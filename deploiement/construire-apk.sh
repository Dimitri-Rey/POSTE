#!/usr/bin/env bash
# Construit l'APK signé de l'enveloppe Android et le dépose là où Poste le sert (/telecharger/poste.apk).
# L'application ouvre l'adresse publique de Poste : [serveur] adresse_publique dans poste.toml (HTTPS obligatoire).
# Identifiant du paquet : [android] identifiant dans poste.toml (défaut app.poste). Clé de signature créée au
# premier passage dans ~/.config/poste. Il faut le JDK 21 et le SDK Android (JAVA_HOME, ANDROID_HOME).
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$(ls -d ~/.local/opt/jdk-21* 2>/dev/null | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
CONF=~/.config/poste
DEST="${POSTE_APK_DEST:-$HOME/.local/share/poste}"

# Adresse et identifiant lus dans les réglages (POSTE_CONFIG ou ~/.config/poste/poste.toml).
read -r URL IDENTIFIANT < <(python3 - <<'EOF'
import os, sys, tomllib
from pathlib import Path
chemin = Path(os.environ.get("POSTE_CONFIG", Path.home() / ".config/poste/poste.toml")).expanduser()
conf = tomllib.loads(chemin.read_text()) if chemin.exists() else {}
url = conf.get("serveur", {}).get("adresse_publique", "")
ident = conf.get("android", {}).get("identifiant", "app.poste")
if not url.startswith("https://"):
    sys.exit(f"Indique l'adresse HTTPS de Poste : [serveur] adresse_publique dans {chemin}")
print(url.rstrip("/"), ident)
EOF
)

# Configuration Capacitor produite ici, jamais suivie par git : elle porte ton adresse.
cat > capacitor.config.json <<EOF
{
  "appId": "$IDENTIFIANT",
  "appName": "Poste",
  "webDir": "web",
  "server": { "url": "$URL", "cleartext": false, "errorPath": "horsligne.html" },
  "android": { "allowMixedContent": false, "backgroundColor": "#14110d" }
}
EOF

if [ ! -f "$CONF/signature.properties" ]; then
  mkdir -p "$CONF"; chmod 700 "$CONF"
  MDP="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  keytool -genkeypair -keystore "$CONF/poste.keystore" -storepass "$MDP" -keypass "$MDP" \
    -alias poste -keyalg RSA -keysize 4096 -validity 20000 -dname "CN=Poste" 2>/dev/null
  ( umask 077; printf 'storeFile=%s\nmotDePasse=%s\n' "$CONF/poste.keystore" "$MDP" > "$CONF/signature.properties" )
fi
VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' api/poste/__init__.py)"
CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
npx cap sync android >/dev/null
( cd android && ./gradlew -q --no-daemon assembleRelease -PposteVersion="$VERSION" -PposteCode="$((CODE + 1))" -PposteId="$IDENTIFIANT" -PposteUrl="$URL" )
mkdir -p "$DEST"
cp android/app/build/outputs/apk/release/app-release.apk "$DEST/poste.apk"
ls -la "$DEST/poste.apk"
