"""
Bake JRC's GHS-BUILT-H ANBH (Average Net Building Height, 2018 epoch, 100 m
global, CC-BY-4.0) into a {z}/{x}/{y}.png slippy tile pyramid feeding the
P.452 endpoint formula and ITM DSM in coverageRaster / scanAnalysis.

Encoding (each 256x256 RGBA PNG):
    R = high byte of height (metres, uint16)
    G = low byte of height
    B = 0 (reserved; std-dev not published for GHS-BUILT-H)
    A = 255 valid, 0 nodata (frontend falls back to class-nominal on nodata)

Source: single global GeoTIFF in EPSG:54009 (Mollweide), reprojected per output
tile to EPSG:3857. ANBH is metres, averaged only over built-area sub-pixels —
0 means "no buildings in this 100 m cell," not nodata. The source's own nodata
sentinel is read from the TIFF header, not hard-coded (JRC has changed it
between releases).

When run without --source, auto-downloads + extracts. Idempotent — existing
PNG tiles skipped unless --force.
"""
from __future__ import annotations

import argparse
import logging
import sys
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
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
        "Install with: pip install -r scripts/requirements-buildings.txt\n"
    )
    sys.exit(2)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("building_tiles")

TILE_PX = 256

# Web Mercator's valid latitude clip; reprojection from Mollweide blows up
# outside this band.
MERCATOR_LAT_LIMIT = 85.0511
GLOBAL_BBOX = (-180.0, -MERCATOR_LAT_LIMIT, 180.0, MERCATOR_LAT_LIMIT)
CONUS_BBOX = (-125.0, 24.0, -67.0, 49.0)

# GHS-BUILT-H R2023A — anonymous-public, no auth. Update for a new release;
# units (metres) and Mollweide CRS are stable across the R2023A family.
DEFAULT_SOURCE_URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_BUILT_H_GLOBE_R2023A/"
    "GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100/"
    "V1-0/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0.zip"
)
DEFAULT_SOURCE_DIR = Path("output/buildings-source")

# Outside ANBH's float32 metres range, so it disambiguates "no source coverage"
# from the meaningful "valid 0 m height" reading (cells with no buildings).
_DST_NODATA = 65535


@dataclass(frozen=True)
class TileJob:
    z: int
    x: int
    y: int
    source: str
    out_dir: str
    force: bool


def _tile_path(out_dir: Path, z: int, x: int, y: int) -> Path:
    return out_dir / str(z) / str(x) / f"{y}.png"


def bake_tile(job: TileJob) -> str:
    """Returns 'written', 'skipped' (already exists), or 'empty' (all nodata)."""
    out_path = _tile_path(Path(job.out_dir), job.z, job.x, job.y)
    if out_path.exists() and not job.force:
        return "skipped"

    bounds = mercantile.xy_bounds(job.x, job.y, job.z)
    dst_transform = rasterio.transform.from_bounds(
        bounds.left, bounds.bottom, bounds.right, bounds.top,
        TILE_PX, TILE_PX,
    )
    contrib = np.full((TILE_PX, TILE_PX), _DST_NODATA, dtype=np.uint16)

    with rasterio.open(job.source) as src:
        # Bilinear: ANBH is already 100 m area-averaged, so cell boundaries
        # benefit from interpolation rather than nearest-neighbor's hard cliff.
        reproject(
            source=rasterio.band(src, 1),
            destination=contrib,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            resampling=Resampling.bilinear,
            src_nodata=src.nodata,
            dst_nodata=_DST_NODATA,
        )

    valid = contrib != _DST_NODATA
    if not valid.any():
        return "empty"

    height = np.where(valid, contrib, 0).astype(np.uint16)
    rgba = np.zeros((TILE_PX, TILE_PX, 4), dtype=np.uint8)
    rgba[..., 0] = (height >> 8) & 0xFF
    rgba[..., 1] = height & 0xFF
    rgba[..., 3] = np.where(valid, 255, 0)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out_path, format="PNG", optimize=True)
    return "written"


def iter_tiles(
    bbox: tuple[float, float, float, float],
    zooms: range,
) -> Iterator[mercantile.Tile]:
    west, south, east, north = bbox
    # mercantile.tiles emits degenerate tiles past Mercator's lat clip.
    south = max(south, -MERCATOR_LAT_LIMIT)
    north = min(north, MERCATOR_LAT_LIMIT)
    for z in zooms:
        for tile in mercantile.tiles(west, south, east, north, zooms=[z]):
            yield tile


def count_tiles(bbox: tuple[float, float, float, float], zooms: range) -> int:
    return sum(1 for _ in iter_tiles(bbox, zooms))


def _find_raster(src_dir: Path) -> Path | None:
    for pattern in ("*.tif", "*.img"):
        for cand in sorted(src_dir.glob(pattern)):
            return cand
    return None


def _download_with_progress(url: str, dest: Path) -> None:
    """Resumes via Range when a partial file exists and the server returns 206;
    falls back to a fresh download if the server returns 200 instead."""
    existing = dest.stat().st_size if dest.exists() else 0
    headers = {"Range": f"bytes={existing}-"} if existing > 0 else {}
    req = urllib.request.Request(url, headers=headers)

    log.info("Downloading %s", url)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status = resp.status
            if existing > 0 and status == 206:
                mode = "ab"
                total = existing + int(resp.headers.get("Content-Length", 0))
                downloaded = existing
                log.info("Resuming from byte %d", existing)
            else:
                if existing > 0:
                    log.info("Server returned %d (no Range); restarting download", status)
                mode = "wb"
                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0

            chunk = 1 << 16
            last_pct = -5
            with dest.open(mode) as f:
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    downloaded += len(buf)
                    if total:
                        pct = (downloaded * 100) // total
                        if pct >= last_pct + 5:
                            log.info("  [%3d%%]  %.1f / %.1f MB",
                                     pct, downloaded / 1e6, total / 1e6)
                            last_pct = pct
    except urllib.error.URLError as e:
        raise RuntimeError(f"Download failed: {e}. Re-run to resume.") from e

    log.info("Download complete: %s (%.1f MB)", dest, dest.stat().st_size / 1e6)


def _extract_zip(zip_path: Path, dest_dir: Path) -> None:
    """Extracts members one at a time, validating each resolved path stays within
    dest_dir so a malicious archive can't write outside it (zip-slip)."""
    log.info("Extracting %s ...", zip_path.name)
    dest_dir.mkdir(parents=True, exist_ok=True)
    resolved_dest = dest_dir.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            target = (dest_dir / member.filename).resolve()
            try:
                target.relative_to(resolved_dest)
            except ValueError as exc:
                raise RuntimeError(
                    f"Refusing to extract suspicious archive entry: {member.filename}"
                ) from exc
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, target.open("wb") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
    log.info("Extraction complete")


def ensure_source(source_arg: str | None) -> Path:
    """If --source is given, use it. Otherwise look for a raster in
    output/buildings-source/, then a zip to extract, then download the default."""
    if source_arg:
        p = Path(source_arg)
        if not p.exists():
            raise RuntimeError(f"Source raster not found: {p}")
        return p

    DEFAULT_SOURCE_DIR.mkdir(parents=True, exist_ok=True)

    raster = _find_raster(DEFAULT_SOURCE_DIR)
    if raster:
        log.info("Using existing raster: %s", raster)
        return raster

    zips = sorted(DEFAULT_SOURCE_DIR.glob("*.zip"))
    if not zips:
        zip_dest = DEFAULT_SOURCE_DIR / Path(DEFAULT_SOURCE_URL).name
        _download_with_progress(DEFAULT_SOURCE_URL, zip_dest)
        zips = [zip_dest]

    _extract_zip(zips[0], DEFAULT_SOURCE_DIR)
    raster = _find_raster(DEFAULT_SOURCE_DIR)
    if not raster:
        raise RuntimeError(
            f"Extracted {zips[0].name} but no .tif or .img found in {DEFAULT_SOURCE_DIR}"
        )
    return raster


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Bake GHS-BUILT-H ANBH into a slippy tile pyramid for the building DSM model.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--source",
        default=None,
        help="Path to GHS-BUILT-H source raster (GeoTIFF). "
             "Omit to auto-download the global ANBH product into output/buildings-source/.",
    )
    p.add_argument(
        "--out",
        default="output/buildings",
        help="Output tile directory (default: output/buildings).",
    )
    p.add_argument(
        "--scope",
        choices=("global", "conus"),
        default="global",
        help="Convenience preset for --bbox: global (default; ~3 GB output) or conus.",
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
        "--zooms",
        nargs=2,
        type=int,
        metavar=("MIN", "MAX"),
        default=[6, 10],
        help="Inclusive zoom range (default: 6 10; GHS-BUILT-H is 100 m native, "
             "z=10 ~= 38 m/px at lat 37 is the matching frontier).",
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
        "--force",
        action="store_true",
        help="Overwrite existing tiles. Default is skip-if-exists (resumable).",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    try:
        source = ensure_source(args.source)
    except RuntimeError as e:
        log.error("%s", e)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.bbox is not None:
        bbox = tuple(args.bbox)
    elif args.scope == "conus":
        bbox = CONUS_BBOX
    else:
        bbox = GLOBAL_BBOX

    zmin, zmax = args.zooms
    if zmin > zmax:
        log.error("Invalid zoom range: min %d > max %d", zmin, zmax)
        return 1
    zooms = range(zmin, zmax + 1)

    log.info("Source:  %s", source.resolve())
    log.info("Output:  %s", out_dir.resolve())
    log.info("BBox:    W=%.3f S=%.3f E=%.3f N=%.3f", *bbox)
    log.info("Zooms:   %d..%d (inclusive)", zmin, zmax)
    log.info("Workers: %d", args.workers)
    log.info("Force:   %s", args.force)

    with rasterio.open(source) as src:
        log.info("Source CRS: %s, size %dx%d, dtype %s, nodata %s",
                 src.crs, src.width, src.height, src.dtypes[0], src.nodata)

    log.info("Counting tiles for progress estimate...")
    total = count_tiles(bbox, zooms)
    log.info("Total tiles to consider: %d", total)

    jobs = (
        TileJob(t.z, t.x, t.y, str(source), str(out_dir), args.force)
        for t in iter_tiles(bbox, zooms)
    )

    counts = {"written": 0, "skipped": 0, "empty": 0, "error": 0}
    progress_step = max(1, total // 100)

    # Bounded streaming submission: keep ~2× workers in flight rather than
    # materializing all futures up front. Default --scope global at z=6..10
    # is millions of tiles; submitting all up front would burn GBs on Futures.
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
                if completed % progress_step == 0 or completed == total:
                    pct = 100.0 * completed / total if total else 100.0
                    log.info(
                        "[%5.1f%%] %d/%d  written=%d skipped=%d empty=%d error=%d",
                        pct, completed, total,
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
