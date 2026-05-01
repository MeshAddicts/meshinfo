# Land-cover tile bake (operator guide)

Meshinfo's coverage and scan tools sample per-pixel land-cover classes for
ITU-R clutter loss. Tiles are pre-baked from USGS NLCD and served as static
PNGs under `/tiles/landcover/{z}/{x}/{y}.png`. See
[../docs/clutter-design.md](../docs/clutter-design.md) for the full RF model.

This guide walks through running the bake once per region. Re-bake every 2–3
years when a new NLCD release ships.

## What you get

- `output/landcover/{z}/{x}/{y}.png` — slippy-tile pyramid, z=8..12 by default.
- ~700 MB – 1.1 GB on disk for the full CONUS bake.
- Bake time: ~30–90 min depending on CPU and disk speed.

Tiles outside the bake bbox 404 at request time, and the frontend falls back
to a "Mixed Forest" default class. So an operator who only deploys in one
state can pass `--bbox` to bake just that state.

## Prerequisites

```bash
# In a venv:
pip install -r scripts/requirements-landcover.txt
```

`rasterio` ships GDAL wheels on PyPI for Linux/macOS/Windows — no system GDAL
is required for typical bakes.

## Source data

NLCD is published by the USGS Multi-Resolution Land Characteristics consortium
at <https://www.mrlc.gov/data>. Pick the **Land Cover** product for the year
you want and your region:

| Region | File (example, 2021 release) |
|---|---|
| CONUS (lower 48) | `nlcd_2021_land_cover_l48_<rev>.img` |
| Alaska | `NLCD_2016_Land_Cover_AK_<rev>.img` |
| Hawaii | (separate; see MRLC portal) |
| Puerto Rico | (separate; see MRLC portal) |

The MRLC site requires a free account but downloads are public-domain.
Download the IMG/TIF; the bake script accepts either via `rasterio`.

## Running the bake (CONUS default)

```bash
python scripts/landcover_tiles.py \
    --source ~/Downloads/nlcd_2021_land_cover_l48_20230630.img \
    --out output/landcover
```

The default bbox covers the CONUS lower 48 (`-125 24 -67 49`) and the default
zoom range is `8 12`. With 8 worker processes on a modern CPU, expect
roughly 30–60 minutes for the full CONUS pyramid.

The script is **idempotent** — already-baked tiles are skipped, so you can
ctrl-C and resume by re-running the same command.

## Baking a smaller region

To bake just California, for example:

```bash
python scripts/landcover_tiles.py \
    --source nlcd_2021_land_cover_l48_20230630.img \
    --out output/landcover \
    --bbox -125 32 -113 43
```

Smaller bbox → fewer tiles → faster bake and less storage. Operators outside
the bbox transparently fall back to the default class.

## Adding AK / HI / PR

Run the bake again with the matching source file and the appropriate bbox.
The output directory can be the same — tile coordinates don't collide.

```bash
# Alaska (using the regional NLCD file)
python scripts/landcover_tiles.py \
    --source nlcd_alaska_2016_land_cover.img \
    --out output/landcover \
    --bbox -180 50 -129 72
```

## Refreshing for a new NLCD release

NLCD releases a new full product every 2–3 years. To refresh:

```bash
python scripts/landcover_tiles.py \
    --source nlcd_2024_land_cover_l48_<rev>.img \
    --out output/landcover \
    --force
```

`--force` overwrites existing tiles; without it, the script skips them.

## Serving the tiles

The Meshinfo API mounts `output/landcover` (configurable via
`landcover.tile_dir`) at `/tiles/landcover` automatically when
`landcover.enabled = true` in `config.toml` (default).

Both `docker-compose.yml` and `docker-compose-dev.yml` already bind-mount
`./output:/app/output`, so tiles baked on the host appear at
`/app/output/landcover` inside the container with no extra volume config.

The frontend fetches tiles through the existing Caddy `/api/*` proxy:

```
/api/tiles/landcover/{z}/{x}/{y}.png   →   meshinfo:9000/tiles/landcover/{z}/{x}/{y}.png
```

Tiles respond with `Cache-Control: public, max-age=31536000, immutable`
because class IDs don't change between bakes.

## Troubleshooting

- **`Missing dependency: rasterio`** — install requirements-landcover.txt.
- **`Source raster not found`** — pass an absolute path, or run from the
  Meshinfo root.
- **All tiles report `empty`** — your bbox doesn't overlap the source raster.
  Check that you're using the right NLCD region file for your bbox.
- **Slow bake** — increase `--workers`, or check that the source file is on
  a fast local disk (network filesystems hurt random-access reprojection).

## File format reference

Each output tile is a 256×256 RGBA PNG:

- **R** = NLCD class ID (11–95). 0 = nodata.
- **G**, **B** = 0 (reserved for future encoding — e.g. canopy height).
- **A** = 255 valid, 0 nodata.

The frontend's `landcoverTiles.ts` reads the R channel directly.
