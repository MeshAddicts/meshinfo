/** Live traceroute plumbing: ONE debounce buffer merges multi-gateway copies
 *  to the longest route, and ambient-vs-catcher is decided at FLUSH time on the
 *  merged copy — deciding at ingest split one traceroute across two buffers
 *  (double or zero comets when gateway copies disagreed or the tool state
 *  changed mid-debounce). Also keeps the tool's data fresh: refetch on tool
 *  entry + leading/trailing throttled refetch on live events. */
import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { toast } from "../../../components/toastStore";
import { useAppDispatch } from "../../../hooks/redux";
import { useLiveEvent } from "../../../hooks/useLiveEvent";
import { apiSlice } from "../../../slices/apiSlice";
import { normalizeNodeId8 } from "../../../utils/normalizeNodeId8";
import { prefersReducedMotion } from "../../../utils/reducedMotion";
import type { ActivityLayer } from "../layers/activityLayer";
import type { ClusterDonutLayer } from "../layers/clusterDonutLayer";
import { samePoint } from "../lib/geo";
import { normNodeId } from "../lib/linkFeatures";
import { packetColor } from "../lib/packetColors";
import type { IMapNode } from "../lib/types";

export type TraceEv = { from?: number | string; to?: number | string; route_ids?: (number | string)[]; id?: number | string };
// Wait this long for other gateways' copies of one traceroute before drawing the best.
const TRACEROUTE_DEBOUNCE_MS = 1200;

type MapTool = "los" | "traceroute" | "coverage" | "scan" | null;

export type TraceLiveEventsParams = {
  activeTool: MapTool;
  activeToolRef: { current: MapTool };
  toolStepRef: { current: "pickFrom" | "pickTo" | "result" };
  toolFromIdRef: { current: string | null };
  toolToIdRef: { current: string | null };
  livePacketsRef: { current: boolean };
  flyoverFlyingRef: { current: boolean };
  clusterEnabledRef: { current: boolean };
  nodesRef: { current: Record<string, IMapNode> };
  mbMapRef: { current: MlMap | null };
  clusterDonutLayerRef: { current: ClusterDonutLayer | null };
  activityLayerRef: { current: ActivityLayer | null };
};

export function useTraceLiveEvents({
  activeTool, activeToolRef, toolStepRef, toolFromIdRef, toolToIdRef,
  livePacketsRef, flyoverFlyingRef, clusterEnabledRef,
  nodesRef, mbMapRef, clusterDonutLayerRef, activityLayerRef,
}: TraceLiveEventsParams) {
  const dispatch = useAppDispatch();

  // Per-mesh-id debounce of multi-gateway traceroute copies → one comet, longest route.
  const tracerouteBufRef = useRef<Map<string, { ev: TraceEv; timer: ReturnType<typeof setTimeout> }> | null>(null);
  // Rate-limits the catcher's "new traceroute" toast (request+reply = two packet ids).
  const traceCatchToastAtRef = useRef(0);
  const traceRefetchAtRef = useRef(0);
  const traceRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve a traceroute's hops to positions and draw one sequential comet along
  // [from, ...route, to], snapping each hop to its cluster and skipping hops with
  // no known position.
  const animateTraceroute = useCallback((t: TraceEv) => {
    const layer = activityLayerRef.current;
    if (!layer) return;
    const liveNodes = nodesRef.current;
    const map = mbMapRef.current;
    const donut = clusterDonutLayerRef.current;
    const clusters = clusterEnabledRef.current && map && donut ? donut.visibleClusters() : null;
    const snap = (pos: [number, number]): [number, number] => {
      if (!clusters || !map) return pos;
      const p = map.project(pos);
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const c of clusters) {
        const cp = map.project([c.lng, c.lat]);
        const d = Math.hypot(cp.x - p.x, cp.y - p.y);
        if (d <= c.r && d < bestD) {
          bestD = d;
          best = [c.lng, c.lat];
        }
      }
      return best ?? pos;
    };
    const pts: [number, number][] = [];
    for (const raw of [t.from, ...(t.route_ids ?? []), t.to]) {
      const id = normalizeNodeId8(raw);
      const pos = id ? liveNodes[id]?.map_position : undefined;
      if (!pos) continue; // hop with unknown position — skip (honest gap)
      const a = snap(pos);
      const last = pts[pts.length - 1];
      if (!last || !samePoint(last, a)) pts.push(a); // collapse same-cluster hops
    }
    if (pts.length === 0) return;
    layer.spawnPath(pts, packetColor("traceroute"), 0.9, performance.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // True when a live traceroute involves BOTH picked endpoints of the open tool.
  const tracePairMatches = (t: TraceEv): boolean => {
    if (activeToolRef.current !== "traceroute" || toolStepRef.current !== "result") return false;
    const a = normNodeId(toolFromIdRef.current ?? "");
    const b = normNodeId(toolToIdRef.current ?? "");
    if (!a || !b) return false;
    const path = [t.from, ...(t.route_ids ?? []), t.to].map((x) => normNodeId(x ?? ""));
    return path.includes(a) && path.includes(b);
  };

  // Keep traceroute data fresh while the tool is open: the Map page never
  // polls, so refetch on tool entry and throttle-refetch on live events.
  // Tag invalidation refreshes every active traceroutes query (global + pair).
  const invalidateTraceroutes = useCallback(() => {
    traceRefetchAtRef.current = Date.now();
    dispatch(apiSlice.util.invalidateTags([{ type: "Traceroutes", id: "LIST" }]));
  }, [dispatch]);
  useEffect(() => {
    if (activeTool === "traceroute") invalidateTraceroutes();
  }, [activeTool, invalidateTraceroutes]);
  useLiveEvent<TraceEv>("traceroute", () => {
    if (activeToolRef.current !== "traceroute") return;
    // Leading + trailing throttle: an event inside the window schedules one
    // deferred refetch instead of being dropped (the page never polls, so a
    // dropped event would leave the just-run traceroute invisible).
    const remaining = 10_000 - (Date.now() - traceRefetchAtRef.current);
    if (remaining > 0) {
      traceRefetchTimerRef.current ??= setTimeout(() => {
        traceRefetchTimerRef.current = null;
        if (activeToolRef.current === "traceroute") invalidateTraceroutes();
      }, remaining);
      return;
    }
    invalidateTraceroutes();
  });

  useLiveEvent<TraceEv>("traceroute", (t) => {
    const interesting =
      tracePairMatches(t) ||
      (livePacketsRef.current && !prefersReducedMotion() && !flyoverFlyingRef.current);
    if (!interesting) return;
    const buf = (tracerouteBufRef.current ??= new globalThis.Map());
    const key = t.id != null ? `id:${t.id}` : `ft:${t.from}:${t.to}`;
    const existing = buf.get(key);
    if (existing) {
      if ((t.route_ids?.length ?? 0) > (existing.ev.route_ids?.length ?? 0)) existing.ev = t;
      return;
    }
    const timer = setTimeout(() => {
      const entry = buf.get(key);
      buf.delete(key);
      if (!entry) return;
      if (tracePairMatches(entry.ev)) {
        // Catch It Live: the open pair's traceroute lands the moment it's
        // heard. The refetch trails the debounce so the DB write has landed;
        // one shared timer coalesces request+reply bursts.
        traceRefetchTimerRef.current ??= setTimeout(() => {
          traceRefetchTimerRef.current = null;
          if (activeToolRef.current === "traceroute") invalidateTraceroutes();
        }, 2_000);
        if (Date.now() - traceCatchToastAtRef.current > 8_000) {
          traceCatchToastAtRef.current = Date.now();
          toast("New traceroute observed for this pair.");
        }
        if (!prefersReducedMotion() && !flyoverFlyingRef.current) animateTraceroute(entry.ev);
      } else if (livePacketsRef.current && !prefersReducedMotion() && !flyoverFlyingRef.current) {
        animateTraceroute(entry.ev);
      }
    }, TRACEROUTE_DEBOUNCE_MS);
    buf.set(key, { ev: t, timer });
  });

  useEffect(
    () => () => {
      if (traceRefetchTimerRef.current) clearTimeout(traceRefetchTimerRef.current);
      const buf = tracerouteBufRef.current;
      if (buf) {
        for (const { timer } of buf.values()) clearTimeout(timer);
        buf.clear();
      }
    },
    [],
  );

  /** Drops any pending trailing refetch (resetTool must not refetch a closed tool). */
  const clearTraceRefetchTimer = useCallback(() => {
    if (traceRefetchTimerRef.current) {
      clearTimeout(traceRefetchTimerRef.current);
      traceRefetchTimerRef.current = null;
    }
  }, []);

  return { clearTraceRefetchTimer };
}
