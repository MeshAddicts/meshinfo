/** Coverage-worker configuration (env-overridable). */
import { NodeRole } from "../src/types";

export const MESHINFO_URL = process.env.MESHINFO_URL ?? "http://localhost:9000";
export const OUTPUT_DIR = process.env.COVERAGE_OUTPUT_DIR ?? "output/coverage";

/** Output zoom range. MAX_ZOOM bounds compute (paint detail, not terrain accuracy). */
export const MAX_ZOOM = Number(process.env.COVERAGE_MAX_ZOOM ?? 9);
export const MIN_ZOOM = Number(process.env.COVERAGE_MIN_ZOOM ?? 5);

/** Shared-DEM / per-node-sub-DEM dimensions (terrain accuracy; capped for memory). */
export const SHARED_DEM_SIZE = Number(process.env.COVERAGE_DEM_SIZE ?? 4096);
export const NODE_DEM_SIZE = Number(process.env.COVERAGE_NODE_DEM_SIZE ?? 1024);
/** Per-node render grid. Modest, since coverage upsamples smoothly — decouples ITM
 *  cost from MAX_ZOOM (the dominant perf lever) while the sub-DEM keeps terrain fine. */
export const NODE_OUTPUT_MAX = Number(process.env.COVERAGE_NODE_OUTPUT ?? 384);

/** Per-role footprint reach (km). Routers full range; clients capped (~80 km max over terrain). */
export const ROUTER_REACH_KM = Number(process.env.COVERAGE_ROUTER_REACH_KM ?? 200);
export const CLIENT_REACH_KM = Number(process.env.COVERAGE_CLIENT_REACH_KM ?? 80);

/** A node contributes if heard within this many hours. */
export const RECENCY_HOURS = Number(process.env.COVERAGE_RECENCY_HOURS ?? 4);

/** Optional "west,south,east,north" clip, for aggregator DBs that span many regions. */
export const BBOX: [number, number, number, number] | null = (() => {
  const raw = process.env.COVERAGE_BBOX;
  if (!raw) return null;
  const p = raw.split(",").map(Number);
  return p.length === 4 && p.every(Number.isFinite) ? (p as [number, number, number, number]) : null;
})();

const ROUTER_CLASS = new Set<NodeRole>([NodeRole.ROUTER, NodeRole.ROUTER_LATE, NodeRole.REPEATER]);
export function reachKmForRole(role: NodeRole | undefined): number {
  return role != null && ROUTER_CLASS.has(role) ? ROUTER_REACH_KM : CLIENT_REACH_KM;
}

/** Live-loop cadence. */
export const POLL_INTERVAL_MS = Number(process.env.COVERAGE_POLL_MS ?? 60_000);
export const MIN_RECOMPUTE_MS = Number(process.env.COVERAGE_MIN_RECOMPUTE_MS ?? 10 * 60_000);
export const BACKSTOP_MS = Number(process.env.COVERAGE_BACKSTOP_MS ?? 4 * 60 * 60_000);
