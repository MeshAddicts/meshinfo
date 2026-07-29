"""
Self-hosted static map image generator.

Renders a PNG map thumbnail by fetching tiles from OSM or Mapbox and
compositing them locally. No external "static map API" — just tile
fetching and image stitching via the `staticmap` library.

Supports two tile providers:
  - mapbox: Uses Mapbox raster tiles (requires access_token in config)
  - osm:    Uses OpenStreetMap public tiles (no token needed, fallback)

Results are cached to disk to avoid re-rendering for repeated requests.
"""

import hashlib
import logging
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import requests
from staticmap import StaticMap, CircleMarker

logger = logging.getLogger(__name__)

# Cache settings
CACHE_DIR = Path(tempfile.gettempdir()) / "meshinfo-map-cache"
CACHE_MAX_AGE = 3600  # seconds (1 hour)
# Disk budget for the cache dir. The endpoint is unauthenticated with five
# free parameters, so unique keys (and their PNGs) accumulate unboundedly
# without a cap; the TTL alone only reaps a file on a same-key re-request.
CACHE_MAX_BYTES = 100 * 1024 * 1024
CACHE_MAX_FILES = 2000

# Tile fetch limits — without a timeout a hung upstream pins a render thread
# indefinitely (requests.get defaults to no timeout).
TILE_REQUEST_TIMEOUT = 10  # seconds
DELAY_BETWEEN_RETRIES = 1  # seconds

# Negative cache: a failed render costs up to ~120 upstream tile fetches
# (OSM fallback x 3 retry rounds), so remember failures briefly and fail
# fast instead of re-rendering per request.
FAILURE_TTL = 120  # seconds
_FAILURE_CACHE_MAX = 256
_failure_cache: dict[str, float] = {}  # cache_key -> monotonic expiry
_failure_lock = threading.Lock()

# Dedicated render pool. Renders block on network + PIL for up to tens of
# seconds; keeping them off asyncio's default to_thread executor (only
# min(32, cpu+4) threads) stops slow renders starving other to_thread users.
STATIC_MAP_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="static-map")


class MapUnavailableError(RuntimeError):
    """Render for this key failed within FAILURE_TTL — retry later (503)."""


# One keep-alive session shared across renders. StaticMap.get() is the
# library's per-tile fetch method (it calls bare requests.get); overriding
# it in a subclass is the supported customization point — no monkeypatching.
_tile_session = requests.Session()


class _SessionStaticMap(StaticMap):
    def get(self, url, **kwargs):
        res = _tile_session.get(url, **kwargs)
        return res.status_code, res.content

# OSM tile URL
OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

# Mapbox raster tile URL template (style and token injected at runtime)
MAPBOX_TILE_URL = (
    "https://api.mapbox.com/styles/v1/{style}/tiles/256/{{z}}/{{x}}/{{y}}"
    "?access_token={token}"
)


def _get_tile_url(config: dict) -> str:
    """Determine the tile URL based on config, with Mapbox preferred."""
    maps_cfg = (
        config.get("integrations", {})
        .get("discord", {})
        .get("bridge", {})
        .get("maps", {})
    )
    provider = maps_cfg.get("provider", "none")

    if provider == "mapbox":
        mb = maps_cfg.get("mapbox", {})
        token = mb.get("access_token", "")
        if token:
            style = mb.get("style", "mapbox/dark-v11")
            return MAPBOX_TILE_URL.format(style=style, token=token)
        logger.warning("Mapbox configured but no access token; falling back to OSM tiles")

    return OSM_TILE_URL


def _cache_key(lat: float, lon: float, zoom: int, width: int, height: int, tile_url: str) -> str:
    """Generate a cache key from parameters."""
    # Round coords to ~100m precision to increase cache hits
    lat_r = round(lat, 3)
    lon_r = round(lon, 3)
    raw = f"{lat_r},{lon_r},{zoom},{width},{height},{tile_url}"
    return hashlib.md5(raw.encode()).hexdigest()


def _get_cached(cache_key: str) -> bytes | None:
    """Return cached PNG bytes, or None if not cached/expired."""
    path = CACHE_DIR / f"{cache_key}.png"
    # The budget sweep (running on the other render thread) can unlink any file
    # between our checks — degrade to a cache miss instead of a 500.
    try:
        age = time.time() - path.stat().st_mtime
        if age > CACHE_MAX_AGE:
            path.unlink(missing_ok=True)
            return None
        return path.read_bytes()
    except OSError:
        return None


def _set_cached(cache_key: str, data: bytes) -> None:
    """Write PNG bytes to cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{cache_key}.png"
    path.write_bytes(data)
    _sweep_cache()


def _sweep_cache() -> None:
    """Bound the disk cache: unlink expired files, then oldest-mtime files
    until the dir fits the size/count budget. One scandir pass plus a sort
    only when over budget; never raises."""
    try:
        entries: list[tuple[float, int, str]] = []  # (mtime, size, path)
        total_size = 0
        now = time.time()
        with os.scandir(CACHE_DIR) as it:
            for entry in it:
                try:
                    if not entry.is_file():
                        continue
                    st = entry.stat()
                except OSError:
                    continue
                if now - st.st_mtime > CACHE_MAX_AGE:
                    try:
                        os.unlink(entry.path)
                    except OSError:
                        pass
                    continue
                entries.append((st.st_mtime, st.st_size, entry.path))
                total_size += st.st_size
        if total_size <= CACHE_MAX_BYTES and len(entries) <= CACHE_MAX_FILES:
            return
        entries.sort()  # oldest first
        remaining = len(entries)
        for _, size, path in entries:
            if total_size <= CACHE_MAX_BYTES and remaining <= CACHE_MAX_FILES:
                break
            try:
                os.unlink(path)
            except OSError:
                continue
            total_size -= size
            remaining -= 1
    except Exception:
        logger.debug("Static map cache sweep failed", exc_info=True)


def _failure_cached(cache_key: str) -> bool:
    """True while a recent failure for this key is still fresh."""
    now = time.monotonic()
    with _failure_lock:
        expiry = _failure_cache.get(cache_key)
        if expiry is None:
            return False
        if expiry <= now:
            del _failure_cache[cache_key]
            return False
        return True


def _failure_record(cache_key: str) -> None:
    """Remember a failed render; prune expired entries and cap the dict."""
    now = time.monotonic()
    with _failure_lock:
        for key in [k for k, exp in _failure_cache.items() if exp <= now]:
            del _failure_cache[key]
        _failure_cache[cache_key] = now + FAILURE_TTL
        if len(_failure_cache) > _FAILURE_CACHE_MAX:
            # Evict soonest-to-expire entries down to the cap.
            for key, _ in sorted(_failure_cache.items(), key=lambda kv: kv[1])[
                : len(_failure_cache) - _FAILURE_CACHE_MAX
            ]:
                del _failure_cache[key]


def _render_map(tile_url: str, lat: float, lon: float, zoom: int, width: int, height: int) -> bytes | None:
    """Render a static map PNG. Returns bytes or None on failure."""
    try:
        m = _SessionStaticMap(
            width,
            height,
            url_template=tile_url,
            headers={"User-Agent": "MeshInfo/1.0"},
            tile_request_timeout=TILE_REQUEST_TIMEOUT,
            delay_between_retries=DELAY_BETWEEN_RETRIES,
        )
        marker = CircleMarker((lon, lat), color="#45B3BA", width=8)
        m.add_marker(marker)
        image = m.render(zoom=zoom)
        buf = BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        logger.debug("Tile rendering failed with URL: %s", tile_url, exc_info=True)
        return None


def generate_static_map(
    lat: float,
    lon: float,
    config: dict,
    zoom: int = 12,
    width: int = 300,
    height: int = 200,
) -> bytes:
    """
    Generate a static map PNG image centered on the given coordinates.

    Returns PNG bytes. Uses cache when available. Raises MapUnavailableError
    while a recent failure for the same key is negative-cached.
    """
    tile_url = _get_tile_url(config)
    key = _cache_key(lat, lon, zoom, width, height, tile_url)

    # Check cache
    cached = _get_cached(key)
    if cached:
        return cached

    if _failure_cached(key):
        raise MapUnavailableError("map render for this key failed recently")

    # Generate map — try configured provider, fall back to OSM on failure
    png_bytes = _render_map(tile_url, lat, lon, zoom, width, height)
    if png_bytes is None and tile_url != OSM_TILE_URL:
        logger.warning("Tile fetch failed with configured provider, falling back to OSM")
        png_bytes = _render_map(OSM_TILE_URL, lat, lon, zoom, width, height)
    if png_bytes is None:
        _failure_record(key)
        raise RuntimeError("Failed to generate map with all providers")

    # Cache it
    _set_cached(key, png_bytes)

    logger.debug("Generated static map for %.4f, %.4f (zoom=%d, %dx%d)", lat, lon, zoom, width, height)
    return png_bytes
