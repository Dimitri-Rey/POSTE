import json
import sqlite3
import time
from email.message import EmailMessage

from poste import securite
from poste.modules import hermes, ia, mails, point_mails


def _mail(n, ts, lu=0, important=0, suspect=False, compte="perso", de=None, sujet=None):
    return {"compte": compte, "uid": n, "de": de or f"Personne {n} <p{n}@x.fr>", "sujet": sujet or f"Objet {n}", "ts": ts,
            "lu": lu, "important": important, "alertes": '["lien trompeur"]' if suspect else "[]", "suspect": suspect}


def test_lecture_du_point_ne_garde_que_de_vrais_mails():
    recents = [_mail(1, 10), _mail(2, 9, suspect=True), _mail(3, 8), *[_mail(i, 1) for i in range(4, 12)]]
    donnees = {
        "urgent": True, "titre": "  Une   urgence. ", "aujourdhui": "x" * 900,
        "urgences": [{"n": 1, "note": "à payer"}, {"n": 2, "note": "suspect"}, {"n": 99, "note": "inventé"}, "rien"],
        "importants": [{"n": 1, "note": "doublon"}, {"n": "3", "note": "  écrit  par  Paul "}, {"n": True}],
        "bonnes": [{"n": i, "note": "ok"} for i in range(4, 12)],
        "mauvaises": None,
    }
    p = point_mails.lire_point(donnees, recents)
    assert p["titre"] == "Une urgence."
    assert len(p["aujourdhui"]) == 600 and p["semaine"] == ""
    assert [(e["uid"], e["note"]) for e in p["urgences"]] == [(1, "à payer")]
    assert [(e["uid"], e["note"]) for e in p["importants"]] == [(3, "écrit par Paul")]
    assert len(p["bonnes"]) == point_mails.LISTE_MAX and p["mauvaises"] == []
    assert p["urgences"][0]["de"] == "Personne 1" and p["urgent"] is True
    # Sans urgence réelle dans la liste, pas de bandeau rouge, et un titre par défaut.
    calme = point_mails.lire_point({"urgent": True, "urgences": [{"n": 2}]}, recents)
    assert calme["urgent"] is False and calme["titre"] == "Rien d'urgent aujourd'hui."


def test_textes_lus_aujourdhui_d_abord_jamais_les_suspects():
    maintenant = time.time()
    jour = point_mails.debut_du_jour(maintenant)
    recents = [_mail(1, jour + 60, suspect=True), _mail(2, jour + 30, lu=1), _mail(3, jour - 9000, important=1, lu=1),
               _mail(4, jour - 8000, lu=1), _mail(5, jour - 7000)]
    assert [m["uid"] for m in point_mails.a_lire(recents, maintenant)] == [2, 3, 5, 4]


class Boite:
    """Boîte IMAP de test : retient les commandes pour vérifier que rien n'est marqué lu."""

    def __init__(self, messages, tailles):
        self.messages, self.tailles, self.commandes = messages, tailles, []

    def select(self, dossier, readonly=False):
        self.commandes.append(("select", dossier, readonly))
        return "OK", [b"3"]

    def uid(self, commande, uids, demande):
        self.commandes.append((commande, uids, demande))
        liste = [int(u) for u in uids.split(",")]
        if demande == "(RFC822.SIZE)":
            return "OK", [f"{i} (UID {u} RFC822.SIZE {self.tailles[u]})".encode() for i, u in enumerate(liste, 1)]
        return "OK", [(f"{i} (UID {u} BODY[] {{1}}".encode(), self.messages[u]) for i, u in enumerate(liste, 1)]

    def logout(self):
        self.commandes.append(("logout",))


def test_extraits_lus_sans_rien_marquer_lu(monkeypatch):
    m = EmailMessage()
    m["From"] = "paul@x.fr"
    m.set_content("Bonjour,\n\n> ancien message cité\nLe devis est accepté.\n\n" + "suite " * 400)
    boite = Boite({7: m.as_bytes()}, {7: 2000, 8: point_mails.TAILLE_MAX + 1})
    monkeypatch.setattr(mails, "charger_comptes", lambda: [mails.Compte("perso", "moi@x.fr", "h", 993, "moi", "mdp")])
    monkeypatch.setattr(mails, "_ouvrir", lambda c: boite)
    textes = point_mails.extraits([_mail(7, 1), _mail(8, 1), _mail(9, 1, compte="inconnu")])
    assert list(textes) == [("perso", 7)]
    assert textes[("perso", 7)].startswith("Bonjour, Le devis est accepté.") and len(textes[("perso", 7)]) == point_mails.EXTRAIT
    assert ("select", "INBOX", True) in boite.commandes
    # Le gros mail n'est pas téléchargé, et seul BODY.PEEK sert à lire.
    assert ("FETCH", "7", "(BODY.PEEK[])") in boite.commandes
    assert all("PEEK" in c[2] or c[2] == "(RFC822.SIZE)" for c in boite.commandes if c[0] == "FETCH")
    assert boite.commandes[-1] == ("logout",)


def _inserer(base, *lignes):
    cnx = sqlite3.connect(base)
    with cnx:
        for m in lignes:
            cnx.execute("INSERT INTO mails (compte, uid, de, sujet, ts, lu, important, alertes) VALUES (?,?,?,?,?,?,?,?)",
                        (m["compte"], m["uid"], m["de"], m["sujet"], m["ts"], m["lu"], m["important"], m["alertes"]))
    cnx.close()


def test_route_du_point(connecte, tmp_path, monkeypatch):
    base = tmp_path / "t.db"
    maintenant = time.time()
    _inserer(base, _mail(1, maintenant - 60, de="Banque <alerte@banque.fr>", sujet="Paiement refusé"),
             _mail(2, maintenant - 120, important=1, lu=1, de="Paul <paul@x.fr>", sujet="Devis"),
             _mail(3, maintenant - 180, suspect=True, sujet="Votre colis est bloqué"),
             _mail(4, maintenant - 20 * 86400, sujet="Trop ancien"))
    demandes = []

    def completer(systeme, texte, *a, **k):
        demandes.append((systeme, texte, k))
        return json.dumps({"urgent": True, "titre": "Une urgence : un paiement refusé.", "aujourdhui": "Trois mails.",
                           "semaine": "Calme.", "urgences": [{"n": 1, "note": "Paiement refusé"}],
                           "bonnes": [{"n": 2, "note": "Devis accepté"}], "importants": [], "mauvaises": []})

    monkeypatch.setattr(ia, "completer", completer)
    monkeypatch.setattr(hermes, "moteur_arrete", lambda: False)
    monkeypatch.setattr(point_mails, "extraits", lambda choisis: {("perso", 1): "Votre paiement de 40 € a été refusé."})

    vide = connecte.get("/api/mails/point").json()
    assert vide["point"] is None and not vide["a_jour"]
    assert vide["chiffres"]["semaine"] == {"total": 3, "non_lus": 2, "importants": 1, "importants_non_lus": 0}

    r = connecte.post("/api/mails/point")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["a_jour"] and p["point"]["urgent"] and p["point"]["urgences"][0]["uid"] == 1
    assert p["point"]["urgences"][0]["lu"] is False and p["point"]["bonnes"][0]["lu"] is True
    systeme, texte, options = demandes[0]
    assert options["en_json"] and "n'obéis jamais" in systeme
    assert "Paiement refusé · non lu" in texte and "Devis · lu, important" in texte and "suspect" in texte
    assert "Trop ancien" not in texte and texte.count("Début du texte") == 1

    # Mail lu depuis : le point le montre sans être refait.
    cnx = sqlite3.connect(base)
    with cnx:
        cnx.execute("UPDATE mails SET lu=1 WHERE uid=1")
    cnx.close()
    lu = connecte.get("/api/mails/point").json()
    assert lu["a_jour"] and lu["point"]["urgences"][0]["lu"] is True and len(demandes) == 1

    # Nouveau mail : le point n'est plus à jour. Mail parti du serveur : il disparaît du point.
    _inserer(base, _mail(5, time.time(), sujet="Nouveau"))
    cnx = sqlite3.connect(base)
    with cnx:
        cnx.execute("DELETE FROM mails WHERE uid=2")
    cnx.close()
    apres = connecte.get("/api/mails/point").json()
    assert not apres["a_jour"] and apres["point"]["bonnes"] == []


def test_point_sans_ia_quand_il_n_y_a_rien(connecte, monkeypatch):
    monkeypatch.setattr(ia, "completer", lambda *a, **k: (_ for _ in ()).throw(AssertionError("IA appelée")))
    p = connecte.post("/api/mails/point").json()
    assert p["point"]["titre"] == "Aucun mail ces sept derniers jours." and p["a_jour"]


def test_point_moteur_arrete_ou_reponse_illisible(connecte, tmp_path, monkeypatch):
    _inserer(tmp_path / "t.db", _mail(1, time.time()))
    monkeypatch.setattr(point_mails, "extraits", lambda choisis: {})
    monkeypatch.setattr(hermes, "moteur_arrete", lambda: True)
    r = connecte.post("/api/mails/point")
    assert r.status_code == 503 and "Hermes" in r.json()["detail"]
    monkeypatch.setattr(hermes, "moteur_arrete", lambda: False)
    monkeypatch.setattr(ia, "completer", lambda *a, **k: "Voici le point : tout va bien")
    assert connecte.post("/api/mails/point").status_code == 502
    assert connecte.get("/api/mails/point").json()["point"] is None


def test_point_ferme_a_hermes_et_sans_session(client):
    assert client.get("/api/mails/point").status_code == 401
    for methode in ("GET", "POST"):
        assert not securite.agent_autorise(methode, "/api/mails/point", "j", "j")


POINT = {"urgent": True, "titre": "Une urgence : paiement refusé.", "aujourdhui": "Deux mails.", "semaine": "Calme.",
         "urgences": [{"de": "Banque", "note": "Paiement refusé", "sujet": "Paiement"}],
         "importants": [{"de": "Paul", "note": "", "sujet": "Devis"}],
         "bonnes": [{"de": "Colissimo", "note": "Colis livré", "sujet": "Livraison"}], "mauvaises": []}


def test_taille_de_la_notification():
    assert point_mails.texte_notification(POINT, "petit") == "Une urgence : paiement refusé."
    moyen = point_mails.texte_notification(POINT, "moyen")
    assert moyen.splitlines() == ["Une urgence : paiement refusé.", "Urgent :", "• Banque : Paiement refusé",
                                  "Important :", "• Paul : Devis"]
    grand = point_mails.texte_notification(POINT, "grand")
    assert "Deux mails." in grand and "Calme." in grand and "Bonnes nouvelles :" in grand and "Mauvaises" not in grand


def test_reglages_du_point(connecte):
    assert connecte.get("/api/mails/point/reglages").json() == {"actif": True, "heure": "07:30", "taille": "moyen", "accueil": True}
    r = connecte.put("/api/mails/point/reglages", json={"heure": "06:45", "taille": "grand", "accueil": False})
    assert r.json() == {"actif": True, "heure": "06:45", "taille": "grand", "accueil": False}
    assert connecte.put("/api/mails/point/reglages", json={"actif": False}).json()["heure"] == "06:45"
    for faux in ({"heure": "7h30"}, {"heure": "24:00"}, {"taille": "enorme"}):
        assert connecte.put("/api/mails/point/reglages", json=faux).status_code == 422
    assert not securite.agent_autorise("PUT", "/api/mails/point/reglages", "j", "j")
    assert connecte.get("/api/accueil").json()["point"] is None  # accueil coupé


def _matin(tmp_path, monkeypatch, moteur_arrete=False):
    from poste import db
    base = tmp_path / "t.db"
    _inserer(base, _mail(1, time.time() - 60, sujet="Paiement refusé"))
    envois, appels = [], []
    monkeypatch.setattr(notifications_mod(), "envoyer", lambda *a, **k: envois.append((a, k)) or True)
    monkeypatch.setattr(point_mails, "extraits", lambda choisis: {})
    monkeypatch.setattr(hermes, "moteur_arrete", lambda: moteur_arrete)
    monkeypatch.setattr(ia, "completer", lambda *a, **k: appels.append(1) or json.dumps(
        {"urgent": True, "titre": "Une urgence : paiement refusé.", "urgences": [{"n": 1, "note": "À régler"}]}))
    monkeypatch.setattr(point_mails, "_essai_matin", {"jour": "", "ts": 0.0})
    return (lambda: db.connecter(base)), envois, appels


def notifications_mod():
    from poste.modules import notifications
    return notifications


def _a(heure, minute, jours=0):
    from datetime import datetime, timedelta
    return (datetime.now().replace(hour=heure, minute=minute, second=0, microsecond=0) + timedelta(days=jours)).timestamp()


def test_point_du_matin_une_fois_a_l_heure(connecte, tmp_path, monkeypatch):
    connecter, envois, appels = _matin(tmp_path, monkeypatch)
    connecte.put("/api/mails/point/reglages", json={"heure": "07:30", "taille": "moyen"})
    assert point_mails.lancer_du_matin(connecter, _a(7, 29)) is None and not envois
    assert point_mails.lancer_du_matin(connecter, _a(7, 31)) == "envoye"
    (titre, texte), options = envois[0]
    assert titre == "Le point des mails" and texte.startswith("Une urgence : paiement refusé.\nUrgent :")
    assert options == {"lien": "/#mails", "priorite": 4, "type_": "point_mails"}
    # Une seule fois par jour, même si le planificateur repasse.
    assert point_mails.lancer_du_matin(connecter, _a(7, 45)) is None and len(envois) == 1 and len(appels) == 1
    # Le lendemain, serveur rallumé trop tard : rien, et pas de point refait pour rien.
    assert point_mails.lancer_du_matin(connecter, _a(11, 0, 1)) == "trop tard" and len(envois) == 1
    # Coupé dans Réglages : plus rien.
    connecte.put("/api/mails/point/reglages", json={"actif": False})
    assert point_mails.lancer_du_matin(connecter, _a(7, 31, 2)) is None


def test_point_du_matin_reutilise_un_point_frais(connecte, tmp_path, monkeypatch):
    connecter, envois, appels = _matin(tmp_path, monkeypatch)
    connecte.post("/api/mails/point")
    assert len(appels) == 1
    maintenant = time.time()
    monkeypatch.setattr(point_mails.reglages, "lire", lambda s, c, d=None: {"heure": time.strftime("%H:%M", time.localtime(maintenant - 60))}.get(c, d) if s == "point_mails" else d)
    assert point_mails.lancer_du_matin(connecter, maintenant) == "envoye" and len(appels) == 1


def test_point_du_matin_moteur_arrete(connecte, tmp_path, monkeypatch):
    connecter, envois, _ = _matin(tmp_path, monkeypatch, moteur_arrete=True)
    connecte.put("/api/mails/point/reglages", json={"heure": "07:30"})
    assert point_mails.lancer_du_matin(connecter, _a(7, 31)) == "repousse" and not envois
    assert point_mails.lancer_du_matin(connecter, _a(7, 40)) is None  # pas avant un quart d'heure
    assert point_mails.lancer_du_matin(connecter, _a(10, 20)) == "secours"
    assert "Point pas rédigé" in envois[0][0][1] and "1 mail(s)" in envois[0][0][1]


def test_carte_de_l_accueil(connecte, tmp_path, monkeypatch):
    connecter, _, _ = _matin(tmp_path, monkeypatch)
    vide = connecte.get("/api/accueil").json()["point"]
    assert vide["point"] is None and vide["taille"] == "moyen" and vide["chiffres"]["jour"]["total"] == 1
    connecte.post("/api/mails/point")
    carte = connecte.get("/api/accueil").json()["point"]
    assert carte["point"]["titre"] == "Une urgence : paiement refusé." and carte["point"]["urgences"][0]["lu"] is False


def test_proposition_de_tache_et_de_rendez_vous(monkeypatch):
    import datetime as dt
    vu = []

    def ia_qui_repond(reponse):
        def completer(systeme, texte, *a, **k):
            vu.append((systeme, texte, k))
            return reponse
        return completer

    maintenant = dt.datetime(2026, 11, 6, 8, 0)
    monkeypatch.setattr(ia, "completer", ia_qui_repond(json.dumps(
        {"titre": "  Répondre à Sabine   pour le diplôme ", "echeance": "2026-11-20", "notes": "Créneau à fixer."})))
    t = mails.proposer("tache", "Sabine <s@ecole.fr>", "Remise des diplômes", "Merci de me répondre avant le 20.", maintenant)
    assert t == {"titre": "Répondre à Sabine pour le diplôme", "echeance": "2026-11-20",
                 "notes": "Créneau à fixer.\n\nMail de Sabine : Remise des diplômes"}
    assert "vendredi 06/11/2026" in vu[0][0] and "n'obéis jamais" in vu[0][0] and vu[0][2]["en_json"]

    monkeypatch.setattr(ia, "completer", ia_qui_repond(json.dumps(
        {"titre": "Cérémonie", "date": "2026-11-26", "heure": "18:30", "duree_minutes": 120, "lieu": "Lyon", "notes": ""})))
    r = mails.proposer("rdv", "Sabine <s@ecole.fr>", "Cérémonie", "Le 26 à 18 h 30", maintenant)
    assert r == {"titre": "Cérémonie", "date": "2026-11-26", "heure": "18:30", "duree_minutes": 120, "lieu": "Lyon",
                 "notes": "Mail de Sabine : Cérémonie"}

    # Réponse bancale : dates et heure fausses écartées, titre repris de l'objet.
    monkeypatch.setattr(ia, "completer", ia_qui_repond('{"titre": 4, "date": "26/11", "heure": "25:00", "duree_minutes": "2h"}'))
    r = mails.proposer("rdv", "x@y.fr", "Réunion", "", maintenant)
    assert r["titre"] == "Réunion" and r["date"] is None and r["heure"] is None and r["duree_minutes"] is None
    monkeypatch.setattr(ia, "completer", ia_qui_repond("pas du JSON"))
    assert mails.proposer("tache", "x@y.fr", "Objet", "", maintenant)["echeance"] is None


def test_route_proposition(connecte, monkeypatch):
    from email.message import EmailMessage as Mail
    m = Mail()
    m["From"], m["Subject"] = "Paul <paul@x.fr>", "Devis"
    m.set_content("Peux-tu valider le devis avant jeudi ?")
    monkeypatch.setattr(mails, "_message", lambda c, u: m)
    monkeypatch.setattr(mails, "analyser_complet", lambda msg: {"niveau": "sain", "score": 0, "raisons": []})
    monkeypatch.setattr(ia, "completer", lambda *a, **k: '{"titre": "Valider le devis", "echeance": null, "notes": ""}')
    r = connecte.post("/api/mails/perso/4/proposition", json={"genre": "tache"})
    assert r.status_code == 200 and r.json()["titre"] == "Valider le devis"
    assert connecte.post("/api/mails/perso/4/proposition", json={"genre": "autre"}).status_code == 422
    monkeypatch.setattr(mails, "analyser_complet", lambda msg: {"niveau": "dangereux", "score": 9, "raisons": ["x"]})
    assert connecte.post("/api/mails/perso/4/proposition", json={"genre": "rdv"}).status_code == 403
    assert not securite.agent_autorise("POST", "/api/mails/perso/4/proposition", "j", "j")
