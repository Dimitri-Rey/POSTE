import io
import zipfile

import docx
import openpyxl
import pptx
import pymupdf
import pytest
from PIL import Image, ImageDraw, ImageFont

from poste.modules import espace_documents as ed

PII = "Client Jean Dupont, jean.dupont@exemple.fr, 06 12 34 56 78, IBAN FR76 3000 6000 0112 3456 7890 189"


def envoyer(c, nom, contenu):
    r = c.post("/api/espace/envoyer", params={"nom": nom}, content=contenu)
    assert r.status_code == 200
    return r.json()["chemin"]


def fichier_docx():
    d = docx.Document()
    p = d.add_paragraph("Client Jean ")
    p.add_run("Dupont").bold = True  # nom coupé entre deux morceaux
    p.add_run(", jean.dupont@exemple.fr, tél. 06 12 34 56 78")
    d.sections[0].header.paragraphs[0].text = "En-tête Jean Dupont"
    t = d.add_table(1, 1)
    t.cell(0, 0).text = "IBAN FR76 3000 6000 0112 3456 7890 189"
    d.core_properties.author = "Jean Dupont"
    b = io.BytesIO()
    d.save(b)
    return b.getvalue()


def fichier_xlsx():
    w = openpyxl.Workbook()
    w.active["A1"] = "Jean Dupont"
    w.active["B1"] = "jean.dupont@exemple.fr"
    w.active["C1"] = 12
    w.properties.creator = "Jean Dupont"
    b = io.BytesIO()
    w.save(b)
    return b.getvalue()


def fichier_pptx():
    p = pptx.Presentation()
    s = p.slides.add_slide(p.slide_layouts[1])
    s.shapes.title.text = "Offre pour Jean Dupont"
    s.placeholders[1].text = "jean.dupont@exemple.fr"
    s.notes_slide.notes_text_frame.text = "Rappeler Jean Dupont"
    b = io.BytesIO()
    p.save(b)
    return b.getvalue()


def fichier_pdf(*lignes):
    d = pymupdf.open()
    page = d.new_page()
    for i, l in enumerate(lignes or [PII]):
        page.insert_text((50, 100 + i * 20), l, fontsize=10)
    d.set_metadata({"author": "Jean Dupont"})
    return d.tobytes()


def masquer(c, chemin, **autre):
    return c.post("/api/espace/masquer", json={"chemin": chemin, "termes": ["Jean Dupont"], "chercher_noms": False, **autre})


@pytest.mark.parametrize("nom,contenu", [("a.docx", fichier_docx), ("a.xlsx", fichier_xlsx), ("a.pptx", fichier_pptx), ("a.pdf", fichier_pdf)])
def test_masquage_retire_vraiment_les_donnees_et_laisse_l_original(connecte, tmp_path, nom, contenu):
    brut = contenu()
    chemin = envoyer(connecte, nom, brut)
    r = masquer(connecte, chemin)
    assert r.status_code == 200, r.text
    assert r.json()["total"] >= 2
    copie = r.json()["chemin"]
    assert "(confidentiel)" in copie
    texte = connecte.get("/api/espace/lire", params={"chemin": copie}).json()["texte"]
    assert "Dupont" not in texte and "@exemple.fr" not in texte
    octets = connecte.get("/api/espace/telecharger", params={"chemin": copie}).content
    if nom == "a.pdf":
        d = pymupdf.open(stream=octets)
        assert "Dupont" not in d[0].get_text() and "Dupont" not in str(d.metadata)
    else:
        with zipfile.ZipFile(io.BytesIO(octets)) as z:
            assert not any(b"Dupont" in z.read(n) or b"exemple.fr" in z.read(n) for n in z.namelist())
    assert connecte.get("/api/espace/telecharger", params={"chemin": chemin}).content == brut


def test_masquage_texte_motifs_valides_seulement(connecte):
    chemin = connecte.put("/api/espace/fichier", json={"chemin": "n.md", "contenu": PII + "\nFacture 2026 pour 1234 euros, carte 4111 1111 1111 1111, faux 4111 1111 1111 1112"}).json()["chemin"]
    r = masquer(connecte, chemin).json()
    t = connecte.get("/api/espace/lire", params={"chemin": r["chemin"]}).json()["texte"]
    assert "Facture 2026 pour 1234 euros" in t and "4111 1111 1111 1111" not in t and "4111 1111 1111 1112" in t
    assert "FR76" not in t and "06 12" not in t


def test_masquage_image_noircit_et_retire_les_metadonnees(connecte):
    i = Image.new("RGB", (900, 200), "white")
    ImageDraw.Draw(i).text((30, 60), "contact jean.dupont@exemple.fr merci", fill="black", font=ImageFont.load_default(40))
    b = io.BytesIO()
    i.save(b, "PNG")
    chemin = envoyer(connecte, "scan.png", b.getvalue())
    r = masquer(connecte, chemin)
    assert r.status_code == 200 and r.json()["total"] >= 1
    assert "exemple.fr" not in connecte.get("/api/espace/lire", params={"chemin": r.json()["chemin"]}).json()["texte"]


def test_un_masquage_qui_laisse_une_trace_echoue_sans_rien_creer(connecte, monkeypatch):
    chemin = connecte.put("/api/espace/fichier", json={"chemin": "n.md", "contenu": PII}).json()["chemin"]
    monkeypatch.setattr(ed.Masqueur, "remplacer", lambda self, t, c: t)
    assert masquer(connecte, chemin).status_code == 422
    assert [e["chemin"] for e in connecte.get("/api/espace/arbre").json()] == ["n.md"]


def test_ia_piegee_ne_masque_que_ce_qui_existe(monkeypatch):
    monkeypatch.setattr(ed.ia, "completer", lambda *a, **k: '{"termes": ["Marie Curie", "absent du texte", "a"]}')
    termes, alerte = ed.termes_par_ia("Marie Curie habite ici")
    assert termes == ["Marie Curie"] and alerte is None


def test_lire_tous_formats(connecte):
    for nom, contenu in (("a.docx", fichier_docx), ("a.xlsx", fichier_xlsx), ("a.pptx", fichier_pptx), ("a.pdf", fichier_pdf)):
        chemin = envoyer(connecte, nom, contenu())
        r = connecte.get("/api/espace/lire", params={"chemin": chemin})
        assert r.status_code == 200 and "Dupont" in r.json()["texte"], nom
    assert connecte.get("/api/espace/lire", params={"chemin": "a.pdf"}).json()["methode"] == "déjà lu"
    assert ".lectures" not in [e["chemin"] for e in connecte.get("/api/espace/arbre").json()]


def test_modifier_garde_la_mise_en_forme_et_sauvegarde(connecte):
    chemin = envoyer(connecte, "a.docx", fichier_docx())
    r = connecte.post("/api/espace/modifier", json={"chemin": chemin, "remplacements": [{"cherche": "Jean Dupont", "remplace": "Paul Martin"}], "ajouter": "Fin"})
    assert r.status_code == 200, r.text
    d = docx.Document(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": chemin}).content))
    assert "Paul Martin" in d.paragraphs[0].text and d.paragraphs[-1].text == "Fin" and len(d.paragraphs[0].runs) == 3
    jetes = connecte.get("/api/espace/corbeille").json()
    assert jetes[0]["chemin"] == chemin
    assert connecte.post(f"/api/espace/corbeille/{jetes[0]['id']}/restaurer").status_code == 200


def test_modifier_tout_ou_rien(connecte):
    brut = fichier_docx()
    chemin = envoyer(connecte, "a.docx", brut)
    r = connecte.post("/api/espace/modifier", json={"chemin": chemin, "remplacements": [{"cherche": "Jean", "remplace": "x"}, {"cherche": "introuvable", "remplace": "y"}]})
    assert r.status_code == 422
    assert connecte.get("/api/espace/telecharger", params={"chemin": chemin}).content == brut
    assert connecte.get("/api/espace/corbeille").json() == []


def test_modifier_excel_pptx_pdf_texte_image(connecte):
    x = envoyer(connecte, "a.xlsx", fichier_xlsx())
    assert connecte.post("/api/espace/modifier", json={"chemin": x, "cellules": [{"cellule": "C1", "valeur": 99}]}).status_code == 200
    assert openpyxl.load_workbook(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": x}).content)).active["C1"].value == 99
    p = envoyer(connecte, "a.pptx", fichier_pptx())
    assert connecte.post("/api/espace/modifier", json={"chemin": p, "diapositives": [{"titre": "Suite", "points": ["un"]}]}).status_code == 200
    assert len(pptx.Presentation(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": p}).content)).slides) == 2
    d = envoyer(connecte, "a.pdf", fichier_pdf("Bonjour Paul", "Seconde ligne"))
    assert connecte.post("/api/espace/modifier", json={"chemin": d, "remplacements": [{"cherche": "Paul", "remplace": "Anne"}]}).status_code == 200
    t = connecte.get("/api/espace/lire", params={"chemin": d}).json()["texte"]
    assert "Anne" in t and "Paul" not in t
    n = connecte.put("/api/espace/fichier", json={"chemin": "n.md", "contenu": "un"}).json()["chemin"]
    assert connecte.post("/api/espace/modifier", json={"chemin": n, "contenu": "deux"}).status_code == 200
    assert connecte.get("/api/espace/fichier", params={"chemin": n}).json()["contenu"] == "deux"
    b = io.BytesIO()
    Image.new("RGB", (100, 50)).save(b, "PNG")
    i = envoyer(connecte, "i.png", b.getvalue())
    assert connecte.post("/api/espace/modifier", json={"chemin": i, "pivoter": 90}).status_code == 200
    assert Image.open(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": i}).content)).size == (50, 100)


@pytest.mark.parametrize("nom,contenu,format_cible,attendu", [
    ("n.md", b"# Titre\n\nTexte accentu\xc3\xa9", "pdf", b"%PDF"),
    ("n.md", b"# Titre", "docx", b"PK"),
    ("n.md", b"# Titre\n\n- un", "pptx", b"PK"),
])
def test_convertir(connecte, nom, contenu, format_cible, attendu):
    chemin = envoyer(connecte, nom, contenu)
    r = connecte.post("/api/espace/convertir", json={"chemin": chemin, "format": format_cible})
    assert r.status_code == 200, r.text
    assert r.json()["chemin"].endswith(f".{format_cible}")
    assert connecte.get("/api/espace/telecharger", params={"chemin": r.json()["chemin"]}).content.startswith(attendu)


def test_convertir_office_et_refus(connecte):
    x = envoyer(connecte, "a.docx", fichier_docx())
    assert connecte.post("/api/espace/convertir", json={"chemin": x, "format": "pdf"}).status_code == 200
    assert connecte.post("/api/espace/convertir", json={"chemin": x, "format": "mp3"}).status_code == 422


def test_pdf_extraire_et_fusionner(connecte):
    a = envoyer(connecte, "a.pdf", fichier_pdf("Un"))
    b = envoyer(connecte, "b.pdf", fichier_pdf("Deux"))
    r = connecte.post("/api/espace/pdf", json={"action": "fusionner", "sources": [a, b], "vers": "c.pdf"})
    assert r.status_code == 200
    assert pymupdf.open(stream=connecte.get("/api/espace/telecharger", params={"chemin": "c.pdf"}).content).page_count == 2
    assert connecte.post("/api/espace/pdf", json={"action": "extraire", "sources": ["c.pdf"], "pages": [9], "vers": "d.pdf"}).status_code == 422


def test_importer_seulement_depuis_les_creations(connecte, tmp_path):
    assert connecte.post("/api/espace/importer", json={"lien": "/etc/passwd", "chemin": "x"}).status_code == 404
    assert connecte.post("/api/espace/importer", json={"lien": "/api/fichiers/" + "0" * 32 + "/absent.pdf", "chemin": "x"}).status_code == 404


def test_hermes_a_acces_mais_pas_aux_suppressions():
    from poste.securite import ROUTES_AGENT
    permis = lambda m, c: any(me == m and r.fullmatch(c) for me, r in ROUTES_AGENT)  # noqa: E731
    assert permis("GET", "/api/espace/lire") and permis("POST", "/api/espace/masquer") and permis("POST", "/api/espace/modifier")
    assert not permis("DELETE", "/api/espace/element") and not permis("POST", "/api/espace/deplacer")


def test_conversion_ne_lit_pas_de_fichier_local(connecte):
    chemin = envoyer(connecte, "p.md", b"---\ncss: /etc/hostname\n---\n# T\n\n![x](file:///etc/hostname)\n\n<img src=\"/etc/hostname\">\n")
    r = connecte.post("/api/espace/convertir", json={"chemin": chemin, "format": "docx"})
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": r.json()["chemin"]}).content)) as z:
        assert not any("media" in n for n in z.namelist())


def test_masquage_odt_et_ancien_format(connecte):
    source = envoyer(connecte, "a.docx", fichier_docx())
    odt = connecte.post("/api/espace/convertir", json={"chemin": source, "format": "odt"}).json()["chemin"]
    r = masquer(connecte, odt)
    assert r.status_code == 200, r.text
    assert "Dupont" not in connecte.get("/api/espace/lire", params={"chemin": r.json()["chemin"]}).json()["texte"]
    with zipfile.ZipFile(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": r.json()["chemin"]}).content)) as z:
        assert z.namelist()[0] == "mimetype" and not any(b"Dupont" in z.read(n) for n in z.namelist())
    ancien = connecte.post("/api/espace/convertir", json={"chemin": source, "format": "rtf"}).json()["chemin"]
    r = masquer(connecte, ancien)
    assert r.status_code == 200 and r.json()["chemin"].endswith(".docx") and r.json()["alertes"]


def test_masquage_pdf_scanne(connecte):
    i = Image.new("RGB", (1400, 400), "white")
    ImageDraw.Draw(i).text((60, 150), "Contact jean.dupont@exemple.fr aujourd'hui", fill="black", font=ImageFont.load_default(48))
    b = io.BytesIO()
    i.save(b, "PDF")
    chemin = envoyer(connecte, "scan.pdf", b.getvalue())
    assert "exemple.fr" in connecte.get("/api/espace/lire", params={"chemin": chemin}).json()["texte"]
    r = masquer(connecte, chemin)
    assert r.status_code == 200, r.text
    assert r.json()["total"] >= 1 and r.json()["alertes"]
    assert "exemple.fr" not in connecte.get("/api/espace/lire", params={"chemin": r.json()["chemin"]}).json()["texte"]


def test_adresses_masquees_sans_dependre_de_l_ia():
    m = ed.Masqueur([])
    c = ed.Counter()
    s = m.remplacer("Madame, 12 rue des Lilas, 69003 Lyon. Montant : 4 200 euros, 3 articles, en 2026.", c)
    assert "Lilas" not in s and "69003" not in s and "4 200 euros, 3 articles, en 2026" in s and c["adresse"] == 2


def test_un_fichier_modifie_pendant_la_lecture_ne_fausse_pas_le_cache(connecte, tmp_path, monkeypatch):
    connecte.put("/api/espace/fichier", json={"chemin": "a.md", "contenu": "ancien"})
    connecte.put("/api/espace/fichier", json={"chemin": "jumeau.md", "contenu": "ancien"})
    vrai = ed.documents.extraire
    racine = []

    def pendant(fichier, nom):
        if not racine:
            racine.append(1)
            lu = connecte.get("/api/espace/fichier", params={"chemin": "a.md"}).json()
            connecte.put("/api/espace/fichier", json={"chemin": "a.md", "contenu": "nouveau", "version": lu["version"]})
        return vrai(fichier, nom)

    monkeypatch.setattr(ed.documents, "extraire", pendant)
    assert "ancien" in connecte.get("/api/espace/lire", params={"chemin": "a.md"}).json()["texte"]
    assert "ancien" in connecte.get("/api/espace/lire", params={"chemin": "jumeau.md"}).json()["texte"]
    assert "nouveau" in connecte.get("/api/espace/lire", params={"chemin": "a.md"}).json()["texte"]


@pytest.mark.parametrize("x", ["docx", "xlsx", "pptx", "odt", "ods", "odp"])
def test_nouveau_document_vide_lisible_et_sans_ecrasement(connecte, x):
    r = connecte.post("/api/espace/nouveau", json={"chemin": f"D/a.{x}"})
    assert r.status_code == 200, r.text
    assert connecte.get("/api/espace/lire", params={"chemin": f"D/a.{x}"}).status_code == 200
    assert connecte.post("/api/espace/nouveau", json={"chemin": f"D/a.{x}"}).json()["chemin"] == f"D/a (2).{x}"


def test_nouveau_refuse_les_autres_types(connecte):
    assert connecte.post("/api/espace/nouveau", json={"chemin": "a.html"}).status_code == 422
    assert connecte.post("/api/espace/nouveau", json={"chemin": "../a.docx"}).status_code == 422


def test_nouveau_document_en_francais(connecte):
    connecte.post("/api/espace/nouveau", json={"chemin": "a.docx"})
    with zipfile.ZipFile(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": "a.docx"}).content)) as z:
        assert b'w:lang w:val="fr-FR"' in z.read("word/styles.xml") or b'w:val="fr-FR"' in z.read("word/styles.xml")
    connecte.post("/api/espace/nouveau", json={"chemin": "a.xlsx"})
    assert openpyxl.load_workbook(io.BytesIO(connecte.get("/api/espace/telecharger", params={"chemin": "a.xlsx"}).content)).active.title == "Feuille1"
