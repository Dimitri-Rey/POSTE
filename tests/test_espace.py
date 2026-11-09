import json
import os

import pytest

from poste import reglages
from poste.modules import espace as module


@pytest.fixture
def racine(connecte, tmp_path):
    return tmp_path / "espace"


def ecrire(c, chemin, contenu="x", **autre):
    return c.put("/api/espace/fichier", json={"chemin": chemin, "contenu": contenu, **autre})


def test_creer_lire_modifier_avec_controle_de_version(connecte):
    r = ecrire(connecte, "Notes/idee.md", "# Titre")
    assert r.status_code == 200
    version = r.json()["version"]
    assert ecrire(connecte, "Notes/idee.md", "écrasé").status_code == 409
    lu = connecte.get("/api/espace/fichier", params={"chemin": "Notes/idee.md"}).json()
    assert lu["contenu"] == "# Titre" and lu["version"] == version
    r = ecrire(connecte, "Notes/idee.md", "deux", version=version)
    assert r.status_code == 200
    assert ecrire(connecte, "Notes/idee.md", "conflit", version=version).status_code == 409
    assert connecte.get("/api/espace/fichier", params={"chemin": "Notes/idee.md"}).json()["contenu"] == "deux"


@pytest.mark.parametrize("chemin", ["../sortie.md", "a/../../b", ".cache/x", "a/.corbeille/b", "a\\b", "a\x00b", "/" , "   "])
def test_chemins_dangereux_refuses(connecte, chemin):
    assert ecrire(connecte, chemin).status_code == 422


def test_lien_symbolique_ne_sort_pas(connecte, racine, tmp_path):
    (tmp_path / "secret").mkdir()
    (tmp_path / "secret/cle").write_text("cle")
    os.symlink(tmp_path / "secret", racine / "lien")
    assert connecte.get("/api/espace/fichier", params={"chemin": "lien/cle"}).status_code == 422


def test_envoi_nom_libre_et_telechargement_en_piece_jointe(connecte):
    assert connecte.post("/api/espace/envoyer", params={"nom": "../../a.html"}, content=b"<script>").json()["chemin"] == "a.html"
    assert connecte.post("/api/espace/envoyer", params={"nom": "a.html"}, content=b"2").json()["chemin"] == "a (2).html"
    r = connecte.get("/api/espace/telecharger", params={"chemin": "a.html"})
    assert r.status_code == 200 and r.headers["content-disposition"].startswith("attachment")
    assert r.headers["content-type"] == "application/octet-stream"
    connecte.post("/api/espace/envoyer", params={"nom": "b.bin"}, content=bytes(range(256)))
    assert connecte.get("/api/espace/fichier", params={"chemin": "b.bin"}).status_code == 415


def test_arbre_masque_la_corbeille_et_on_restaure(connecte):
    ecrire(connecte, "D/a.md", "A")
    assert connecte.delete("/api/espace/element", params={"chemin": "D/a.md"}).status_code == 200
    assert [e["chemin"] for e in connecte.get("/api/espace/arbre").json()] == ["D"]
    jete = connecte.get("/api/espace/corbeille").json()
    assert jete[0]["chemin"] == "D/a.md"
    assert connecte.post(f"/api/espace/corbeille/{jete[0]['id']}/restaurer").json()["chemin"] == "D/a.md"
    assert connecte.get("/api/espace/fichier", params={"chemin": "D/a.md"}).json()["contenu"] == "A"
    assert connecte.get("/api/espace/corbeille").json() == []
    assert connecte.post("/api/espace/corbeille/abc/restaurer").status_code == 422


def test_deplacer_n_ecrase_jamais(connecte):
    ecrire(connecte, "a.md", "A")
    ecrire(connecte, "b.md", "B")
    assert connecte.post("/api/espace/deplacer", json={"de": "a.md", "vers": "b.md"}).status_code == 409
    assert connecte.post("/api/espace/deplacer", json={"de": "a.md", "vers": "x/y/a.md"}).status_code == 200
    connecte.post("/api/espace/dossier", json={"chemin": "D"})
    assert connecte.post("/api/espace/deplacer", json={"de": "D", "vers": "D/E"}).status_code == 422


def test_rangement_tout_ou_rien(connecte):
    ecrire(connecte, "a.md", "A")
    ecrire(connecte, "b.md", "B")
    avant = [e["chemin"] for e in connecte.get("/api/espace/arbre").json()]
    r = connecte.post("/api/espace/appliquer", json={"operations": [
        {"action": "creer_dossier", "chemin": "N/M"}, {"action": "deplacer", "de": "a.md", "vers": "N/M/a.md"},
        {"action": "deplacer", "de": "absent.md", "vers": "N/absent.md"}]})
    assert r.status_code == 404
    assert [e["chemin"] for e in connecte.get("/api/espace/arbre").json()] == avant
    assert connecte.post("/api/espace/appliquer", json={"operations": [{"action": "supprimer", "chemin": "a.md"}]}).status_code == 422
    r = connecte.post("/api/espace/appliquer", json={"operations": [
        {"action": "creer_dossier", "chemin": "N"}, {"action": "deplacer", "de": "a.md", "vers": "N/a.md"}]})
    assert r.status_code == 200
    assert connecte.get("/api/espace/fichier", params={"chemin": "N/a.md"}).status_code == 200


def test_plan_de_l_ia_verifie(connecte, monkeypatch):
    ecrire(connecte, "a.md", "A")
    vu = {}
    def faux(systeme, texte, *a, **k):
        vu["texte"] = texte
        return plan
    monkeypatch.setattr(module.ia, "completer", faux)
    plan = json.dumps({"resume": "ok", "operations": [{"action": "creer_dossier", "chemin": "N/"}, {"action": "deplacer", "de": "a.md", "vers": "N/a.md"}]})
    r = connecte.post("/api/espace/ia/ranger", json={"demande": "range"})
    assert r.json()["operations"][0] == {"action": "creer_dossier", "chemin": "N"}
    assert "a.md : A" in vu["texte"]
    # Une proposition ne change rien tant qu'elle n'est pas appliquée.
    assert connecte.get("/api/espace/fichier", params={"chemin": "a.md"}).status_code == 200
    for plan in (json.dumps({"operations": [{"action": "supprimer", "chemin": "a.md"}]}), json.dumps({"operations": [{"action": "deplacer", "de": "a.md", "vers": "../x"}]})):
        assert connecte.post("/api/espace/ia/ranger", json={"demande": "range"}).status_code in (422, 502)
    plan = "pas du json"
    assert connecte.post("/api/espace/ia/ranger", json={"demande": "range"}).status_code == 502


def test_correction_et_suite_ne_touchent_a_aucun_fichier(connecte, monkeypatch):
    appels = []
    def faux(systeme, texte, *a, **k):
        appels.append(systeme)
        return "résultat"
    monkeypatch.setattr(module.ia, "completer", faux)
    assert connecte.post("/api/espace/ia/retoucher", json={"texte": "bonjoure"}).json() == {"texte": "résultat"}
    assert connecte.post("/api/espace/ia/retoucher", json={"texte": "x", "demande": "plus court"}).json() == {"texte": "résultat"}
    assert connecte.post("/api/espace/ia/suite", json={"avant": "Bonjour Paul, je"}).json() == {"suite": "résultat"}
    assert appels == [reglages.personnaliser(c) for c in (module.CONSIGNE_CORRECTION, module.CONSIGNE_REECRITURE, module.CONSIGNE_SUITE)]
    assert connecte.get("/api/espace/arbre").json() == []


def test_jeton_agent_limite_dans_l_espace(connecte, tmp_path):
    h = {"x-poste-agent": (tmp_path / "agent").read_text()}
    assert connecte.get("/api/espace/arbre", headers=h).status_code == 200
    assert connecte.put("/api/espace/fichier", headers=h, json={"chemin": "h.md", "contenu": "x"}).status_code == 200
    assert connecte.post("/api/espace/appliquer", headers=h, json={"operations": [{"action": "creer_dossier", "chemin": "H"}]}).status_code == 200
    connecte.cookies.clear()
    assert connecte.delete("/api/espace/element", params={"chemin": "h.md"}, headers=h).status_code == 401
    assert connecte.get("/api/espace/telecharger", params={"chemin": "h.md"}, headers=h).status_code == 401
    assert connecte.post("/api/espace/deplacer", headers=h, json={"de": "h.md", "vers": "i.md"}).status_code == 401


def test_copier_ne_touche_pas_a_loriginal_et_trouve_un_nom_libre(connecte):
    ecrire(connecte, "a.md", "un")
    connecte.post("/api/espace/dossier", json={"chemin": "D"})
    assert connecte.post("/api/espace/copier", json={"de": "a.md", "dossier": "D"}).json()["chemin"] == "D/a.md"
    deuxieme = connecte.post("/api/espace/copier", json={"de": "a.md", "dossier": "D"}).json()["chemin"]
    assert deuxieme != "D/a.md" and deuxieme.startswith("D/")
    assert connecte.get("/api/espace/fichier", params={"chemin": "a.md"}).json()["contenu"] == "un"
    assert connecte.get("/api/espace/fichier", params={"chemin": deuxieme}).json()["contenu"] == "un"


def test_copier_refuse_un_dossier_dans_lui_meme_et_une_sortie(connecte):
    ecrire(connecte, "D/a.md")
    assert connecte.post("/api/espace/copier", json={"de": "D", "dossier": "D"}).status_code == 422
    assert connecte.post("/api/espace/copier", json={"de": "D/a.md", "dossier": "../.."}).status_code == 422


def test_apercu_seulement_pour_les_images_passives(connecte):
    for nom in ("x.svg", "x.html"):
        ecrire(connecte, nom, "<script>alert(1)</script>")
        assert connecte.get("/api/espace/apercu", params={"chemin": nom}).status_code == 415
    connecte.post("/api/espace/envoyer", params={"nom": "p.png"}, content=b"\x89PNG")
    r = connecte.get("/api/espace/apercu", params={"chemin": "p.png"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert "attachment" not in r.headers.get("content-disposition", "")


def test_les_favoris_suivent_les_deplacements_et_disparaissent_avec_le_fichier(connecte):
    ecrire(connecte, "D/a.md")
    assert connecte.put("/api/espace/favoris", json={"chemin": "D/a.md", "favori": True}).json() == ["D/a.md"]
    connecte.post("/api/espace/deplacer", json={"de": "D", "vers": "E"})
    assert connecte.get("/api/espace/favoris").json() == ["E/a.md"]
    connecte.post("/api/espace/appliquer", json={"operations": [{"action": "deplacer", "de": "E/a.md", "vers": "b.md"}]})
    assert connecte.get("/api/espace/favoris").json() == ["b.md"]
    connecte.delete("/api/espace/element", params={"chemin": "b.md"})
    assert connecte.get("/api/espace/favoris").json() == []
    assert ".favoris.json" not in [e["chemin"] for e in connecte.get("/api/espace/arbre").json()]
    assert connecte.put("/api/espace/favoris", json={"chemin": "../x", "favori": True}).status_code == 422


def test_telecharger_garde_le_type_reel_et_reste_une_piece_jointe(connecte):
    ecrire(connecte, "Rangé.md", "# x")
    ecrire(connecte, "a.html", "<script></script>")
    r = connecte.get("/api/espace/telecharger/Rang%C3%A9.md", params={"chemin": "Rangé.md"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/markdown")
    assert r.headers["content-disposition"].startswith("attachment")
    r = connecte.get("/api/espace/telecharger/a.html", params={"chemin": "a.html"})
    assert r.headers["content-disposition"].startswith("attachment") and r.headers["content-type"] == "application/octet-stream"


def test_archiver_la_selection_dans_le_dossier_courant(connecte, tmp_path):
    import zipfile
    ecrire(connecte, "Projet/a.md", "un")
    ecrire(connecte, "Projet/Sous/b.md", "deux")
    ecrire(connecte, "Projet/.cache/c.md", "caché")
    ecrire(connecte, "seul.txt", "trois")
    (tmp_path / "espace" / "Projet" / "lien").symlink_to("/etc/passwd")
    r = connecte.post("/api/espace/archiver", json={"chemins": ["Projet", "seul.txt"], "nom": "lot", "dossier": "Projet"})
    assert r.status_code == 200 and r.json()["chemin"] == "Projet/lot.zip"
    noms = set(zipfile.ZipFile(tmp_path / "espace" / "Projet" / "lot.zip").namelist())
    assert {"Projet/a.md", "Projet/Sous/b.md", "seul.txt"} <= noms
    assert not any("cache" in n or "lien" in n or n.endswith("lot.zip") or "partiel" in n for n in noms)
    deuxieme = connecte.post("/api/espace/archiver", json={"chemins": ["seul.txt"], "nom": "lot.zip", "dossier": "Projet", "compresser": False})
    assert deuxieme.json()["chemin"] == "Projet/lot (2).zip"
    assert connecte.post("/api/espace/archiver", json={"chemins": ["../x"], "nom": "a"}).status_code == 422

