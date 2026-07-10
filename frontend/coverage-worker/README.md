# Coverage Worker — Live Network Coverage Map

A standalone container that continuously bakes a map layer of your mesh's
predicted RF coverage: the combined ITM (Longley-Rice) footprint of every node
heard recently, rendered as a web-mercator PNG tile pyramid that meshinfo
serves at `/tiles/coverage`. The map's **Coverage** pill toggles the layer;
hovering (long-press on mobile) lists the nodes covering that point with their
signal margins.

It reuses the exact RF engine behind the interactive Coverage tool — same ITM
model, same NLCD land-cover / canopy / building-height layers when those bakes
are present (it degrades gracefully to terrain-only when they aren't).

## Quick start

1. `config.toml` (meshinfo reads it at startup, so restart meshinfo after):

   ```toml
   [coverage]
   enabled = true
   ```

2. Start the worker alongside the stack:

   ```sh
   docker compose --profile coverage up -d --build coverage-worker
   ```

That's it. The worker polls `/v1/nodes`, bakes tiles into `output/coverage/`
(shared volume), and POSTs `/v1/coverage/notify` so open maps refresh live via
SSE. Once `[coverage]` is enabled, no further meshinfo restarts are needed —
the tile route is mounted up front, so the first bake appears as soon as it
lands.

## Modem-preset pyramids

Each bake produces the combined `all` pyramid plus one per modem preset present
on the mesh (`output/coverage/<group>/…`, e.g. `all`, `LongFast`,
`MediumFast`); the map's Coverage pill grows an All/LF/MF switch when more than
one preset is active. A node's preset comes from its `last_channel` hash via
meshinfo's `[broker.channels.meta.<hash>] preset = "..."` entries — channels
are not presets, so a custom/regional channel (e.g. a future "SacValley" on
MediumFast) is supported by adding one meta entry with its hash and preset.
Unmapped hashes fall back to `COVERAGE_DEFAULT_PRESET`.

Each node's margin is computed against a receiver on its own mesh (an SX1262
handheld on that preset), so slower presets legitimately paint larger
footprints. Per-node renders are shared across pyramids — extra groups cost
compositing and PNG encoding, not ITM time.

## What to expect

- **First bake:** renders every eligible node — minutes for a regional mesh,
  up to ~20+ min for very large meshes on few cores. Watch progress:
  `docker compose logs -f coverage-worker`
- **After that:** bakes are **incremental**. Per-node renders are cached on
  disk (`output/coverage-cache/`), so only new/changed nodes recompute; nodes
  aging in/out of the recency window cost almost nothing. Typical rebake:
  seconds to a couple of minutes.
- **Liveness:** the worker rebakes when the node set changes (at most every
  `COVERAGE_MIN_RECOMPUTE_MS`, default 10 min) with a 4 h backstop.
- The cache survives restarts; a container update does not trigger a full
  rebake. Delete `output/coverage-cache/` to force one.

## Sizing / small servers

Defaults target quality ("ultra" z11 detail). The worker parallelizes across
cores but always yields to meshinfo/postgres under contention
(`cpu_shares: 512`). On a small dedicated host (3–4 CPUs, 4–8 GB RAM) the
defaults work; the first bake is just slower.

Memory scales with the shared terrain raster (8192² ≈ 256 MB) plus one
transient accuracy-slice set per render worker — the NLCD/canopy/building
layers are sliced **per node** over its footprint at render resolution (never
as network-wide rasters), so their sampling stays survey-grade no matter how
large the mesh's bounding box grows. If RAM is tight:

```yaml
environment:
  - COVERAGE_DEM_SIZE=4096        # terrain raster (default 8192²)
  - COVERAGE_NODE_OUTPUT=1024     # per-node render grid cap (default 2048)
```

To hard-cap CPU on a shared host, add `cpus: N` to the service plus
`COVERAGE_WORKERS=N` (fewer workers also means fewer concurrent slice sets).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MESHINFO_URL` | `http://meshinfo:9000` | Where to fetch nodes / send notify |
| `COVERAGE_OUTPUT_DIR` | `/output/coverage` | Tile output (must be the volume meshinfo serves) |
| `COVERAGE_RECENCY_HOURS` | `4` | A node contributes if heard within this window |
| `COVERAGE_DEFAULT_PRESET` | `LongFast` | Modem preset assumed for channel hashes without a `[broker.channels.meta]` mapping |
| `COVERAGE_BBOX` | unset | `west,south,east,north` clip — set only if your DB aggregates multiple disjoint regions |
| `COVERAGE_MAX_ZOOM` / `COVERAGE_MIN_ZOOM` | `11` / `5` | Tile pyramid range (z11 ≈ 60 m/px) |
| `COVERAGE_OUTPUT_M_PER_PX` | `200` | Render + accuracy-layer sampling resolution; higher = cheaper bakes, softer detail (ITM cost scales inversely with its square) |
| `COVERAGE_DEM_SIZE` / `COVERAGE_NODE_OUTPUT` | `8192` / `3072` | Terrain raster / per-node grid caps (memory + CPU) |
| `COVERAGE_ROUTER_REACH_KM` / `COVERAGE_CLIENT_REACH_KM` | `300` / `80` | Per-role footprint radius (router reach covers peak-sited radio horizons) |
| `COVERAGE_WORKERS` | `min(cores−1, 32)` | Render threads |
| `COVERAGE_MIN_RECOMPUTE_MS` | `600000` | Min interval between rebakes |
| `COVERAGE_LOOKUP_PORT` | `9301` | Hover-lookup HTTP port (internal; meshinfo proxies it — keep `[coverage] lookup_url` in sync if changed) |

Per-role behavior: router/repeater-class nodes render at 33 dBm TX with 300 km
reach; everything else 22 dBm / 80 km. Antenna height comes from the node's
reported altitude (floored at 6 m AGL). See RF-MODEL.md for the propagation
model.

## Troubleshooting

- **Pill says "not baked yet"** — the worker hasn't finished its first bake
  (check its logs), or it isn't running (`docker compose ps coverage-worker`
  — remember the `--profile coverage` flag on compose commands).
- **Hover shows nothing** — the tooltip only appears over covered (colored)
  area; `/v1/coverage/lookup` returning 503 means the worker is unreachable
  from meshinfo (`[coverage] lookup_url`, default `http://coverage-worker:9301`).
- **Tiles look stale** — bakes are throttled to every 10 min and skipped when
  the node set is unchanged; `metadata.json` in `output/coverage/` carries the
  `generatedAt` of the served set.
- **Coverage looks terrain-only** — the NLCD/canopy/buildings accuracy bakes
  aren't present (`metadata.json` → `sources` shows what the current output
  used). Run them (see the main README); the worker re-probes for missing
  layers about every 30 minutes, and the first bake that renders a node after
  that picks them up with an automatic full re-render.
