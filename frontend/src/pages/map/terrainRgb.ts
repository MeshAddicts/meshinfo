/**
 * Direct terrain DEM tile fetch + decode. Worker-safe (fetch + createImageBitmap
 * + OffscreenCanvas), LRU-cached, picks the highest zoom under a tile-count cap.
 *
 * Mapbox terrain-rgb decode:  elev_m = -10000 + ((R*256² + G*256 + B) * 0.1)
 * Tilezen terrarium decode:   elev_m = (R*256 + G + B/256) - 32768
 */
import type { DEM, DEMBounds } from "./terrainDEM";

/** Nominal output tile size; real size taken from each decoded tile (256 or 512). */
const DEFAULT_TILE_SIZE = 512;

/** Mapbox `terrain-rgb` v1 via v4 Tiles API. `.pngraw` is required — `.png` gets
 *  re-encoded by the CDN and breaks the elevation decode. */
const TILE_URL =
  "https://api.mapbox.com/v4/mapbox.terrain-rgb";

/** Tilezen AWS Open Data (USGS 3DEP-backed in the US, ~10 m native through z=15).
 *  Public S3, no token, terrarium encoding. 256 px tiles. Spec: github.com/tilezen/joerd */
const TILEZEN_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

// Callers can override via BuildDemOptions.maxTiles (e.g. coverage Survey Detail).
const DEFAULT_MAX_TILES_PER_REQUEST = 256;
const MAX_ZOOM = 14;
/** Tilezen goes to z=15 (Mapbox v4: z=14). */
const TILEZEN_MAX_ZOOM = 15;
const MIN_ZOOM = 0;

// Slippy Map / Web Mercator math

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

/** m/px at zoom. tileSize = source native (512 Mapbox v4, 256 Tilezen). */
function tileMetersPerPixel(lat: number, zoom: number, tileSize: number): number {
  const equatorCircumferenceM = 40_075_017;
  return (equatorCircumferenceM * Math.cos((lat * Math.PI) / 180)) / (tileSize * Math.pow(2, zoom));
}

/** Highest zoom where tile resolution is finer than targetPixelSizeM and tile count ≤ maxTiles. */
function selectZoom(
  bounds: DEMBounds,
  targetPixelSizeM: number,
  tileSize: number,
  maxZoom: number,
  maxTiles: number,
): number {
  const midLat = (bounds.north + bounds.south) / 2;
  for (let z = maxZoom; z >= MIN_ZOOM; z--) {
    const res = tileMetersPerPixel(midLat, z, tileSize);
    if (res > targetPixelSizeM) continue;
    const tiles = tileCountForBounds(bounds, z);
    if (tiles <= maxTiles) return z;
  }
  // Fallback: largest zoom with tolerable tile count, even if coarse
  for (let z = maxZoom; z >= MIN_ZOOM; z--) {
    if (tileCountForBounds(bounds, z) <= maxTiles) return z;
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

interface CachedTile {
  /** Row-major elevations, length size². */
  data: Float32Array;
  /** Decoded tile edge in px (256 or 512). */
  size: number;
}

/** LRU keyed by `${z}/${x}/${y}`; Map preserves insertion order so oldest = first key. */
class TileLRU {
  private cache = new Map<string, CachedTile>();
  constructor(private readonly maxEntries: number) {}

  get(key: string): CachedTile | undefined {
    const v = this.cache.get(key);
    if (!v) return undefined;
    // Re-insert → mark MRU
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

// ~64 × 512² × 4B ≈ 64 MB worst case
const tileCache = new TileLRU(64);

// Sized to fit a standard-detail compute (256 max tiles) so back-to-back computes at the
// same origin hit 100% cache. 256 × 256² × 4B ≈ 64 MB worst case.
const tilezenCache = new TileLRU(256);

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

/** Fetch + decode a Tilezen terrarium tile (no token; cached separately from Mapbox). */
async function fetchTilezenTile(
  z: number,
  x: number,
  y: number,
): Promise<CachedTile> {
  const key = `${z}/${x}/${y}`;
  const hit = tilezenCache.get(key);
  if (hit) return hit;

  const url = `${TILEZEN_URL}/${z}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`tilezen tile fetch failed ${z}/${x}/${y}: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (w !== h) {
      throw new Error(`tilezen tile ${key} has non-square dimensions ${w}x${h}`);
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const elev = new Float32Array(w * h);
    // Terrarium: (R*256 + G + B/256) - 32768. Precision ~3.9 mm vs Mapbox's 0.1 m.
    for (let i = 0; i < elev.length; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      elev[i] = (r * 256 + g + b / 256) - 32768;
    }
    const tile: CachedTile = { data: elev, size: w };
    tilezenCache.set(key, tile);
    return tile;
  } finally {
    bitmap.close();
  }
}

/** Bilinear sample at lng/lat. Returns null for NaN corners or elev outside [-500, 9000] m. */
function sampleTileBilinear(
  tile: CachedTile,
  tileX: number,
  tileY: number,
  lng: number,
  lat: number,
  zoom: number,
): number | null {
  const pxFloat = (lng2tileX(lng, zoom) - tileX) * tile.size;
  const pyFloat = (lat2tileY(lat, zoom) - tileY) * tile.size;
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
  const elev = top + (bot - top) * fy;
  if (elev < -500 || elev > 9000) return null;
  return elev;
}

/** Zoom-invariant single-point elevation: tries Tilezen (3DEP), falls back to Mapbox terrain-rgb. */
export async function fetchElevationAt(
  lng: number,
  lat: number,
  token: string,
  zoom = 15,
): Promise<number | null> {
  const clampedZoom = Math.max(0, Math.min(15, zoom));
  const tileX = Math.floor(lng2tileX(lng, clampedZoom));
  const tileY = Math.floor(lat2tileY(lat, clampedZoom));

  try {
    const tile = await fetchTilezenTile(clampedZoom, tileX, tileY);
    const elev = sampleTileBilinear(tile, tileX, tileY, lng, lat, clampedZoom);
    if (elev != null) return elev;
  } catch (err) {
    if (token) {
      console.warn(
        "[terrainRgb] Tilezen tile fetch failed, falling back to Mapbox terrain-rgb:",
        err,
      );
    } else {
      console.warn("[terrainRgb] Tilezen tile fetch failed (no Mapbox fallback — token not configured):", err);
      return null;
    }
  }

  if (!token) return null;

  try {
    const tile = await fetchTile(clampedZoom, tileX, tileY, token);
    return sampleTileBilinear(tile, tileX, tileY, lng, lat, clampedZoom);
  } catch (err) {
    console.warn("[terrainRgb] Mapbox terrain-rgb fallback also failed:", err);
    return null;
  }
}

export interface BuildDemOptions {
  bounds: DEMBounds;
  /** Output grid resolution. */
  targetWidth: number;
  targetHeight: number;
  /** Mapbox access token. Only consumed by the Mapbox terrain-rgb path. */
  token: string;
  /** Overrides DEFAULT_MAX_TILES_PER_REQUEST; coverage Detail tiers trade network for finer terrain. */
  maxTiles?: number;
}

/** Tile source for DEM attribution. */
export type DemSource = "tilezen" | "mapbox-terrain-rgb";

/** Try Tilezen; fall back to Mapbox terrain-rgb when a token is configured. Returns source tag for attribution. */
export async function buildDem(opts: BuildDemOptions): Promise<{ dem: DEM; source: DemSource }> {
  try {
    const dem = await buildDemFromTilezen(opts);
    return { dem, source: "tilezen" };
  } catch (err) {
    if (!opts.token) {
      console.warn("[terrainRgb] Bulk DEM from Tilezen failed (no Mapbox fallback — token not configured):", err);
      throw err;
    }
    console.warn(
      "[terrainRgb] Bulk DEM from Tilezen failed, falling back to Mapbox terrain-rgb:",
      err,
    );
    const dem = await buildDemFromTerrainRgb(opts);
    return { dem, source: "mapbox-terrain-rgb" };
  }
}

/** Stitch terrain tiles for bounds, bilinear-resample to target grid. Per-tile failures → NaN pixels. */
export async function buildDemFromTerrainRgb(opts: BuildDemOptions): Promise<DEM> {
  const { bounds, targetWidth, targetHeight, token } = opts;
  const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES_PER_REQUEST;

  // Tile pixels ≈ output pixels, clamped by tile-count cap
  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    ((bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180));
  const targetPixelSizeM = Math.max(1, bboxWidthM / targetWidth);
  const zoom = selectZoom(bounds, targetPixelSizeM, DEFAULT_TILE_SIZE, MAX_ZOOM, maxTiles);

  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));
  const scale = Math.pow(2, zoom);


  // Parallel fetch; individual failures → null tile.
  // Antimeridian: wrap absolute x to canonical [0, scale) fetch index. See landcoverTiles.ts for rationale.
  // Pre-seed with null synchronously so the dedupe check sees in-flight tiles.
  const tileMap = new Map<string, CachedTile | null>();
  const jobs: Promise<void>[] = [];
  for (let x = xMin; x <= xMax; x++) {
    const fetchX = ((x % scale) + scale) % scale;
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${fetchX}/${y}`;
      if (tileMap.has(key)) continue;
      tileMap.set(key, null);
      jobs.push(
        fetchTile(zoom, fetchX, y, token)
          .then((t) => void tileMap.set(key, t))
          .catch((err) => {
            console.warn("[terrainRgb]", err);
            tileMap.set(key, null);
          }),
      );
    }
  }
  await Promise.all(jobs);

  // Bilinear resample; nearest-neighbor dropped narrow peaks (~500 m underread on CA buttes)
  const data = new Float32Array(targetWidth * targetHeight);

  // Pick tile size from any non-null tile; 256 fallback
  let tileSize = 256;
  for (const t of tileMap.values()) {
    if (t) { tileSize = t.size; break; }
  }

  /** Elevation at absolute tile-pixel (absX, absY) across stitched tiles. */
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

      // Any NaN corner → NaN output (no-data, not interpolated garbage)
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

/** Tilezen twin of buildDemFromTerrainRgb. 256 px tiles, max z=15. */
export async function buildDemFromTilezen(opts: BuildDemOptions): Promise<DEM> {
  const { bounds, targetWidth, targetHeight } = opts;
  const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES_PER_REQUEST;

  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    ((bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180));
  const targetPixelSizeM = Math.max(1, bboxWidthM / targetWidth);
  const TILEZEN_TILE_SIZE = 256;
  const zoom = selectZoom(bounds, targetPixelSizeM, TILEZEN_TILE_SIZE, TILEZEN_MAX_ZOOM, maxTiles);

  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));

  // buildDem's Tilezen→Mapbox fallback relies on throwing when >half the tiles fail
  const tileMap = new Map<string, CachedTile | null>();
  let failureCount = 0;
  const jobs: Promise<void>[] = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${x}/${y}`;
      jobs.push(
        fetchTilezenTile(zoom, x, y)
          .then((t) => void tileMap.set(key, t))
          .catch((err) => {
            failureCount += 1;
            console.warn("[terrainRgb/tilezen]", err);
            tileMap.set(key, null);
          }),
      );
    }
  }
  await Promise.all(jobs);

  const totalTiles = (xMax - xMin + 1) * (yMax - yMin + 1);
  // >50% failure → throw so buildDem falls back to Mapbox
  if (failureCount > totalTiles / 2) {
    throw new Error(
      `tilezen bulk DEM failed: ${failureCount}/${totalTiles} tiles errored`,
    );
  }

  const data = new Float32Array(targetWidth * targetHeight);
  const scale = Math.pow(2, zoom);

  let tileSize = TILEZEN_TILE_SIZE;
  for (const t of tileMap.values()) {
    if (t) { tileSize = t.size; break; }
  }

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
