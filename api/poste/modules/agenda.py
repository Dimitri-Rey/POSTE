"""Agenda : rendez-vous de Poste (modifiables) et, en lecture seule, ceux des agendas branchés (iCal, CalDAV)."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from . import connecteurs

SCHEMA = """
CREATE TABLE IF NOT EXISTS evenements_agenda (
    id INTEGER PRIMARY KEY,
    titre TEXT NOT NULL,
    debut TEXT NOT NULL,
    fin TEXT,
    lieu TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    rappel_minutes INTEGER NOT NULL DEFAULT 15,
    rappele INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agenda_debut ON evenements_agenda (debut);
"""


class Evenement(BaseModel):
    titre: str = Field(min_length=1, max_length=300)
    debut: str
    fin: str | None = None
    lieu: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=5000)
    rappel_minutes: int = Field(default=15, ge=0, le=10080)

    @field_validator("debut", "fin")
    @classmethod
    def date_valide(cls, valeur: str | None) -> str | None:
        if valeur is not None:
            datetime.fromisoformat(valeur)
        return valeur


def creer_routeur(base) -> APIRouter:
    routeur = APIRouter(prefix="/api/agenda", tags=["agenda"])

    @routeur.get("")
    def lister(du: str | None = None, au: str | None = None) -> list[dict]:
        debut = du or datetime.now().strftime("%Y-%m-%dT00:00")
        cnx = base()
        try:
            lignes = cnx.execute(
                "SELECT * FROM evenements_agenda WHERE debut >= ? AND (? IS NULL OR debut <= ?)"
                " ORDER BY debut LIMIT 500", (debut, au, au)).fetchall()
            externes = connecteurs.evenements_entre(cnx, debut, au)
        finally:
            cnx.close()
        # Les événements d'une journée entière passent avant les heures du même jour.
        return sorted([dict(l) for l in lignes] + externes, key=lambda e: (e["debut"][:10], not e.get("journee"), e["debut"]))

    @routeur.post("", status_code=201)
    def creer(e: Evenement) -> dict:
        if e.fin and e.fin < e.debut:
            raise HTTPException(422, "La fin précède le début")
        cnx = base()
        try:
            with cnx:
                cur = cnx.execute(
                    "INSERT INTO evenements_agenda (titre, debut, fin, lieu, notes, rappel_minutes)"
                    " VALUES (?,?,?,?,?,?)", (e.titre, e.debut, e.fin, e.lieu, e.notes, e.rappel_minutes))
        finally:
            cnx.close()
        return {"id": cur.lastrowid}

    @routeur.put("/{eid}")
    def modifier(eid: int, e: Evenement) -> dict:
        cnx = base()
        try:
            with cnx:
                cur = cnx.execute(
                    "UPDATE evenements_agenda SET titre=?, debut=?, fin=?, lieu=?, notes=?, rappel_minutes=?,"
                    " rappele=0 WHERE id=?", (e.titre, e.debut, e.fin, e.lieu, e.notes, e.rappel_minutes, eid))
        finally:
            cnx.close()
        if not cur.rowcount:
            raise HTTPException(404, "Événement introuvable")
        return {"ok": True}

    @routeur.delete("/{eid}")
    def supprimer(eid: int) -> dict:
        cnx = base()
        try:
            with cnx:
                cnx.execute("DELETE FROM evenements_agenda WHERE id=?", (eid,))
        finally:
            cnx.close()
        return {"ok": True}

    return routeur
