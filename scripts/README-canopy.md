# Canopy-height tile bake (operator guide)

The coverage and scan tools use measured per-pixel canopy heights to refine
the ITU-R P.833-9 path-integrated vegetation loss. Tiles are pre-baked from
the ETH Global Canopy Height 2020 dataset (Lang et al. 2023, 10 m global) and
served as static PNGs under `/tiles/canopy/{z}/{x}/{y}.png`.

For the propagation model that consumes these tiles, see
[../RF-MODEL.md](../RF-MODEL.md).

## Quick start

The bake auto-downloads the relevant 3°×3° COGs from ETH's libdrive share into
`output/canopy-source/`, then bakes z=8..12 PNG tiles into `output/canopy/`.

### Docker (recommended — no host Python deps)

```bash
docker compose --profile bake run --rm canopy-bake
```

### Python directly

```bash
pip install -r scripts/requirements-canopy.txt
python scripts/canopy_tiles.py
```

Default scope is **CONUS** (lower 48). Without canopy tiles the frontend falls
back to class-nominal heights from NLCD (e.g. 20 m for Evergreen Forest) — the
coverage tool still works, just less accurate over canopy variation.

**First-run footprint (CONUS):** ~30 GB downloaded COGs + ~1–2 GB output tiles.

**Time:** ~1–4 hours total depending on the ETH server and CPU. Idempotent —
ctrl-C and re-run to resume.

## Sub-region or non-CONUS bake

```bash
# Single state / metro
python scripts/canopy_tiles.py --bbox -125 32 -113 43

# Full Earth (~50 GB download, hours of bake time)
python scripts/canopy_tiles.py --scope global

# AK only (uses ETH coverage extent N81..S57)
python scripts/canopy_tiles.py --bbox -170 51 -129 71
```

## Including std-dev

ETH publishes a per-pixel standard-deviation file (`*_Map_SD.tif`) alongside
each height file. The frontend can use it to weight uncertainty: where σ
exceeds the height, the value is treated as low-confidence and the model
falls back toward the class-nominal value.

Off by default (it doubles the download). Enable with:

```bash
python scripts/canopy_tiles.py --include-stddev
```

## All flags

```
--scope conus|global    Convenience preset for --bbox (default: conus).
--bbox W S E N          Geographic bbox in EPSG:4326. Overrides --scope.
--src-dir PATH          Cache for downloaded COGs (default: output/canopy-source).
--out PATH              Tile output directory (default: output/canopy).
--zooms MIN MAX         Zoom range (default: 8 12; ETH is 10 m native).
--workers N             Bake worker count (default: cpu_count).
--download-workers N    Parallel ETH downloads (default: 2; max 4 — be polite).
--include-stddev        Also download std-dev and pack into B channel.
--force                 Overwrite existing tiles instead of skipping.
```

## How the tiles are served

The Meshinfo API mounts `output/canopy` (configurable via `canopy.tile_dir` in
`config.toml`) at `/tiles/canopy` automatically when `canopy.enabled = true`.

Both compose files bind-mount `./output:/app/output`, so tiles baked on the
host appear at `/app/output/canopy` inside the container with no extra config.

The frontend fetches via the Caddy `/api/*` proxy:

```
/api/tiles/canopy/{z}/{x}/{y}.png   →   meshinfo:9000/tiles/canopy/{z}/{x}/{y}.png
```

Tiles respond with `Cache-Control: public, max-age=31536000, immutable`.

## Troubleshooting

- **`Missing dependency: rasterio`** — install `scripts/requirements-canopy.txt`.
- **All cells absent** — bbox doesn't overlap any ETH-published cell. Most
  often this means the bbox is over open ocean. Check the ETH tile index at
  https://langnico.github.io/globalcanopyheight/.
- **Slow downloads** — leave `--download-workers` at 2; raising it does not
  speed things up much against a single server, and will get you rate-limited.
- **Slow bake** — bump `--workers` once downloads are done.

## File format

Each output tile is a 256×256 RGBA PNG:

- **R** = high byte of canopy height in metres (uint16 packed into R/G).
- **G** = low byte of canopy height.
- **B** = std-dev in metres (uint8); 0 if `--include-stddev` was off.
- **A** = 255 valid, 0 nodata. Frontend falls back to NLCD class-nominal on nodata.

A=255 with height=0 is "valid measurement, no canopy here" (e.g. clearing in a
forest, fire scar) — distinct from A=0 (the bake didn't cover this region).

## Refreshing for a new vintage

ETH has not yet published a v2 (as of 2026). When they do, update
`ETH_BASE_URL` and `ETH_QUERY_PATH` in
[canopy_tiles.py](canopy_tiles.py) to point at the new share, delete
`output/canopy-source/` and `output/canopy/`, and re-run the bake.
