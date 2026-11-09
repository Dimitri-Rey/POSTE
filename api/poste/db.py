"""Base SQLite unique : une connexion par requête, journal WAL."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
    jeton_hash TEXT PRIMARY KEY,
    cree_le REAL NOT NULL,
    expire_le REAL NOT NULL
);
-- Journal unifié : chaque module y écrit ; l'accueil le lit. « cle » évite les doublons
-- lorsqu'un module republie le même fait (même mail, même alerte).
CREATE TABLE IF NOT EXISTS evenements (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    source TEXT NOT NULL,
    titre TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    lien TEXT NOT NULL DEFAULT '',
    cle TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS evenements_ts ON evenements (ts DESC);
"""


def connecter(chemin: Path) -> sqlite3.Connection:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    # Une connexion par requête, mais FastAPI peut changer de fil entre ses dépendances.
    cnx = sqlite3.connect(chemin, timeout=10, check_same_thread=False)
    cnx.row_factory = sqlite3.Row
    cnx.execute("PRAGMA foreign_keys=ON")
    return cnx


# Colonnes ajoutées après la création des tables : (table, colonne, définition).
COLONNES = [
    ("taches", "priorite", "INTEGER NOT NULL DEFAULT 0"),
    ("mails", "pourquoi", "TEXT NOT NULL DEFAULT ''"),
    ("mails", "expediteur", "TEXT NOT NULL DEFAULT ''"),
    ("sauvegardes", "fournisseur", "TEXT NOT NULL DEFAULT 'dossier'"),
    ("sauvegardes", "options", "TEXT NOT NULL DEFAULT '{}'"),
]


def initialiser(chemin: Path, schemas: list[str]) -> None:
    with connecter(chemin) as cnx:
        # Réglage persistant : à ne faire qu'ici, il se bloque si plusieurs requêtes le refont.
        cnx.execute("PRAGMA journal_mode=WAL")
        cnx.executescript(SCHEMA)
        for schema in schemas:
            cnx.executescript(schema)
        for table, colonne, definition in COLONNES:
            existantes = {l[1] for l in cnx.execute(f"PRAGMA table_info({table})")}
            if existantes and colonne not in existantes:
                cnx.execute(f"ALTER TABLE {table} ADD COLUMN {colonne} {definition}")
    chemin.chmod(0o600)


def publier(cnx: sqlite3.Connection, source: str, titre: str, detail: str = "",
            lien: str = "", cle: str | None = None, ts: float | None = None) -> bool:
    """Ajoute un événement au journal. Renvoie False s'il y était déjà (même clé)."""
    cur = cnx.execute(
        "INSERT OR IGNORE INTO evenements (ts, source, titre, detail, lien, cle)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (ts or time.time(), source, titre, detail, lien, cle),
    )
    return cur.rowcount > 0
