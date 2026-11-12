# trunk-ignore-all(checkov/CKV_DOCKER_3)
FROM python:3.14-slim

LABEL org.opencontainers.image.source https://github.com/MeshAddicts/meshinfo
LABEL org.opencontainers.image.description "Realtime web UI to run against a Meshtastic regional or private mesh network."

ENV MQTT_TLS=false
ENV PYTHONUNBUFFERED=1

# Set the working directory in the container
RUN mkdir /app
WORKDIR /app

# pg_dump/pg_restore matching the postgres:18 server, for the in-app scheduled
# backups ([backups] in config.toml). Debian's own client is too old to dump 18.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install deps first so the pip layer caches across source-only changes.
COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

HEALTHCHECK NONE

RUN chmod +x run.sh

CMD ["./run.sh"]
