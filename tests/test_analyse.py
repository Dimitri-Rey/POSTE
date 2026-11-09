"""Détection : une vraie arnaque doit ressortir, un mail normal ou une lettre d'information non."""
from email.message import EmailMessage

from poste.modules import analyse, mails


def mail(de, sujet="Bonjour", auth=None, **entetes):
    m = EmailMessage()
    m["From"] = de
    m["Subject"] = sujet
    if auth:
        m["Authentication-Results"] = auth
    for cle, val in entetes.items():
        m[cle.replace("_", "-")] = val
    return m


def test_arnaque_contravention_dangereuse():
    v = analyse.analyser(mail("Impots.gouv <noreply@amende-secure.top>", "Contravention en attente – Majoration sous 24h",
                              "mx; dmarc=fail; spf=fail"), liens=[("https://impots-paiement.top/x", "www.impots.gouv.fr")])
    assert v["niveau"] == "dangereux"
    assert any("DMARC" in r for r in v["raisons"]) and any("impots" in r.lower() for r in v["raisons"])


def test_mail_normal_authentifie_sain():
    v = analyse.analyser(mail("Paul <paul@exemple.fr>", "Déjeuner mardi ?", "mx; dkim=pass; spf=pass; dmarc=pass"),
                         texte="On se voit mardi ?")
    assert v == {"niveau": "sain", "score": -2, "raisons": []}


def test_vraie_marque_sur_son_domaine_saine():
    v = analyse.analyser(mail("Amazon <ship@amazon.fr>", "Votre commande", "mx; dkim=pass; dmarc=pass"))
    assert v["niveau"] == "sain"


def test_mot_contenant_une_marque_ne_declenche_rien():
    assert analyse.analyser(mail("Freelance Weekly <a@weekly.io>"))["niveau"] == "sain"


def test_lien_trompeur_et_ip_et_piece_jointe():
    v = analyse.analyser(mail("A <a@x.fr>"), liens=[("http://203.0.113.9/login", "Connexion")], pieces=["facture.pdf.exe"])
    assert v["niveau"] == "dangereux"
    assert any("IP" in r for r in v["raisons"]) and any("exécuter" in r for r in v["raisons"])


def test_motif_de_blocage_controle():
    moi = [mails.Compte("g", "moi@gmail.com", "h", 993, "u", "p"), mails.Compte("c", "bonjour@exemple.fr", "h", 993, "u", "p")]
    assert mails.motif_valide("SPAM@Mal.example ", moi) == "spam@mal.example"
    assert mails.motif_valide("*@mal.example", moi) == "*@mal.example"
    for mauvais in ("*@gmail.com", "x@exemple.fr", "moi@gmail.com", "*@exemple.fr", "pas une adresse", "a@b"):
        try:
            mails.motif_valide(mauvais, moi)
        except mails.HTTPException as err:
            assert err.status_code == 422
        else:
            raise AssertionError(mauvais)
    assert mails.correspond("*@mal.example", "A@Mal.Example") and not mails.correspond("*@mal.example", "a@bmal.example")


def test_actions_interdites_a_hermes_et_sans_session(client):
    from poste import securite
    for methode, chemin in (("POST", "/api/mails/bloques"), ("DELETE", "/api/mails/bloques"), ("POST", "/api/mails/c/1/spam")):
        assert not securite.agent_autorise(methode, chemin, "j", "j"), chemin
        assert client.request(methode, chemin, json={"motif": "a@b.fr"}, params={"motif": "a"}).status_code == 401


def test_blocage_passe_par_serveur_et_spam(connecte, monkeypatch):
    moi = [mails.Compte("c", "moi@moi.fr", "h", 993, "u", "p")]
    appels = []
    monkeypatch.setattr(mails, "charger_comptes", lambda: moi)
    monkeypatch.setattr(mails, "mailcow_bloquer", lambda m: appels.append(("bl", m)) or True)
    monkeypatch.setattr(mails, "mailcow_debloquer", lambda m: appels.append(("deb", m)) or True)
    monkeypatch.setattr(mails, "mettre_en_spam", lambda c, u: appels.append(("spam", u)))
    r = connecte.post("/api/mails/bloques", json={"motif": "x@mal.example", "compte": "c", "uid": 5}).json()
    assert r == {"motif": "x@mal.example", "sur_serveur": True, "range_en_spam": True}
    assert connecte.get("/api/mails/bloques").json()[0]["motif"] == "x@mal.example"
    connecte.delete("/api/mails/bloques", params={"motif": "x@mal.example"})
    assert connecte.get("/api/mails/bloques").json() == []
    assert appels == [("bl", "x@mal.example"), ("spam", 5), ("deb", "x@mal.example")]


def test_deplacement_utilise_le_vrai_dossier_spam():
    class Boite:
        capabilities = ("IMAP4REV1", "MOVE")
        def __init__(self): self.appels = []
        def list(self): return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"']
        def uid(self, *a): self.appels.append(a); return "OK", []
    b = Boite()
    mails.deplacer_vers_spam(b, 7)
    assert b.appels == [("MOVE", "7", '"[Gmail]/Spam"')]


def test_domaines_de_marque_et_noms_de_fichier_sans_fausse_alerte():
    assert not analyse.analyser(mail("A <a@news.fr>"), liens=[("https://link.amazon/x", "Voir")])["raisons"]
    assert not analyse.analyser(mail("A <a@news.fr>"), liens=[("https://cdn.news.fr/i", "image.png")])["raisons"]
    assert analyse.analyser(mail("A <a@news.fr>"), liens=[("https://paypal-secure.mal.example/x", "Voir")])["raisons"]


def test_entetes_utf8_bruts_et_encodes():
    import email as _email
    import email.policy as _politique
    for brut, sujet, de in (
        ("Subject: Arrivé\r\nFrom: Zoé <z@x.fr>\r\n\r\n".encode(), "Arrivé", "Zoé <z@x.fr>"),
        (b"Subject: =?iso-8859-1?q?caf=E9?= et =?utf-8?b?w6l0w6k=?=\r\nFrom: a@x.fr\r\n\r\n", "café et été", "a@x.fr"),
        ("Subject: Caf\xe9\r\nFrom: a@x.fr\r\n\r\n".encode("latin-1"), "Café", "a@x.fr"),
    ):
        m = _email.message_from_bytes(brut, policy=_politique.compat32)
        assert (mails._entete(m.get("Subject")), mails._entete(m.get("From"))) == (sujet, de)


def _msg(entetes):
    import email as _email
    import email.policy as _politique
    return _email.message_from_string("".join(f"{k}: {v}\n" for k, v in entetes.items()) + "\nx", policy=_politique.compat32)


def test_classement_des_mails_importants():
    c = mails.classer
    # Cas vus sur un vrai accueil : publicité et suivi de colis ne sont pas « importants ».
    assert c(_msg({"From": '"Restaurant Exemple" <contact@info-news.restaurant.example>'}), []) == (False, "Adresse d'envoi automatique")
    assert not c(_msg({"From": "Boutique <preferences42@mail.boutique.example>", "Feedback-ID": "x"}), [])[0]
    assert not c(_msg({"From": "Boutique <transaction@notice.boutique.example>", "X-SES-Outgoing": "2026"}), [])[0]
    assert not c(_msg({"From": "info@mutuelle.example", "Feedback-ID": "1:2"}), [])[0]
    assert not c(_msg({"From": "a@b.fr", "Precedence": "bulk"}), [])[0]
    assert not c(_msg({"From": "a@b.fr", "Auto-Submitted": "auto-generated"}), [])[0]
    # Une personne qui écrit, ou à qui l'on a déjà écrit (même par un outil d'envoi), est importante.
    assert c(_msg({"From": "Paul <paul@exemple.fr>"}), []) == (True, "Écrit par une personne, sans signe d'envoi automatique")
    assert c(_msg({"From": "Paul <paul@exemple.fr>", "Feedback-ID": "x"}), [], {"paul@exemple.fr"}) == (True, "Tu as déjà écrit à cette personne")
    assert not c(_msg({"From": "Paul <paul@exemple.fr>"}), ["SPF en échec"], {"paul@exemple.fr"})[0]
    # Gmail donne son avis quand rien d'autre ne tranche ; le choix de l'utilisateur passe avant tout.
    assert c(_msg({"From": "Paul <paul@exemple.fr>"}), [], gmail_important=False) == (False, "Gmail ne le classe pas important")
    assert c(_msg({"From": "x@notice.boutique.example", "Feedback-ID": "x"}), [], choix={"*@notice.boutique.example": True})[0]
    assert not c(_msg({"From": "Paul <paul@exemple.fr>"}), [], {"paul@exemple.fr"}, choix={"paul@exemple.fr": False})[0]
    # Des adresses ordinaires ne sont pas prises pour des robots.
    for adresse in ("information@mairie.fr", "dupont.news@gmail.com", "contact@logiciel.example", "marie@mail.fr"):
        assert c(_msg({"From": adresse}), [])[0], adresse


def test_choix_d_importance(connecte):
    import sqlite3
    base = connecte.app.state.config.base
    cnx = sqlite3.connect(base)
    with cnx:
        cnx.execute("INSERT INTO mails (compte, uid, de, sujet, ts, lu, important, alertes, expediteur) VALUES ('c', 1, 'x', 's', 0, 0, 0, '[]', 'a@notice.exemple.fr')")
    assert connecte.put("/api/mails/importance", json={"motif": "*@notice.exemple.fr", "important": True}).status_code == 200
    assert cnx.execute("SELECT important, pourquoi FROM mails").fetchone() == (1, "Ton choix pour cet expéditeur")
    assert connecte.put("/api/mails/importance", json={"motif": "pas une adresse", "important": True}).status_code == 422
    assert connecte.put("/api/mails/importance", json={"motif": "*@notice.exemple.fr", "important": None}).status_code == 200
    assert cnx.execute("SELECT COUNT(*) FROM expediteurs_importance").fetchone()[0] == 0
    cnx.close()


def test_classement_cas_reels_suite():
    c = mails.classer
    assert not c(_msg({"From": "leboncoin <no.reply@leboncoin.fr>"}), [])[0]
    assert not c(_msg({"From": "WordPress <wordpress@monsite.fr>"}), [])[0]
    faux = _msg({"From": "Cloudflare <music@inconnu.example>", "Subject": "Invitation sondage"})
    assert analyse.analyser(faux)["niveau"] != "sain"
