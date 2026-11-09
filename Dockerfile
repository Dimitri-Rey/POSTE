# Poste : image de l'API et de l'interface. Données dans /data, réglages et clés dans /config.
FROM docker.io/rclone/rclone:1.75 AS rclone

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    POSTE_CONFIG=/config/poste.toml POSTE_CLE=/config/cle-secrets \
    POSTE_JETON_AGENT=/config/jeton-agent \
    POSTE_BASE=/data/poste.db HOME=/data

# rclone : sauvegardes vers les clouds, NAS et partages réseau (binaire officiel, autonome).
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api api
COPY web web
COPY poste.exemple.toml .

RUN useradd --uid 1000 --home-dir /data --no-create-home poste \
    && mkdir -p /data /config && chown poste:poste /data /config
USER poste
VOLUME ["/data", "/config"]
EXPOSE 8541

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8541/api/auth/etat', timeout=4)"

CMD ["uvicorn", "poste.app:creer", "--factory", "--app-dir", "api", "--host", "0.0.0.0", "--port", "8541", "--proxy-headers", "--forwarded-allow-ips", "*"]
