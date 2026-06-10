/** worker_threads entry: composite a node subset into a private margin buffer. */
import { parentPort, workerData } from "node:worker_threads";

import { loadItmContext } from "../src/pages/map/itm";
import { type AccDims, type Accumulator, compositeNode, type RenderSources } from "./nodeRender";
import type { CoverageOrigin } from "./nodes";

interface WorkerInput {
  src: RenderSources; // typed arrays are SharedArrayBuffer-backed (shared, not copied)
  z: number;
  dims: AccDims;
  origins: CoverageOrigin[];
}

async function run(): Promise<void> {
  const { src, z, dims, origins } = workerData as WorkerInput;
  const itm = await loadItmContext(128);
  const margin = new Float32Array(dims.accW * dims.accH);
  margin.fill(Number.NaN);
  const acc: Accumulator = { margin, accX0: dims.accX0, accY0: dims.accY0, accW: dims.accW, accH: dims.accH };
  for (const o of origins) compositeNode(o, src, itm, z, acc);
  parentPort!.postMessage(margin.buffer, [margin.buffer]); // transfer ownership back
}

run().catch((err) => {
  parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
});
