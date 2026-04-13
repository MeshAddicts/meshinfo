/**
 * Direct terrain-DEM sourcing via Mapbox terrain-dem-v1 tiles.
 *
 * Instead of calling `map.queryTerrainElevation()` (which only returns data
 * for tiles currently loaded in the viewport — the source of our "empty
 * coverage render" bug), we fetch the underlying PNG tiles directly over
 * HTTPS and decode RGB → elevation per pixel. This works at any zoom, any
 * bbox, with no camera movement, and is safe to run from a Web Worker.
 *
 * Elevation decode per the Mapbox spec:
 *   elevation_m = -10000 + ((R × 256² + G × 256 + B) × 0.1)
 *
 * Design goals:
 *   - Worker-safe (no DOM): uses fetch + createImageBitmap + OffscreenCanvas
 *   - Parallel tile fetch for speed
 *   - LRU cache keyed by z/x/y so drag / recompute reuses tiles
 *   - Sensible zoom selection: highest zoom where total tiles stay under a
 *     hard cap (to avoid blowing Mapbox's tile-read quota and our RAM)
 *
 * This module is the Phase 10A foundation; Phase 10B+ will consume these
 * DEM arrays for Longley-Rice ray-march sampling.
 */
import type { DEM, DEMBounds } from "./terrainDEM";

/**
 * Nominal tile size used for output sampling math. The actual decoded tile
 * may be 256 or 512; we use each tile's real width/height at read time.
 */
const DEFAULT_TILE_SIZE = 512;
/**
 * Mapbox terrain tileset endpoint. We use `mapbox.terrain-rgb` (the v1
 * tileset) served through the v4 Tiles API — this is the publicly
 * accessible one. The newer `mapbox-terrain-dem-v1` is explicitly marked
 * "not user-accessible" in Mapbox's docs (GL JS uses it internally only),
 * so it 404s when fetched directly.
 *
 * `.pngraw` is critical — it returns the raw (non-re-encoded) PNG so the
 * RGB elevation encoding is preserved exactly. A `.png` request gets
 * re-encoded by the CDN and elevations decode as garbage.
 *
 * Elevation decode (same for both tilesets):
 *   elev_m = -10000 + ((R × 256² + G × 256 + B) × 0.1)
 */
const TILE_URL =
  "https://api.mapbox.com/v4/mapbox.terrain-rgb";

// Practical safety caps — prevent a bad bbox/zoom combination from
// dispatching thousands of tile fetches. If a request asks for more, we
// bump the zoom down until the count fits.
const MAX_TILES_PER_REQUEST = 64;
const MAX_ZOOM = 14;
const MIN_ZOOM = 0;

// ---------------------------------------------------------------------------
// Tile coordinate math (Slippy Map / Web Mercator)
// ---------------------------------------------------------------------------

function lng2tileX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

function lat2tileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    Math.pow(2, zoom)
  );
}

/** Approx ground resolution (meters per pixel) for a tile at `zoom`, at `lat`. */
function tileMetersPerPixel(lat: number, zoom: number): number {
  const equatorCircumferenceM = 40_075_017;
  return (equatorCircumferenceM * Math.cos((lat * Math.PI) / 180)) / (DEFAULT_TILE_SIZE * Math.pow(2, zoom));
}

/**
 * Pick the highest zoom where (a) tile resolution is finer than the caller's
 * target pixel size, AND (b) the total number of tiles stays under
 * `MAX_TILES_PER_REQUEST`. Falls back to lower zooms on either constraint.
 */
function selectZoom(bounds: DEMBounds, targetPixelSizeM: number): number {
  const midLat = (bounds.north + bounds.south) / 2;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const res = tileMetersPerPixel(midLat, z);
    if (res > targetPixelSizeM) continue; // tile resolution too coarse
    const tiles = tileCountForBounds(bounds, z);
    if (tiles <= MAX_TILES_PER_REQUEST) return z;
  }
  // Fall back: largest zoom where tile count is tolerable, even if coarse.
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    if (tileCountForBounds(bounds, z) <= MAX_TILES_PER_REQUEST) return z;
  }
  return MIN_ZOOM;
}

function tileCountForBounds(bounds: DEMBounds, zoom: number): number {
  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom)); // north = smaller Y
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}

// ---------------------------------------------------------------------------
// LRU tile cache (decoded elevations)
// ---------------------------------------------------------------------------

interface CachedTile {
  /** Row-major elevations, length = size × size. */
  data: Float32Array;
  /** Actual edge length in pixels of the decoded tile (256 or 512). */
  size: number;
}

/**
 * Each entry is the decoded Float32Array of elevations for one tile. Keyed
 * by `${z}/${x}/${y}`. Map preserves insertion order so oldest = first key.
 */
class TileLRU {
  private cache = new Map<string, CachedTile>();
  constructor(private readonly maxEntries: number) {}

  get(key: string): CachedTile | undefined {
    const v = this.cache.get(key);
    if (!v) return undefined;
    // Re-insert to mark as most recently used.
    this.cache.delete(key);
    this.cache.set(key, v);
    return v;
  }

  set(key: string, tile: CachedTile): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, tile);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

// Module-level cache; persists across requests to the same worker instance.
// ~64 tiles × 512² × 4 bytes = ~64 MB worst case — reasonable for a worker.
const tileCache = new TileLRU(64);

// ---------------------------------------------------------------------------
// Tile fetch + decode
// ---------------------------------------------------------------------------

async function fetchTile(
  z: number,
  x: number,
  y: number,
  token: string,
): Promise<CachedTile> {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;

  const url = `${TILE_URL}/${z}/${x}/${y}.pngraw?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`terrain-rgb tile fetch failed ${z}/${x}/${y}: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (w !== h) {
      throw new Error(`terrain tile ${key} has non-square dimensions ${w}x${h}`);
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const elev = new Float32Array(w * h);
    for (let i = 0; i < elev.length; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      elev[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
    }
    const tile: CachedTile = { data: elev, size: w };
    tileCache.set(key, tile);
    return tile;
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Build a DEM over the requested bounds by resampling fetched tiles
// ---------------------------------------------------------------------------

export interface BuildDemOptions {
  bounds: DEMBounds;
  /** Output grid resolution. */
  targetWidth: number;
  targetHeight: number;
  /** Mapbox access token (passed through to worker via postMessage). */
  token: string;
}

/**
 * Fetch + stitch terrain tiles for `bounds`, then sample to a `targetWidth × targetHeight`
 * DEM using nearest-neighbor. Good enough for viewshed work; if we want
 * bilinear later we can add it without changing the interface.
 *
 * Any individual tile failure is tolerated — its pixels come out as NaN and
 * the viewshed treats them as unreachable. The overall promise still resolves.
 */
export async function buildDemFromTerrainRgb(opts: BuildDemOptions): Promise<DEM> {
  const { bounds, targetWidth, targetHeight, token } = opts;

  // Pick a zoom that gives tile pixels roughly as fine as output pixels,
  // then clamp by the tile-count cap. Ground-meters-per-output-pixel:
  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    ((bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180));
  const targetPixelSizeM = Math.max(1, bboxWidthM / targetWidth);
  const zoom = selectZoom(bounds, targetPixelSizeM);

  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));

  // Fetch all tiles in parallel. Individual failures become `null` tiles.
  const tileMap = new Map<string, CachedTile | null>();
  const jobs: Promise<void>[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${x}/${y}`;
      jobs.push(
        fetchTile(zoom, x, y, token)
          .then((t) => void tileMap.set(key, t))
          .catch((err) => {
            console.warn("[terrainRgb]", err);
            tileMap.set(key, null);
          }),
      );
    }
  }
  await Promise.all(jobs);

  // Resample into the output grid. For each output pixel, compute its
  // fractional tile x/y, locate the owning tile, and read the nearest pixel.
  const data = new Float32Array(targetWidth * targetHeight);
  const scale = Math.pow(2, zoom);

  for (let j = 0; j < targetHeight; j++) {
    // Latitude of this output row (row 0 = north edge).
    const lat =
      bounds.north - ((bounds.north - bounds.south) * j) / (targetHeight - 1);
    const tyFloat = lat2tileY(lat, zoom);
    const tyInt = Math.floor(tyFloat);
    const tyFrac = tyFloat - tyInt;

    for (let i = 0; i < targetWidth; i++) {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * i) / (targetWidth - 1);
      const txFloat = lng2tileX(lng, zoom);
      const txInt = Math.floor(txFloat);
      const txFrac = txFloat - txInt;

      // Wrap X across the world seam just in case (terrain-rgb uses standard
      // spherical Mercator with X wrapping at 2^zoom).
      const xWrapped = ((txInt % scale) + scale) % scale;
      const key = `${zoom}/${xWrapped}/${tyInt}`;
      const tile = tileMap.get(key);
      if (!tile) {
        data[j * targetWidth + i] = NaN;
        continue;
      }
      // Use each tile's actual pixel size — might be 256 or 512.
      const tileSize = tile.size;
      const pxInt = Math.min(tileSize - 1, Math.floor(txFrac * tileSize));
      const pyInt = Math.min(tileSize - 1, Math.floor(tyFrac * tileSize));
      data[j * targetWidth + i] = tile.data[pyInt * tileSize + pxInt];
    }
  }

  return { data, width: targetWidth, height: targetHeight, bounds };
}
