"""Sauvegardes de Poste vers un ou plusieurs endroits, réglées dans Réglages.

Où : un dossier du serveur, ou tout stockage joignable par rclone (voir stockages.py : clouds, kDrive, NAS Synology,
partages SMB avec comptes d'annuaire, SFTP, S3…), avec chiffrement facultatif.

Ce qui est copié : la base (copie cohérente à chaud), les Fichiers, les documents joints, les créations, poste.toml ;
les clés et secrets (~/.config/poste) seulement si on le demande. Le reste se reconstruit (draw.io, APK, index).

Rotation : une sauvegarde complète (toutes les données), puis des incrémentielles (seulement ce qui a changé depuis
la précédente, plus la liste de ce qui a été supprimé). Une complète et ses incrémentielles forment une chaîne ;
on garde les N dernières chaînes. Restaurer = la complète, puis chaque incrémentielle dans l'ordre.

Sur l'endroit choisi, tout va dans un sous-dossier « poste-sauvegardes » : une archive .tar.gz par sauvegarde et,
à côté, sa fiche .json (type, chaîne, taille, état des fichiers pour calculer la suivante).
Routes réservées à une session humaine (absentes de la liste de Hermes).
"""
from __future__ import annotations

import calendar
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from .. import __version__, coffre, reglages
from .stockages import Dossier, ErreurStockage, Rclone
from . import stockages

journal = logging.getLogger("poste.sauvegardes")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sauvegardes (
    id INTEGER PRIMARY KEY,
    nom TEXT NOT NULL,
    chemin TEXT NOT NULL,
    actif INTEGER NOT NULL DEFAULT 1,
    heure TEXT NOT NULL DEFAULT '03:00',
    frequence TEXT NOT NULL DEFAULT 'jours',
    jours TEXT NOT NULL DEFAULT '1234567',
    jour_mois INTEGER NOT NULL DEFAULT 1,
    complete TEXT NOT NULL DEFAULT 'semaine',
    complete_jour INTEGER NOT NULL DEFAULT 7,
    garder INTEGER NOT NULL DEFAULT 4,
    secrets INTEGER NOT NULL DEFAULT 0,
    derniere_tentative REAL,
    derniere_reussite REAL,
    erreur TEXT NOT NULL DEFAULT ''
);
"""

SOUS_DOSSIER = "poste-sauvegardes"
FICHE = ".poste-sauvegarde.json"
DOSSIERS_DONNEES = ("espace", "documents", "fichiers")
RESTAURATIONS = "Restaurations"
FRAIS = 600  # secondes : aperçu d'un stockage distant gardé en mémoire
JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]

_racine_donnees: Path | None = None
_base: Path | None = None
_connecter: Callable[[], sqlite3.Connection] | None = None
_publier: Callable | None = None
_verrou = threading.Lock()
_en_cours: dict[int, str] = {}
_apercus: dict[int, dict] = {}
_rafraichis: set[int] = set()


ErreurSauvegarde = ErreurStockage  # même famille : message lisible, à montrer tel quel


# --- Planning ---------------------------------------------------------------------------------------------------------

def _heure(plan: dict) -> tuple[int, int]:
    h, m = plan["heure"].split(":")
    return int(h), int(m)


def _jour_du_mois(annee: int, mois: int, jour: int) -> int:
    """« Le 31 » tombe le dernier jour des mois plus courts."""
    return min(jour, calendar.monthrange(annee, mois)[1])


def _prevu_ce_jour(plan: dict, d: date) -> bool:
    if plan["frequence"] == "mois":
        return d.day == _jour_du_mois(d.year, d.month, plan["jour_mois"])
    return str(d.isoweekday()) in plan["jours"]


def dernier_creneau(plan: dict, maintenant: datetime) -> datetime | None:
    """Le dernier moment prévu, passé ou présent (sur deux mois au plus)."""
    h, m = _heure(plan)
    for decalage in range(0, 63):
        d = maintenant.date() - timedelta(days=decalage)
        moment = datetime(d.year, d.month, d.day, h, m)
        if moment <= maintenant and _prevu_ce_jour(plan, d):
            return moment
    return None


def prochain_creneau(plan: dict, maintenant: datetime) -> datetime | None:
    h, m = _heure(plan)
    for decalage in range(0, 63):
        d = maintenant.date() + timedelta(days=decalage)
        moment = datetime(d.year, d.month, d.day, h, m)
        if moment > maintenant and _prevu_ce_jour(plan, d):
            return moment
    return None


def debut_du_cycle(plan: dict, maintenant: datetime) -> datetime | None:
    """Depuis ce moment, la prochaine sauvegarde doit être complète si aucune complète n'a été faite."""
    if plan["complete"] == "toujours":
        return maintenant
    h, m = _heure(plan)
    for decalage in range(0, 63):
        d = maintenant.date() - timedelta(days=decalage)
        if plan["complete"] == "semaine":
            bon = d.isoweekday() == plan["complete_jour"]
        else:
            bon = d.day == _jour_du_mois(d.year, d.month, plan["complete_jour"])
        moment = datetime(d.year, d.month, d.day, h, m)
        if bon and moment <= maintenant:
            return moment
    return None


def resume(plan: dict) -> str:
    """Le planning en une phrase, pour l'écran."""
    if plan["frequence"] == "mois":
        quand = f"le {plan['jour_mois']} de chaque mois à {plan['heure']}"
    elif len(plan["jours"]) == 7:
        quand = f"tous les jours à {plan['heure']}"
    else:
        quand = ", ".join(JOURS[int(j) - 1] for j in sorted(plan["jours"])) + f" à {plan['heure']}"
    if plan["complete"] == "toujours":
        rotation = "toujours complète"
        duree = f"{plan['garder']} sauvegarde{'s' if plan['garder'] > 1 else ''} gardée{'s' if plan['garder'] > 1 else ''}"
    elif plan["complete"] == "semaine":
        rotation = f"complète le {JOURS[plan['complete_jour'] - 1]}, incrémentielle sinon"
        duree = f"environ {plan['garder']} semaine{'s' if plan['garder'] > 1 else ''} d'historique"
    else:
        rotation = f"complète le {plan['complete_jour']} du mois, incrémentielle sinon"
        duree = f"environ {plan['garder']} mois d'historique"
    return f"{quand[0].upper()}{quand[1:]} · {rotation} · {duree}."


# --- Ce qui est copié -------------------------------------------------------------------------------------------------

def _dossier_config() -> Path:
    return reglages.chemin().parent


def _sources(secrets: bool) -> list[tuple[str, Path]]:
    """(nom dans l'archive, chemin réel) de chaque fichier à copier, hors base (copiée à part)."""
    sources: list[tuple[str, Path]] = []
    for nom in DOSSIERS_DONNEES:
        racine = _racine_donnees / nom
        if not racine.is_dir():
            continue
        for dossier, sous, fichiers in os.walk(racine):
            sous.sort()
            for f in sorted(fichiers):
                chemin = Path(dossier) / f
                if chemin.is_file() and not chemin.is_symlink():
                    sources.append((f"donnees/{nom}/{chemin.relative_to(racine).as_posix()}", chemin))
    toml = reglages.chemin()
    if toml.is_file():
        sources.append(("config/poste.toml", toml))
    if secrets:
        cle = coffre.chemin_cle()
        vus = {toml.resolve()}
        for chemin in sorted(_dossier_config().glob("*")) + [cle]:
            if chemin.is_file() and chemin.resolve() not in vus:
                vus.add(chemin.resolve())
                sources.append((f"config/secrets/{chemin.name}", chemin))
    return sources


def _copie_base(dossier: Path) -> Path:
    """Copie cohérente de la base pendant que Poste tourne (API de sauvegarde de SQLite)."""
    cible = dossier / "poste.db"
    source = sqlite3.connect(f"file:{_base or _racine_donnees / 'poste.db'}?mode=ro", uri=True, timeout=30)
    copie = sqlite3.connect(cible)
    try:
        source.backup(copie)
    finally:
        copie.close()
        source.close()
    return cible


# --- Endroit de sauvegarde --------------------------------------------------------------------------------------------

def verifier_endroit(chemin: str) -> Path:
    """Un dossier absolu, existant, où Poste peut écrire, en dehors de ses propres données."""
    brut = Path(chemin.strip()).expanduser()
    if not brut.is_absolute():
        raise ErreurSauvegarde("Donne un chemin complet, qui commence par / (par exemple /mnt/disque-externe).")
    if not brut.is_dir():
        raise ErreurSauvegarde(f"Le dossier {brut} n'existe pas (disque branché et monté ?).")
    reel = brut.resolve()
    interdits = [Path("/"), _racine_donnees.resolve(), _dossier_config().resolve()]
    if reel == Path("/") or any(reel == i or reel.is_relative_to(i) for i in interdits[1:]):
        raise ErreurSauvegarde("Choisis un dossier en dehors des données de Poste (idéalement un autre disque).")
    if not os.access(reel, os.W_OK | os.X_OK):
        raise ErreurSauvegarde(f"Poste ne peut pas écrire dans {reel}.")
    return reel


def _secrets(ident: int | None, fournis: dict | None = None) -> dict:
    """Secrets du coffre pour cet endroit, remplacés par ceux qu'on vient de saisir (vide = garder l'ancien)."""
    valeurs = {c: coffre.lire(f"sauvegarde:{ident}:{c}") for c in stockages.SECRETS} if ident else {}
    valeurs |= {c: v for c, v in (fournis or {}).items() if c in stockages.SECRETS and v}
    return {c: v for c, v in valeurs.items() if v}


def stockage_de(plan: dict, secrets: dict | None = None) -> Dossier | Rclone:
    fournisseur = plan.get("fournisseur") or "dossier"
    if fournisseur == "dossier":
        return Dossier(verifier_endroit(plan["chemin"]) / SOUS_DOSSIER)
    secrets = _secrets(plan.get("id")) if secrets is None else secrets
    options = json.loads(plan["options"]) if isinstance(plan.get("options"), str) else dict(plan.get("options") or {})
    params, chemin = stockages.configuration(stockages.FOURNISSEURS[fournisseur]["type"],
                                             {**stockages.FOURNISSEURS[fournisseur].get("options", {}), **options,
                                              "chemin": plan.get("chemin", "")}, secrets)
    return Rclone(plan.get("id") or "essai", params, chemin, secrets.get("chiffrement", ""), SOUS_DOSSIER)


def _cache(plan: dict) -> Path | None:
    """Fiches déjà lues d'un stockage distant (elles ne changent jamais) : évite de les retélécharger."""
    if not plan.get("id") or (plan.get("fournisseur") or "dossier") == "dossier":
        return None
    return _racine_donnees / "sauvegardes-cache" / str(plan["id"])


def vider_cache(ident: int) -> None:
    shutil.rmtree(_racine_donnees / "sauvegardes-cache" / str(ident), ignore_errors=True)
    _apercus.pop(ident, None)


def lister(stockage: Dossier | Rclone | Path, cache: Path | None = None) -> list[dict]:
    """Les sauvegardes présentes, des plus anciennes aux plus récentes (lues sur l'endroit, pas en base)."""
    if isinstance(stockage, Path):
        stockage = Dossier(stockage)
    noms = stockage.noms()
    archives = {n for n in noms if n.endswith(".tar.gz")}
    fiches = []
    for nom in noms:
        if not (nom.startswith("poste-") and nom.endswith(".json")):
            continue
        local = cache / nom if cache else None
        try:
            if local and local.is_file():
                brut = local.read_bytes()
            else:
                brut = stockage.lire(nom)
                if local:
                    local.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    local.write_bytes(brut)
            fiche = json.loads(brut)
        except (OSError, ValueError, ErreurStockage):
            continue
        if fiche.get("archive") in archives:
            fiches.append(fiche)
    return sorted(fiches, key=lambda x: x["date"])


def _sans_etat(fiche: dict) -> dict:
    return {k: v for k, v in fiche.items() if k != "etat"}


# --- Faire une sauvegarde ---------------------------------------------------------------------------------------------

def sauvegarder(plan: dict, maintenant: datetime | None = None, forcer_complete: bool = False) -> dict:
    """Une sauvegarde, complète ou incrémentielle selon le planning, puis la rotation. Renvoie sa fiche."""
    maintenant = maintenant or datetime.now()
    stockage = stockage_de(plan)
    stockage.preparer()
    existantes = lister(stockage, _cache(plan))
    deja = {f["archive"] for f in existantes}
    precedente = existantes[-1] if existantes else None
    derniere_complete = next((f for f in reversed(existantes) if f["type"] == "complete"), None)
    cycle = debut_du_cycle(plan, maintenant)
    complete = (forcer_complete or precedente is None or derniere_complete is None or "etat" not in precedente
                or bool(precedente.get("secrets")) != bool(plan["secrets"])
                or (cycle is not None and datetime.fromisoformat(derniere_complete["date"]) < cycle))
    horodatage = maintenant.strftime("%Y%m%d-%H%M%S")
    nom = f"poste-{horodatage}-{'complete' if complete else 'incr'}"
    while f"{nom}.tar.gz" in deja:
        maintenant += timedelta(seconds=1)
        nom = f"poste-{maintenant.strftime('%Y%m%d-%H%M%S')}-{'complete' if complete else 'incr'}"
    sources = _sources(bool(plan["secrets"]))
    etat = {arc: [c.stat().st_size, c.stat().st_mtime_ns] for arc, c in sources}
    ancien = {} if complete else precedente["etat"]
    a_copier = [(arc, c) for arc, c in sources if ancien.get(arc) != etat[arc]]
    supprimes = sorted(set(ancien) - set(etat))
    fiche = {
        "archive": f"{nom}.tar.gz", "date": maintenant.isoformat(timespec="seconds"),
        "type": "complete" if complete else "incrementielle",
        "chaine": f"{nom}.tar.gz" if complete else precedente["chaine"],
        "parent": None if complete else precedente["archive"],
        "fichiers": len(a_copier) + 1, "supprimes": len(supprimes), "secrets": bool(plan["secrets"]),
        "version": __version__,
    }
    # Préparée dans les données de Poste (pas dans /tmp, souvent en mémoire), puis envoyée d'un bloc.
    attente = _racine_donnees / ".sauvegarde-en-cours"
    shutil.rmtree(attente, ignore_errors=True)
    attente.mkdir(mode=0o700)
    local = attente / fiche["archive"]
    try:
        with tempfile.TemporaryDirectory(prefix="base-", dir=attente) as tmp:
            base = _copie_base(Path(tmp))
            with tarfile.open(local, "w:gz", compresslevel=6) as archive:
                archive.add(base, "donnees/poste.db")
                for arc, chemin in a_copier:
                    try:
                        archive.add(chemin, arc, recursive=False)
                    except FileNotFoundError:
                        etat.pop(arc, None)  # supprimé entre-temps : il sera vu à la prochaine
                donnees = json.dumps({**fiche, "supprimes_liste": supprimes}, ensure_ascii=False).encode()
                info = tarfile.TarInfo(FICHE)
                info.size, info.mtime, info.mode = len(donnees), int(time.time()), 0o600
                archive.addfile(info, io.BytesIO(donnees))
        fiche["taille"] = local.stat().st_size
        stockage.envoyer(local, fiche["archive"])
        # La fiche part en dernier : sans elle l'archive est ignorée, donc une coupure ne laisse rien de bancal.
        stockage.ecrire(f"{nom}.json", json.dumps({**fiche, "etat": etat}, ensure_ascii=False).encode())
    except OSError as err:
        raise ErreurSauvegarde(f"Écriture impossible : {err.strerror or err}") from err
    finally:
        shutil.rmtree(attente, ignore_errors=True)
    tourner(stockage, plan["garder"], _cache(plan))
    return fiche


def tourner(stockage: Dossier | Rclone | Path, garder: int, cache: Path | None = None) -> list[str]:
    """Garde les `garder` dernières chaînes (une complète et ses incrémentielles) ; efface les plus anciennes."""
    if isinstance(stockage, Path):
        stockage = Dossier(stockage)
    fiches = lister(stockage, cache)
    chaines = list(dict.fromkeys(f["chaine"] for f in fiches if f["type"] == "complete"))
    a_effacer = set(chaines[:-garder]) if len(chaines) > garder else set()
    # Une incrémentielle dont la complète a disparu ne se restaure plus : elle part aussi.
    orphelines = {f["chaine"] for f in fiches} - set(chaines)
    effacees = []
    for f in fiches:
        if f["chaine"] in a_effacer or f["chaine"] in orphelines:
            fiche = f["archive"].replace(".tar.gz", ".json")
            stockage.effacer(fiche)  # la fiche d'abord : une archive sans fiche est ignorée
            stockage.effacer(f["archive"])
            if cache:
                (cache / fiche).unlink(missing_ok=True)
            effacees.append(f["archive"])
    if isinstance(stockage, Dossier) and stockage.racine.is_dir():
        for reste in stockage.racine.glob("*.partiel"):
            if time.time() - reste.stat().st_mtime > 86400:
                reste.unlink(missing_ok=True)
    return effacees


# --- Restaurer ----------------------------------------------------------------------------------------------------------

def chaine_jusqua(stockage: Dossier | Rclone | Path, archive: str, cache: Path | None = None) -> list[dict]:
    fiches = {f["archive"]: f for f in lister(stockage, cache)}
    if archive not in fiches:
        raise ErreurSauvegarde("Sauvegarde introuvable sur cet endroit.")
    suite = [fiches[archive]]
    while suite[0]["parent"]:
        parent = fiches.get(suite[0]["parent"])
        if parent is None:
            raise ErreurSauvegarde("Il manque une sauvegarde de la chaîne : celle-ci ne peut plus être restaurée.")
        suite.insert(0, parent)
    return suite


def restaurer(stockage: Dossier | Rclone | Path, archive: str, cible: Path, prefixe: str = "", cache: Path | None = None) -> int:
    """Remet dans `cible` l'état au moment de `archive` (complète puis incrémentielles). `prefixe` limite à une partie."""
    if isinstance(stockage, Path):
        stockage = Dossier(stockage)
    chaine = chaine_jusqua(stockage, archive, cache)
    cible.mkdir(parents=True, exist_ok=True)
    total = 0
    attente = Path(tempfile.mkdtemp(prefix=".restauration-", dir=cible.parent))
    try:
        for fiche in chaine:
            total += _extraire(stockage.chemin_local(fiche["archive"], attente), cible, prefixe)
    finally:
        shutil.rmtree(attente, ignore_errors=True)
    return total


def _extraire(archive: Path, cible: Path, prefixe: str) -> int:
    """Une archive de la chaîne : ses fichiers (sous `prefixe`), puis les suppressions qu'elle note."""
    with tarfile.open(archive, "r:gz") as tar:
        meta = json.load(tar.extractfile(FICHE))
        membres = [m for m in tar.getmembers() if m.name != FICHE and m.name.startswith(prefixe)]
        for m in membres:
            m.name = m.name[len(prefixe):]
        tar.extractall(cible, members=[m for m in membres if m.name], filter="data")
    for supprime in meta.get("supprimes_liste", []):
        if supprime.startswith(prefixe) and supprime[len(prefixe):]:
            chemin = (cible / supprime[len(prefixe):]).resolve()
            if chemin.is_relative_to(cible.resolve()):
                chemin.unlink(missing_ok=True)
    return len(membres)


# --- Base, planificateur ------------------------------------------------------------------------------------------------

def _plans(cnx: sqlite3.Connection) -> list[dict]:
    return [dict(l) for l in cnx.execute("SELECT * FROM sauvegardes ORDER BY id")]


def _noter(ident: int, **valeurs) -> None:
    cnx = _connecter()
    try:
        with cnx:
            cnx.execute(f"UPDATE sauvegardes SET {', '.join(f'{k}=?' for k in valeurs)} WHERE id=?", (*valeurs.values(), ident))
    finally:
        cnx.close()


def executer(plan: dict, forcer_complete: bool = False) -> None:
    """Dans un fil à part ; une seule sauvegarde à la fois sur tout Poste."""
    from . import notifications
    with _verrou:
        _en_cours[plan["id"]] = "complete" if forcer_complete else "auto"
        try:
            fiche = sauvegarder(plan, forcer_complete=forcer_complete)
            _noter(plan["id"], derniere_reussite=time.time(), erreur="")
            journal.info("Sauvegarde %s faite : %s (%s octets)", plan["nom"], fiche["archive"], fiche["taille"])
        except (ErreurSauvegarde, OSError, sqlite3.Error, tarfile.TarError) as err:
            message = str(err) if isinstance(err, ErreurSauvegarde) else f"{type(err).__name__} : {err}"
            _noter(plan["id"], erreur=message[:500])
            journal.warning("Sauvegarde %s en échec : %s", plan["nom"], message)
            notifications.envoyer(f"Sauvegarde « {plan['nom']} » en échec", message[:300], lien="/#reglages", priorite=4,
                                  type_="sauvegardes")
            if _publier:
                _publier("Sauvegardes", f"Sauvegarde « {plan['nom']} » en échec", message[:200], "#reglages",
                         f"sauvegarde:{plan['id']}:{int(time.time())}")
        finally:
            # Aperçu relu avant de rendre la main : l'écran ne voit jamais « fini » avec l'ancienne liste.
            if _cache(plan):
                actualiser(plan)
            _en_cours.pop(plan["id"], None)


def lancer(plan: dict, forcer_complete: bool = False, moment: datetime | None = None) -> bool:
    if _en_cours or _verrou.locked():
        return False
    _en_cours[plan["id"]] = "attente"
    # Noté avant de partir : le planificateur ne relance pas ce créneau, même en échec (le suivant réessaiera).
    _noter(plan["id"], derniere_tentative=(moment or datetime.now()).timestamp())
    threading.Thread(target=executer, args=(plan, forcer_complete), name=f"sauvegarde-{plan['id']}", daemon=True).start()
    return True


def lancer_dues(maintenant: datetime | None = None) -> list[int]:
    """Appelé chaque minute : lance ce qui est prévu et pas encore tenté depuis le dernier créneau (rattrape un oubli)."""
    maintenant = maintenant or datetime.now()
    cnx = _connecter()
    try:
        plans = _plans(cnx)
    finally:
        cnx.close()
    lances = []
    for plan in plans:
        creneau = dernier_creneau(plan, maintenant)
        if plan["actif"] and creneau and (plan["derniere_tentative"] or 0) < creneau.timestamp():
            if lancer(plan, moment=maintenant):
                lances.append(plan["id"])
            break  # une à la fois ; les suivantes à la minute d'après
    return lances


# --- Aperçu (ce que montre l'écran) ------------------------------------------------------------------------------------

def _apercu(plan: dict) -> dict:
    """Sauvegardes présentes et place libre ; une panne d'accès devient un message, pas une exception."""
    try:
        stockage = stockage_de(plan)
        return {"sauvegardes": [_sans_etat(f) for f in reversed(lister(stockage, _cache(plan)))], "libre": stockage.libre(),
                "joignable": True, "acces": "", "lu_le": time.time()}
    except (ErreurStockage, OSError) as err:
        return {"sauvegardes": [], "libre": None, "joignable": False, "acces": str(err), "lu_le": time.time()}


def actualiser(plan: dict) -> dict:
    _apercus[plan["id"]] = _apercu(plan)
    return _apercus[plan["id"]]


def _apercu_rapide(plan: dict) -> dict:
    """Un dossier se lit tout de suite ; un stockage distant est relu en arrière-plan (l'écran se met à jour seul)."""
    if not _cache(plan):
        return _apercu(plan)
    connu = _apercus.get(plan["id"])
    if (connu is None or time.time() - connu["lu_le"] > FRAIS) and plan["id"] not in _rafraichis:
        _rafraichis.add(plan["id"])

        def relire() -> None:
            try:
                actualiser(plan)
            finally:
                _rafraichis.discard(plan["id"])
        threading.Thread(target=relire, name=f"apercu-{plan['id']}", daemon=True).start()
    return {**(connu or {"sauvegardes": [], "libre": None, "joignable": True, "acces": "", "lu_le": None}),
            "chargement": plan["id"] in _rafraichis}


# --- Routes ---------------------------------------------------------------------------------------------------------------

class Plan(BaseModel):
    nom: str = Field(min_length=1, max_length=80)
    fournisseur: str = "dossier"
    chemin: str = Field(default="", max_length=500)
    options: dict[str, str] = {}
    secrets_stockage: dict[str, str] = {}
    actif: bool = True
    heure: str = Field(default="03:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    frequence: Literal["jours", "mois"] = "jours"
    jours: str = Field(default="1234567", pattern=r"^[1-7]{1,7}$")
    jour_mois: int = Field(default=1, ge=1, le=31)
    complete: Literal["toujours", "semaine", "mois"] = "semaine"
    complete_jour: int = Field(default=7, ge=1, le=31)
    garder: int = Field(default=4, ge=1, le=365)
    secrets: bool = False

    @field_validator("fournisseur")
    @classmethod
    def fournisseur_connu(cls, v: str) -> str:
        if v not in stockages.FOURNISSEURS:
            raise ValueError("fournisseur inconnu")
        return v

    @field_validator("jours")
    @classmethod
    def jours_uniques(cls, v: str) -> str:
        return "".join(sorted(set(v)))

    @field_validator("complete_jour")
    @classmethod
    def jour_coherent(cls, v: int, info) -> int:
        if info.data.get("complete") == "semaine" and v > 7:
            raise ValueError("jour de la semaine entre 1 et 7")
        return v

    @field_validator("options")
    @classmethod
    def options_courtes(cls, v: dict[str, str]) -> dict[str, str]:
        if any(len(k) > 40 or len(x) > 500 for k, x in v.items()):
            raise ValueError("option trop longue")
        return v

    @field_validator("secrets_stockage")
    @classmethod
    def secrets_connus(cls, v: dict[str, str]) -> dict[str, str]:
        if set(v) - stockages.SECRETS or any(len(x) > 20000 for x in v.values()):
            raise ValueError("secret inconnu ou trop long")
        return v


class Lancement(BaseModel):
    complete: bool = False


class Recuperation(BaseModel):
    archive: str = Field(pattern=r"^poste-\d{8}-\d{6}-(complete|incr)\.tar\.gz$")


def _description(plan: dict) -> str:
    if plan["fournisseur"] == "dossier":
        return plan["chemin"]
    options = json.loads(plan["options"] or "{}")
    lieu = options.get("hote") or options.get("url") or options.get("compartiment") or ""
    lieu = re.sub(r"^https?://", "", lieu).split("/")[0]
    morceaux = [stockages.FOURNISSEURS[plan["fournisseur"]]["nom"], lieu, options.get("partage", ""), plan["chemin"]]
    return " · ".join(m for m in morceaux if m)


def _vue(plan: dict, maintenant: datetime) -> dict:
    apercu = _apercu_rapide(plan)
    options = json.loads(plan.get("options") or "{}")
    vue = {**plan, "options": options, "actif": bool(plan["actif"]), "secrets": bool(plan["secrets"]), "resume": resume(plan),
           "en_cours": plan["id"] in _en_cours, "description": _description(plan),
           "fournisseur_nom": stockages.FOURNISSEURS[plan["fournisseur"]]["nom"],
           "secrets_definis": sorted(c for c in stockages.SECRETS if coffre.defini(f"sauvegarde:{plan['id']}:{c}")),
           **{k: apercu[k] for k in ("sauvegardes", "libre", "joignable", "lu_le")}, "chargement": apercu.get("chargement", False)}
    vue["chiffre"] = "chiffrement" in vue["secrets_definis"]
    if not vue["erreur"] and apercu["acces"]:
        vue["erreur"] = apercu["acces"]
    prochain = prochain_creneau(plan, maintenant) if plan["actif"] else None
    vue["prochaine"] = prochain.isoformat(timespec="minutes") if prochain else None
    if prochain:
        derniere_complete = next((f for f in vue["sauvegardes"] if f["type"] == "complete"), None)
        cycle = debut_du_cycle(plan, prochain)
        vue["prochaine_complete"] = (derniere_complete is None or plan["complete"] == "toujours"
                                     or (cycle is not None and datetime.fromisoformat(derniere_complete["date"]) < cycle))
    return vue


def _ecrire_secrets(ident: int, fournis: dict[str, str]) -> None:
    for cle, valeur in fournis.items():
        if valeur:
            coffre.ecrire(f"sauvegarde:{ident}:{cle}", valeur)


def _effacer_secrets(ident: int) -> None:
    for cle in stockages.SECRETS:
        coffre.effacer(f"sauvegarde:{ident}:{cle}")


def creer_routeur(connecter: Callable[[], sqlite3.Connection], publier: Callable, base: Path) -> APIRouter:
    """`base` : le fichier SQLite de Poste ; son dossier contient les autres données."""
    global _connecter, _publier, _racine_donnees, _base
    _connecter, _publier, _racine_donnees, _base = connecter, publier, base.parent, base
    routeur = APIRouter(prefix="/api/sauvegardes")

    def plan_de(ident: int) -> dict:
        cnx = connecter()
        try:
            ligne = cnx.execute("SELECT * FROM sauvegardes WHERE id=?", (ident,)).fetchone()
        finally:
            cnx.close()
        if ligne is None:
            raise HTTPException(404, "Endroit de sauvegarde inconnu")
        return dict(ligne)

    def controler(p: Plan, ident: int | None = None) -> tuple[str, dict, int | None]:
        """Vérifie l'endroit pour de vrai (dossier, ou connexion avec écriture d'essai) avant d'enregistrer."""
        permises = stockages.options_permises(p.fournisseur) - {"chemin"}
        if set(p.options) - permises:
            raise HTTPException(422, f"Réglage inconnu pour ce stockage : {', '.join(sorted(set(p.options) - permises))}")
        if p.fournisseur == "dossier":
            try:
                return str(verifier_endroit(p.chemin)), {}, None
            except ErreurStockage as err:
                raise HTTPException(422, str(err)) from err
        plan = {"id": ident, "fournisseur": p.fournisseur, "options": p.options, "chemin": p.chemin}
        try:
            stockage = stockage_de(plan, _secrets(ident, p.secrets_stockage))
            stockage.preparer()
            libre = stockage.libre()
        except ErreurStockage as err:
            raise HTTPException(422, str(err)) from err
        return p.chemin.strip(), p.options, libre

    @routeur.get("")
    def liste() -> dict:
        cnx = connecter()
        try:
            plans = _plans(cnx)
        finally:
            cnx.close()
        maintenant = datetime.now()
        return {"endroits": [_vue(p, maintenant) for p in plans], "fournisseurs": stockages.champs_publics(),
                "rclone": shutil.which("rclone") is not None}

    @routeur.post("/tester")
    def tester(p: Plan, ident: int | None = None) -> dict:
        if ident is not None:
            plan_de(ident)
        _, _, libre = controler(p, ident)
        return {"ok": True, "libre": libre}

    @routeur.post("", status_code=201)
    def ajouter(p: Plan) -> dict:
        chemin, options, _ = controler(p)
        cnx = connecter()
        try:
            with cnx:
                # Pas de sauvegarde surprise à l'ajout : la première vient au prochain créneau (ou « Sauvegarder maintenant »).
                ident = cnx.execute(
                    "INSERT INTO sauvegardes (nom, fournisseur, chemin, options, actif, heure, frequence, jours, jour_mois,"
                    " complete, complete_jour, garder, secrets, derniere_tentative) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (p.nom.strip(), p.fournisseur, chemin, json.dumps(options), int(p.actif), p.heure, p.frequence, p.jours,
                     p.jour_mois, p.complete, p.complete_jour, p.garder, int(p.secrets), time.time())).lastrowid
        finally:
            cnx.close()
        _ecrire_secrets(ident, p.secrets_stockage)
        return _vue(plan_de(ident), datetime.now())

    @routeur.put("/{ident}")
    def modifier(ident: int, p: Plan) -> dict:
        ancien = plan_de(ident)
        if ident in _en_cours:
            raise HTTPException(409, "Une sauvegarde est en cours vers cet endroit.")
        if p.fournisseur != ancien["fournisseur"]:
            raise HTTPException(422, "Le type de stockage ne se change pas : ajoute un autre endroit.")
        chemin, options, _ = controler(p, ident)
        cnx = connecter()
        try:
            with cnx:
                cnx.execute(
                    "UPDATE sauvegardes SET nom=?, chemin=?, options=?, actif=?, heure=?, frequence=?, jours=?, jour_mois=?,"
                    " complete=?, complete_jour=?, garder=?, secrets=? WHERE id=?",
                    (p.nom.strip(), chemin, json.dumps(options), int(p.actif), p.heure, p.frequence, p.jours, p.jour_mois,
                     p.complete, p.complete_jour, p.garder, int(p.secrets), ident))
        finally:
            cnx.close()
        _ecrire_secrets(ident, p.secrets_stockage)
        vider_cache(ident)
        return _vue(plan_de(ident), datetime.now())

    @routeur.delete("/{ident}")
    def retirer(ident: int) -> dict:
        plan_de(ident)
        if ident in _en_cours:
            raise HTTPException(409, "Une sauvegarde est en cours vers cet endroit.")
        cnx = connecter()
        try:
            with cnx:
                cnx.execute("DELETE FROM sauvegardes WHERE id=?", (ident,))
        finally:
            cnx.close()
        _effacer_secrets(ident)
        vider_cache(ident)
        return {"ok": True}

    @routeur.post("/{ident}/actualiser")
    def relire(ident: int) -> dict:
        plan = plan_de(ident)
        actualiser(plan)
        return _vue(plan, datetime.now())

    @routeur.post("/{ident}/lancer", status_code=202)
    def maintenant(ident: int, l: Lancement) -> dict:
        plan = plan_de(ident)
        if not lancer(plan, l.complete):
            raise HTTPException(409, "Une sauvegarde est déjà en cours.")
        return {"ok": True}

    @routeur.post("/{ident}/recuperer")
    def recuperer(ident: int, r: Recuperation) -> dict:
        """Remet les Fichiers tels qu'à cette date dans un dossier à part de Fichiers, sans rien écraser."""
        plan = plan_de(ident)
        try:
            moment = datetime.strptime(r.archive[6:21], "%Y%m%d-%H%M%S")
            nom = f"{plan['nom']} du {moment.strftime('%d-%m-%Y %Hh%M')}".replace("/", "-")
            cible = _racine_donnees / "espace" / RESTAURATIONS / nom
            if cible.exists():
                raise ErreurSauvegarde(f"Déjà récupérée : Fichiers › {RESTAURATIONS} › {nom}.")
            nombre = restaurer(stockage_de(plan), r.archive, cible, prefixe="donnees/espace/", cache=_cache(plan))
        except ErreurStockage as err:
            raise HTTPException(422, str(err)) from err
        except (OSError, tarfile.TarError) as err:
            raise HTTPException(422, f"Archive illisible : {err}") from err
        return {"dossier": f"{RESTAURATIONS}/{nom}", "fichiers": nombre}

    return routeur


if __name__ == "__main__":  # Restauration complète à la main, hors de Poste : voir le README.
    import argparse
    analyse = argparse.ArgumentParser(description="Restaure une sauvegarde de Poste dans un dossier vide.")
    analyse.add_argument("endroit", help="dossier poste-sauvegardes, ou numéro d'un endroit réglé dans Poste (cloud, NAS…)")
    analyse.add_argument("archive", nargs="?", help="nom de l'archive (la plus récente de la chaîne voulue) ; absent : la liste")
    analyse.add_argument("cible", type=Path, nargs="?", help="dossier où tout remettre (créé s'il n'existe pas)")
    args = analyse.parse_args()
    if args.endroit.isdigit():
        from .. import db
        from ..config import Config
        config = Config()
        _connecter, _racine_donnees, _base = (lambda: db.connecter(config.base)), config.base.parent, config.base
        coffre.ouvrir(config.base)
        cnx = _connecter()
        ligne = cnx.execute("SELECT * FROM sauvegardes WHERE id=?", (int(args.endroit),)).fetchone()
        cnx.close()
        if ligne is None:
            raise SystemExit("Endroit inconnu (numéro dans Réglages → Sauvegardes, au survol de « Modifier »).")
        source = stockage_de(dict(ligne))
    else:
        source = Dossier(Path(args.endroit))
    if not args.archive:
        for f in lister(source):
            print(f"{f['archive']}  {f['type']:<15} {f.get('taille', 0):>12} octets")
        raise SystemExit(0)
    if args.cible is None or (args.cible.exists() and any(args.cible.iterdir())):
        raise SystemExit("Donne un dossier cible vide.")
    print(f"{restaurer(source, args.archive, args.cible)} éléments remis dans {args.cible}")
