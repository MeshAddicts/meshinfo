/** worker_threads entry: persistent job loop with two modes — ITM-render one
 *  node, or composite tiles. Workers live across bakes (pooled by render.ts),
 *  so the tsx bootstrap and ITM WASM load are paid once per worker. */
import { parentPort } from "node:worker_threads";

import { type ItmContext, loadItmContext } from "../src/pages/map/rf/itm";
import type { DEMBounds } from "../src/pages/map/terrain/terrainDEM";
import type { MarginGridQ8 } from "./cache";
import { renderNodeMargin, type RenderSources, streamCompositeQ8 } from "./nodeRender";
import type { CoverageOrigin } from "./nodes";

export interface RenderInput {
  mode: "render";
  origin: CoverageOrigin;
  /** DEM is SharedArrayBuffer-backed (shared); the clutter/canopy/building
   *  slices are per-node, their buffers TRANSFERRED (zero-copy, freed when
   *  the job ends). */
  src: RenderSources;
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
  /** Affected tile keys "tx/ty" (unwrapped frame) this worker owns. */
  keys: string[];
  /** Grids to stream from the margin cache, pre-filtered to this chunk's rows.
   *  The worker reads each from disk itself, one at a time — no shared grid
   *  buffers between jobs. */
  nodes: Array<{ id: string; bounds: DEMBounds }>;
  cacheDir: string;
}

export interface CompositeResult {
  /** Non-empty q8 canvas tiles (buffers transferred). */
  tiles: Array<{ key: string; buf: ArrayBuffer }>;
  /** Cache entries that failed to read; main drops them and fails the bake. */
  unreadable: string[];
}

export interface WorkerJob {
  jobId: number;
  input: RenderInput | CompositeInput;
}

export type WorkerReply =
  | { jobId: number; ok: RenderedNode | null | CompositeResult }
  | { jobId: number; err: string };

let itmPromise: Promise<ItmContext> | null = null;

async function run(
  input: RenderInput | CompositeInput,
): Promise<{ out: RenderedNode | null | CompositeResult; transfers: ArrayBuffer[] }> {
  if (input.mode === "render") {
    itmPromise ??= loadItmContext(128);
    let itm: ItmContext;
    try {
      itm = await itmPromise;
    } catch (err) {
      itmPromise = null; // pool workers live across bakes — don't memoize a transient load failure
      throw err;
    }
    const g = renderNodeMargin(input.origin, input.src, itm);
    if (!g) return { out: null, transfers: [] };
    const out: RenderedNode = { id: input.origin.id, width: g.width, height: g.height, bounds: g.bounds, buf: g.data.buffer as ArrayBuffer };
    return { out, transfers: [out.buf] };
  }
  const { canvas, unreadable } = await streamCompositeQ8(input.nodes, input.keys, input.z, input.cacheDir);
  const tiles = [...canvas].map(([key, tile]) => ({ key, buf: tile.buffer as ArrayBuffer }));
  return { out: { tiles, unreadable }, transfers: tiles.map((t) => t.buf) };
}

parentPort!.on("message", ({ jobId, input }: WorkerJob) => {
  run(input)
    .then(({ out, transfers }) => parentPort!.postMessage({ jobId, ok: out } satisfies WorkerReply, transfers))
    .catch((err: unknown) =>
      parentPort!.postMessage({ jobId, err: err instanceof Error ? err.message : String(err) } satisfies WorkerReply),
    );
});
