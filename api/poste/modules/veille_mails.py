"""Veille des boîtes (IMAP IDLE) : le serveur prévient dès qu'un mail arrive, Poste synchronise la boîte aussitôt.

Une connexion d'attente par boîte, en lecture seule (rien n'est lu ni marqué). Une boîte sans IDLE, ou en panne,
est couverte par la synchro régulière du planificateur. La liste des veilleurs suit les comptes branchés.
"""
from __future__ import annotations

import imaplib
import logging
import re
import select
import ssl
import threading
import time
from typing import Callable

from . import mails

journal = logging.getLogger("poste.veille")

DUREE_IDLE = 9 * 60      # en dessous des 29 min de la RFC 2177 et des coupures des pare-feu
ATTENTE_MIN = 30
ATTENTE_MAX = 600
REGROUPEMENT = 2.0       # plusieurs avis d'affilée (EXISTS puis RECENT) : une seule synchro
ACTIVITE = re.compile(rb"^\* \d+ (EXISTS|EXPUNGE|FETCH)\b")


def attendre(boite: imaplib.IMAP4, duree: float, arret: threading.Event) -> bool:
    """Un cycle IDLE. True si la boîte a bougé (arrivée, suppression, changement lu/non lu)."""
    etiquette = boite._new_tag()
    boite.send(etiquette + b" IDLE\r\n")
    reponse = boite.readline()
    while reponse.startswith(b"* "):  # avis glissés avant l'accord du serveur
        reponse = boite.readline()
    if not reponse.startswith(b"+"):
        raise imaplib.IMAP4.error("IDLE refusé")
    bouge = False
    fin = time.monotonic() + duree
    while not bouge and not arret.is_set() and (reste := fin - time.monotonic()) > 0:
        pret = getattr(boite.sock, "pending", lambda: 0)() or select.select([boite.sock], [], [], min(reste, 5))[0]
        if not pret:
            continue
        ligne = boite.readline()
        if not ligne:
            raise OSError("connexion fermée par le serveur")
        bouge = bool(ACTIVITE.match(ligne))
    boite.send(b"DONE\r\n")
    while not (ligne := boite.readline()).startswith(etiquette):
        if not ligne:
            raise OSError("connexion fermée par le serveur")
    return bouge


class Veilleur(threading.Thread):
    def __init__(self, compte_id: str, signaler: Callable[[str], None]):
        super().__init__(name=f"veille-{compte_id}", daemon=True)
        self.compte_id = compte_id
        self.signaler = signaler
        self.arret = threading.Event()

    def _compte(self) -> mails.Compte | None:
        return next((c for c in mails.charger_comptes() if c.id == self.compte_id), None)

    def run(self) -> None:
        pause = ATTENTE_MIN
        while not self.arret.is_set():
            compte = self._compte()
            if compte is None:
                return
            try:
                boite = mails._ouvrir(compte)
                try:
                    if "IDLE" not in boite.capabilities:
                        journal.info("%s : pas d'IDLE, synchro régulière seulement", self.compte_id)
                        return
                    boite.select("INBOX", readonly=True)
                    # Ce qui a pu arriver pendant la reconnexion.
                    self.signaler(self.compte_id)
                    pause = ATTENTE_MIN
                    while not self.arret.is_set():
                        if attendre(boite, DUREE_IDLE, self.arret):
                            self.signaler(self.compte_id)
                finally:
                    try:
                        boite.logout()
                    except (imaplib.IMAP4.error, OSError):
                        pass
            except (imaplib.IMAP4.error, OSError, ssl.SSLError) as err:
                journal.warning("Veille %s coupée (%s), reprise dans %d s", self.compte_id, type(err).__name__, pause)
                self.arret.wait(pause)
                pause = min(pause * 2, ATTENTE_MAX)


class Veille:
    """Un veilleur par boîte branchée ; les synchros demandées sont regroupées et passent une par une."""

    def __init__(self, connecter: Callable, publier: Callable):
        self.connecter, self.publier = connecter, publier
        self.veilleurs: dict[str, Veilleur] = {}
        self.demandes: dict[str, float] = {}
        self.verrou = threading.Condition()
        self.fil: threading.Thread | None = None

    def signaler(self, compte_id: str) -> None:
        with self.verrou:
            self.demandes.setdefault(compte_id, time.monotonic() + REGROUPEMENT)
            self.verrou.notify()

    def _synchroniseur(self) -> None:
        while True:
            with self.verrou:
                while not self.demandes:
                    self.verrou.wait()
                compte_id, echeance = min(self.demandes.items(), key=lambda x: x[1])
                attente = echeance - time.monotonic()
                if attente > 0:
                    self.verrou.wait(attente)
                    continue
                del self.demandes[compte_id]
            compte = next((c for c in mails.charger_comptes() if c.id == compte_id), None)
            if compte:
                mails.synchroniser_un(self.connecter, self.publier, compte)

    def ajuster(self) -> None:
        """Démarre les veilleurs des nouvelles boîtes, arrête ceux des boîtes retirées."""
        if self.fil is None:
            self.fil = threading.Thread(target=self._synchroniseur, name="veille-synchro", daemon=True)
            self.fil.start()
        voulus = {c.id for c in mails.charger_comptes()}
        for ident in list(self.veilleurs):
            if ident not in voulus:
                self.veilleurs.pop(ident).arret.set()
        for ident in voulus - set(self.veilleurs):
            self.veilleurs[ident] = Veilleur(ident, self.signaler)
            self.veilleurs[ident].start()

    demarrer = ajuster
