import type { Map as MlMap, MapGeoJSONFeature, MapSourceDataEvent } from "maplibre-gl";
import { useLayoutEffect, useState } from "react";

import { MAP_ROUTER_COLORS } from "../../../palette";
import { SPIDERFY_LAYER_NODES } from "../layers/spiderfy";

/** Which encodings are on screen right now; drives the contextual legend.
 *  `null` until the first query resolves (legend shows every row until then). */
export interface LegendContext {
  onlineNode: boolean;
  onlineRouter: boolean;
  offlineNode: boolean;
  cluster: boolean;
  /** Any non-traceroute link with a known SNR (colour ramp applies). */
  linkSnr: boolean;
  linkSnrUnknown: boolean;
  /** kind=neighbor — solid straight line. */
  linkHeard: boolean;
  /** kind=heard_by — dashed line. */
  linkHeardBy: boolean;
  /** kind=both — curved arc. */
  linkMutual: boolean;
  /** kind=traceroute — dotted amber. */
  linkTrace: boolean;
}

export const EMPTY_LEGEND_CONTEXT: LegendContext = {
  onlineNode: false,
  onlineRouter: false,
  offlineNode: false,
  cluster: false,
  linkSnr: false,
  linkSnrUnknown: false,
  linkHeard: false,
  linkHeardBy: false,
  linkMutual: false,
  linkTrace: false,
};

/** True when nothing the legend describes is on screen. */
export function legendContextIsEmpty(ctx: LegendContext): boolean {
  return !Object.values(ctx).some(Boolean);
}

const NODE_LAYERS = ["unclustered-nodes", "plain-nodes", SPIDERFY_LAYER_NODES];
const CLUSTER_LAYERS = ["clusters"];
const LINK_LAYERS = ["links-solid", "links-dashed", "links-dotted"];
const ALL_LAYERS = [...NODE_LAYERS, ...CLUSTER_LAYERS, ...LINK_LAYERS];

/** Trailing debounce for `idle` bursts (hover feature-state churn re-idles the map). */
const QUERY_DEBOUNCE_MS = 200;

/** Reduce the viewport's rendered features to legend flags. Exported for tests. */
export function legendContextFromFeatures(features: Pick<MapGeoJSONFeature, "layer" | "properties">[]): LegendContext {
  const ctx = { ...EMPTY_LEGEND_CONTEXT };
  for (const f of features) {
    const layerId = f.layer?.id;
    const p = f.properties ?? {};
    if (CLUSTER_LAYERS.includes(layerId)) {
      ctx.cluster = true;
    } else if (NODE_LAYERS.includes(layerId)) {
      if (!p.online) ctx.offlineNode = true;
      else if (typeof p.role === "number" && MAP_ROUTER_COLORS[p.role]) ctx.onlineRouter = true;
      else ctx.onlineNode = true;
    } else if (LINK_LAYERS.includes(layerId)) {
      switch (p.kind) {
        case "traceroute": ctx.linkTrace = true; break;
        case "heard_by": ctx.linkHeardBy = true; break;
        case "both": ctx.linkMutual = true; break;
        default: ctx.linkHeard = true;
      }
      if (p.kind !== "traceroute") {
        if (p.snr == null) ctx.linkSnrUnknown = true;
        else ctx.linkSnr = true;
      }
    }
  }
  return ctx;
}

function sameContext(a: LegendContext | null, b: LegendContext): boolean {
  if (!a) return false;
  for (const k of Object.keys(b) as (keyof LegendContext)[]) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Query the map (on `idle`, debounced) for what is actually rendered in the
 * viewport, so the legend can show only the rows that apply. Only runs while
 * `enabled` (legend open); `null` when disabled or before the first result.
 */
export function useLegendContext(
  mapRef: { current: MlMap | null },
  opts: { enabled: boolean; mapLoaded: boolean; styleEpoch: number },
): LegendContext | null {
  const { enabled, mapLoaded, styleEpoch } = opts;
  const [ctx, setCtx] = useState<LegendContext | null>(null);

  // Layout effect: the immediate query lands before the legend's first paint,
  // so an already-idle map never flashes the full legend.
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!enabled || !map) {
      setCtx(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 'idle' also follows hover-only repaints (feature-state / paint swaps);
    // only re-query after a move or a source reload — visibility and filter
    // changes reload their source, so they arrive as loaded sourcedata too.
    let pending = true;
    const arm = () => { pending = true; };
    const armOnLoaded = (e: MapSourceDataEvent) => { if (e.isSourceLoaded) pending = true; };

    const run = () => {
      timer = null;
      pending = false;
      const layers = ALL_LAYERS.filter((id) => map.getLayer(id));
      // No layers yet (style swap in progress) — keep what we have; the idle
      // after the layers come back re-runs.
      if (layers.length === 0) return;
      let features: MapGeoJSONFeature[] = [];
      try {
        features = map.queryRenderedFeatures({ layers });
      } catch {
        return;
      }
      const next = legendContextFromFeatures(features);
      setCtx((prev) => (sameContext(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!pending) return;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(run, QUERY_DEBOUNCE_MS);
    };

    map.on("moveend", arm);
    map.on("sourcedata", armOnLoaded);
    map.on("idle", schedule);
    // Already idle → no idle event is coming; query now.
    if (map.loaded()) run();

    return () => {
      map.off("moveend", arm);
      map.off("sourcedata", armOnLoaded);
      map.off("idle", schedule);
      if (timer != null) clearTimeout(timer);
    };
    // mapLoaded: map instance appears after mount; styleEpoch: layers re-added
  }, [mapRef, enabled, mapLoaded, styleEpoch]);

  return ctx;
}
