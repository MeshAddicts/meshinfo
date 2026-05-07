# Land-cover tile bake (operator guide)

Meshinfo's coverage and scan tools sample per-pixel land-cover classes for
ITU-R clutter loss. Tiles are pre-baked from USGS NLCD and served as static
PNGs under `/tiles/landcover/{z}/{x}/{y}.png`.

For the propagation model that consumes these tiles (ITM + ITU-R P.452-17 +
ITU-R P.833-9), see [../RF-MODEL.md](../RF-MODEL.md).

## Quick start

The bake auto-downloads NLCD 2024 (CONUS, Annual Collection 1.1) from MRLC if
no source file is provided. Two ways to run:

### Docker (recommended — no host Python deps)

```bash
docker compose --profile bake run --rm landcover-bake
```

### Python directly

```bash
pip install -r scripts/requirements-landcover.txt
python scripts/landcover_tiles.py
```

Either way, the script:

1. Downloads `Annual_NLCD_LndCov_2024_CU_C1V1.zip` (~1.4 GB) into
   `output/landcover-source/` if not already present.
2. Extracts the GeoTIFF.
3. Bakes the full CONUS pyramid (z=8..12) into `output/landcover/`.

The Meshinfo API picks the tiles up automatically on next start (or restart if
already running) — no extra config.

**First-run footprint:** ~1.4 GB zip + ~1.7 GB extracted raster + ~1 GB tiles.
Delete `output/landcover-source/` after the bake if you don't plan to re-bake.

**Time:** ~15–90 min depending on CPU. The bake is idempotent — ctrl-C and re-run
to resume; already-baked tiles are skipped.

## Sub-region or offline bake

Pass `--source` to skip the download and use a local raster (mirror, regional
NLCD release, alternate vintage):

```bash
python scripts/landcover_tiles.py --source /path/to/nlcd.tif
```

Or restrict the bbox to a single state for a faster bake:

```bash
# California only
python scripts/landcover_tiles.py --bbox -125 32 -113 43
```

Operators who only deploy in one region can save storage and bake time this
way; the frontend falls back to the default "Mixed Forest" class everywhere
outside the baked bbox.

## All flags

```
--source PATH       Use a local NLCD raster instead of auto-downloading.
--out PATH          Tile output directory (default: output/landcover).
--bbox W S E N      Geographic bbox (default: CONUS -125 24 -67 49).
--zooms MIN MAX     Zoom range (default: 8 12; NLCD is 30 m native).
--workers N         Parallel worker count (default: cpu_count).
--force             Overwrite existing tiles instead of skipping.
```

## Refreshing for a new NLCD release

NLCD publishes a new vintage every 1–3 years (Annual NLCD has yearly snapshots
since 2019). Class IDs follow the standard NLCD legend, which has been stable
since 2001 — bake-time tuning is rarely needed.

To refresh: update `DEFAULT_SOURCE_URL` in [landcover_tiles.py](landcover_tiles.py)
to the newer vintage, delete `output/landcover-source/` and `output/landcover/`,
and re-run the bake.

## How the tiles are served

The Meshinfo API mounts `output/landcover` (configurable via `landcover.tile_dir`
in `config.toml`) at `/tiles/landcover` automatically when `landcover.enabled =
true` (default).

Both `docker-compose.yml` and `docker-compose-dev.yml` bind-mount
`./output:/app/output`, so tiles baked on the host appear at
`/app/output/landcover` inside the container with no extra config.

The frontend fetches via the Caddy `/api/*` proxy:

```
/api/tiles/landcover/{z}/{x}/{y}.png   →   meshinfo:9000/tiles/landcover/{z}/{x}/{y}.png
```

Tiles respond with `Cache-Control: public, max-age=31536000, immutable` since
class IDs don't change within a bake.

## Troubleshooting

- **`Missing dependency: rasterio`** — install `scripts/requirements-landcover.txt`.
- **Download interrupted** — re-run the same command. Resumes via HTTP Range if
  the server supports it; otherwise restarts cleanly.
- **`Extracted X but no .tif or .img found`** — corrupt zip. Delete
  `output/landcover-source/*.zip` and re-run.
- **All tiles report `empty`** — bbox doesn't overlap the source raster. Check
  you're not passing a non-CONUS `--bbox` against the CONUS source file.
- **Slow bake** — bump `--workers`, ensure the source file is on a local disk
  (network filesystems hurt random-access reprojection).

## File format

Each output tile is a 256×256 RGBA PNG:

- **R** = NLCD class ID (11–95). 0 = nodata.
- **G**, **B** = 0 (reserved for future encoding — e.g. canopy height).
- **A** = 255 valid, 0 nodata.

The frontend's `landcoverTiles.ts` reads the R channel directly.
