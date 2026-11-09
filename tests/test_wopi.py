import re

from poste.modules import wopi


class Reponse:
    text = '<action ext="docx" name="edit" urlsrc="https://bureau.test/cool.html?"/>'


def session(connecte, monkeypatch, chemin="a.docx"):
    monkeypatch.setattr(wopi.httpx, "get", lambda *a, **k: Reponse())
    connecte.post("/api/espace/envoyer", params={"nom": chemin}, content=b"un")
    r = connecte.post("/api/espace/bureau/session", json={"chemin": chemin})
    assert r.status_code == 200, r.text
    return r.json()["jeton"], r.json()["url"]


def test_session_demande_une_connexion(client):
    assert client.post("/api/espace/bureau/session", json={"chemin": "a.docx"}).status_code == 401


def test_le_jeton_n_ouvre_que_son_fichier(connecte, monkeypatch):
    j, url = session(connecte, monkeypatch)
    assert j not in url.split("WOPISrc")[0] and "&lang=fr-FR&ui_defaults=UITheme%3Ddark" in url
    infos = connecte.get(f"/wopi/files/{j}", params={"access_token": j}).json()
    assert infos["BaseFileName"] == "a.docx" and infos["UserCanWrite"] is True
    assert connecte.get(f"/wopi/files/{j}", params={"access_token": "faux"}).status_code == 401
    assert connecte.get("/wopi/files/inconnu", params={"access_token": "inconnu"}).status_code == 401
    assert connecte.get(f"/wopi/files/{j}/contents", params={"access_token": j}).content == b"un"


def test_enregistrer_sauvegarde_une_seule_fois_et_detecte_un_conflit(connecte, monkeypatch):
    j, _ = session(connecte, monkeypatch)
    p = {"access_token": j}
    assert connecte.post(f"/wopi/files/{j}/contents", params=p, content=b"deux").status_code == 200
    assert connecte.post(f"/wopi/files/{j}/contents", params=p, content=b"trois").status_code == 200
    assert connecte.get("/api/espace/telecharger", params={"chemin": "a.docx"}).content == b"trois"
    assert len(connecte.get("/api/espace/corbeille").json()) == 1
    r = connecte.post(f"/wopi/files/{j}/contents", params=p, content=b"x", headers={"X-COOL-WOPI-Timestamp": "2000-01-01T00:00:00.000000Z"})
    assert r.status_code == 409 and r.json()["COOLStatusCode"] == 1010
    assert connecte.post(f"/wopi/files/{j}/contents", params=p, content=b"").status_code == 422
    assert connecte.get("/api/espace/telecharger", params={"chemin": "a.docx"}).content == b"trois"


def test_format_non_bureautique_refuse(connecte, monkeypatch):
    monkeypatch.setattr(wopi.httpx, "get", lambda *a, **k: Reponse())
    connecte.put("/api/espace/fichier", json={"chemin": "n.html", "contenu": "x"})
    assert connecte.post("/api/espace/bureau/session", json={"chemin": "n.html"}).status_code == 415


def test_seul_collabora_peut_s_afficher_dans_poste(connecte):
    politique = connecte.get("/api/auth/etat").headers["content-security-policy"]
    assert re.search(r"frame-src 'self' https?://\S+", politique) and "frame-ancestors 'none'" in politique
