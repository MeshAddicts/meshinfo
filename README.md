# MeshInfo

A real-time web application for visualizing and monitoring Meshtastic mesh networks.

[![Docker Image](https://github.com/MeshAddicts/meshinfo/actions/workflows/docker.yml/badge.svg)](https://github.com/MeshAddicts/meshinfo/actions/workflows/docker.yml) ![GitHub Release](https://img.shields.io/github/v/release/meshaddicts/meshinfo) ![GitHub commit activity](https://img.shields.io/github/commit-activity/t/meshaddicts/meshinfo) [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## Overview

MeshInfo connects to one or more MQTT brokers receiving Meshtastic traffic and provides a modern web UI for exploring your mesh. It decodes protobuf and JSON messages in real time, stores everything in PostgreSQL, and serves it through a FastAPI backend and React frontend.

See a live instance at [Central Valley Mesh](https://meshinfo.cvme.sh).

## Features

- **Interactive Map** -- Node positions on OpenStreetMap or Mapbox with hardware icons
- **RF Coverage / Best Neighbors** -- Per-pixel RF coverage prediction using ITM (Longley-Rice) over real terrain plus per-pixel ITU-R clutter loss from USGS land cover. See [RF-MODEL.md](RF-MODEL.md).
- **Chat** -- View and search mesh text messages across channels, with CSV/JSON export
- **Node Explorer** -- Browse all nodes with filtering by status, hardware, role, and more
- **Network Graph** -- Visualize mesh topology with adjacency heatmaps and arc diagrams
- **Neighbor View** -- Inspect neighbor relationships and signal quality (SNR)
- **Telemetry** -- Device metrics, environment sensors, and power data per node
- **Traceroutes** -- Hop-by-hop path visualization between nodes
- **MQTT Log** -- Live stream of raw mesh traffic for debugging
- **Discord Integration** -- Bridge mesh messages and position updates to Discord channels
- **Node Enrichment** -- Augment node data from the MeshInfo network discovery service
- **Reverse Geocoding** -- Resolve node coordinates to human-readable locations
- **Multi-topic MQTT** -- Subscribe to multiple MQTT topics with tag-based filtering in the UI
- **Channel-aware Chat** -- Firmware 2.5+ channel hash support with configurable channel views

## Architecture

```
MQTT Broker(s)  -->  MeshInfo Backend (Python / FastAPI / uvicorn)
                          |
                     PostgreSQL 16
                          |
                     MeshInfo Frontend (React 19 / TypeScript / Vite)
                          |
                     Caddy (reverse proxy, automatic HTTPS)
```

All components run as Docker containers orchestrated by Docker Compose.

## Supported Message Types

- `neighborinfo` -- neighbor lists and SNR data
- `nodeinfo` -- hardware, firmware, and role information
- `position` -- GPS coordinates and altitude
- `telemetry` -- device, environment, and power metrics
- `text` -- chat messages
- `traceroute` -- hop-by-hop route data

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- An MQTT broker receiving Meshtastic traffic (or use a public one like `mqtt.meshtastic.org`)

### 1. Clone and configure

```sh
git clone https://github.com/MeshAddicts/meshinfo.git
cd meshinfo

# Backend config
cp config.toml.sample config.toml
# Edit config.toml -- set your MQTT broker, topics, mesh name, and node ID

# Frontend config
cp frontend/.env.sample frontend/.env
# Edit frontend/.env if you want to use Mapbox instead of OpenStreetMap

# MQTT broker config
cp mosquitto/config/mosquitto.conf.sample mosquitto/config/mosquitto.conf
# Edit mosquitto.conf -- add bridge connections to MQTT brokers for your region

# Reverse proxy
cp Caddyfile.sample Caddyfile
# Edit Caddyfile -- set your domain (FQDN) and email for automatic TLS
```

### 2. Start

```sh
docker compose up -d
```

MeshInfo will be available at `https://your-domain` (or `http://localhost` if using a local setup).

### 3. Update

```sh
git pull && docker compose pull && docker compose down && docker compose up -d
```

### Configuration

The main configuration file is `config.toml`. Key sections:

| Section | Purpose |
|---------|---------|
| `[broker]` | MQTT connection, topics, channel hashes, decoders |
| `[server]` | Node ID, base URL, timezone, enrichment, graph settings |
| `[storage.postgres]` | PostgreSQL connection and pool settings |
| `[mesh]` | Network name, region, coordinates, external tool links |
| `[integrations.*]` | Discord bridge, reverse geocoding |

See [config.toml.sample](config.toml.sample) for all options with inline documentation.

For PostgreSQL-specific details, see [POSTGRES.md](POSTGRES.md).

For the Coverage and Scan tools' propagation model (ITM + ITU-R clutter), see [RF-MODEL.md](RF-MODEL.md). Operators wanting per-pixel land-cover-aware predictions also need to bake NLCD tiles once via [scripts/README-landcover.md](scripts/README-landcover.md).

### Caddy / Reverse Proxy

The included `Caddyfile.sample` routes `/api/*` and `/v1/*` to the backend and everything else to the frontend. Caddy automatically provisions Let's Encrypt certificates when you use a public FQDN on ports 80/443.

If you use a different reverse proxy, point `/api/*` and `/v1/*` at the backend container (port 9000) and `/` at the frontend container (port 80).

### Map Providers

MeshInfo supports two map providers, configured in `frontend/.env`:

- **OpenStreetMap** (default) -- no account needed
- **Mapbox** -- requires a [Mapbox access token](https://account.mapbox.com/)

## Running Without Docker

### Backend

Requires Python 3.12.4+ and a running PostgreSQL instance.

```sh
pip install -r requirements.txt
# Edit config.toml with storage.postgres.host = "localhost"
python main.py
```

### Frontend

Requires Node.js 20.19+ and Yarn.

```sh
cd frontend
cp .env.sample .env
yarn install
yarn dev
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and contribution guidelines.

### Building Local Docker Images

```sh
# Build everything with docker-compose in dev mode
docker compose -f docker-compose-dev.yml up --build --force-recreate

# Or build images individually
scripts/docker-build.sh 0.0.1-dev
```

### Releasing

Tag the release and push. GitHub Actions builds and publishes images to `ghcr.io/meshaddicts/meshinfo` and `ghcr.io/meshaddicts/meshinfo-spa` for both amd64 and arm64.

```sh
git tag v0.0.0 && git push && git push --tags
```

## API

MeshInfo exposes a REST API used by the frontend. See [API.md](API.md) for endpoint documentation.

## Community

Questions, feedback, or want to contribute? Join us on the [Central Valley Mesh Discord](https://discord.gg/2P63uauAws).

If you run a public MeshInfo instance, we'd love to hear about it -- drop a note in Discord.

## Related Projects

- [Airframes](https://airframes.io) / [GitHub](https://github.com/airframesio) -- ADS-B, ACARS, VDL, HFDL, SATCOM, and AIS tracking

## License

[GNU General Public License v3.0](LICENSE)
