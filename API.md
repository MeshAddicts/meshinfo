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
| GET | `/v1/nodes/{id}/packets` | Raw MQTT messages for this node, keyset-paginated. Query params: `limit` (1–200, default 50), `start`/`end` (unix-epoch seconds), `before` (cursor). Returns `{"packets": [...], "next_cursor": str \| null}`. |
| GET | `/v1/nodes/{id}/traceroutes` | Traceroutes involving this node: as initiator, target, uplink gateway, or relay hop on either leg. Query params: `limit` (1–10000, default 1000). Returns `{"traceroutes": [...]}`. |

### Chat / Messages

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/chat` | Chat in a channel. Query params: `channel` (a channel-hash id such as `"8"`; **omit for all channels**), `range` (`1h`/`24h`/`7d`/`all`, default `24h`), `limit` (1–50000, default 10000; non-integer → 400). Every channel is always returned with its `name`, `totalMessages` (all-time), `recentMessages` (within the selected `range`; equals `totalMessages` at `range=all`), and `newestTimestamp` (unix epoch of its latest message, `null` if none); `messages` is populated for the requested channel, or for all of them when `channel` is omitted. `limit` applies **per channel**, so `range=all` with no `channel` returns every message of every channel and the payload scales with channel count — pass a smaller `limit` if that matters. The old default of `"0"` was dropped — channel ids are `(name, PSK)` hashes and `"0"` is a gateway slot index that is empty on most meshes. |
| GET | `/v1/messages` | Raw MQTT messages, newest window only. Query params: `q` (search), `range`, `limit` (1–50000, default 5000). |
| GET | `/v1/mqtt_messages` | Same as `/v1/messages` without search. |
| GET | `/v1/packets` | Keyset-paginated packet archive — reaches the full history, not just the newest window. Query params: `q` (search), `topic` (substring filter on topic only), `range`, `start`/`end` (unix-epoch seconds, absolute window on ingest time), `before` (cursor from a prior page), `limit` (1–50000, default 1000). Returns `{"messages": [...], "next_cursor": str \| null}`; pass `next_cursor` back as `before` for the next page. Each message carries `mqtt_row_id` (stable DB id). |
| GET | `/v1/packets/{id}` | Single packet by `mqtt_row_id` — backs per-packet deeplinks. Returns `{"packet": {...}}`, or 404 if not found. Query params: `copies` (`1`/`true`/`yes`) rebuilds every gateway's original uplink message from its reception rows — dedup is lossless, see POSTGRES.md; `by=packet&from=<node id>` reads `{id}` as the sender's 32-bit mesh packet id instead of the row id (what chat rows know — newest archived row wins on id reuse; 400 if `from` is missing or invalid). |

### Telemetry / Traceroutes / Stats

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/telemetry` | All recent telemetry. |
| GET | `/v1/traceroutes` | Recent traceroutes, newest first. Query params: `from`/`to` (node id; both = pair in either direction), `range` (`1h`/`24h`/`7d`), `limit` (1–10000, default 1000), `slim` (`1` keeps only the fields the SPA reads, adds `packet_id`/`created_at`/`route_back_ids`), `envelope` (`1` wraps the response as `{"traceroutes": [...], "next_cursor": str \| null}` for keyset pagination — pass `next_cursor` back as `before`). Without `envelope` the response is a bare array and cannot page. Payload semantics: `snr_towards`/`snr_back` are dB ×4 with `-128` = unknown; a row whose `snr_towards` length equals `route` length + 1 is a REPLY packet, whose travel path reads header `to` → route → header `from`. `packet_id` on replies carries the request's packet id. Rows may be upgraded in place for up to 1h after first insert as richer gateway copies arrive (`created_at` never changes). |
| GET | `/v1/stats` | Mesh totals (counts, top nodes, modem preset, etc.). `nodes_by_hardware` / `online_nodes_by_hardware` map stringified HardwareModel enum ids to node counts; `online_nodes` and the online split count nodes heard in the last 6 hours (the map's online window). |
| GET | `/v1/channels` | Channel buckets with display facts and no messages — for labeling/filtering UIs. Query params: `range` (`1h`/`24h`/`7d`/`all`, default `24h`). Returns `{"channels": {"<id>": {"name", "totalMessages", "recentMessages", "newestTimestamp"}}}` with the same field semantics as `/v1/chat`. |

### Live events (SSE)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/events` | Server-Sent Events stream of live updates, one multiplexed connection per client. Each frame's `event:` type is `node`, `chat`, `telemetry`, `coverage`, `packet`, or `traceroute`; `: ...` comment frames are keep-alive heartbeats. `packet` mirrors the archived message (keys like `rssi`/`snr` are omitted when unmeasured). `traceroute` mirrors a full `/v1/traceroutes` row (plus `route_back_ids`/`created_at`) and fires once per stored insert/upgrade, not per gateway copy; rows over ~4 KB degrade to a skinny `{from, to, route_ids, id}` frame — refetch on receipt. Served unbuffered through Caddy (`flush_interval -1`); the SPA reaches it as `/api/v1/events`. |

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

### Live coverage (requires the coverage-worker container)

| Method | Path | Notes |
|---|---|---|
| GET | `/tiles/coverage/{group}/{z}/{x}/{y}.png` | Live network-coverage tile pyramids (z5–z11), rebaked as nodes come and go. `group` is `all` or a modem-preset id (e.g. `LongFast`). |
| GET | `/v1/coverage/metadata` | Bake metadata: `bounds`, `minZoom`/`maxZoom`, `nodeCount`, `generatedAt`, `sources`, `group`, `groups`. Optional `group` (default `all`). 404 until first bake. |
| GET | `/v1/coverage/lookup` | Nodes covering a point, strongest first. Required: `lng`, `lat`; optional `group` (default `all`). Returns `{"total": n, "entries": [{"id", "marginDb"}]}` (top 12). 503 when the worker is unreachable. |
| POST | `/v1/coverage/notify` | Worker → server: broadcasts the `all` pyramid's on-disk metadata as an SSE `coverage` event so open maps refresh. Request body ignored; one broadcast per baked version. |

All four require `[coverage] enabled = true`; see
[frontend/coverage-worker/README.md](frontend/coverage-worker/README.md).

## Errors

- `400 {"error": "..."}` — malformed query params (non-integer `limit`/`days`, missing required `lat`/`lon`, etc.)
- `404 {"error": "..."}` — node id not found.
- `500` — unexpected; check container logs.
