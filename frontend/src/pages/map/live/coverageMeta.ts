/**
 * Metadata for one bake of the live network-coverage tile pyramid. Written by
 * the coverage-worker as `metadata.json`, served at /v1/coverage/metadata, and
 * broadcast verbatim on the `coverage` SSE event — one shape for all three.
 */
export interface CoverageMeta {
  version: string;
  generatedAt: string;
  /** [west, south, east, north], clamped to [-180, 180] for map display. */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  nodeCount: number;
  tileCount: number;
  recencyHours: number;
  /** RF model inputs used, e.g. ["itm", "nlcd", "eth-canopy", "jrc-buildings"]. */
  sources: string[];
}
