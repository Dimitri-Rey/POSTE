import pytest

from poste.modules import sites


def test_sites_ajoutes_au_menu_et_permis_dans_les_cadres(connecte, origine):
    assert connecte.get("/api/sites").json() == []
    assert "crm.exemple.fr" not in connecte.get("/api/sites").headers["content-security-policy"]
    r = connecte.post("/api/sites", json={"nom": "CRM", "adresse": "https://crm.exemple.fr:8443/tableau?vue=1"}, headers={"origin": origine})
    assert r.status_code == 201
    ident = r.json()["id"]
    assert connecte.get("/api/sites").json() == [{"id": ident, "nom": "CRM", "adresse": "https://crm.exemple.fr:8443/tableau?vue=1"}]
    politique = connecte.get("/api/accueil").headers["content-security-policy"]
    assert "frame-src 'self'" in politique and "https://crm.exemple.fr:8443" in politique
    assert connecte.delete(f"/api/sites/{ident}", headers={"origin": origine}).status_code == 204
    assert "crm.exemple.fr" not in connecte.get("/api/accueil").headers["content-security-policy"]
    assert connecte.delete(f"/api/sites/{ident}", headers={"origin": origine}).status_code == 404


@pytest.mark.parametrize("adresse", ["javascript:alert(1)", "file:///etc/passwd", "https://", "https://moi:mdp@exemple.fr",
                                     "https://exemple.fr/ 'unsafe-inline'", "https://exemple.fr;script-src *", "http://testserver/"])
def test_adresses_refusees(connecte, origine, adresse):
    assert connecte.post("/api/sites", json={"nom": "X", "adresse": adresse}, headers={"origin": origine}).status_code == 422
    assert sites.origines() == ()


def test_sites_reserves_a_la_session(client):
    assert client.get("/api/sites").status_code == 401
