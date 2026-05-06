"""
Bake an NLCD land-cover raster into a {z}/{x}/{y}.png slippy tile pyramid.
Output tiles encode the NLCD class ID in the red channel (A=255 valid / 0 nodata).
See RF-MODEL.md for what the tiles are for, scripts/README-landcover.md for the
operator runbook.

When --source is omitted, the script auto-downloads NLCD 2024 (CONUS, Annual NLCD
Collection 1.1) from MRLC into output/landcover-source/, extracts, and bakes.
Pass --source to point at a pre-downloaded raster (offline / mirror / regional).

Idempotent: existing tiles are skipped unless --force, so interrupted bakes
resume by re-running.
"""
from __future__ import annotations

import argparse
import logging
import sys
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
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
        "Install with: pip install -r scripts/requirements-landcover.txt\n"
    )
    sys.exit(2)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("landcover_tiles")

TILE_PX = 256

# CONUS bbox (lower 48). AK/HI/PR are separate NLCD source files.
CONUS_BBOX = (-125.0, 24.0, -67.0, 49.0)

# MRLC direct download (anonymous-public). Update for a new vintage; class IDs
# follow the standard NLCD legend, stable since NLCD 2001, so existing class
# table doesn't need re-tuning.
DEFAULT_SOURCE_URL = (
    "https://www.mrlc.gov/downloads/sciweb1/shared/mrlc/data-bundles/"
    "Annual_NLCD_LndCov_2024_CU_C1V1.zip"
)
DEFAULT_SOURCE_DIR = Path("output/landcover-source")


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
    """Returns "written", "skipped" (already exists), or "empty" (all nodata)."""
    out_path = _tile_path(Path(job.out_dir), job.z, job.x, job.y)
    if out_path.exists() and not job.force:
        return "skipped"

    bounds = mercantile.xy_bounds(job.x, job.y, job.z)
    dst_transform = rasterio.transform.from_bounds(
        bounds.left, bounds.bottom, bounds.right, bounds.top,
        TILE_PX, TILE_PX,
    )
    dst = np.zeros((TILE_PX, TILE_PX), dtype=np.uint8)

    with rasterio.open(job.source) as src:
        # Nearest-neighbor: bilinear over categorical IDs would invent IDs.
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            resampling=Resampling.nearest,
            dst_nodata=0,
        )

    # Skip empty tiles; frontend treats 404 as out-of-bbox and falls back.
    if not dst.any():
        return "empty"

    rgba = np.zeros((TILE_PX, TILE_PX, 4), dtype=np.uint8)
    rgba[..., 0] = dst
    rgba[..., 3] = np.where(dst == 0, 0, 255)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(out_path, format="PNG", optimize=True)
    return "written"


def iter_tiles(
    bbox: tuple[float, float, float, float],
    zooms: range,
) -> Iterator[mercantile.Tile]:
    """Yield every (z, x, y) tile intersecting *bbox* across *zooms*."""
    west, south, east, north = bbox
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
        # Leave the partial file in place so a re-run can resume.
        raise RuntimeError(f"Download failed: {e}. Re-run to resume.") from e

    log.info("Download complete: %s (%.1f MB)", dest, dest.stat().st_size / 1e6)


def _extract_zip(zip_path: Path, dest_dir: Path) -> None:
    log.info("Extracting %s ...", zip_path.name)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)
    log.info("Extraction complete")


def ensure_source(source_arg: str | None) -> Path:
    """If --source is given, use it. Otherwise look for a raster in
    output/landcover-source/, then a zip to extract, then download the default."""
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
        description="Bake NLCD into a slippy tile pyramid for the Meshinfo clutter model.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--source",
        default=None,
        help="Path to NLCD source raster (GeoTIFF, IMG, or COG). "
             "Omit to auto-download NLCD 2024 CONUS into output/landcover-source/.",
    )
    p.add_argument(
        "--out",
        default="output/landcover",
        help="Output tile directory (default: output/landcover).",
    )
    p.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=CONUS_BBOX,
        help="Geographic bbox in EPSG:4326 (default: CONUS lower 48).",
    )
    p.add_argument(
        "--zooms",
        nargs=2,
        type=int,
        metavar=("MIN", "MAX"),
        default=[8, 12],
        help="Inclusive zoom range to bake (default: 8 12). NLCD is 30 m native; "
             "z=12 ~= 10 m/px is the matching frontier.",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=cpu_count() or 4,
        help="Parallel worker processes (default: cpu_count).",
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

    bbox = tuple(args.bbox)
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

    # Sanity check the source CRS once on the main process before forking.
    with rasterio.open(source) as src:
        log.info("Source CRS: %s, size %dx%d, dtype %s",
                 src.crs, src.width, src.height, src.dtypes[0])
        if src.dtypes[0] != "uint8":
            log.warning(
                "Source dtype is %s, expected uint8. Class IDs may be truncated.",
                src.dtypes[0],
            )

    log.info("Counting tiles for progress estimate...")
    total = count_tiles(bbox, zooms)
    log.info("Total tiles to consider: %d", total)

    jobs = (
        TileJob(t.z, t.x, t.y, str(source), str(out_dir), args.force)
        for t in iter_tiles(bbox, zooms)
    )

    counts = {"written": 0, "skipped": 0, "empty": 0, "error": 0}

    progress_step = max(1, total // 100)

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(bake_tile, job): None for job in jobs}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                result = fut.result()
                counts[result] += 1
            except Exception as exc:
                counts["error"] += 1
                log.warning("Tile failed: %s", exc)
            if i % progress_step == 0 or i == total:
                pct = 100.0 * i / total if total else 100.0
                log.info(
                    "[%5.1f%%] %d/%d  written=%d skipped=%d empty=%d error=%d",
                    pct, i, total,
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
