"""Strava : flux d'autorisation, jetons protégés, synchro incrémentale, accès en lecture seule pour Hermes."""
import stat
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from poste import db, securite
from poste.modules import sport


@pytest.fixture
def conf(tmp_path, monkeypatch):
    fichier = tmp_path / "strava.env"
    fichier.write_text("STRAVA_CLIENT_ID=123\nSTRAVA_CLIENT_SECRET=secret-de-test\n")
    monkeypatch.setattr(sport, "CONF", fichier)
    monkeypatch.setattr(sport, "JETONS", tmp_path / "jetons.json")
    return tmp_path


def _etat(connecte):
    r = connecte.get("/api/sport/connexion", follow_redirects=False)
    assert r.status_code == 307
    q = parse_qs(urlsplit(r.headers["location"]).query)
    assert q["scope"] == ["read,activity:read_all"] and "client_secret" not in q and "secret-de-test" not in r.headers["location"]
    return q["state"][0]


def test_retour_controle_le_state_et_la_portee(connecte, conf, monkeypatch):
    monkeypatch.setattr(sport, "_echange", lambda d: {"access_token": "a", "refresh_token": "r", "expires_at": 9e9, "autre": "x"})
    assert connecte.get("/api/sport/retour", params={"state": "faux", "code": "c", "scope": "read,activity:read_all"}).status_code == 400
    assert not sport.JETONS.exists()
    assert connecte.get("/api/sport/retour", params={"state": _etat(connecte), "code": "c", "scope": "read"}).status_code == 400
    assert not sport.JETONS.exists()
    etat = _etat(connecte)
    assert connecte.get("/api/sport/retour", params={"state": etat, "code": "c", "scope": "read,activity:read_all"}).status_code == 200
    assert stat.S_IMODE(sport.JETONS.stat().st_mode) == 0o600
    assert "autre" not in sport.JETONS.read_text()
    # Un state ne sert qu'une fois.
    assert connecte.get("/api/sport/retour", params={"state": etat, "code": "c", "scope": "read,activity:read_all"}).status_code == 400


def test_jeton_rafraichi_avant_expiration(conf, monkeypatch):
    sport.ecrire_jetons({"access_token": "vieux", "refresh_token": "r", "expires_at": 0})
    monkeypatch.setattr(sport, "_echange", lambda d: {"access_token": "neuf", "refresh_token": "r2", "expires_at": 9e9})
    assert sport.jeton_valide() == "neuf"
    assert sport.lire_jetons()["refresh_token"] == "r2"


def test_synchro_par_pages_et_resume(tmp_path, conf, monkeypatch):
    base = tmp_path / "s.db"
    db.initialiser(base, [sport.SCHEMA])
    sport.ecrire_jetons({"access_token": "a", "refresh_token": "r", "expires_at": 9e9})
    appels = []

    def faux_get(url, **k):
        appels.append(k["params"])
        page = k["params"]["page"]
        lot = [{"id": page * 1000 + i, "start_date": "2026-10-20T08:00:00Z", "sport_type": "Run", "name": "Footing", "distance": 10000,
                "moving_time": 3000, "total_elevation_gain": 50, "average_heartrate": 150} for i in range(100 if page == 1 else 3)]
        return httpx.Response(200, json=lot, request=httpx.Request("GET", url))

    monkeypatch.setattr(sport.httpx, "get", faux_get)
    assert sport.synchroniser(lambda: db.connecter(base)) == 103
    assert [a["page"] for a in appels] == [1, 2] and appels[0]["after"] == 0
    cnx = db.connecter(base)
    r = sport.resume(cnx, maintenant=1_793_000_000 + 86400 * 2)
    cnx.close()
    assert r["total_activites"] == 103 and r["records"]["Run"]["plus_longue_km"] == 10
    assert r["dernieres"][0]["allure_min_km"] == 5


def test_quota_strava_arrete_sans_erreur(tmp_path, conf, monkeypatch):
    base = tmp_path / "s.db"
    db.initialiser(base, [sport.SCHEMA])
    sport.ecrire_jetons({"access_token": "a", "refresh_token": "r", "expires_at": 9e9})
    monkeypatch.setattr(sport.httpx, "get", lambda url, **k: httpx.Response(429, request=httpx.Request("GET", url)))
    assert sport.synchroniser(lambda: db.connecter(base)) == 0


def test_hermes_lit_seulement(client, conf):
    for chemin in ("/api/sport/resume", "/api/sport/activites"):
        assert securite.agent_autorise("GET", chemin, "j", "j")
        assert client.get(chemin).status_code == 401
    for methode, chemin in (("GET", "/api/sport/connexion"), ("GET", "/api/sport/etat"), ("POST", "/api/sport/deconnecter"), ("POST", "/api/sport/synchroniser")):
        assert not securite.agent_autorise(methode, chemin, "j", "j"), chemin
        assert client.request(methode, chemin, follow_redirects=False).status_code == 401


def test_non_configure(connecte, tmp_path, monkeypatch):
    monkeypatch.setattr(sport, "CONF", tmp_path / "absent")
    monkeypatch.setattr(sport, "JETONS", tmp_path / "absent2")
    assert connecte.get("/api/sport/etat").json() == {"configure": False, "connecte": False, "activites": 0}
    assert connecte.get("/api/sport/connexion", follow_redirects=False).status_code == 503


def test_identifiants_enregistres_jamais_rendus(connecte, conf):
    sport.CONF.unlink()
    assert connecte.post("/api/sport/identifiants", json={"client_id": "abc", "client_secret": "x" * 40}).status_code == 422
    assert connecte.post("/api/sport/identifiants", json={"client_id": "12", "client_secret": "a\nINJECTE=1aaaaaaaaaaaaaaaaaaaaaaa"}).status_code == 422
    assert not sport.CONF.exists()
    r = connecte.post("/api/sport/identifiants", json={"client_id": "12", "client_secret": "s" * 40})
    assert r.status_code == 200 and "sss" not in r.text
    assert stat.S_IMODE(sport.CONF.stat().st_mode) == 0o600
    assert sport.identifiants() == ("12", "s" * 40)
    assert "sss" not in connecte.get("/api/sport/etat").text


def test_identifiants_fermes_a_hermes_et_sans_session(client, conf):
    assert not securite.agent_autorise("POST", "/api/sport/identifiants", "j", "j")
    assert client.post("/api/sport/identifiants", json={"client_id": "1", "client_secret": "s" * 40}).status_code == 401
