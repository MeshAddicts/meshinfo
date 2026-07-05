/** Disk cache of per-node rendered margin grids (the expensive ITM artifact),
 *  keyed by quantized node state. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DEMBounds } from "../src/pages/map/terrain/terrainDEM";
import type { CoverageOrigin } from "./nodes";

/** dB = (q − 1) / 4 − 20 for q ≥ 1; q = 0 is NaN. The −20..+43.5 dB clamp is
 *  lossless for colorize (transparent < 0, saturated ≥ 25). */
export interface MarginGridQ8 {
  data: Uint8Array;
  width: number;
  height: number;
  bounds: DEMBounds;
}

export interface NodeCacheHeader {
  id: string;
  stateKey: string;
  contextKey: string;
  width: number;
  height: number;
  bounds: DEMBounds;
  /** Accuracy sources the margin was rendered with (e.g. ["itm","nlcd"]). A
   *  cached grid is only reusable when this matches the current output's
   *  sources — otherwise a node absent during a sources change would re-enter
   *  with a stale clutter-free grid. */
  sources?: string[];
}

/** Every .bin starts with the 16-char stateKey it was rendered for, so readers
 *  can detect a bin swapped under a stale in-memory header (same dimensions,
 *  different position) instead of sampling through the wrong bounds. */
export const GRID_PREFIX_BYTES = 16;

/** One composited node in the current output: its stateKey plus the footprint
 *  actually painted on disk. Keeping bounds here (not just in the margin cache)
 *  means a moved/removed node's old footprint can always be erased, even after
 *  a failed bake overwrote its cache entry. */
export interface ActiveNodeState {
  key: string;
  bounds: DEMBounds;
}

export interface CacheState {
  contextKey: string;
  /** id → state of every node composited into the current output. */
  active: Record<string, ActiveNodeState>;
  /** Accuracy sources of the current output (reused by raster-free delta bakes). */
  sources?: string[];
  /** Sticky render bbox [west, south, east, north] — kept while nodes fit inside.
   *  May be unwrapped past ±180 for a seam-straddling mesh. */
  bbox?: [number, number, number, number];
}

export function hashKey(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function originStateKey(o: CoverageOrigin): string {
  return hashKey(o.id, o.lng, o.lat, o.altitudeM ?? "_", o.txDbm, o.reachKm, o.preset);
}

export function quantizeMargin(m: Float32Array): Uint8Array {
  const q = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    if (!Number.isNaN(v)) q[i] = Math.max(1, Math.min(255, 1 + Math.round((v + 20) * 4)));
  }
  return q;
}

/**
 * Project lng/lat onto a pixel-CENTER-registered grid: renderCoverageRaster
 * samples pixel i at west + (i + 0.5) * step with step = extent / width, so the
 * inverse is (lng − west) / step − 0.5 (NOT the corner-registered (width − 1)
 * mapping the DEM uses). Longitude is shifted ±360 into the bounds frame first
 * so seam-crossing footprints resolve. Returns fractional pixel coords clamped
 * to the edge pixel centers, or null outside the bounds.
 */
export function gridFraction(
  bounds: DEMBounds,
  width: number,
  height: number,
  lng: number,
  lat: number,
): { fx: number; fy: number } | null {
  const { west, south, east, north } = bounds;
  const sLng = lng < west ? lng + 360 : lng > east ? lng - 360 : lng;
  const fx = ((sLng - west) / (east - west)) * width - 0.5;
  const fy = ((north - lat) / (north - south)) * height - 0.5;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  if (fx < -0.5 || fx > width - 0.5 || fy < -0.5 || fy > height - 0.5) return null;
  return {
    fx: Math.min(width - 1, Math.max(0, fx)),
    fy: Math.min(height - 1, Math.max(0, fy)),
  };
}

/** Bilinear blend of four quantized corners (0 = NaN sentinel) → margin dB. */
export function bilinearMarginQ8(
  q00: number,
  q10: number,
  q01: number,
  q11: number,
  tx: number,
  ty: number,
): number {
  if (q00 === 0 || q10 === 0 || q01 === 0 || q11 === 0) return Number.NaN;
  const top = q00 + (q10 - q00) * tx;
  const bot = q01 + (q11 - q01) * tx;
  return (top + (bot - top) * ty - 1) / 4 - 20;
}

/** Bilinear margin sample at lng/lat; NaN outside bounds or at NaN corners. */
export function marginQ8At(g: MarginGridQ8, lng: number, lat: number): number {
  const f = gridFraction(g.bounds, g.width, g.height, lng, lat);
  if (!f) return Number.NaN;
  const x0 = Math.floor(f.fx);
  const y0 = Math.floor(f.fy);
  const x1 = Math.min(x0 + 1, g.width - 1);
  const y1 = Math.min(y0 + 1, g.height - 1);
  return bilinearMarginQ8(
    g.data[y0 * g.width + x0],
    g.data[y0 * g.width + x1],
    g.data[y1 * g.width + x0],
    g.data[y1 * g.width + x1],
    f.fx - x0,
    f.fy - y0,
  );
}

const nodesDir = (dir: string) => join(dir, "nodes");
const fileBase = (dir: string, id: string) => join(nodesDir(dir), hashKey(id));

export async function readNodeHeader(dir: string, id: string): Promise<NodeCacheHeader | null> {
  try {
    const h = JSON.parse(await readFile(`${fileBase(dir, id)}.json`, "utf8")) as NodeCacheHeader;
    return h.id === id ? h : null; // guards truncated-hash filename collisions
  } catch {
    return null;
  }
}

export async function readNodeGrid(dir: string, id: string): Promise<MarginGridQ8 | null> {
  const h = await readNodeHeader(dir, id);
  if (!h) return null;
  try {
    const buf = await readFile(`${fileBase(dir, id)}.bin`);
    if (buf.length !== GRID_PREFIX_BYTES + h.width * h.height) return null;
    if (buf.subarray(0, GRID_PREFIX_BYTES).toString("utf8") !== h.stateKey) return null;
    return {
      data: new Uint8Array(buf.subarray(GRID_PREFIX_BYTES)),
      width: h.width,
      height: h.height,
      bounds: h.bounds,
    };
  } catch {
    return null;
  }
}

/** Atomic (tmp + rename) so a concurrent lookup never reads a torn grid;
 *  bin lands before header so header/bin pairing stays consistent. */
export async function writeNode(dir: string, header: NodeCacheHeader, data: Uint8Array): Promise<void> {
  await mkdir(nodesDir(dir), { recursive: true });
  const base = fileBase(dir, header.id);
  await writeFile(`${base}.bin.tmp`, Buffer.concat([Buffer.from(header.stateKey, "utf8"), data]));
  await rename(`${base}.bin.tmp`, `${base}.bin`);
  await writeFile(`${base}.json.tmp`, JSON.stringify(header));
  await rename(`${base}.json.tmp`, `${base}.json`);
}

/** Drop a cache entry; the node re-renders next bake. */
export async function removeNode(dir: string, id: string): Promise<void> {
  const base = fileBase(dir, id);
  await rm(`${base}.json`, { force: true });
  await rm(`${base}.bin`, { force: true });
}

export async function loadState(dir: string): Promise<CacheState | null> {
  try {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as CacheState;
  } catch {
    return null;
  }
}

export async function saveState(dir: string, state: CacheState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
}

/** Drop cache entries for nodes not active and not touched within maxAgeDays. */
export async function pruneCache(dir: string, activeIds: Set<string>, maxAgeDays: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(nodesDir(dir));
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const base = join(nodesDir(dir), name.slice(0, -5));
    try {
      const h = JSON.parse(await readFile(`${base}.json`, "utf8")) as NodeCacheHeader;
      if (activeIds.has(h.id)) continue;
      const { mtimeMs } = await stat(`${base}.bin`);
      if (mtimeMs < cutoff) {
        // header first: header-without-bin classifies as reusable, then fails to load
        await rm(`${base}.json`, { force: true });
        await rm(`${base}.bin`, { force: true });
      }
    } catch {
      // unreadable entry: remove both halves
      await rm(`${base}.bin`, { force: true });
      await rm(`${base}.json`, { force: true });
    }
  }
}
