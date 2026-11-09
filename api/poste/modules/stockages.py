"""Où écrire les sauvegardes : un dossier du serveur, ou tout stockage que rclone sait joindre.

Clouds (Google Drive, Dropbox, OneDrive…), kDrive et Nextcloud (WebDAV), NAS Synology et partages Windows/Samba (SMB,
comptes d'annuaire AD/LDAP compris), serveurs SFTP et FTP, stockage objet S3 (Amazon, Backblaze, Wasabi, OVHcloud,
Scaleway, Infomaniak, MinIO, Synology C2), et le reste via une configuration rclone collée telle quelle.

rclone est configuré à chaque appel par variables d'environnement (RCLONE_CONFIG_<NOM>_<CLÉ>) : aucun fichier de
configuration écrit, les mots de passe restent dans le coffre de Poste. Option : chiffrement côté Poste (rclone crypt),
noms de fichiers compris, avant que rien ne parte.
"""
from __future__ import annotations

import configparser
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

# Un champ : (clé, étiquette, genre, défaut, aide). Genres : texte, url, nombre, secret, zone (secret sur plusieurs
# lignes), case, liste:<a>|<b>… Les champs secrets vont au coffre et ne reviennent jamais à l'interface.
CHAMP_CHEMIN_DISTANT = ("chemin", "Dossier dans le stockage (vide : à la racine)", "texte", "Sauvegardes", "")
CHAMP_CHIFFRER = ("chiffrement", "Mot de passe de chiffrement (recommandé)", "secret", "",
                  "Les sauvegardes sont chiffrées avant de partir, noms compris : le fournisseur ne peut rien lire. "
                  "Note ce mot de passe ailleurs : sans lui, personne (ni toi) ne pourra les relire. Vide : pas de chiffrement.")

FOURNISSEURS: dict[str, dict] = {
    "dossier": {
        "nom": "Disque ou dossier du serveur", "type": "dossier",
        "aide": "Un disque externe branché sur le serveur, ou un NAS déjà monté (NFS, SMB) : donne son chemin complet.",
        "champs": [("chemin", "Dossier sur le serveur", "texte", "", "Par exemple /mnt/disque-externe ou /run/media/moi/USB.")],
    },
    "google": {
        "nom": "Google Drive", "type": "drive",
        "aide": "Sur un ordinateur avec un navigateur, installe rclone puis lance : rclone authorize \"drive\". "
                "Connecte-toi à Google, puis colle ici tout ce que la commande affiche (le jeton entre accolades).",
        "champs": [("jeton", "Jeton donné par rclone authorize", "zone", "", ""), CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "kdrive": {
        "nom": "kDrive (Infomaniak)", "type": "webdav", "options": {"vendor": "other"},
        "aide": "Adresse WebDAV de ton kDrive : https://<numéro>.connect.kdrive.infomaniak.com (le numéro est dans l'adresse "
                "de kDrive sur le web). Identifiant : ton adresse e-mail Infomaniak. Avec la double authentification, "
                "crée un mot de passe d'application (Infomaniak, Sécurité).",
        "champs": [("url", "Adresse WebDAV", "url", "https://NUMERO.connect.kdrive.infomaniak.com", ""),
                   ("utilisateur", "Identifiant (e-mail)", "texte", "", ""), ("mot_de_passe", "Mot de passe", "secret", "", ""),
                   CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "synology": {
        "nom": "NAS Synology", "type": "smb",
        "aide": "Par le partage réseau (SMB, activé par défaut dans DSM). Compte DSM, ou compte de l'annuaire si le NAS est "
                "relié à un LDAP ou un Active Directory : mets alors le domaine. Le partage est un dossier partagé "
                "(par exemple « sauvegardes »). SFTP et WebDAV marchent aussi : choisis-les dans la liste.",
        "champs": [("hote", "Adresse du NAS", "texte", "", "Nom ou adresse IP, par exemple 192.168.1.20 ou nas.local."),
                   ("partage", "Dossier partagé", "texte", "", ""),
                   ("utilisateur", "Identifiant", "texte", "", ""), ("mot_de_passe", "Mot de passe", "secret", "", ""),
                   ("domaine", "Domaine (compte d'annuaire LDAP ou AD seulement)", "texte", "", ""),
                   ("port", "Port", "nombre", "445", ""), ("chemin", "Sous-dossier (facultatif)", "texte", "", ""), CHAMP_CHIFFRER],
    },
    "smb": {
        "nom": "Partage réseau Windows, Samba (AD, LDAP)", "type": "smb",
        "aide": "Lecteur réseau d'un serveur Windows, d'un Samba ou d'un NAS. Compte local, ou compte d'annuaire Active "
                "Directory ou Samba relié à un LDAP : mets le domaine (NTLM). Kerberos : seulement si le serveur Poste "
                "a déjà un ticket (kinit).",
        "champs": [("hote", "Serveur", "texte", "", "Nom ou adresse IP."), ("partage", "Partage", "texte", "", "Le nom après \\\\serveur\\"),
                   ("utilisateur", "Identifiant", "texte", "", ""), ("mot_de_passe", "Mot de passe", "secret", "", ""),
                   ("domaine", "Domaine", "texte", "", "Par exemple ENTREPRISE (vide pour un compte local)."),
                   ("kerberos", "Utiliser Kerberos", "case", "", ""), ("port", "Port", "nombre", "445", ""),
                   ("chemin", "Sous-dossier (facultatif)", "texte", "", ""), CHAMP_CHIFFRER],
    },
    "nextcloud": {
        "nom": "Nextcloud, ownCloud", "type": "webdav", "options": {"vendor": "nextcloud"},
        "aide": "Adresse : https://ton-serveur/remote.php/dav/files/IDENTIFIANT. Crée un mot de passe d'application "
                "(Paramètres personnels, Sécurité).",
        "champs": [("url", "Adresse WebDAV", "url", "https://serveur/remote.php/dav/files/IDENTIFIANT", ""),
                   ("utilisateur", "Identifiant", "texte", "", ""), ("mot_de_passe", "Mot de passe d'application", "secret", "", ""),
                   CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "webdav": {
        "nom": "Autre WebDAV", "type": "webdav", "options": {"vendor": "other"},
        "aide": "Tout serveur WebDAV : Synology (WebDAV Server, port 5006 en HTTPS), pCloud, Koofr, Box, SharePoint…",
        "champs": [("url", "Adresse WebDAV", "url", "https://", ""), ("utilisateur", "Identifiant", "texte", "", ""),
                   ("mot_de_passe", "Mot de passe", "secret", "", ""), CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "sftp": {
        "nom": "SFTP (serveur SSH, NAS)", "type": "sftp",
        "aide": "Tout serveur SSH : Linux, Synology (SFTP à activer dans Services de fichiers), QNAP, TrueNAS… "
                "Mot de passe, ou clé privée (format PEM ou OpenSSH).",
        "champs": [("hote", "Serveur", "texte", "", ""), ("port", "Port", "nombre", "22", ""),
                   ("utilisateur", "Identifiant", "texte", "", ""), ("mot_de_passe", "Mot de passe", "secret", "", ""),
                   ("cle_privee", "Ou clé privée", "zone", "", "Colle la clé entière, BEGIN et END compris."),
                   ("chemin", "Dossier sur le serveur", "texte", "sauvegardes", "Relatif au dossier personnel, ou complet (/volume1/sauvegardes)."),
                   CHAMP_CHIFFRER],
    },
    "s3": {
        "nom": "Stockage S3", "type": "s3",
        "aide": "Amazon S3, Backblaze B2, Wasabi, OVHcloud, Scaleway, Infomaniak, MinIO, Synology C2… Le compartiment "
                "(bucket) doit exister. Clés d'accès limitées à ce compartiment de préférence.",
        "champs": [("fournisseur", "Fournisseur", "liste:AWS|Other|Wasabi|Scaleway|Minio|Ceph|IDrive|Synology|Cloudflare", "Other", "Other pour Backblaze, OVHcloud, Infomaniak et les autres."),
                   ("endpoint", "Adresse (endpoint)", "url", "", "Vide pour Amazon. Ex. https://s3.eu-central-003.backblazeb2.com"),
                   ("region", "Région", "texte", "", ""), ("compartiment", "Compartiment (bucket)", "texte", "", ""),
                   ("cle_acces", "Clé d'accès (access key)", "texte", "", ""), ("cle_secrete", "Clé secrète", "secret", "", ""),
                   CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "dropbox": {
        "nom": "Dropbox", "type": "dropbox",
        "aide": "Sur un ordinateur avec un navigateur, installe rclone puis lance : rclone authorize \"dropbox\". "
                "Colle ici le jeton affiché.",
        "champs": [("jeton", "Jeton donné par rclone authorize", "zone", "", ""), CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "onedrive": {
        "nom": "OneDrive, SharePoint", "type": "rclone",
        "aide": "OneDrive demande quelques choix (compte perso ou pro, quel lecteur) : sur un ordinateur avec un navigateur, "
                "lance rclone config, crée un stockage « onedrive », puis colle ici sa section du fichier rclone.conf "
                "(rclone config show <nom>).",
        "champs": [("config_rclone", "Section de rclone.conf", "zone", "", "De [nom] jusqu'à la dernière ligne (type, token, drive_id, drive_type)."),
                   CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "ftp": {
        "nom": "FTP", "type": "ftp",
        "aide": "Serveur FTP, de préférence chiffré (FTPS).",
        "champs": [("hote", "Serveur", "texte", "", ""), ("port", "Port", "nombre", "21", ""),
                   ("utilisateur", "Identifiant", "texte", "", ""), ("mot_de_passe", "Mot de passe", "secret", "", ""),
                   ("tls", "Chiffré (FTPS explicite)", "case", "1", ""), CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
    "rclone": {
        "nom": "Autre service (rclone)", "type": "rclone",
        "aide": "pCloud, Mega, Proton Drive, Jottacloud, Box, Swift, Azure, Google Cloud Storage… plus de 70 services. "
                "Crée le stockage avec rclone config sur un ordinateur, puis colle sa section de rclone.conf.",
        "champs": [("config_rclone", "Section de rclone.conf", "zone", "", ""), CHAMP_CHEMIN_DISTANT, CHAMP_CHIFFRER],
    },
}

TYPES = {"dossier", "drive", "webdav", "smb", "sftp", "s3", "dropbox", "ftp", "rclone"}
SECRETS = {"mot_de_passe", "cle_secrete", "jeton", "cle_privee", "config_rclone", "chiffrement"}
DELAI = 120
DELAI_ENVOI = 6 * 3600


class ErreurStockage(Exception):
    """Message lisible, sans secret, à montrer tel quel."""


def champs_publics() -> dict:
    """Pour l'interface : les fournisseurs et leurs champs."""
    return {k: {"nom": f["nom"], "type": f["type"], "aide": f["aide"],
                "champs": [{"cle": c, "etiquette": e, "genre": g, "defaut": d, "aide": a} for c, e, g, d, a in f["champs"]]}
            for k, f in FOURNISSEURS.items()}


def options_permises(fournisseur: str) -> set[str]:
    return {c[0] for c in FOURNISSEURS[fournisseur]["champs"]} - SECRETS


# --- Dossier du serveur ------------------------------------------------------------------------------------------------

class Dossier:
    """Dossier local : écrit à côté puis renommé, jamais de demi-archive visible."""

    distant = False

    def __init__(self, racine: Path) -> None:
        self.racine = racine

    def preparer(self) -> None:
        self.racine.mkdir(exist_ok=True, mode=0o700)

    def noms(self) -> list[str]:
        return sorted(p.name for p in self.racine.iterdir() if p.is_file()) if self.racine.is_dir() else []

    def lire(self, nom: str) -> bytes:
        return (self.racine / nom).read_bytes()

    def ecrire(self, nom: str, donnees: bytes) -> None:
        cible = self.racine / nom
        cible.with_name(nom + ".partiel").write_bytes(donnees)
        cible.with_name(nom + ".partiel").chmod(0o600)
        cible.with_name(nom + ".partiel").rename(cible)

    def envoyer(self, local: Path, nom: str) -> None:
        partiel = self.racine / f"{nom}.partiel"
        try:
            shutil.copyfile(local, partiel)
            partiel.chmod(0o600)
            partiel.rename(self.racine / nom)
        except OSError:
            partiel.unlink(missing_ok=True)
            raise

    def effacer(self, nom: str) -> None:
        (self.racine / nom).unlink(missing_ok=True)

    def chemin_local(self, nom: str, _tmp: Path) -> Path:
        return self.racine / nom

    def libre(self) -> int | None:
        try:
            return shutil.disk_usage(self.racine if self.racine.exists() else self.racine.parent).free
        except OSError:
            return None


# --- rclone ------------------------------------------------------------------------------------------------------------

def obscurcir(secret: str) -> str:
    """Forme attendue par rclone pour ses mots de passe (pas un chiffrement : juste pas en clair)."""
    r = subprocess.run(["rclone", "obscure", "-"], input=secret, capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise ErreurStockage("rclone obscure a échoué.")
    return r.stdout.strip()


def extraire_jeton(texte: str) -> str:
    """Accepte toute la sortie de rclone authorize : garde le JSON entre accolades."""
    trouve = re.search(r"\{.*\}", texte, re.S)
    if not trouve:
        raise ErreurStockage("Jeton introuvable : colle tout ce que « rclone authorize » a affiché.")
    try:
        jeton = json.loads(trouve.group(0))
    except ValueError as err:
        raise ErreurStockage("Jeton illisible : recopie-le en entier.") from err
    if "access_token" not in jeton and "refresh_token" not in jeton:
        raise ErreurStockage("Ce n'est pas un jeton rclone (access_token absent).")
    return json.dumps(jeton, separators=(",", ":"))


def section_rclone(texte: str) -> dict[str, str]:
    """Une section de rclone.conf collée : [nom] puis clé = valeur. Les mots de passe y sont déjà sous forme rclone."""
    analyse = configparser.ConfigParser(interpolation=None)
    try:
        analyse.read_string(texte if texte.lstrip().startswith("[") else "[distant]\n" + texte)
    except configparser.Error as err:
        raise ErreurStockage("Configuration rclone illisible : colle la section entière, de [nom] à la fin.") from err
    if not analyse.sections():
        raise ErreurStockage("Configuration rclone vide.")
    valeurs = dict(analyse[analyse.sections()[0]])
    if not valeurs.get("type"):
        raise ErreurStockage("La configuration rclone n'a pas de ligne « type = … ».")
    if valeurs["type"] in ("crypt", "alias", "union", "combine", "chunker", "hasher", "compress"):
        raise ErreurStockage("Colle la section du stockage lui-même, pas d'un stockage qui en enveloppe un autre.")
    return valeurs


def _chemin_propre(chemin: str) -> str:
    morceaux = [m for m in chemin.replace("\\", "/").split("/") if m not in ("", ".")]
    if ".." in morceaux:
        raise ErreurStockage("Le dossier ne doit pas contenir « .. ».")
    debut = "/" if chemin.startswith("/") else ""
    return debut + "/".join(morceaux)


def configuration(type_: str, options: dict, secrets: dict) -> tuple[dict[str, str], str]:
    """(paramètres rclone du stockage, chemin dans ce stockage jusqu'au dossier de Poste exclu)."""
    o = {k: str(v).strip() for k, v in options.items() if v is not None}
    s = {k: v for k, v in secrets.items() if v}
    chemin = _chemin_propre(o.get("chemin", ""))

    def exiger(*cles: str, dans: dict = o) -> None:
        manque = [c for c in cles if not dans.get(c)]
        if manque:
            raise ErreurStockage("Champ manquant : " + ", ".join(manque).replace("_", " ") + ".")

    if type_ == "drive" or type_ == "dropbox":
        exiger("jeton", dans=s)
        return {"type": type_, "token": extraire_jeton(s["jeton"]), **({"scope": "drive"} if type_ == "drive" else {})}, chemin
    if type_ == "webdav":
        exiger("url", "utilisateur")
        exiger("mot_de_passe", dans=s)
        if not re.match(r"^https?://[^\s/]+", o["url"]) or "NUMERO" in o["url"] or "IDENTIFIANT" in o["url"]:
            raise ErreurStockage("Adresse WebDAV incomplète : remplace la partie en majuscules par la tienne.")
        return {"type": "webdav", "url": o["url"], "vendor": o.get("vendor", "other"), "user": o["utilisateur"],
                "pass": obscurcir(s["mot_de_passe"])}, chemin
    if type_ == "smb":
        exiger("hote", "partage")
        params = {"type": "smb", "host": o["hote"], "port": o.get("port") or "445"}
        if o.get("kerberos") in ("1", "true", "True"):
            params["use_kerberos"] = "true"
        else:
            exiger("utilisateur")
            exiger("mot_de_passe", dans=s)
            params |= {"user": o["utilisateur"], "pass": obscurcir(s["mot_de_passe"])}
            if o.get("domaine"):
                params["domain"] = o["domaine"]
        partage = _chemin_propre(o["partage"]).strip("/")
        return params, f"{partage}/{chemin.strip('/')}".rstrip("/")
    if type_ == "sftp":
        exiger("hote", "utilisateur")
        params = {"type": "sftp", "host": o["hote"], "port": o.get("port") or "22", "user": o["utilisateur"]}
        if s.get("cle_privee"):
            params["key_pem"] = s["cle_privee"].strip().replace("\r", "").replace("\n", "\\n")
        elif s.get("mot_de_passe"):
            params["pass"] = obscurcir(s["mot_de_passe"])
        else:
            raise ErreurStockage("Il faut un mot de passe ou une clé privée.")
        return params, chemin
    if type_ == "ftp":
        exiger("hote", "utilisateur")
        exiger("mot_de_passe", dans=s)
        params = {"type": "ftp", "host": o["hote"], "port": o.get("port") or "21", "user": o["utilisateur"],
                  "pass": obscurcir(s["mot_de_passe"])}
        if o.get("tls") in ("1", "true", "True"):
            params["explicit_tls"] = "true"
        return params, chemin
    if type_ == "s3":
        exiger("compartiment", "cle_acces")
        exiger("cle_secrete", dans=s)
        params = {"type": "s3", "provider": o.get("fournisseur") or "Other", "access_key_id": o["cle_acces"],
                  "secret_access_key": s["cle_secrete"], "no_check_bucket": "true"}
        if o.get("endpoint"):
            params["endpoint"] = o["endpoint"]
        if o.get("region"):
            params["region"] = o["region"]
        return params, f"{o['compartiment'].strip('/')}/{chemin.strip('/')}".rstrip("/")
    if type_ == "rclone":
        exiger("config_rclone", dans=s)
        return section_rclone(s["config_rclone"]), chemin
    raise ErreurStockage(f"Type de stockage inconnu : {type_}")


# Erreurs de rclone traduites ; sinon sa dernière ligne d'erreur (jamais de secret : rclone ne les affiche pas).
TRADUCTIONS = [
    (r"url field ends in /dav/files", "Adresse Nextcloud incomplète : elle doit finir par /remote.php/dav/files/IDENTIFIANT."),
    (r"NT_STATUS_LOGON_FAILURE|STATUS_LOGON_FAILURE|logon is invalid|bad username|401 Unauthorized|authentication failed|unable to authenticate|"
     r"Login incorrect|530 |InvalidAccessKeyId|SignatureDoesNotMatch|invalid_grant|AccessDenied|403 Forbidden",
     "Identifiants refusés par le stockage (identifiant, mot de passe, clé ou jeton)."),
    (r"no such host|name resolution|server misbehaving", "Serveur introuvable : vérifie l'adresse."),
    (r"connection refused|connectex", "Le serveur refuse la connexion : service arrêté, ou mauvais port."),
    (r"i/o timeout|deadline exceeded|timed out|no route to host|network is unreachable", "Le serveur ne répond pas (réseau, pare-feu)."),
    (r"BAD_NETWORK_NAME|NoSuchBucket|bucket does not exist", "Partage ou compartiment introuvable : vérifie son nom."),
    (r"x509|certificate", "Certificat du serveur refusé (HTTPS)."),
    (r"insufficient storage|quota|507 ", "Stockage plein (quota atteint)."),
]


def _erreur_lisible(sortie: str) -> str:
    for motif, message in TRADUCTIONS:
        if re.search(motif, sortie, re.I):
            return message
    lignes = [l for l in sortie.strip().splitlines() if l.strip()]
    derniere = re.sub(r"^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d (ERROR|NOTICE|CRITICAL) ?:?\s*", "", lignes[-1]) if lignes else "erreur inconnue"
    return f"Le stockage a répondu : {derniere[:300]}"


class Rclone:
    """Tout stockage joignable par rclone ; chiffrement facultatif par une enveloppe crypt."""

    distant = True

    def __init__(self, ident: int | str, params: dict[str, str], chemin: str, chiffrement: str = "",
                 sous_dossier: str = "poste-sauvegardes") -> None:
        nom = f"poste{ident}".upper()
        env = {k: v for k, v in os.environ.items() if not k.startswith("RCLONE_")}
        env["RCLONE_CONFIG"] = os.devnull  # rien sur disque : tout vient des variables ci-dessous
        for cle, valeur in params.items():
            env[f"RCLONE_CONFIG_{nom}_{cle.upper()}"] = str(valeur)
        base = f"{nom.lower()}:{chemin}"
        if chiffrement:
            env[f"RCLONE_CONFIG_{nom}C_TYPE"] = "crypt"
            env[f"RCLONE_CONFIG_{nom}C_REMOTE"] = base
            env[f"RCLONE_CONFIG_{nom}C_PASSWORD"] = obscurcir(chiffrement)
            base = f"{nom.lower()}c:"
        self.env = env
        self.racine = f"{base.rstrip('/')}/{sous_dossier}" if not base.endswith(":") else f"{base}{sous_dossier}"

    def _rclone(self, *args: str, entree: bytes | None = None, delai: int = DELAI) -> bytes:
        try:
            r = subprocess.run(["rclone", "--retries", "2", "--low-level-retries", "3", "--contimeout", "20s",
                                "--timeout", "120s", *args], input=entree, capture_output=True, env=self.env, timeout=delai)
        except FileNotFoundError as err:
            raise ErreurStockage("rclone n'est pas installé sur le serveur (https://rclone.org/install).") from err
        except subprocess.TimeoutExpired as err:
            raise ErreurStockage("Le stockage met trop de temps à répondre.") from err
        if r.returncode:
            raise ErreurStockage(_erreur_lisible(r.stderr.decode(errors="replace")))
        return r.stdout

    def preparer(self) -> None:
        """Crée le dossier et vérifie qu'on peut y écrire, lire et effacer."""
        self._rclone("mkdir", self.racine)
        self._rclone("rcat", f"{self.racine}/.poste-essai", entree=b"ok")
        if self._rclone("cat", f"{self.racine}/.poste-essai") != b"ok":
            raise ErreurStockage("Écriture faite, mais relue différente : stockage peu fiable.")
        self._rclone("deletefile", f"{self.racine}/.poste-essai")

    def noms(self) -> list[str]:
        try:
            sortie = self._rclone("lsf", "--files-only", self.racine)
        except ErreurStockage as err:
            if re.search(r"not found|doesn't exist|does not exist|NoSuchKey", str(err), re.I):
                return []
            raise
        return sorted(l for l in sortie.decode().splitlines() if l)

    def lire(self, nom: str) -> bytes:
        return self._rclone("cat", f"{self.racine}/{nom}")

    def ecrire(self, nom: str, donnees: bytes) -> None:
        self._rclone("rcat", f"{self.racine}/{nom}", entree=donnees)

    def envoyer(self, local: Path, nom: str) -> None:
        self._rclone("copyto", str(local), f"{self.racine}/{nom}", delai=DELAI_ENVOI)

    def effacer(self, nom: str) -> None:
        self._rclone("deletefile", f"{self.racine}/{nom}")

    def chemin_local(self, nom: str, tmp: Path) -> Path:
        cible = tmp / nom
        self._rclone("copyto", f"{self.racine}/{nom}", str(cible), delai=DELAI_ENVOI)
        return cible

    def libre(self) -> int | None:
        try:
            infos = json.loads(self._rclone("about", "--json", self.racine.split(":")[0] + ":", delai=30))
        except (ErreurStockage, ValueError):
            return None
        return infos.get("free")
