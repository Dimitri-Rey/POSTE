import ast
import email
import email.policy
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

import pytest

from poste import db, planificateur
from poste.modules import agenda, mails, notifications, taches

RACINE = Path(__file__).parents[1]


def test_aucun_code_d_envoi_de_mail():
    for f in (RACINE / "api").rglob("*.py"):
        arbre = ast.parse(f.read_text())
        for n in ast.walk(arbre):
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                noms = [a.name for a in n.names] + [getattr(n, "module", "") or ""]
                assert not any("smtp" in x.lower() for x in noms), f
    routes = (RACINE / "api/poste/modules/mails.py").read_text()
    assert "sendmail" not in routes and "send_message" not in routes


def test_taches_crud(connecte):
    r = connecte.post("/api/taches", json={"titre": "Payer", "echeance": "2026-11-02"})
    tid = r.json()["id"]
    assert connecte.post("/api/taches", json={"titre": "x", "echeance": "pas-une-date"}).status_code == 422
    assert [t["titre"] for t in connecte.get("/api/taches").json()] == ["Payer"]
    assert connecte.patch(f"/api/taches/{tid}", json={"faite": True}).status_code == 200
    assert connecte.get("/api/taches").json() == []
    assert len(connecte.get("/api/taches?avec_faites=true").json()) == 1
    assert connecte.patch("/api/taches/999", json={"faite": True}).status_code == 404


def test_agenda_crud_et_controles(connecte):
    corps = {"titre": "Appel", "debut": "2099-01-01T10:00", "fin": "2099-01-01T09:00"}
    assert connecte.post("/api/agenda", json=corps).status_code == 422
    corps["fin"] = "2099-01-01T11:00"
    eid = connecte.post("/api/agenda", json=corps).json()["id"]
    assert connecte.get("/api/agenda").json()[0]["titre"] == "Appel"
    assert connecte.put(f"/api/agenda/{eid}", json={**corps, "titre": "Visio"}).status_code == 200
    assert connecte.get("/api/agenda").json()[0]["titre"] == "Visio"
    assert connecte.delete(f"/api/agenda/{eid}").status_code == 200
    assert connecte.get("/api/agenda").json() == []
    assert connecte.post("/api/agenda", json={"titre": "x", "debut": "nope"}).status_code == 422


def _base(tmp_path):
    chemin = tmp_path / "p.db"
    db.initialiser(chemin, [mails.SCHEMA, agenda.SCHEMA, taches.SCHEMA])
    return db.connecter(chemin)


def test_rappel_agenda_une_seule_fois(tmp_path, monkeypatch):
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a))
    cnx = _base(tmp_path)
    cnx.execute("INSERT INTO evenements_agenda (titre, debut, rappel_minutes) VALUES ('RDV','2026-11-01T10:00',15)")
    pub = lambda *a: None
    assert planificateur.rappels_agenda(cnx, pub, datetime(2026, 11, 1, 9, 30)) == 0
    assert planificateur.rappels_agenda(cnx, pub, datetime(2026, 11, 1, 9, 46)) == 1
    assert planificateur.rappels_agenda(cnx, pub, datetime(2026, 11, 1, 9, 47)) == 0
    assert len(envois) == 1


def test_echeance_le_matin_et_une_seule_fois(tmp_path, monkeypatch):
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a))
    cnx = _base(tmp_path)
    cnx.execute("INSERT INTO taches (titre, echeance, cree_le) VALUES ('T','2026-11-01',0)")
    pub = lambda *a: None
    assert planificateur.echeances_du_jour(cnx, pub, datetime(2026, 11, 1, 7)) == 0
    assert planificateur.echeances_du_jour(cnx, pub, datetime(2026, 11, 1, 9)) == 1
    assert planificateur.echeances_du_jour(cnx, pub, datetime(2026, 11, 1, 10)) == 0


def test_alerte_serveur_au_changement_seulement(monkeypatch):
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a))
    etat = {"services": [{"id": "ntfy", "nom": "Notifications", "etat": "failed"}], "disques": [], "gpu": None}
    deja = set()
    pub = lambda *a: None
    assert planificateur.alertes_serveur(etat, deja, pub) == ["service:ntfy"]
    assert planificateur.alertes_serveur(etat, deja, pub) == []
    etat["services"][0]["etat"] = "active"
    assert planificateur.alertes_serveur(etat, deja, pub) == []
    etat["services"][0]["etat"] = "failed"
    assert planificateur.alertes_serveur(etat, deja, pub) == ["service:ntfy"]
    assert len(envois) == 2


def test_importance_d_un_mail():
    assert mails.est_important({"From": "Paul <paul@x.fr>"}, [])
    assert not mails.est_important({"From": "a@x.fr", "List-Unsubscribe": "<u>"}, [])
    assert not mails.est_important({"From": "no-reply@x.fr"}, [])
    assert not mails.est_important({"From": "paul@x.fr"}, ["SPF en échec"])


def test_brouillon_refuse_les_domaines_interdits(connecte, monkeypatch):
    compte = mails.Compte("c", "a@b.fr", "h", 993, "u", "p")
    monkeypatch.setattr(mails, "charger_comptes", lambda: [compte])
    monkeypatch.setattr(mails, "domaines_interdits", lambda: ["interdit.example"])
    r = connecte.post("/api/mails/brouillon", json={"compte": "c", "a": "x@interdit.example"})
    assert r.status_code == 403
    assert connecte.post("/api/mails/brouillon", json={"compte": "c", "a": "invalide"}).status_code == 422
    assert connecte.post("/api/mails/brouillon", json={"compte": "z", "a": "a@b.fr"}).status_code == 404


def test_reponse_ia_redige_sans_rien_deposer(connecte, monkeypatch):
    msg = email.message_from_string("From: Paul <paul@x.fr>\nSubject: Point\n\nOn se voit ?")
    monkeypatch.setattr(mails, "_message", lambda c, u: msg)
    monkeypatch.setattr(mails, "texte_de", lambda m: "On se voit ?")
    monkeypatch.setattr(mails, "analyser_complet", lambda m: {"niveau": "sain"})
    vu = {}
    def faux(de, sujet, texte, theme):
        vu.update(de=de, theme=theme)
        return "Bonjour Paul"
    monkeypatch.setattr(mails, "generer_reponse", faux)
    monkeypatch.setattr(mails, "deposer_brouillon", lambda b: pytest.fail("rien ne doit être déposé"))
    r = connecte.post("/api/mails/c/5/reponse-ia", json={"theme": "oui à 15 h"})
    assert r.status_code == 200 and r.json() == {"corps": "Bonjour Paul"}
    assert vu == {"de": "Paul <paul@x.fr>", "theme": "oui à 15 h"}
    assert connecte.post("/api/mails/c/5/reponse-ia", json={"theme": ""}).status_code == 422
    monkeypatch.setattr(mails, "analyser_complet", lambda m: {"niveau": "dangereux"})
    assert connecte.post("/api/mails/c/5/reponse-ia", json={"theme": "x"}).status_code == 403


def _publier_reel(base):
    def publier(*annonce):
        cnx = db.connecter(base)
        cnx.execute("PRAGMA busy_timeout=100")  # Échec immédiat si l'écriture appelante est encore ouverte.
        try:
            with cnx:
                db.publier(cnx, *annonce)
        finally:
            cnx.close()
    return publier


def test_synchro_mails_publie_sans_se_bloquer(tmp_path, monkeypatch):
    base = tmp_path / "t.db"
    db.initialiser(base, [mails.SCHEMA, mails.SCHEMA_BLOCAGE])
    compte = mails.Compte("c", "a@b.fr", "h", 993, "u", "p")
    entete = b"From: Paul <paul@x.fr>\r\nSubject: Bonjour\r\nDate: Sat, 31 Oct 2026 08:00:00 +0100\r\n\r\n"

    demandes = []

    class Boite:
        def list(self): return "OK", []
        def select(self, *a, **k): return "OK", [b"2"]
        def logout(self): pass
        def uid(self, commande, *a):
            demandes.append((commande, *a))
            if commande == "SEARCH":
                return "OK", [b"1 2"]
            if a[1] == "(FLAGS)":
                return "OK", [b"1 (UID 1 FLAGS (\\Seen))", b"2 (UID 2 FLAGS ())"]
            return "OK", [(b"2 (UID 2 BODY[HEADER] {90}", entete), b")"]

    envois = []
    monkeypatch.setattr(mails, "charger_comptes", lambda: [compte])
    monkeypatch.setattr(mails, "domaines_interdits", lambda: [])
    monkeypatch.setattr(mails, "_ouvrir", lambda c: Boite())
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a) or True)
    cnx = db.connecter(base)
    with cnx:
        cnx.execute("INSERT INTO mails (compte, uid, de, sujet, ts, lu, important, alertes) VALUES ('c', 1, 'x', 'ancien', 0, 0, 0, '[]')")
        cnx.execute("INSERT INTO reglages VALUES ('mails_classement:c', ?)", (str(mails.CLASSEMENT),))
    cnx.close()
    bilan = mails.synchroniser_tout(lambda: db.connecter(base), _publier_reel(base))
    assert bilan == {"c": 1}
    cnx = db.connecter(base)
    assert cnx.execute("SELECT titre FROM evenements").fetchone()["titre"] == "Bonjour"
    assert cnx.execute("SELECT COUNT(*) FROM mails").fetchone()[0] == 2
    cnx.close()
    assert envois == [("Paul", "Bonjour")]
    # Seul le nouveau mail est lu en détail ; l'ancien prend son état « lu » du serveur.
    assert [d for d in demandes if d[0] == "FETCH" and "HEADER" in d[2]] == [("FETCH", "2", "(BODY.PEEK[HEADER])")]
    cnx = db.connecter(base)
    assert cnx.execute("SELECT lu FROM mails WHERE uid=1").fetchone()[0] == 1
    cnx.close()


def test_synchro_retire_les_mails_partis_du_serveur(tmp_path, monkeypatch):
    base = tmp_path / "t.db"
    db.initialiser(base, [mails.SCHEMA, mails.SCHEMA_BLOCAGE])
    compte = mails.Compte("c", "a@b.fr", "h", 993, "u", "p")

    class Boite:
        def list(self): return "OK", []
        def select(self, *a, **k): return "OK", [b"1"]
        def logout(self): pass
        def uid(self, commande, *a):
            if commande == "SEARCH":
                return "OK", [b"3"]
            return "OK", [b"1 (UID 3 FLAGS ())"]

    monkeypatch.setattr(mails, "charger_comptes", lambda: [compte])
    monkeypatch.setattr(mails, "domaines_interdits", lambda: [])
    monkeypatch.setattr(mails, "_ouvrir", lambda c: Boite())
    cnx = db.connecter(base)
    with cnx:
        cnx.executemany("INSERT INTO mails (compte, uid, de, sujet, ts, lu, important, alertes) VALUES ('c', ?, 'x', 's', 0, 0, 0, '[]')", [(1,), (2,), (3,)])
        cnx.execute("INSERT INTO reglages VALUES ('mails_classement:c', ?)", (str(mails.CLASSEMENT),))
    cnx.close()
    assert mails.synchroniser_tout(lambda: db.connecter(base), lambda *a: None) == {"c": 0}
    cnx = db.connecter(base)
    assert [l[0] for l in cnx.execute("SELECT uid FROM mails")] == [3]
    etat = mails.etat_boites(cnx, depuis=-1)
    cnx.close()
    assert etat["nouveaux"] == 1 and etat["jeton"]


def test_rappel_publie_apres_enregistrement(tmp_path, monkeypatch):
    base = tmp_path / "t.db"
    db.initialiser(base, [agenda.SCHEMA])
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: True)
    cnx = db.connecter(base)
    with cnx:
        cnx.execute("CREATE TABLE ecrit (a)")
    cnx.close()

    def action(c, publier):
        c.execute("INSERT INTO ecrit VALUES (1)")
        publier("Agenda", "RDV")

    planificateur.en_transaction(lambda: db.connecter(base), _publier_reel(base), action)
    cnx = db.connecter(base)
    assert cnx.execute("SELECT titre FROM evenements").fetchone()["titre"] == "RDV"
    cnx.close()


MAIL_PIEGE = (
    '<html><head><title>x</title><meta http-equiv="refresh" content="0;url=https://mal.example"><base href="https://mal.example/">'
    "<style>.b{color:red}</style></head><body onload=\"alert(1)\"><script>alert(2)</script><div class=b style=\"width:600px\">Bonjour"
    '<a href="javascript:alert(3)">j</a><a href="https://site.fr/a" onclick="alert(4)">lien</a>'
    '<img src="https://suivi.example/p.gif"><img src="cid:logo"><form action="https://mal.example"><input name=m></form>'
    "<iframe src=\"https://mal.example\"></iframe><svg onload=alert(5)></svg></div></body></html>"
)


def _mail_piege():
    m = EmailMessage()
    m["From"] = "Paul <paul@x.fr>"
    m["Subject"] = "Sujet"
    m.set_content("texte brut")
    m.add_alternative(MAIL_PIEGE, subtype="html")
    m.get_body(("html",)).add_related(b"\x89PNG", "image", "png", cid="<logo>")
    return m


def test_html_nettoye_sans_rien_d_executable():
    propre = mails.corps_html(_mail_piege())
    for interdit in ("script", "onload", "onclick", "javascript:", "<meta", "<base", "<form", "<input", "<iframe", "<svg", "alert("):
        assert interdit not in propre.lower(), interdit
    assert "Bonjour" in propre and "<style>" in propre and 'style="width:600px"' in propre
    assert 'href="https://site.fr/a"' in propre
    assert 'src="data:image/png;base64,' in propre and "cid:" not in propre
    assert mails.IMAGE_DISTANTE.search(propre)


def test_mail_en_texte_seul_sans_html():
    m = EmailMessage()
    m.set_content("juste du texte")
    assert mails.corps_html(m) is None


def test_route_html_isolee_et_images_sur_demande(connecte, monkeypatch):
    monkeypatch.setattr(mails, "_message", lambda c, u: _mail_piege())
    monkeypatch.setattr(mails, "analyser_complet", lambda m: {"niveau": "sain", "score": 0, "raisons": []})
    r = connecte.get("/api/mails/c/1/html")
    csp = r.headers["content-security-policy"]
    assert r.status_code == 200 and "sandbox allow-same-origin" in csp and "default-src 'none'" in csp
    assert "allow-scripts" not in csp and "img-src data:;" in csp and "form-action 'none'" in csp
    assert r.headers["x-frame-options"] == "SAMEORIGIN"
    assert "img-src data: https:" in connecte.get("/api/mails/c/1/html?images=true").headers["content-security-policy"]


def test_mail_suspect_jamais_d_images_distantes(connecte, monkeypatch):
    monkeypatch.setattr(mails, "_message", lambda c, u: _mail_piege())
    monkeypatch.setattr(mails, "analyser_complet", lambda m: {"niveau": "douteux", "score": 4, "raisons": ["x"]})
    assert "https:" not in connecte.get("/api/mails/c/1/html?images=true").headers["content-security-policy"]


def test_route_html_fermee_a_l_agent_et_sans_session(client):
    from poste import securite
    assert client.get("/api/mails/c/1/html").status_code == 401
    assert not securite.agent_autorise("GET", "/api/mails/c/1/html", "j", "j")


def test_brouillon_depose_dans_le_dossier_sans_rien_envoyer(monkeypatch):
    depots = []

    class Boite:
        def list(self):
            return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\Drafts) "/" "Brouillons"']

        def append(self, dossier, drapeaux, date, contenu):
            depots.append((dossier, drapeaux, email.message_from_bytes(contenu, policy=email.policy.default)))
            return "OK", []

        def logout(self):
            depots.append("fermee")

    compte = mails.Compte("c", "moi@b.fr", "h", 993, "u", "p")
    monkeypatch.setattr(mails, "charger_comptes", lambda: [compte])
    monkeypatch.setattr(mails, "domaines_interdits", lambda: [])
    monkeypatch.setattr(mails, "_ouvrir", lambda c: Boite())
    r = mails.deposer_brouillon(mails.Brouillon(compte="c", a="Paul <paul@x.fr>", sujet="Re: Point", corps="Oui à 15 h", en_reponse_a="<id@x>"))
    assert r == {"depose_dans": "Brouillons", "compte": "moi@b.fr"}
    (dossier, drapeaux, msg), fin = depots
    assert dossier == '"Brouillons"' and drapeaux == r"(\Draft)" and fin == "fermee"
    assert msg["To"] == "Paul <paul@x.fr>" and msg["In-Reply-To"] == "<id@x>" and msg["References"] == "<id@x>"
    assert msg.get_content().strip() == "Oui à 15 h"


def test_taches_priorite_et_migration(connecte, tmp_path):
    import sqlite3
    from poste import db
    a = connecte.post("/api/taches", json={"titre": "Normale", "echeance": "2026-11-01"}).json()["id"]
    b = connecte.post("/api/taches", json={"titre": "Urgente", "priorite": 1}).json()["id"]
    assert [t["titre"] for t in connecte.get("/api/taches").json()] == ["Urgente", "Normale"]
    assert connecte.patch(f"/api/taches/{b}", json={"priorite": 0}).status_code == 200
    assert connecte.patch(f"/api/taches/{a}", json={"priorite": 1}).status_code == 200
    assert [t["titre"] for t in connecte.get("/api/taches").json()] == ["Normale", "Urgente"]
    assert connecte.patch(f"/api/taches/{a}", json={}).status_code == 422
    assert connecte.patch(f"/api/taches/{a}", json={"faite": True}).status_code == 200
    # Une base d'avant la priorité gagne la colonne sans perdre ses tâches.
    vieille = tmp_path / "vieille.db"
    with sqlite3.connect(vieille) as cnx:
        cnx.executescript("CREATE TABLE taches (id INTEGER PRIMARY KEY, titre TEXT NOT NULL, echeance TEXT, faite_le REAL, notes TEXT NOT NULL DEFAULT '', cree_le REAL NOT NULL, signalee INTEGER NOT NULL DEFAULT 0); INSERT INTO taches (titre, cree_le) VALUES ('ancienne', 0);")
    db.initialiser(vieille, [taches.SCHEMA])
    with sqlite3.connect(vieille) as cnx:
        assert cnx.execute("SELECT titre, priorite FROM taches").fetchall() == [("ancienne", 0)]


def test_module_coupe_dans_les_reglages(connecte, monkeypatch):
    from poste import reglages
    assert connecte.get("/api/modules").json()["sport"] is True
    monkeypatch.setattr(reglages, "_contenu", lambda: {"modules": {"sport": False, "hermes": False}})
    etat = connecte.get("/api/modules").json()
    assert etat["sport"] is False and etat["hermes"] is False and etat["mails"] is True
    assert connecte.get("/api/sport/etat").status_code == 404
    assert connecte.get("/api/hermes/conversations").status_code == 404
    assert connecte.get("/api/taches").status_code == 200


def test_reglages_par_defaut_neutres(monkeypatch):
    from poste import reglages
    monkeypatch.setattr(reglages, "_contenu", lambda: {})
    assert reglages.actif("mails") and not reglages.actif("hermes") and not reglages.actif("sport")
    assert reglages.lire("ia", "adresse", "x") == "x" and reglages.section("ia.modeles") == {}


def test_alertes_serveur_retenues_apres_redemarrage(tmp_path, monkeypatch):
    base = tmp_path / "t.db"
    db.initialiser(base, [])
    connecter = lambda: db.connecter(base)
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a) or True)
    monkeypatch.setattr(planificateur, "SERVICES_CRITIQUES", {"moteur"})
    etat = {"services": [{"id": "moteur", "nom": "Moteur IA", "etat": "inactive"}], "disques": [], "gpu": None}
    alertes = planificateur.alertes_connues(connecter)
    planificateur.alertes_serveur(etat, alertes, lambda *a: None)
    planificateur.retenir_alertes(connecter, alertes)
    # Redémarrage de Poste : la panne qui dure ne sonne pas une seconde fois.
    apres = planificateur.alertes_connues(connecter)
    assert planificateur.alertes_serveur(etat, apres, lambda *a: None) == []
    assert len(envois) == 1
