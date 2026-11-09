# Référence des réglages

[English](CONFIGURATION.md) · **Français**

Poste lit ses réglages à trois endroits, dans cet ordre de priorité :

1. **L'interface** (Réglages) : boîtes mail, agendas, IA, dictée, notifications, modules, prénom, point du matin, alertes, sauvegardes et sites intégrés. Ces choix sont gardés dans la base et passent avant le fichier.
2. **Les variables d'environnement** `POSTE_*` (pratiques avec Docker, voir `.env.example`).
3. **`poste.toml`** : `~/.config/poste/poste.toml`, ou le chemin donné par `POSTE_CONFIG`. Le modèle commenté est [`poste.exemple.toml`](../poste.exemple.toml).

Tout est facultatif. Sans fichier, Poste démarre avec Mails, Agenda, Tâches, Fichiers et Serveur.

## Fichiers et dossiers

| Quoi | Par défaut (sans Docker) | Avec Docker |
|---|---|---|
| Fichier de réglages | `~/.config/poste/poste.toml` | `./config/poste.toml` |
| Clé qui chiffre les mots de passe enregistrés | `~/.config/poste/cle-secrets` (créée au premier démarrage) | `./config/cle-secrets` |
| Jeton local de l'assistant | `~/.config/poste/jeton-agent` (créé au premier démarrage) | `./config/jeton-agent` |
| Base de données | `~/.local/share/poste/poste.db` | volume `poste-donnees`, `/data/poste.db` |
| Espace Fichiers, pièces jointes, créations | à côté de la base : `espace/`, `documents/`, `fichiers/` | même volume |
| Index de recherche | à côté de la base : `espace-index.db` | même volume |

Sauvegarde le dossier des réglages : sans `cle-secrets`, les mots de passe enregistrés ne se déchiffrent plus et sont à ressaisir.

## Variables d'environnement

| Variable | Par défaut | Rôle |
|---|---|---|
| `POSTE_CONFIG` | `~/.config/poste/poste.toml` | Chemin du fichier de réglages. |
| `POSTE_BASE` | `~/.local/share/poste/poste.db` | Base SQLite ; les dossiers de données sont créés à côté. |
| `POSTE_CLE` | `[serveur] cle_secrets` | Clé qui chiffre les mots de passe et jetons enregistrés. |
| `POSTE_HOTES` | `127.0.0.1:8541,localhost:8541` | Noms d'hôte acceptés (avec le port), séparés par des virgules. Ajoute ton adresse HTTPS. |
| `POSTE_ORIGINES` | `http://127.0.0.1:8541` | Origines autorisées pour les requêtes du navigateur, séparées par des virgules. |
| `POSTE_COOKIE_SECURE` | `1` | Cookie de session réservé au HTTPS. `0` seulement pour essayer en HTTP simple depuis une autre machine du réseau local. |
| `POSTE_JETON_AGENT` | `~/.config/poste/jeton-agent` | Jeton local avec lequel l'assistant appelle Poste. |
| `POSTE_URL_IA` | `[ia] adresse` | Adresse du service d'IA compatible OpenAI. |
| `POSTE_COLLABORA_PUBLIC` | `[collabora] adresse_publique` | Adresse de Collabora vue par le navigateur. |
| `POSTE_COLLABORA_INTERNE` | `http://127.0.0.1:9980` | Adresse de Collabora vue par Poste. |
| `POSTE_WOPI_INTERNE` | `http://127.0.0.1:8541` | Adresse de Poste vue par Collabora (WOPI). |
| `POSTE_DRAWIO_PUBLIC` | `[drawio] adresse_publique` | Adresse de draw.io vue par le navigateur. |
| `POSTE_TACHES_DE_FOND` | `1` | `0` coupe les tâches de fond (synchro, rappels, sauvegardes). Utilisé par les tests. |

Docker Compose seulement (`.env`) : `POSTE_PORT` (8541), `NTFY_PORT` (8546), `DRAWIO_PORT` (8543), `TZ` (`Europe/Paris`).

## Ports

| Service | Port | Remarque |
|---|---|---|
| Poste | 8541 | écoute sur 127.0.0.1 ; à publier par un proxy HTTPS |
| ntfy (profil Compose `ntfy`) | 8546 | notifications sur le téléphone |
| draw.io (profil Compose `drawio`) | 8543 | éditeur de diagrammes |
| Collabora Online | 9980 | installé à part |
| Passerelle Hermes Agent | 8643 | installée à part |
| IA (Ollama) | 11434 | ou tout service compatible OpenAI |
| Dictée | 8085 | tout service de transcription compatible OpenAI |

## `poste.toml`, section par section

### `[serveur]`

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse_publique` | `http://127.0.0.1:8541` | Adresse par laquelle on ouvre Poste (navigateur, application Android, retour de Strava). |
| `hotes` | `["127.0.0.1:8541", "localhost:8541"]` | Noms d'hôte acceptés. `POSTE_HOTES` passe avant. |
| `origines` | `["http://127.0.0.1:8541"]` | Origines autorisées. `POSTE_ORIGINES` passe avant. |
| `services_critiques` | `[]` | Unités systemd dont l'arrêt envoie une notification. |
| `cle_secrets` | `~/.config/poste/cle-secrets` | Fichier de la clé de chiffrement. `POSTE_CLE` passe avant. |

`[serveur.services]` : unités systemd affichées dans la page Serveur, sous la forme `unite = "Libellé"`.
`[serveur.disques]` : disques affichés dans la page Serveur, sous la forme `"Libellé" = "/point/de/montage"`. Par défaut : `"Système" = "/"`.

### `[modules]`

`true` ou `false` pour chaque module. Coupé, un module disparaît de l'interface et ses routes répondent 404. Se règle aussi dans Réglages.

| Clé | Par défaut | Module |
|---|---|---|
| `mails`, `agenda`, `taches`, `fichiers`, `serveur` | `true` | modules de base |
| `hermes` | `false` | assistant (voir `[hermes]`) |
| `dictee` | `false` | dictée vocale (voir `[dictee]`) |
| `notifications` | `false` | notifications ntfy (voir `[notifications]`) |
| `collabora` | `false` | Word, Excel, PowerPoint dans le navigateur (voir `[collabora]`) |
| `drawio` | `false` | diagrammes (voir `[drawio]`) |
| `sport` | `false` | activités Strava, en lecture |
| `blocage_mailcow` | `false` | blocage d'expéditeurs sur un serveur Mailcow (voir `[blocage_mailcow]`) |

### `[profil]`

| Clé | Par défaut | Rôle |
|---|---|---|
| `prenom` | vide | Ton prénom : la salutation de l'accueil, et la signature des brouillons rédigés par l'IA. Aussi dans Réglages. |

### `[ia]` : moteur d'IA

N'importe quel service compatible OpenAI (`/v1/models`, `/v1/chat/completions`). La clé d'API, si besoin, se saisit dans Réglages et reste chiffrée.

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse` | `http://127.0.0.1:11434` | Adresse du service. |
| `modele` | vide | Nom du modèle ; vide : le premier proposé par le service. |

Facultatif, **bascule entre plusieurs modèles** d'un moteur local lancé comme service systemd (l'en-tête de l'assistant propose alors le choix) :

| Clé | Rôle |
|---|---|
| `service_systemd` | Unité systemd utilisateur du moteur, redémarrée à chaque bascule. |
| `fichier_modele` | Fichier écrit à chaque bascule et lu par le moteur au démarrage (par défaut `~/.config/poste/modele.conf`). |
| `modele_defaut` | Clé du choix par défaut. |
| `service_remplacant` | Unité qui remplace parfois le moteur (un modèle plus léger, par exemple) ; tant qu'elle tourne, le moteur n'est pas annoncé arrêté. |
| `[ia.modeles.<cle>]` | Une table par choix : `nom` (libellé), `modele` (dossier ou nom du modèle), `vision = true` s'il lit les images, `environnement = { VAR = "valeur" }` pour les variables du moteur. |

### `[mails]`

Les boîtes se branchent dans Réglages (Gmail, Outlook, iCloud, Infomaniak, OVHcloud, Fastmail, tout serveur IMAP).

| Clé | Par défaut | Rôle |
|---|---|---|
| `domaines_interdits` | `[]` | Domaines vers lesquels Poste ne prépare jamais de brouillon. |

### `[point_mails]` : point du matin

Aussi dans Réglages → Point des mails.

| Clé | Par défaut | Rôle |
|---|---|---|
| `actif` | `true` | Envoyer le point sur le téléphone chaque matin. |
| `heure` | `"07:30"` | Heure du point du matin. |
| `taille` | `"moyen"` | `petit` (la phrase clé), `moyen` (+ urgents et importants), `grand` (tout). |
| `accueil` | `true` | L'afficher en haut de l'accueil. |

### `[alertes]` : types de notifications

Aussi dans Réglages → Notifications. `recevoir = false` coupe tout ; chaque type se coupe à part : `mails`, `hermes_confirmation`, `hermes_fin`, `agenda`, `taches`, `serveur`, `sauvegardes` (tous à `true` par défaut).

### `[notifications]` : ntfy

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse` | `http://127.0.0.1:8546` | Serveur ntfy vu par Poste (`https://ntfy.sh` convient aussi). |
| `sujet` | `poste` | Sujet. Sur ntfy.sh, les sujets sont publics : prends un nom difficile à deviner. |
| `adresse_publique` | comme `adresse` | Serveur ntfy vu par le téléphone, s'il diffère. |
| `jeton` | `~/.config/poste/ntfy-jeton` | Fichier qui contient le jeton d'accès (ou le saisir dans Réglages). |

### `[dictee]` : dictée

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse` | `http://127.0.0.1:8085` | Service de transcription compatible OpenAI (`/v1/audio/transcriptions`). Sert aussi à transcrire les pièces jointes audio. |
| `modele` | vide | Nom du modèle, pour les services qui en demandent un. |

### `[hermes]` : assistant

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse` | `http://127.0.0.1:8643` | Serveur d'API de la passerelle Hermes Agent. |
| `profil` | `~/.hermes/profiles/poste` | Dossier du profil Hermes ; Poste lit `API_SERVER_KEY` dans son `.env`, et tient `model.supports_vision` de son `config.yaml` à jour selon le modèle choisi. |

Le navigateur ne parle jamais directement à Hermes et ne voit jamais sa clé.

### `[collabora]` : Word, Excel, PowerPoint

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse_publique` | vide | Adresse de Collabora vue par le navigateur. |
| `adresse_interne` | `http://127.0.0.1:9980` | Adresse de Collabora vue par Poste. |
| `adresse_wopi` | `http://127.0.0.1:8541` | Adresse de Poste vue par Collabora. |

### `[drawio]` : diagrammes

| Clé | Par défaut | Rôle |
|---|---|---|
| `adresse_publique` | vide | Adresse de draw.io vue par le navigateur (profil Compose `drawio` : `http://localhost:8543`). |

### `[blocage_mailcow]`

| Clé | Par défaut | Rôle |
|---|---|---|
| `identifiants` | `~/.config/poste/mailcow.env` | Fichier avec `MAILCOW_URL=` et `MAILCOW_API_KEY=`. |
| `domaine` | vide | Ton domaine de messagerie sur le serveur Mailcow. |

### `[creations]` : outils de création de documents (avancé)

| Clé | Par défaut | Rôle |
|---|---|---|
| `outils` | `~/.config/poste/outils` | Dossier d'outils de création au format des outils Open WebUI (Word, Excel, PowerPoint, schémas…), utilisés par l'assistant. |
| `service_pdf` | vide | Service de rendu PDF facultatif. |

### `[android]`

| Clé | Par défaut | Rôle |
|---|---|---|
| `identifiant` | `app.poste` | Nom du paquet Android utilisé par `deploiement/construire-apk.sh`. L'application ouvre `[serveur] adresse_publique` (HTTPS obligatoire). |

## Sites intégrés

Réglages → Sites intégrés. Jusqu'à 20 sites, chacun avec un nom et une adresse `http(s)` sans identifiant. L'adresse de Poste lui-même est refusée, car le cadre aurait alors la main sur Poste. L'origine de chaque site est ajoutée à `frame-src` dans la politique de sécurité tant que le site existe. Un site qui envoie `X-Frame-Options` ou un `frame-ancestors` restrictif ne peut pas s'afficher dans un cadre ; il s'ouvre dans un onglet.
