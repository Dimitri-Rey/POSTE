"""Réglages de l'installation, lus une fois dans un fichier TOML.

Ordre de priorité : variable d'environnement (quand elle existe) > réglage fait dans l'interface (Réglages,
branchements) > fichier > valeur par défaut du code.
Le fichier vit chez l'utilisateur (~/.config/poste/poste.toml, ou POSTE_CONFIG) et n'est jamais dans le dépôt :
c'est là que vont les adresses, les services branchés et les modules activés. Voir poste.exemple.toml.
"""
from __future__ import annotations

import functools
import logging
import os
import tomllib
from pathlib import Path
from typing import Any

journal = logging.getLogger("poste.reglages")

# Modules facultatifs : coupés, ils disparaissent de l'interface et leurs routes répondent 404.
MODULES_DEFAUT = {
    "mails": True, "agenda": True, "taches": True, "fichiers": True, "serveur": True,
    "hermes": False, "sport": False,
    "collabora": False, "drawio": False, "dictee": False, "notifications": False, "blocage_mailcow": False,
}


# Réglages faits dans l'interface, rangés dans la base et posés au démarrage par le module connecteurs.
_surcharges: dict[str, dict] = {}


def poser_surcharges(valeurs: dict[str, dict]) -> None:
    _surcharges.clear()
    _surcharges.update({s: dict(v) for s, v in valeurs.items()})


def chemin() -> Path:
    return Path(os.environ.get("POSTE_CONFIG", Path.home() / ".config/poste/poste.toml")).expanduser()


@functools.cache
def _contenu() -> dict:
    fichier = chemin()
    if not fichier.exists():
        return {}
    try:
        with fichier.open("rb") as f:
            return tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as err:
        # Un fichier illisible ne doit pas empêcher Poste de démarrer : on le signale et on part des défauts.
        journal.error("Réglages illisibles (%s) : %s", fichier, err)
        return {}


def section(nom: str) -> dict:
    """Une table du fichier ; « ia.modeles » désigne la sous-table [ia.modeles]."""
    noeud: Any = _contenu()
    for partie in nom.split("."):
        noeud = noeud.get(partie, {}) if isinstance(noeud, dict) else {}
    return {**(noeud if isinstance(noeud, dict) else {}), **_surcharges.get(nom, {})}


def lire(section_: str, cle: str, defaut: Any = None) -> Any:
    return section(section_).get(cle, defaut)


def fichier(section_: str, cle: str, defaut: str) -> Path:
    """Chemin réglable, « ~ » compris."""
    return Path(lire(section_, cle, defaut)).expanduser()


def actif(module: str) -> bool:
    return bool(section("modules").get(module, MODULES_DEFAUT.get(module, False)))


def modules() -> dict[str, bool]:
    return {m: actif(m) for m in MODULES_DEFAUT}


def prenom() -> str:
    """Prénom de l'utilisateur (Réglages, ou [profil] prenom) : l'IA s'adresse à lui et signe ses brouillons."""
    return str(lire("profil", "prenom", "") or "").strip()


def personnaliser(consigne: str) -> str:
    """Remplace {qui} dans une consigne pour l'IA (sans .format : les consignes contiennent du JSON)."""
    return consigne.replace("{qui}", prenom() or "l'utilisateur")


def recharger() -> None:
    _contenu.cache_clear()
