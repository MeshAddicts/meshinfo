/** Incremental coverage bake: only changed nodes re-render (margins cached on
 *  disk), only affected tiles recomposite; cold start = everything new, same path. */
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { buildBuildingRaster } from "../src/pages/map/buildingTiles";
import { buildCanopyRaster } from "../src/pages/map/canopyTiles";
import { loadItmContext } from "../src/pages/map/itm";
import { buildClutterRaster } from "../src/pages/map/landcoverTiles";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { type DEMBounds, unionDemBoundsAround } from "../src/pages/map/terrainDEM";
import { buildDem } from "../src/pages/map/terrainRgb";
import { decodeTilePixels } from "../src/pages/map/tileDecode";
import {
  type CacheState,
  hashKey,
  loadState,
  type MarginGridQ8,
  type NodeCacheHeader,
  originStateKey,
  pruneCache,
  readNodeGrid,
  readNodeHeader,
  removeNode,
  saveState,
  writeNode,
} from "./cache";
import { colorizeMargin } from "./colorize";
import * as cfg from "./config";
import { TILE_SIZE } from "./mercator";
import {
  clampRect,
  compositeTileMargin,
  renderNodeMargin,
  type RenderSources,
  tileRectForBounds,
} from "./nodeRender";
import type { CoverageOrigin } from "./nodes";
import type { CompositedTile, CompositeInput, RenderedNode, RenderInput } from "./renderWorker";
import { encodePng } from "./sharpImage";

export interface BakeMetadata {
  version: string;
  generatedAt: string;
  bounds: [number, number, number, number]; // [west, south, east, north]
  minZoom: number;
  maxZoom: number;
  nodeCount: number;
  tileCount: number;
  recencyHours: number;
  sources: string[];
}

/** Copy a source's typed arrays into SharedArrayBuffers so workers share them zero-copy. */
function shareSources(src: RenderSources): RenderSources {
  const f = (a: Float32Array) => { const s = new Float32Array(new SharedArrayBuffer(a.byteLength)); s.set(a); return s; };
  const u = (a: Uint8Array) => { const s = new Uint8Array(new SharedArrayBuffer(a.byteLength)); s.set(a); return s; };
  return {
    dem: { ...src.dem, data: f(src.dem.data) },
    clutter: src.clutter ? { ...src.clutter, data: u(src.clutter.data) } : null,
    canopy: src.canopy
      ? { ...src.canopy, heightM: f(src.canopy.heightM), stdM: f(src.canopy.stdM), mask: f(src.canopy.mask) }
      : null,
    buildings: src.buildings ? { ...src.buildings, heightM: f(src.buildings.heightM), mask: f(src.buildings.mask) } : null,
    clutterAggression: src.clutterAggression,
  };
}

function sabGrid(g: MarginGridQ8): MarginGridQ8 {
  if (g.data.buffer instanceof SharedArrayBuffer) return g;
  const s = new Uint8Array(new SharedArrayBuffer(g.data.byteLength));
  s.set(g.data);
  g.data = s; // in place, so the non-shared copy is freed (halves composite peak)
  return g;
}

/** Snap outward to a coarse grid so frontier-node churn doesn't move the bbox
 *  (a bbox change invalidates the whole cache). */
function snapBounds(b: DEMBounds, step = 0.25): DEMBounds {
  return {
    west: Math.max(-180, Math.floor(b.west / step) * step),
    south: Math.max(-85, Math.floor(b.south / step) * step),
    east: Math.min(180, Math.ceil(b.east / step) * step),
    north: Math.min(85, Math.ceil(b.north / step) * step),
  };
}

/** Everything a cached margin depends on besides the node's own state. */
function contextKeyFor(bbox: DEMBounds): string {
  const paramsFp = JSON.stringify(buildLiveCoverageParams(0, 1)) + LIVE_ANTENNA_AGL_M;
  return hashKey(
    "v1",
    bbox.west.toFixed(4), bbox.south.toFixed(4), bbox.east.toFixed(4), bbox.north.toFixed(4),
    cfg.SHARED_DEM_SIZE, cfg.NODE_DEM_SIZE, cfg.CLUTTER_RASTER_SIZE,
    cfg.NODE_OUTPUT_MAX, cfg.OUTPUT_M_PER_PX, cfg.MAX_ZOOM, cfg.MIN_ZOOM,
    String(cfg.USE_CLUTTER), String(cfg.USE_CANOPY), String(cfg.USE_BUILDINGS),
    cfg.CLUTTER_AGGRESSION, paramsFp,
  );
}

/** Interleaved 16-bit Morton code of a position within the bbox. */
function mortonCode(o: CoverageOrigin, bbox: DEMBounds): number {
  const nx = Math.max(0, Math.min(0xffff, Math.floor(((o.lng - bbox.west) / (bbox.east - bbox.west)) * 0x10000)));
  const ny = Math.max(0, Math.min(0xffff, Math.floor(((o.lat - bbox.south) / (bbox.north - bbox.south)) * 0x10000)));
  let code = 0;
  for (let b = 0; b < 16; b++) code += ((nx >> b) & 1) * 2 ** (2 * b) + ((ny >> b) & 1) * 2 ** (2 * b + 1);
  return code;
}

/** Morton-sorted chunks balanced by estimated render cost (∝ reach²) — a router
 *  costs ~6× a client, and count-balanced chunks leave router-heavy stragglers. */
function partitionOrigins(origins: CoverageOrigin[], bbox: DEMBounds, k: number): CoverageOrigin[][] {
  const sorted = [...origins].sort((a, b) => mortonCode(a, bbox) - mortonCode(b, bbox));
  const cost = (o: CoverageOrigin) => o.reachKm * o.reachKm;
  const total = sorted.reduce((s, o) => s + cost(o), 0);
  const groups: CoverageOrigin[][] = [];
  let group: CoverageOrigin[] = [];
  let acc = 0;
  for (const o of sorted) {
    group.push(o);
    acc += cost(o);
    if (acc >= total / k && groups.length < k - 1) {
      groups.push(group);
      group = [];
      acc = 0;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

const workerUrl = new URL("./renderWorker.ts", import.meta.url);

/** Run one worker per input; on any failure, terminate the rest (no zombies). */
async function runWorkers<T>(inputs: Array<RenderInput | CompositeInput>): Promise<T[]> {
  const workers: Worker[] = [];
  const jobs = inputs.map(
    (input) =>
      new Promise<T>((resolve, reject) => {
        const w = new Worker(workerUrl, { workerData: input, execArgv: ["--import", "tsx"] });
        workers.push(w);
        w.once("message", (msg: T | { error: string }) => {
          void w.terminate();
          if (Array.isArray(msg)) resolve(msg as T);
          else reject(new Error((msg as { error: string }).error));
        });
        w.once("error", reject);
      }),
  );
  try {
    return await Promise.all(jobs);
  } catch (err) {
    for (const w of workers) void w.terminate();
    throw err;
  }
}

/** ITM-render `origins` (workers when available); returns id → quantized grid. */
async function renderPhase(origins: CoverageOrigin[], src: RenderSources, bbox: DEMBounds): Promise<Map<string, MarginGridQ8>> {
  const out = new Map<string, MarginGridQ8>();
  if (cfg.WORKERS <= 1 || origins.length <= 1) {
    const itm = await loadItmContext(128);
    for (const o of origins) {
      const g = renderNodeMargin(o, src, itm);
      if (g) out.set(o.id, g);
    }
    return out;
  }
  const groups = partitionOrigins(origins, bbox, Math.min(cfg.WORKERS, origins.length));
  const parts = await runWorkers<RenderedNode[]>(groups.map((group) => ({ mode: "render", src, origins: group })));
  for (const part of parts) {
    for (const r of part) {
      out.set(r.id, { data: new Uint8Array(r.buf), width: r.width, height: r.height, bounds: r.bounds });
    }
  }
  return out;
}

/** Composite the affected tiles from node grids (workers when available). */
async function compositePhase(
  tiles: Array<{ tx: number; ty: number }>,
  nodes: MarginGridQ8[],
  z: number,
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  if (cfg.WORKERS <= 1 || tiles.length <= 8) {
    for (const { tx, ty } of tiles) {
      const m = compositeTileMargin(tx, ty, z, nodes);
      if (m) out.set(`${tx}/${ty}`, m);
    }
    return out;
  }
  const shared = nodes.map(sabGrid);
  const k = Math.min(cfg.WORKERS, Math.ceil(tiles.length / 8));
  const groups: Array<Array<{ tx: number; ty: number }>> = Array.from({ length: k }, () => []);
  tiles.forEach((t, i) => groups[i % k].push(t));
  const parts = await runWorkers<CompositedTile[]>(
    groups.map((group) => ({ mode: "composite", z, tiles: group, nodes: shared })),
  );
  for (const part of parts) for (const t of part) out.set(t.key, new Float32Array(t.buf));
  return out;
}

/** Alpha-weighted 2×2 downsample of a 256² RGBA tile → 128². */
function downsampleHalf(src: Uint8ClampedArray): Uint8ClampedArray {
  const half = TILE_SIZE / 2;
  const out = new Uint8ClampedArray(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * TILE_SIZE + (x * 2 + dx)) * 4;
          const sa = src[si + 3];
          r += src[si] * sa;
          g += src[si + 1] * sa;
          b += src[si + 2] * sa;
          a += sa;
        }
      }
      const oi = (y * half + x) * 4;
      out[oi + 3] = a / 4;
      if (a > 0) {
        out[oi] = r / a;
        out[oi + 1] = g / a;
        out[oi + 2] = b / a;
      }
    }
  }
  return out;
}

/** Assemble a parent from its four z+1 children via the async getter. */
async function buildParent(
  getChild: (z: number, x: number, y: number) => Promise<Uint8ClampedArray | null>,
  z: number,
  tx: number,
  ty: number,
): Promise<Uint8ClampedArray | null> {
  const half = TILE_SIZE / 2;
  let parent: Uint8ClampedArray | null = null;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const child = await getChild(z + 1, 2 * tx + cx, 2 * ty + cy);
    if (!child) continue;
    parent ??= new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    const ds = downsampleHalf(child);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const si = (y * half + x) * 4;
        const di = ((cy * half + y) * TILE_SIZE + (cx * half + x)) * 4;
        parent[di] = ds[si];
        parent[di + 1] = ds[si + 1];
        parent[di + 2] = ds[si + 2];
        parent[di + 3] = ds[si + 3];
      }
    }
  }
  return parent;
}

/** Long-lived raster cache: rebuilt only when the context changes, and only
 *  when a bake actually has nodes to render. */
let rasterKey: string | null = null;
let rasterSrc: RenderSources | null = null;
let rasterSources: string[] = ["itm"];

async function ensureRasters(bbox: DEMBounds, contextKey: string): Promise<RenderSources> {
  if (rasterSrc && rasterKey === contextKey) return rasterSrc;
  const demTiles = Math.ceil(cfg.SHARED_DEM_SIZE / 256) ** 2 * 2;
  const clutDim = { bounds: bbox, targetWidth: cfg.CLUTTER_RASTER_SIZE, targetHeight: cfg.CLUTTER_RASTER_SIZE, maxTiles: 1024 };
  const [{ dem }, clutter, canopy, buildings] = await Promise.all([
    buildDem({ bounds: bbox, targetWidth: cfg.SHARED_DEM_SIZE, targetHeight: cfg.SHARED_DEM_SIZE, maxTiles: demTiles, token: "" }),
    cfg.USE_CLUTTER ? buildClutterRaster(clutDim).catch(() => null) : Promise.resolve(null),
    cfg.USE_CANOPY ? buildCanopyRaster(clutDim).catch(() => null) : Promise.resolve(null),
    cfg.USE_BUILDINGS ? buildBuildingRaster(clutDim).catch(() => null) : Promise.resolve(null),
  ]);
  // A transient layer failure must not poison the cache with clutter-free margins.
  if ((cfg.USE_CLUTTER && !clutter) || (cfg.USE_CANOPY && !canopy) || (cfg.USE_BUILDINGS && !buildings)) {
    throw new Error("accuracy raster build failed; retrying next tick");
  }
  rasterSrc = shareSources({
    dem,
    clutter,
    canopy,
    buildings,
    clutterAggression: clutter ? cfg.CLUTTER_AGGRESSION : 0,
  });
  rasterKey = contextKey;
  rasterSources = ["itm"];
  if (clutter?.tilesPresent) rasterSources.push("nlcd");
  if (canopy?.tilesPresent) rasterSources.push("eth-canopy");
  if (buildings?.tilesPresent) rasterSources.push("jrc-buildings");
  return rasterSrc;
}

function rectKeys(r: { tx0: number; tx1: number; ty0: number; ty1: number }): string[] {
  const keys: string[] = [];
  for (let ty = r.ty0; ty < r.ty1; ty++) for (let tx = r.tx0; tx < r.tx1; tx++) keys.push(`${tx}/${ty}`);
  return keys;
}

/** Bake to a temp dir then atomically swap into OUTPUT_DIR; returns + writes metadata.json. */
export async function bakeCoverage(origins: CoverageOrigin[], version: string): Promise<BakeMetadata> {
  const z = cfg.MAX_ZOOM;
  const positions = origins.map((o) => [o.lng, o.lat] as [number, number]);
  const maxReach = origins.reduce((m, o) => Math.max(m, o.reachKm), cfg.CLIENT_REACH_KM);
  // state.json lives inside the output dir (written pre-swap) so the two stay atomic
  const state = await loadState(cfg.OUTPUT_DIR);

  // Sticky bbox — a change moves DEM resolution and invalidates every cached
  // margin, so keep it while nodes fit and grow (never shrink) otherwise.
  const candidate = snapBounds(unionDemBoundsAround(positions, maxReach, 1.05));
  let bbox = candidate;
  if (state?.bbox) {
    const [w, s, e, n] = state.bbox;
    if (candidate.west >= w && candidate.east <= e && candidate.south >= s && candidate.north <= n) {
      bbox = { west: w, south: s, east: e, north: n };
    } else {
      bbox = snapBounds({
        west: Math.min(w, candidate.west),
        south: Math.min(s, candidate.south),
        east: Math.max(e, candidate.east),
        north: Math.max(n, candidate.north),
      });
      console.log("[coverage-worker] bbox grew — full rebake");
    }
  }
  const contextKey = contextKeyFor(bbox);
  const dims = tileRectForBounds(bbox, z);
  let incremental = state != null && state.contextKey === contextKey;

  const wantKey = new Map(origins.map((o) => [o.id, originStateKey(o)]));
  let toRender: CoverageOrigin[] = [];
  const oldHeaders = new Map<string, NodeCacheHeader>();
  const reusableIds: string[] = [];
  for (const o of origins) {
    const h = await readNodeHeader(cfg.CACHE_DIR, o.id);
    if (h) oldHeaders.set(o.id, h);
    if (h && h.contextKey === contextKey && h.stateKey === wantKey.get(o.id)) reusableIds.push(o.id);
    else toRender.push(o);
  }
  const removedIds = incremental && state ? Object.keys(state.active).filter((id) => !wantKey.has(id)) : [];
  const removedHeaders = (
    await Promise.all(removedIds.map((id) => readNodeHeader(cfg.CACHE_DIR, id)))
  ).filter((h): h is NodeCacheHeader => h != null);

  // Render only what changed; a pure-aging delta skips rasters + ITM entirely.
  let rendered = new Map<string, MarginGridQ8>();
  if (toRender.length > 0) {
    const src = await ensureRasters(bbox, contextKey);
    // Sources changed (e.g. NLCD baked later): cached margins lack the layer — re-render all.
    if (incremental && state?.sources && JSON.stringify(rasterSources) !== JSON.stringify(state.sources)) {
      console.log(`[coverage-worker] accuracy sources changed (${state.sources} → ${rasterSources}) — full rebake`);
      toRender = [...origins];
      incremental = false;
    }
    rendered = await renderPhase(toRender, src, bbox);
    for (const [id, g] of rendered) {
      await writeNode(
        cfg.CACHE_DIR,
        { id, stateKey: wantKey.get(id)!, contextKey, width: g.width, height: g.height, bounds: g.bounds },
        g.data,
      );
    }
  }

  // Affected tiles: every tile a changed/new/removed footprint touches (old + new).
  const affected = new Set<string>();
  const addBounds = (b: DEMBounds) => {
    for (const k of rectKeys(clampRect(tileRectForBounds(b, z), dims))) affected.add(k);
  };
  if (incremental && state) {
    // Compare against state.active, not just rendered: nodes re-entering the
    // active set from cache also need their tiles recomposited.
    for (const o of origins) {
      if (state.active[o.id] === wantKey.get(o.id)) continue;
      const g = rendered.get(o.id);
      if (g) addBounds(g.bounds);
      const old = oldHeaders.get(o.id);
      if (old) addBounds(old.bounds);
    }
    for (const h of removedHeaders) addBounds(h.bounds);
  } else {
    for (const [, g] of rendered) addBounds(g.bounds);
    for (const id of reusableIds) addBounds(oldHeaders.get(id)!.bounds);
  }

  // Grids needed to composite the affected region: fresh renders + cached
  // unchanged nodes whose footprints intersect an affected tile.
  const affectedTiles = [...affected].map((k) => {
    const [tx, ty] = k.split("/").map(Number);
    return { tx, ty };
  });
  const compositeNodes: MarginGridQ8[] = [...rendered.values()];
  for (const id of reusableIds) {
    const h = oldHeaders.get(id)!;
    const r = clampRect(tileRectForBounds(h.bounds, z), dims);
    const touches = affectedTiles.some((t) => t.tx >= r.tx0 && t.tx < r.tx1 && t.ty >= r.ty0 && t.ty < r.ty1);
    if (!touches) continue;
    const g = await readNodeGrid(cfg.CACHE_DIR, id);
    if (g) compositeNodes.push(g);
    else {
      // drop the broken entry so the next bake re-renders instead of failing forever
      await removeNode(cfg.CACHE_DIR, id);
      throw new Error(`cached margin for ${id} unreadable; entry dropped`);
    }
  }

  const margins = await compositePhase(affectedTiles, compositeNodes, z);

  // Fresh RGBA per affected key; null = now empty (erases the old PNG).
  const fresh = new Map<string, Uint8ClampedArray | null>();
  for (const k of affected) {
    const m = margins.get(k);
    fresh.set(`${z}/${k}`, m ? colorizeMargin(m, TILE_SIZE * TILE_SIZE) : null);
  }

  const prevDecoded = new Map<string, Uint8ClampedArray | null>();
  const getChild = async (cz: number, x: number, y: number): Promise<Uint8ClampedArray | null> => {
    const key = `${cz}/${x}/${y}`;
    if (fresh.has(key)) return fresh.get(key)!;
    if (!incremental) return null;
    if (prevDecoded.has(key)) return prevDecoded.get(key)!;
    let rgba: Uint8ClampedArray | null = null;
    try {
      const buf = await readFile(join(cfg.OUTPUT_DIR, `${key}.png`));
      const px = await decodeTilePixels(new Blob([new Uint8Array(buf)]));
      if (px.width === TILE_SIZE && px.height === TILE_SIZE) rgba = px.data;
    } catch {
      rgba = null;
    }
    prevDecoded.set(key, rgba);
    return rgba;
  };

  // Rebuild the ancestor chain of every affected tile, MAX_ZOOM-1 down to MIN_ZOOM.
  const minZoom = Math.min(cfg.MIN_ZOOM, z);
  let level = new Set(affected);
  for (let pz = z - 1; pz >= minZoom; pz--) {
    const parents = new Set<string>();
    for (const k of level) {
      const [tx, ty] = k.split("/").map(Number);
      parents.add(`${tx >> 1}/${ty >> 1}`);
    }
    for (const k of parents) {
      const [tx, ty] = k.split("/").map(Number);
      fresh.set(`${pz}/${k}`, await buildParent(getChild, pz, tx, ty));
    }
    level = parents;
  }

  // Assemble output: copy every untouched PNG forward, write the fresh ones.
  const tmpDir = `${cfg.OUTPUT_DIR}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  let copied = 0;
  if (incremental) {
    const names = await readdir(cfg.OUTPUT_DIR, { recursive: true });
    for (const name of names) {
      const key = String(name).replace(/\\/g, "/");
      if (!key.endsWith(".png") || fresh.has(key.slice(0, -4))) continue;
      const dst = join(tmpDir, key);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(join(cfg.OUTPUT_DIR, key), dst);
      copied++;
    }
  }
  const entries = [...fresh].filter((e): e is [string, Uint8ClampedArray] => e[1] != null);
  const BATCH = 16;
  for (let i = 0; i < entries.length; i += BATCH) {
    await Promise.all(
      entries.slice(i, i + BATCH).map(async ([key, rgba]) => {
        const png = await encodePng(rgba, TILE_SIZE, TILE_SIZE);
        const p = join(tmpDir, `${key}.png`);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, png);
      }),
    );
  }

  const meta: BakeMetadata = {
    version,
    generatedAt: new Date().toISOString(),
    bounds: [bbox.west, bbox.south, bbox.east, bbox.north],
    minZoom,
    maxZoom: z,
    nodeCount: origins.length,
    tileCount: copied + entries.length,
    recencyHours: cfg.RECENCY_HOURS,
    sources: toRender.length > 0 ? rasterSources : state?.sources ?? rasterSources,
  };
  await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2));
  const newState: CacheState = {
    contextKey,
    active: Object.fromEntries(wantKey),
    sources: meta.sources,
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
  };
  await saveState(tmpDir, newState); // rides the swap with the tiles it describes

  // Swap old aside, new into place.
  const oldDir = `${cfg.OUTPUT_DIR}.old`;
  await rm(oldDir, { recursive: true, force: true });
  await rename(cfg.OUTPUT_DIR, oldDir).catch(() => {});
  await mkdir(dirname(cfg.OUTPUT_DIR) || ".", { recursive: true });
  await rename(tmpDir, cfg.OUTPUT_DIR);
  await rm(oldDir, { recursive: true, force: true });

  await pruneCache(cfg.CACHE_DIR, new Set(wantKey.keys()), cfg.CACHE_PRUNE_DAYS);

  console.log(
    `[coverage-worker] ${incremental ? "delta" : "full"} bake: ${toRender.length} rendered, ` +
      `${reusableIds.length} cached, ${removedIds.length} removed, ${affected.size} tiles recomposited, ${copied} reused`,
  );
  return meta;
}
