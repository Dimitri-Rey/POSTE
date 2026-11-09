"""Création de fichiers : les mêmes outils qu'Open WebUI (Word, Excel, PowerPoint, schémas...), même code source.

Seul change le rangement : les fichiers vont dans le dossier de Poste. Aucun fichier créé ne s'exécute ni ne part ailleurs.
"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import inspect
import json
import logging
import mimetypes
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from .. import reglages

journal = logging.getLogger("poste.creations")

# Outils de création (format Open WebUI) et service de rendu PDF : facultatifs.
SOURCES = reglages.fichier("creations", "outils", "~/.config/poste/outils")
SERVICE_PDF = reglages.lire("creations", "service_pdf", "")
UTILISATEUR = {"id": "poste"}
HOTE_PRIVE = re.compile(r"\.(ts\.net|local|localhost|home|lan|internal|intranet)$", re.I)
INLINE = {"image/png", "image/jpeg"}
# Documents Office : l'aperçu est un PDF fait une fois par LibreOffice, gardé à côté du fichier.
BUREAU = {"doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp"}
APERCU = ".apercu.pdf"
PAGES_MAX = 60
LARGEUR_PAGE = 1400


def _charger(nom: str):
    spec = importlib.util.spec_from_file_location(f"poste_outil_{nom}", SOURCES / f"{nom}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def adresse_publique(url: str) -> bool:
    m = re.fullmatch(r"https://([a-z0-9.-]+\.[a-z]{2,})(?:[/?]\S*)?", url, re.I)
    return bool(m) and not HOTE_PRIVE.search(m[1])


def nom_propre(nom: str) -> str:
    return re.sub(r"[^\w.\- ]", "", Path(nom).name, flags=re.UNICODE).strip(" .").replace(" ", "-")[:150] or "fichier"


def creer_routeur(racine: Path) -> tuple[APIRouter, Callable]:
    routeur = APIRouter(tags=["creations"])
    outils: dict[str, object] = {}

    async def enregistrer(_utilisateur: str, nom: str, donnees: bytes, _type: str | None = None) -> str:
        fid = uuid.uuid4().hex
        nom = nom_propre(nom)
        dossier = racine / fid
        dossier.mkdir(parents=True, mode=0o700)
        from . import espace_documents  # Word et PowerPoint en français pour le correcteur de l'éditeur
        (dossier / nom).write_bytes(espace_documents.en_francais(nom, donnees))
        return f"/api/fichiers/{fid}/{nom}"

    async def aucune_image(_fichiers) -> dict:
        return {}

    def chemin_de(fid: str, nom: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{32}", fid) or nom != nom_propre(nom):
            raise HTTPException(404, "Fichier inconnu")
        chemin = racine / fid / nom
        if not chemin.is_file():
            raise HTTPException(404, "Fichier inconnu")
        return chemin

    async def exporter_en_pdf(lien_fichier: str = "", **_) -> str:
        m = re.search(r"/api/fichiers/([0-9a-f]{32})/([^\s)]+)", lien_fichier or "")
        if not m:
            return "Donne le lien /api/fichiers/… du document Word, Excel ou PowerPoint créé plus haut."
        try:
            chemin = chemin_de(m[1], m[2])
        except HTTPException:
            return "Document introuvable : vérifie le lien /api/fichiers/…"

        def appeler() -> dict:
            corps = json.dumps({"nom": chemin.name, "contenu": base64.b64encode(chemin.read_bytes()).decode()}).encode()
            requete = urllib.request.Request(SERVICE_PDF, corps, {"Content-Type": "application/json"})
            with urllib.request.urlopen(requete, timeout=200) as r:
                return json.loads(r.read())
        try:
            res = await asyncio.to_thread(appeler)
        except OSError as err:
            return f"Échec de la conversion en PDF : {type(err).__name__}"
        nom = f"{chemin.stem}.pdf"
        return f"Le PDF est prêt : [Télécharger {nom}]({await enregistrer('', nom, base64.b64decode(res['pdf']))}). Donne ce lien tel quel."

    def preparer() -> None:
        if outils:
            return
        for nom in ("bureautique", "utilitaires"):
            module = _charger(nom)
            module._enregistrer = enregistrer
            if hasattr(module, "_images_jointes"):
                module._images_jointes = aucune_image
            if hasattr(module, "telecharger_images"):
                telecharger = module.telecharger_images

                def filtre(contenu: str, dossier: str, _t=telecharger) -> dict:
                    # Un contenu dicté par un document ne doit pas viser les services internes de la machine.
                    public = re.sub(r"!\[[^\]]*\]\((\S+?)\)", lambda m: m[0] if adresse_publique(m[1]) else "", contenu)
                    return _t(public, dossier)
                module.telecharger_images = filtre
            instance = module.Tools()
            for cle, methode in inspect.getmembers(instance, inspect.iscoroutinefunction):
                if not cle.startswith("_"):
                    outils[cle] = methode
        outils["exporter_en_pdf"] = exporter_en_pdf

    @routeur.post("/api/creations/{outil}")
    def creer(outil: str, corps: dict) -> dict:
        try:
            preparer()
        except (OSError, ImportError) as err:
            journal.warning("Outils de création indisponibles : %s", err)
            raise HTTPException(503, "Outils de création indisponibles") from err
        methode = outils.get(outil)
        if not methode:
            raise HTTPException(404, "Outil inconnu")
        permis = {n for n in inspect.signature(methode).parameters if not n.startswith("__") and n != "_"}
        arguments = {k: v for k, v in corps.items() if k in permis or outil == "exporter_en_pdf"}
        if "__user__" in inspect.signature(methode).parameters:
            arguments["__user__"] = UTILISATEUR
        try:
            return {"resultat": asyncio.run(methode(**arguments))}
        except TypeError as err:
            return {"resultat": f"Paramètres incorrects : {err}"}
        except Exception as err:  # noqa: BLE001 - l'erreur revient au modèle pour qu'il corrige
            journal.exception("Création %s en erreur", outil)
            return {"resultat": f"Échec de la création : {type(err).__name__}"}

    def fichier(fid: str, nom: str) -> FileResponse:
        chemin = chemin_de(fid, nom)
        mime = mimetypes.guess_type(nom)[0] or "application/octet-stream"
        # Seules les images PNG/JPEG s'affichent ; tout le reste (HTML, SVG...) se télécharge sans s'exécuter ici.
        if mime not in INLINE and mime != "application/octet-stream":
            mime = mime if mime.startswith("application/vnd") or mime == "application/pdf" else "application/octet-stream"
        # Les PDF s'affichent aussi (lecteur léger de Hermes) : la visionneuse du navigateur n'exécute rien de la page.
        return FileResponse(chemin, media_type=mime, filename=nom,
                            content_disposition_type="inline" if mime in INLINE or mime == "application/pdf" else "attachment")

    verrous: dict[str, threading.Lock] = {}

    def pdf_de(fid: str, nom: str) -> Path:
        """Le PDF à montrer : le fichier lui-même, ou pour un document Office sa conversion (faite une fois, gardée à côté)."""
        chemin = chemin_de(fid, nom)
        extension = chemin.suffix.lower().lstrip(".")
        if extension == "pdf":
            return chemin
        if extension not in BUREAU:
            raise HTTPException(415, "Pas d'aperçu pour ce format")
        cache = chemin.parent / APERCU
        with verrous.setdefault(fid, threading.Lock()):
            if not cache.is_file() or cache.stat().st_mtime < chemin.stat().st_mtime:
                from . import espace_documents  # lourd (pandoc, LibreOffice) : chargé à la première demande
                with tempfile.TemporaryDirectory(prefix="poste-apercu-") as d:
                    copie = Path(d) / chemin.name
                    shutil.copyfile(chemin, copie)
                    shutil.move(espace_documents._soffice(copie, "pdf", Path(d)), cache)
        return cache

    @routeur.get("/api/fichiers/{fid}/{nom}/apercu")
    def apercu(fid: str, nom: str) -> FileResponse:
        """Aperçu PDF d'un document Word, Excel ou PowerPoint créé par Hermes (lecture seule, aucune macro)."""
        pdf = pdf_de(fid, nom)
        return FileResponse(pdf, media_type="application/pdf", filename=f"{Path(nom).stem}.pdf", content_disposition_type="inline")

    @routeur.get("/api/fichiers/{fid}/{nom}/pages")
    def pages(fid: str, nom: str) -> dict:
        pdf = pdf_de(fid, nom)
        r = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=30, check=False)
        m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
        if not m:
            raise HTTPException(422, "Aperçu impossible : le PDF est illisible")
        return {"pages": min(int(m[1]), PAGES_MAX), "total": int(m[1])}

    # Les pages en images : lisibles partout, y compris dans l'appli Android qui n'affiche pas de PDF dans une page.
    @routeur.get("/api/fichiers/{fid}/{nom}/page/{numero}")
    def page(fid: str, nom: str, numero: int) -> FileResponse:
        if not 1 <= numero <= PAGES_MAX:
            raise HTTPException(404, "Page inconnue")
        pdf = pdf_de(fid, nom)
        image = pdf.parent / f".page-{'o' if pdf.name == APERCU else 'p'}-{numero}.png"
        if not image.is_file() or image.stat().st_mtime < pdf.stat().st_mtime:
            with tempfile.TemporaryDirectory(prefix="poste-page-") as d:
                r = subprocess.run(["pdftoppm", "-png", "-singlefile", "-scale-to", str(LARGEUR_PAGE), "-f", str(numero), "-l", str(numero),
                                    str(pdf), str(Path(d) / "p")], capture_output=True, timeout=60, check=False)
                produit = Path(d) / "p.png"
                if r.returncode != 0 or not produit.is_file():
                    raise HTTPException(404, "Page inconnue")
                shutil.move(produit, image)
        return FileResponse(image, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})

    return routeur, fichier
