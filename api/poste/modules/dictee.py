"""Dictée en direct : le texte s'écrit pendant qu'on parle, 100 % sur la machine.

Le calcul est confié au service de transcription réglé (compatible OpenAI, /v1/audio/transcriptions). Le passage en cours est retranscrit toutes les 0,5 s (« partiel ») et figé à chaque pause (« final »),
pour que chaque calcul reste court quelle que soit la durée de la dictée.

WebSocket ``/api/dictee`` :
- navigateur -> serveur : morceaux PCM 16 bits mono 16 kHz, puis le texte ``fin`` ;
- serveur -> navigateur : JSON ``{"type": "pret" | "partiel" | "final" | "erreur" | "fin", "texte": ...}``.
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import sqlite3
import threading
import wave
from collections.abc import Callable

import httpx
import numpy as np
from fastapi import APIRouter, HTTPException
from starlette.websockets import WebSocket, WebSocketDisconnect

from .. import reglages, securite


journal = logging.getLogger("poste.dictee")



def adresse() -> str:
    """Service de transcription compatible OpenAI (/v1/audio/transcriptions) : Speaches, whisper.cpp, Parakeet…"""
    return (reglages.lire("dictee", "adresse", "") or "http://127.0.0.1:8085").rstrip("/")


FREQ = 16000
TRAME = FREQ // 10  # 100 ms : unité de mesure du volume
PAS_PARTIEL = FREQ // 2  # nouvelle transcription partielle toutes les 0,5 s de son reçu
PAUSE_TRAMES = 7  # 0,7 s de silence après de la parole = fin de phrase
PAROLE_MIN_TRAMES = 3  # moins de 0,3 s de son : bruit, pas de la parole
SEGMENT_MAX = 20 * FREQ  # au-delà, on fige au point le plus calme des 8 dernières secondes
SEUIL_MIN = 0.005  # volume sous lequel c'est toujours du silence (son normalisé entre -1 et 1)
DUREE_MAX_S = 300
INACTIVITE_S = 30.0
MORCEAU_MAX = 64 * 1024


def moteur_pret() -> None:
    refus = HTTPException(503, "Moteur de dictée indisponible sur le serveur")
    try:
        r = httpx.get(f"{adresse()}/health", timeout=3)
        if r.status_code == 404:
            # Pas de /health (Speaches, whisper.cpp…) : un service qui liste ses modèles est prêt.
            r = httpx.get(f"{adresse()}/v1/models", timeout=3)
            pret = r.is_success
        else:
            donnees = r.json() if r.is_success else {}
            pret = r.is_success and donnees.get("modele_charge", True) is not False
    except (httpx.HTTPError, ValueError, AttributeError):
        pret = False
    if not pret:
        raise refus


def reconnaitre(son: np.ndarray) -> str:
    tampon = io.BytesIO()
    with wave.open(tampon, "wb") as sortie:
        sortie.setnchannels(1)
        sortie.setsampwidth(2)
        sortie.setframerate(FREQ)
        sortie.writeframes((np.clip(son, -1, 1) * 32767).astype(np.int16).tobytes())
    try:
        modele = reglages.lire("dictee", "modele", "")
        reponse = httpx.post(f"{adresse()}/v1/audio/transcriptions", timeout=30, data={"model": modele} if modele else None,
                             files={"file": ("dictee.wav", tampon.getvalue(), "audio/wav")})
        reponse.raise_for_status()
        return reponse.json()["text"].strip()
    except (httpx.HTTPError, ValueError, KeyError) as err:
        journal.warning("Dictée : moteur en erreur : %s", type(err).__name__)
        raise HTTPException(503, "Moteur de dictée indisponible sur le serveur") from err


class Segmenteur:
    """Découpe un flux continu en passages et produit les événements à envoyer.

    ``ajouter`` est appelé par la boucle de réception pendant qu'``etape`` tourne dans un fil : le tampon est
    protégé par un verrou, et une étape ne retire que le son qu'elle a traité.
    """

    def __init__(self, reconnaitre: Callable[[np.ndarray], str]) -> None:
        self.reconnaitre = reconnaitre
        self._tampon = np.zeros(0, np.float32)
        self._verrou = threading.Lock()
        self._traite = 0  # taille du tampon lors du dernier calcul
        self._dernier_partiel = ""
        self.recu = 0  # échantillons reçus depuis le début
        self._niveaux: list[float] = []  # volumes de toute la dictée, pour estimer le bruit de fond

    def ajouter(self, pcm: bytes) -> None:
        son = np.frombuffer(pcm[: len(pcm) // 2 * 2], np.int16).astype(np.float32) / 32768.0
        with self._verrou:
            self._tampon = np.concatenate((self._tampon, son))
            self.recu += son.size

    def a_traiter(self) -> bool:
        with self._verrou:
            return self._tampon.size - self._traite >= PAS_PARTIEL

    def _seuil(self, niveaux: np.ndarray) -> float:
        self._niveaux = (self._niveaux + niveaux.tolist())[-3000:]  # 5 dernières minutes
        bruit = float(np.percentile(self._niveaux, 10))
        fort = float(np.percentile(self._niveaux, 95))
        return max(SEUIL_MIN, min(2.5 * bruit, 0.25 * fort))

    def _retirer(self, n: int) -> None:
        with self._verrou:
            self._tampon = self._tampon[n:]
            self._traite = 0

    def _final(self, son: np.ndarray, retire: int) -> list[dict]:
        self._retirer(retire)
        self._dernier_partiel = ""
        texte = self.reconnaitre(son)
        return [{"type": "final", "texte": texte}] if texte else []

    def etape(self) -> list[dict]:
        with self._verrou:
            son = self._tampon.copy()
            self._traite = son.size
        trames = son.size // TRAME
        if trames == 0:
            return []
        niveaux = np.sqrt(np.mean(son[: trames * TRAME].reshape(trames, TRAME) ** 2, axis=1))
        nouveaux = niveaux[-(PAS_PARTIEL // TRAME) :]
        seuil = self._seuil(nouveaux)
        parle = niveaux >= seuil
        if parle.sum() < PAROLE_MIN_TRAMES:
            if son.size > 3 * FREQ:  # que du silence : on oublie, en gardant la dernière demi-seconde
                self._retirer(son.size - FREQ // 2)
            return []
        if trames > PAUSE_TRAMES and not parle[-PAUSE_TRAMES:].any():
            # Pause après de la parole : on fige la phrase (avec 0,2 s de marge) et on jette le silence.
            fin = (int(np.flatnonzero(parle)[-1]) + 3) * TRAME
            return self._final(son[:fin], son.size)
        if son.size >= SEGMENT_MAX:
            debut = trames - 80
            coupe = (debut + int(np.argmin(niveaux[debut:]))) * TRAME
            return self._final(son[:coupe], coupe)
        texte = self.reconnaitre(son)
        if not texte or texte == self._dernier_partiel:
            return []
        self._dernier_partiel = texte
        return [{"type": "partiel", "texte": texte}]

    def terminer(self) -> list[dict]:
        with self._verrou:
            son = self._tampon.copy()
        self._retirer(son.size)
        trames = son.size // TRAME
        if trames < PAROLE_MIN_TRAMES:
            return []
        niveaux = np.sqrt(np.mean(son[: trames * TRAME].reshape(trames, TRAME) ** 2, axis=1))
        if (niveaux >= self._seuil(niveaux)).sum() < PAROLE_MIN_TRAMES:
            return []
        texte = self.reconnaitre(son)
        return [{"type": "final", "texte": texte}] if texte else []


async def session(ws: WebSocket) -> None:
    """Une dictée : réception du son et transcription en parallèle, jusqu'à « fin » ou déconnexion."""
    segmenteur = Segmenteur(lambda extrait: reconnaitre(extrait))
    reveil = asyncio.Event()
    etat = {"fin": False, "coupe": False}

    async def recevoir() -> None:
        try:
            while True:
                message = await asyncio.wait_for(ws.receive(), INACTIVITE_S)
                if message["type"] == "websocket.disconnect":
                    etat["coupe"] = True
                    return
                if message.get("text") == "fin":
                    etat["fin"] = True
                    return
                morceau = message.get("bytes") or b""
                if len(morceau) > MORCEAU_MAX:
                    etat["coupe"] = True
                    return
                segmenteur.ajouter(morceau)
                if segmenteur.recu > DUREE_MAX_S * FREQ:
                    etat["fin"] = True
                    return
                reveil.set()
        except (TimeoutError, WebSocketDisconnect):
            etat["coupe"] = True
        finally:
            reveil.set()

    reception = asyncio.create_task(recevoir())
    try:
        await asyncio.to_thread(moteur_pret)
        await ws.send_json({"type": "pret"})
        while True:
            await reveil.wait()
            reveil.clear()
            if etat["coupe"]:
                return
            if etat["fin"]:
                for evenement in await asyncio.to_thread(segmenteur.terminer):
                    await ws.send_json(evenement)
                await ws.send_json({"type": "fin"})
                return
            if segmenteur.a_traiter():
                for evenement in await asyncio.to_thread(segmenteur.etape):
                    await ws.send_json(evenement)
                if segmenteur.a_traiter():  # du son est arrivé pendant le calcul
                    reveil.set()
    except HTTPException as err:
        await ws.send_json({"type": "erreur", "texte": err.detail})
    except WebSocketDisconnect:
        return
    finally:
        reception.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reception
        with contextlib.suppress(RuntimeError):
            await ws.close()


def creer_routeur(connecter: Callable[[], sqlite3.Connection], hotes, origines) -> APIRouter:
    routeur = APIRouter(tags=["dictee"])

    def autorise(ws: WebSocket) -> bool:
        """Le middleware HTTP ne voit pas les WebSocket : hôte, origine et session sont vérifiés ici.

        L'origine est obligatoire : une page tierce ouverte sur le même réseau ne doit pas pouvoir écouter ce canal.
        """
        if ws.headers.get("host") not in hotes or ws.headers.get("origin") not in origines:
            return False
        cnx = connecter()
        try:
            return securite.session_valide(cnx, ws.cookies.get(securite.COOKIE))
        finally:
            cnx.close()

    @routeur.websocket("/api/dictee")
    async def dictee(ws: WebSocket) -> None:
        if not autorise(ws):
            await ws.close(code=1008)
            return
        await ws.accept()
        await session(ws)

    return routeur
