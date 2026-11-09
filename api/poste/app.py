"""Application FastAPI : authentification, accueil et assemblage des modules."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from typing import Iterator

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, coffre, db, reglages, securite
from .config import Config
from . import planificateur
from .modules import agenda, connecteurs, creations, dictee, documents, espace, hermes, sport, mails, notifications, serveur, sites, taches, wopi, ia_bureau, sauvegardes, point_mails


class Identifiants(BaseModel):
    mot_de_passe: str


def creer(config: Config | None = None) -> FastAPI:
    config = config or Config()
    db.initialiser(config.base, [mails.SCHEMA, mails.SCHEMA_BLOCAGE, sport.SCHEMA, documents.SCHEMA, agenda.SCHEMA, taches.SCHEMA,
                                 connecteurs.SCHEMA, coffre.SCHEMA, hermes.SCHEMA, sauvegardes.SCHEMA, sites.SCHEMA])
    # Réglages faits dans l'interface (Réglages, branchements), par-dessus poste.toml.
    connecteurs.charger(lambda: db.connecter(config.base), config.base)
    limiteur = securite.Limiteur()
    jeton_agent = securite.jeton_agent(config.jeton_agent)
    app = FastAPI(title="Poste", version=__version__, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.config = config

    def base() -> Iterator[sqlite3.Connection]:
        cnx = db.connecter(config.base)
        try:
            with cnx:
                yield cnx
        finally:
            cnx.close()

    def connecte(request: Request, cnx: sqlite3.Connection = Depends(base)) -> None:
        if securite.session_valide(cnx, request.cookies.get(securite.COOKIE)):
            return
        if securite.agent_autorise(request.method, request.url.path,
                                   request.headers.get("x-poste-agent"), jeton_agent):
            return
        raise HTTPException(401, "Connexion requise")

    # La politique suit les sites intégrés : recalculée seulement quand leur liste change.
    politique: dict = {}

    def entetes_securite() -> dict[str, str]:
        cle = sites.origines()
        if politique.get("cle") != cle:
            politique.update(cle=cle, entetes=securite.entetes(config.collabora_public, config.drawio_public, cle))
        return politique["entetes"]

    @app.middleware("http")
    async def garde(request: Request, suite):
        if request.headers.get("host") not in config.hotes:
            return JSONResponse({"detail": "Hôte refusé"}, 400)
        # Toute écriture doit venir de nos propres pages (protection CSRF).
        origine = request.headers.get("origin")
        if request.method not in ("GET", "HEAD") and origine and origine not in config.origines:
            return JSONResponse({"detail": "Origine refusée"}, 403)
        reponse = await suite(request)
        for cle, valeur in entetes_securite().items():
            reponse.headers.setdefault(cle, valeur)
        return reponse

    def poser_cookie(reponse: Response, jeton: str) -> None:
        reponse.set_cookie(
            securite.COOKIE, jeton, max_age=config.duree_session_jours * 86400,
            httponly=True, secure=config.cookie_secure, samesite="strict", path="/",
        )

    @app.get("/api/auth/etat")
    def etat_auth(request: Request, cnx: sqlite3.Connection = Depends(base)) -> dict:
        return {
            "initialise": securite.mot_de_passe(cnx) is not None,
            "connecte": securite.session_valide(cnx, request.cookies.get(securite.COOKIE)),
            "version": __version__,
        }

    @app.post("/api/auth/creer")
    def creer_mot_de_passe(corps: Identifiants, reponse: Response,
                           cnx: sqlite3.Connection = Depends(base)) -> dict:
        if securite.mot_de_passe(cnx) is not None:
            raise HTTPException(409, "Le mot de passe existe déjà")
        if len(corps.mot_de_passe) < securite.LONGUEUR_MIN:
            raise HTTPException(422, f"{securite.LONGUEUR_MIN} caractères minimum")
        cnx.execute("INSERT INTO reglages VALUES ('mot_de_passe', ?)",
                    (securite.hacher(corps.mot_de_passe),))
        poser_cookie(reponse, securite.ouvrir_session(cnx, config.duree_session_jours))
        return {"ok": True}

    @app.post("/api/auth/connexion")
    def connexion(corps: Identifiants, reponse: Response,
                  cnx: sqlite3.Connection = Depends(base)) -> dict:
        if limiteur.bloque():
            raise HTTPException(429, "Trop d'essais, réessaie dans 5 minutes")
        stocke = securite.mot_de_passe(cnx)
        if stocke is None or not securite.verifier(corps.mot_de_passe, stocke):
            limiteur.noter()
            raise HTTPException(401, "Mot de passe incorrect")
        limiteur.effacer()
        poser_cookie(reponse, securite.ouvrir_session(cnx, config.duree_session_jours))
        return {"ok": True}

    @app.post("/api/auth/deconnexion")
    def deconnexion(request: Request, reponse: Response,
                    cnx: sqlite3.Connection = Depends(base)) -> dict:
        securite.fermer_session(cnx, request.cookies.get(securite.COOKIE))
        reponse.delete_cookie(securite.COOKIE, path="/")
        return {"ok": True}

    protege = [Depends(connecte)]

    # Module coupé dans poste.toml : ses routes répondent 404, l'interface ne le montre pas.
    def module(nom: str) -> list:
        def garde() -> None:
            if not reglages.actif(nom):
                raise HTTPException(404, "Module désactivé")
        return [Depends(garde)]

    @app.get("/api/modules", dependencies=protege)
    def modules_actifs() -> dict:
        return reglages.modules()

    @app.get("/api/accueil", dependencies=protege)
    def accueil(cnx: sqlite3.Connection = Depends(base)) -> dict:
        journal = cnx.execute(
            "SELECT id, ts, source, titre, detail, lien FROM evenements"
            " ORDER BY ts DESC LIMIT 50"
        ).fetchall()
        maintenant = datetime.now()
        demain = (maintenant + timedelta(days=1)).strftime("%Y-%m-%dT00:00")
        jour = maintenant.strftime("%Y-%m-%dT00:00")
        rdv = [dict(e) for e in cnx.execute(
            "SELECT id, titre, debut, lieu FROM evenements_agenda WHERE debut >= ? AND debut < ? ORDER BY debut",
            (jour, demain),
        )] + [{k: e[k] for k in ("id", "titre", "debut", "lieu", "journee", "source")}
              for e in connecteurs.evenements_entre(cnx, jour, demain) if e["debut"] < demain]
        rdv.sort(key=lambda e: (not e.get("journee"), e["debut"]))
        a_faire = cnx.execute(
            "SELECT id, titre, echeance FROM taches WHERE faite_le IS NULL AND echeance <= ?"
            " ORDER BY echeance LIMIT 20", (maintenant.date().isoformat(),),
        ).fetchall()
        non_lus = cnx.execute(
            "SELECT compte, uid, de, sujet, ts FROM mails WHERE lu=0 AND important=1"
            " ORDER BY ts DESC LIMIT 8"
        ).fetchall()
        return {
            "journal": [dict(e) for e in journal],
            "rdv": rdv,
            "taches": [dict(e) for e in a_faire],
            "mails": [dict(e) for e in non_lus],
            "serveur": serveur.etat(),
            "point": point_mails.pour_accueil(cnx),
        }

    @app.get("/telecharger/poste.apk", dependencies=protege)
    def apk() -> FileResponse:
        chemin = config.base.parent / "poste.apk"
        if not chemin.exists():
            raise HTTPException(404, "APK pas encore construit")
        return FileResponse(chemin, media_type="application/vnd.android.package-archive",
                            filename="poste.apk")

    def publier(source: str, titre: str, detail: str = "", lien: str = "", cle: str | None = None) -> None:
        cnx = db.connecter(config.base)
        try:
            with cnx:
                db.publier(cnx, source, titre, detail, lien, cle)
        finally:
            cnx.close()

    @app.get("/api/notifications/config", dependencies=protege)
    def config_notifications() -> dict:
        return notifications.config_appareil()

    def connecter() -> sqlite3.Connection:
        return db.connecter(config.base)

    app.include_router(serveur.routeur, dependencies=protege)
    app.include_router(dictee.creer_routeur(connecter, config.hotes, config.origines), dependencies=module("dictee"))
    app.include_router(point_mails.creer_routeur(connecter), dependencies=protege)
    app.include_router(mails.creer_routeur(connecter, publier), dependencies=protege)
    app.include_router(connecteurs.creer_routeur(connecter, publier), dependencies=protege)
    app.include_router(sauvegardes.creer_routeur(connecter, publier, config.base), dependencies=protege)
    app.include_router(agenda.creer_routeur(connecter), dependencies=protege)
    app.include_router(taches.creer_routeur(connecter), dependencies=protege)
    app.include_router(sites.creer_routeur(connecter, config.origines), dependencies=protege)
    app.include_router(hermes.creer_routeur(publier, connecter), dependencies=protege + module("hermes"))
    app.include_router(documents.creer_routeur(connecter, config.base.parent / "documents"), dependencies=protege)
    app.include_router(espace.creer_routeur(config.base.parent / "espace", indexer=config.taches_de_fond, drawio=config.drawio_public), dependencies=protege)
    bureau_prive, bureau_public = wopi.creer_routeurs(config.base.parent / "espace", config.collabora_interne, config.wopi_interne, config.origines[0])
    app.include_router(bureau_prive, dependencies=protege + module("collabora"))
    app.include_router(bureau_public, dependencies=module("collabora"))
    ia_relais, ia_page = ia_bureau.creer_routeurs(config.wopi_interne.split("//", 1)[-1])
    app.include_router(ia_relais)
    app.include_router(ia_page, dependencies=protege)
    routeur_creations, lire_fichier = creations.creer_routeur(config.base.parent / "fichiers")
    app.include_router(routeur_creations, dependencies=protege)
    app.get("/api/fichiers/{fid}/{nom}", dependencies=protege)(lire_fichier)
    sport_prive, sport_retour = sport.creer_routeurs(connecter)
    app.include_router(sport_prive, dependencies=protege + module("sport"))
    app.include_router(sport_retour, dependencies=module("sport"))
    if config.taches_de_fond:
        planificateur.demarrer(connecter, publier)
    app.mount("/", StaticFiles(directory=config.web, html=True), name="web")
    return app
