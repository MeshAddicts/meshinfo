# trunk-ignore-all(checkov/CKV_DOCKER_3)
FROM python:3.13-slim

LABEL org.opencontainers.image.source https://github.com/MeshAddicts/meshinfo
LABEL org.opencontainers.image.description "Realtime web UI to run against a Meshtastic regional or private mesh network."

ENV MQTT_TLS=false
ENV PYTHONUNBUFFERED=1

# Set the working directory in the container
RUN mkdir /app
WORKDIR /app

COPY . .
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

HEALTHCHECK NONE

RUN chmod +x run.sh

CMD ["./run.sh"]
