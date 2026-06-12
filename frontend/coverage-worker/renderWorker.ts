/** worker_threads entry with two modes: ITM-render a node subset, or composite tiles. */
import { parentPort, workerData } from "node:worker_threads";

import { loadItmContext } from "../src/pages/map/itm";
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
  key: string; // "tx/ty"
  buf: ArrayBuffer; // Float32 margin, 256²
}

async function run(): Promise<void> {
  const input = workerData as RenderInput | CompositeInput;
  if (input.mode === "render") {
    const itm = await loadItmContext(128);
    const out: RenderedNode[] = [];
    for (const o of input.origins) {
      const g = renderNodeMargin(o, input.src, itm);
      if (g) out.push({ id: o.id, width: g.width, height: g.height, bounds: g.bounds, buf: g.data.buffer as ArrayBuffer });
    }
    parentPort!.postMessage(out, out.map((r) => r.buf));
  } else {
    const out: CompositedTile[] = [];
    for (const { tx, ty } of input.tiles) {
      const margin = compositeTileMargin(tx, ty, input.z, input.nodes);
      if (margin) out.push({ key: `${tx}/${ty}`, buf: margin.buffer as ArrayBuffer });
    }
    parentPort!.postMessage(out, out.map((t) => t.buf));
  }
}

run().catch((err) => {
  parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
});
