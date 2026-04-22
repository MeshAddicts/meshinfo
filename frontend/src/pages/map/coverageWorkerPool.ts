/**
 * Promise-based worker pool for coverage slice workers. Sized to
 * navigator.hardwareConcurrency, capped at MAX_POOL_SIZE. FCFS dispatch;
 * workers keep ITM WASM warm across tasks.
 */
import type {
  CoverageSliceRequest,
  CoverageSliceResponse,
} from "./coverageSliceWorker";

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
  /** Tracked so terminate() can reject them (worker death = no response). */
  private readonly inFlight: Set<PendingTask> = new Set();

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

  /** Dispatch to first free worker; queues if all busy. */
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
    this.inFlight.add(task);
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
      this.inFlight.delete(task);
      const next = this.queue.shift();
      if (next) this.run(worker, next);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage(task.req, task.transfer);
  }

  /** Terminate all workers; reject queued + in-flight tasks (promises would otherwise hang). */
  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.busy.clear();
    const err = new Error("pool terminated");
    for (const t of this.inFlight) t.reject(err);
    this.inFlight.clear();
    for (const t of this.queue) t.reject(err);
    this.queue.length = 0;
  }
}
