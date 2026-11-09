"""Notifications sur le téléphone par ntfy (serveur à soi ou ntfy.sh). Une notification ratée ne casse jamais une action.

Adresse, sujet et jeton se règlent dans Réglages (le jeton va au coffre) ou dans poste.toml, section [notifications].
"""
from __future__ import annotations

import logging

import httpx

from .. import coffre, reglages

journal = logging.getLogger("poste.notifications")

SECRET_JETON = "notifications:jeton"

# Ce que l'utilisateur peut choisir de recevoir (Réglages, section « Notifications »), avec le module dont ça dépend.
# Réglages rangés dans la section « alertes » : « recevoir » coupe tout, chaque type se coupe à part.
TYPES = {
    "mails": ("Nouveaux mails importants", "Seulement ceux que Poste classe comme importants.", "mails"),
    "hermes_confirmation": ("Hermes attend ta confirmation", "Il est bloqué tant que tu n'as pas répondu.", "hermes"),
    "hermes_fin": ("Hermes a fini", "Réponse terminée, échec ou arrêt.", "hermes"),
    "agenda": ("Rappels de rendez-vous", "À l'heure du rappel choisi pour chaque rendez-vous.", "agenda"),
    "taches": ("Tâches à faire", "Le matin de l'échéance, ou dès qu'une tâche est en retard.", "taches"),
    "serveur": ("Alertes serveur", "Service arrêté, disque presque plein, GPU trop chaud.", "serveur"),
    "sauvegardes": ("Sauvegarde en échec", "Disque absent, plein, ou dossier inaccessible.", None),
}


def adresse() -> str:
    return (reglages.lire("notifications", "adresse", "") or "http://127.0.0.1:8546").rstrip("/")


def sujet() -> str:
    return reglages.lire("notifications", "sujet", "") or "poste"


def adresse_publique() -> str:
    """Celle que le téléphone joint ; par défaut la même que le serveur."""
    return reglages.lire("notifications", "adresse_publique", "") or adresse()


def _jeton() -> str | None:
    """Jeton saisi dans Réglages, sinon fichier indiqué dans poste.toml (installation d'origine)."""
    jeton = coffre.lire(SECRET_JETON)
    if jeton:
        return jeton
    try:
        return reglages.fichier("notifications", "jeton", "~/.config/poste/ntfy-jeton").read_text(encoding="ascii").strip() or None
    except OSError:
        return None


def _entetes() -> dict[str, str]:
    jeton = _jeton()
    return {"Authorization": f"Bearer {jeton}"} if jeton else {}


def voulu(type_: str) -> bool:
    """Sans type (essai depuis Réglages), on envoie toujours."""
    if not type_:
        return True
    return bool(reglages.lire("alertes", "recevoir", True)) and bool(reglages.lire("alertes", type_, True))


def preferences() -> dict:
    return {
        "branche": reglages.actif("notifications"),
        "recevoir": bool(reglages.lire("alertes", "recevoir", True)),
        "types": [{"id": t, "nom": nom, "aide": aide, "actif": bool(reglages.lire("alertes", t, True))}
                  for t, (nom, aide, module) in TYPES.items() if module is None or reglages.actif(module)],
    }


def envoyer(titre: str, texte: str = "", lien: str = "", priorite: int = 3, type_: str = "") -> bool:
    if not reglages.actif("notifications") or not voulu(type_):
        return False
    try:
        reponse = httpx.post(adresse(), timeout=5, headers=_entetes(), json={
            "topic": sujet(), "title": titre[:200], "message": texte[:1000] or titre[:200],
            "priority": priorite, "click": lien,
        })
        reponse.raise_for_status()
    except httpx.HTTPError as err:
        journal.warning("ntfy indisponible : %s", type(err).__name__)
        return False
    return True


def envoi_possible() -> bool:
    """Le serveur peut répondre avec un jeton refusé : on teste le droit d'écrire, pas seulement le service."""
    if not reglages.actif("notifications"):
        return False
    try:
        return httpx.get(f"{adresse()}/{sujet()}/auth", timeout=3, headers=_entetes()).is_success
    except httpx.HTTPError:
        return False


def config_appareil() -> dict:
    """Ce dont l'APK a besoin pour écouter ; servi uniquement à une session connectée."""
    return {"url": adresse_publique(), "sujet": sujet(), "jeton": _jeton()}
