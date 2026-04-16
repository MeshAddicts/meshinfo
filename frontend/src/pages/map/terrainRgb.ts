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
// bump the zoom down until the count fits. 256 lets us climb one zoom
// level higher than the old cap of 64 for typical radii (e.g. z=10 @
// 200 km radius instead of z=9), nearly halving native m/px. In-session
// `TileLRU` and the browser's HTTP cache (Mapbox serves terrain-rgb with
// `Cache-Control: max-age=43200`) mean the extra fetches are a
// first-view-only cost per user per ~12 hours.
const MAX_TILES_PER_REQUEST = 256;
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

/**
 * Fetch a single high-zoom tile and bilinear-sample its elevation at a
 * specific lng/lat. Use this to override the origin ground elevation in
 * the coverage / LOS tools — the main bbox DEM is forced to a coarser
 * zoom by `MAX_TILES_PER_REQUEST`, which can undersample narrow peaks
 * by hundreds of meters. A single tile at z=14 (~7.6 m/px native in the
 * US — backed by USGS 3DEP in Mapbox's blend) captures summits
 * faithfully.
 *
 * Returns `null` if the fetch fails.
 */
export async function fetchElevationAt(
  lng: number,
  lat: number,
  token: string,
  zoom = 15,
): Promise<number | null> {
  // Don't clamp to MAX_ZOOM (which caps the *bbox* DEM fetch to keep
  // tile counts sane). For a single pin tile, z=15 is fine — Mapbox
  // terrain-rgb is published through zoom 15, and that's where USGS
  // 3DEP high-resolution data lives in the US. z=14 often still uses
  // a coarser source blend that can undersample peaks by 500+ m.
  const clampedZoom = Math.max(0, Math.min(15, zoom));
  const tileX = Math.floor(lng2tileX(lng, clampedZoom));
  const tileY = Math.floor(lat2tileY(lat, clampedZoom));
  try {
    const tile = await fetchTile(clampedZoom, tileX, tileY, token);
    const pxFloat = (lng2tileX(lng, clampedZoom) - tileX) * tile.size;
    const pyFloat = (lat2tileY(lat, clampedZoom) - tileY) * tile.size;
    const x0 = Math.max(0, Math.min(tile.size - 1, Math.floor(pxFloat)));
    const y0 = Math.max(0, Math.min(tile.size - 1, Math.floor(pyFloat)));
    const x1 = Math.min(tile.size - 1, x0 + 1);
    const y1 = Math.min(tile.size - 1, y0 + 1);
    const fx = pxFloat - x0;
    const fy = pyFloat - y0;
    const v00 = tile.data[y0 * tile.size + x0];
    const v10 = tile.data[y0 * tile.size + x1];
    const v01 = tile.data[y1 * tile.size + x0];
    const v11 = tile.data[y1 * tile.size + x1];
    if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return null;
    const top = v00 + (v10 - v00) * fx;
    const bot = v01 + (v11 - v01) * fx;
    return top + (bot - top) * fy;
  } catch (err) {
    console.warn("[terrainRgb] fetchElevationAt failed:", err);
    return null;
  }
}

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

  // Resample into the output grid using BILINEAR interpolation across
  // native tile pixels. Previously we did nearest-neighbor, which meant
  // narrow terrain peaks (1–2 tile pixels wide) could fall between DEM
  // cells and be completely dropped from the output — we saw ~500 m
  // undershoot on small California buttes. Bilinear guarantees every
  // input pixel contributes to at least one DEM cell, so peaks survive
  // the resample.
  const data = new Float32Array(targetWidth * targetHeight);
  const scale = Math.pow(2, zoom);

  // All fetched tiles at a given zoom should share the same pixel size;
  // pick it from any non-null tile. Fallback to 256 if somehow all null.
  let tileSize = 256;
  for (const t of tileMap.values()) {
    if (t) { tileSize = t.size; break; }
  }

  /**
   * Look up a single elevation by absolute tile-pixel coordinates (i.e.
   * treat the fetched tiles as one contiguous image). Handles cross-tile
   * reads: a pixel near the eastern edge of one tile whose right
   * neighbor lies in the tile to the east resolves correctly.
   */
  const lookup = (absX: number, absY: number): number => {
    const tileX = Math.floor(absX / tileSize);
    const tileY = Math.floor(absY / tileSize);
    const px = absX - tileX * tileSize;
    const py = absY - tileY * tileSize;
    const xWrapped = ((tileX % scale) + scale) % scale;
    const t = tileMap.get(`${zoom}/${xWrapped}/${tileY}`);
    if (!t) return NaN;
    return t.data[py * t.size + px];
  };

  for (let j = 0; j < targetHeight; j++) {
    // Latitude of this output row (row 0 = north edge).
    const lat =
      bounds.north - ((bounds.north - bounds.south) * j) / (targetHeight - 1);
    const absY = lat2tileY(lat, zoom) * tileSize;
    const y0 = Math.floor(absY);
    const fy = absY - y0;

    for (let i = 0; i < targetWidth; i++) {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * i) / (targetWidth - 1);
      const absX = lng2tileX(lng, zoom) * tileSize;
      const x0 = Math.floor(absX);
      const fx = absX - x0;

      const v00 = lookup(x0, y0);
      const v10 = lookup(x0 + 1, y0);
      const v01 = lookup(x0, y0 + 1);
      const v11 = lookup(x0 + 1, y0 + 1);

      // If ANY corner is missing (tile not fetched — typically bbox
      // edges), mark NaN so downstream treats it as no-data rather than
      // bleeding in a bogus interpolation.
      if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) {
        data[j * targetWidth + i] = NaN;
        continue;
      }

      const top = v00 + (v10 - v00) * fx;
      const bot = v01 + (v11 - v01) * fx;
      data[j * targetWidth + i] = top + (bot - top) * fy;
    }
  }

  return { data, width: targetWidth, height: targetHeight, bounds };
}
