/**
 * Promise-based worker pool for the coverage prediction slice workers.
 *
 * The pool owns N persistent Web Workers (one per logical CPU, capped
 * at a sensible max) and serves tasks on a first-come-first-served
 * basis. Each worker keeps its ITM WASM module warm across tasks, so
 * dispatch latency after the first compute is just message-passing +
 * actual compute.
 *
 * Usage:
 *   const pool = new CoverageWorkerPool(); // auto-sized
 *   const result = await pool.dispatch(request, [request.demBuffer]);
 *   // ...
 *   pool.terminate();
 */
import type {
  CoverageSliceRequest,
  CoverageSliceResponse,
} from "./coverageSliceWorker";

/** Cap the pool size — more than this doesn't pay off and eats RAM. */
const MAX_POOL_SIZE = 8;

interface PendingTask {
  req: CoverageSliceRequest;
  transfer: Transferable[];
  resolve: (r: CoverageSliceResponse) => void;
  reject: (err: unknown) => void;
}

export class CoverageWorkerPool {
  private readonly workers: Worker[];
  private readonly busy: Set<Worker> = new Set();
  private readonly queue: PendingTask[] = [];

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

  /**
   * Dispatch a task to the first available worker. Returns a promise
   * that resolves with the slice response. If every worker is busy the
   * task queues and runs as soon as one frees up.
   */
  dispatch(
    req: CoverageSliceRequest,
    transfer: Transferable[],
  ): Promise<CoverageSliceResponse> {
    return new Promise((resolve, reject) => {
      const task: PendingTask = { req, transfer, resolve, reject };
      const free = this.workers.find((w) => !this.busy.has(w));
      if (free) {
        this.run(free, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  private run(worker: Worker, task: PendingTask): void {
    this.busy.add(worker);
    const onMessage = (evt: MessageEvent<CoverageSliceResponse>) => {
      if (evt.data.requestId !== task.req.requestId) return;
      cleanup();
      task.resolve(evt.data);
    };
    const onError = (err: ErrorEvent) => {
      cleanup();
      task.reject(err.error ?? new Error(err.message));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      this.busy.delete(worker);
      const next = this.queue.shift();
      if (next) this.run(worker, next);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(task.req, task.transfer);
  }

  /**
   * Terminate all workers and fail any queued tasks. Call when the
   * coverage tool is no longer needed (e.g. on page unmount).
   */
  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.busy.clear();
    for (const t of this.queue) t.reject(new Error("pool terminated"));
    this.queue.length = 0;
  }
}
