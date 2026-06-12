/** Disk cache of per-node rendered margin grids (the expensive ITM artifact),
 *  keyed by quantized node state. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DEMBounds } from "../src/pages/map/terrainDEM";
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
}

export interface CacheState {
  contextKey: string;
  /** id → stateKey of every node composited into the current output. */
  active: Record<string, string>;
  /** Accuracy sources of the current output (reused by raster-free delta bakes). */
  sources?: string[];
  /** Sticky render bbox [west, south, east, north] — kept while nodes fit inside. */
  bbox?: [number, number, number, number];
}

export function hashKey(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function originStateKey(o: CoverageOrigin): string {
  return hashKey(o.id, o.lng, o.lat, o.altitudeM ?? "_", o.txDbm, o.reachKm);
}

export function quantizeMargin(m: Float32Array): Uint8Array {
  const q = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    if (!Number.isNaN(v)) q[i] = Math.max(1, Math.min(255, 1 + Math.round((v + 20) * 4)));
  }
  return q;
}

/** Bilinear margin sample at lng/lat; NaN outside bounds or at NaN corners
 *  (mirrors terrainDEM.sampleDEMAt semantics). */
export function marginQ8At(g: MarginGridQ8, lng: number, lat: number): number {
  const { west, south, east, north } = g.bounds;
  const fx = ((lng - west) / (east - west)) * (g.width - 1);
  const fy = ((north - lat) / (north - south)) * (g.height - 1);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > g.width - 1 || fy < 0 || fy > g.height - 1) {
    return Number.NaN;
  }
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, g.width - 1);
  const y1 = Math.min(y0 + 1, g.height - 1);
  const q00 = g.data[y0 * g.width + x0];
  const q10 = g.data[y0 * g.width + x1];
  const q01 = g.data[y1 * g.width + x0];
  const q11 = g.data[y1 * g.width + x1];
  if (q00 === 0 || q10 === 0 || q01 === 0 || q11 === 0) return Number.NaN;
  const tx = fx - x0;
  const ty = fy - y0;
  const top = q00 + (q10 - q00) * tx;
  const bot = q01 + (q11 - q01) * tx;
  return (top + (bot - top) * ty - 1) / 4 - 20;
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
    if (buf.length !== h.width * h.height) return null;
    return { data: new Uint8Array(buf), width: h.width, height: h.height, bounds: h.bounds };
  } catch {
    return null;
  }
}

export async function writeNode(dir: string, header: NodeCacheHeader, data: Uint8Array): Promise<void> {
  await mkdir(nodesDir(dir), { recursive: true });
  const base = fileBase(dir, header.id);
  await writeFile(`${base}.bin`, data);
  await writeFile(`${base}.json`, JSON.stringify(header));
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
