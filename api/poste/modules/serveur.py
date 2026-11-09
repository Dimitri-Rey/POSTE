"""État de la machine : charge, mémoire, disque, GPU et services utilisateur."""
from __future__ import annotations

import os
import shutil
import subprocess

from fastapi import APIRouter

from . import notifications
from .. import reglages

routeur = APIRouter(prefix="/api/serveur", tags=["serveur"])

# Services systemd suivis (unité → nom affiché) et disques : propres à chaque machine, dans poste.toml.
SERVICES = reglages.section("serveur.services")
DISQUES = reglages.section("serveur.disques") or {"Système": "/"}


def _lancer(*cmd: str) -> str | None:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return res.stdout.strip()


def memoire() -> dict:
    valeurs = {}
    with open("/proc/meminfo", encoding="ascii") as f:
        for ligne in f:
            cle, val = ligne.split(":", 1)
            valeurs[cle] = int(val.split()[0])
    total = valeurs["MemTotal"]
    return {"total_go": round(total / 2**20, 1),
            "utilise_go": round((total - valeurs["MemAvailable"]) / 2**20, 1)}


def gpu() -> dict | None:
    sortie = _lancer(
        "nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    )
    if not sortie:
        return None
    charge, utilisee, totale, temp = (int(x) for x in sortie.splitlines()[0].split(", "))
    return {"charge": charge, "memoire_go": round(utilisee / 1024, 1),
            "memoire_totale_go": round(totale / 1024, 1), "temperature": temp}


def services() -> list[dict]:
    sortie = (_lancer("systemctl", "--user", "is-active", *SERVICES) or "") if SERVICES else ""
    etats = sortie.splitlines()
    liste = [{"id": sid, "nom": nom, "etat": etats[i] if i < len(etats) else "inconnu"}
             for i, (sid, nom) in enumerate(SERVICES.items())]
    if not reglages.actif("notifications"):
        return liste
    envoi = "active" if notifications.envoi_possible() else "failed"
    return [*liste, {"id": "ntfy-envoi", "nom": "Envoi des notifications", "etat": envoi}]


def etat() -> dict:
    disques = []
    for nom, chemin in DISQUES.items():
        if os.path.exists(chemin):
            usage = shutil.disk_usage(chemin)
            disques.append({"nom": nom, "libre_go": usage.free // 2**30,
                            "total_go": usage.total // 2**30})
    return {
        "charge": round(os.getloadavg()[0], 1),
        "coeurs": os.cpu_count(),
        "memoire": memoire(),
        "gpu": gpu(),
        "disques": disques,
        "services": services(),
    }


@routeur.get("")
def lire() -> dict:
    return etat()
