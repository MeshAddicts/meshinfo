/**
 * Canopy-height tile fetcher; tiles produced by scripts/canopy_tiles.py.
 *
 * Encoding:
 *   R/G = canopy height (uint16 metres, R=high byte)
 *   B   = std-dev (uint8 metres; 0 when the bake skipped --include-stddev)
 *   A   = 255 valid, 0 nodata
 *
 * A=255 with height=0 is a real "no canopy here" measurement (clearings,
 * fire scars); A=0 means the bake didn't cover this region and the consumer
 * should fall back to class-nominal heights.
 */
import { env } from "../../env";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { DEMBounds } from "./terrainDEM";
import { decodeTilePixels } from "./tileDecode";

const TILE_SIZE = 256;
const MIN_ZOOM = 0;
/** Matches the bake's default ceiling. ETH source is 10 m native; z=12 is ~30 m/px
 *  at lat 37, so tiles are ~3× downsampled. Higher max-zoom = exponentially more
 *  disk; bump together with the bake's --zooms ceiling if you need native detail. */
const MAX_ZOOM = 12;
const DEFAULT_MAX_TILES_PER_REQUEST = 256;

function tileBaseUrl(): string {
  const apiBase = env.API_BASE_URL ?? window.location.origin;
  return `${apiBase}/tiles/canopy`;
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

export function selectCanopyZoom(
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
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    if (tileCountForBounds(bounds, z) <= maxTiles) return z;
  }
  return MIN_ZOOM;
}

export interface CachedCanopyTile {
  /** Row-major canopy heights in metres, length TILE_SIZE². 0 where mask is 0 too. */
  height: Uint16Array;
  /** Row-major std-dev metres; all zero if --include-stddev was off in the bake. */
  std: Uint8Array;
  /** Row-major valid mask: 255 = measured, 0 = nodata (fall back to class-nominal). */
  mask: Uint8Array;
  size: number;
}

/** Sentinel for 404'd tiles, distinct from "not yet attempted." */
export const TILE_MISSING: CachedCanopyTile = Object.freeze({
  height: new Uint16Array(0),
  std: new Uint8Array(0),
  mask: new Uint8Array(0),
  size: TILE_SIZE,
}) as CachedCanopyTile;

class CanopyTileLRU {
  private cache = new Map<string, CachedCanopyTile>();
  constructor(private readonly maxEntries: number) {}

  get(key: string): CachedCanopyTile | undefined {
    const v = this.cache.get(key);
    if (!v) return undefined;
    this.cache.delete(key);
    this.cache.set(key, v);
    return v;
  }

  set(key: string, tile: CachedCanopyTile): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, tile);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

// 256 tiles × 256² × (2 + 1 + 1) ≈ 64 MB worst case (height u16 + std u8 + mask u8).
const tileCache = new CanopyTileLRU(256);

/** R/G = uint16 height (R=high byte), B = uint8 std-dev, A = mask. */
function decodeCanopyPixels(
  px: Uint8ClampedArray,
  n: number,
): { height: Uint16Array; std: Uint8Array; mask: Uint8Array } {
  const height = new Uint16Array(n);
  const std = new Uint8Array(n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const valid = px[o + 3] !== 0;
    mask[i] = valid ? 255 : 0;
    if (valid) {
      height[i] = (px[o] << 8) | px[o + 1];
      std[i] = px[o + 2];
    }
  }
  return { height, std, mask };
}

export async function fetchCanopyTile(
  z: number,
  x: number,
  y: number,
): Promise<CachedCanopyTile> {
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
    throw new Error(`canopy tile fetch failed ${z}/${x}/${y}: HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const { width: w, height: h, data: px } = await decodeTilePixels(blob);
  if (w !== h || w !== TILE_SIZE) {
    throw new Error(`canopy tile ${key} unexpected size ${w}x${h} (want ${TILE_SIZE})`);
  }
  const { height, std, mask } = decodeCanopyPixels(px, w * h);
  const tile: CachedCanopyTile = { height, std, mask, size: w };
  tileCache.set(key, tile);
  return tile;
}

export interface BuildCanopyRasterOptions {
  bounds: DEMBounds;
  targetWidth: number;
  targetHeight: number;
  maxTiles?: number;
}

export interface CanopyRaster {
  /** Row-major canopy height in metres. 0 where mask is 0 (frontend uses class-nominal then). */
  heightM: Float32Array;
  /** Row-major std-dev metres. 0 when bake didn't include SD or pixel is nodata. */
  stdM: Float32Array;
  /** Row-major 1 = measured, 0 = nodata. Float32 to keep bilinear math simple. */
  mask: Float32Array;
  width: number;
  height: number;
  bounds: DEMBounds;
  tilesPresent: number;
  tilesTotal: number;
}

/**
 * Build a height raster covering `bounds` at `targetWidth × targetHeight`.
 * Weighted bilinear over valid neighbours; missing tiles → mask = 0 and the
 * consumer falls back to class-nominal at those pixels.
 */
export async function buildCanopyRaster(
  opts: BuildCanopyRasterOptions,
): Promise<CanopyRaster> {
  const { bounds, targetWidth, targetHeight } = opts;
  const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES_PER_REQUEST;

  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    (bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const targetPixelSizeM = Math.max(1, bboxWidthM / targetWidth);
  const zoom = selectCanopyZoom(bounds, targetPixelSizeM, maxTiles);

  const xMin = Math.floor(lng2tileX(bounds.west, zoom));
  const xMax = Math.floor(lng2tileX(bounds.east, zoom));
  const yMin = Math.floor(lat2tileY(bounds.north, zoom));
  const yMax = Math.floor(lat2tileY(bounds.south, zoom));
  const scale = Math.pow(2, zoom);

  const tileMap = new Map<string, CachedCanopyTile>();
  const jobs: Promise<void>[] = [];
  // Antimeridian wrap + sync pre-seed for in-flight dedupe — see landcoverTiles.ts.
  for (let x = xMin; x <= xMax; x++) {
    const fetchX = ((x % scale) + scale) % scale;
    for (let y = yMin; y <= yMax; y++) {
      const key = `${zoom}/${fetchX}/${y}`;
      if (tileMap.has(key)) continue;
      tileMap.set(key, TILE_MISSING);
      jobs.push(
        fetchCanopyTile(zoom, fetchX, y)
          .then((t) => void tileMap.set(key, t))
          .catch((err) => {
            console.warn("[canopyTiles]", err);
            tileMap.set(key, TILE_MISSING);
          }),
      );
    }
  }
  await Promise.all(jobs);

  // Deduped tile count (seam-straddling bbox wraps to shared fetch indices).
  const tilesTotal = tileMap.size;
  let tilesPresent = 0;
  for (const t of tileMap.values()) {
    if (t !== TILE_MISSING && t.height.length > 0) tilesPresent++;
  }

  const n = targetWidth * targetHeight;
  const heightOut = new Float32Array(n);
  const stdOut = new Float32Array(n);
  const maskOut = new Float32Array(n);

  /** Sample (h, s, m) at a fractional tile-pixel coord. m=0 if no valid neighbour. */
  const sampleAt = (absX: number, absY: number): [number, number, number] => {
    const x0 = Math.floor(absX);
    const y0 = Math.floor(absY);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = absX - x0;
    const fy = absY - y0;

    const get = (ax: number, ay: number): [number, number, number] => {
      const tileX = Math.floor(ax / TILE_SIZE);
      const tileY = Math.floor(ay / TILE_SIZE);
      const px = ax - tileX * TILE_SIZE;
      const py = ay - tileY * TILE_SIZE;
      if (px < 0 || py < 0 || px >= TILE_SIZE || py >= TILE_SIZE) return [0, 0, 0];
      const xWrapped = ((tileX % scale) + scale) % scale;
      const t = tileMap.get(`${zoom}/${xWrapped}/${tileY}`);
      if (!t || t === TILE_MISSING || t.height.length === 0) return [0, 0, 0];
      const idx = py * TILE_SIZE + px;
      const m = t.mask[idx];
      if (m === 0) return [0, 0, 0];
      return [t.height[idx], t.std[idx], 1];
    };

    const [h00, s00, m00] = get(x0, y0);
    const [h10, s10, m10] = get(x1, y0);
    const [h01, s01, m01] = get(x0, y1);
    const [h11, s11, m11] = get(x1, y1);

    const w00 = (1 - fx) * (1 - fy) * m00;
    const w10 = fx * (1 - fy) * m10;
    const w01 = (1 - fx) * fy * m01;
    const w11 = fx * fy * m11;
    const wSum = w00 + w10 + w01 + w11;
    if (wSum <= 0) return [0, 0, 0];
    const h = (h00 * w00 + h10 * w10 + h01 * w01 + h11 * w11) / wSum;
    const s = (s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11) / wSum;
    return [h, s, 1];
  };

  for (let j = 0; j < targetHeight; j++) {
    const lat =
      bounds.north - ((bounds.north - bounds.south) * j) / Math.max(1, targetHeight - 1);
    const absY = lat2tileY(lat, zoom) * TILE_SIZE - 0.5;
    for (let i = 0; i < targetWidth; i++) {
      const lng =
        bounds.west + ((bounds.east - bounds.west) * i) / Math.max(1, targetWidth - 1);
      const absX = lng2tileX(lng, zoom) * TILE_SIZE - 0.5;
      const [h, s, m] = sampleAt(absX, absY);
      const k = j * targetWidth + i;
      heightOut[k] = h;
      stdOut[k] = s;
      maskOut[k] = m;
    }
  }

  return {
    heightM: heightOut,
    stdM: stdOut,
    mask: maskOut,
    width: targetWidth,
    height: targetHeight,
    bounds,
    tilesPresent,
    tilesTotal,
  };
}

/**
 * Bilinear sample of canopy height at lng/lat. Returns null only when every
 * neighbour pixel is masked off (or the query is outside the raster). One
 * valid neighbour is enough — canopy edge cases benefit from interpolating
 * from any available data rather than falling back to class-nominal.
 */
export interface CanopySample {
  heightM: number;
  stdM: number;
}

export function sampleCanopyAt(
  raster: { heightM: Float32Array; stdM: Float32Array; mask: Float32Array; width: number; height: number; bounds: DEMBounds },
  lng: number,
  lat: number,
): CanopySample | null {
  const { width, height, bounds, heightM, stdM, mask } = raster;
  const fx = ((lng - bounds.west) / (bounds.east - bounds.west)) * (width - 1);
  const fy = ((bounds.north - lat) / (bounds.north - bounds.south)) * (height - 1);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > width - 1 || fy < 0 || fy > height - 1) return null;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const k00 = y0 * width + x0;
  const k10 = y0 * width + x1;
  const k01 = y1 * width + x0;
  const k11 = y1 * width + x1;

  const m00 = mask[k00], m10 = mask[k10], m01 = mask[k01], m11 = mask[k11];
  const w00 = (1 - tx) * (1 - ty) * m00;
  const w10 = tx * (1 - ty) * m10;
  const w01 = (1 - tx) * ty * m01;
  const w11 = tx * ty * m11;
  const wSum = w00 + w10 + w01 + w11;
  if (wSum <= 0) return null;

  const h = (heightM[k00] * w00 + heightM[k10] * w10 + heightM[k01] * w01 + heightM[k11] * w11) / wSum;
  const s = (stdM[k00] * w00 + stdM[k10] * w10 + stdM[k01] * w01 + stdM[k11] * w11) / wSum;
  return { heightM: h, stdM: s };
}

/** Bilinear downsample over the same bounds. */
export function downsampleCanopyRaster(
  src: CanopyRaster,
  newWidth: number,
  newHeight: number,
): CanopyRaster {
  const heightOut = new Float32Array(newWidth * newHeight);
  const stdOut = new Float32Array(newWidth * newHeight);
  const maskOut = new Float32Array(newWidth * newHeight);
  for (let j = 0; j < newHeight; j++) {
    const lat =
      src.bounds.north -
      ((src.bounds.north - src.bounds.south) * j) / Math.max(1, newHeight - 1);
    for (let i = 0; i < newWidth; i++) {
      const lng =
        src.bounds.west +
        ((src.bounds.east - src.bounds.west) * i) / Math.max(1, newWidth - 1);
      const k = j * newWidth + i;
      const sample = sampleCanopyAt(src, lng, lat);
      if (sample) {
        heightOut[k] = sample.heightM;
        stdOut[k] = sample.stdM;
        maskOut[k] = 1;
      }
    }
  }
  return {
    heightM: heightOut,
    stdM: stdOut,
    mask: maskOut,
    width: newWidth,
    height: newHeight,
    bounds: src.bounds,
    tilesPresent: src.tilesPresent,
    tilesTotal: src.tilesTotal,
  };
}

/** Test-only. */
export function _resetCanopyCacheForTests(): void {
  (tileCache as unknown as { cache: Map<string, unknown> }).cache.clear();
}

/** Test-only. */
export function _canopyCacheSizeForTests(): number {
  return (tileCache as unknown as { cache: Map<string, unknown> }).cache.size;
}

/** Test-only. Inject a cached tile without going through fetch/Canvas. */
export function _putCanopyTileForTests(z: number, x: number, y: number, tile: CachedCanopyTile): void {
  tileCache.set(`${z}/${x}/${y}`, tile);
}

/** Test-only. Direct byte-decode access for round-trip pixel tests. */
export function _decodeCanopyPixelsForTests(
  px: Uint8ClampedArray,
  n: number,
): { height: Uint16Array; std: Uint8Array; mask: Uint8Array } {
  return decodeCanopyPixels(px, n);
}
