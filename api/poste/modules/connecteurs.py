"""Branchements réglés dans l'interface : comptes mail, agendas externes, IA, dictée, notifications, modules.

Les mots de passe, clés et liens secrets vont au coffre (chiffrés) ; aucune route ne les renvoie.
Les agendas externes sont en lecture seule : Poste les recopie toutes les 15 minutes et les montre dans l'Agenda.
Routes réservées à une session humaine : Hermes n'y a pas accès (absentes de leurs listes).
"""
from __future__ import annotations

import imaplib
import json
import logging
import re
import socket
import sqlite3
import ssl
import threading
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Callable
from urllib.parse import urljoin, urlsplit

import httpx
import icalendar
import recurring_ical_events
import x_wr_timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import coffre, reglages

journal = logging.getLogger("poste.connecteurs")

SCHEMA = """
CREATE TABLE IF NOT EXISTS reglages_interface (
    section TEXT NOT NULL,
    cle TEXT NOT NULL,
    valeur TEXT NOT NULL,
    PRIMARY KEY (section, cle)
);
CREATE TABLE IF NOT EXISTS comptes_mail (
    id TEXT PRIMARY KEY,
    nom TEXT NOT NULL,
    adresse TEXT NOT NULL,
    hote TEXT NOT NULL,
    port INTEGER NOT NULL,
    utilisateur TEXT NOT NULL,
    tls_local INTEGER NOT NULL DEFAULT 0,
    cree_le REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agendas (
    id INTEGER PRIMARY KEY,
    nom TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('ics', 'caldav')),
    hote TEXT NOT NULL,
    utilisateur TEXT NOT NULL DEFAULT '',
    synchro_le REAL,
    erreur TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS evenements_externes (
    agenda INTEGER NOT NULL REFERENCES agendas(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    titre TEXT NOT NULL,
    debut TEXT NOT NULL,
    fin TEXT,
    journee INTEGER NOT NULL DEFAULT 0,
    lieu TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS evenements_externes_debut ON evenements_externes (debut);
"""

# Ce que l'interface a le droit de régler ; le reste (adresses publiques des éditeurs, CSP…) reste dans poste.toml.
CLES_REGLABLES = {
    "ia": {"adresse", "modele"},
    "dictee": {"adresse", "modele"},
    "notifications": {"adresse", "sujet", "adresse_publique"},
    "modules": set(reglages.MODULES_DEFAUT),
    "profil": {"prenom"},
    "point_mails": {"actif", "heure", "taille", "accueil"},
    "alertes": {"recevoir", "mails", "hermes_confirmation", "hermes_fin", "agenda", "taches", "serveur", "sauvegardes"},
}

PREREGLAGES_MAIL = {
    "gmail": {"nom": "Gmail", "hote": "imap.gmail.com", "port": 993,
              "aide": "Active la validation en deux étapes, puis crée un mot de passe d'application sur myaccount.google.com/apppasswords. Ton mot de passe habituel ne fonctionne pas ici."},
    "outlook": {"nom": "Outlook, Hotmail", "hote": "outlook.office365.com", "port": 993,
                "aide": "Attention : Microsoft exige maintenant une connexion OAuth pour la plupart des comptes Outlook.com et Microsoft 365, que Poste ne gère pas encore. Un mot de passe d'application peut fonctionner sur certains comptes professionnels ; sinon la connexion sera refusée."},
    "icloud": {"nom": "iCloud", "hote": "imap.mail.me.com", "port": 993,
               "aide": "Crée un mot de passe pour app sur account.apple.com (Connexion et sécurité). Identifiant : ton adresse iCloud."},
    "infomaniak": {"nom": "Infomaniak", "hote": "mail.infomaniak.com", "port": 993,
                   "aide": "Adresse et mot de passe de la boîte, ou un mot de passe d'application si la double authentification est active."},
    "ovh": {"nom": "OVHcloud", "hote": "ssl0.ovh.net", "port": 993, "aide": "Adresse et mot de passe de la boîte."},
    "fastmail": {"nom": "Fastmail", "hote": "imap.fastmail.com", "port": 993,
                 "aide": "Crée un mot de passe d'application (Réglages, Confidentialité et sécurité) avec l'accès IMAP."},
    "autre": {"nom": "Autre serveur IMAP", "hote": "", "port": 993,
              "aide": "Ton hébergeur donne l'adresse du serveur IMAP. Connexion chiffrée (SSL/TLS, port 993 en général) uniquement."},
}

PREREGLAGES_AGENDA = {
    "google": {"nom": "Google Agenda", "type": "ics", "url": "",
               "aide": "Sur ordinateur : Google Agenda, Paramètres, ton agenda, « Adresse secrète au format iCal ». Copie ce lien ici. Lecture seule."},
    "outlook": {"nom": "Outlook", "type": "ics", "url": "",
                "aide": "Outlook.com : Paramètres, Calendrier, Calendriers partagés, « Publier un calendrier », puis copie le lien ICS. Lecture seule."},
    "icloud": {"nom": "iCloud", "type": "caldav", "url": "https://caldav.icloud.com",
               "aide": "Identifiant : ton adresse Apple. Mot de passe : un mot de passe pour app créé sur account.apple.com."},
    "nextcloud": {"nom": "Nextcloud", "type": "caldav", "url": "https://ton-serveur/remote.php/dav",
                  "aide": "Remplace « ton-serveur ». Identifiant Nextcloud, et un mot de passe d'application (Paramètres personnels, Sécurité)."},
    "fastmail": {"nom": "Fastmail", "type": "caldav", "url": "https://caldav.fastmail.com/dav/",
                 "aide": "Mot de passe d'application avec l'accès CalDAV."},
    "ics": {"nom": "Lien iCal", "type": "ics", "url": "", "aide": "N'importe quel lien .ics ou webcal:// (agenda publié, calendrier de vacances, sport…)."},
    "caldav": {"nom": "Autre CalDAV", "type": "caldav", "url": "", "aide": "Adresse du serveur CalDAV, identifiant et mot de passe."},
}

# Fenêtre recopiée : un mois en arrière, un an en avant.
JOURS_PASSES = 31
JOURS_A_VENIR = 366
TAILLE_MAX = 15_000_000
JOURNEE_MAX = 31
OCCURRENCES_MAX = 5000
DELAI = 30
AGENT = {"User-Agent": "Poste (agenda)"}

_connecter: Callable[[], sqlite3.Connection] | None = None
_base = None


class ErreurBranchement(Exception):
    """Message lisible, sans secret, à montrer tel quel."""


# --- Démarrage et réglages simples -------------------------------------------------------------------------------

def charger(connecter: Callable[[], sqlite3.Connection], base) -> None:
    """Ouvre le coffre et pose les réglages faits dans l'interface par-dessus poste.toml."""
    global _connecter, _base
    _connecter, _base = connecter, base
    coffre.ouvrir(base)
    cnx = connecter()
    try:
        lignes = cnx.execute("SELECT section, cle, valeur FROM reglages_interface").fetchall()
    finally:
        cnx.close()
    valeurs: dict[str, dict] = {}
    for section, cle, valeur in lignes:
        valeurs.setdefault(section, {})[cle] = json.loads(valeur)
    reglages.poser_surcharges(valeurs)


def enregistrer(section: str, valeurs: dict) -> None:
    """Une valeur vide efface le réglage de l'interface : poste.toml (ou le défaut) reprend la main."""
    permises = CLES_REGLABLES[section]
    cnx = _connecter()
    try:
        with cnx:
            for cle, valeur in valeurs.items():
                if cle not in permises:
                    raise HTTPException(422, f"Réglage inconnu : {cle}")
                if valeur is None or valeur == "":
                    cnx.execute("DELETE FROM reglages_interface WHERE section=? AND cle=?", (section, cle))
                else:
                    propre = valeur if isinstance(valeur, bool) else str(valeur).strip()
                    cnx.execute("INSERT OR REPLACE INTO reglages_interface VALUES (?,?,?)", (section, cle, json.dumps(propre)))
    finally:
        cnx.close()
    charger(_connecter, _base)


def _adresse_http(valeur: str) -> str:
    valeur = valeur.strip().rstrip("/")
    morceaux = urlsplit(valeur)
    if morceaux.scheme not in ("http", "https") or not morceaux.hostname:
        raise HTTPException(422, "Adresse invalide : elle commence par http:// ou https://")
    return valeur


def _secret(nom: str, valeur: str | None) -> None:
    """None : on garde l'ancien ; vide : on l'efface ; sinon on le remplace."""
    if valeur is None:
        return
    if valeur.strip():
        coffre.ecrire(nom, valeur.strip())
    else:
        coffre.effacer(nom)


# --- Comptes mail --------------------------------------------------------------------------------------------------

def comptes_mail(avec_mot_de_passe: bool = False) -> list[dict]:
    if _connecter is None:
        return []
    cnx = _connecter()
    try:
        lignes = cnx.execute("SELECT * FROM comptes_mail ORDER BY cree_le").fetchall()
    finally:
        cnx.close()
    comptes = []
    for l in lignes:
        c = {"id": l["id"], "adresse": l["adresse"], "hote": l["hote"], "port": l["port"],
             "utilisateur": l["utilisateur"], "tls_local": bool(l["tls_local"])}
        if avec_mot_de_passe:
            mot = coffre.lire(f"mail:{l['id']}")
            if mot is None:
                continue  # clé du coffre perdue : le compte est à rebrancher
            c["mot_de_passe"] = mot
        else:
            c["nom"] = l["nom"]
        comptes.append(c)
    return comptes


def tester_imap(hote: str, port: int, utilisateur: str, mot_de_passe: str, tls_local: bool = False) -> None:
    contexte = ssl.create_default_context()
    if tls_local:
        contexte.check_hostname = False
        contexte.verify_mode = ssl.CERT_NONE
    try:
        boite = imaplib.IMAP4_SSL(hote, port, ssl_context=contexte, timeout=20)
    except ssl.SSLError as err:
        raise ErreurBranchement("Connexion chiffrée refusée : vérifie le serveur et le port (993 en général).") from err
    except (OSError, socket.timeout) as err:
        raise ErreurBranchement(f"Serveur {hote} injoignable sur le port {port}.") from err
    try:
        boite.login(utilisateur, mot_de_passe)
        statut, _ = boite.select("INBOX", readonly=True)
        if statut != "OK":
            raise ErreurBranchement("Connecté, mais la boîte de réception est introuvable.")
    except imaplib.IMAP4.error as err:
        raise ErreurBranchement("Identifiant ou mot de passe refusé par le serveur. Beaucoup de fournisseurs demandent un mot de passe d'application.") from err
    except OSError as err:
        raise ErreurBranchement("La connexion a été coupée par le serveur.") from err
    finally:
        try:
            boite.logout()
        except (imaplib.IMAP4.error, OSError):
            pass


def _identifiant(adresse: str, pris: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", adresse.split("@")[0].lower()).strip("-")[:30] or "boite"
    ident, n = base, 2
    while ident in pris:
        ident, n = f"{base}-{n}", n + 1
    return ident


# --- Agendas externes ----------------------------------------------------------------------------------------------

def _local(valeur) -> tuple[str, bool]:
    """Heure locale de la machine, comme les rendez-vous de Poste ; une date seule = toute la journée."""
    if isinstance(valeur, datetime):
        if valeur.tzinfo:
            valeur = valeur.astimezone().replace(tzinfo=None)
        return valeur.strftime("%Y-%m-%dT%H:%M"), False
    if isinstance(valeur, date):
        return f"{valeur.isoformat()}T00:00", True
    raise ValueError("date illisible")


def _texte(composant, cle: str, limite: int) -> str:
    return str(composant.get(cle, "") or "").strip()[:limite]


def _occurrences(calendrier, du: datetime, au: datetime) -> list:
    """Occurrences dans l'ordre, arrêtées à la fin de la fenêtre ou au plafond : une répétition « chaque seconde »
    d'un agenda piégé ne fait pas développer des millions d'événements au serveur."""
    sortie = []
    for o in recurring_ical_events.of(calendrier).after(du):
        debut = o["DTSTART"].dt
        borne = au if isinstance(debut, datetime) else au.date()
        if isinstance(debut, datetime) and debut.tzinfo is None:
            borne = au.replace(tzinfo=None)
        if debut > borne or len(sortie) >= OCCURRENCES_MAX:
            break
        sortie.append(o)
    return sortie


def evenements_ical(calendriers: list[bytes], du: datetime, au: datetime) -> list[dict]:
    """Toutes les occurrences entre du et au, répétitions développées. Un événement illisible est ignoré, pas fatal."""
    sortie = []
    for brut in calendriers:
        try:
            calendrier = x_wr_timezone.to_standard(icalendar.Calendar.from_ical(brut))
            occurrences = _occurrences(calendrier, du, au)
        except (ValueError, KeyError, TypeError, AttributeError) as err:
            raise ErreurBranchement("Cet agenda n'est pas un fichier iCal lisible.") from err
        for o in occurrences:
            try:
                if o.name != "VEVENT" or str(o.get("STATUS", "")).upper() == "CANCELLED":
                    continue
                debut, journee = _local(o["DTSTART"].dt)
                fin_brute = o.get("DTEND")
                fin = _local(fin_brute.dt)[0] if fin_brute is not None else None
            except (KeyError, ValueError, AttributeError, TypeError):
                continue
            commun = {"uid": _texte(o, "UID", 300), "titre": _texte(o, "SUMMARY", 300) or "(sans titre)",
                      "lieu": _texte(o, "LOCATION", 300), "notes": _texte(o, "DESCRIPTION", 5000)}
            if journee:
                # Plusieurs jours : une ligne par jour, pour que l'événement paraisse chaque jour qu'il couvre.
                premier = date.fromisoformat(debut[:10])
                dernier = date.fromisoformat(fin[:10]) - timedelta(days=1) if fin else premier
                for n in range(min((dernier - premier).days, JOURNEE_MAX - 1) + 1):
                    jour = (premier + timedelta(days=n)).isoformat()
                    sortie.append({**commun, "debut": f"{jour}T00:00", "fin": None, "journee": 1})
            else:
                sortie.append({**commun, "debut": debut, "fin": fin if fin and fin >= debut else None, "journee": 0})
    return sortie


def _lien_ics(url: str) -> str:
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[9:]
    morceaux = urlsplit(url)
    if morceaux.scheme not in ("http", "https") or not morceaux.hostname:
        raise ErreurBranchement("Lien invalide : il commence par https://, http:// ou webcal://.")
    return url


def _lire_borne(client: httpx.Client, methode: str, url: str, **kw) -> tuple[httpx.Response, bytes]:
    with client.stream(methode, url, **kw) as r:
        morceaux, taille = [], 0
        for m in r.iter_bytes():
            taille += len(m)
            if taille > TAILLE_MAX:
                raise ErreurBranchement("Agenda trop gros (plus de 15 Mo).")
            morceaux.append(m)
    return r, b"".join(morceaux)


def _client(utilisateur: str = "", mot_de_passe: str = "") -> httpx.Client:
    auth = (utilisateur, mot_de_passe) if utilisateur else None
    return httpx.Client(auth=auth, follow_redirects=True, timeout=DELAI, headers=AGENT)


def _verifier_reponse(r: httpx.Response) -> None:
    if r.status_code in (401, 403):
        raise ErreurBranchement("Identifiant ou mot de passe refusé (ou lien qui n'est plus valable).")
    if r.status_code == 404:
        raise ErreurBranchement("Rien à cette adresse (404).")
    if r.status_code >= 400:
        raise ErreurBranchement(f"Le serveur a répondu {r.status_code}.")


def lire_ics(url: str, utilisateur: str = "", mot_de_passe: str = "") -> list[bytes]:
    try:
        with _client(utilisateur, mot_de_passe) as client:
            r, corps = _lire_borne(client, "GET", _lien_ics(url))
    except httpx.HTTPError as err:
        raise ErreurBranchement("Agenda injoignable : vérifie le lien.") from err
    _verifier_reponse(r)
    if b"BEGIN:VCALENDAR" not in corps[:4096]:
        raise ErreurBranchement("Ce lien ne renvoie pas un agenda iCal (.ics).")
    return [corps]


DAV = "{DAV:}"
CAL = "{urn:ietf:params:xml:ns:caldav}"
PROPFIND = ('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:prop><d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/>'
            '<c:supported-calendar-component-set/></d:prop></d:propfind>')


def _multistatus(r: httpx.Response, corps: bytes) -> list[tuple[str, ET.Element]]:
    """(adresse absolue, prop) pour chaque réponse 200 d'un multistatus WebDAV."""
    _verifier_reponse(r)
    try:
        racine = ET.fromstring(corps)
    except ET.ParseError as err:
        raise ErreurBranchement("Ce serveur ne répond pas comme un serveur CalDAV.") from err
    sortie = []
    for reponse in racine.iter(f"{DAV}response"):
        href = reponse.findtext(f"{DAV}href", "").strip()
        for propstat in reponse.iter(f"{DAV}propstat"):
            if " 200 " in (propstat.findtext(f"{DAV}status", "") + " ") and (prop := propstat.find(f"{DAV}prop")) is not None:
                sortie.append((urljoin(str(r.url), href), prop))
    return sortie


def _propfind(client: httpx.Client, url: str, profondeur: str) -> list[tuple[str, ET.Element]]:
    r, corps = _lire_borne(client, "PROPFIND", url, content=PROPFIND,
                           headers={"Depth": profondeur, "Content-Type": "application/xml; charset=utf-8"})
    return _multistatus(r, corps)


def _href(prop: ET.Element, balise: str, base: str) -> str | None:
    noeud = prop.find(f"{balise}/{DAV}href")
    return urljoin(base, noeud.text.strip()) if noeud is not None and noeud.text else None


def _est_agenda(prop: ET.Element) -> bool:
    if prop.find(f"{DAV}resourcetype/{CAL}calendar") is None:
        return False
    composants = [c.get("name") for c in prop.iter(f"{CAL}comp")]
    return not composants or "VEVENT" in composants


def calendriers_caldav(client: httpx.Client, url: str) -> list[str]:
    """Adresse d'un agenda, d'un compte ou du serveur : on descend jusqu'aux agendas qui portent des événements."""
    try:
        reponses = _propfind(client, url, "0")
    except ErreurBranchement:
        if urlsplit(url).path.strip("/"):
            raise
        reponses = _propfind(client, urljoin(url, "/.well-known/caldav"), "0")
    if not reponses:
        raise ErreurBranchement("Ce serveur ne répond pas comme un serveur CalDAV.")
    adresse, prop = reponses[0]
    if _est_agenda(prop):
        return [adresse]
    maison = _href(prop, f"{CAL}calendar-home-set", adresse)
    if not maison and (principal := _href(prop, f"{DAV}current-user-principal", adresse)):
        for a, p in _propfind(client, principal, "0"):
            maison = _href(p, f"{CAL}calendar-home-set", a) or maison
    if not maison:
        raise ErreurBranchement("Connecté, mais aucun agenda trouvé à cette adresse.")
    agendas = [a for a, p in _propfind(client, maison, "1") if _est_agenda(p)]
    if not agendas:
        raise ErreurBranchement("Connecté, mais ce compte n'a aucun agenda.")
    return agendas


def _requete_periode(du: datetime, au: datetime) -> str:
    f = "%Y%m%dT%H%M%SZ"
    return ('<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
            f'<c:time-range start="{du.strftime(f)}" end="{au.strftime(f)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')


def lire_caldav(url: str, utilisateur: str, mot_de_passe: str, du: datetime, au: datetime) -> list[bytes]:
    try:
        with _client(utilisateur, mot_de_passe) as client:
            calendriers = []
            for agenda in calendriers_caldav(client, _adresse_dav(url)):
                r, corps = _lire_borne(client, "REPORT", agenda, content=_requete_periode(du, au),
                                       headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
                for _, prop in _multistatus(r, corps):
                    donnees = prop.findtext(f"{CAL}calendar-data")
                    if donnees and "BEGIN:VCALENDAR" in donnees:
                        calendriers.append(donnees.encode())
    except httpx.HTTPError as err:
        raise ErreurBranchement("Serveur CalDAV injoignable : vérifie l'adresse.") from err
    return calendriers


def _adresse_dav(url: str) -> str:
    morceaux = urlsplit(url.strip())
    if morceaux.scheme not in ("http", "https") or not morceaux.hostname:
        raise ErreurBranchement("Adresse invalide : elle commence par https://.")
    return url.strip()


def lire_agenda(type_: str, url: str, utilisateur: str, mot_de_passe: str) -> list[dict]:
    maintenant = datetime.now().astimezone()
    du, au = maintenant - timedelta(days=JOURS_PASSES), maintenant + timedelta(days=JOURS_A_VENIR)
    if type_ == "ics":
        bruts = lire_ics(url, utilisateur, mot_de_passe)
    else:
        bruts = lire_caldav(url, utilisateur, mot_de_passe, du.astimezone(timezone.utc), au.astimezone(timezone.utc))
    return evenements_ical(bruts, du, au)


def synchroniser_agenda(agenda_id: int) -> int:
    """Lit l'agenda puis remplace sa copie locale d'un bloc. En cas d'échec, l'ancienne copie reste et l'erreur s'affiche."""
    cnx = _connecter()
    try:
        ligne = cnx.execute("SELECT * FROM agendas WHERE id=?", (agenda_id,)).fetchone()
    finally:
        cnx.close()
    if not ligne:
        raise HTTPException(404, "Agenda inconnu")
    try:
        url = coffre.lire(f"agenda:{agenda_id}:url")
        if url is None:
            raise ErreurBranchement("Lien perdu (clé du coffre changée) : supprime puis rebranche cet agenda.")
        evenements = lire_agenda(ligne["type"], url, ligne["utilisateur"], coffre.lire(f"agenda:{agenda_id}:mdp") or "")
    except ErreurBranchement as err:
        cnx = _connecter()
        try:
            with cnx:
                cnx.execute("UPDATE agendas SET erreur=? WHERE id=?", (str(err), agenda_id))
        finally:
            cnx.close()
        raise
    cnx = _connecter()
    try:
        with cnx:
            cnx.execute("DELETE FROM evenements_externes WHERE agenda=?", (agenda_id,))
            cnx.executemany("INSERT INTO evenements_externes (agenda, uid, titre, debut, fin, journee, lieu, notes)"
                            " VALUES (:agenda, :uid, :titre, :debut, :fin, :journee, :lieu, :notes)",
                            [{**e, "agenda": agenda_id} for e in evenements])
            cnx.execute("UPDATE agendas SET synchro_le=?, erreur='' WHERE id=?", (time.time(), agenda_id))
    finally:
        cnx.close()
    return len(evenements)


def synchroniser_agendas() -> dict:
    """Tâche de fond : un agenda en panne n'empêche pas les autres."""
    if _connecter is None:
        return {}
    cnx = _connecter()
    try:
        ids = [l[0] for l in cnx.execute("SELECT id FROM agendas")]
    finally:
        cnx.close()
    bilan = {}
    for ident in ids:
        try:
            bilan[ident] = synchroniser_agenda(ident)
        except ErreurBranchement as err:
            journal.warning("Agenda %s : %s", ident, err)
            bilan[ident] = str(err)
    return bilan


def evenements_entre(cnx: sqlite3.Connection, du: str, au: str | None) -> list[dict]:
    """Pour l'Agenda et l'Accueil : événements des agendas branchés, marqués « externe »."""
    lignes = cnx.execute(
        "SELECT e.rowid AS n, e.*, a.nom AS source FROM evenements_externes e JOIN agendas a ON a.id = e.agenda"
        " WHERE e.debut >= ? AND (? IS NULL OR e.debut <= ?) ORDER BY e.debut LIMIT 500", (du, au, au)).fetchall()
    return [{"id": f"x{l['n']}", "externe": True, "agenda": l["agenda"], "source": l["source"], "titre": l["titre"],
             "debut": l["debut"], "fin": l["fin"], "journee": bool(l["journee"]), "lieu": l["lieu"], "notes": l["notes"]}
            for l in lignes]


# --- Routes --------------------------------------------------------------------------------------------------------

class NouveauCompte(BaseModel):
    nom: str = Field(default="", max_length=60)
    adresse: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    hote: str = Field(min_length=3, max_length=255, pattern=r"^[A-Za-z0-9.-]+$")
    port: int = Field(default=993, ge=1, le=65535)
    utilisateur: str = Field(default="", max_length=320)
    mot_de_passe: str = Field(min_length=1, max_length=500)


class NouvelAgenda(BaseModel):
    nom: str = Field(min_length=1, max_length=60)
    type: str = Field(pattern=r"^(ics|caldav)$")
    url: str = Field(min_length=8, max_length=2000)
    utilisateur: str = Field(default="", max_length=320)
    mot_de_passe: str = Field(default="", max_length=500)


class ReglageIA(BaseModel):
    adresse: str = Field(default="", max_length=500)
    modele: str = Field(default="", max_length=300)
    cle: str | None = Field(default=None, max_length=500)


class ReglageDictee(BaseModel):
    actif: bool | None = None
    adresse: str = Field(default="", max_length=500)
    modele: str = Field(default="", max_length=300)


class ReglageNotifications(BaseModel):
    actif: bool | None = None
    adresse: str = Field(default="", max_length=500)
    sujet: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    adresse_publique: str = Field(default="", max_length=500)
    jeton: str | None = Field(default=None, max_length=500)


class Profil(BaseModel):
    prenom: str = Field(default="", max_length=60)


def _refus(err: ErreurBranchement) -> HTTPException:
    return HTTPException(422, str(err))


def etat() -> dict:
    from . import mails  # import tardif : mails dépend de ce module
    branches = {c["id"] for c in comptes_mail()}
    origine = [{"id": c.id, "nom": c.adresse, "adresse": c.adresse, "hote": c.hote, "port": c.port, "origine": "fichier"}
               for c in mails.charger_comptes() if c.id not in branches]
    cnx = _connecter()
    try:
        agendas = [dict(l) for l in cnx.execute(
            "SELECT a.id, a.nom, a.type, a.hote, a.utilisateur, a.synchro_le, a.erreur,"
            " (SELECT COUNT(*) FROM evenements_externes e WHERE e.agenda = a.id) AS evenements FROM agendas a ORDER BY a.id")]
    finally:
        cnx.close()
    from . import dictee, ia, notifications
    return {
        "comptes": [{**c, "origine": "interface"} for c in comptes_mail()] + origine,
        "agendas": agendas,
        "ia": {"adresse": ia.adresse(), "modele": reglages.lire("ia", "modele", ""), "cle": coffre.defini(ia.SECRET_CLE)},
        "dictee": {"actif": reglages.actif("dictee"), "adresse": dictee.adresse(), "modele": reglages.lire("dictee", "modele", "")},
        "notifications": {"actif": reglages.actif("notifications"), "adresse": notifications.adresse(), "sujet": notifications.sujet(),
                          "adresse_publique": reglages.lire("notifications", "adresse_publique", ""),
                          "jeton": coffre.defini(notifications.SECRET_JETON)},
        "modules": reglages.modules(),
        "profil": {"prenom": reglages.prenom()},
        "prereglages": {"mails": PREREGLAGES_MAIL, "agendas": PREREGLAGES_AGENDA},
    }


def creer_routeur(connecter: Callable[[], sqlite3.Connection], publier: Callable) -> APIRouter:
    routeur = APIRouter(prefix="/api/connecteurs", tags=["connecteurs"])

    @routeur.get("")
    def lire_etat() -> dict:
        return etat()

    @routeur.post("/mails", status_code=201)
    def ajouter_compte(c: NouveauCompte) -> dict:
        from . import mails
        utilisateur = c.utilisateur.strip() or c.adresse.strip()
        try:
            tester_imap(c.hote.strip(), c.port, utilisateur, c.mot_de_passe)
        except ErreurBranchement as err:
            raise _refus(err) from err
        ident = _identifiant(c.adresse, {x.id for x in mails.charger_comptes()})
        coffre.ecrire(f"mail:{ident}", c.mot_de_passe)
        cnx = connecter()
        try:
            with cnx:
                cnx.execute("INSERT INTO comptes_mail VALUES (?,?,?,?,?,?,0,?)",
                            (ident, c.nom.strip() or c.adresse.strip(), c.adresse.strip().lower(), c.hote.strip().lower(), c.port,
                             utilisateur, time.time()))
        finally:
            cnx.close()
        # Première lecture tout de suite, en fond : la page Mails se remplit sans attendre la prochaine synchro.
        threading.Thread(target=lambda: mails.synchroniser_tout(connecter, publier), daemon=True).start()
        return {"id": ident}

    @routeur.delete("/mails/{ident}")
    def retirer_compte(ident: str) -> dict:
        cnx = connecter()
        try:
            with cnx:
                retire = cnx.execute("DELETE FROM comptes_mail WHERE id=?", (ident,)).rowcount
                if retire:
                    cnx.execute("DELETE FROM mails WHERE compte=?", (ident,))
        finally:
            cnx.close()
        if not retire:
            raise HTTPException(404, "Compte inconnu, ou défini dans les fichiers de configuration")
        coffre.effacer(f"mail:{ident}")
        return {"ok": True}

    @routeur.post("/agendas", status_code=201)
    def ajouter_agenda(a: NouvelAgenda) -> dict:
        try:
            nombre = len(lire_agenda(a.type, a.url, a.utilisateur.strip(), a.mot_de_passe))
        except ErreurBranchement as err:
            raise _refus(err) from err
        url = _lien_ics(a.url) if a.type == "ics" else a.url.strip()
        cnx = connecter()
        try:
            with cnx:
                ident = cnx.execute("INSERT INTO agendas (nom, type, hote, utilisateur) VALUES (?,?,?,?)",
                                    (a.nom.strip(), a.type, urlsplit(url).hostname or "", a.utilisateur.strip())).lastrowid
        finally:
            cnx.close()
        coffre.ecrire(f"agenda:{ident}:url", url)
        if a.mot_de_passe:
            coffre.ecrire(f"agenda:{ident}:mdp", a.mot_de_passe)
        try:
            nombre = synchroniser_agenda(ident)
        except ErreurBranchement as err:
            raise _refus(err) from err
        return {"id": ident, "evenements": nombre}

    @routeur.post("/agendas/{ident}/actualiser")
    def actualiser_agenda(ident: int) -> dict:
        try:
            return {"evenements": synchroniser_agenda(ident)}
        except ErreurBranchement as err:
            raise _refus(err) from err

    @routeur.delete("/agendas/{ident}")
    def retirer_agenda(ident: int) -> dict:
        cnx = connecter()
        try:
            with cnx:
                cnx.execute("DELETE FROM evenements_externes WHERE agenda=?", (ident,))
                retire = cnx.execute("DELETE FROM agendas WHERE id=?", (ident,)).rowcount
        finally:
            cnx.close()
        if not retire:
            raise HTTPException(404, "Agenda inconnu")
        coffre.effacer(f"agenda:{ident}:url")
        coffre.effacer(f"agenda:{ident}:mdp")
        return {"ok": True}

    @routeur.put("/ia")
    def regler_ia(r: ReglageIA) -> dict:
        from . import ia
        enregistrer("ia", {"adresse": _adresse_http(r.adresse) if r.adresse.strip() else "", "modele": r.modele})
        _secret(ia.SECRET_CLE, r.cle)
        return etat()["ia"]

    @routeur.post("/ia/tester")
    def tester_ia() -> dict:
        from . import ia
        try:
            liste = ia.modeles()
        except httpx.HTTPStatusError as err:
            code = err.response.status_code
            raise HTTPException(422, "Clé d'API refusée." if code in (401, 403) else f"Le service a répondu {code}.") from err
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as err:
            raise HTTPException(422, f"Aucun service compatible OpenAI ne répond à {ia.adresse()}.") from err
        if not liste:
            raise HTTPException(422, "Le service répond, mais n'a aucun modèle chargé.")
        return {"modeles": liste[:200]}

    @routeur.put("/dictee")
    def regler_dictee(r: ReglageDictee) -> dict:
        enregistrer("dictee", {"adresse": _adresse_http(r.adresse) if r.adresse.strip() else "", "modele": r.modele})
        if r.actif is not None:
            enregistrer("modules", {"dictee": r.actif})
        return etat()["dictee"]

    @routeur.post("/dictee/tester")
    def tester_dictee() -> dict:
        from . import dictee
        try:
            dictee.moteur_pret()
        except HTTPException as err:
            raise HTTPException(422, f"Aucun service de transcription prêt à {dictee.adresse()}.") from err
        return {"ok": True}

    @routeur.put("/notifications")
    def regler_notifications(r: ReglageNotifications) -> dict:
        from . import notifications
        enregistrer("notifications", {
            "adresse": _adresse_http(r.adresse) if r.adresse.strip() else "", "sujet": r.sujet,
            "adresse_publique": _adresse_http(r.adresse_publique) if r.adresse_publique.strip() else "",
        })
        _secret(notifications.SECRET_JETON, r.jeton)
        if r.actif is not None:
            enregistrer("modules", {"notifications": r.actif})
        return etat()["notifications"]

    @routeur.post("/notifications/tester")
    def tester_notifications() -> dict:
        from . import notifications
        if not reglages.actif("notifications"):
            raise HTTPException(422, "Active d'abord les notifications.")
        if not notifications.envoyer("Poste", "Notification d'essai : tout est branché.", lien="/#reglages"):
            raise HTTPException(422, f"ntfy ne répond pas à {notifications.adresse()}, ou refuse le jeton.")
        return {"ok": True}

    @routeur.get("/alertes")
    def alertes() -> dict:
        from . import notifications
        return notifications.preferences()

    @routeur.put("/alertes")
    def regler_alertes(valeurs: dict[str, bool]) -> dict:
        from . import notifications
        enregistrer("alertes", valeurs)
        return notifications.preferences()

    @routeur.put("/profil")
    def regler_profil(r: Profil) -> dict:
        enregistrer("profil", {"prenom": r.prenom})
        return {"prenom": reglages.prenom()}

    @routeur.put("/modules")
    def regler_modules(valeurs: dict[str, bool]) -> dict:
        enregistrer("modules", valeurs)
        return reglages.modules()

    return routeur
