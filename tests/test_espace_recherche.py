import os

import docx

from poste.modules import espace as module_espace
from poste.modules import espace_recherche


def ecrire(c, chemin, contenu):
    assert c.put("/api/espace/fichier", json={"chemin": chemin, "contenu": contenu}).status_code == 200


def chercher(c, texte):
    r = c.get("/api/espace/recherche", params={"texte": texte})
    assert r.status_code == 200
    return r.json()


def test_trouve_le_contenu_avec_extrait_surligne_et_sans_accents(connecte):
    ecrire(connecte, "Notes/reunion.md", "Compte rendu : le budget de l'été est validé par le client.")
    ecrire(connecte, "autre.txt", "Rien à voir ici.")
    r = chercher(connecte, "ete budg")
    assert [x["chemin"] for x in r] == ["Notes/reunion.md"]
    assert "\x02budget\x03" in r[0]["extrait"] and "\x02été\x03" in r[0]["extrait"]


def test_suit_les_modifications_et_les_suppressions(connecte, tmp_path):
    ecrire(connecte, "a.md", "ancien mot")
    assert chercher(connecte, "ancien")
    racine = tmp_path / "espace"
    (racine / "a.md").write_text("nouveau contenu")
    os.utime(racine / "a.md", (1, 1))
    assert not chercher(connecte, "ancien") and chercher(connecte, "nouveau")
    assert connecte.delete("/api/espace/element", params={"chemin": "a.md"}).status_code == 200
    assert not chercher(connecte, "nouveau")


def test_la_saisie_ne_passe_jamais_comme_syntaxe_fts(connecte):
    ecrire(connecte, "a.md", "texte ordinaire")
    for piege in ['"', "NEAR(", "a OR", "*", "texte)", "-texte", "chemin:a"]:
        assert isinstance(chercher(connecte, piege), list)
    assert chercher(connecte, "texte)")


def test_documents_bureau_indexes_par_la_tache_de_fond_seulement(tmp_path):
    racine = tmp_path / "espace"
    espace = module_espace.Espace(racine)
    d = docx.Document()
    d.add_paragraph("Proposition commerciale pour Durandal")
    d.save(racine / "offre.docx")
    index = espace_recherche.Index(espace, tmp_path / "index.db")
    assert index.chercher("durandal") == []  # recherche : textes simples seulement, rien de lent
    assert index.mettre_a_jour() == 1
    assert [x["chemin"] for x in index.chercher("durandal")] == ["offre.docx"]
    assert index.mettre_a_jour() == 0  # rien n'a changé : rien n'est relu
    assert index.etat() == {"fichiers": 1, "avec_texte": 1}


def test_index_hors_de_l_espace(connecte, tmp_path):
    ecrire(connecte, "a.md", "x")
    chercher(connecte, "x")
    assert not any(".db" in e["chemin"] for e in connecte.get("/api/espace/arbre").json())
    assert (tmp_path / "espace-index.db").exists()
