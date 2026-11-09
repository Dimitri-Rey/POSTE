"""Sites intégrés : des applications web (CRM, wiki, supervision…) ajoutées au menu et ouvertes dans Poste.

Chaque site s'affiche dans un cadre. Son origine est ajoutée à la politique de sécurité (frame-src) au fil des
ajouts et des retraits. Un site qui refuse d'être encadré (X-Frame-Options, frame-ancestors) reste blanc :
l'interface propose alors de l'ouvrir dans un onglet.
"""
from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY,
    nom TEXT NOT NULL,
    adresse TEXT NOT NULL,
    cree_le REAL NOT NULL
);
"""
MAXIMUM = 20

_origines: tuple[str, ...] = ()


class Site(BaseModel):
    nom: str = Field(min_length=1, max_length=40)
    adresse: str = Field(min_length=1, max_length=2000)


def origine(adresse: str) -> str:
    """https://crm.exemple.fr pour https://crm.exemple.fr/tableau?x=1 ; refuse tout ce qui n'est pas http(s)."""
    morceaux = urlsplit(adresse.strip())
    if morceaux.scheme not in ("http", "https") or not morceaux.hostname or morceaux.username or morceaux.password:
        raise ValueError("Adresse attendue : http:// ou https:// suivi du nom du site, sans identifiant.")
    if any(c in adresse for c in " ;,'\"\n\r\t"):
        raise ValueError("Caractère interdit dans l'adresse.")
    port = f":{morceaux.port}" if morceaux.port else ""
    return f"{morceaux.scheme}://{morceaux.hostname.lower()}{port}"


def origines() -> tuple[str, ...]:
    """Origines à permettre dans frame-src, lues sans toucher à la base (appelé à chaque réponse)."""
    return _origines


def _recharger(cnx: sqlite3.Connection) -> None:
    global _origines
    _origines = tuple(sorted({origine(l["adresse"]) for l in cnx.execute("SELECT adresse FROM sites")}))


def creer_routeur(connecter: Callable[[], sqlite3.Connection], origines_poste: tuple[str, ...]) -> APIRouter:
    routeur = APIRouter(prefix="/api/sites", tags=["sites"])
    cnx = connecter()
    try:
        _recharger(cnx)
    finally:
        cnx.close()

    @routeur.get("")
    def lister() -> list[dict]:
        cnx = connecter()
        try:
            return [dict(l) for l in cnx.execute("SELECT id, nom, adresse FROM sites ORDER BY id")]
        finally:
            cnx.close()

    @routeur.post("", status_code=201)
    def ajouter(site: Site) -> dict:
        try:
            o = origine(site.adresse)
        except ValueError as e:
            raise HTTPException(422, str(e)) from e
        # Même origine que Poste : le cadre aurait la main sur Poste lui-même.
        if o in origines_poste:
            raise HTTPException(422, "Cette adresse est celle de Poste.")
        cnx = connecter()
        try:
            if cnx.execute("SELECT COUNT(*) FROM sites").fetchone()[0] >= MAXIMUM:
                raise HTTPException(422, f"{MAXIMUM} sites au plus.")
            ident = cnx.execute("INSERT INTO sites (nom, adresse, cree_le) VALUES (?, ?, ?)",
                                (site.nom.strip(), site.adresse.strip(), time.time())).lastrowid
            cnx.commit()
            _recharger(cnx)
        finally:
            cnx.close()
        return {"id": ident, "nom": site.nom.strip(), "adresse": site.adresse.strip()}

    @routeur.delete("/{ident}", status_code=204)
    def retirer(ident: int) -> None:
        cnx = connecter()
        try:
            if not cnx.execute("DELETE FROM sites WHERE id=?", (ident,)).rowcount:
                raise HTTPException(404, "Site inconnu")
            cnx.commit()
            _recharger(cnx)
        finally:
            cnx.close()

    return routeur
