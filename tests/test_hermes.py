import sqlite3

import yaml
from fastapi import HTTPException

from poste.modules import hermes, notifications


def faux_hermes(monkeypatch, approbation):
    appels = []

    def appeler(methode, chemin, **options):
        appels.append((methode, chemin, options.get("json")))
        if methode == "GET" and chemin.startswith("/v1/runs/"):
            return {"status": "waiting_for_approval", "approval": approbation}
        return {"ok": True}

    monkeypatch.setattr(hermes, "appeler", appeler)
    return appels


def test_toujours_refuse_sans_habitude(connecte, monkeypatch):
    appels = faux_hermes(monkeypatch, {"description": "Exécuter : rm -rf x", "request_id": "r"})
    r = connecte.post("/api/hermes/executions/run1/decision", json={"choix": "always"})
    assert r.status_code == 403
    assert not [a for a in appels if a[0] == "POST"]


def test_toujours_accepte_pour_une_habitude(connecte, monkeypatch):
    appels = faux_hermes(monkeypatch, {"description": "[habitude] git status — Exécuter : git status", "request_id": "r"})
    r = connecte.post("/api/hermes/executions/run1/decision", json={"choix": "always", "request_id": "r"})
    assert r.status_code == 200
    assert ("POST", "/v1/runs/run1/approval", {"choice": "always", "request_id": "r"}) in appels


def test_choix_inconnu_et_session_refuses(connecte, monkeypatch):
    faux_hermes(monkeypatch, {})
    assert connecte.post("/api/hermes/executions/r/decision", json={"choix": "session"}).status_code == 422


def test_approbation_publique_masque_le_marqueur():
    a = hermes.approbation_publique({"description": "[habitude] ls — Exécuter : ls", "request_id": "x", "command": "secret"})
    assert a == {"request_id": "x", "description": "Exécuter : ls", "habitude": "ls"}


def test_habitudes_liste_et_retrait(tmp_path):
    c = tmp_path / "config.yaml"
    c.write_text(yaml.safe_dump({"command_allowlist": ["plugin_rule:habitude:git status", "rm"], "autre": 1}))
    assert hermes.lire_habitudes(c) == ["git status"]
    hermes.retirer_habitude("git status", c)
    assert yaml.safe_load(c.read_text()) == {"command_allowlist": ["rm"], "autre": 1}
    try:
        hermes.retirer_habitude("absente", c)
    except HTTPException as err:
        assert err.status_code == 404
    else:
        raise AssertionError


def test_modele_inconnu_et_lecture_du_depot(connecte, monkeypatch, tmp_path):
    monkeypatch.setattr(hermes, "DEPOT_MOTEUR", tmp_path / "absent.conf")
    assert hermes.modele_actif() == "precis"
    assert connecte.post("/api/hermes/modele", json={"modele": "autre"}).status_code == 422
    (tmp_path / "absent.conf").write_text(f"Environment=MODEL=/app/models/{hermes.MODELES['rapide'][1]}")
    assert hermes.modele_actif() == "rapide"


def test_notification_sans_service_ne_casse_rien():
    assert notifications.envoyer("x") is False


def test_routes_hermes_protegees(client):
    assert client.get("/api/hermes/habitudes").status_code == 401
    assert client.post("/api/hermes/envoyer", json={"texte": "x"}).status_code == 401


def test_identifiant_avec_chemin_refuse(connecte, monkeypatch):
    appels = faux_hermes(monkeypatch, {})
    assert connecte.get("/api/hermes/executions/a%2Fb").status_code in (404, 422)
    assert connecte.get("/api/hermes/conversations/a.b").status_code == 422
    assert appels == []


def _base_sessions(chemin):
    cnx = sqlite3.connect(chemin)
    cnx.executescript("""
        CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, archived INT DEFAULT 0, hidden INT DEFAULT 0);
        CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, timestamp REAL);
        INSERT INTO sessions (id, title, source) VALUES ('a', 'Météo', 'api_server'), ('b', 'Facture', 'api_server'), ('c', 'Facture', 'cli');
        INSERT INTO sessions (id, title, source, archived) VALUES ('d', 'Facture', 'api_server', 1);
        INSERT INTO messages VALUES ('a', 'user', 'il fait 100% beau', 1), ('a', 'tool', 'secret interne', 2),
          ('b', 'assistant', 'La facture de novembre est prête', 3), ('c', 'user', 'facture', 4), ('d', 'user', 'facture', 5);
    """)
    cnx.commit()
    cnx.close()


def test_recherche_titres_et_contenu(tmp_path):
    base = tmp_path / "state.db"
    _base_sessions(base)
    assert [r["id"] for r in hermes.rechercher_conversations("facture", base)] == ["b"]
    assert [r["id"] for r in hermes.rechercher_conversations("météo", base)] == ["a"]
    assert "novembre" in hermes.rechercher_conversations("novembre", base)[0]["extrait"]
    assert hermes.rechercher_conversations("secret", base) == []
    assert [r["id"] for r in hermes.rechercher_conversations("100%", base)] == ["a"]
    assert hermes.rechercher_conversations("1%0", base) == []
    assert hermes.rechercher_conversations("x", tmp_path / "absente.db") == []


def test_modifier_conversation(connecte, monkeypatch):
    appels = faux_hermes(monkeypatch, {})
    assert connecte.patch("/api/hermes/conversations/c1", json={"titre": " Mon titre "}).status_code == 200
    assert appels[-1] == ("PATCH", "/api/sessions/c1", {"title": "Mon titre"})
    assert connecte.patch("/api/hermes/conversations/c1", json={"epinglee": True}).status_code == 200
    assert appels[-1] == ("PATCH", "/api/sessions/c1", {"pinned": True})
    assert connecte.patch("/api/hermes/conversations/c1", json={}).status_code == 422
    assert connecte.patch("/api/hermes/conversations/c.x", json={"epinglee": True}).status_code == 422


def test_conversation_active_visible_et_non_supprimable(connecte, monkeypatch):
    monkeypatch.setattr(hermes.threading, "Thread", lambda **k: type("F", (), {"start": lambda self: None})())

    def appeler(methode, chemin, **options):
        if chemin == "/v1/runs":
            return {"run_id": "r1"}
        if chemin == "/api/sessions" and methode == "GET":
            return {"data": [{"id": "c1", "title": "T", "last_active": 5}]}
        return {"ok": True}

    monkeypatch.setattr(hermes, "appeler", appeler)
    monkeypatch.setattr(hermes, "etat_modele", lambda: {"pret": True})
    assert connecte.post("/api/hermes/envoyer", json={"texte": "bonjour", "conversation": "c1"}).status_code == 200
    assert connecte.get("/api/hermes/conversations").json()[0]["run"] == "r1"
    assert connecte.delete("/api/hermes/conversations/c1").status_code == 409
    # Pas de bascule du moteur pendant une réponse.
    bascules = []
    monkeypatch.setattr(hermes, "modele_actif", lambda: "precis")
    monkeypatch.setattr(hermes, "basculer_modele", bascules.append)
    assert connecte.post("/api/hermes/modele", json={"modele": "rapide"}).status_code == 409
    assert bascules == []


def test_message_refuse_pendant_le_chargement(connecte, monkeypatch):
    appels = faux_hermes(monkeypatch, {})
    monkeypatch.setattr(hermes, "etat_modele", lambda: {"pret": False})
    r = connecte.post("/api/hermes/envoyer", json={"texte": "bonjour"})
    assert r.status_code == 503 and "charger" in r.json()["detail"]
    assert appels == []


def test_explication_nettoyee_et_sans_blocage(monkeypatch):
    import httpx

    class Reponse:
        status_code = 200
        def __init__(self, donnees):
            self.donnees = donnees
        def raise_for_status(self):
            pass
        def json(self):
            return self.donnees

    monkeypatch.setattr(hermes.httpx, "get", lambda *a, **k: Reponse({"data": [{"id": "m"}]}))
    monkeypatch.setattr(hermes.httpx, "post", lambda *a, **k: Reponse({"choices": [{"message": {"content": "<think>x</think>Pourquoi : a — b"}}]}))
    assert hermes.expliquer("q", "git status") == "Pourquoi : a, b"

    def panne(*a, **k):
        raise httpx.ConnectError("x")
    monkeypatch.setattr(hermes.httpx, "get", panne)
    assert hermes.expliquer("q", "git status") is None


def test_moteur_arrete_se_dit_et_se_demarre(connecte, monkeypatch):
    arrete = [True]
    demarrages = []
    monkeypatch.setattr(hermes, "moteur_arrete", lambda: arrete[0])
    monkeypatch.setattr(hermes, "demarrer_moteur", lambda: demarrages.append(1) or arrete.__setitem__(0, False))
    etat = connecte.get("/api/hermes/modele").json()
    assert etat["arrete"] and not etat["pret"] and etat["demarrable"]
    r = connecte.post("/api/hermes/envoyer", json={"texte": "Bonjour"})
    assert r.status_code == 503 and "arrêté" in r.json()["detail"]
    etat = connecte.post("/api/hermes/moteur/demarrer").json()
    assert demarrages == [1] and not etat["arrete"]
    # Déjà en route : on ne relance rien.
    connecte.post("/api/hermes/moteur/demarrer")
    assert demarrages == [1]


def test_mesures_de_vitesse():
    avant = {"lus": 1000, "caches": 800, "generes": 10, "t_lecture": 1.0, "t_generation": 2.0}
    apres = {"lus": 13340, "caches": 10600, "generes": 390, "t_lecture": 2.0, "t_generation": 11.0}
    m = hermes.calculer_mesures(avant, apres, {"input_tokens": 1, "output_tokens": 2}, 12.34)
    assert m["lecture"] == {"tokens": 12340, "caches": 9800, "vitesse": 2540}
    assert m["generation"] == {"tokens": 380, "vitesse": 42.2, "secondes": 12.3}
    # Moteur sans compteurs : les tokens de Hermes, sans vitesse inventée.
    m = hermes.calculer_mesures(None, None, {"input_tokens": 500, "output_tokens": 40}, 3.0)
    assert m["lecture"]["tokens"] == 500 and m["lecture"]["vitesse"] is None and m["generation"]["tokens"] == 40


def test_modele_vision_meme_dossier_avec_variables(monkeypatch, tmp_path):
    dossier = "Huihui-abliterated"
    monkeypatch.setattr(hermes, "MODELES", {"precis": ("Précis", dossier), "rapide": ("Rapide", "Autre"), "vision": ("Vision", dossier)})
    monkeypatch.setattr(hermes, "OPTIONS_MODELES", {"precis": {"vision": False, "environnement": {}},
                                                   "rapide": {"vision": False, "environnement": {}},
                                                   "vision": {"vision": True, "environnement": {"VISION": "1", "mal nommée": "x", "BIZARRE": "a b\nc"}}})
    monkeypatch.setattr(hermes, "DEPOT_MOTEUR", tmp_path / "depot.conf")
    contenu = hermes.depot_modele("vision")
    assert "# poste-modele: vision\n" in contenu and contenu.endswith(f"Environment=MODEL=/app/models/{dossier}\nEnvironment=VISION=1\n")
    assert "mal nommée" not in contenu and "BIZARRE" not in contenu
    (tmp_path / "depot.conf").write_text(contenu)
    assert hermes.modele_actif() == "vision" and hermes.modele_voit()
    (tmp_path / "depot.conf").write_text(hermes.depot_modele("precis"))
    assert hermes.modele_actif() == "precis" and not hermes.modele_voit()
    # Ancien dépôt sans marque : le choix sans variables pour ce dossier, jamais la vision.
    (tmp_path / "depot.conf").write_text(f"[Container]\nEnvironment=MODEL=/app/models/{dossier}\n")
    assert hermes.modele_actif() == "precis"


def test_vision_reglee_dans_le_profil_hermes(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("model:\n  default: modele-local\n  supports_vision: false\ncommand_allowlist:\n- a\n")
    hermes.regler_vision_hermes(True, config)
    import yaml
    donnees = yaml.safe_load(config.read_text())
    assert donnees["model"] == {"default": "modele-local", "supports_vision": True} and donnees["command_allowlist"] == ["a"]
    avant = config.stat().st_mtime_ns
    hermes.regler_vision_hermes(True, config)  # déjà bon : pas réécrit
    assert config.stat().st_mtime_ns == avant
    hermes.regler_vision_hermes(False, tmp_path / "absent.yaml")  # profil absent : rien


def test_image_refusee_sans_modele_qui_voit(connecte, monkeypatch):
    monkeypatch.setattr(hermes, "etat_modele", lambda: {"pret": True, "arrete": False, "vision": False})
    r = connecte.post("/api/hermes/envoyer", json={"texte": "Décris", "image": "data:image/jpeg;base64,AAAA"})
    assert r.status_code == 422 and "Vision" in r.json()["detail"]


def test_message_avec_image_relu_en_texte():
    assert hermes.texte_message([{"type": "text", "text": "Décris"}, {"type": "image_url", "image_url": {"url": "data:..."}}]) == "Décris\n\n[Image]"
    assert hermes.texte_message("Bonjour") == "Bonjour"


def _passerelle(monkeypatch, statuts):
    """Fausse passerelle : chaque /v1/runs crée run1, run2… ; l'état d'une exécution vient de `statuts`."""
    appels, numero = [], [0]
    monkeypatch.setattr(hermes.threading, "Thread", lambda **k: type("F", (), {"start": lambda self: None})())

    def appeler(methode, chemin, **options):
        appels.append((methode, chemin))
        if chemin == "/v1/runs":
            numero[0] += 1
            return {"run_id": f"run{numero[0]}"}
        if chemin == "/api/sessions" and methode == "GET":
            return {"data": [{"id": "c1", "title": "T", "last_active": 5}]}
        if methode == "GET" and chemin.startswith("/v1/runs/"):
            return {"status": statuts.get(chemin.split("/")[3], "running")}
        return {"ok": True}

    monkeypatch.setattr(hermes, "appeler", appeler)
    monkeypatch.setattr(hermes, "etat_modele", lambda: {"pret": True})
    return appels


def test_nouveau_message_arrete_l_execution_precedente(connecte, monkeypatch):
    """Sinon l'ancienne reste à attendre une confirmation que plus aucun écran ne montre."""
    appels = _passerelle(monkeypatch, {})
    assert connecte.post("/api/hermes/envoyer", json={"texte": "un", "conversation": "c1"}).json()["run_id"] == "run1"
    assert ("POST", "/v1/runs/run1/stop") not in appels
    assert connecte.post("/api/hermes/envoyer", json={"texte": "deux", "conversation": "c1"}).json()["run_id"] == "run2"
    assert ("POST", "/v1/runs/run1/stop") in appels
    assert connecte.get("/api/hermes/conversations").json()[0]["run"] == "run2"


def test_execution_retrouvee_apres_un_redemarrage(connecte, client, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from poste.app import creer
    _passerelle(monkeypatch, {})
    assert connecte.post("/api/hermes/envoyer", json={"texte": "un", "conversation": "c1"}).status_code == 200
    # Poste redémarre : même base, nouvelle application.
    relance = TestClient(creer(client.app.state.config))
    relance.cookies = connecte.cookies
    assert relance.get("/api/hermes/conversations").json()[0]["run"] == "run1"


def test_une_ancienne_execution_ne_retire_pas_la_nouvelle(tmp_path, monkeypatch):
    """La fin de run1 (remplacée) ne doit pas effacer run2, toujours en cours dans la même conversation."""
    import threading as vrai
    from poste import db
    VraiThread = vrai.Thread
    base = tmp_path / "h.db"
    db.initialiser(base, [hermes.SCHEMA])
    statuts = {"run1": "running", "run2": "running"}
    _passerelle(monkeypatch, statuts)
    monkeypatch.setattr(hermes.threading, "Thread", VraiThread)
    monkeypatch.setattr(hermes.time, "sleep", lambda s: None)
    monkeypatch.setattr(hermes.notifications, "envoyer", lambda *a, **k: None)
    cnx = db.connecter(base)
    with cnx:
        cnx.execute("INSERT INTO hermes_actives VALUES ('c1','run1','q','a')")
    cnx.close()
    statuts["run1"] = "cancelled"
    # Au démarrage, run1 est retrouvée puis suivie jusqu'à sa fin : elle quitte la base.
    hermes.creer_routeur(lambda *a, **k: None, lambda: db.connecter(base))
    for _ in range(200):
        cnx = db.connecter(base)
        reste = cnx.execute("SELECT run FROM hermes_actives").fetchall()
        cnx.close()
        if not reste:
            break
        vrai.Event().wait(0.01)
    assert reste == []
