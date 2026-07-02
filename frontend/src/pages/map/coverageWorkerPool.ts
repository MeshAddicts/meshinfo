/**
 * Promise-based worker pool for coverage slice workers. Sized to
 * navigator.hardwareConcurrency, capped at MAX_POOL_SIZE. FCFS dispatch;
 * workers keep ITM WASM warm across tasks.
 *
 * Rasters are registered once per generation via setRasters(); the pool
 * clones + transfers them lazily per worker on first use of a generation,
 * so same-generation recomputes ship no buffers.
 */
import type { BuildingRaster } from "./buildingTiles";
import type { CanopyRaster } from "./canopyTiles";
import type {
  CoverageRasterPayload,
  CoverageSliceRequest,
  CoverageSliceResponse,
} from "./coverageSliceWorker";
import type { ClutterRaster } from "./landcoverTiles";
import type { DEM } from "./terrainDEM";

const MAX_POOL_SIZE = 8;

/** Authoritative raster set the pool clones per worker on demand. */
export interface PoolRasterSet {
  dem: DEM;
  clutter: ClutterRaster | null;
  canopy: CanopyRaster | null;
  buildings: BuildingRaster | null;
}

interface PendingTask {
  req: CoverageSliceRequest;
  resolve: (r: CoverageSliceResponse) => void;
  reject: (err: unknown) => void;
}

export class CoverageWorkerPool {
  private readonly workers: Worker[];
  private readonly busy: Set<Worker> = new Set();
  private readonly queue: PendingTask[] = [];
  /** Tracked so terminate() can reject them (worker death = no response). */
  private readonly inFlight: Set<PendingTask> = new Set();
  /** Monotonic raster generation; slices reference it instead of carrying buffers. */
  private rasterGen = 0;
  private rasters: PoolRasterSet | null = null;
  /** Which generation each worker has cached. */
  private readonly workerGen = new WeakMap<Worker, number>();
  /** Set by terminate(); dispatches after that reject immediately. */
  private terminated = false;

  constructor(size?: number) {
    const concurrency = navigator.hardwareConcurrency || 4;
    const n = Math.max(1, Math.min(MAX_POOL_SIZE, size ?? concurrency));
    this.workers = Array.from({ length: n }, () =>
      new Worker(new URL("./coverageSliceWorker.ts", import.meta.url), {
        type: "module",
      }),
    );
  }

  get size(): number {
    return this.workers.length;
  }

  /** Register the raster set for subsequent slices. No copies happen here —
   *  each worker receives its clone on the first slice of the new generation. */
  setRasters(rasters: PoolRasterSet): number {
    this.rasterGen += 1;
    this.rasters = rasters;
    return this.rasterGen;
  }

  /** The generation the pool currently serves; callers must re-register
   *  (setRasters) before dispatching if their handle is older. */
  get currentGen(): number {
    return this.rasterGen;
  }

  /** Pre-compile ITM WASM in every worker ahead of the first compute. */
  warmup(): void {
    for (const w of this.workers) {
      try {
        w.postMessage({ kind: "warmup" });
      } catch {}
    }
  }

  /** Drop the raster refs and tell workers to free their caches (~100 MB each
   *  at full tiers). Safe to call anytime; the next compute re-registers. */
  releaseRasters(): void {
    this.rasters = null;
    for (const w of this.workers) {
      this.workerGen.delete(w);
      try {
        w.postMessage({ kind: "clearRasters" });
      } catch {}
    }
  }

  /** Reject all queued (not yet running) tasks. Called when a newer request
   *  supersedes them so heavy stale slices don't delay fresh work. In-flight
   *  slices can't be aborted (synchronous WASM) and run to completion. */
  dropQueued(): void {
    if (this.queue.length === 0) return;
    const err = new Error("pool superseded");
    for (const t of this.queue) t.reject(err);
    this.queue.length = 0;
  }

  /** Dispatch to first free worker; queues if all busy. */
  dispatch(req: CoverageSliceRequest): Promise<CoverageSliceResponse> {
    return new Promise((resolve, reject) => {
      if (this.terminated) {
        // Tasks queued on a dead pool never settle; message must match the
        // benign-cancel regex in useCoverageCompute
        reject(new Error("pool terminated"));
        return;
      }
      const task: PendingTask = { req, resolve, reject };
      const free = this.workers.find((w) => !this.busy.has(w));
      if (free) {
        this.run(free, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  /** Clone the registered rasters into transferable buffers for one worker. */
  private buildPayload(): { payload: CoverageRasterPayload; transfer: Transferable[] } | null {
    const r = this.rasters;
    if (!r) return null;
    const demCopy = new Float32Array(r.dem.data);
    const clutterCopy = r.clutter ? new Uint8Array(r.clutter.data) : null;
    const canopyHeightCopy = r.canopy ? new Float32Array(r.canopy.heightM) : null;
    const canopyStdCopy = r.canopy ? new Float32Array(r.canopy.stdM) : null;
    const canopyMaskCopy = r.canopy ? new Float32Array(r.canopy.mask) : null;
    const buildingHeightCopy = r.buildings ? new Float32Array(r.buildings.heightM) : null;
    const buildingMaskCopy = r.buildings ? new Float32Array(r.buildings.mask) : null;
    const payload: CoverageRasterPayload = {
      demBuffer: demCopy.buffer,
      demWidth: r.dem.width,
      demHeight: r.dem.height,
      bounds: r.dem.bounds,
      clutterBuffer: clutterCopy?.buffer,
      clutterWidth: r.clutter?.width,
      clutterHeight: r.clutter?.height,
      canopyHeightBuffer: canopyHeightCopy?.buffer,
      canopyStdBuffer: canopyStdCopy?.buffer,
      canopyMaskBuffer: canopyMaskCopy?.buffer,
      canopyWidth: r.canopy?.width,
      canopyHeight: r.canopy?.height,
      buildingHeightBuffer: buildingHeightCopy?.buffer,
      buildingMaskBuffer: buildingMaskCopy?.buffer,
      buildingWidth: r.buildings?.width,
      buildingHeight: r.buildings?.height,
    };
    const transfer: Transferable[] = [demCopy.buffer];
    if (clutterCopy) transfer.push(clutterCopy.buffer);
    if (canopyHeightCopy) transfer.push(canopyHeightCopy.buffer);
    if (canopyStdCopy) transfer.push(canopyStdCopy.buffer);
    if (canopyMaskCopy) transfer.push(canopyMaskCopy.buffer);
    if (buildingHeightCopy) transfer.push(buildingHeightCopy.buffer);
    if (buildingMaskCopy) transfer.push(buildingMaskCopy.buffer);
    return { payload, transfer };
  }

  private postTask(worker: Worker, task: PendingTask): boolean {
    const needRasters =
      task.req.rasterGen === this.rasterGen &&
      this.workerGen.get(worker) !== task.req.rasterGen;
    if (needRasters) {
      const built = this.buildPayload();
      if (!built) return false;
      this.workerGen.set(worker, task.req.rasterGen);
      worker.postMessage({ ...task.req, rasters: built.payload }, built.transfer);
      return true;
    }
    worker.postMessage(task.req);
    return true;
  }

  private run(worker: Worker, task: PendingTask): void {
    this.busy.add(worker);
    this.inFlight.add(task);
    let retriedMiss = false;
    const onMessage = (evt: MessageEvent<CoverageSliceResponse>) => {
      if (evt.data.requestId !== task.req.requestId) return;
      if (evt.data.cacheMiss) {
        // Worker lost/never had this generation; re-send once with buffers
        if (!retriedMiss && task.req.rasterGen === this.rasterGen && this.rasters) {
          retriedMiss = true;
          const built = this.buildPayload();
          if (built) {
            this.workerGen.set(worker, task.req.rasterGen);
            worker.postMessage({ ...task.req, rasters: built.payload }, built.transfer);
            return;
          }
        }
        cleanup();
        task.reject(new Error("pool superseded"));
        return;
      }
      cleanup();
      task.resolve(evt.data);
    };
    const onError = (err: ErrorEvent) => {
      // An errored worker may be dead — replace it or the next task hangs
      workerBroken = true;
      cleanup();
      task.reject(err.error ?? new Error(err.message));
    };
    let workerBroken = false;
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      this.busy.delete(worker);
      this.inFlight.delete(task);
      const successor = workerBroken ? this.replaceWorker(worker) : worker;
      const next = this.queue.shift();
      if (next && successor) this.run(successor, next);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    if (!this.postTask(worker, task)) {
      cleanup();
      task.reject(new Error("pool superseded"));
    }
  }

  /** Swap a broken worker for a fresh one in place. Returns null if the pool
   *  was terminated in the meantime. */
  private replaceWorker(dead: Worker): Worker | null {
    dead.terminate();
    this.workerGen.delete(dead);
    const idx = this.workers.indexOf(dead);
    if (idx < 0) return null; // pool terminated
    const fresh = new Worker(new URL("./coverageSliceWorker.ts", import.meta.url), {
      type: "module",
    });
    this.workers[idx] = fresh;
    return fresh;
  }

  /** Terminate all workers; reject queued + in-flight tasks (promises would otherwise hang). */
  terminate(): void {
    this.terminated = true;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.busy.clear();
    this.rasters = null;
    const err = new Error("pool terminated");
    for (const t of this.inFlight) t.reject(err);
    this.inFlight.clear();
    for (const t of this.queue) t.reject(err);
    this.queue.length = 0;
  }
}
