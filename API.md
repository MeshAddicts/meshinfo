# MeshInfo API

The MeshInfo backend exposes a small REST API at port `9000` (proxied by Caddy
under `/api/*` and `/v1/*`). The frontend consumes it; you can also call it
directly for integrations. Responses are JSON unless noted.

## Endpoints

### Nodes

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/nodes` | Active nodes. Query params: `days` (default 7), `ids` (comma-separated), `long_name`, `short_name`, `status` (`online`/`offline`). |
| GET | `/v1/nodes/{id}` | Single node. `id` may be hex (`abcd1234`, `!abcd1234`) or decimal. |
| GET | `/v1/nodes/{id}/telemetry` | Telemetry history. |
| GET | `/v1/nodes/{id}/texts` | Chat messages from this node. |
| GET | `/v1/nodes/{id}/packets` | Raw MQTT messages. Query param: `limit` (1–200, default 50). |
| GET | `/v1/nodes/{id}/traceroutes` | Traceroutes involving this node. |

### Chat / Messages

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/chat` | Chat in a channel. Query params: `channel` (default `"0"`), `range` (`1h`/`24h`/`7d`/`all`, default `24h`). |
| GET | `/v1/messages` | Raw MQTT messages. Query params: `q` (search), `range`, `limit` (1–50000, default 5000). |
| GET | `/v1/mqtt_messages` | Same as `/v1/messages` without search. |

### Telemetry / Traceroutes / Stats

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/telemetry` | All recent telemetry. |
| GET | `/v1/traceroutes` | All recent traceroutes. |
| GET | `/v1/stats` | Mesh totals (counts, top nodes, modem preset, etc.). |

### Static map / Server

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/static-map` | PNG snapshot at given coords. Required: `lat`, `lon`. Optional: `zoom` (1–18, default 12), `width` (100–800, default 300), `height` (100–600, default 200). |
| GET | `/v1/server/config` | Sanitized server config (secrets stripped). |

### Tiles (coverage / scan)

| Method | Path | Notes |
|---|---|---|
| GET | `/tiles/landcover/{z}/{x}/{y}` | NLCD class-ID tiles for the clutter model. |
| GET | `/tiles/canopy/{z}/{x}/{y}` | ETH canopy-height tiles for P.833 vegetation loss. |
| GET | `/tiles/buildings/{z}/{x}/{y}` | GHS-BUILT-H tiles for P.452 endpoint clutter. |

Tile endpoints are mounted only when the corresponding `[landcover]` / `[canopy]`
/ `[buildings]` section is enabled in `config.toml` and the bake has been run
(see `scripts/README-*.md`).

## Errors

- `400 {"error": "..."}` — malformed query params (non-integer `limit`/`days`, missing required `lat`/`lon`, etc.)
- `404 {"error": "..."}` — node id not found.
- `500` — unexpected; check container logs.
