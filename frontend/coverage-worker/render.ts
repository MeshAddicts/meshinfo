/**
 * Bake coverage tiles: one shared DEM over the network bbox; per node, render
 * single-origin coverage over a footprint sub-DEM and composite max-margin into a
 * web-mercator accumulator (across worker_threads); colourise → slice to XYZ tiles.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { buildBuildingRaster } from "../src/pages/map/buildingTiles";
import { buildCanopyRaster } from "../src/pages/map/canopyTiles";
import { type ItmContext, loadItmContext } from "../src/pages/map/itm";
import { buildClutterRaster } from "../src/pages/map/landcoverTiles";
import { type DEMBounds, unionDemBoundsAround } from "../src/pages/map/terrainDEM";
import { buildDem } from "../src/pages/map/terrainRgb";
import { colorizeMargin } from "./colorize";
import * as cfg from "./config";
import { TILE_SIZE } from "./mercator";
import { type AccDims, type Accumulator, compositeNode, computeAccDims, type RenderSources } from "./nodeRender";
import type { CoverageOrigin } from "./nodes";
import { encodePng } from "./sharpImage";

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

/** NaN-aware per-pixel max merge of `src` into `dst`. */
function mergeMax(dst: Float32Array, src: Float32Array): void {
  for (let i = 0; i < dst.length; i++) {
    const m = src[i];
    if (Number.isNaN(m)) continue;
    const prev = dst[i];
    if (Number.isNaN(prev) || m > prev) dst[i] = m;
  }
}

function renderMarginInline(origins: CoverageOrigin[], src: RenderSources, dims: AccDims, z: number, itm: ItmContext): Float32Array {
  const margin = new Float32Array(dims.accW * dims.accH);
  margin.fill(Number.NaN);
  const acc: Accumulator = { margin, accX0: dims.accX0, accY0: dims.accY0, accW: dims.accW, accH: dims.accH };
  for (const o of origins) compositeNode(o, src, itm, z, acc);
  return margin;
}

/** Fan the per-node renders across worker_threads; each returns a private margin,
 *  merged by max. Shared rasters are passed zero-copy via SharedArrayBuffer. */
async function renderMarginParallel(
  origins: CoverageOrigin[],
  src: RenderSources,
  dims: AccDims,
  z: number,
): Promise<Float32Array> {
  const shared = shareSources(src);

  const k = Math.min(cfg.WORKERS, origins.length);
  const groups: CoverageOrigin[][] = Array.from({ length: k }, () => []);
  origins.forEach((o, i) => groups[i % k].push(o));

  const workerUrl = new URL("./renderWorker.ts", import.meta.url);
  const parts = await Promise.all(
    groups.map(
      (group) =>
        new Promise<Float32Array>((resolve, reject) => {
          const w = new Worker(workerUrl, {
            workerData: { src: shared, z, dims, origins: group },
            execArgv: ["--import", "tsx"],
          });
          w.once("message", (msg: ArrayBuffer | { error: string }) => {
            void w.terminate();
            if (msg instanceof ArrayBuffer) resolve(new Float32Array(msg));
            else reject(new Error(msg.error));
          });
          w.once("error", reject);
        }),
    ),
  );

  const margin = new Float32Array(dims.accW * dims.accH);
  margin.fill(Number.NaN);
  for (const part of parts) mergeMax(margin, part);
  return margin;
}

/** Extract a 256² RGBA tile from the accumulator RGBA at (ox, oy); null if empty. */
function extractTile(rgba: Uint8ClampedArray, accW: number, accH: number, ox: number, oy: number) {
  const tile = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  let any = false;
  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const ay = oy + ty;
    if (ay < 0 || ay >= accH) continue;
    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const ax = ox + tx;
      if (ax < 0 || ax >= accW) continue;
      const a = rgba[(ay * accW + ax) * 4 + 3];
      if (a === 0) continue;
      const di = (ty * TILE_SIZE + tx) * 4;
      const si = (ay * accW + ax) * 4;
      tile[di] = rgba[si];
      tile[di + 1] = rgba[si + 1];
      tile[di + 2] = rgba[si + 2];
      tile[di + 3] = a;
      any = true;
    }
  }
  return any ? tile : null;
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

/** Assemble a parent tile from its four z+1 children (downsampled into quadrants). */
function buildParent(tiles: Map<string, Uint8ClampedArray>, z: number, tx: number, ty: number): Uint8ClampedArray | null {
  const half = TILE_SIZE / 2;
  const parent = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  let any = false;
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const child = tiles.get(`${z + 1}/${2 * tx + cx}/${2 * ty + cy}`);
    if (!child) continue;
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
    any = true;
  }
  return any ? parent : null;
}

/** Bake to a temp dir then atomically swap into OUTPUT_DIR; returns + writes metadata.json. */
export async function bakeCoverage(origins: CoverageOrigin[], version: string): Promise<BakeMetadata> {
  const positions = origins.map((o) => [o.lng, o.lat] as [number, number]);
  const maxReach = origins.reduce((m, o) => Math.max(m, o.reachKm), cfg.CLIENT_REACH_KM);
  const bbox: DEMBounds = unionDemBoundsAround(positions, maxReach, 1.05);

  // One shared terrain DEM + accuracy rasters (NLCD/ETH/JRC) over the network bbox.
  const dim = { bounds: bbox, targetWidth: cfg.SHARED_DEM_SIZE, targetHeight: cfg.SHARED_DEM_SIZE, maxTiles: 1024 };
  const [{ dem }, clutter, canopy, buildings] = await Promise.all([
    buildDem({ ...dim, token: "" }),
    cfg.USE_CLUTTER ? buildClutterRaster(dim).catch(() => null) : Promise.resolve(null),
    cfg.USE_CANOPY ? buildCanopyRaster(dim).catch(() => null) : Promise.resolve(null),
    cfg.USE_BUILDINGS ? buildBuildingRaster(dim).catch(() => null) : Promise.resolve(null),
  ]);
  const src: RenderSources = {
    dem,
    clutter,
    canopy,
    buildings,
    clutterAggression: clutter ? cfg.CLUTTER_AGGRESSION : 0,
  };

  const z = cfg.MAX_ZOOM;
  const dims = computeAccDims(bbox, z);
  let margin: Float32Array;
  if (cfg.WORKERS > 1 && origins.length > 1) {
    margin = await renderMarginParallel(origins, src, dims, z);
  } else {
    margin = renderMarginInline(origins, src, dims, z, await loadItmContext(128));
  }
  const accRgba = colorizeMargin(margin, dims.accW * dims.accH);
  const sources = ["itm"];
  if (clutter?.tilesPresent) sources.push("nlcd");
  if (canopy?.tilesPresent) sources.push("eth-canopy");
  if (buildings?.tilesPresent) sources.push("jrc-buildings");

  // MAX_ZOOM tiles from the accumulator, then parent zooms by 2×2 downsample.
  const tiles = new Map<string, Uint8ClampedArray>();
  for (let tx = dims.tx0; tx < dims.tx1; tx++) {
    for (let ty = dims.ty0; ty < dims.ty1; ty++) {
      const tile = extractTile(accRgba, dims.accW, dims.accH, tx * TILE_SIZE - dims.accX0, ty * TILE_SIZE - dims.accY0);
      if (tile) tiles.set(`${z}/${tx}/${ty}`, tile);
    }
  }
  const minZoom = Math.min(cfg.MIN_ZOOM, z);
  for (let pz = z - 1; pz >= minZoom; pz--) {
    const d = computeAccDims(bbox, pz);
    for (let tx = d.tx0; tx < d.tx1; tx++) {
      for (let ty = d.ty0; ty < d.ty1; ty++) {
        const parent = buildParent(tiles, pz, tx, ty);
        if (parent) tiles.set(`${pz}/${tx}/${ty}`, parent);
      }
    }
  }

  const tmpDir = `${cfg.OUTPUT_DIR}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  for (const [key, rgba] of tiles) {
    const png = await encodePng(rgba, TILE_SIZE, TILE_SIZE);
    const p = join(tmpDir, `${key}.png`);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, png);
  }

  const meta: BakeMetadata = {
    version,
    generatedAt: new Date().toISOString(),
    bounds: [bbox.west, bbox.south, bbox.east, bbox.north],
    minZoom,
    maxZoom: z,
    nodeCount: origins.length,
    tileCount: tiles.size,
    recencyHours: cfg.RECENCY_HOURS,
    sources,
  };
  await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2));

  // Swap old aside, new into place.
  const oldDir = `${cfg.OUTPUT_DIR}.old`;
  await rm(oldDir, { recursive: true, force: true });
  await rename(cfg.OUTPUT_DIR, oldDir).catch(() => {});
  await mkdir(dirname(cfg.OUTPUT_DIR) || ".", { recursive: true });
  await rename(tmpDir, cfg.OUTPUT_DIR);
  await rm(oldDir, { recursive: true, force: true });

  return meta;
}
