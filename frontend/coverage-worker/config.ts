/** Coverage-worker configuration (env-overridable). */
import { cpus } from "node:os";

import { ROUTER_CLASS_ROLES } from "../src/pages/map/live/liveCoverageParams";
import { DEFAULT_LIVE_PRESET, isKnownPreset } from "../src/pages/map/live/liveCoveragePresets";
import type { NodeRole } from "../src/types";

/** Parallel render workers. Tile buckets keep per-worker memory sparse, so the
 *  cap is generous. Set 1 to force single-thread. */
export const WORKERS = (() => {
  const env = process.env.COVERAGE_WORKERS;
  if (env != null) return Math.max(1, Number(env) || 1);
  return Math.max(1, Math.min(32, (cpus()?.length ?? 4) - 1));
})();

export const MESHINFO_URL = process.env.MESHINFO_URL ?? "http://localhost:9000";
export const OUTPUT_DIR = process.env.COVERAGE_OUTPUT_DIR ?? "output/coverage";
/** Per-node rendered-margin cache (survives restarts; lives in the output volume). */
export const CACHE_DIR = process.env.COVERAGE_CACHE_DIR ?? `${OUTPUT_DIR}-cache`;
/** Drop cached margins for nodes inactive this long. */
export const CACHE_PRUNE_DAYS = Number(process.env.COVERAGE_CACHE_PRUNE_DAYS ?? 7);
/** Hover-lookup HTTP port (internal; meshinfo proxies /v1/coverage/lookup to it). */
export const LOOKUP_PORT = Number(process.env.COVERAGE_LOOKUP_PORT ?? 9301);

/** Output zoom range. MAX_ZOOM bounds paint detail (z11 ≈ 60 m/px at lat 38). */
export const MAX_ZOOM = Number(process.env.COVERAGE_MAX_ZOOM ?? 11);
export const MIN_ZOOM = Number(process.env.COVERAGE_MIN_ZOOM ?? 5);

/** Shared-DEM / per-node-sub-DEM dimensions (terrain accuracy; capped for memory). */
export const SHARED_DEM_SIZE = Number(process.env.COVERAGE_DEM_SIZE ?? 8192);
export const NODE_DEM_SIZE = Number(process.env.COVERAGE_NODE_DEM_SIZE ?? 2048);
/** Clutter/canopy/building raster dimension. Separate from the DEM: canopy alone is
 *  3 Float32 planes, so 8192² would cost ~800 MB. */
export const CLUTTER_RASTER_SIZE = Number(process.env.COVERAGE_CLUTTER_SIZE ?? 4096);
/** Per-node render grid: ~OUTPUT_M_PER_PX everywhere, capped at NODE_OUTPUT_MAX.
 *  ITM cost scales with the grid square — these are the dominant perf levers. */
export const NODE_OUTPUT_MAX = Number(process.env.COVERAGE_NODE_OUTPUT ?? 2048);
export const OUTPUT_M_PER_PX = Number(process.env.COVERAGE_OUTPUT_M_PER_PX ?? 200);

/** Per-role footprint reach (km). Routers full range; clients capped (~80 km max over terrain). */
export const ROUTER_REACH_KM = Number(process.env.COVERAGE_ROUTER_REACH_KM ?? 200);
export const CLIENT_REACH_KM = Number(process.env.COVERAGE_CLIENT_REACH_KM ?? 80);

/** A node contributes if heard within this many hours. */
export const RECENCY_HOURS = Number(process.env.COVERAGE_RECENCY_HOURS ?? 4);

/** Modem preset assumed for nodes whose channel hash has no
 *  `[broker.channels.meta.<hash>] preset` mapping in meshinfo's config.
 *  Strictly validated: preset ids double as group directory names, so an
 *  empty/garbage value must never reach the bake (join(OUTPUT_DIR, "") is
 *  the output root itself). */
export const DEFAULT_PRESET = (() => {
  const raw = process.env.COVERAGE_DEFAULT_PRESET;
  if (!raw) return DEFAULT_LIVE_PRESET;
  if (!isKnownPreset(raw)) {
    console.warn(`[coverage-worker] unknown COVERAGE_DEFAULT_PRESET "${raw}" — using ${DEFAULT_LIVE_PRESET}`);
    return DEFAULT_LIVE_PRESET;
  }
  return raw;
})();

/** Accuracy layers (NLCD clutter / ETH canopy / JRC buildings), fetched from
 *  meshinfo's baked tiles. Default on; gracefully no-op where a layer isn't baked. */
const flag = (v: string | undefined) => v !== "false" && v !== "0";
export const USE_CLUTTER = flag(process.env.COVERAGE_CLUTTER);
export const USE_CANOPY = flag(process.env.COVERAGE_CANOPY);
export const USE_BUILDINGS = flag(process.env.COVERAGE_BUILDINGS);
/** ITU clutter-model scaler; 1.0 = calibrated baseline (matches the interactive tool). */
export const CLUTTER_AGGRESSION = Number(process.env.COVERAGE_CLUTTER_AGGRESSION ?? 1.0);

/** Optional "west,south,east,north" clip, for aggregator DBs that span many regions. */
export const BBOX: [number, number, number, number] | null = (() => {
  const raw = process.env.COVERAGE_BBOX;
  if (!raw) return null;
  const p = raw.split(",").map(Number);
  return p.length === 4 && p.every(Number.isFinite) ? (p as [number, number, number, number]) : null;
})();

/** Same role split as txDbmForRole, so reach and TX class can't drift apart. */
export function reachKmForRole(role: NodeRole | undefined): number {
  return role != null && ROUTER_CLASS_ROLES.has(role) ? ROUTER_REACH_KM : CLIENT_REACH_KM;
}

/** Live-loop cadence. Rebakes are incremental (only changed nodes re-render),
 *  so the interval can be short without baking back-to-back. */
export const POLL_INTERVAL_MS = Number(process.env.COVERAGE_POLL_MS ?? 60_000);
export const MIN_RECOMPUTE_MS = Number(process.env.COVERAGE_MIN_RECOMPUTE_MS ?? 10 * 60_000);
export const BACKSTOP_MS = Number(process.env.COVERAGE_BACKSTOP_MS ?? 4 * 60 * 60_000);
