"""Édition bureautique dans le navigateur : Collabora ouvre un fichier de l'espace avec un jeton limité à ce fichier.

Ces routes n'ont pas de session : Collabora les appelle lui-même. Le jeton est aléatoire, gardé en mémoire et expire ;
il ne donne accès qu'au seul fichier pour lequel il a été créé. Tout redémarrage de Poste les annule.
"""
from __future__ import annotations

import datetime as dt
import hmac
import re
import secrets
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import espace as module_espace
from .. import reglages

DUREE = 10 * 3600
EXTENSIONS = {"docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"}
# Réglages d'interface de Collabora (ui_defaults) : thème sombre partout.
INTERFACE = urllib.parse.quote("UITheme=dark", safe="")


@dataclass
class Jeton:
    chemin: str
    expire: float
    sauvegarde: bool = False


class Ouverture(BaseModel):
    chemin: str = Field(min_length=1, max_length=1000)


def _date(cible: Path) -> str:
    return dt.datetime.fromtimestamp(cible.stat().st_mtime, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def creer_routeurs(racine: Path, interne: str, wopi: str, origine_poste: str) -> tuple[APIRouter, APIRouter]:
    prive = APIRouter(prefix="/api/espace/bureau", tags=["bureau"])
    public = APIRouter(prefix="/wopi/files", tags=["wopi"])
    espace = module_espace.Espace(racine)
    jetons: dict[str, Jeton] = {}

    def adresse_edition(extension: str) -> str:
        try:
            xml = httpx.get(f"{interne}/hosting/discovery", timeout=10).text
        except httpx.HTTPError as err:
            raise HTTPException(503, "L'éditeur bureautique ne répond pas : télécharge le fichier pour l'instant") from err
        for action in re.findall(r"<action\b[^>]*>", xml):
            if f'ext="{extension}"' in action and 'name="edit"' in action:
                return re.search(r'urlsrc="([^"]+)"', action)[1]
        raise HTTPException(415, "Ce format ne s'édite pas dans le navigateur")

    def fichier_du(fid: str, access_token: str) -> tuple[Path, Jeton]:
        jeton = jetons.get(fid)
        if not jeton or not hmac.compare_digest(fid, access_token) or jeton.expire < time.time():
            raise HTTPException(401, "Jeton invalide")
        cible = espace.existant(jeton.chemin)
        if cible.is_dir():
            raise HTTPException(404, "Introuvable")
        return cible, jeton

    @prive.post("/session")
    def ouvrir(corps: Ouverture) -> dict:
        cible = espace.existant(corps.chemin)
        extension = cible.suffix.lower().lstrip(".")
        if cible.is_dir() or extension not in EXTENSIONS:
            raise HTTPException(415, "Ce format ne s'édite pas dans le navigateur")
        adresse = adresse_edition(extension)
        for ancien in [k for k, j in jetons.items() if j.expire < time.time()]:
            del jetons[ancien]
        fid = secrets.token_urlsafe(32)
        expire = time.time() + DUREE
        jetons[fid] = Jeton(espace.relatif(cible), expire)
        source = urllib.parse.quote(f"{wopi}/wopi/files/{fid}", safe="")
        # Interface en français et thème sombre, quels que soient la langue du navigateur et le format ouvert.
        return {"url": f"{adresse}WOPISrc={source}&lang=fr-FR&ui_defaults={INTERFACE}", "jeton": fid, "expire_ms": int(expire * 1000)}

    @public.get("/{fid}")
    def informations(fid: str, access_token: str = Query()) -> dict:
        cible, _ = fichier_du(fid, access_token)
        return {
            "BaseFileName": cible.name, "Size": cible.stat().st_size, "OwnerId": "poste", "UserId": "poste",
            "UserFriendlyName": reglages.prenom() or "Moi", "Version": module_espace.empreinte(cible.read_bytes()), "LastModifiedTime": _date(cible),
            "UserCanWrite": True, "UserCanNotWriteRelative": True, "PostMessageOrigin": origine_poste, "EnableInsertRemoteImage": False,
        }

    @public.get("/{fid}/contents")
    def contenu(fid: str, access_token: str = Query()) -> FileResponse:
        cible, _ = fichier_du(fid, access_token)
        return FileResponse(cible, media_type="application/octet-stream")

    @public.post("/{fid}/contents")
    async def enregistrer(fid: str, request: Request, access_token: str = Query()):
        cible, jeton = fichier_du(fid, access_token)
        attendu = request.headers.get("x-cool-wopi-timestamp")
        # Le fichier a changé ailleurs (Hermes, un autre appareil) : Collabora demande alors quoi faire.
        if attendu and attendu != _date(cible):
            return JSONResponse({"COOLStatusCode": 1010}, 409)
        corps = bytearray()
        async for morceau in request.stream():
            corps += morceau
            if len(corps) > module_espace.TAILLE_MAX:
                raise HTTPException(413, "Fichier trop gros : 100 Mo au plus")
        if not corps:
            raise HTTPException(422, "Contenu vide refusé")
        # Une ouverture = une version d'avant à la corbeille, pas une par enregistrement automatique.
        if not jeton.sauvegarde and bytes(corps) != cible.read_bytes():
            espace._sauvegarder(cible)
            jeton.sauvegarde = True
        module_espace.ecrire_atomique(cible, bytes(corps))
        return {"LastModifiedTime": _date(cible)}

    return prive, public
