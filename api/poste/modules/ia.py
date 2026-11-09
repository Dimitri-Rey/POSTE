"""Appel direct au moteur d'IA, pour les petites rédactions qui ne passent pas par Hermes.

N'importe quel service compatible OpenAI convient : Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, OpenAI.
Adresse, modèle et clé se règlent dans Réglages (la clé va au coffre) ou dans poste.toml, section [ia].
"""
from __future__ import annotations

import logging
import os
import re

import httpx
from fastapi import HTTPException

from .. import coffre, reglages

journal = logging.getLogger("poste.ia")

SECRET_CLE = "ia:cle"
# Moteurs qui refusent les paramètres inconnus : on n'y renvoie plus l'option de réflexion coupée.
_sans_option_reflexion: set[str] = set()


def adresse() -> str:
    """Racine du service, sans « /v1 » final : on accepte les deux écritures."""
    brut = os.environ.get("POSTE_URL_IA") or reglages.lire("ia", "adresse", "") or "http://127.0.0.1:11434"
    return re.sub(r"/v1/?$", "", brut.strip().rstrip("/"))


def entetes() -> dict[str, str]:
    cle = coffre.lire(SECRET_CLE)
    return {"Authorization": f"Bearer {cle}"} if cle else {}


def modeles(delai: float = 5) -> list[str]:
    r = httpx.get(f"{adresse()}/v1/models", headers=entetes(), timeout=delai)
    r.raise_for_status()
    return [m["id"] for m in r.json()["data"]]


def modele(delai: float = 5) -> str:
    """Le modèle choisi dans les réglages, sinon le premier que le service annonce."""
    return reglages.lire("ia", "modele", "") or modeles(delai)[0]


def _poster(corps: dict, delai: float) -> httpx.Response:
    racine = adresse()
    if racine not in _sans_option_reflexion:
        r = httpx.post(f"{racine}/v1/chat/completions", headers=entetes(), timeout=delai,
                       json={**corps, "chat_template_kwargs": {"enable_thinking": False}})
        if r.status_code not in (400, 422):
            return r
        # OpenAI et quelques autres refusent cette option propre aux moteurs locaux : on réessaie sans.
        _sans_option_reflexion.add(racine)
    return httpx.post(f"{racine}/v1/chat/completions", headers=entetes(), timeout=delai, json=corps)


def completer(systeme: str, texte: str, max_tokens: int, temperature: float = 0.3, delai: float = 180, en_json: bool = False) -> str:
    """Renvoie le texte du modèle. Une réponse coupée est refusée : un texte tronqué ne doit jamais remplacer l'original."""
    try:
        r = _poster({
            "model": modele(), "max_tokens": max_tokens, "temperature": temperature,
            **({"response_format": {"type": "json_object"}} if en_json else {}),
            "messages": [{"role": "system", "content": systeme}, {"role": "user", "content": texte}],
        }, delai)
        r.raise_for_status()
        choix = r.json()["choices"][0]
        reponse = re.sub(r"<think>.*?</think>", "", choix["message"]["content"] or "", flags=re.S).strip()
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as err:
        journal.warning("IA indisponible : %s", type(err).__name__)
        raise HTTPException(503, "L'IA ne répond pas. Réessaie dans un instant.") from err
    if choix.get("finish_reason") == "length":
        raise HTTPException(422, "Réponse de l'IA coupée : texte trop long, sélectionne un passage plus court.")
    return reponse
