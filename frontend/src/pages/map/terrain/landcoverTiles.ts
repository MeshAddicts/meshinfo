/**
 * Land-cover (NLCD) tile fetcher. Tiles are produced by scripts/landcover_tiles.py
 * and served at /tiles/landcover/{z}/{x}/{y}.png. Encoding: R = NLCD class ID,
 * A = 0/255 for nodata/valid, G/B reserved. A 404 means the tile is outside the
 * bake bbox; the per-pixel fallback uses NLCD_DEFAULT_CLASS_ID.
 */
import { env } from "../../../env";
import { NLCD_DEFAULT_CLASS_ID } from "../rf/clutterClasses";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { DEMBounds } from "./terrainDEM";
import { decodeTilePixels } from "./tileDecode";
import { fetchTilesPooled } from "./tileFetchPool";
import { lat2tileY, lng2tileX } from "./webMercator";

const TILE_SIZE = 256;
const MIN_ZOOM = 0;
/** Matches the bake's default ceiling; z=12 ≈ 10 m/px at lat 37, NLCD is 30 m native. */
const MAX_ZOOM = 12;
const DEFAULT_MAX_TILES_PER_REQUEST = 256;

function tileBaseUrl(): string {
  // globalThis, not window — also runs inside the raster-build worker
  const apiBase = env.API_BASE_URL ?? globalThis.location.origin;
  return `${apiBase}/tiles/landcover`;
}

function tileMetersPerPixel(lat: number, zoom: number, tileSize: number): number {
  const equatorCircumferenceM = 40_075_017;
  return (equatorCircumferenceM * Math.cos((lat * Math.PI) / 180)) / (tileSize * Math.pow(2, zoom));
}

function tileCountForBounds(bounds: DEMBounds, zoom: number): number {
  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}

/** Highest zoom (≤ MAX_ZOOM) where m/px ≤ targetPixelSizeM and tile count ≤ maxTiles. */
export function selectLandcoverZoom(
  bounds: DEMBounds,
  targetPixelSizeM: number,
  maxTiles: number = DEFAULT_MAX_TILES_PER_REQUEST,
): number {
  const midLat = (bounds.north + bounds.south) / 2;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const res = tileMetersPerPixel(midLat, z, TILE_SIZE);
    if (res > targetPixelSizeM) continue;
    if (tileCountForBounds(bounds, z) <= maxTiles) return z;
  }
  // Fallback: coarsest zoom with tolerable tile count
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    if (tileCountForBounds(bounds, z) <= maxTiles) return z;
  }
  return MIN_ZOOM;
}

export interface CachedLandcoverTile {
  /** Row-major class IDs, length TILE_SIZE². 0 = nodata. */
  data: Uint8Array;
  size: number;
}

/** Sentinel for 404'd tiles, distinct from "not yet attempted." */
export const TILE_MISSING: CachedLandcoverTile = Object.freeze({
  data: new Uint8Array(0),
  size: TILE_SIZE,
}) as CachedLandcoverTile;

class LandcoverTileLRU {
  private cache = new Map<string, CachedLandcoverTile>();
  constructor(private readonly maxEntries: number) {}

  get(key: string): CachedLandcoverTile | undefined {
    const v = this.cache.get(key);
    if (!v) return undefined;
    this.cache.delete(key);
    this.cache.set(key, v);
    return v;
  }

  set(key: string, tile: CachedLandcoverTile): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, tile);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  evictWhere(pred: (tile: CachedLandcoverTile) => boolean): void {
    for (const [k, v] of this.cache) {
      if (pred(v)) this.cache.delete(k);
    }
  }
}

// 256 tiles × 256² × 1B ≈ 16 MB worst case.
const tileCache = new LandcoverTileLRU(256);

/** Drop cached 404 sentinels so a bake completed after them gets re-requested
 *  (the coverage-worker re-probes for missing layers on a long-lived process). */
export function evictMissingLandcoverTiles(): void {
  tileCache.evictWhere((t) => t === TILE_MISSING);
}

/** Returns TILE_MISSING for 404 (not an error). */
export async function fetchLandcoverTile(
  z: number,
  x: number,
  y: number,
): Promise<CachedLandcoverTile> {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;

  const url = `${tileBaseUrl()}/${z}/${x}/${y}.png`;
  const res = await fetchWithTimeout(url);
  if (res.status === 404) {
    tileCache.set(key, TILE_MISSING);
    return TILE_MISSING;
  }
  if (!res.ok) {
    throw new Error(`landcover tile fetch failed ${z}/${x}/${y}: HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const { width: w, height: h, data: px } = await decodeTilePixels(blob);
  if (w !== h) {
    throw new Error(`landcover tile ${key} has non-square dimensions ${w}x${h}`);
  }
  if (w !== TILE_SIZE) {
    throw new Error(`landcover tile ${key} unexpected size ${w} (want ${TILE_SIZE})`);
  }
  const data = new Uint8Array(w * h);
  for (let i = 0, n = data.length; i < n; i++) {
    const o = i * 4;
    data[i] = px[o + 3] === 0 ? 0 : px[o];
  }
  const tile: CachedLandcoverTile = { data, size: w };
  tileCache.set(key, tile);
  return tile;
}

export interface BuildClutterRasterOptions {
  bounds: DEMBounds;
  targetWidth: number;
  targetHeight: number;
  maxTiles?: number;
}

export interface ClutterRaster {
  /** Row-major class IDs. NLCD_DEFAULT_CLASS_ID where the source had no data or the tile 404'd. */
  data: Uint8Array;
  width: number;
  height: number;
  bounds: DEMBounds;
  /** For telemetry + UI fallback indicator. */
  tilesPresent: number;
  tilesTotal: number;
  /** Tiles that errored (network/5xx), as opposed to 404 = not baked. Lets the
   *  coverage-worker tell an outage from a legitimately absent layer. */
  tilesFailed?: number;
}

/**
 * Class-ID raster covering `bounds`. Nearest-neighbor (categorical IDs;
 * bilinear would invent non-existent IDs). Missing tiles → NLCD_DEFAULT_CLASS_ID.
 * Never throws on 404 — that's the out-of-bbox path.
 */
export async function buildClutterRaster(
  opts: BuildClutterRasterOptions,
): Promise<ClutterRaster> {
  const { bounds, targetWidth, targetHeight } = opts;
  const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES_PER_REQUEST;

  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    (bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const targetPixelSizeM = Math.max(1, bboxWidthM / targetWidth);
  const zoom = selectLandcoverZoom(bounds, targetPixelSizeM, maxTiles);

  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));
  const scale = Math.pow(2, zoom);

  const tileMap = new Map<string, CachedLandcoverTile>();
  // Antimeridian: bbox may straddle ±180 (xMin/xMax outside [0, scale)). Wrap
  // each absolute x to a canonical fetch index so URLs stay valid; the lookup
  // applies the same wrap. Pre-seed the map synchronously so dedupe sees it.
  const wanted: Array<{ key: string; x: number; y: number }> = [];
  for (let x = xMin; x <= xMax; x++) {
    const fetchX = ((x % scale) + scale) % scale;
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${fetchX}/${y}`;
      if (tileMap.has(key)) continue;
      tileMap.set(key, TILE_MISSING);
      wanted.push({ key, x: fetchX, y });
    }
  }
  const tilesFailed = await fetchTilesPooled(
    wanted,
    (x, y) => fetchLandcoverTile(zoom, x, y),
    tileMap,
    TILE_MISSING,
    "[landcoverTiles]",
  );

  let tilesPresent = 0;
  for (const t of tileMap.values()) {
    if (t !== TILE_MISSING && t.data.length > 0) tilesPresent++;
  }
  // Deduped count (a seam-straddling bbox wraps to shared fetch indices).
  const tilesTotal = tileMap.size;

  const data = new Uint8Array(targetWidth * targetHeight);
  data.fill(NLCD_DEFAULT_CLASS_ID);

  /** Class ID at absolute tile-pixel; 0 for missing/nodata. */
  const lookup = (absX: number, absY: number): number => {
    const tileX = Math.floor(absX / TILE_SIZE);
    const tileY = Math.floor(absY / TILE_SIZE);
    const px = absX - tileX * TILE_SIZE;
    const py = absY - tileY * TILE_SIZE;
    const xWrapped = ((tileX % scale) + scale) % scale;
    const t = tileMap.get(`${zoom}/${xWrapped}/${tileY}`);
    if (!t || t === TILE_MISSING || t.data.length === 0) return 0;
    return t.data[py * TILE_SIZE + px];
  };

  for (let j = 0; j < targetHeight; j++) {
    const lat =
      bounds.north - ((bounds.north - bounds.south) * j) / Math.max(1, targetHeight - 1);
    const absY = lat2tileY(lat, zoom) * TILE_SIZE;
    const yIdx = Math.floor(absY);

    for (let i = 0; i < targetWidth; i++) {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * i) / Math.max(1, targetWidth - 1);
      const absX = lng2tileX(lng, zoom) * TILE_SIZE;
      const xIdx = Math.floor(absX);

      const cls = lookup(xIdx, yIdx);
      if (cls !== 0) data[j * targetWidth + i] = cls;
    }
  }

  return { data, width: targetWidth, height: targetHeight, bounds, tilesPresent, tilesTotal, tilesFailed };
}

/** Nearest-neighbor sample at lng/lat. Returns NLCD_DEFAULT_CLASS_ID for out-of-bounds. */
export function sampleClutterClassAt(
  raster: { data: Uint8Array; width: number; height: number; bounds: DEMBounds },
  lng: number,
  lat: number,
): number {
  const { width, height, bounds, data } = raster;
  // Seam unwrap, matching sampleDEMAt: a [179,181] bbox must accept lng -179
  const sLng = lng < bounds.west ? lng + 360 : lng > bounds.east ? lng - 360 : lng;
  const fx = ((sLng - bounds.west) / (bounds.east - bounds.west)) * (width - 1);
  const fy = ((bounds.north - lat) / (bounds.north - bounds.south)) * (height - 1);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > width - 1 || fy < 0 || fy > height - 1) return NLCD_DEFAULT_CLASS_ID;
  const x = Math.round(fx);
  const y = Math.round(fy);
  return data[y * width + x];
}

/** Nearest-neighbor downsample over the same bounds. */
export function downsampleClutterRaster(
  src: ClutterRaster,
  newWidth: number,
  newHeight: number,
): ClutterRaster {
  const data = new Uint8Array(newWidth * newHeight);
  data.fill(NLCD_DEFAULT_CLASS_ID);
  for (let j = 0; j < newHeight; j++) {
    const lat =
      src.bounds.north -
      ((src.bounds.north - src.bounds.south) * j) / Math.max(1, newHeight - 1);
    for (let i = 0; i < newWidth; i++) {
      const lng =
        src.bounds.west +
        ((src.bounds.east - src.bounds.west) * i) / Math.max(1, newWidth - 1);
      data[j * newWidth + i] = sampleClutterClassAt(src, lng, lat);
    }
  }
  return {
    data,
    width: newWidth,
    height: newHeight,
    bounds: src.bounds,
    tilesPresent: src.tilesPresent,
    tilesTotal: src.tilesTotal,
    tilesFailed: src.tilesFailed,
  };
}

/** Test-only. */
export function _resetLandcoverCacheForTests(): void {
  (tileCache as unknown as { cache: Map<string, unknown> }).cache.clear();
}
