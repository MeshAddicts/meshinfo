/** worker_threads entry: persistent job loop with two modes — ITM-render a node
 *  subset, or composite tiles. Workers live across bakes (pooled by render.ts),
 *  so the tsx bootstrap and ITM WASM load are paid once per worker. */
import { parentPort } from "node:worker_threads";

import { type ItmContext, loadItmContext } from "../src/pages/map/rf/itm";
import type { MarginGridQ8 } from "./cache";
import { compositeTileMargin, renderNodeMargin, type RenderSources } from "./nodeRender";
import type { CoverageOrigin } from "./nodes";

export interface RenderInput {
  mode: "render";
  src: RenderSources; // typed arrays are SharedArrayBuffer-backed (shared, not copied)
  origins: CoverageOrigin[];
}

export interface RenderedNode {
  id: string;
  width: number;
  height: number;
  bounds: MarginGridQ8["bounds"];
  buf: ArrayBuffer; // quantized uint8 margin
}

export interface CompositeInput {
  mode: "composite";
  z: number;
  tiles: Array<{ tx: number; ty: number }>;
  nodes: MarginGridQ8[]; // data is SharedArrayBuffer-backed
}

export interface CompositedTile {
  key: string; // "tx/ty" (unwrapped frame; render.ts wraps for file keys)
  buf: ArrayBuffer; // Float32 margin, 256²
}

export interface WorkerJob {
  jobId: number;
  input: RenderInput | CompositeInput;
}

export type WorkerReply =
  | { jobId: number; ok: RenderedNode[] | CompositedTile[] }
  | { jobId: number; err: string };

let itmPromise: Promise<ItmContext> | null = null;

async function run(
  input: RenderInput | CompositeInput,
): Promise<{ out: RenderedNode[] | CompositedTile[]; transfers: ArrayBuffer[] }> {
  if (input.mode === "render") {
    itmPromise ??= loadItmContext(128);
    let itm: ItmContext;
    try {
      itm = await itmPromise;
    } catch (err) {
      itmPromise = null; // pool workers live across bakes — don't memoize a transient load failure
      throw err;
    }
    const out: RenderedNode[] = [];
    for (const o of input.origins) {
      const g = renderNodeMargin(o, input.src, itm);
      if (g) out.push({ id: o.id, width: g.width, height: g.height, bounds: g.bounds, buf: g.data.buffer as ArrayBuffer });
    }
    return { out, transfers: out.map((r) => r.buf) };
  }
  const out: CompositedTile[] = [];
  for (const { tx, ty } of input.tiles) {
    const margin = compositeTileMargin(tx, ty, input.z, input.nodes);
    if (margin) out.push({ key: `${tx}/${ty}`, buf: margin.buffer as ArrayBuffer });
  }
  return { out, transfers: out.map((t) => t.buf) };
}

parentPort!.on("message", ({ jobId, input }: WorkerJob) => {
  run(input)
    .then(({ out, transfers }) => parentPort!.postMessage({ jobId, ok: out } satisfies WorkerReply, transfers))
    .catch((err: unknown) =>
      parentPort!.postMessage({ jobId, err: err instanceof Error ? err.message : String(err) } satisfies WorkerReply),
    );
});
