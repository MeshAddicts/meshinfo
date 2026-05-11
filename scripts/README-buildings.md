# Building-height tile bake (operator guide)

The coverage and scan tools use measured per-pixel building heights to refine
the ITU-R P.452-17 endpoint clutter formula and to feed buildings into the
DEM-as-DSM that the ITM propagation algorithm sees. Tiles are pre-baked from
JRC's GHS-BUILT-H ANBH (Average Net Building Height, 2018 epoch, 100 m global,
CC-BY-4.0) and served as static PNGs under `/tiles/buildings/{z}/{x}/{y}.png`.

For the propagation model that consumes these tiles, see
[../RF-MODEL.md](../RF-MODEL.md).

## Quick start

The bake auto-downloads the global ANBH GeoTIFF (~1.8 GB compressed) into
`output/buildings-source/`, then bakes z=6..10 PNG tiles into `output/buildings/`.

### Docker (recommended — no host Python deps)

```bash
docker compose --profile bake run --rm building-bake
```

### Python directly

```bash
pip install -r scripts/requirements-buildings.txt
python scripts/building_tiles.py
```

Default scope is **global** (the source is small enough). Without building
tiles the frontend falls back to class-nominal heights from NLCD (4/9/15/25 m
for the four developed-intensity classes) — coverage still works, just less
accurate in built-up regions.

**First-run footprint:** ~1.8 GB zip + ~30 GB extracted GeoTIFF + ~1-2 GB
output tiles.

**Time:** ~1-3 hours total depending on CPU. Idempotent — ctrl-C and re-run
to resume.

## Sub-region bake

```bash
# CONUS only (faster, smaller output)
python scripts/building_tiles.py --scope conus

# Single state / metro
python scripts/building_tiles.py --bbox -125 32 -113 43
```

## All flags

```
--source PATH       Use a local GHS-BUILT-H raster instead of auto-downloading.
--scope global|conus  Convenience preset for --bbox (default: global).
--bbox W S E N      Geographic bbox in EPSG:4326. Overrides --scope.
--out PATH          Tile output directory (default: output/buildings).
--zooms MIN MAX     Zoom range (default: 6 10; GHS-BUILT-H is 100 m native).
--workers N         Parallel worker count (default: cpu_count).
--force             Overwrite existing tiles instead of skipping.
```

## How the tiles are served

The Meshinfo API mounts `output/buildings` (configurable via `buildings.tile_dir`
in `config.toml`) at `/tiles/buildings` automatically when `buildings.enabled =
true` (default).

Both compose files bind-mount `./output:/app/output`, so tiles baked on the
host appear at `/app/output/buildings` inside the container with no extra config.

The frontend fetches via the Caddy `/api/*` proxy:

```
/api/tiles/buildings/{z}/{x}/{y}.png   →   meshinfo:9000/tiles/buildings/{z}/{x}/{y}.png
```

Tiles respond with `Cache-Control: public, max-age=86400` (1 day; new bakes
propagate to clients within ~24 h via Starlette's built-in ETag handling).

## File format

Each output tile is a 256×256 RGBA PNG:

- **R** = high byte of average building height in metres (uint16 packed in R/G).
- **G** = low byte of building height.
- **B** = 0 (reserved; std-dev is not published for GHS-BUILT-H).
- **A** = 255 valid, 0 nodata. Frontend falls back to class-nominal on nodata.

A=255 with height=0 is "valid measurement, no buildings in this 100 m cell"
(open space, water, forest) — distinct from A=0 (the bake didn't cover this
region).

## Refreshing for a new GHS-BUILT-H release

JRC publishes new GHSL releases roughly every 1-2 years. As of the 2025
catalog, R2023A is still the latest building-height vintage (other GHSL
products like GHS-POP have R2025A; building heights have not refreshed).

To refresh: update `DEFAULT_SOURCE_URL` in
[building_tiles.py](building_tiles.py) to the newer release, delete
`output/buildings-source/` and `output/buildings/`, and re-run the bake.

## Troubleshooting

- **`Missing dependency: rasterio`** — install `scripts/requirements-buildings.txt`.
- **Download interrupted** — re-run the same command. Resumes via HTTP Range.
- **All tiles report `empty`** — bbox doesn't overlap the source. Check you
  haven't passed a bbox over open ocean.
- **Slow bake** — bump `--workers`, ensure the source GeoTIFF is on a local
  disk (network filesystems hurt random-access reprojection).

## What this models, and what it doesn't

GHS-BUILT-H ANBH is a **100 m area-averaged** product — within each 100 m
cell, ANBH gives the mean building height across the built portion. This
captures first-order propagation physics (above-rooftop diffraction, isolated
tall structures along a path) but smooths fine-grained building edges.

For street-canyon waveguide effects and per-building precision near an antenna,
ray-tracing or per-building vector data would be needed; both are outside the
scope of this raster pipeline. See [../RF-MODEL.md](../RF-MODEL.md) for what
Meshinfo does and doesn't model.
