# Configuration reference

**English** · [Français](CONFIGURATION.fr.md)

Poste reads its settings from three places, in this order of priority:

1. **The interface** (Réglages / Settings): mailboxes, calendars, AI, dictation, notifications, modules, first name, morning summary, alerts, backups and embedded sites. These choices are stored in the database and override the file.
2. **Environment variables** `POSTE_*` (handy with Docker, see `.env.example`).
3. **`poste.toml`**: `~/.config/poste/poste.toml`, or the path given in `POSTE_CONFIG`. The annotated example is [`poste.exemple.toml`](../poste.exemple.toml).

Everything is optional. With no file, Poste starts with Mail, Calendar, Tasks, Files and Server.

## Files and folders

| What | Default (without Docker) | With Docker |
|---|---|---|
| Settings file | `~/.config/poste/poste.toml` | `./config/poste.toml` |
| Key that encrypts saved passwords | `~/.config/poste/cle-secrets` (created on first start) | `./config/cle-secrets` |
| Local token for the assistant | `~/.config/poste/jeton-agent` (created on first start) | `./config/jeton-agent` |
| Database | `~/.local/share/poste/poste.db` | volume `poste-donnees`, `/data/poste.db` |
| Files space, attachments, created files | next to the database: `espace/`, `documents/`, `fichiers/` | same volume |
| Search index | next to the database: `espace-index.db` | same volume |

Back up the settings folder: without `cle-secrets`, saved passwords cannot be decrypted and have to be entered again.

## Environment variables

| Variable | Default | Role |
|---|---|---|
| `POSTE_CONFIG` | `~/.config/poste/poste.toml` | Path of the settings file. |
| `POSTE_BASE` | `~/.local/share/poste/poste.db` | SQLite database; data folders are created next to it. |
| `POSTE_CLE` | `[serveur] cle_secrets` | Key that encrypts saved passwords and tokens. |
| `POSTE_HOTES` | `127.0.0.1:8541,localhost:8541` | Accepted host names (with port), comma-separated. Add your HTTPS address. |
| `POSTE_ORIGINES` | `http://127.0.0.1:8541` | Allowed origins for browser requests, comma-separated. |
| `POSTE_COOKIE_SECURE` | `1` | Session cookie restricted to HTTPS. Set `0` only to try plain HTTP from another machine on the local network. |
| `POSTE_JETON_AGENT` | `~/.config/poste/jeton-agent` | Local token the assistant uses to call Poste. |
| `POSTE_URL_IA` | `[ia] adresse` | Address of the OpenAI-compatible AI service. |
| `POSTE_COLLABORA_PUBLIC` | `[collabora] adresse_publique` | Collabora address as seen by the browser. |
| `POSTE_COLLABORA_INTERNE` | `http://127.0.0.1:9980` | Collabora address as seen by Poste. |
| `POSTE_WOPI_INTERNE` | `http://127.0.0.1:8541` | Poste address as seen by Collabora (WOPI). |
| `POSTE_DRAWIO_PUBLIC` | `[drawio] adresse_publique` | draw.io address as seen by the browser. |
| `POSTE_TACHES_DE_FOND` | `1` | `0` turns off background jobs (sync, reminders, backups). Used by tests. |

Docker Compose only (`.env`): `POSTE_PORT` (8541), `NTFY_PORT` (8546), `DRAWIO_PORT` (8543), `TZ` (`Europe/Paris`).

## Ports

| Service | Port | Note |
|---|---|---|
| Poste | 8541 | listens on 127.0.0.1; publish it through an HTTPS proxy |
| ntfy (Compose profile `ntfy`) | 8546 | phone notifications |
| draw.io (Compose profile `drawio`) | 8543 | diagram editor |
| Collabora Online | 9980 | installed separately |
| Hermes Agent gateway | 8643 | installed separately |
| AI (Ollama) | 11434 | or any OpenAI-compatible service |
| Dictation | 8085 | any OpenAI-compatible transcription service |

## `poste.toml`, section by section

### `[serveur]`

| Key | Default | Role |
|---|---|---|
| `adresse_publique` | `http://127.0.0.1:8541` | Address used to open Poste (browser, Android app, Strava return link). |
| `hotes` | `["127.0.0.1:8541", "localhost:8541"]` | Accepted host names. `POSTE_HOTES` wins. |
| `origines` | `["http://127.0.0.1:8541"]` | Allowed origins. `POSTE_ORIGINES` wins. |
| `services_critiques` | `[]` | systemd units whose stop sends a notification. |
| `cle_secrets` | `~/.config/poste/cle-secrets` | Encryption key file. `POSTE_CLE` wins. |

`[serveur.services]`: systemd units shown on the Server page, as `unit = "Label"`.
`[serveur.disques]`: disks shown on the Server page, as `"Label" = "/mount/point"`. Default: `"Système" = "/"`.

### `[modules]`

`true` or `false` for each module. A switched-off module disappears from the interface and its routes answer 404. Also adjustable in Settings.

| Key | Default | Module |
|---|---|---|
| `mails`, `agenda`, `taches`, `fichiers`, `serveur` | `true` | core modules |
| `hermes` | `false` | assistant (see `[hermes]`) |
| `dictee` | `false` | voice dictation (see `[dictee]`) |
| `notifications` | `false` | ntfy notifications (see `[notifications]`) |
| `collabora` | `false` | Word, Excel, PowerPoint in the browser (see `[collabora]`) |
| `drawio` | `false` | diagrams (see `[drawio]`) |
| `sport` | `false` | Strava activities, read-only |
| `blocage_mailcow` | `false` | sender blocking on a Mailcow server (see `[blocage_mailcow]`) |

### `[profil]`

| Key | Default | Role |
|---|---|---|
| `prenom` | empty | Your first name: the home greeting, and the signature of AI reply drafts. Also in Settings. |

### `[ia]`: AI engine

Any OpenAI-compatible service (`/v1/models`, `/v1/chat/completions`). The API key, if needed, is entered in Settings and stored encrypted.

| Key | Default | Role |
|---|---|---|
| `adresse` | `http://127.0.0.1:11434` | Address of the service. |
| `modele` | empty | Model name; empty means the first model offered by the service. |

Optional, **switching between several models** of a local engine run as a systemd service (the assistant's header then offers the choice):

| Key | Role |
|---|---|
| `service_systemd` | systemd user unit of the engine, restarted on a switch. |
| `fichier_modele` | drop-in file written on a switch and read by the engine at start-up (default `~/.config/poste/modele.conf`). |
| `modele_defaut` | key of the default choice. |
| `service_remplacant` | unit that sometimes replaces the engine (a lighter model, for example); while it runs, the engine is not reported as stopped. |
| `[ia.modeles.<key>]` | one table per choice: `nom` (label), `modele` (folder or model name), `vision = true` if it reads images, `environnement = { VAR = "value" }` for engine variables. |

### `[mails]`

Mailboxes are connected in Settings (Gmail, Outlook, iCloud, Infomaniak, OVHcloud, Fastmail, any IMAP server).

| Key | Default | Role |
|---|---|---|
| `domaines_interdits` | `[]` | Domains for which Poste never prepares a draft. |

### `[point_mails]`: morning summary

Also in Settings → Point des mails.

| Key | Default | Role |
|---|---|---|
| `actif` | `true` | Send the summary to the phone every morning. |
| `heure` | `"07:30"` | Time of the morning summary. |
| `taille` | `"moyen"` | `petit` (the headline), `moyen` (+ urgent and important), `grand` (everything). |
| `accueil` | `true` | Show it at the top of the home page. |

### `[alertes]`: notification types

Also in Settings → Notifications. `recevoir = false` turns everything off; each type can be turned off on its own: `mails`, `hermes_confirmation`, `hermes_fin`, `agenda`, `taches`, `serveur`, `sauvegardes` (all `true` by default).

### `[notifications]`: ntfy

| Key | Default | Role |
|---|---|---|
| `adresse` | `http://127.0.0.1:8546` | ntfy server as seen by Poste (`https://ntfy.sh` works too). |
| `sujet` | `poste` | Topic. On ntfy.sh, topics are public: pick a hard-to-guess name. |
| `adresse_publique` | same as `adresse` | ntfy server as seen by the phone, if different. |
| `jeton` | `~/.config/poste/ntfy-jeton` | File holding the access token (or enter it in Settings). |

### `[dictee]`: dictation

| Key | Default | Role |
|---|---|---|
| `adresse` | `http://127.0.0.1:8085` | OpenAI-compatible transcription service (`/v1/audio/transcriptions`). Also used to transcribe audio attachments. |
| `modele` | empty | Model name, for services that require one. |

### `[hermes]`: assistant

| Key | Default | Role |
|---|---|---|
| `adresse` | `http://127.0.0.1:8643` | API server of the Hermes Agent gateway. |
| `profil` | `~/.hermes/profiles/poste` | Hermes profile folder; Poste reads `API_SERVER_KEY` from its `.env`, and keeps `model.supports_vision` in its `config.yaml` in step with the chosen model. |

The browser never talks to Hermes directly and never sees its key.

### `[collabora]`: Word, Excel, PowerPoint

| Key | Default | Role |
|---|---|---|
| `adresse_publique` | empty | Collabora address as seen by the browser. |
| `adresse_interne` | `http://127.0.0.1:9980` | Collabora address as seen by Poste. |
| `adresse_wopi` | `http://127.0.0.1:8541` | Poste address as seen by Collabora. |

### `[drawio]`: diagrams

| Key | Default | Role |
|---|---|---|
| `adresse_publique` | empty | draw.io address as seen by the browser (Compose profile `drawio`: `http://localhost:8543`). |

### `[blocage_mailcow]`

| Key | Default | Role |
|---|---|---|
| `identifiants` | `~/.config/poste/mailcow.env` | File with `MAILCOW_URL=` and `MAILCOW_API_KEY=`. |
| `domaine` | empty | Your mail domain on the Mailcow server. |

### `[creations]`: document creation tools (advanced)

| Key | Default | Role |
|---|---|---|
| `outils` | `~/.config/poste/outils` | Folder of creation tools in the Open WebUI tool format (Word, Excel, PowerPoint, diagrams…), used by the assistant. |
| `service_pdf` | empty | Optional PDF rendering service. |

### `[android]`

| Key | Default | Role |
|---|---|---|
| `identifiant` | `app.poste` | Android package name used by `deploiement/construire-apk.sh`. The app opens `[serveur] adresse_publique` (HTTPS required). |

## Embedded sites

Settings → Sites intégrés. Up to 20 sites, each with a name and an `http(s)` address without credentials. Poste's own address is refused, because the frame would then control Poste. Each site's origin is added to `frame-src` in the content security policy while the site exists. Sites that send `X-Frame-Options` or a restrictive `frame-ancestors` cannot be shown in a frame; they open in a new tab.
