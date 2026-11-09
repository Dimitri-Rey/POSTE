"""Création de fichiers : vrais outils d'Open WebUI, rangés dans Poste, et fermés à tout le reste."""
import io
import os
import re
from pathlib import Path

import pytest

from poste import securite
from poste.modules import creations

# Ces tests utilisent les vrais outils de création (format Open WebUI) : indiqués par POSTE_OUTILS_TEST, sinon ignorés.
OUTILS = Path(os.environ.get("POSTE_OUTILS_TEST", "/inexistant")).expanduser()
avec_outils = pytest.mark.skipif(not (OUTILS / "bureautique.py").exists(), reason="outils de création absents (POSTE_OUTILS_TEST)")


@pytest.fixture(autouse=True)
def outils_reels(monkeypatch):
    monkeypatch.setattr(creations, "SOURCES", OUTILS)


def lien_de(texte):
    return re.search(r"/api/fichiers/[0-9a-f]{32}/[^)\s]+", texte)[0]


@avec_outils
def test_word_excel_powerpoint_reels(connecte):
    from docx import Document
    from openpyxl import load_workbook
    from pptx import Presentation
    r = connecte.post("/api/creations/creer_document_word", json={"titre": "Rapport d'essai", "contenu_markdown": "# Partie\n\nBonjour **Hermes**.\n\n| a | b |\n|---|---|\n| 1 | 2 |"}).json()["resultat"]
    f = connecte.get(lien_de(r))
    assert f.status_code == 200 and "attachment" in f.headers["content-disposition"]
    assert any("Bonjour" in p.text for p in Document(io.BytesIO(f.content)).paragraphs)
    r = connecte.post("/api/creations/creer_classeur_excel", json={"titre": "Budget", "feuilles_json": '[{"nom":"B","colonnes":["P","V"],"lignes":[["Loyer",800]],"total":true}]'}).json()["resultat"]
    assert load_workbook(io.BytesIO(connecte.get(lien_de(r)).content))["B"]["B2"].value == 800
    r = connecte.post("/api/creations/creer_presentation_powerpoint", json={"titre": "Présentation", "diapos_json": '[{"titre":"Un","points":["a"]}]'}).json()["resultat"]
    assert len(Presentation(io.BytesIO(connecte.get(lien_de(r)).content)).slides) == 2


@avec_outils
def test_fichier_texte_verifie_avant_creation(connecte):
    r = connecte.post("/api/creations/creer_fichier_texte", json={"nom_fichier": "a.py", "contenu": "def ("}).json()["resultat"]
    assert "NON créé" in r
    r = connecte.post("/api/creations/creer_fichier_texte", json={"nom_fichier": "../../a.py", "contenu": "print(1)\n"}).json()["resultat"]
    assert "/a.py" in lien_de(r) and ".." not in lien_de(r)


@avec_outils
def test_html_cree_jamais_affiche_sur_le_site(connecte):
    r = connecte.post("/api/creations/creer_fichier_texte", json={"nom_fichier": "p.html", "contenu": "<script>alert(1)</script>"}).json()["resultat"]
    f = connecte.get(lien_de(r))
    assert "attachment" in f.headers["content-disposition"] and "html" not in f.headers["content-type"]


@avec_outils
def test_calcul_et_outil_inconnu(connecte):
    assert "120" in connecte.post("/api/creations/calcul_tva", json={"montant": 100}).json()["resultat"]
    assert connecte.post("/api/creations/inexistant", json={}).status_code == 404
    assert connecte.post("/api/creations/_statut", json={}).status_code == 404


def test_images_seulement_publiques():
    assert creations.adresse_publique("https://exemple.fr/a.png")
    for url in ("http://exemple.fr/a.png", "https://127.0.0.1/a.png", "https://poste.exemple.ts.net:8540/x", "https://serveur.home/a", "file:///etc/passwd"):
        assert not creations.adresse_publique(url), url


def test_droits(client):
    assert securite.agent_autorise("POST", "/api/creations/creer_document_word", "j", "j")
    assert not securite.agent_autorise("GET", "/api/fichiers/" + "a" * 32 + "/x.docx", "j", "j")
    assert client.post("/api/creations/calcul_tva", json={"montant": 1}).status_code == 401
    assert client.get("/api/fichiers/" + "a" * 32 + "/x.docx").status_code == 401


def test_chemin_de_fichier_controle(connecte):
    assert connecte.get("/api/fichiers/" + "a" * 32 + "/absent.docx").status_code == 404
    assert connecte.get("/api/fichiers/pasunid/x").status_code == 404


def test_apercu_pdf_d_un_document_office(connecte, tmp_path):
    """Un Word créé par Hermes s'ouvre en aperçu : PDF fait une fois par LibreOffice, gardé à côté, servi en ligne."""
    import shutil
    import subprocess
    if not shutil.which("soffice") or not shutil.which("pandoc"):
        pytest.skip("LibreOffice ou pandoc absent")
    fid = "a" * 32
    dossier = tmp_path / "fichiers" / fid
    dossier.mkdir(parents=True)
    (tmp_path / "r.md").write_text("# Rapport\n\nBonjour le monde.", encoding="utf-8")
    subprocess.run(["pandoc", str(tmp_path / "r.md"), "-o", str(dossier / "rapport.docx")], check=True)
    r = connecte.get(f"/api/fichiers/{fid}/rapport.docx/apercu")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf" and r.headers["content-disposition"].startswith("inline")
    assert r.content.startswith(b"%PDF")
    assert (dossier / ".apercu.pdf").is_file()
    assert connecte.get(f"/api/fichiers/{fid}/rapport.docx/apercu").content == r.content  # depuis le cache
    assert connecte.get(f"/api/fichiers/{fid}/rapport.docx/pages").json() == {"pages": 1, "total": 1}
    p = connecte.get(f"/api/fichiers/{fid}/rapport.docx/page/1")
    assert p.status_code == 200 and p.headers["content-type"] == "image/png" and p.content.startswith(b"\x89PNG")
    assert connecte.get(f"/api/fichiers/{fid}/rapport.docx/page/2").status_code == 404
    assert connecte.get(f"/api/fichiers/{fid}/rapport.docx/page/0").status_code == 404
    # Ni un autre format, ni le cache lui-même, ni une adresse fabriquée.
    (dossier / "page.html").write_text("<script>alert(1)</script>")
    assert connecte.get(f"/api/fichiers/{fid}/page.html/apercu").status_code == 415
    assert connecte.get(f"/api/fichiers/{fid}/.apercu.pdf").status_code == 404
    assert connecte.get(f"/api/fichiers/{'b' * 32}/rapport.docx/apercu").status_code == 404
    assert connecte.get(f"/api/fichiers/{fid}/..%2Frapport.docx/apercu").status_code == 404


def test_apercu_demande_une_session(client):
    assert client.get(f"/api/fichiers/{'a' * 32}/rapport.docx/apercu").status_code == 401


def zipfile_lire(donnees):
    import zipfile
    return zipfile.ZipFile(io.BytesIO(donnees)).read("word/styles.xml")


def test_word_et_powerpoint_marques_en_francais():
    """Les modèles de python-docx et python-pptx sont en anglais : l'éditeur soulignerait tout le texte français."""
    import docx
    import pptx
    from docx.oxml.ns import qn
    from poste.modules import espace_documents as ed
    d = docx.Document()
    d.add_paragraph("Bonjour le monde")
    tampon = io.BytesIO()
    d.save(tampon)
    assert b'w:val="en-US"' in zipfile_lire(tampon.getvalue())
    sortie = ed.en_francais("rapport.docx", tampon.getvalue())
    relu = docx.Document(io.BytesIO(sortie))
    langues = {e.get(qn("w:val")) for e in relu.styles.element.iter(qn("w:lang"))}
    assert langues == {"fr-FR"}
    defaut = relu.styles.element.find(qn("w:docDefaults")).find(qn("w:rPrDefault")).find(qn("w:rPr")).find(qn("w:lang"))
    assert defaut.get(qn("w:val")) == "fr-FR"
    assert relu.paragraphs[-1].text == "Bonjour le monde"
    p = pptx.Presentation()
    diapo = p.slides.add_slide(p.slide_layouts[0])
    diapo.shapes.title.text = "Bonjour"
    tampon = io.BytesIO()
    p.save(tampon)
    sortie = ed.en_francais("expose.pptx", tampon.getvalue())
    import zipfile
    tout = b"".join(zipfile.ZipFile(io.BytesIO(sortie)).read(n) for n in zipfile.ZipFile(io.BytesIO(sortie)).namelist() if n.endswith(".xml"))
    assert b'lang="en-US"' not in tout and b'lang="fr-FR"' in tout
    assert pptx.Presentation(io.BytesIO(sortie)).slides[0].shapes.title.text == "Bonjour"
    # Le reste passe tel quel, même un faux Word.
    assert ed.en_francais("a.xlsx", b"abc") == b"abc"
    assert ed.en_francais("faux.docx", b"pas un zip") == b"pas un zip"


def test_powerpoint_vide_en_francais(tmp_path):
    import zipfile
    from poste.modules import espace_documents as ed
    ed.document_vide("pptx", tmp_path / "v.pptx")
    z = zipfile.ZipFile(tmp_path / "v.pptx")
    tout = b"".join(z.read(n) for n in z.namelist() if n.endswith(".xml"))
    assert b'lang="en-US"' not in tout
