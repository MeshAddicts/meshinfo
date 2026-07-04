/** Incremental coverage bake: only changed nodes re-render (margins cached on
 *  disk), only affected tiles recomposite; cold start = everything new, same path. */
import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import type { CoverageMeta } from "../src/pages/map/live/coverageMeta";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { type ItmContext, loadItmContext } from "../src/pages/map/rf/itm";
import {
  buildBuildingRaster,
  evictMissingBuildingTiles,
  fetchBuildingTile,
  selectBuildingZoom,
} from "../src/pages/map/terrain/buildingTiles";
import {
  buildCanopyRaster,
  evictMissingCanopyTiles,
  fetchCanopyTile,
  selectCanopyZoom,
} from "../src/pages/map/terrain/canopyTiles";
import {
  buildClutterRaster,
  evictMissingLandcoverTiles,
  fetchLandcoverTile,
  selectLandcoverZoom,
} from "../src/pages/map/terrain/landcoverTiles";
import { type DEMBounds, demBoundsContain, unionDemBoundsAround } from "../src/pages/map/terrain/terrainDEM";
import { buildDem } from "../src/pages/map/terrain/terrainRgb";
import { decodeTilePixels } from "../src/pages/map/terrain/tileDecode";
import { lat2tileY, lng2tileX } from "../src/pages/map/terrain/webMercator";
import {
  type ActiveNodeState,
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
import type { CompositedTile, CompositeInput, RenderedNode, RenderInput, WorkerJob, WorkerReply } from "./renderWorker";
import { encodePng } from "./sharpImage";

/** metadata.json shape — the shared CoverageMeta contract (see coverageMeta.ts). */
export type BakeMetadata = CoverageMeta;

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
 *  (a bbox change invalidates the whole cache). Longitude is deliberately NOT
 *  clamped to ±180: a seam-straddling mesh lives in an unwrapped frame (e.g.
 *  [178, 182]) end-to-end; only tile file keys and display bounds wrap. */
function snapBounds(b: DEMBounds, step = 0.25): DEMBounds {
  const out = {
    west: Math.floor(b.west / step) * step,
    south: Math.max(-85, Math.floor(b.south / step) * step),
    east: Math.ceil(b.east / step) * step,
    north: Math.min(85, Math.ceil(b.north / step) * step),
  };
  if (out.east - out.west >= 360) {
    out.west = -180;
    out.east = 180;
  }
  return out;
}

/** Everything a cached margin depends on besides the node's own state.
 *  "v2" = ActiveNodeState state.json format (v1 states full-rebake cleanly). */
function contextKeyFor(bbox: DEMBounds): string {
  const paramsFp = JSON.stringify(buildLiveCoverageParams(0, 1)) + LIVE_ANTENNA_AGL_M;
  return hashKey(
    "v2",
    bbox.west.toFixed(4), bbox.south.toFixed(4), bbox.east.toFixed(4), bbox.north.toFixed(4),
    cfg.SHARED_DEM_SIZE, cfg.NODE_DEM_SIZE, cfg.CLUTTER_RASTER_SIZE,
    cfg.NODE_OUTPUT_MAX, cfg.OUTPUT_M_PER_PX, cfg.MAX_ZOOM, cfg.MIN_ZOOM,
    String(cfg.USE_CLUTTER), String(cfg.USE_CANOPY), String(cfg.USE_BUILDINGS),
    cfg.CLUTTER_AGGRESSION, paramsFp,
  );
}

/** Interleaved 16-bit Morton code of a position within the bbox. */
function mortonCode(o: CoverageOrigin, bbox: DEMBounds): number {
  const sLng = o.lng < bbox.west ? o.lng + 360 : o.lng > bbox.east ? o.lng - 360 : o.lng;
  const nx = Math.max(0, Math.min(0xffff, Math.floor(((sLng - bbox.west) / (bbox.east - bbox.west)) * 0x10000)));
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

/** Persistent worker pool: lives across bakes (in the persistent bake thread),
 *  so tsx bootstrap + module import + ITM WASM load are paid once per worker,
 *  not per phase per bake. A worker that errors or exits leaves the pool; the
 *  next bake respawns as needed. */
const pool: Worker[] = [];
let nextJobId = 1;

function obtainWorkers(n: number): Worker[] {
  while (pool.length < n) {
    const w = new Worker(workerUrl, { execArgv: ["--import", "tsx"] });
    w.on("exit", () => {
      const i = pool.indexOf(w);
      if (i !== -1) pool.splice(i, 1);
    });
    pool.push(w);
  }
  return pool.slice(0, n);
}

/** Kill idle pool workers so a --once run's event loop can drain. */
export async function terminateWorkerPool(): Promise<void> {
  await Promise.all([...pool].map((w) => w.terminate()));
  pool.length = 0;
}

function runJob<T extends RenderedNode[] | CompositedTile[]>(
  w: Worker,
  input: RenderInput | CompositeInput,
): Promise<T> {
  const jobId = nextJobId++;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
    };
    const onMessage = (msg: WorkerReply) => {
      if (msg.jobId !== jobId) return;
      cleanup();
      if ("err" in msg) reject(new Error(msg.err));
      else resolve(msg.ok as T);
    };
    const onError = (err: Error) => {
      cleanup();
      void w.terminate(); // exit handler removes it from the pool
      reject(err);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("render worker exited"));
    };
    w.on("message", onMessage);
    w.once("error", onError);
    w.once("exit", onExit);
    w.postMessage({ jobId, input } satisfies WorkerJob);
  });
}

/** Inline-path ITM context, loaded once per process. */
let itmCtx: Promise<ItmContext> | null = null;

/** ITM-render `origins` (workers when available); returns id → quantized grid. */
async function renderPhase(origins: CoverageOrigin[], src: RenderSources, bbox: DEMBounds): Promise<Map<string, MarginGridQ8>> {
  const out = new Map<string, MarginGridQ8>();
  if (cfg.WORKERS <= 1 || origins.length <= 1) {
    itmCtx ??= loadItmContext(128);
    let itm: ItmContext;
    try {
      itm = await itmCtx;
    } catch (err) {
      itmCtx = null; // don't memoize a transient WASM-load failure forever
      throw err;
    }
    for (const o of origins) {
      const g = renderNodeMargin(o, src, itm);
      if (g) out.set(o.id, g);
    }
    return out;
  }
  const groups = partitionOrigins(origins, bbox, Math.min(cfg.WORKERS, origins.length));
  const workers = obtainWorkers(groups.length);
  const parts = await Promise.all(
    groups.map((group, i) => runJob<RenderedNode[]>(workers[i], { mode: "render", src, origins: group })),
  );
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
  const workers = obtainWorkers(k);
  const parts = await Promise.all(
    groups.map((group, i) => runJob<CompositedTile[]>(workers[i], { mode: "composite", z, tiles: group, nodes: shared })),
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

/** Assemble a parent from its four z+1 children via the async getter (unwrapped coords). */
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

/** Long-lived raster cache: rebuilt when the context changes; while an enabled
 *  accuracy layer is missing, a cheap per-layer tile probe runs every 30 min so
 *  a later NLCD/canopy/buildings bake is picked up without restarting. */
let rasterKey: string | null = null;
let rasterSrc: RenderSources | null = null;
let rasterSources: string[] = ["itm"];
let rasterLayersMissing = false;
let rasterBuiltAt = 0;

const RASTER_REPROBE_MS = 30 * 60_000;

/** Probe a handful of tiles (center + quadrant midpoints) for each enabled
 *  layer that was missing; true when any tile now exists. Uses the same zoom
 *  selection as the builders so the probe requests tiles a build would. */
async function anyMissingLayerAppeared(bbox: DEMBounds): Promise<boolean> {
  const midLat = (bbox.north + bbox.south) / 2;
  const lngSpan = bbox.east - bbox.west;
  const latSpan = bbox.north - bbox.south;
  const points: Array<[number, number]> = (
    [
      [bbox.west + lngSpan / 2, midLat],
      [bbox.west + lngSpan / 4, bbox.south + latSpan / 4],
      [bbox.west + (3 * lngSpan) / 4, bbox.south + latSpan / 4],
      [bbox.west + lngSpan / 4, bbox.south + (3 * latSpan) / 4],
      [bbox.west + (3 * lngSpan) / 4, bbox.south + (3 * latSpan) / 4],
    ] as Array<[number, number]>
  ).map(([lng, lat]) => [lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng, lat]);
  const pxSize = Math.max(1, (lngSpan * 111_320 * Math.cos((midLat * Math.PI) / 180)) / cfg.CLUTTER_RASTER_SIZE);
  const tileXY = (lng: number, lat: number, z: number): [number, number] => {
    const s = 1 << z;
    return [((Math.floor(lng2tileX(lng, z)) % s) + s) % s, Math.floor(lat2tileY(lat, z))];
  };

  const checks: Array<Promise<boolean>> = [];
  if (cfg.USE_CLUTTER && !rasterSources.includes("nlcd")) {
    evictMissingLandcoverTiles(); // cached 404s would mask a completed bake
    const z = selectLandcoverZoom(bbox, pxSize, 1024);
    for (const [lng, lat] of points) {
      checks.push(
        (async () => {
          const [x, y] = tileXY(lng, lat, z);
          return (await fetchLandcoverTile(z, x, y)).data.length > 0;
        })().catch(() => false),
      );
    }
  }
  if (cfg.USE_CANOPY && !rasterSources.includes("eth-canopy")) {
    evictMissingCanopyTiles();
    const z = selectCanopyZoom(bbox, pxSize, 1024);
    for (const [lng, lat] of points) {
      checks.push(
        (async () => {
          const [x, y] = tileXY(lng, lat, z);
          return (await fetchCanopyTile(z, x, y)).height.length > 0;
        })().catch(() => false),
      );
    }
  }
  if (cfg.USE_BUILDINGS && !rasterSources.includes("jrc-buildings")) {
    evictMissingBuildingTiles();
    const z = selectBuildingZoom(bbox, pxSize, 1024);
    for (const [lng, lat] of points) {
      checks.push(
        (async () => {
          const [x, y] = tileXY(lng, lat, z);
          return (await fetchBuildingTile(z, x, y)).height.length > 0;
        })().catch(() => false),
      );
    }
  }
  if (checks.length === 0) return false;
  return (await Promise.all(checks)).some(Boolean);
}

async function ensureRasters(bbox: DEMBounds, contextKey: string): Promise<RenderSources> {
  if (rasterSrc != null && rasterKey === contextKey) {
    if (!rasterLayersMissing || Date.now() - rasterBuiltAt < RASTER_REPROBE_MS) return rasterSrc;
    rasterBuiltAt = Date.now(); // pace probes even when they fail or find nothing
    if (!(await anyMissingLayerAppeared(bbox))) return rasterSrc;
    console.log("[coverage-worker] new accuracy layer detected — rebuilding rasters");
  }
  const prevSrc = rasterSrc;
  const prevKey = rasterKey;
  try {
    // Drop cached 404 sentinels: this rebuild may follow a bake that filled them in.
    evictMissingLandcoverTiles();
    evictMissingCanopyTiles();
    evictMissingBuildingTiles();
    const demTiles = Math.ceil(cfg.SHARED_DEM_SIZE / 256) ** 2 * 2;
    const clutDim = { bounds: bbox, targetWidth: cfg.CLUTTER_RASTER_SIZE, targetHeight: cfg.CLUTTER_RASTER_SIZE, maxTiles: 1024 };
    const [built, clutter, canopy, buildings] = await Promise.all([
      buildDem({ bounds: bbox, targetWidth: cfg.SHARED_DEM_SIZE, targetHeight: cfg.SHARED_DEM_SIZE, maxTiles: demTiles, token: "" }),
      cfg.USE_CLUTTER ? buildClutterRaster(clutDim) : Promise.resolve(null),
      cfg.USE_CANOPY ? buildCanopyRaster(clutDim) : Promise.resolve(null),
      cfg.USE_BUILDINGS ? buildBuildingRaster(clutDim) : Promise.resolve(null),
    ]);
    // Tiles that failed TRANSIENTLY (vs 404 = not baked, or permanently bad)
    // mean an outage: rendering through it would cache degraded margins under
    // an unchanged key, poisoning every later delta bake. Abort this build.
    const failed =
      built.tilesFailed +
      (clutter?.tilesFailed ?? 0) +
      (canopy?.tilesFailed ?? 0) +
      (buildings?.tilesFailed ?? 0);
    if (failed > 0) {
      throw new Error(`raster build had ${failed} failed tile fetches`);
    }
    rasterSrc = shareSources({
      dem: built.dem,
      clutter,
      canopy,
      buildings,
      // Canopy/building losses scale with the same aggression factor, so it must
      // stay live even when the NLCD layer itself is absent.
      clutterAggression: cfg.CLUTTER_AGGRESSION,
    });
    rasterKey = contextKey;
    rasterBuiltAt = Date.now();
    rasterSources = ["itm"];
    if (clutter?.tilesPresent) rasterSources.push("nlcd");
    if (canopy?.tilesPresent) rasterSources.push("eth-canopy");
    if (buildings?.tilesPresent) rasterSources.push("jrc-buildings");
    rasterLayersMissing =
      (cfg.USE_CLUTTER && !clutter?.tilesPresent) ||
      (cfg.USE_CANOPY && !canopy?.tilesPresent) ||
      (cfg.USE_BUILDINGS && !buildings?.tilesPresent);
    return rasterSrc;
  } catch (err) {
    if (prevSrc != null && prevKey === contextKey) {
      // Outage mid-rebuild: keep rendering with the last good rasters — they
      // match contextKey and state.sources, so nothing gets poisoned.
      console.warn("[coverage-worker] raster rebuild failed; keeping previous rasters:", err);
      return prevSrc;
    }
    throw err; // no valid rasters yet — abort the bake; the loop retries next tick
  }
}

function rectKeys(r: { tx0: number; tx1: number; ty0: number; ty1: number }): string[] {
  const keys: string[] = [];
  for (let ty = r.ty0; ty < r.ty1; ty++) for (let tx = r.tx0; tx < r.tx1; tx++) keys.push(`${tx}/${ty}`);
  return keys;
}

/** Wrap an unwrapped tile x to the canonical [0, 2^z) index used in file paths.
 *  snapBounds caps the bbox under 360°, so the mapping is collision-free. */
function wrapX(x: number, z: number): number {
  const s = 1 << z;
  return ((x % s) + s) % s;
}

/**
 * Bake to a temp dir then atomically swap into OUTPUT_DIR; returns + writes
 * metadata.json. An empty origin set erases the previous output (a mesh gone
 * quiet must not keep serving stale coverage); returns null when there is
 * nothing baked and nothing to erase.
 */
export async function bakeCoverage(origins: CoverageOrigin[], version: string): Promise<BakeMetadata | null> {
  const z = cfg.MAX_ZOOM;
  // state.json lives inside the output dir (written pre-swap) so the two stay atomic
  const state = await loadState(cfg.OUTPUT_DIR);
  const stored: DEMBounds | null = state?.bbox
    ? { west: state.bbox[0], south: state.bbox[1], east: state.bbox[2], north: state.bbox[3] }
    : null;

  // Sticky bbox — a change moves DEM resolution and invalidates every cached
  // margin, so keep it while nodes fit and grow (never shrink) otherwise.
  let bbox: DEMBounds;
  if (origins.length === 0) {
    if (!stored || !state || Object.keys(state.active).length === 0) return null; // nothing baked, nothing to erase
    bbox = stored;
  } else {
    const positions = origins.map((o) => [o.lng, o.lat] as [number, number]);
    const maxReach = origins.reduce((m, o) => Math.max(m, o.reachKm), cfg.CLIENT_REACH_KM);
    const candidate = snapBounds(unionDemBoundsAround(positions, maxReach, 1.05));
    bbox = candidate;
    if (stored) {
      if (demBoundsContain(stored, candidate)) {
        bbox = stored;
      } else {
        // Union in the stored frame — the candidate may sit in a ±360-shifted
        // frame when the reference node changed sides of the antimeridian.
        const dMid = (candidate.west + candidate.east) / 2 - (stored.west + stored.east) / 2;
        const shift = dMid > 180 ? -360 : dMid < -180 ? 360 : 0;
        bbox = snapBounds({
          west: Math.min(stored.west, candidate.west + shift),
          south: Math.min(stored.south, candidate.south),
          east: Math.max(stored.east, candidate.east + shift),
          north: Math.max(stored.north, candidate.north),
        });
        console.log("[coverage-worker] bbox grew — full rebake");
      }
    }
  }
  const contextKey = contextKeyFor(bbox);
  const dims = tileRectForBounds(bbox, z);
  let incremental = state != null && state.contextKey === contextKey;

  const wantKey = new Map(origins.map((o) => [o.id, originStateKey(o)]));
  // A cached margin is only reusable if it was rendered with the sources the
  // current output uses — a node absent across a sources change must not
  // re-enter with its stale (e.g. clutter-free) grid.
  const wantSources = state?.sources != null ? JSON.stringify(state.sources) : null;
  let toRender: CoverageOrigin[] = [];
  const oldHeaders = new Map<string, NodeCacheHeader>();
  const reusableIds: string[] = [];
  for (const o of origins) {
    const h = await readNodeHeader(cfg.CACHE_DIR, o.id);
    if (h) oldHeaders.set(o.id, h);
    const sourcesOk = wantSources == null || JSON.stringify(h?.sources ?? null) === wantSources;
    if (h && h.contextKey === contextKey && h.stateKey === wantKey.get(o.id) && sourcesOk) reusableIds.push(o.id);
    else toRender.push(o);
  }
  const removedIds = incremental && state ? Object.keys(state.active).filter((id) => !wantKey.has(id)) : [];

  // Render only what changed; a pure-aging delta skips rasters + ITM entirely.
  let rendered = new Map<string, MarginGridQ8>();
  if (toRender.length > 0) {
    const src = await ensureRasters(bbox, contextKey);
    // Sources changed (e.g. NLCD baked later): cached margins lack the layer — re-render all.
    if (incremental && state?.sources && JSON.stringify(rasterSources) !== JSON.stringify(state.sources)) {
      console.log(`[coverage-worker] accuracy sources changed (${state.sources} → ${rasterSources}) — full rebake`);
      toRender = [...origins];
      reusableIds.length = 0; // everything re-renders; don't composite stale grids twice
      incremental = false;
    }
    rendered = await renderPhase(toRender, src, bbox);
    for (const [id, g] of rendered) {
      await writeNode(
        cfg.CACHE_DIR,
        { id, stateKey: wantKey.get(id)!, contextKey, width: g.width, height: g.height, bounds: g.bounds, sources: rasterSources },
        g.data,
      );
    }
  }

  // Affected tiles: every tile a changed/new/removed footprint touches — both
  // the newly rendered bounds and whatever is currently painted on disk
  // (state.active carries the painted bounds, so a moved node's old footprint
  // is erased even if its cache entry was overwritten by a failed bake).
  const affected = new Set<string>();
  const addBounds = (b: DEMBounds) => {
    for (const k of rectKeys(clampRect(tileRectForBounds(b, z), dims))) affected.add(k);
  };
  if (incremental && state) {
    for (const o of origins) {
      const cur = state.active[o.id] as ActiveNodeState | undefined;
      // Skip only when the painted state is current AND nothing re-rendered
      // (a wiped cache re-renders unchanged nodes; their tiles must recomposite).
      if (cur?.key === wantKey.get(o.id) && !rendered.has(o.id)) continue;
      const g = rendered.get(o.id);
      if (g) addBounds(g.bounds);
      else {
        const h = oldHeaders.get(o.id);
        if (h) addBounds(h.bounds); // re-entering the active set from cache
      }
      if (cur?.bounds) addBounds(cur.bounds);
    }
    for (const id of removedIds) {
      const cur = state.active[id] as ActiveNodeState | undefined;
      if (cur?.bounds) addBounds(cur.bounds);
    }
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

  // Fresh RGBA per affected key; null = now empty (erases the old PNG). Keys
  // wrap to canonical tile x here — composite ran in the unwrapped frame.
  const fresh = new Map<string, Uint8ClampedArray | null>();
  for (const k of affected) {
    const [tx, ty] = k.split("/").map(Number);
    const m = margins.get(k);
    margins.delete(k); // free each Float32 tile as soon as it's colorized
    fresh.set(`${z}/${wrapX(tx, z)}/${ty}`, m ? colorizeMargin(m, TILE_SIZE * TILE_SIZE) : null);
  }

  const prevDecoded = new Map<string, Uint8ClampedArray | null>();
  const getChild = async (cz: number, x: number, y: number): Promise<Uint8ClampedArray | null> => {
    const key = `${cz}/${wrapX(x, cz)}/${y}`;
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
  let level = new Set(affected); // unwrapped "tx/ty"
  for (let pz = z - 1; pz >= minZoom; pz--) {
    const parents = new Set<string>();
    for (const k of level) {
      const [tx, ty] = k.split("/").map(Number);
      parents.add(`${tx >> 1}/${ty >> 1}`);
    }
    for (const k of parents) {
      const [tx, ty] = k.split("/").map(Number);
      fresh.set(`${pz}/${wrapX(tx, pz)}/${ty}`, await buildParent(getChild, pz, tx, ty));
    }
    level = parents;
  }

  // Assemble output: carry every untouched PNG forward, write the fresh ones.
  const tmpDir = `${cfg.OUTPUT_DIR}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const BATCH = 16;
  let copied = 0;
  if (incremental) {
    const names = await readdir(cfg.OUTPUT_DIR, { recursive: true });
    const carried: string[] = [];
    for (const name of names) {
      const key = String(name).replace(/\\/g, "/");
      if (!key.endsWith(".png") || fresh.has(key.slice(0, -4))) continue;
      carried.push(key);
    }
    // Hardlink (copy as fallback) so carry-forward I/O is O(delta), and the
    // untouched tiles keep their inode + mtime — their ETags stay stable, so
    // clients revalidating after a bake get 304s instead of re-downloads.
    for (let i = 0; i < carried.length; i += BATCH * 4) {
      await Promise.all(
        carried.slice(i, i + BATCH * 4).map(async (key) => {
          const src = join(cfg.OUTPUT_DIR, key);
          const dst = join(tmpDir, key);
          await mkdir(dirname(dst), { recursive: true });
          try {
            await link(src, dst);
          } catch {
            await copyFile(src, dst);
          }
          copied++;
        }),
      );
    }
  }
  const entries = [...fresh].filter((e): e is [string, Uint8ClampedArray] => e[1] != null);
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

  // Display bounds are clamped for MapLibre source culling; a seam-straddling
  // bbox falls back to the full longitude band (the true frame stays in state).
  const displayBounds: [number, number, number, number] =
    bbox.west < -180 || bbox.east > 180
      ? [-180, bbox.south, 180, bbox.north]
      : [bbox.west, bbox.south, bbox.east, bbox.north];

  // Sources bookkeeping: fresh renders use rasterSources; a render-free delta
  // keeps the output's previous sources; with state lost but caches reused,
  // the cached headers say what the composited grids were rendered with.
  const cachedSources = reusableIds.length > 0 ? oldHeaders.get(reusableIds[0])!.sources : undefined;
  const meta: BakeMetadata = {
    version,
    generatedAt: new Date().toISOString(),
    bounds: displayBounds,
    minZoom,
    maxZoom: z,
    nodeCount: origins.length,
    tileCount: copied + entries.length,
    recencyHours: cfg.RECENCY_HOURS,
    sources: toRender.length > 0 ? rasterSources : state?.sources ?? cachedSources ?? rasterSources,
  };
  await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2));

  const activeOut: Record<string, ActiveNodeState> = {};
  for (const o of origins) {
    const b = rendered.get(o.id)?.bounds ?? oldHeaders.get(o.id)?.bounds;
    if (b) activeOut[o.id] = { key: wantKey.get(o.id)!, bounds: b };
  }
  const newState: CacheState = {
    contextKey,
    active: activeOut,
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
