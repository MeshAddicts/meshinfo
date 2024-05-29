# Use the official Python slim image as the base
FROM python:3.10-slim

LABEL org.opencontainers.image.source https://github.com/kevinelliott/meshinfo
LABEL org.opencontainers.image.description "Realtime web UI to run against a Meshtastic regional or private mesh network."

ENV MQTT_BROKER=mosquitto
ENV MQTT_PORT=1883
ENV MQTT_TOPIC=msh/2/json/#
ENV MQTT_CLIENT_ID=meshinfo
ENV MQTT_USERNAME=meshinfo
ENV MQTT_PASSWORD=m3sht4st1c
ENV MQTT_TLS=false
ENV PYTHONUNBUFFERED=1

# Set the working directory in the container
RUN mkdir /app
WORKDIR /app

# Copy the requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Add a HEALTHCHECK instruction
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD python -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); result = s.connect_ex(('localhost', 8000)); s.close(); exit(result)"

# Copy the project code
COPY . .

# Set the command to run the application
CMD ["python", "main.py"]
