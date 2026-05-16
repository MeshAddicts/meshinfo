# trunk-ignore-all(checkov/CKV_DOCKER_3)
FROM python:3.14-slim

LABEL org.opencontainers.image.source https://github.com/MeshAddicts/meshinfo
LABEL org.opencontainers.image.description "Realtime web UI to run against a Meshtastic regional or private mesh network."

ENV MQTT_TLS=false
ENV PYTHONUNBUFFERED=1

# Set the working directory in the container
RUN mkdir /app
WORKDIR /app

# Install deps first so the pip layer caches across source-only changes.
COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

HEALTHCHECK NONE

RUN chmod +x run.sh

CMD ["./run.sh"]
