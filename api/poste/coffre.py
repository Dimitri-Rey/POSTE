"""Coffre des secrets branchés depuis l'interface (mots de passe de boîtes mail, d'agendas, clés d'API).

Les secrets sont chiffrés (Fernet : AES 128 + HMAC) dans la base, avec une clé rangée À CÔTÉ de la base, dans le
dossier de configuration : une copie de la base seule (sauvegarde, export) ne révèle aucun mot de passe.
Aucune route ne renvoie un secret : l'interface sait seulement s'il est défini.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from . import reglages

SCHEMA = """
CREATE TABLE IF NOT EXISTS secrets (nom TEXT PRIMARY KEY, valeur BLOB NOT NULL);
"""

_base: Path | None = None


def ouvrir(base: Path) -> None:
    """Appelé au démarrage : le coffre écrit dans la base de Poste."""
    global _base
    _base = base


def chemin_cle() -> Path:
    return Path(os.environ.get("POSTE_CLE") or reglages.fichier("serveur", "cle_secrets", "~/.config/poste/cle-secrets")).expanduser()


def _fernet() -> Fernet:
    cle = chemin_cle()
    if not cle.exists():
        cle.parent.mkdir(parents=True, exist_ok=True)
        descripteur = os.open(cle, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descripteur, "wb") as f:
            f.write(Fernet.generate_key())
    return Fernet(cle.read_bytes().strip())


def _connexion() -> sqlite3.Connection:
    if _base is None:
        raise RuntimeError("Coffre non ouvert")
    cnx = sqlite3.connect(_base, timeout=10)
    cnx.executescript(SCHEMA)
    return cnx


def ecrire(nom: str, valeur: str) -> None:
    jeton = _fernet().encrypt(valeur.encode())
    cnx = _connexion()
    try:
        with cnx:
            cnx.execute("INSERT OR REPLACE INTO secrets VALUES (?, ?)", (nom, jeton))
    finally:
        cnx.close()


def lire(nom: str) -> str | None:
    """None si absent, ou si la clé a changé (le secret est alors à ressaisir)."""
    if _base is None:
        return None
    cnx = _connexion()
    try:
        ligne = cnx.execute("SELECT valeur FROM secrets WHERE nom=?", (nom,)).fetchone()
    finally:
        cnx.close()
    if not ligne:
        return None
    try:
        return _fernet().decrypt(ligne[0]).decode()
    except InvalidToken:
        return None


def effacer(nom: str) -> None:
    cnx = _connexion()
    try:
        with cnx:
            cnx.execute("DELETE FROM secrets WHERE nom=?", (nom,))
    finally:
        cnx.close()


def defini(nom: str) -> bool:
    return lire(nom) is not None
