"""Recherche dans le contenu des fichiers de l'espace : index SQLite FTS5 tenu à jour par comparaison taille + date.

Le texte vient de Espace.texte (même extraction et même cache que la lecture par Hermes).
Les textes simples sont indexés tout de suite à la recherche ; documents bureautiques et PDF (LibreOffice, OCR)
passent par la tâche de fond, pour qu'une recherche ne reste jamais bloquée derrière une conversion.
"""
from __future__ import annotations

import contextlib
import logging
import re
import sqlite3
import threading
import time
from pathlib import Path

from . import documents

journal = logging.getLogger("poste.recherche")

RAPIDES = documents.TEXTE
LENTS = (documents.BUREAU - {"pages", "numbers", "key"}) | {"pdf"}
TAILLE_MAX = 30 * 1024 * 1024
TEXTE_MAX = 2_000_000
RESULTATS_MAX = 50
PERIODE = 120
# Délimiteurs d'extrait : jamais présents dans un texte extrait, l'interface les remplace par un surlignage.
DEBUT, FIN = "\x02", "\x03"

SCHEMA = """
CREATE TABLE IF NOT EXISTS fichiers (chemin TEXT PRIMARY KEY, taille INTEGER NOT NULL, modifie REAL NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS contenu USING fts5(chemin UNINDEXED, texte, tokenize = 'unicode61 remove_diacritics 2');
"""


def extension(chemin: str) -> str:
    return chemin.rsplit(".", 1)[-1].lower() if "." in chemin.rsplit("/", 1)[-1] else ""


def requete(texte: str) -> str | None:
    """Chaque mot devient un préfixe entre guillemets : aucune syntaxe FTS5 ne passe de la saisie à la requête."""
    mots = re.findall(r"\w+", texte, flags=re.UNICODE)[:12]
    return " ".join(f'"{m}"*' for m in mots) or None


class Index:
    def __init__(self, espace, base: Path) -> None:
        self.espace = espace
        self.base = base
        self.verrou = threading.Lock()
        self.reveil = threading.Event()
        with self._connexion() as cnx:
            cnx.executescript(SCHEMA)
            cnx.commit()

    @contextlib.contextmanager
    def _connexion(self):
        cnx = sqlite3.connect(self.base, timeout=10)
        try:
            cnx.execute("PRAGMA journal_mode=WAL")
            yield cnx
        finally:
            cnx.close()

    def mettre_a_jour(self, lents: bool = True) -> int:
        """Indexe ce qui a changé. Sans `lents`, seulement les fichiers texte. Renvoie le nombre de fichiers relus."""
        if not self.verrou.acquire(blocking=lents):
            return 0
        try:
            return self._mettre_a_jour(lents)
        finally:
            self.verrou.release()

    def _mettre_a_jour(self, lents: bool) -> int:
        actuels = {e["chemin"]: e for e in self.espace.arbre() if not e["dossier"]}
        relus = 0
        with self._connexion() as cnx:
            connus = {c: (t, m) for c, t, m in cnx.execute("SELECT chemin, taille, modifie FROM fichiers")}
            for chemin in connus.keys() - actuels.keys():
                cnx.execute("DELETE FROM fichiers WHERE chemin=?", (chemin,))
                cnx.execute("DELETE FROM contenu WHERE chemin=?", (chemin,))
            cnx.commit()
            for chemin, e in actuels.items():
                ext = extension(chemin)
                if connus.get(chemin) == (e["taille"], e["modifie"]):
                    continue
                if ext not in RAPIDES and not (lents and ext in LENTS):
                    continue
                texte = ""
                if e["taille"] <= TAILLE_MAX:
                    try:
                        texte = self.espace.texte(self.espace.existant(chemin))[0][:TEXTE_MAX]
                    except documents.Illisible:
                        pass
                    except Exception:  # un fichier abîmé ne doit pas arrêter l'indexation des autres
                        journal.exception("indexation impossible : %s", chemin)
                cnx.execute("DELETE FROM contenu WHERE chemin=?", (chemin,))
                if texte.strip():
                    cnx.execute("INSERT INTO contenu (chemin, texte) VALUES (?, ?)", (chemin, texte))
                cnx.execute("INSERT OR REPLACE INTO fichiers VALUES (?, ?, ?)", (chemin, e["taille"], e["modifie"]))
                cnx.commit()
                relus += 1
        return relus

    def chercher(self, texte: str) -> list[dict]:
        self.mettre_a_jour(lents=False)
        self.reveil.set()
        q = requete(texte)
        if not q:
            return []
        with self._connexion() as cnx:
            lignes = cnx.execute(
                "SELECT chemin, snippet(contenu, 1, ?, ?, ' … ', 24) FROM contenu WHERE contenu MATCH ? ORDER BY bm25(contenu) LIMIT ?",
                (DEBUT, FIN, q, RESULTATS_MAX),
            ).fetchall()
        return [{"chemin": c, "extrait": re.sub(r"\s+", " ", x).strip()} for c, x in lignes]

    def etat(self) -> dict:
        self.mettre_a_jour(lents=False)
        with self._connexion() as cnx:
            fichiers = cnx.execute("SELECT count(*) FROM fichiers").fetchone()[0]
            avec_texte = cnx.execute("SELECT count(*) FROM contenu").fetchone()[0]
        return {"fichiers": fichiers, "avec_texte": avec_texte}

    def demarrer(self) -> None:
        def boucle() -> None:
            while True:
                try:
                    self.mettre_a_jour()
                except Exception:
                    journal.exception("indexation")
                self.reveil.wait(PERIODE)
                self.reveil.clear()
                time.sleep(2)
        threading.Thread(target=boucle, name="poste-index", daemon=True).start()
