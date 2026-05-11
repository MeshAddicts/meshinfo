"""
Bake the ETH Global Canopy Height 2020 (Lang et al. 2023, 10 m global) into a
{z}/{x}/{y}.png slippy tile pyramid feeding the ITU-R P.833-9 vegetation loop
in coverageRaster / scanAnalysis.

Encoding (each 256x256 RGBA PNG):
    R = high byte of height (metres, uint16)
    G = low byte of height
    B = std-dev (metres, uint8) when --include-stddev; else 0
    A = 255 valid, 0 nodata (frontend falls back to class-nominal on nodata)

Source: ETH 3 deg COG tiles. See https://langnico.github.io/globalcanopyheight/.
Only 2014 of the global ~7800 3x3 cells exist (land-only); a 404 means "no
canopy data here," not a config error. Idempotent — existing PNG tiles are
skipped unless --force, so an interrupted bake resumes by re-running.
"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, ThreadPoolExecutor, as_completed, wait
from dataclasses import dataclass
from os import cpu_count
from pathlib import Path
from typing import Iterator

try:
    import mercantile
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.warp import Resampling, reproject
except ImportError as exc:
    sys.stderr.write(
        f"Missing dependency: {exc.name}.\n"
        "Install with: pip install -r scripts/requirements-canopy.txt\n"
    )
    sys.exit(2)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("canopy_tiles")

TILE_PX = 256

# AK/HI/PR / non-US use --bbox or --scope.
CONUS_BBOX = (-125.0, 24.0, -67.0, 49.0)
# Clipped to ETH's published latitude extent (N81..S57).
GLOBAL_BBOX = (-180.0, -57.0, 180.0, 81.0)

# Single university file server — be polite (low concurrency).
ETH_BASE_URL = "https://libdrive.ethz.ch/index.php/s/cO8or7iOe5dT2Rt/download"
ETH_QUERY_PATH = "/3deg_cogs"
DEFAULT_DOWNLOAD_WORKERS = 2
DEFAULT_SOURCE_DIR = Path("output/canopy-source")

CELL_DEG = 3


@dataclass(frozen=True)
class TileJob:
    z: int
    x: int
    y: int
    # Parallel tuples: sd_sources[i] = "" if no SD file for sources[i].
    sources: tuple[str, ...]
    sd_sources: tuple[str, ...]
    out_dir: str
    force: bool


def _tile_path(out_dir: Path, z: int, x: int, y: int) -> Path:
    return out_dir / str(z) / str(x) / f"{y}.png"


def cog_basename(lat_south: int, lon_west: int) -> str:
    """ETH naming gotcha: name uses the corner closest to the prime meridian.
    For W tiles that's the EAST edge (e.g. N48W123 covers lon -126..-123).
    For E tiles that's the WEST edge (lower-left, classic).
    """
    lat_part = f"N{lat_south:02d}" if lat_south >= 0 else f"S{abs(lat_south):02d}"
    lon_east = lon_west + CELL_DEG
    if lon_west >= 0:
        lon_part = f"E{lon_west:03d}"
    else:
        lon_part = f"W{abs(lon_east):03d}"
    return f"ETH_GlobalCanopyHeight_10m_2020_{lat_part}{lon_part}"


def cells_intersecting(bbox: tuple[float, float, float, float]) -> Iterator[tuple[int, int]]:
    """Yield (lat_south, lon_west) for every 3x3 cell whose bbox overlaps."""
    west, south, east, north = bbox
    lat_lo = (int(south) // CELL_DEG) * CELL_DEG
    lat_hi = (int(north - 1e-9) // CELL_DEG) * CELL_DEG
    lon_lo = (int(west) // CELL_DEG) * CELL_DEG
    lon_hi = (int(east - 1e-9) // CELL_DEG) * CELL_DEG
    for lat in range(lat_lo, lat_hi + 1, CELL_DEG):
        for lon in range(lon_lo, lon_hi + 1, CELL_DEG):
            yield (lat, lon)


def eth_download_url(filename: str) -> str:
    qs = urllib.parse.urlencode({"path": ETH_QUERY_PATH, "files": filename})
    return f"{ETH_BASE_URL}?{qs}"


_progress_lock = threading.Lock()


def _download_one(url: str, dest: Path) -> str:
    """Returns 'downloaded', 'skipped', or 'absent' (404 — no data for this cell)."""
    if dest.exists() and dest.stat().st_size > 0:
        return "skipped"

    headers = {"User-Agent": "meshinfo-canopy-bake/1 (+https://github.com/MeshAddicts/meshinfo)"}
    req = urllib.request.Request(url, headers=headers)
    tmp = dest.with_suffix(dest.suffix + ".part")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            with tmp.open("wb") as f:
                chunk = 1 << 16
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
            tmp.replace(dest)
            with _progress_lock:
                log.info("  downloaded %s (%.1f MB)", dest.name, dest.stat().st_size / 1e6)
            return "downloaded"
    except urllib.error.HTTPError as e:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        if e.code == 404:
            return "absent"
        raise
    except urllib.error.URLError as e:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Download failed for {url}: {e}. Re-run to resume.") from e


def ensure_sources(
    bbox: tuple[float, float, float, float],
    src_dir: Path,
    include_stddev: bool,
    download_workers: int,
) -> tuple[list[Path], list[Path | None]]:
    """Download every ETH COG (and SD, if requested) intersecting *bbox*.
    Returns (map_paths, sd_paths) of equal length; sd_paths[i] is None when
    --include-stddev was off or the SD download was absent."""
    src_dir.mkdir(parents=True, exist_ok=True)
    cells = list(cells_intersecting(bbox))
    log.info("Inspecting %d candidate ETH cells over bbox", len(cells))

    map_paths: list[Path] = []
    counts = {"downloaded": 0, "skipped": 0, "absent": 0, "error": 0}
    with ThreadPoolExecutor(max_workers=download_workers) as pool:
        jobs: dict = {}
        for (lat, lon) in cells:
            base = cog_basename(lat, lon)
            path = src_dir / f"{base}_Map.tif"
            jobs[pool.submit(_download_one, eth_download_url(path.name), path)] = path
        for fut in as_completed(jobs):
            path = jobs[fut]
            try:
                result = fut.result()
                counts[result] += 1
                if result in ("downloaded", "skipped"):
                    map_paths.append(path)
            except Exception as exc:
                counts["error"] += 1
                log.warning("Map download failed for %s: %s", path.name, exc)
    log.info(
        "Map COGs: downloaded=%d skipped=%d absent=%d error=%d (kept %d for bake)",
        counts["downloaded"], counts["skipped"], counts["absent"],
        counts["error"], len(map_paths),
    )

    sd_paths: list[Path | None]
    if include_stddev:
        sd_counts = {"downloaded": 0, "skipped": 0, "absent": 0, "error": 0}
        sd_by_map: dict[Path, Path | None] = {}
        with ThreadPoolExecutor(max_workers=download_workers) as pool:
            sd_futures: dict = {}
            for p in map_paths:
                sd_path = src_dir / p.name.replace("_Map.tif", "_Map_SD.tif")
                sd_futures[pool.submit(_download_one, eth_download_url(sd_path.name), sd_path)] = (p, sd_path)
            for fut in as_completed(sd_futures):
                (p, sd_path) = sd_futures[fut]
                try:
                    result = fut.result()
                    sd_counts[result] += 1
                    sd_by_map[p] = sd_path if result in ("downloaded", "skipped") else None
                except Exception as exc:
                    sd_counts["error"] += 1
                    log.warning("SD download failed for %s: %s", sd_path.name, exc)
                    sd_by_map[p] = None
        log.info(
            "SD COGs: downloaded=%d skipped=%d absent=%d error=%d",
            sd_counts["downloaded"], sd_counts["skipped"],
            sd_counts["absent"], sd_counts["error"],
        )
        sd_paths = [sd_by_map.get(p) for p in map_paths]
    else:
        sd_paths = [None] * len(map_paths)

    if not map_paths:
        raise RuntimeError(
            "No ETH canopy COGs available for the requested bbox. "
            "If this bbox is not over land (e.g. open ocean), there is nothing to bake."
        )
    return map_paths, sd_paths


# Outside ETH's uint8 source range, so it disambiguates "no source coverage"
# from the meaningful "valid 0 m canopy" reading.
_DST_NODATA = 65535


def _read_into_tile(
    src_path: Path,
    tile_bounds_3857: tuple[float, float, float, float],
    dst: np.ndarray,
    dst_mask: np.ndarray,
) -> None:
    """Reproject the relevant window of *src_path* (EPSG:4326) into *dst*
    (EPSG:3857, TILE_PX x TILE_PX). Pixels outside this source's footprint
    leave *dst* untouched so callers can accumulate over multiple sources.
    """
    dst_transform = rasterio.transform.from_bounds(
        tile_bounds_3857[0], tile_bounds_3857[1],
        tile_bounds_3857[2], tile_bounds_3857[3],
        TILE_PX, TILE_PX,
    )
    contrib = np.full((TILE_PX, TILE_PX), _DST_NODATA, dtype=np.uint16)
    with rasterio.open(src_path) as src:
        # ETH nodata sentinel is 255 (uint8); 0 is a real "no canopy" reading.
        src_nodata = src.nodata if src.nodata is not None else 255
        reproject(
            source=rasterio.band(src, 1),
            destination=contrib,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            resampling=Resampling.bilinear,
            src_nodata=src_nodata,
            dst_nodata=_DST_NODATA,
        )

    valid = contrib != _DST_NODATA
    if not valid.any():
        return
    dst[valid] = contrib[valid]
    dst_mask[valid] = 255


def bake_tile(job: TileJob) -> str:
    """Returns 'written', 'skipped', or 'empty'."""
    out_path = _tile_path(Path(job.out_dir), job.z, job.x, job.y)
    if out_path.exists() and not job.force:
        return "skipped"

    bounds_3857 = mercantile.xy_bounds(job.x, job.y, job.z)

    height = np.zeros((TILE_PX, TILE_PX), dtype=np.uint16)
    sd16 = np.zeros((TILE_PX, TILE_PX), dtype=np.uint16)
    mask = np.zeros((TILE_PX, TILE_PX), dtype=np.uint8)

    for src_path, sd_path in zip(job.sources, job.sd_sources):
        _read_into_tile(Path(src_path), bounds_3857, height, mask)
        if sd_path:
            # SD presence alone must not validate a pixel — only height does.
            sd_only_mask = np.zeros((TILE_PX, TILE_PX), dtype=np.uint8)
            _read_into_tile(Path(sd_path), bounds_3857, sd16, sd_only_mask)

    if not mask.any():
        return "empty"

    sd8 = np.clip(sd16, 0, 255).astype(np.uint8)

    rgba = np.zeros((TILE_PX, TILE_PX, 4), dtype=np.uint8)
    rgba[..., 0] = (height >> 8) & 0xFF
    rgba[..., 1] = height & 0xFF
    rgba[..., 2] = sd8
    rgba[..., 3] = np.where(mask > 0, 255, 0)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out_path, format="PNG", optimize=True)
    return "written"


def iter_tiles(
    bbox: tuple[float, float, float, float],
    zooms: range,
) -> Iterator[mercantile.Tile]:
    west, south, east, north = bbox
    for z in zooms:
        for tile in mercantile.tiles(west, south, east, north, zooms=[z]):
            yield tile


def count_tiles(bbox: tuple[float, float, float, float], zooms: range) -> int:
    return sum(1 for _ in iter_tiles(bbox, zooms))


def _bbox_intersects(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> bool:
    return not (a[2] <= b[0] or a[0] >= b[2] or a[3] <= b[1] or a[1] >= b[3])


def build_source_index(
    map_paths: list[Path],
    sd_paths: list[Path | None],
) -> list[tuple[Path, Path | None, tuple[float, float, float, float]]]:
    """Open each COG once to read its actual bounds (handles non-square cells
    that ETH publishes for some clipped tiles)."""
    out: list[tuple[Path, Path | None, tuple[float, float, float, float]]] = []
    for p, sd in zip(map_paths, sd_paths):
        with rasterio.open(p) as src:
            b = src.bounds  # ETH source CRS is EPSG:4326.
            out.append((p, sd, (b.left, b.bottom, b.right, b.top)))
    return out


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Bake ETH Global Canopy Height 2020 into a slippy tile pyramid.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--scope",
        choices=("conus", "global"),
        default="conus",
        help="Convenience preset for --bbox: conus = lower 48 (default), "
             "global = full Earth (~50 GB download, hours of bake time).",
    )
    p.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=None,
        help="Geographic bbox in EPSG:4326. Overrides --scope.",
    )
    p.add_argument(
        "--src-dir",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help="Where to cache downloaded ETH COGs (default: output/canopy-source).",
    )
    p.add_argument(
        "--out",
        default="output/canopy",
        help="Output tile directory (default: output/canopy).",
    )
    p.add_argument(
        "--zooms",
        nargs=2,
        type=int,
        metavar=("MIN", "MAX"),
        default=[8, 12],
        help="Inclusive zoom range (default: 8 12; ETH is 10 m native).",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=cpu_count() or 4,
        help="Parallel bake workers (default: cpu_count). Memory ceiling is "
             "GDAL_CACHEMAX × workers; the Dockerfile caps GDAL_CACHEMAX so "
             "cpu_count fits comfortably in Docker Desktop's default 16 GB.",
    )
    p.add_argument(
        "--download-workers",
        type=int,
        default=DEFAULT_DOWNLOAD_WORKERS,
        help=f"Parallel ETH downloads (default: {DEFAULT_DOWNLOAD_WORKERS}; do "
             "not raise above 4 — be polite to the ETH file server).",
    )
    p.add_argument(
        "--include-stddev",
        action="store_true",
        help="Also download _Map_SD.tif and pack std-dev into the B channel. "
             "Doubles download size; useful for the uncertainty-weighted refinement.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing tiles. Default is skip-if-exists (resumable).",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if args.bbox is not None:
        bbox = tuple(args.bbox)
    elif args.scope == "global":
        bbox = GLOBAL_BBOX
    else:
        bbox = CONUS_BBOX

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    zmin, zmax = args.zooms
    if zmin > zmax:
        log.error("Invalid zoom range: min %d > max %d", zmin, zmax)
        return 1
    zooms = range(zmin, zmax + 1)

    log.info("Source dir: %s", args.src_dir.resolve())
    log.info("Output:     %s", out_dir.resolve())
    log.info("BBox:       W=%.3f S=%.3f E=%.3f N=%.3f", *bbox)
    log.info("Zooms:      %d..%d (inclusive)", zmin, zmax)
    log.info("Workers:    bake=%d  download=%d", args.workers, args.download_workers)
    log.info("Include SD: %s", args.include_stddev)
    log.info("Force:      %s", args.force)

    try:
        map_paths, sd_paths = ensure_sources(
            bbox, args.src_dir, args.include_stddev, args.download_workers,
        )
    except RuntimeError as e:
        log.error("%s", e)
        return 1

    log.info("Indexing %d source COGs...", len(map_paths))
    src_index = build_source_index(map_paths, sd_paths)

    log.info("Counting output tiles for progress estimate...")
    total = count_tiles(bbox, zooms)
    log.info("Total tiles to consider: %d", total)

    def make_jobs() -> Iterator[TileJob]:
        for t in iter_tiles(bbox, zooms):
            tile_bounds = mercantile.bounds(t.x, t.y, t.z)
            tile_geo = (tile_bounds.west, tile_bounds.south, tile_bounds.east, tile_bounds.north)
            srcs: list[str] = []
            sds: list[str] = []
            for (p, sd, b) in src_index:
                if _bbox_intersects(tile_geo, b):
                    srcs.append(str(p))
                    sds.append(str(sd) if sd else "")
            if not srcs:
                continue
            yield TileJob(
                z=t.z, x=t.x, y=t.y,
                sources=tuple(srcs),
                sd_sources=tuple(sds),
                out_dir=str(out_dir),
                force=args.force,
            )

    counts = {"written": 0, "skipped": 0, "empty": 0, "error": 0}
    progress_step = max(1, total // 100)

    # Bounded streaming submission: keep ~2× workers in flight rather than
    # materializing all futures up front. CONUS at z=8..12 is ~200k tiles; a
    # global bake is 10×+ that and would burn ~1 GB on Future objects alone.
    jobs = make_jobs()
    in_flight_target = max(args.workers * 2, args.workers + 1)

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        pending = set()
        for _ in range(in_flight_target):
            try:
                pending.add(pool.submit(bake_tile, next(jobs)))
            except StopIteration:
                break

        completed = 0
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in done:
                completed += 1
                try:
                    counts[fut.result()] += 1
                except Exception as exc:
                    counts["error"] += 1
                    log.warning("Tile failed: %s", exc)
                try:
                    pending.add(pool.submit(bake_tile, next(jobs)))
                except StopIteration:
                    pass
                if completed % progress_step == 0:
                    log.info(
                        "[%5.1f%%] %d  written=%d skipped=%d empty=%d error=%d",
                        100.0 * completed / max(1, total), completed,
                        counts["written"], counts["skipped"],
                        counts["empty"], counts["error"],
                    )

    log.info(
        "Done. written=%d skipped=%d empty=%d error=%d",
        counts["written"], counts["skipped"], counts["empty"], counts["error"],
    )
    return 0 if counts["error"] == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
