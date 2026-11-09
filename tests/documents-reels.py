"""Extraction sur de vrais fichiers, avec les vrais outils : python tests/documents-reels.py <dossier>"""
import sys, time
from pathlib import Path
sys.path.insert(0, "api")
from poste.modules import documents
for f in sorted(Path(sys.argv[1]).iterdir()):
    debut = time.time()
    try:
        texte, methode = documents.extraire(f, f.name)
        print(f"{f.name:14} {time.time()-debut:5.1f}s {methode:18} {' '.join(texte.split())[:88]}")
    except documents.Illisible as err:
        print(f"{f.name:14} {time.time()-debut:5.1f}s ILLISIBLE {err}")
