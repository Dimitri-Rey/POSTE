"""Réglages du serveur : variable d'environnement, sinon fichier poste.toml (voir reglages.py), sinon défaut neutre."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from . import reglages

RACINE = Path(__file__).resolve().parents[2]


@dataclass
class Config:
    base: Path = field(default_factory=lambda: Path(os.environ.get(
        "POSTE_BASE", Path.home() / ".local/share/poste/poste.db")))
    web: Path = RACINE / "web"
    # Noms d'hôte acceptés et origines autorisées : l'adresse publique de Poste en fait partie.
    hotes: tuple[str, ...] = tuple(os.environ.get(
        "POSTE_HOTES", ",".join(reglages.lire("serveur", "hotes", ["127.0.0.1:8541", "localhost:8541"])),
    ).split(","))
    origines: tuple[str, ...] = tuple(os.environ.get(
        "POSTE_ORIGINES", ",".join(reglages.lire("serveur", "origines", ["http://127.0.0.1:8541"])),
    ).split(","))
    collabora_public: str = os.environ.get("POSTE_COLLABORA_PUBLIC", reglages.lire("collabora", "adresse_publique", ""))
    drawio_public: str = os.environ.get("POSTE_DRAWIO_PUBLIC", reglages.lire("drawio", "adresse_publique", ""))
    collabora_interne: str = os.environ.get("POSTE_COLLABORA_INTERNE", reglages.lire("collabora", "adresse_interne", "http://127.0.0.1:9980"))
    wopi_interne: str = os.environ.get("POSTE_WOPI_INTERNE", reglages.lire("collabora", "adresse_wopi", "http://127.0.0.1:8541"))
    # Le cookie Secure n'est coupé que par les tests (pas de HTTPS sur le client de test).
    cookie_secure: bool = os.environ.get("POSTE_COOKIE_SECURE", "1") == "1"
    duree_session_jours: int = 90
    jeton_agent: Path = field(default_factory=lambda: Path(os.environ.get(
        "POSTE_JETON_AGENT", Path.home() / ".config/poste/jeton-agent")))
    taches_de_fond: bool = os.environ.get("POSTE_TACHES_DE_FOND", "1") == "1"
