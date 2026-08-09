# MeshInfo

A real-time web application for visualizing and monitoring Meshtastic mesh networks.

[![Docker Image](https://github.com/MeshAddicts/meshinfo/actions/workflows/docker.yml/badge.svg)](https://github.com/MeshAddicts/meshinfo/actions/workflows/docker.yml) ![GitHub Release](https://img.shields.io/github/v/release/meshaddicts/meshinfo) ![GitHub commit activity](https://img.shields.io/github/commit-activity/t/meshaddicts/meshinfo) [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## Overview

MeshInfo connects to one or more MQTT brokers receiving Meshtastic traffic and provides a modern web UI for exploring your mesh. It decodes protobuf and JSON messages in real time, stores everything in PostgreSQL, and serves it through a FastAPI backend and React frontend.

See live instances at [Central Valley Mesh](https://meshinfo.cvme.sh), 
[Georgia State Mesh](https://meshinfo.gamesh.net)

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
- **Channel-aware Chat** -- Channels resolved to firmware `(name, PSK)` hash ids; channel pills build themselves from traffic in the selected time range, or pin a curated list with `broker.channels.mode = "manual"`

## Architecture

```
MQTT Broker(s)  -->  MeshInfo Backend (Python / FastAPI / uvicorn)
                          |
                     PostgreSQL 18
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

> **PostgreSQL major version bumps:** if a release changes the `postgres` image
> to a new major version (e.g. 16 → 18), run the one-time migration **before**
> the final `up -d` — `docker compose pull` then `bash scripts/migrate-postgres.sh`.
> See [POSTGRES.md](POSTGRES.md#upgrading-postgresql-major-versions).

Upgrading from an older release? See [UPGRADING.md](UPGRADING.md) for release-specific notes (channel-id resolution and backfill, config changes).

### Configuration

The main configuration file is `config.toml`. Key sections:

| Section | Purpose |
|---------|---------|
| `[broker]` | MQTT connection, topics, channel display mode and hashes, decoders |
| `[server]` | Node ID, base URL, timezone, enrichment, graph settings |
| `[storage.postgres]` | PostgreSQL connection and pool settings |
| `[mesh]` | Network name, region, coordinates, external tool links |
| `[integrations.*]` | Discord bridge, reverse geocoding |

See [config.toml.sample](config.toml.sample) for all options with inline documentation.

For PostgreSQL-specific details, see [POSTGRES.md](POSTGRES.md).

For the Coverage and Scan tools' propagation model (ITM + ITU-R clutter), see [RF-MODEL.md](RF-MODEL.md). To enable per-pixel land-cover-aware predictions, run the one-shot tile bake:

```sh
docker compose --profile bake run --rm landcover-bake
```

The bake auto-downloads NLCD from MRLC, extracts, and writes tiles to `output/landcover/`. ~15–90 min one-time, no manual download. See [scripts/README-landcover.md](scripts/README-landcover.md) for sub-region or offline options.

### Live Coverage Map

An optional always-current map layer showing the predicted RF footprint of every recently-heard node on your mesh — like a carrier coverage map, rebaked automatically as nodes come and go. Two steps to enable:

1. In `config.toml`, set `[coverage] enabled = true`.
2. Start the worker: `docker compose --profile coverage up -d --build coverage-worker`

The first bake takes minutes to tens of minutes depending on mesh size and CPU; every rebake after that is incremental (seconds to a couple of minutes). Toggle the layer with the **Coverage** pill on the map; hover (or long-press on mobile) to see which nodes cover a point. See [frontend/coverage-worker/README.md](frontend/coverage-worker/README.md) for how it works, tuning for small servers, and troubleshooting.

### Caddy / Reverse Proxy

The included `Caddyfile.sample` routes `/api/*` and `/v1/*` to the backend and everything else to the frontend. Caddy automatically provisions Let's Encrypt certificates when you use a public FQDN on ports 80/443.

If you use a different reverse proxy, point `/api/*` and `/v1/*` at the backend container (port 9000) and `/` at the frontend container (port 80).

### Maintenance Mode

When you need to take the stack down — for example to upgrade PostgreSQL — Caddy can serve a branded maintenance page instead of a broken site. Caddy and the page itself stay up the whole time, so visitors get a clean "we'll be back shortly" landing page rather than a connection error.

```sh
scripts/maintenance.sh on       # show the maintenance page
# ... perform the upgrade ...
scripts/maintenance.sh off      # back to normal
scripts/maintenance.sh status   # check current state
```

On Windows, use the PowerShell port instead — `scripts\maintenance.ps1 on|off|status`.

The toggle creates/removes the flag file `public/maintenance/ON`. Caddy checks for it on every request, so it takes effect immediately — no reload or restart. While enabled, every path (including `/api/*`) returns the page with HTTP `503` and a `Retry-After` header. The page auto-refreshes every 60 seconds, so visitors land on the live site automatically once you turn it off.

A typical database upgrade then looks like:

```sh
scripts/maintenance.sh on
docker compose stop meshinfo postgres
# ... upgrade / migrate ...
docker compose up -d meshinfo postgres
scripts/maintenance.sh off
```

Customize the look by editing [public/maintenance/index.html](public/maintenance/index.html) — it is a single self-contained file.

### Map Providers

MeshInfo supports two map providers, configured in `frontend/.env`:

- **OpenStreetMap** (default) -- no account needed
- **Mapbox** -- requires a [Mapbox access token](https://account.mapbox.com/)

## Running Without Docker

### Backend

Requires Python 3.14+ and a running PostgreSQL 18 instance.

```sh
pip install -r requirements.txt
# Edit config.toml with storage.postgres.host = "localhost"
python main.py
```

### Frontend

Requires Node.js 24 LTS (minimum 22.22.2) and Yarn 4 (managed via Corepack — no manual install needed).

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
