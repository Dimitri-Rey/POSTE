"""Mot de passe, sessions et protections HTTP.

L'application écoute sur 127.0.0.1 ; un proxy HTTPS (Tailscale, Caddy, Traefik…) la publie
pour les autres appareils. Le mot de passe unique est choisi à la première visite (rien n'est généré ni
affiché ailleurs) et stocké haché en scrypt.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from collections import deque
from pathlib import Path

COOKIE = "poste_session"
LONGUEUR_MIN = 10
MAX_ESSAIS = 5
FENETRE_ESSAIS = 300.0

ENTETES = {
    "Content-Security-Policy": (
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-cache",
}


def _scrypt(mdp: str, sel: bytes) -> bytes:
    return hashlib.scrypt(mdp.encode(), salt=sel, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024)


def hacher(mdp: str) -> str:
    sel = secrets.token_bytes(16)
    return f"{sel.hex()}${_scrypt(mdp, sel).hex()}"


def verifier(mdp: str, stocke: str) -> bool:
    sel, attendu = stocke.split("$", 1)
    return hmac.compare_digest(_scrypt(mdp, bytes.fromhex(sel)).hex(), attendu)


def mot_de_passe(cnx: sqlite3.Connection) -> str | None:
    ligne = cnx.execute("SELECT valeur FROM reglages WHERE cle='mot_de_passe'").fetchone()
    return ligne["valeur"] if ligne else None


def _hash_jeton(jeton: str) -> str:
    return hashlib.sha256(jeton.encode()).hexdigest()


def ouvrir_session(cnx: sqlite3.Connection, duree_jours: int) -> str:
    jeton = secrets.token_urlsafe(32)
    maintenant = time.time()
    cnx.execute("DELETE FROM sessions WHERE expire_le < ?", (maintenant,))
    cnx.execute(
        "INSERT INTO sessions VALUES (?, ?, ?)",
        (_hash_jeton(jeton), maintenant, maintenant + duree_jours * 86400),
    )
    return jeton


def session_valide(cnx: sqlite3.Connection, jeton: str | None) -> bool:
    if not jeton:
        return False
    ligne = cnx.execute(
        "SELECT 1 FROM sessions WHERE jeton_hash=? AND expire_le>?",
        (_hash_jeton(jeton), time.time()),
    ).fetchone()
    return ligne is not None


def fermer_session(cnx: sqlite3.Connection, jeton: str | None) -> None:
    if jeton:
        cnx.execute("DELETE FROM sessions WHERE jeton_hash=?", (_hash_jeton(jeton),))


# Jeton local de Hermes : seulement ces routes. Jamais les confirmations, les habitudes, le modèle
# ni la connexion : l'agent ne doit pas pouvoir valider ses propres actions.
ROUTES_AGENT = (
    ("GET", re.compile(r"/api/(accueil|taches|agenda|mails|mails/comptes|mails/[\w.-]+/\d+|sport/resume|sport/activites|documents/[0-9a-f]{32}/texte|espace/arbre|espace/fichier|espace/lire)")),
    ("POST", re.compile(r"/api/(taches|agenda|mails/brouillon|creations/[a-z_]+|espace/(?:appliquer|modifier|masquer|convertir|importer|pdf))")),
    ("PUT", re.compile(r"/api/espace/fichier")),
)



def entetes(collabora: str, drawio: str = "", sites: tuple[str, ...] = ()) -> dict[str, str]:
    """Cadres permis : les pages de Poste elles-mêmes (le mail HTML, isolé par sa propre politique), les éditeurs
    (bureautique, diagrammes) et les sites intégrés. Sans 'self', le contenu des mails HTML est bloqué.
    Seul Collabora reçoit un jeton."""
    cadres = " ".join(["'self'", *(x for x in (collabora, drawio) if x), *sites])
    politique = ENTETES["Content-Security-Policy"].replace("form-action 'self'", f"form-action 'self' {collabora}".rstrip() + f"; frame-src {cadres}")
    return {**ENTETES, "Content-Security-Policy": politique}


def jeton_agent(chemin: Path) -> str:
    """Créé au premier démarrage, lisible par le seul utilisateur."""
    if not chemin.exists():
        chemin.parent.mkdir(parents=True, exist_ok=True)
        descripteur = os.open(chemin, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descripteur, "w", encoding="ascii") as f:
            f.write(secrets.token_urlsafe(32))
    return chemin.read_text(encoding="ascii").strip()


def agent_autorise(methode: str, chemin: str, jeton: str | None, attendu: str) -> bool:
    if not jeton or not hmac.compare_digest(jeton.encode(), attendu.encode()):
        return False
    return any(methode == m and motif.fullmatch(chemin) for m, motif in ROUTES_AGENT)



class Limiteur:
    """Freine les essais de mot de passe (un seul utilisateur : compteur global)."""

    def __init__(self) -> None:
        self.essais: deque[float] = deque()

    def bloque(self) -> bool:
        limite = time.time() - FENETRE_ESSAIS
        while self.essais and self.essais[0] < limite:
            self.essais.popleft()
        return len(self.essais) >= MAX_ESSAIS

    def noter(self) -> None:
        self.essais.append(time.time())

    def effacer(self) -> None:
        self.essais.clear()
