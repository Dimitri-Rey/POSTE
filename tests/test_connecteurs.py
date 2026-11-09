"""Branchements : coffre chiffré, comptes mail, agendas iCal et CalDAV, IA, dictée, notifications, modules."""
import email
import email.policy
import sqlite3
from datetime import datetime, timedelta

import httpx
import pytest

from poste import coffre, reglages
from poste.modules import connecteurs, ia, mails

MAINTENANT = datetime.now()
J = (MAINTENANT + timedelta(days=2)).strftime("%Y%m%d")
J_ISO = (MAINTENANT + timedelta(days=2)).strftime("%Y-%m-%d")
J4 = (MAINTENANT + timedelta(days=4)).strftime("%Y%m%d")

ICS = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//FR
BEGIN:VEVENT
UID:rdv-1
DTSTART:{J}T090000Z
DTEND:{J}T100000Z
SUMMARY:Dentiste
LOCATION:Cabinet
END:VEVENT
BEGIN:VEVENT
UID:conges
DTSTART;VALUE=DATE:{J}
DTEND;VALUE=DATE:{J4}
SUMMARY:Congés
END:VEVENT
BEGIN:VEVENT
UID:sport
DTSTART;TZID=Europe/Paris:{J}T180000
DTEND;TZID=Europe/Paris:{J}T190000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Escalade
END:VEVENT
BEGIN:VEVENT
UID:annule
DTSTART:{J}T120000Z
SUMMARY:Annulé
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR
""".replace("\n", "\r\n").encode()


def test_coffre_chiffre_et_cle_perdue(tmp_path, monkeypatch):
    base = tmp_path / "c.db"
    coffre.ouvrir(base)
    coffre.ecrire("x", "mot-de-passe-secret")
    assert coffre.lire("x") == "mot-de-passe-secret"
    assert b"mot-de-passe-secret" not in base.read_bytes()
    assert (coffre.chemin_cle().stat().st_mode & 0o777) == 0o600
    # Autre clé (base copiée ailleurs) : le secret est illisible, sans planter.
    monkeypatch.setenv("POSTE_CLE", str(tmp_path / "autre-cle"))
    assert coffre.lire("x") is None
    coffre.effacer("x")
    assert not coffre.defini("x")


def test_ical_heures_journees_repetitions_et_annulations():
    du, au = MAINTENANT.astimezone() - timedelta(days=1), MAINTENANT.astimezone() + timedelta(days=30)
    evts = connecteurs.evenements_ical([ICS], du, au)
    titres = [e["titre"] for e in evts]
    assert "Annulé" not in titres
    assert titres.count("Escalade") == 3
    assert titres.count("Congés") == 2  # du J au J4 exclu : deux jours
    dentiste = next(e for e in evts if e["titre"] == "Dentiste")
    attendu = datetime.fromisoformat(f"{J_ISO}T09:00:00+00:00").astimezone().strftime("%Y-%m-%dT%H:%M")
    assert dentiste["debut"] == attendu and dentiste["lieu"] == "Cabinet" and not dentiste["journee"]
    conges = [e for e in evts if e["titre"] == "Congés"]
    assert all(e["journee"] and e["debut"].endswith("T00:00") for e in conges)


def test_lien_ics_controle():
    assert connecteurs._lien_ics("webcal://exemple.fr/a.ics") == "https://exemple.fr/a.ics"
    for mauvais in ("ftp://x/a.ics", "file:///etc/passwd", "exemple.fr/a.ics"):
        with pytest.raises(connecteurs.ErreurBranchement):
            connecteurs._lien_ics(mauvais)


def test_agenda_ics_branche_puis_retire(connecte, monkeypatch):
    monkeypatch.setattr(connecteurs, "lire_ics", lambda url, u="", m="": [ICS])
    r = connecte.post("/api/connecteurs/agendas", json={"nom": "Perso", "type": "ics", "url": "https://agenda.exemple.fr/secret-123.ics"})
    assert r.status_code == 201, r.text
    ident = r.json()["id"]
    assert r.json()["evenements"] >= 6
    agenda = connecte.get(f"/api/agenda?du={J_ISO}T00:00&au={J_ISO}T23:59").json()
    externes = [e for e in agenda if e.get("externe")]
    assert {e["titre"] for e in externes} == {"Dentiste", "Congés", "Escalade"}
    assert all(e["source"] == "Perso" for e in externes)
    assert agenda[0]["journee"]  # la journée entière passe en tête du jour
    # Le lien secret ne ressort jamais : seul le nom du serveur s'affiche.
    etat = connecte.get("/api/connecteurs").text
    assert "secret-123" not in etat and "agenda.exemple.fr" in etat
    # Lecture seule : un événement externe ne se modifie pas par l'API de l'agenda local.
    assert connecte.delete(f"/api/agenda/{externes[0]['id']}").status_code == 422
    assert connecte.delete(f"/api/connecteurs/agendas/{ident}").status_code == 200
    assert not [e for e in connecte.get(f"/api/agenda?du={J_ISO}T00:00&au={J_ISO}T23:59").json() if e.get("externe")]


def test_agenda_en_panne_garde_sa_copie(connecte, monkeypatch):
    monkeypatch.setattr(connecteurs, "lire_ics", lambda url, u="", m="": [ICS])
    ident = connecte.post("/api/connecteurs/agendas", json={"nom": "P", "type": "ics", "url": "https://a.fr/x.ics"}).json()["id"]

    def panne(*a, **k):
        raise connecteurs.ErreurBranchement("Agenda injoignable : vérifie le lien.")
    monkeypatch.setattr(connecteurs, "lire_ics", panne)
    r = connecte.post(f"/api/connecteurs/agendas/{ident}/actualiser")
    assert r.status_code == 422 and "injoignable" in r.json()["detail"]
    agenda = next(a for a in connecte.get("/api/connecteurs").json()["agendas"] if a["id"] == ident)
    assert agenda["erreur"] and agenda["evenements"] >= 6


def _caldav(requete: httpx.Request) -> httpx.Response:
    """Serveur CalDAV minimal : racine -> principal -> dossier des agendas -> un agenda d'événements, un de tâches."""
    xml = lambda corps: httpx.Response(207, text=f'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">{corps}</d:multistatus>')
    ok = lambda href, prop: f"<d:response><d:href>{href}</d:href><d:propstat><d:prop>{prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
    if requete.headers.get("authorization") != httpx.BasicAuth("moi", "mdp")._auth_header:
        return httpx.Response(401)
    chemin = requete.url.path
    if requete.method == "PROPFIND" and chemin == "/dav/":
        return xml(ok("/dav/", "<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>/dav/principals/moi/</d:href></d:current-user-principal>"))
    if requete.method == "PROPFIND" and chemin == "/dav/principals/moi/":
        return xml(ok(chemin, "<c:calendar-home-set><d:href>/dav/calendars/moi/</d:href></c:calendar-home-set>"))
    if requete.method == "PROPFIND" and chemin == "/dav/calendars/moi/":
        assert requete.headers["depth"] == "1"
        return xml(ok(chemin, "<d:resourcetype><d:collection/></d:resourcetype>")
                   + ok("/dav/calendars/moi/perso/", "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
                        "<c:supported-calendar-component-set><c:comp name=\"VEVENT\"/></c:supported-calendar-component-set>")
                   + ok("/dav/calendars/moi/taches/", "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>"
                        "<c:supported-calendar-component-set><c:comp name=\"VTODO\"/></c:supported-calendar-component-set>"))
    if requete.method == "REPORT" and chemin == "/dav/calendars/moi/perso/":
        assert b"time-range" in requete.content
        return xml(ok("/dav/calendars/moi/perso/1.ics", f"<c:calendar-data>{ICS.decode()}</c:calendar-data>"))
    return httpx.Response(404)


def test_caldav_decouverte_et_lecture(monkeypatch):
    monkeypatch.setattr(connecteurs, "_client", lambda u="", m="": httpx.Client(
        transport=httpx.MockTransport(_caldav), auth=(u, m) if u else None, follow_redirects=True))
    evts = connecteurs.lire_agenda("caldav", "https://cal.exemple.fr/dav/", "moi", "mdp")
    assert {e["titre"] for e in evts} == {"Dentiste", "Congés", "Escalade"}
    with pytest.raises(connecteurs.ErreurBranchement, match="refusé"):
        connecteurs.lire_agenda("caldav", "https://cal.exemple.fr/dav/", "moi", "faux")


def test_compte_mail_branche_teste_et_retire(connecte, monkeypatch):
    essais = []
    monkeypatch.setattr(connecteurs, "tester_imap", lambda *a, **k: essais.append(a))
    monkeypatch.setattr(mails, "synchroniser_tout", lambda *a: {})
    corps = {"nom": "Perso", "adresse": "Jean.Dupont@gmail.com", "hote": "imap.gmail.com", "port": 993, "mot_de_passe": "abcd efgh"}
    r = connecte.post("/api/connecteurs/mails", json=corps)
    assert r.status_code == 201, r.text
    assert essais == [("imap.gmail.com", 993, "Jean.Dupont@gmail.com", "abcd efgh")]
    ident = r.json()["id"]
    assert ident == "jean-dupont"
    compte = next(c for c in mails.charger_comptes() if c.id == ident)
    assert compte.mot_de_passe == "abcd efgh" and compte.adresse == "jean.dupont@gmail.com"
    # Deuxième boîte du même nom : identifiant distinct. Le mot de passe ne ressort jamais.
    assert connecte.post("/api/connecteurs/mails", json={**corps, "adresse": "jean.dupont@icloud.com"}).json()["id"] == "jean-dupont-2"
    assert "abcd" not in connecte.get("/api/connecteurs").text
    assert connecte.get("/api/mails/comptes").json()[0]["adresse"] == "jean.dupont@gmail.com"
    assert connecte.delete(f"/api/connecteurs/mails/{ident}").status_code == 200
    assert ident not in [c.id for c in mails.charger_comptes()]
    assert connecte.delete("/api/connecteurs/mails/inconnu").status_code == 404


def test_compte_mail_refuse_si_la_connexion_echoue(connecte, monkeypatch):
    def refus(*a, **k):
        raise connecteurs.ErreurBranchement("Identifiant ou mot de passe refusé par le serveur.")
    monkeypatch.setattr(connecteurs, "tester_imap", refus)
    r = connecte.post("/api/connecteurs/mails", json={"adresse": "a@b.fr", "hote": "imap.b.fr", "mot_de_passe": "x"})
    assert r.status_code == 422 and "refusé" in r.json()["detail"]
    assert not connecte.get("/api/connecteurs").json()["comptes"]
    assert connecte.post("/api/connecteurs/mails", json={"adresse": "a@b.fr", "hote": "imap.b.fr; rm", "mot_de_passe": "x"}).status_code == 422


def test_ia_reglee_dans_l_interface(connecte, monkeypatch):
    r = connecte.put("/api/connecteurs/ia", json={"adresse": "https://api.exemple.fr/v1/", "modele": "petit", "cle": "sk-secret"})
    assert r.status_code == 200 and r.json() == {"adresse": "https://api.exemple.fr", "modele": "petit", "cle": True}
    assert ia.adresse() == "https://api.exemple.fr" and ia.modele() == "petit"
    assert ia.entetes() == {"Authorization": "Bearer sk-secret"}
    assert "sk-secret" not in connecte.get("/api/connecteurs").text
    # Clé absente du corps : on la garde ; chaîne vide : on l'efface.
    connecte.put("/api/connecteurs/ia", json={"adresse": "http://127.0.0.1:11434", "modele": ""})
    assert ia.entetes() and ia.adresse() == "http://127.0.0.1:11434"
    connecte.put("/api/connecteurs/ia", json={"adresse": "", "modele": "", "cle": ""})
    assert not ia.entetes() and ia.adresse() == "http://127.0.0.1:9"  # retour à poste.toml
    assert connecte.put("/api/connecteurs/ia", json={"adresse": "javascript:alert(1)"}).status_code == 422


def test_ia_reessaie_sans_option_locale(monkeypatch):
    envois = []

    def poster(url, json, **k):
        envois.append(json)
        if "chat_template_kwargs" in json:
            return httpx.Response(400, json={"error": "unknown parameter"}, request=httpx.Request("POST", url))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}, request=httpx.Request("POST", url))
    monkeypatch.setattr(ia.httpx, "post", poster)
    monkeypatch.setattr(ia, "modele", lambda delai=5: "m")
    monkeypatch.setattr(ia, "_sans_option_reflexion", set())
    assert ia.completer("s", "t", 10) == "ok"
    assert ia.completer("s", "t", 10) == "ok"
    assert len(envois) == 3  # un refus, puis deux envois sans l'option


def test_modules_et_notifications_dans_l_interface(connecte):
    assert connecte.get("/api/modules").json()["sport"] is True
    assert connecte.put("/api/connecteurs/modules", json={"sport": False}).json()["sport"] is False
    assert connecte.get("/api/sport/etat").status_code == 404
    assert connecte.put("/api/connecteurs/modules", json={"inconnu": True}).status_code == 422
    r = connecte.put("/api/connecteurs/notifications", json={"actif": False, "adresse": "https://ntfy.sh", "sujet": "mon-sujet", "jeton": "tk_x"})
    assert r.json() == {"actif": False, "adresse": "https://ntfy.sh", "sujet": "mon-sujet", "adresse_publique": "", "jeton": True}
    assert connecte.post("/api/connecteurs/notifications/tester").status_code == 422
    assert connecte.put("/api/connecteurs/notifications", json={"sujet": "a/b"}).status_code == 422


def test_reglages_interface_survivent_au_redemarrage(tmp_path):
    from fastapi.testclient import TestClient
    from poste.app import creer
    from poste.config import Config
    from conftest import MDP
    config = Config(base=tmp_path / "t.db", hotes=("testserver",), origines=("http://testserver",), cookie_secure=False,
                    taches_de_fond=False, jeton_agent=tmp_path / "agent")
    client = TestClient(creer(config))
    client.post("/api/auth/creer", json={"mot_de_passe": MDP})
    client.put("/api/connecteurs/dictee", json={"actif": False, "adresse": "http://stt.exemple.fr"})
    reglages.poser_surcharges({})
    creer(config)
    assert reglages.lire("dictee", "adresse") == "http://stt.exemple.fr" and not reglages.actif("dictee")


def test_hermes_n_a_pas_acces_aux_branchements(connecte, tmp_path):
    jeton = (tmp_path / "agent").read_text()
    connecte.cookies.clear()
    h = {"x-poste-agent": jeton}
    assert connecte.get("/api/mails/comptes", headers=h).status_code == 200
    assert connecte.get("/api/connecteurs", headers=h).status_code == 401
    assert connecte.put("/api/connecteurs/modules", headers=h, json={"hermes": True}).status_code == 401


def test_texte_d_un_mail_html():
    msg = email.message_from_string(
        "From: a@b.fr\nContent-Type: text/html; charset=utf-8\n\n<html><head><style>p{}</style></head>"
        "<body><p>Bonjour</p><script>x()</script><div>Ligne 2</div></body></html>", policy=email.policy.default)
    assert mails.texte_de(msg) == "Bonjour\nLigne 2"


def test_prenom_dans_les_consignes(connecte):
    assert reglages.personnaliser("Tu aides {qui}.") == "Tu aides l'utilisateur."
    assert connecte.put("/api/connecteurs/profil", json={"prenom": "Camille"}).json() == {"prenom": "Camille"}
    assert reglages.personnaliser('Tu aides {qui} : {"json": 1}') == 'Tu aides Camille : {"json": 1}'


def test_repetition_piegee_plafonnee():
    piege = (f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//FR\r\nBEGIN:VEVENT\r\nUID:p\r\nDTSTART:{J}T090000Z\r\n"
             "RRULE:FREQ=SECONDLY\r\nSUMMARY:Bruit\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").encode()
    du, au = MAINTENANT.astimezone() - timedelta(days=1), MAINTENANT.astimezone() + timedelta(days=366)
    debut = datetime.now()
    assert len(connecteurs.evenements_ical([piege], du, au)) == connecteurs.OCCURRENCES_MAX
    assert (datetime.now() - debut).total_seconds() < 20


def test_choix_des_notifications(connecte, monkeypatch):
    from poste.modules import notifications
    envois = []
    monkeypatch.setattr(notifications.httpx, "post", lambda url, **k: envois.append(k["json"]["title"]) or httpx.Response(200, request=httpx.Request("POST", url)))
    connecte.put("/api/connecteurs/modules", json={"notifications": True})
    prefs = connecte.get("/api/connecteurs/alertes").json()
    assert prefs["branche"] and prefs["recevoir"] and all(t["actif"] for t in prefs["types"])
    assert {"mails", "agenda", "taches", "serveur"} <= {t["id"] for t in prefs["types"]}
    # Un type coupé ne part plus, les autres si.
    prefs = connecte.put("/api/connecteurs/alertes", json={"mails": False}).json()
    assert [t["actif"] for t in prefs["types"] if t["id"] == "mails"] == [False]
    assert not notifications.envoyer("Nouveau mail", type_="mails")
    assert notifications.envoyer("RDV", type_="agenda")
    # Tout coupé : plus rien, sauf l'essai lancé depuis Réglages.
    connecte.put("/api/connecteurs/alertes", json={"recevoir": False})
    assert not notifications.envoyer("Alerte", type_="serveur")
    assert connecte.post("/api/connecteurs/notifications/tester").status_code == 200
    assert envois == ["RDV", "Poste"]
    assert connecte.put("/api/connecteurs/alertes", json={"inconnu": True}).status_code == 422
    assert connecte.put("/api/connecteurs/alertes", json={"mails": "oui"}).status_code == 422
    # Un module coupé fait disparaître ses choix.
    connecte.put("/api/connecteurs/modules", json={"serveur": False})
    assert "serveur" not in {t["id"] for t in connecte.get("/api/connecteurs/alertes").json()["types"]}
