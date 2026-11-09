"""Détection de spam et d'hameçonnage : des indices notés, expliqués en français. Ne décide rien à la place de l'utilisateur."""
from __future__ import annotations

import ipaddress
import re
from email.utils import getaddresses
from html.parser import HTMLParser
from urllib.parse import urlsplit

SEUIL_DOUTEUX = 3.0
SEUIL_DANGEREUX = 6.0

MARQUES = {
    "amazon": "amazon", "ameli": "ameli", "apple": "apple", "banque postale": "labanquepostale", "bnp": "bnp", "caf": "caf",
    "chronopost": "chronopost", "colissimo": "laposte", "credit agricole": "credit-agricole", "crédit agricole": "credit-agricole",
    "dhl": "dhl", "docusign": "docusign", "dropbox": "dropbox", "edf": "edf", "facebook": "facebook", "fedex": "fedex",
    "france travail": "francetravail", "free": "free", "google": "google", "impots": "impots", "impôts": "impots",
    "instagram": "instagram", "la poste": "laposte", "lcl": "lcl", "linkedin": "linkedin", "microsoft": "microsoft",
    "netflix": "netflix", "orange": "orange", "ovh": "ovh", "paypal": "paypal", "sfr": "sfr", "societe generale": "societegenerale",
    "société générale": "societegenerale", "stripe": "stripe", "ups": "ups", "whatsapp": "whatsapp",
    "cloudflare": "cloudflare", "leboncoin": "leboncoin", "vinted": "vinted", "steam": "steampowered", "binance": "binance",
    "coinbase": "coinbase", "revolut": "revolut", "boursorama": "boursorama", "qonto": "qonto", "adobe": "adobe",
    "spotify": "spotify", "airbnb": "airbnb", "booking": "booking", "doctolib": "doctolib", "antai": "antai", "sncf": "sncf",
    "bouygues": "bouyguestelecom", "infomaniak": "infomaniak", "gandi": "gandi", "ionos": "ionos", "shopify": "shopify",
}
PRESSION = re.compile(
    r"compte (?:a été |est |sera )?(?:suspendu|bloqué|fermé|limité|désactivé)|vérifi(?:ez|er) votre (?:compte|identité)|"
    r"confirm(?:ez|er) vos (?:informations|coordonnées|identifiants)|mot de passe (?:expire|a expiré)|action (?:immédiate|requise)|"
    r"dernier (?:rappel|avis)|sous (?:24|48) ?h|contravention|amende|majoration|poursuites?|huissier|colis (?:bloqué|en attente|retenu)|"
    r"frais de (?:livraison|douane)|remboursement en attente|paiement (?:en attente|refusé|échoué)|facture impayée|"
    r"carte (?:bancaire )?(?:expir|bloqu)|verify your account|account (?:suspended|locked)|urgent", re.I)
PROMESSE = re.compile(r"vous avez gagné|félicitations|gagnant|héritage|investissement garanti|crypto.{0,20}(?:gain|profit)|bitcoin|"
                      r"revenus? passifs?|prêt sans|casino|viagra", re.I)
RACCOURCIS = {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rebrand.ly", "shorturl.at"}
TLD_RISQUE = {"zip", "mov", "top", "xyz", "click", "icu", "tk", "ml", "ga", "cf", "gq", "buzz", "cam", "rest", "sbs", "monster", "cyou"}
PJ_DANGER = {"exe", "scr", "js", "jse", "vbs", "vbe", "bat", "cmd", "com", "jar", "iso", "img", "lnk", "hta", "ps1", "msi", "wsf",
             "htm", "html", "svg", "docm", "xlsm", "pptm", "dotm", "xlam", "cab", "chm", "reg"}
FICHIERS = {"png", "jpg", "jpeg", "gif", "pdf", "doc", "docx", "xls", "xlsx", "zip", "txt", "csv"}
SUFFIXES_DOUBLES = {"co.uk", "com.fr", "gouv.fr", "asso.fr", "org.uk", "com.au", "co.jp", "com.br"}


def domaine_racine(hote: str) -> str:
    """exemple.fr pour www.news.exemple.fr (assez juste pour comparer deux adresses, sans liste publique complète)."""
    morceaux = hote.lower().strip(".").split(".")
    if len(morceaux) >= 3 and ".".join(morceaux[-2:]) in SUFFIXES_DOUBLES:
        return ".".join(morceaux[-3:])
    return ".".join(morceaux[-2:])


class _Liens(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.liens: list[tuple[str, str]] = []
        self._href: str | None = None
        self._texte: list[str] = []

    def handle_starttag(self, balise, attributs):
        if balise == "a":
            self._href = dict(attributs).get("href")
            self._texte = []

    def handle_data(self, donnees):
        if self._href is not None:
            self._texte.append(donnees)

    def handle_endtag(self, balise):
        if balise == "a" and self._href is not None:
            self.liens.append((self._href, "".join(self._texte).strip()))
            self._href = None


def extraire_liens(contenu_html: str) -> list[tuple[str, str]]:
    lecteur = _Liens()
    try:
        lecteur.feed(contenu_html)
    except (ValueError, AssertionError):
        pass
    return lecteur.liens


def _hote(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _analyser_liens(liens: list[tuple[str, str]], dom_racine: str) -> list[tuple[float, str]]:
    indices: dict[str, tuple[float, str]] = {}
    for url, texte in liens[:300]:
        if not url.lower().startswith(("http://", "https://")):
            continue
        hote = _hote(url)
        if not hote:
            continue
        racine = domaine_racine(hote)
        montre = re.match(r"^(?:https?://)?((?:[\w-]+\.)+[a-z]{2,})(?:[/?#\s]|$)", texte, re.I)
        fichier = montre and montre[1].rsplit(".", 1)[-1].lower() in FICHIERS
        if montre and not fichier and domaine_racine(montre[1]) not in (racine, dom_racine):
            indices["trompeur"] = (2.5, f"un lien affiche {montre[1]} mais mène vers {hote}")
        try:
            ipaddress.ip_address(hote)
            indices["ip"] = (3, f"un lien pointe vers une adresse IP ({hote})")
        except ValueError:
            pass
        if "xn--" in hote:
            indices["puny"] = (3, f"un lien utilise un nom imitant d'autres caractères ({hote})")
        if racine in RACCOURCIS:
            indices["court"] = (1, f"un lien est masqué par un raccourcisseur ({racine})")
        if hote.rsplit(".", 1)[-1] in TLD_RISQUE and racine != dom_racine:
            indices["tld"] = (1.5, f"un lien mène vers une extension souvent abusée ({hote})")
        for officiel in set(MARQUES.values()):
            # La marque doit être le nom du domaine, ou son extension propre (link.amazon).
            legitime = officiel in racine.replace("-", "")
            if racine != dom_racine and officiel in hote.replace("-", "") and not legitime:
                indices["imitation"] = (3, f"un lien imite {officiel} sans être son site ({hote})")
    return list(indices.values())


def analyser(msg, *, liens: list[tuple[str, str]] | None = None, texte: str = "", pieces: list[str] | None = None) -> dict:
    """Sans corps (synchro : entêtes seuls), seuls les indices d'entête comptent. Plus le score est haut, plus c'est suspect."""
    indices: list[tuple[float, str]] = []
    nom, adresse = (getaddresses([str(msg.get("From", ""))]) or [("", "")])[0]
    dom = adresse.lower().rsplit("@", 1)[-1]
    racine = domaine_racine(dom) if "." in dom else dom
    nom_bas = nom.lower()

    # Le premier en-tête est celui ajouté par NOTRE fournisseur : les suivants peuvent être forgés par l'expéditeur.
    auth = str(msg.get("Authentication-Results", "")).lower()
    resultat = {t: (m[1] if (m := re.search(rf"\b{t}=(\w+)", auth)) else None) for t in ("spf", "dkim", "dmarc")}
    if resultat["dmarc"] == "fail":
        indices.append((4, "l'expéditeur échoue au contrôle DMARC : son adresse peut être falsifiée"))
    if resultat["dkim"] == "fail":
        indices.append((1.5, "la signature DKIM du mail est invalide"))
    if resultat["spf"] in ("fail", "softfail"):
        indices.append((1.5, "le serveur d'envoi n'est pas autorisé par ce domaine (SPF)"))
    if resultat["dmarc"] == "pass" and resultat["dkim"] == "pass":
        indices.append((-2, ""))

    for marque, officiel in MARQUES.items():
        if re.search(rf"(?<!\w){re.escape(marque)}(?!\w)", nom_bas) and officiel not in racine.replace("-", ""):
            indices.append((4, f"se présente comme « {nom} » mais écrit depuis {dom}"))
            break
    autre = re.search(r"[\w.+-]+@([\w-]+\.[\w.-]+)", nom)
    if autre and domaine_racine(autre[1]) != racine:
        indices.append((3, f"le nom affiché contient une autre adresse ({autre[0]}) que la vraie ({adresse})"))
    if "xn--" in dom:
        indices.append((3, f"le domaine de l'expéditeur imite d'autres caractères ({dom})"))
    if racine.rsplit(".", 1)[-1] in TLD_RISQUE:
        indices.append((1, f"l'expéditeur utilise une extension souvent abusée ({dom})"))

    reponses = [a.lower() for _, a in getaddresses([str(msg.get("Reply-To", ""))]) if a]
    if reponses and domaine_racine(reponses[0].rsplit("@", 1)[-1]) != racine:
        indices.append((1.5, f"les réponses partiraient vers {reponses[0]}, pas vers l'expéditeur"))

    drapeau = f"{msg.get('X-Spam-Flag', '')} {msg.get('X-Spam', '')} {str(msg.get('X-Spam-Status', ''))[:4]}".lower()
    if "yes" in drapeau or "true" in drapeau:
        indices.append((3, "ton fournisseur de mail l'a déjà marqué comme spam"))

    sujet = str(msg.get("Subject", ""))
    pression = {m.lower() for m in PRESSION.findall(f"{sujet}\n{texte[:20000]}")}
    if pression:
        indices.append((min(1 + len(pression) * 0.5, 3), f"le message met la pression ({', '.join(sorted(pression)[:3])})"))
    if PROMESSE.search(f"{sujet}\n{texte[:20000]}"):
        indices.append((2, "le message promet un gain ou une affaire trop belle"))

    for piece in pieces or []:
        nom_pj = piece.lower().strip()
        extensions = nom_pj.rsplit("/", 1)[-1].split(".")[1:]
        if extensions and extensions[-1] in PJ_DANGER:
            indices.append((4, f"la pièce jointe {piece} peut exécuter du code ou imiter une page"))
        elif len(extensions) >= 2 and extensions[-2] in {"pdf", "doc", "docx", "xls", "xlsx", "jpg", "png"}:
            indices.append((3, f"la pièce jointe {piece} a une double extension"))

    indices += _analyser_liens(liens or [], racine)
    score = round(sum(p for p, _ in indices), 1)
    # Une liste de diffusion authentifiée reste une lettre d'info : elle ne devient pas suspecte pour autant.
    niveau = "dangereux" if score >= SEUIL_DANGEREUX else "douteux" if score >= SEUIL_DOUTEUX else "sain"
    raisons = [r for p, r in sorted(indices, key=lambda i: -i[0]) if r and p > 0]
    return {"niveau": niveau, "score": score, "raisons": raisons}
