"""Veille IMAP de bout en bout, contre un vrai serveur d'essai (jamais une vraie boîte) :
POSTE_IMAP_ESSAI=hote:port:utilisateur:mot_de_passe (par exemple un conteneur dovecot/dovecot jetable)."""
import imaplib
import os
import ssl
import time

import pytest

from poste import db
from poste.modules import mails, notifications, veille_mails

ESSAI = os.environ.get("POSTE_IMAP_ESSAI")
pytestmark = pytest.mark.skipif(not ESSAI, reason="POSTE_IMAP_ESSAI non défini")


def _boite():
    hote, port, utilisateur, mdp = ESSAI.split(":")
    contexte = ssl.create_default_context()
    contexte.check_hostname, contexte.verify_mode = False, ssl.CERT_NONE
    b = imaplib.IMAP4_SSL(hote, int(port), ssl_context=contexte, timeout=20)
    b.login(utilisateur, mdp)
    return b


def _deposer(b, sujet, de="Paul <paul@exemple.fr>"):
    corps = f"From: {de}\r\nTo: moi@exemple.fr\r\nSubject: {sujet}\r\nDate: Thu, 05 Nov 2026 10:00:00 +0100\r\n\r\nBonjour.\r\n"
    b.append("INBOX", None, imaplib.Time2Internaldate(time.time()), corps.encode())


def _attendre(condition, delai=10):
    fin = time.time() + delai
    while time.time() < fin:
        if condition():
            return True
        time.sleep(0.2)
    return False


def test_veille_voit_arrivees_lectures_et_suppressions(tmp_path, monkeypatch):
    hote, port, utilisateur, mdp = ESSAI.split(":")
    compte = mails.Compte("essai", "moi@exemple.fr", hote, int(port), utilisateur, mdp, tls_local=True)
    monkeypatch.setattr(mails, "charger_comptes", lambda: [compte])
    monkeypatch.setattr(mails, "domaines_interdits", lambda: [])
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(a) or True)
    base = tmp_path / "t.db"
    db.initialiser(base, [mails.SCHEMA, mails.SCHEMA_BLOCAGE])
    connecter = lambda: db.connecter(base)
    lignes = lambda: {l["sujet"]: l["lu"] for l in connecter().execute("SELECT sujet, lu FROM mails")}

    b = _boite()
    b.select("INBOX")
    b.uid("STORE", "1:*", "+FLAGS", r"(\Deleted)")
    b.expunge()
    for n in range(3):
        _deposer(b, f"Ancien {n}")
    assert mails.synchroniser_tout(connecter, lambda *a: None) == {"essai": 3}
    assert mails.synchroniser_tout(connecter, lambda *a: None) == {"essai": 0}

    veille = veille_mails.Veille(connecter, lambda *a: None)
    veille.demarrer()
    try:
        time.sleep(1.5)
        debut = time.time()
        _deposer(b, "Arrivé en direct")
        assert _attendre(lambda: "Arrivé en direct" in lignes()), "arrivée non vue"
        print(f"arrivée vue en {time.time() - debut:.1f} s")
        assert envois and envois[-1][1] == "Arrivé en direct"
        _, uids = b.uid("SEARCH", None, "ALL")
        premier, deuxieme = uids[0].split()[:2]
        b.uid("STORE", premier, "+FLAGS", r"(\Seen)")
        assert _attendre(lambda: lignes().get("Ancien 0") == 1), "lecture ailleurs non vue"
        b.uid("STORE", deuxieme, "+FLAGS", r"(\Deleted)")
        b.expunge()
        assert _attendre(lambda: "Ancien 1" not in lignes()), "suppression ailleurs non vue"
    finally:
        for v in veille.veilleurs.values():
            v.arret.set()
        b.logout()
