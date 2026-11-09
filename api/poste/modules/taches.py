"""Tâches de Poste."""
from __future__ import annotations

import time
from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

SCHEMA = """
CREATE TABLE IF NOT EXISTS taches (
    id INTEGER PRIMARY KEY,
    titre TEXT NOT NULL,
    echeance TEXT,
    faite_le REAL,
    notes TEXT NOT NULL DEFAULT '',
    cree_le REAL NOT NULL,
    signalee INTEGER NOT NULL DEFAULT 0
);
"""


class Tache(BaseModel):
    titre: str = Field(min_length=1, max_length=300)
    echeance: str | None = None
    notes: str = Field(default="", max_length=5000)
    priorite: int = Field(default=0, ge=0, le=1)

    @field_validator("echeance")
    @classmethod
    def date_valide(cls, valeur: str | None) -> str | None:
        if valeur:
            date.fromisoformat(valeur)
        return valeur or None


class Etat(BaseModel):
    faite: bool | None = None
    priorite: int | None = Field(default=None, ge=0, le=1)


def creer_routeur(base) -> APIRouter:
    routeur = APIRouter(prefix="/api/taches", tags=["taches"])

    @routeur.get("")
    def lister(avec_faites: bool = False) -> list[dict]:
        clause = "" if avec_faites else "WHERE faite_le IS NULL"
        cnx = base()
        try:
            lignes = cnx.execute(
                f"SELECT * FROM taches {clause} ORDER BY faite_le IS NOT NULL, priorite DESC, echeance IS NULL, echeance, id DESC LIMIT 500"
            ).fetchall()
        finally:
            cnx.close()
        return [dict(l) for l in lignes]

    @routeur.post("", status_code=201)
    def creer(t: Tache) -> dict:
        cnx = base()
        try:
            with cnx:
                cur = cnx.execute("INSERT INTO taches (titre, echeance, notes, cree_le, priorite) VALUES (?,?,?,?,?)",
                                  (t.titre, t.echeance, t.notes, time.time(), t.priorite))
        finally:
            cnx.close()
        return {"id": cur.lastrowid}

    @routeur.patch("/{tid}")
    def changer_etat(tid: int, e: Etat) -> dict:
        cnx = base()
        try:
            with cnx:
                if e.faite is None and e.priorite is None:
                    raise HTTPException(422, "Rien à changer")
                if e.priorite is not None:
                    cur = cnx.execute("UPDATE taches SET priorite=? WHERE id=?", (e.priorite, tid))
                if e.faite is not None:
                    cur = cnx.execute("UPDATE taches SET faite_le=? WHERE id=?", (time.time() if e.faite else None, tid))
        finally:
            cnx.close()
        if not cur.rowcount:
            raise HTTPException(404, "Tâche introuvable")
        return {"ok": True}

    @routeur.delete("/{tid}")
    def supprimer(tid: int) -> dict:
        cnx = base()
        try:
            with cnx:
                cnx.execute("DELETE FROM taches WHERE id=?", (tid,))
        finally:
            cnx.close()
        return {"ok": True}

    return routeur
