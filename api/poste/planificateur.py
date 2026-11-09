"""Tâches de fond : synchro des mails, rappels d'agenda, échéances, alertes serveur."""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Callable

from . import reglages
from .modules import connecteurs, mails, notifications, point_mails, sauvegardes, serveur, sport, veille_mails

journal = logging.getLogger("poste.planificateur")

SERVICES_CRITIQUES = set(reglages.lire("serveur", "services_critiques", []))
SEUIL_DISQUE_GO = 20
SEUIL_GPU_DEGRES = 87
HEURE_ECHEANCES = 8


def rappels_agenda(cnx, publier: Callable, maintenant: datetime | None = None) -> int:
    maintenant = maintenant or datetime.now()
    envoyes = 0
    lignes = cnx.execute(
        "SELECT * FROM evenements_agenda WHERE rappele=0 AND debut >= ?",
        (maintenant.strftime("%Y-%m-%dT%H:%M"),),
    ).fetchall()
    for e in lignes:
        debut = datetime.fromisoformat(e["debut"])
        if debut - timedelta(minutes=e["rappel_minutes"]) <= maintenant:
            cnx.execute("UPDATE evenements_agenda SET rappele=1 WHERE id=?", (e["id"],))
            heure = debut.strftime("%H:%M")
            notifications.envoyer(f"{heure} · {e['titre']}", e["lieu"], lien="/#agenda", priorite=4, type_="agenda")
            publier("Agenda", e["titre"], f"à {heure}", "#agenda", f"rappel:{e['id']}:{e['debut']}")
            envoyes += 1
    return envoyes


def echeances_du_jour(cnx, publier: Callable, maintenant: datetime | None = None) -> int:
    """Une fois par tâche, le matin de l'échéance ou dès qu'elle est en retard."""
    maintenant = maintenant or datetime.now()
    if maintenant.hour < HEURE_ECHEANCES:
        return 0
    lignes = cnx.execute(
        "SELECT * FROM taches WHERE faite_le IS NULL AND signalee=0 AND echeance IS NOT NULL AND echeance <= ?",
        (maintenant.date().isoformat(),),
    ).fetchall()
    for t in lignes:
        cnx.execute("UPDATE taches SET signalee=1 WHERE id=?", (t["id"],))
        notifications.envoyer("Tâche à faire", t["titre"], lien="/#taches", type_="taches")
        publier("Tâches", t["titre"], f"échéance {t['echeance']}", "#taches", f"tache:{t['id']}:{t['echeance']}")
    return len(lignes)



def alertes_serveur(etat: dict, deja: set[str], publier: Callable) -> list[str]:
    """Ne signale qu'au changement : une panne qui dure ne sonne qu'une fois."""
    actuelles = {}
    for s in etat["services"]:
        if s["id"] in SERVICES_CRITIQUES and s["etat"] in ("failed", "inactive"):
            actuelles[f"service:{s['id']}"] = f"{s['nom']} est arrêté"
    for d in etat["disques"]:
        if d["libre_go"] < SEUIL_DISQUE_GO:
            actuelles[f"disque:{d['nom']}"] = f"Disque {d['nom']} : {d['libre_go']} Go libres"
    if etat["gpu"] and etat["gpu"]["temperature"] >= SEUIL_GPU_DEGRES:
        actuelles["gpu"] = f"GPU à {etat['gpu']['temperature']} °C"
    nouvelles = [c for c in actuelles if c not in deja]
    for cle in nouvelles:
        notifications.envoyer("Alerte serveur", actuelles[cle], lien="/#serveur", priorite=5, type_="serveur")
        publier("Serveur", actuelles[cle], "", "#serveur", f"{cle}:{int(time.time())}")
    deja.clear()
    deja.update(actuelles)
    return nouvelles


def alertes_connues(connecter: Callable) -> set[str]:
    """Alertes déjà signalées, gardées en base : un redémarrage de Poste ne refait pas sonner une panne qui dure."""
    cnx = connecter()
    try:
        ligne = cnx.execute("SELECT valeur FROM reglages WHERE cle='alertes_serveur'").fetchone()
    finally:
        cnx.close()
    try:
        return set(json.loads(ligne[0])) if ligne else set()
    except ValueError:
        return set()


def retenir_alertes(connecter: Callable, alertes: set[str]) -> None:
    cnx = connecter()
    try:
        with cnx:
            cnx.execute("INSERT OR REPLACE INTO reglages VALUES ('alertes_serveur', ?)", (json.dumps(sorted(alertes)),))
    finally:
        cnx.close()


def en_transaction(connecter: Callable, publier: Callable, action: Callable) -> None:
    """Les annonces partent après l'enregistrement : publier a sa propre connexion et se bloquerait sur celle-ci."""
    cnx = connecter()
    annonces: list[tuple] = []
    try:
        with cnx:
            action(cnx, lambda *a: annonces.append(a))
    finally:
        cnx.close()
    for annonce in annonces:
        publier(*annonce)


def demarrer(connecter: Callable, publier: Callable) -> threading.Thread:
    def executer(nom: str, action: Callable) -> None:
        try:
            action()
        except Exception:  # noqa: BLE001 - une tâche en panne ne doit pas arrêter les autres
            journal.exception("Tâche %s en erreur", nom)

    def boucle() -> None:
        alertes = alertes_connues(connecter)

        def surveiller() -> None:
            alertes_serveur(serveur.etat(), alertes, publier)
            retenir_alertes(connecter, alertes)
        dernier_mail = 0.0
        dernier_sport = 0.0
        dernier_agenda = 0.0
        # Arrivée des mails en direct (IMAP IDLE) ; la synchro régulière ci-dessous rattrape le reste.
        veille = veille_mails.Veille(connecter, publier)
        if reglages.actif("mails"):
            executer("veille", veille.demarrer)
        while True:
            executer("rappels", lambda: en_transaction(connecter, publier, rappels_agenda))
            executer("echeances", lambda: en_transaction(connecter, publier, echeances_du_jour))
            # Modules coupés (dans poste.toml ou Réglages) : leurs tâches de fond ne tournent pas.
            executer("serveur", surveiller)
            executer("sauvegardes", sauvegardes.lancer_dues)
            if reglages.actif("mails"):
                executer("point_mails", lambda: point_mails.lancer_du_matin(connecter))
            if reglages.actif("mails") and time.time() - dernier_mail >= 120:
                dernier_mail = time.time()
                executer("veille", veille.ajuster)
                executer("mails", lambda: mails.synchroniser_tout(connecter, publier))
            if reglages.actif("agenda") and time.time() - dernier_agenda >= 900:
                dernier_agenda = time.time()
                executer("agendas", connecteurs.synchroniser_agendas)
            if reglages.actif("sport") and time.time() - dernier_sport >= 3600:
                dernier_sport = time.time()
                executer("sport", lambda: sport.synchroniser(connecter))
            time.sleep(60)

    fil = threading.Thread(target=boucle, name="planificateur", daemon=True)
    fil.start()
    return fil
