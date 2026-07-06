/** Incremental coverage bake: only changed nodes re-render (margins cached on
 *  disk), only affected tiles recomposite; cold start = everything new, same path. */
import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import type { CoverageMeta } from "../src/pages/map/live/coverageMeta";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { LIVE_PRESET_SENSITIVITY_DBM } from "../src/pages/map/live/liveCoveragePresets";
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
  readNodeHeader,
  removeNode,
  saveState,
  writeNode,
} from "./cache";
import { colorizeQ8 } from "./colorize";
import * as cfg from "./config";
import { TILE_SIZE } from "./mercator";
import {
  clampRect,
  type NodeRenderPlan,
  planNodeRender,
  renderNodeMargin,
  type RenderSources,
  streamCompositeQ8,
  tileRectForBounds,
} from "./nodeRender";
import type { CoverageOrigin } from "./nodes";
import type { CompositeInput, CompositeResult, RenderedNode, RenderInput, WorkerJob, WorkerReply } from "./renderWorker";
import { encodePng } from "./sharpImage";

/** metadata.json shape — the shared CoverageMeta contract (see coverageMeta.ts). */
export type BakeMetadata = CoverageMeta;

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
 *  "v2" = ActiveNodeState state.json format (v1 states full-rebake cleanly).
 *  All groups share one bbox → one contextKey, so a node's ITM grid renders
 *  once and is composited by both the "all" and its preset pyramid. */
function contextKeyFor(bbox: DEMBounds): string {
  const paramsFp =
    JSON.stringify(buildLiveCoverageParams(0, 1)) +
    LIVE_ANTENNA_AGL_M +
    JSON.stringify(LIVE_PRESET_SENSITIVITY_DBM) +
    cfg.DEFAULT_PRESET;
  return hashKey(
    "v2",
    bbox.west.toFixed(4), bbox.south.toFixed(4), bbox.east.toFixed(4), bbox.north.toFixed(4),
    cfg.SHARED_DEM_SIZE, cfg.NODE_DEM_SIZE,
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

function runJob<T extends RenderedNode | null | CompositeResult>(
  w: Worker,
  input: RenderInput | CompositeInput,
  transfers: ArrayBuffer[] = [],
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
    w.postMessage({ jobId, input } satisfies WorkerJob, transfers);
  });
}

/** Inline-path ITM context, loaded once per process. */
let itmCtx: Promise<ItmContext> | null = null;

interface NodeSlices {
  clutter: RenderSources["clutter"];
  canopy: RenderSources["canopy"];
  buildings: RenderSources["buildings"];
  transfers: ArrayBuffer[];
}

/** Build one node's accuracy slices over its footprint at output resolution,
 *  decoupling clutter sampling from network-bbox size. The tile builders'
 *  LRUs make morton-adjacent nodes mostly cache hits; slice buffers are
 *  transferred to the render worker, so peak memory is one slice set per
 *  in-flight job. */
async function buildNodeSlices(plan: NodeRenderPlan): Promise<NodeSlices> {
  const dims = { bounds: plan.fp, targetWidth: plan.outW, targetHeight: plan.outH, maxTiles: 256 };
  // Sequential per layer: every render lane runs one of these, so parallel
  // layer builds would multiply concurrent sockets against meshinfo ×3
  // (slices are small and mostly LRU hits — sequencing costs ~nothing).
  const clutter = cfg.USE_CLUTTER ? await buildClutterRaster(dims) : null;
  const canopy = cfg.USE_CANOPY ? await buildCanopyRaster(dims) : null;
  const buildings = cfg.USE_BUILDINGS ? await buildBuildingRaster(dims) : null;
  // Same outage policy as the DEM: transient fetch failures abort the bake
  // rather than cache a clutter-free margin under an unchanged key.
  const failed = (clutter?.tilesFailed ?? 0) + (canopy?.tilesFailed ?? 0) + (buildings?.tilesFailed ?? 0);
  if (failed > 0) {
    throw new Error(`accuracy slice build had ${failed} failed tile fetches`);
  }
  const transfers: ArrayBuffer[] = [];
  if (clutter) transfers.push(clutter.data.buffer as ArrayBuffer);
  if (canopy) transfers.push(canopy.heightM.buffer as ArrayBuffer, canopy.stdM.buffer as ArrayBuffer, canopy.mask.buffer as ArrayBuffer);
  if (buildings) transfers.push(buildings.heightM.buffer as ArrayBuffer, buildings.mask.buffer as ArrayBuffer);
  return { clutter, canopy, buildings, transfers };
}

/** ITM-render `origins` (workers when available); returns id → footprint
 *  BOUNDS only — the grids themselves live in the margin cache (written by
 *  `onRendered` as each finishes) and are streamed back at composite time, so
 *  a full rebake never holds every grid in memory. One job per node: the bake
 *  thread builds that node's slices just-in-time, then hands them to a worker. */
/** Cap on concurrent slice builds: each opens a 24-lane fetch pool against
 *  meshinfo, so unbounded lanes would burst WORKERS × 24 sockets (ECONNRESET
 *  territory). Renders dominate lane time, so a small cap rarely blocks. */
const MAX_CONCURRENT_SLICE_BUILDS = 4;
let sliceBuildsInFlight = 0;
const sliceBuildWaiters: Array<() => void> = [];

async function withSliceBuildSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (sliceBuildsInFlight >= MAX_CONCURRENT_SLICE_BUILDS) {
    await new Promise<void>((r) => sliceBuildWaiters.push(r));
  }
  sliceBuildsInFlight++;
  try {
    return await fn();
  } finally {
    sliceBuildsInFlight--;
    sliceBuildWaiters.shift()?.();
  }
}

/** Monotonic render-phase generation: cache writes from an aborted phase's
 *  still-in-flight jobs must not land after a retry bake started (they could
 *  overwrite the retry's fresh grid with a stale one right before composite). */
let renderGen = 0;

async function renderPhase(
  origins: CoverageOrigin[],
  dem: RenderSources["dem"],
  bbox: DEMBounds,
  onRendered: (id: string, g: MarginGridQ8) => Promise<void>,
): Promise<Map<string, DEMBounds>> {
  const gen = ++renderGen;
  const out = new Map<string, DEMBounds>();
  // Morton order = spatial locality, so consecutive slice builds hit the tile LRUs.
  const queue = [...origins].sort((a, b) => mortonCode(a, bbox) - mortonCode(b, bbox));
  // One lane failing aborts the phase; the flag stops sibling lanes from
  // draining the rest of the queue as zombies that race the retry bake.
  let aborted = false;

  const renderOne = async (o: CoverageOrigin, w: Worker | null, itm: ItmContext | null): Promise<void> => {
    const plan = planNodeRender(o, dem.bounds);
    if (!plan) {
      console.warn(`[coverage-worker] node ${o.id} footprint outside DEM bounds; skipped`);
      return;
    }
    const { clutter, canopy, buildings, transfers } = await withSliceBuildSlot(() => buildNodeSlices(plan));
    const src: RenderSources = { dem, clutter, canopy, buildings, clutterAggression: cfg.CLUTTER_AGGRESSION };
    let g: MarginGridQ8 | null;
    if (w) {
      const r = await runJob<RenderedNode | null>(w, { mode: "render", origin: o, src }, transfers);
      g = r ? { data: new Uint8Array(r.buf), width: r.width, height: r.height, bounds: r.bounds } : null;
    } else {
      g = renderNodeMargin(o, src, itm!);
    }
    if (g && gen === renderGen) {
      out.set(o.id, g.bounds);
      await onRendered(o.id, g); // grid is dropped after this — cache is its home
    }
  };

  if (cfg.WORKERS <= 1 || queue.length <= 1) {
    itmCtx ??= loadItmContext(128);
    let itm: ItmContext;
    try {
      itm = await itmCtx;
    } catch (err) {
      itmCtx = null; // don't memoize a transient WASM-load failure forever
      throw err;
    }
    for (const o of queue) await renderOne(o, null, itm);
    return out;
  }

  const workers = obtainWorkers(Math.min(cfg.WORKERS, queue.length));
  let i = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (!aborted && i < queue.length) {
        const o = queue[i++];
        try {
          await renderOne(o, w, null);
        } catch (err) {
          aborted = true;
          throw err;
        }
      }
    }),
  );
  return out;
}

/**
 * Streaming composite: grids are read from the margin cache one at a time and
 * max-blended into a sparse q8 canvas, so peak memory is one grid + the canvas
 * regardless of node count or output resolution. Workers own contiguous
 * tile-row chunks and stream their own grids from disk — no shared grid
 * buffers, no cross-worker coordination. Unreadable cache entries are dropped
 * and fail the bake (the retry re-renders them), matching the old semantics.
 */
async function compositePhase(
  affectedKeys: string[],
  refs: Array<{ id: string; bounds: DEMBounds }>,
  z: number,
): Promise<Map<string, Uint8Array>> {
  if (affectedKeys.length === 0 || refs.length === 0) return new Map();

  const failUnreadable = async (unreadable: string[]): Promise<void> => {
    if (unreadable.length === 0) return;
    const unique = [...new Set(unreadable)];
    for (const id of unique) await removeNode(cfg.CACHE_DIR, id);
    // drop the broken entries so the next bake re-renders instead of failing forever
    throw new Error(`cached margins unreadable for ${unique.length} node(s); entries dropped`);
  };

  if (cfg.WORKERS <= 1 || affectedKeys.length <= 8) {
    const { canvas, unreadable } = await streamCompositeQ8(refs, affectedKeys, z, cfg.CACHE_DIR);
    await failUnreadable(unreadable);
    return canvas;
  }

  // Contiguous row chunks: a grid spanning R rows lands in few chunks, keeping
  // duplicate disk reads low (vs round-robin, which would touch every worker).
  const rows = [...new Set(affectedKeys.map((k) => Number(k.split("/")[1])))].sort((a, b) => a - b);
  const k = Math.min(cfg.WORKERS, rows.length);
  const perChunk = Math.ceil(rows.length / k);
  const jobs: Array<{ keys: string[]; refs: Array<{ id: string; bounds: DEMBounds }> }> = [];
  for (let c = 0; c < k; c++) {
    const chunkRows = rows.slice(c * perChunk, (c + 1) * perChunk);
    if (chunkRows.length === 0) continue;
    const rowSet = new Set(chunkRows);
    const minRow = chunkRows[0];
    const maxRow = chunkRows[chunkRows.length - 1];
    const keys = affectedKeys.filter((key) => rowSet.has(Number(key.split("/")[1])));
    const chunkRefs = refs.filter((ref) => {
      const r = tileRectForBounds(ref.bounds, z);
      return r.ty0 <= maxRow && r.ty1 > minRow;
    });
    if (keys.length > 0 && chunkRefs.length > 0) jobs.push({ keys, refs: chunkRefs });
  }

  const workers = obtainWorkers(jobs.length);
  const parts = await Promise.all(
    jobs.map((job, i) =>
      runJob<CompositeResult>(workers[i], { mode: "composite", z, keys: job.keys, nodes: job.refs, cacheDir: cfg.CACHE_DIR }),
    ),
  );
  await failUnreadable(parts.flatMap((p) => p.unreadable));
  const out = new Map<string, Uint8Array>();
  for (const part of parts) for (const t of part.tiles) out.set(t.key, new Uint8Array(t.buf));
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

/** Shared DEM (SAB) + probe-derived accuracy-source availability. The DEM is
 *  the only network-wide raster left — clutter/canopy/buildings are sliced per
 *  node at render time — so sources come from cheap tile probes, which also
 *  keeps them stable across delta cycles that render only a few nodes. */
let demKey: string | null = null;
let demShared: RenderSources["dem"] | null = null;
let rasterSources: string[] = ["itm"];
let rasterLayersMissing = false;
let rasterBuiltAt = 0;
/** Sources are only trustworthy after one conclusive probe pass. */
let sourcesProbed = false;

const RASTER_REPROBE_MS = 30 * 60_000;
/** Only affects which pyramid level the probes touch (bakes are full pyramids). */
const PROBE_GRID = 4096;

type ProbeState = "present" | "absent" | "unknown";

/** Canonical layer order — rasterSources is JSON-compared against state.sources. */
const LAYER_PROBES = [
  {
    name: "nlcd",
    enabled: () => cfg.USE_CLUTTER,
    evict: evictMissingLandcoverTiles,
    selectZoom: selectLandcoverZoom,
    probe: async (z: number, x: number, y: number) => (await fetchLandcoverTile(z, x, y)).data.length > 0,
  },
  {
    name: "eth-canopy",
    enabled: () => cfg.USE_CANOPY,
    evict: evictMissingCanopyTiles,
    selectZoom: selectCanopyZoom,
    probe: async (z: number, x: number, y: number) => (await fetchCanopyTile(z, x, y)).height.length > 0,
  },
  {
    name: "jrc-buildings",
    enabled: () => cfg.USE_BUILDINGS,
    evict: evictMissingBuildingTiles,
    selectZoom: selectBuildingZoom,
    probe: async (z: number, x: number, y: number) => (await fetchBuildingTile(z, x, y)).height.length > 0,
  },
];

function enabledLayerNames(): string[] {
  return LAYER_PROBES.filter((L) => L.enabled()).map((L) => L.name);
}

/**
 * Probe whether the `wanted` layers are baked: bbox spread points at a coarse
 * zoom PLUS a sample of actual node positions at slice-realistic zoom (so a
 * regionally-baked layer that covers the nodes counts as present). A 404 is
 * conclusive ("absent" = not baked); a fetch ERROR is not — such a layer is
 * "unknown", and callers must never change state on it. Missing-tile
 * sentinels are evicted first so a bake completed after them is seen.
 */
async function probeLayers(
  bbox: DEMBounds,
  wanted: string[],
  origins: CoverageOrigin[],
): Promise<Map<string, ProbeState>> {
  const midLat = (bbox.north + bbox.south) / 2;
  const lngSpan = bbox.east - bbox.west;
  const latSpan = bbox.north - bbox.south;
  const wrap = ([lng, lat]: [number, number]): [number, number] => [
    lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng,
    lat,
  ];
  const bboxPts: Array<[number, number]> = (
    [
      [bbox.west + lngSpan / 2, midLat],
      [bbox.west + lngSpan / 4, bbox.south + latSpan / 4],
      [bbox.west + (3 * lngSpan) / 4, bbox.south + latSpan / 4],
      [bbox.west + lngSpan / 4, bbox.south + (3 * latSpan) / 4],
      [bbox.west + (3 * lngSpan) / 4, bbox.south + (3 * latSpan) / 4],
    ] as Array<[number, number]>
  ).map(wrap);
  // Up to 8 node positions, evenly sampled — bakes matter where the nodes are.
  const nodePts: Array<[number, number]> = [];
  const step = Math.max(1, Math.floor(origins.length / 8));
  for (let i = 0; i < origins.length && nodePts.length < 8; i += step) {
    nodePts.push(wrap([origins[i].lng, origins[i].lat]));
  }
  const pxBbox = Math.max(1, (lngSpan * 111_320 * Math.cos((midLat * Math.PI) / 180)) / PROBE_GRID);
  const tileXY = (lng: number, lat: number, z: number): [number, number] => {
    const s = 1 << z;
    return [((Math.floor(lng2tileX(lng, z)) % s) + s) % s, Math.floor(lat2tileY(lat, z))];
  };

  const out = new Map<string, ProbeState>();
  for (const L of LAYER_PROBES) {
    if (!wanted.includes(L.name) || !L.enabled()) continue;
    L.evict();
    const zBbox = L.selectZoom(bbox, pxBbox, 1024);
    const probeAt = (lng: number, lat: number, z: number): Promise<"hit" | "miss" | "error"> =>
      (async () => {
        const [x, y] = tileXY(lng, lat, z);
        return (await L.probe(z, x, y)) ? ("hit" as const) : ("miss" as const);
      })().catch(() => "error" as const);
    const jobs = bboxPts.map(([lng, lat]) => probeAt(lng, lat, zBbox));
    for (const [lng, lat] of nodePts) {
      const nb = { west: lng - 0.25, east: lng + 0.25, south: lat - 0.25, north: lat + 0.25 };
      jobs.push(probeAt(lng, lat, L.selectZoom(nb, cfg.OUTPUT_M_PER_PX, 256)));
    }
    const results = await Promise.all(jobs);
    out.set(L.name, results.includes("hit") ? "present" : results.includes("error") ? "unknown" : "absent");
  }
  return out;
}

/** Merge probe results ADD-ONLY: bakes appear, they don't vanish mid-run.
 *  "absent"/"unknown" never remove a present layer — a demotion on a probe
 *  blip would trigger a spurious full ITM rebake in each direction. */
function applyProbeResults(states: Map<string, ProbeState>): void {
  const present = new Set(rasterSources.filter((s) => s !== "itm"));
  for (const [name, st] of states) {
    if (st === "present") present.add(name);
  }
  rasterSources = ["itm", ...LAYER_PROBES.filter((L) => present.has(L.name)).map((L) => L.name)];
  rasterLayersMissing = enabledLayerNames().some((n) => !present.has(n));
}

async function ensureDem(bbox: DEMBounds, contextKey: string, origins: CoverageOrigin[]): Promise<RenderSources["dem"]> {
  if (!(demShared != null && demKey === contextKey)) {
    const prevDem = demShared;
    const prevKey = demKey;
    try {
      const demTiles = Math.ceil(cfg.SHARED_DEM_SIZE / 256) ** 2 * 2;
      const built = await buildDem({
        bounds: bbox,
        targetWidth: cfg.SHARED_DEM_SIZE,
        targetHeight: cfg.SHARED_DEM_SIZE,
        maxTiles: demTiles,
        token: "",
      });
      // Transient failures (vs 404) mean an outage: rendering through NaN holes
      // would cache degraded margins under an unchanged key. Abort this build.
      if (built.tilesFailed > 0) {
        throw new Error(`DEM build had ${built.tilesFailed} failed tile fetches`);
      }
      const shared = new Float32Array(new SharedArrayBuffer(built.dem.data.byteLength));
      shared.set(built.dem.data);
      demShared = { ...built.dem, data: shared };
      demKey = contextKey;
    } catch (err) {
      if (prevDem != null && prevKey === contextKey) {
        console.warn("[coverage-worker] DEM rebuild failed; keeping previous DEM:", err);
      } else {
        throw err; // no valid DEM yet — abort the bake; the loop retries next tick
      }
    }
  }

  if (!sourcesProbed) {
    // Cold start: an inconclusive probe (fetch errors, e.g. meshinfo still
    // warming up) must not mislabel a full render's sources — abort + retry.
    const states = await probeLayers(bbox, enabledLayerNames(), origins);
    if ([...states.values()].includes("unknown")) {
      throw new Error("accuracy layer probe inconclusive; retrying next tick");
    }
    applyProbeResults(states);
    sourcesProbed = true;
    rasterBuiltAt = Date.now();
  } else if (rasterLayersMissing && Date.now() - rasterBuiltAt > RASTER_REPROBE_MS) {
    rasterBuiltAt = Date.now(); // pace probes even when they find nothing
    const prev = JSON.stringify(rasterSources);
    // Only the still-missing layers are probed; results merge add-only.
    const missing = enabledLayerNames().filter((n) => !rasterSources.includes(n));
    applyProbeResults(await probeLayers(bbox, missing, origins));
    if (JSON.stringify(rasterSources) !== prev) {
      console.log(`[coverage-worker] accuracy layer availability changed → ${rasterSources}`);
    }
  }
  return demShared!;
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
 * Bake one group's pyramid to a temp dir then atomically swap it into
 * `${OUTPUT_DIR}/${group}`; returns + writes metadata.json. An empty origin
 * set erases the previous output (a mesh gone quiet must not keep serving
 * stale coverage); returns null when there is nothing baked and nothing to
 * erase. `bbox` is supplied by bakeAllGroups — shared across groups so the
 * per-node margin cache is shared too. `cycleSources` (group bakes only) is
 * the all-bake's authoritative sources for this cycle: cache reuse is judged
 * against it, and a group whose painted sources lag it recomposites from the
 * fresh cache instead of re-running ITM.
 */
async function bakeCoverage(
  origins: CoverageOrigin[],
  version: string,
  bbox: DEMBounds,
  group: string,
  groups: string[],
  cycleSources: string[] | null = null,
): Promise<BakeMetadata | null> {
  const z = cfg.MAX_ZOOM;
  const outDir = join(cfg.OUTPUT_DIR, group);
  // state.json lives inside the output dir (written pre-swap) so the two stay atomic
  const state = await loadState(outDir);
  if (origins.length === 0 && (!state || Object.keys(state.active).length === 0)) {
    return null; // nothing baked, nothing to erase
  }
  const contextKey = contextKeyFor(bbox);
  const dims = tileRectForBounds(bbox, z);
  let incremental = state != null && state.contextKey === contextKey;
  // Painted sources lag the cycle's (accuracy layer appeared mid-run): the
  // grids in cache are already re-rendered — recomposite everything, render nothing.
  if (incremental && cycleSources && JSON.stringify(state?.sources ?? null) !== JSON.stringify(cycleSources)) {
    incremental = false;
  }

  const wantKey = new Map(origins.map((o) => [o.id, originStateKey(o)]));
  // A cached margin is only reusable if it was rendered with the sources this
  // cycle's output uses — a node absent across a sources change must not
  // re-enter with its stale (e.g. clutter-free) grid.
  const wantSources =
    cycleSources != null
      ? JSON.stringify(cycleSources)
      : state?.sources != null
        ? JSON.stringify(state.sources)
        : null;
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

  // Unchanged group (same painted set, same context, same groups list, nothing
  // to render): keep the existing output byte-for-byte — the stable version
  // means clients viewing it don't even revalidate tiles this cycle.
  if (incremental && state && toRender.length === 0 && removedIds.length === 0) {
    const same =
      origins.length === Object.keys(state.active).length &&
      origins.every((o) => (state.active[o.id] as ActiveNodeState | undefined)?.key === wantKey.get(o.id));
    if (same) {
      try {
        const prev = JSON.parse(await readFile(join(outDir, "metadata.json"), "utf8")) as BakeMetadata;
        if (JSON.stringify(prev.groups) === JSON.stringify(groups)) return prev;
      } catch {
        // metadata unreadable — fall through to a real bake
      }
    }
  }

  // Render only what changed; a pure-aging delta skips the DEM + ITM entirely.
  // Bounds only — the grids live in the margin cache and stream at composite.
  let rendered = new Map<string, DEMBounds>();
  if (toRender.length > 0) {
    const dem = await ensureDem(bbox, contextKey, origins);
    // Sources changed (e.g. NLCD baked later): cached margins lack the layer —
    // re-render all. Group bakes skip this: cycleSources already reconciled it.
    if (!cycleSources && incremental && state?.sources && JSON.stringify(rasterSources) !== JSON.stringify(state.sources)) {
      console.log(`[coverage-worker] accuracy sources changed (${state.sources} → ${rasterSources}) — full rebake`);
      toRender = [...origins];
      reusableIds.length = 0; // everything re-renders; don't composite stale grids twice
      incremental = false;
    }
    // Margins stream into the cache as workers finish, so an aborted first
    // bake resumes from what completed instead of starting over.
    rendered = await renderPhase(toRender, dem, bbox, async (id, g) => {
      await writeNode(
        cfg.CACHE_DIR,
        { id, stateKey: wantKey.get(id)!, contextKey, width: g.width, height: g.height, bounds: g.bounds, sources: rasterSources },
        g.data,
      );
    });
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
      const gb = rendered.get(o.id);
      if (gb) addBounds(gb);
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
    for (const [, gb] of rendered) addBounds(gb);
    for (const id of reusableIds) addBounds(oldHeaders.get(id)!.bounds);
  }

  // Grid REFERENCES to composite (id + bounds only): fresh renders + cached
  // unchanged nodes whose footprints intersect an affected tile. The grids
  // themselves are streamed from the cache inside compositePhase.
  const affectedTiles = [...affected].map((k) => {
    const [tx, ty] = k.split("/").map(Number);
    return { tx, ty };
  });
  const compositeRefs: Array<{ id: string; bounds: DEMBounds }> = [...rendered].map(([id, bounds]) => ({ id, bounds }));
  for (const id of reusableIds) {
    const h = oldHeaders.get(id)!;
    const r = clampRect(tileRectForBounds(h.bounds, z), dims);
    const touches = affectedTiles.some((t) => t.tx >= r.tx0 && t.tx < r.tx1 && t.ty >= r.ty0 && t.ty < r.ty1);
    if (touches) compositeRefs.push({ id, bounds: h.bounds });
  }

  const canvas = await compositePhase([...affected], compositeRefs, z);

  // Streaming write-through: each colorized tile is encoded + written to the
  // tmp dir immediately and only its KEY is retained (`flushed`/`erased`);
  // holding all RGBA in memory would peak >1 GB on a full rebake. Pyramid
  // parents re-read their just-flushed children from tmp, one decode per child.
  const tmpDir = `${outDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const BATCH = 16;
  const flushed = new Set<string>();
  const erased = new Set<string>();
  const flushTile = async (key: string, rgba: Uint8ClampedArray): Promise<void> => {
    const png = await encodePng(rgba, TILE_SIZE, TILE_SIZE);
    const p = join(tmpDir, `${key}.png`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, png);
    flushed.add(key);
  };

  // Base level: colorize + flush per affected key; null = now empty (erases
  // the old PNG). Keys wrap to canonical tile x — composite ran unwrapped.
  {
    const affectedList = [...affected];
    for (let i = 0; i < affectedList.length; i += BATCH) {
      await Promise.all(
        affectedList.slice(i, i + BATCH).map(async (k) => {
          const [tx, ty] = k.split("/").map(Number);
          const key = `${z}/${wrapX(tx, z)}/${ty}`;
          const tile = canvas.get(k);
          canvas.delete(k); // free each q8 tile as soon as it's colorized
          if (tile) await flushTile(key, colorizeQ8(tile));
          else erased.add(key);
        }),
      );
    }
  }

  const decodeTmp = async (key: string): Promise<Uint8ClampedArray | null> => {
    try {
      const buf = await readFile(join(tmpDir, `${key}.png`));
      const px = await decodeTilePixels(new Blob([new Uint8Array(buf)]));
      return px.width === TILE_SIZE && px.height === TILE_SIZE ? px.data : null;
    } catch {
      return null;
    }
  };

  // Bounded cache for old-output reads (each fresh child is read exactly once,
  // but untouched siblings recur across parents on big deltas).
  const prevDecoded = new Map<string, Uint8ClampedArray | null>();
  const PREV_DECODED_CAP = 256;
  const getChild = async (cz: number, x: number, y: number): Promise<Uint8ClampedArray | null> => {
    const key = `${cz}/${wrapX(x, cz)}/${y}`;
    if (erased.has(key)) return null;
    if (flushed.has(key)) return decodeTmp(key);
    if (!incremental) return null;
    if (prevDecoded.has(key)) return prevDecoded.get(key)!;
    let rgba: Uint8ClampedArray | null = null;
    try {
      const buf = await readFile(join(outDir, `${key}.png`));
      const px = await decodeTilePixels(new Blob([new Uint8Array(buf)]));
      if (px.width === TILE_SIZE && px.height === TILE_SIZE) rgba = px.data;
    } catch {
      rgba = null;
    }
    if (prevDecoded.size >= PREV_DECODED_CAP) {
      const oldest = prevDecoded.keys().next().value;
      if (oldest !== undefined) prevDecoded.delete(oldest);
    }
    prevDecoded.set(key, rgba);
    return rgba;
  };

  // Rebuild the ancestor chain of every affected tile, MAX_ZOOM-1 down to
  // MIN_ZOOM, flushing each parent as soon as it's built.
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
      const key = `${pz}/${wrapX(tx, pz)}/${ty}`;
      const rgba = await buildParent(getChild, pz, tx, ty);
      if (rgba) await flushTile(key, rgba);
      else erased.add(key);
    }
    level = parents;
  }

  // Carry every untouched PNG forward. Anything flushed or erased this bake
  // must NOT be carried — a stale copy would overwrite the fresh write.
  let copied = 0;
  if (incremental) {
    const names = await readdir(outDir, { recursive: true });
    const carried: string[] = [];
    for (const name of names) {
      const key = String(name).replace(/\\/g, "/");
      if (!key.endsWith(".png")) continue;
      const tileKey = key.slice(0, -4);
      if (flushed.has(tileKey) || erased.has(tileKey)) continue;
      carried.push(key);
    }
    // Hardlink (copy as fallback) so carry-forward I/O is O(delta), and the
    // untouched tiles keep their inode + mtime — their ETags stay stable, so
    // clients revalidating after a bake get 304s instead of re-downloads.
    for (let i = 0; i < carried.length; i += BATCH * 4) {
      await Promise.all(
        carried.slice(i, i + BATCH * 4).map(async (key) => {
          const src = join(outDir, key);
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
    tileCount: copied + flushed.size,
    recencyHours: cfg.RECENCY_HOURS,
    sources: toRender.length > 0 ? rasterSources : state?.sources ?? cachedSources ?? rasterSources,
    group,
    groups,
  };
  await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2));

  const activeOut: Record<string, ActiveNodeState> = {};
  for (const o of origins) {
    const b = rendered.get(o.id) ?? oldHeaders.get(o.id)?.bounds;
    if (b) activeOut[o.id] = { key: wantKey.get(o.id)!, bounds: b };
  }
  const newState: CacheState = {
    contextKey,
    active: activeOut,
    sources: meta.sources,
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
  };
  await saveState(tmpDir, newState); // rides the swap with the tiles it describes

  await swapDirs(tmpDir, outDir);

  console.log(
    `[coverage-worker] ${incremental ? "delta" : "full"} bake [${group}]: ${toRender.length} rendered, ` +
      `${reusableIds.length} cached, ${removedIds.length} removed, ${affected.size} tiles recomposited, ${copied} reused`,
  );
  return meta;
}

/** "all" plus one group per modem preset. Group names double as directory and
 *  URL segments, so they must stay path/URL-safe. */
export const GROUP_ALL = "all";
const GROUP_NAME_RE = /^[A-Za-z0-9-]{1,32}$/;

/**
 * Swap `tmpDir` into place as `outDir`: previous output aside, new in, old
 * removed. Windows bind mounts (Docker Desktop dev) refuse directory renames
 * while a served file inside is open, so a failed swap restores the previous
 * output and retries once before surfacing — the bake loop retries the cycle
 * anyway, and the restored output keeps serving meanwhile.
 */
async function swapDirs(tmpDir: string, outDir: string): Promise<void> {
  const oldDir = `${outDir}.old`;
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(oldDir, { recursive: true, force: true });
      await rename(outDir, oldDir).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err; // ENOENT = first bake, nothing to move aside
      });
      await mkdir(dirname(outDir) || ".", { recursive: true });
      await rename(tmpDir, outDir);
      await rm(oldDir, { recursive: true, force: true });
      return;
    } catch (err) {
      await rename(oldDir, outDir).catch(() => {}); // no-op unless outDir went missing
      if (attempt >= 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * One bake cycle: the combined "all" pyramid plus a pyramid per modem preset
 * present (or previously baked — an emptied preset erases, then its dir is
 * dropped). All groups share the sticky bbox, so contextKey matches and each
 * node's ITM margin renders once, into the shared cache, no matter how many
 * pyramids composite it. Returns the "all" metadata (null = nothing anywhere).
 */
export async function bakeAllGroups(origins: CoverageOrigin[], version: string): Promise<BakeMetadata | null> {
  const allState = await loadState(join(cfg.OUTPUT_DIR, GROUP_ALL));
  const stored: DEMBounds | null = allState?.bbox
    ? { west: allState.bbox[0], south: allState.bbox[1], east: allState.bbox[2], north: allState.bbox[3] }
    : null;

  // Sticky bbox — a change moves DEM resolution and invalidates every cached
  // margin, so keep it while nodes fit and grow (never shrink) otherwise.
  let bbox: DEMBounds;
  if (origins.length === 0) {
    if (!stored) return null; // nothing ever baked, nothing to erase
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

  // Group set: presets present now, plus baked group dirs that need erasing.
  // Ghost dirs (nothing painted, or an unreadable state that could otherwise
  // serve stale tiles forever) are removed outright.
  const present = new Set(origins.map((o) => o.preset).filter((p) => GROUP_NAME_RE.test(p) && p !== GROUP_ALL));
  const groupSet = new Set(present);
  let dirsChanged = false;
  try {
    for (const e of await readdir(cfg.OUTPUT_DIR, { withFileTypes: true })) {
      const name = e.name;
      if (!e.isDirectory() || name === GROUP_ALL || present.has(name) || !GROUP_NAME_RE.test(name)) continue;
      const s = await loadState(join(cfg.OUTPUT_DIR, name));
      if (s && Object.keys(s.active).length > 0) {
        groupSet.add(name); // still painted — bake (erases if its preset emptied)
      } else {
        await rm(join(cfg.OUTPUT_DIR, name), { recursive: true, force: true });
        dirsChanged = true;
      }
    }
  } catch {
    // output root doesn't exist yet — first run
  }
  const groups = [GROUP_ALL, ...[...groupSet].sort()];

  let metaAll = await bakeCoverage(origins, version, bbox, GROUP_ALL, groups);
  for (const g of groups) {
    if (g === GROUP_ALL) continue;
    // The all-bake's sources are the cycle's truth: group bakes reuse its
    // freshly-written cache instead of re-running ITM on a sources change.
    await bakeCoverage(origins.filter((o) => o.preset === g), version, bbox, g, groups, metaAll?.sources ?? null);
  }

  // A quiet mesh at the backstop removes dirs while the all-bake no-ops (its
  // active set is already empty) — refresh the advertised groups list anyway,
  // or clients keep seeing chips whose pyramids 404.
  if (!metaAll && dirsChanged) {
    metaAll = await rewriteGroupsList(groups, version);
  }

  await pruneCache(cfg.CACHE_DIR, new Set(origins.map((o) => o.id)), cfg.CACHE_PRUNE_DAYS);
  return metaAll;
}

/** In-place update of all/metadata.json's groups list (atomic tmp+rename);
 *  used when directories changed but no group had anything to bake. */
async function rewriteGroupsList(groups: string[], version: string): Promise<BakeMetadata | null> {
  const p = join(cfg.OUTPUT_DIR, GROUP_ALL, "metadata.json");
  try {
    const meta = JSON.parse(await readFile(p, "utf8")) as BakeMetadata;
    const updated: BakeMetadata = { ...meta, version, generatedAt: new Date().toISOString(), groups };
    await writeFile(`${p}.tmp`, JSON.stringify(updated, null, 2));
    await rename(`${p}.tmp`, p);
    return updated;
  } catch {
    return null; // no all-metadata at all — nothing advertised, nothing to fix
  }
}

/** Remove pre-group flat-layout leftovers (tiles/metadata at the output root);
 *  they'd otherwise sit unread next to the group dirs forever. Run once at boot. */
export async function cleanupLegacyLayout(): Promise<void> {
  await rm(join(cfg.OUTPUT_DIR, "metadata.json"), { force: true });
  await rm(join(cfg.OUTPUT_DIR, "state.json"), { force: true });
  try {
    for (const e of await readdir(cfg.OUTPUT_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d{1,2}$/.test(e.name)) {
        await rm(join(cfg.OUTPUT_DIR, e.name), { recursive: true, force: true });
      }
    }
  } catch {
    // nothing baked yet
  }
}
