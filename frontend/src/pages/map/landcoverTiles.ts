/**
 * Land-cover (NLCD) tile fetcher. Tiles are produced by scripts/landcover_tiles.py
 * and served at /tiles/landcover/{z}/{x}/{y}.png. Encoding: R = NLCD class ID,
 * A = 0/255 for nodata/valid, G/B reserved. A 404 means the tile is outside the
 * bake bbox; the per-pixel fallback uses NLCD_DEFAULT_CLASS_ID.
 */
import { env } from "../../env";
import { NLCD_DEFAULT_CLASS_ID } from "./clutterClasses";
import type { DEMBounds } from "./terrainDEM";

const TILE_SIZE = 256;
const MIN_ZOOM = 0;
/** Matches the bake's default ceiling; z=12 ≈ 10 m/px at lat 37, NLCD is 30 m native. */
const MAX_ZOOM = 12;
const DEFAULT_MAX_TILES_PER_REQUEST = 256;

function tileBaseUrl(): string {
  const apiBase = env.API_BASE_URL ?? window.location.origin;
  return `${apiBase}/tiles/landcover`;
}

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
}

// 256 tiles × 256² × 1B ≈ 16 MB worst case.
const tileCache = new LandcoverTileLRU(256);

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
  const res = await fetch(url);
  if (res.status === 404) {
    tileCache.set(key, TILE_MISSING);
    return TILE_MISSING;
  }
  if (!res.ok) {
    throw new Error(`landcover tile fetch failed ${z}/${x}/${y}: HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (w !== h) {
      throw new Error(`landcover tile ${key} has non-square dimensions ${w}x${h}`);
    }
    if (w !== TILE_SIZE) {
      throw new Error(`landcover tile ${key} unexpected size ${w} (want ${TILE_SIZE})`);
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    const data = new Uint8Array(w * h);
    for (let i = 0, n = data.length; i < n; i++) {
      const o = i * 4;
      data[i] = px[o + 3] === 0 ? 0 : px[o];
    }
    const tile: CachedLandcoverTile = { data, size: w };
    tileCache.set(key, tile);
    return tile;
  } finally {
    bitmap.close();
  }
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
  const tilesTotal = (xMax - xMin + 1) * (yMax - yMin + 1);

  const tileMap = new Map<string, CachedLandcoverTile>();
  const jobs: Promise<void>[] = [];
  // Antimeridian: bbox may straddle ±180 (xMin/xMax outside [0, scale)). Wrap
  // each absolute x to a canonical fetch index so URLs stay valid; the lookup
  // applies the same wrap. Pre-seed the map synchronously — the .then() that
  // writes the real value runs later, so the dedupe check needs the placeholder.
  for (let x = xMin; x <= xMax; x++) {
    const fetchX = ((x % scale) + scale) % scale;
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${fetchX}/${y}`;
      if (tileMap.has(key)) continue;
      tileMap.set(key, TILE_MISSING);
      jobs.push(
        fetchLandcoverTile(zoom, fetchX, y)
          .then((t) => void tileMap.set(key, t))
          .catch((err) => {
            console.warn("[landcoverTiles]", err);
            tileMap.set(key, TILE_MISSING);
          }),
      );
    }
  }
  await Promise.all(jobs);

  let tilesPresent = 0;
  for (const t of tileMap.values()) {
    if (t !== TILE_MISSING && t.data.length > 0) tilesPresent++;
  }

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
      bounds.north - ((bounds.north - bounds.south) * j) / (targetHeight - 1);
    const absY = lat2tileY(lat, zoom) * TILE_SIZE;
    const yIdx = Math.floor(absY);

    for (let i = 0; i < targetWidth; i++) {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * i) / (targetWidth - 1);
      const absX = lng2tileX(lng, zoom) * TILE_SIZE;
      const xIdx = Math.floor(absX);

      const cls = lookup(xIdx, yIdx);
      if (cls !== 0) data[j * targetWidth + i] = cls;
    }
  }

  return { data, width: targetWidth, height: targetHeight, bounds, tilesPresent, tilesTotal };
}

/** Nearest-neighbor sample at lng/lat. Returns NLCD_DEFAULT_CLASS_ID for out-of-bounds. */
export function sampleClutterClassAt(
  raster: { data: Uint8Array; width: number; height: number; bounds: DEMBounds },
  lng: number,
  lat: number,
): number {
  const { width, height, bounds, data } = raster;
  const fx = ((lng - bounds.west) / (bounds.east - bounds.west)) * (width - 1);
  const fy = ((bounds.north - lat) / (bounds.north - bounds.south)) * (height - 1);
  if (fx < 0 || fx > width - 1 || fy < 0 || fy > height - 1) return NLCD_DEFAULT_CLASS_ID;
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
  };
}

/** Test-only. */
export function _resetLandcoverCacheForTests(): void {
  (tileCache as unknown as { cache: Map<string, unknown> }).cache.clear();
}
