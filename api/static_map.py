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
import time
from io import BytesIO
from pathlib import Path

from staticmap import StaticMap, CircleMarker

logger = logging.getLogger(__name__)

# Cache settings
CACHE_DIR = Path(tempfile.gettempdir()) / "meshinfo-map-cache"
CACHE_MAX_AGE = 3600  # seconds (1 hour)

# OSM tile URL
OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"

# Mapbox raster tile URL template (style and token injected at runtime)
MAPBOX_TILE_URL = (
    "https://api.mapbox.com/styles/v1/{style}/tiles/256/{{z}}/{{x}}/{{y}}@2x"
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
    if not path.exists():
        return None
    age = time.time() - path.stat().st_mtime
    if age > CACHE_MAX_AGE:
        path.unlink(missing_ok=True)
        return None
    return path.read_bytes()


def _set_cached(cache_key: str, data: bytes) -> None:
    """Write PNG bytes to cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{cache_key}.png"
    path.write_bytes(data)


def _render_map(tile_url: str, lat: float, lon: float, zoom: int, width: int, height: int) -> bytes | None:
    """Render a static map PNG. Returns bytes or None on failure."""
    try:
        m = StaticMap(
            width,
            height,
            url_template=tile_url,
            headers={"User-Agent": "MeshInfo/1.0"},
        )
        marker = CircleMarker((lon, lat), color="red", width=8)
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

    Returns PNG bytes. Uses cache when available.
    """
    tile_url = _get_tile_url(config)
    key = _cache_key(lat, lon, zoom, width, height, tile_url)

    # Check cache
    cached = _get_cached(key)
    if cached:
        return cached

    # Generate map — try configured provider, fall back to OSM on failure
    png_bytes = _render_map(tile_url, lat, lon, zoom, width, height)
    if png_bytes is None and tile_url != OSM_TILE_URL:
        logger.warning("Tile fetch failed with configured provider, falling back to OSM")
        png_bytes = _render_map(OSM_TILE_URL, lat, lon, zoom, width, height)
    if png_bytes is None:
        raise RuntimeError("Failed to generate map with all providers")

    # Cache it
    _set_cached(key, png_bytes)

    logger.debug("Generated static map for %.4f, %.4f (zoom=%d, %dx%d)", lat, lon, zoom, width, height)
    return png_bytes
