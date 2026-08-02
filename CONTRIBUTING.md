# Contributing to MeshInfo

Thanks for your interest in contributing! MeshInfo is open source under the [GPL-3.0 license](LICENSE).

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- Python 3.14+ (for backend development without Docker)
- Node.js 24 LTS (minimum 22.22.2) and Yarn 4 via Corepack (for frontend development)
- A running PostgreSQL 18 instance (Docker Compose provides one)

### Development Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/MeshAddicts/meshinfo.git
   cd meshinfo
   ```

2. **Copy configuration files**

   ```sh
   cp config.toml.sample config.toml
   cp frontend/.env.sample frontend/.env
   cp Caddyfile.sample Caddyfile
   ```

3. **Start the full stack in development mode**

   ```sh
   docker compose -f docker-compose-dev.yml up --build
   ```

   This starts PostgreSQL, the backend, and the frontend with hot-reload enabled.

### Running Backend and Frontend Separately

If you prefer to run components outside Docker:

**Backend:**

```sh
pip install -r requirements.txt
# Set storage.postgres.host = "localhost" in config.toml
python main.py
```

**Frontend:**

```sh
cd frontend
yarn install
yarn dev
```

The frontend dev server proxies API requests to `http://localhost:9000` by default (configurable in `frontend/.env`).

## Project Structure

```
meshinfo/
├── api/                     # FastAPI REST endpoints
│   ├── api.py               # Main API application
│   └── static_map.py        # Static map image generation
├── bot/                     # Discord bot integration
├── frontend/                # React / TypeScript SPA
│   ├── src/
│   │   ├── pages/           # One file/folder per routed page
│   │   │   ├── map/         # Map page internals, by purpose:
│   │   │   │   ├── components/  #   panels, pills, widgets
│   │   │   │   ├── hooks/       #   tool state + compute/orchestration hooks
│   │   │   │   ├── layers/      #   custom GL layers + map plumbing
│   │   │   │   ├── rf/          #   RF/physics engines, coverage workers
│   │   │   │   ├── terrain/     #   DEM/clutter tile fetchers + raster workers
│   │   │   │   └── lib/         #   shared geometry/data/format utilities
│   │   │   ├── chat/        # Chat page components + page-local hooks/utils
│   │   │   ├── nodes/       # Nodes page components (+ NodeMap mini-map)
│   │   │   ├── telemetry/   # …same pattern per page
│   │   │   ├── traceroutes/
│   │   │   ├── graph/
│   │   │   └── stats/
│   │   ├── components/      # App-wide UI (nav, toasts, MobileSheet, ExportMenu…)
│   │   ├── hooks/           # App-wide hooks (redux, live events)
│   │   ├── slices/          # RTK Query API + app state
│   │   ├── maps/            # Basemap style builder + geocoding
│   │   ├── utils/           # App-wide helpers (ids, clipboard, export…)
│   │   ├── types/           # API response types + enums
│   │   └── generated/       # Built artifacts (ITM WASM glue) — do not edit
│   ├── package.json
│   └── vite.config.ts
├── models/                  # Data models
├── postgres/                # Database schema definitions
├── scripts/                 # Bake scripts + host ops (maintenance, migrations)
├── tests/                   # Backend pytest suite
├── config.py                # Configuration loading and validation
├── main.py                  # Application entry point
├── mqtt.py                  # MQTT broker connection and message handling
├── data_store.py            # Runtime coordinator: Postgres handle, MQTT→Discord queue, enrichment loop
├── broadcaster.py           # In-process SSE pub/sub hub
├── storage/db/postgres.py   # asyncpg storage layer
├── Dockerfile               # Backend container image
├── Dockerfile.spa           # Frontend container image (Caddyfile + entrypoint live in frontend/)
├── Dockerfile.caddy         # Caddy reverse proxy image
├── docker-compose.yml       # Production stack
└── docker-compose-dev.yml   # Development stack
```

## Making Changes

### Branching

- Create feature branches from `develop`
- Use descriptive branch names: `feature/multi-broker`, `fix/chat-scroll`, `docs/update-readme`

### Backend

- The backend is a Python application using **FastAPI** with **uvicorn**
- MQTT message processing is in [mqtt.py](mqtt.py)
- API endpoints are in [api/api.py](api/api.py)
- Configuration is loaded and validated in [config.py](config.py)
- PostgreSQL is the only supported storage backend (see [POSTGRES.md](POSTGRES.md))

### Frontend

- Built with **React 19**, **TypeScript**, **Vite**, and **Tailwind CSS**
- State management uses **Redux Toolkit**
- Maps use **MapLibre GL** with OpenStreetMap (default) or Mapbox tiles
- Run `yarn dev` for hot-reload development
- Run `yarn build` to create a production build
- Run `yarn test` to run the test suite

### Code Style

- **Python**: Follow existing conventions in the codebase. Use type hints where practical.
- **TypeScript/React**: ESLint and Prettier are configured in the frontend. Run `yarn lint` to check.

## Pull Requests

1. Make sure your changes work locally with `docker compose -f docker-compose-dev.yml up --build`
2. Keep PRs focused -- one feature or fix per PR
3. Write a clear description of what the PR does and why
4. Reference any related GitHub issues

## Reporting Issues

Open an issue on [GitHub](https://github.com/MeshAddicts/meshinfo/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your deployment method (Docker Compose, bare metal, etc.)

## Community

Join us on [#meshinfo on the SacValleyMesh Discord](https://discord.gg/tj6dADagDJ) for questions and discussion.
