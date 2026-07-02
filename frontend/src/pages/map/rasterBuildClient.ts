/**
 * Promise API over the raster-build worker. Falls back to main-thread builds
 * if the worker can't start (very old browsers, blocked workers).
 */
import { env } from "../../env";
import { buildBuildingRaster } from "./buildingTiles";
import { buildCanopyRaster } from "./canopyTiles";
import { buildClutterRaster } from "./landcoverTiles";
import type {
  RasterBuildRequest,
  RasterBuildResponse,
  RasterBuildResult,
} from "./rasterBuildWorker";
import type { DEMBounds } from "./terrainDEM";
import { buildDem } from "./terrainRgb";

export interface BuildRastersOptions {
  bounds: DEMBounds;
  size: number;
  maxTiles: number;
  token: string;
  wantClutter: boolean;
  wantCanopy: boolean;
  wantBuildings: boolean;
}

let worker: Worker | null = null;
let workerBroken = false;
/** True once the worker has delivered any response — distinguishes a script
 *  that never loaded (404 after redeploy, CSP block: permanent, fall back)
 *  from a runtime death (OOM: recreate lazily). */
let workerDelivered = false;
let nextId = 1;
const pending = new Map<number, {
  opts: BuildRastersOptions;
  resolve: (r: RasterBuildResult) => void;
  reject: (e: Error) => void;
}>();

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./rasterBuildWorker.ts", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    console.warn("[rasterBuild] worker unavailable, building on main thread:", err);
    workerBroken = true;
    return null;
  }
  worker.onmessage = (evt: MessageEvent<RasterBuildResponse>) => {
    workerDelivered = true;
    const resp = evt.data;
    const p = pending.get(resp.id);
    if (!p) return;
    pending.delete(resp.id);
    if (resp.error !== undefined) p.reject(new Error(resp.error));
    else p.resolve(resp);
  };
  worker.onerror = (err) => {
    console.warn("[rasterBuild] worker error:", err.message);
    worker?.terminate();
    worker = null;
    const drained = [...pending.values()];
    pending.clear();
    if (!workerDelivered) {
      // Script never loaded — permanent for this session. Serve the live
      // requests on the main thread instead of failing them.
      workerBroken = true;
      for (const p of drained) {
        buildOnMainThread(p.opts).then(p.resolve, p.reject);
      }
    } else {
      // Runtime death after prior successes: fail live builds, recreate lazily.
      for (const p of drained) {
        p.reject(new Error(err.message || "raster build worker error"));
      }
    }
  };
  return worker;
}

async function buildOnMainThread(opts: BuildRastersOptions): Promise<RasterBuildResult> {
  const common = {
    bounds: opts.bounds,
    targetWidth: opts.size,
    targetHeight: opts.size,
    maxTiles: opts.maxTiles,
  };
  const [built, clutter, canopy, buildings] = await Promise.all([
    buildDem({ ...common, token: opts.token }),
    opts.wantClutter ? buildClutterRaster(common) : Promise.resolve(null),
    opts.wantCanopy ? buildCanopyRaster(common) : Promise.resolve(null),
    opts.wantBuildings ? buildBuildingRaster(common) : Promise.resolve(null),
  ]);
  return {
    dem: built.dem,
    demSource: built.source,
    demTilesFailed: built.tilesFailed,
    demTilesTotal: built.tilesTotal,
    clutter,
    canopy,
    buildings,
  };
}

/** Build the coverage raster set, preferring the worker. */
export function buildCoverageRasters(opts: BuildRastersOptions): Promise<RasterBuildResult> {
  const w = ensureWorker();
  if (!w) return buildOnMainThread(opts);
  return new Promise<RasterBuildResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { opts, resolve, reject });
    const req: RasterBuildRequest = {
      id,
      bounds: opts.bounds,
      size: opts.size,
      maxTiles: opts.maxTiles,
      token: opts.token,
      wantClutter: opts.wantClutter,
      wantCanopy: opts.wantCanopy,
      wantBuildings: opts.wantBuildings,
      runtimeEnv: { VITE_API_BASE_URL: env.API_BASE_URL },
    };
    w.postMessage(req);
  });
}
