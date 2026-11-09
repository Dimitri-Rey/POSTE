"""Sport : activités Strava du seul compte de l'utilisateur, en lecture. Secret et jetons restent dans des fichiers, jamais en base."""
from __future__ import annotations

import json
import logging
import os
import secrets
import sqlite3
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field
from .. import reglages

journal = logging.getLogger("poste.sport")

CONF = Path.home() / ".config/poste/strava.env"
JETONS = Path.home() / ".config/poste/strava-jetons.json"
SITE = reglages.lire("serveur", "adresse_publique", "http://127.0.0.1:8541")
API = "https://www.strava.com/api/v3"
OAUTH = "https://www.strava.com/oauth"
PORTEE = "read,activity:read_all"
PAGES_MAX = 20  # 100 activités par page : le reste de l'historique suit à la synchro suivante, sans épuiser le quota.
DUREE_ETAT_S = 600

SCHEMA = """
CREATE TABLE IF NOT EXISTS activites_sport (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    sport TEXT NOT NULL,
    nom TEXT NOT NULL DEFAULT '',
    distance_m REAL NOT NULL DEFAULT 0,
    duree_s INTEGER NOT NULL DEFAULT 0,
    denivele_m REAL NOT NULL DEFAULT 0,
    fc_moy REAL,
    fc_max REAL,
    watts_moy REAL,
    effort REAL
);
CREATE INDEX IF NOT EXISTS activites_sport_ts ON activites_sport (ts DESC);
"""


def identifiants() -> tuple[str, str] | None:
    try:
        valeurs = dict(l.strip().split("=", 1) for l in CONF.read_text(encoding="utf-8").splitlines() if "=" in l)
        return valeurs["STRAVA_CLIENT_ID"].strip(), valeurs["STRAVA_CLIENT_SECRET"].strip()
    except (OSError, KeyError, ValueError):
        return None


class Identifiants(BaseModel):
    client_id: str = Field(pattern=r"^[0-9]{1,12}$")
    client_secret: str = Field(pattern=r"^[A-Za-z0-9]{20,100}$")


def ecrire_identifiants(ids: Identifiants) -> None:
    CONF.parent.mkdir(parents=True, exist_ok=True)
    temporaire = CONF.with_suffix(".tmp")
    descripteur = os.open(temporaire, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descripteur, "w", encoding="utf-8") as f:
        f.write(f"STRAVA_CLIENT_ID={ids.client_id}\nSTRAVA_CLIENT_SECRET={ids.client_secret}\n")
    temporaire.replace(CONF)


def lire_jetons() -> dict | None:
    try:
        return json.loads(JETONS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def ecrire_jetons(jetons: dict) -> None:
    gardes = {k: jetons[k] for k in ("access_token", "refresh_token", "expires_at")}
    temporaire = JETONS.with_suffix(".tmp")
    descripteur = os.open(temporaire, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descripteur, "w", encoding="utf-8") as f:
        json.dump(gardes, f)
    temporaire.replace(JETONS)


def _echange(donnees: dict) -> dict:
    ids = identifiants()
    if not ids:
        raise HTTPException(503, "Strava n'est pas configuré sur le serveur")
    try:
        r = httpx.post(f"{OAUTH}/token", timeout=20, data={"client_id": ids[0], "client_secret": ids[1], **donnees})
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as err:
        # Seul le type : le message pourrait citer la requête.
        journal.warning("Échange de jeton Strava refusé : %s", type(err).__name__)
        raise HTTPException(502, "Strava a refusé l'échange de jeton") from err


def jeton_valide() -> str | None:
    jetons = lire_jetons()
    if not jetons:
        return None
    if jetons["expires_at"] - time.time() < 300:
        jetons = _echange({"grant_type": "refresh_token", "refresh_token": jetons["refresh_token"]})
        ecrire_jetons(jetons)
    return jetons["access_token"]


def _ligne(a: dict) -> tuple:
    debut = datetime.fromisoformat(a["start_date"].replace("Z", "+00:00")).timestamp()
    return (a["id"], debut, a.get("sport_type") or a.get("type") or "Autre", a.get("name") or "", a.get("distance") or 0,
            a.get("moving_time") or 0, a.get("total_elevation_gain") or 0, a.get("average_heartrate"), a.get("max_heartrate"),
            a.get("average_watts"), a.get("suffer_score"))


def synchroniser(connecter: Callable[[], sqlite3.Connection]) -> int:
    """Ne demande que ce qui est plus récent que la dernière activité connue ; Strava les renvoie alors du plus ancien au plus récent."""
    jeton = jeton_valide()
    if not jeton:
        return 0
    cnx = connecter()
    ajoutees = 0
    try:
        apres = cnx.execute("SELECT COALESCE(MAX(ts), 0) FROM activites_sport").fetchone()[0]
        for page in range(1, PAGES_MAX + 1):
            r = httpx.get(f"{API}/athlete/activities", timeout=30, headers={"Authorization": f"Bearer {jeton}"},
                          params={"after": int(apres), "per_page": 100, "page": page})
            if r.status_code == 429:
                journal.warning("Quota Strava atteint : suite à la prochaine synchro")
                break
            r.raise_for_status()
            lot = r.json()
            if not lot:
                break
            with cnx:
                cnx.executemany("INSERT OR REPLACE INTO activites_sport VALUES (?,?,?,?,?,?,?,?,?,?,?)", [_ligne(a) for a in lot])
            ajoutees += len(lot)
            if len(lot) < 100:
                break
    finally:
        cnx.close()
    return ajoutees


def _semaine(ts: float) -> str:
    jour = datetime.fromtimestamp(ts)
    return (jour - timedelta(days=jour.weekday())).strftime("%Y-%m-%d")


def _bilan(lignes: list) -> dict:
    return {"seances": len(lignes), "km": round(sum(l["distance_m"] for l in lignes) / 1000, 1),
            "heures": round(sum(l["duree_s"] for l in lignes) / 3600, 1), "denivele_m": round(sum(l["denivele_m"] for l in lignes))}


def resume(cnx: sqlite3.Connection, maintenant: float | None = None) -> dict:
    maintenant = maintenant or time.time()
    jour = 86400
    recent = cnx.execute("SELECT * FROM activites_sport WHERE ts >= ?", (maintenant - 84 * jour,)).fetchall()
    semaines: dict[str, dict[str, list]] = {}
    for l in recent:
        semaines.setdefault(_semaine(l["ts"]), {}).setdefault(l["sport"], []).append(l)
    comparer = {}
    for sport in sorted({l["sport"] for l in recent}):
        a = [l for l in recent if l["sport"] == sport and l["ts"] >= maintenant - 28 * jour]
        b = [l for l in recent if l["sport"] == sport and maintenant - 56 * jour <= l["ts"] < maintenant - 28 * jour]
        comparer[sport] = {"28_derniers_jours": _bilan(a), "28_jours_precedents": _bilan(b)}
    records = {}
    for sport, km, heures, deniv in cnx.execute(
            "SELECT sport, MAX(distance_m)/1000, MAX(duree_s)/3600.0, MAX(denivele_m) FROM activites_sport GROUP BY sport"):
        records[sport] = {"plus_longue_km": round(km, 1), "plus_longue_heures": round(heures, 1), "plus_gros_denivele_m": round(deniv)}
    dernieres = cnx.execute("SELECT * FROM activites_sport ORDER BY ts DESC LIMIT 10").fetchall()
    total = cnx.execute("SELECT COUNT(*), MIN(ts) FROM activites_sport").fetchone()
    return {
        "total_activites": total[0],
        "depuis": datetime.fromtimestamp(total[1]).strftime("%Y-%m-%d") if total[1] else None,
        "comparaison": comparer,
        "semaines": {s: {sp: _bilan(ls) for sp, ls in d.items()} for s, d in sorted(semaines.items())},
        "records": records,
        "dernieres": [activite(l) for l in dernieres],
    }


def activite(l: sqlite3.Row) -> dict:
    return {"date": datetime.fromtimestamp(l["ts"]).strftime("%Y-%m-%d %H:%M"), "sport": l["sport"], "nom": l["nom"],
            "km": round(l["distance_m"] / 1000, 2), "minutes": round(l["duree_s"] / 60), "denivele_m": round(l["denivele_m"]),
            "allure_min_km": round(l["duree_s"] / 60 / (l["distance_m"] / 1000), 2) if l["distance_m"] else None,
            "fc_moy": l["fc_moy"], "fc_max": l["fc_max"], "watts_moy": l["watts_moy"], "effort": l["effort"]}


def creer_routeurs(connecter: Callable[[], sqlite3.Connection]) -> tuple[APIRouter, APIRouter]:
    """Le premier exige une session ; le second reçoit le retour de Strava, sans cookie (SameSite=Strict) : son « state » le protège."""
    prive = APIRouter(prefix="/api/sport", tags=["sport"])
    retour = APIRouter(prefix="/api/sport", tags=["sport"])
    etats: dict[str, float] = {}

    @prive.get("/etat")
    def etat() -> dict:
        cnx = connecter()
        try:
            nombre = cnx.execute("SELECT COUNT(*) FROM activites_sport").fetchone()[0]
        finally:
            cnx.close()
        return {"configure": identifiants() is not None, "connecte": lire_jetons() is not None, "activites": nombre}

    @prive.post("/identifiants")
    def enregistrer(corps: Identifiants) -> dict:
        """Le secret entre ici et n'en ressort jamais : aucune route ne le renvoie."""
        ecrire_identifiants(corps)
        return {"ok": True}

    @prive.get("/connexion")
    def connexion() -> RedirectResponse:
        ids = identifiants()
        if not ids:
            raise HTTPException(503, "Strava n'est pas configuré sur le serveur")
        for ancien in [e for e, fin in etats.items() if fin < time.time()]:
            del etats[ancien]
        jeton = secrets.token_urlsafe(24)
        etats[jeton] = time.time() + DUREE_ETAT_S
        return RedirectResponse(f"{OAUTH}/authorize?" + urlencode({
            "client_id": ids[0], "redirect_uri": f"{SITE}/api/sport/retour", "response_type": "code",
            "approval_prompt": "auto", "scope": PORTEE, "state": jeton,
        }))

    def page(texte: str, code: int = 200) -> HTMLResponse:
        return HTMLResponse(f'<!doctype html><html lang="fr"><meta charset="utf-8"><title>Poste</title><p>{texte}</p></html>', status_code=code)

    @retour.get("/retour")
    def revenu(state: str = "", code: str = "", scope: str = "", error: str = "") -> HTMLResponse:
        if etats.pop(state, 0) < time.time():
            return page("Demande expirée ou inconnue. Relance la connexion depuis Poste.", 400)
        if error or not code:
            return page("Connexion à Strava annulée.")
        if "activity:read_all" not in scope.split(","):
            return page("Il faut cocher l'accès à toutes tes activités. Relance la connexion depuis Poste.", 400)
        try:
            ecrire_jetons(_echange({"grant_type": "authorization_code", "code": code}))
        except HTTPException:
            return page("Strava a refusé la connexion. Réessaie depuis Poste.", 502)
        return page("Strava est connecté. Tu peux fermer cette page et revenir sur Poste.")

    @prive.post("/synchroniser")
    def lancer() -> dict:
        try:
            return {"ajoutees": synchroniser(connecter)}
        except httpx.HTTPError as err:
            journal.warning("Synchro Strava impossible : %s", type(err).__name__)
            raise HTTPException(502, "Strava ne répond pas") from err

    @prive.post("/deconnecter")
    def deconnecter() -> dict:
        jetons = lire_jetons()
        if jetons:
            try:
                httpx.post(f"{OAUTH}/deauthorize", timeout=15, data={"access_token": jetons["access_token"]})
            except httpx.HTTPError as err:
                journal.warning("Révocation Strava non confirmée : %s", type(err).__name__)
        JETONS.unlink(missing_ok=True)
        cnx = connecter()
        try:
            with cnx:
                cnx.execute("DELETE FROM activites_sport")
        finally:
            cnx.close()
        return {"ok": True}

    @prive.get("/resume")
    def lire_resume() -> dict:
        cnx = connecter()
        try:
            return resume(cnx)
        finally:
            cnx.close()

    @prive.get("/activites")
    def activites(sport: str | None = None, jours: int = Query(default=30, ge=1, le=3650), limite: int = Query(default=50, ge=1, le=200)) -> list[dict]:
        cnx = connecter()
        try:
            lignes = cnx.execute(
                "SELECT * FROM activites_sport WHERE ts >= ? AND (? IS NULL OR sport = ?) ORDER BY ts DESC LIMIT ?",
                (time.time() - jours * 86400, sport, sport, limite)).fetchall()
            return [activite(l) for l in lignes]
        finally:
            cnx.close()

    return prive, retour
