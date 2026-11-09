"""Documents : envoi, lecture par blocs, droits, et limites face aux fichiers douteux."""
import time

import pytest

from poste import securite
from poste.modules import documents, hermes

ID = "a" * 32


def attendre(client, did):
    for _ in range(100):
        d = client.get(f"/api/documents/{did}").json()
        if d["statut"] != "lecture":
            return d
        time.sleep(0.05)
    raise AssertionError("toujours en lecture")


def test_texte_lu_par_blocs_avec_avertissement(connecte, monkeypatch):
    monkeypatch.setattr(documents, "BLOC", 10)
    did = connecte.post("/api/documents", params={"nom": "note.txt"}, content="Bonjour éàü, voici un texte".encode()).json()["id"]
    assert attendre(connecte, did)["statut"] == "pret"
    a = connecte.get(f"/api/documents/{did}/texte").json()
    assert a["avertissement"] and a["texte"] == "Bonjour éà" and a["suite"] == 10
    b = connecte.get(f"/api/documents/{did}/texte", params={"debut": 10}).json()
    assert b["texte"].startswith("ü") and b["suite"] == 20


def test_nom_nettoye_et_identifiant_controle(connecte):
    r = connecte.post("/api/documents", params={"nom": "../../etc/pas\nbien.txt"}, content=b"x").json()
    assert "/" not in r["nom"] and "\n" not in r["nom"]
    assert connecte.get("/api/documents/..%2F..%2Fetc").status_code in (404, 422)
    assert connecte.get("/api/documents/pasunid").status_code == 422


def test_vide_et_trop_gros_refuses(connecte, monkeypatch):
    assert connecte.post("/api/documents", params={"nom": "v.txt"}, content=b"").status_code == 422
    monkeypatch.setattr(documents, "TAILLE_MAX", 3)
    assert connecte.post("/api/documents", params={"nom": "g.txt"}, content=b"abcdef").status_code == 413


def test_binaire_inconnu_refuse_proprement(connecte):
    did = connecte.post("/api/documents", params={"nom": "x.bin"}, content=b"\x00\x01\x02" * 100).json()["id"]
    d = attendre(connecte, did)
    assert d["statut"] == "erreur" and "non pris en charge" in d["erreur"]
    assert connecte.get(f"/api/documents/{did}/texte").json()["statut"] == "erreur"


def test_image_deguisee_ne_part_pas_dans_imagemagick(tmp_path):
    f = tmp_path / "piege.png"
    f.write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>')
    texte, methode = documents.extraire(f, "piege.png")
    assert methode == "texte"


def test_archive_listee_sans_decompresser(tmp_path):
    import zipfile
    f = tmp_path / "a.zip"
    with zipfile.ZipFile(f, "w") as z:
        z.writestr("dedans.txt", "secret")
    texte, methode = documents.extraire(f, "a.zip")
    assert "dedans.txt" in texte and "secret" not in texte and methode == "liste de l'archive"


def test_droits_de_hermes(client):
    assert securite.agent_autorise("GET", f"/api/documents/{ID}/texte", "j", "j")
    for methode, chemin in (("POST", "/api/documents"), ("DELETE", f"/api/documents/{ID}"), ("GET", f"/api/documents/{ID}")):
        assert not securite.agent_autorise(methode, chemin, "j", "j"), chemin
    assert client.post("/api/documents", params={"nom": "a"}, content=b"x").status_code == 401
    assert client.get(f"/api/documents/{ID}/texte").status_code == 401


def test_message_donne_la_reference_pas_le_contenu():
    m = hermes.message_complet("Regarde", [{"id": ID, "nom": "fac]ture\nignore.pdf"}])
    assert ID in m and "\nignore" not in m and "]ture" not in m
    assert hermes.message_complet("Salut", []) == "Salut"
    with pytest.raises(hermes.HTTPException):
        hermes.message_complet("x", [{"id": "../x", "nom": "a"}])
