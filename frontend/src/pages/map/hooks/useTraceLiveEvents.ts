/** Live traceroute plumbing: ONE debounce buffer merges multi-gateway copies
 *  to the longest route, and ambient-vs-catcher is decided at FLUSH time on the
 *  merged copy — deciding at ingest split one traceroute across two buffers
 *  (double or zero comets when gateway copies disagreed or the tool state
 *  changed mid-debounce). Also keeps the tool's data fresh: refetch on tool
 *  entry; on live events, enriched backends' full-row events are upserted
 *  straight into the cache (rare 300 s backstop refetch), skinny events fall
 *  back to the leading/trailing 30 s throttled refetch. */
import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { toast } from "../../../components/toastStore";
import { useAppDispatch } from "../../../hooks/redux";
import { useLiveEvent } from "../../../hooks/useLiveEvent";
import { apiSlice } from "../../../slices/apiSlice";
import { store } from "../../../store";
import type { ITraceroutesResponse } from "../../../types";
import { normalizeNodeId8 } from "../../../utils/normalizeNodeId8";
import { prefersReducedMotion } from "../../../utils/reducedMotion";
import { orientTraceroute } from "../../../utils/traceroute";
import type { ActivityLayer } from "../layers/activityLayer";
import type { ClusterDonutLayer } from "../layers/clusterDonutLayer";
import { samePoint } from "../lib/geo";
import { normNodeId } from "../lib/linkFeatures";
import { packetColor } from "../lib/packetColors";
import type { IMapNode } from "../lib/types";

/** SSE traceroute event. Older backends publish only the skinny
 *  from/to/route_ids/id; enriched backends publish the full
 *  /v1/traceroutes?slim=1 row — same field names and serialization as REST —
 *  so the cache can be patched without a refetch. */
export type TraceEv = {
  from?: number | string;
  to?: number | string;
  route_ids?: (number | string)[];
  id?: number | string;
  hops_away?: number | null;
  rssi?: number | null;
  snr?: number | null;
  timestamp?: number;
  payload?: { snr_towards?: number[] };
};
/** True when an SSE traceroute event carries a full /v1/traceroutes row
 *  (enriched backend). `timestamp` is the discriminator — skinny events only
 *  carry from/to/route_ids/id — and id+from (the cache merge key) plus to
 *  (closes the path) must be present for the upsert to be well-formed. */
const isFullTraceRow = (t: TraceEv): boolean =>
  Number.isFinite(t?.timestamp) &&
  Array.isArray(t?.route_ids) &&
  t.id != null &&
  t.from != null &&
  t.to != null;
// Wait this long for other gateways' copies of one traceroute before drawing the best.
const TRACEROUTE_DEBOUNCE_MS = 1200;
// Full-row events keep the cache current by themselves; drift can only come
// from MISSED events (the reconnect resync path doesn't cover traceroutes), so
// a rare trailing backstop refetch replaces the 30 s throttle: at most one
// invalidate per 5 min while full rows keep arriving.
const FULL_ROW_BACKSTOP_MS = 300_000;

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
  // When the pending trailing refetch fires (epoch ms) — lets a shorter
  // deadline preempt a longer one (a skinny fallback event must not sit
  // behind a 300 s full-row backstop timer).
  const traceRefetchDueAtRef = useRef(0);

  // Resolve a traceroute's hops to positions and draw one sequential comet in
  // TRAVEL order (orientTraceroute swaps reply-row headers back; skinny events
  // without payload fall back to header order), snapping each hop to its
  // cluster and skipping hops with no known position.
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
    const walk = orientTraceroute(t)?.orderedPath ?? [t.from, ...(t.route_ids ?? []), t.to];
    for (const raw of walk) {
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

  /** Schedule one trailing invalidate `delayMs` out, keeping whichever pending
   *  deadline is SOONER (skinny 30 s trailing vs full-row 300 s backstop can
   *  coexist when a malformed enriched event falls back to the skinny path). */
  const scheduleInvalidate = (delayMs: number) => {
    const dueAt = Date.now() + delayMs;
    if (traceRefetchTimerRef.current != null) {
      if (traceRefetchDueAtRef.current <= dueAt) return;
      clearTimeout(traceRefetchTimerRef.current);
    }
    traceRefetchDueAtRef.current = dueAt;
    traceRefetchTimerRef.current = setTimeout(() => {
      traceRefetchTimerRef.current = null;
      if (activeToolRef.current === "traceroute") invalidateTraceroutes();
    }, delayMs);
  };

  /** Enriched event → upsert the full row into the cached traceroute windows
   *  (global 1000-row + active pair 500-row). Returns true when the row landed
   *  (no refetch needed); false falls back to the skinny throttle path. */
  const upsertFullTraceRow = (t: TraceEv): boolean => {
    if (!isFullTraceRow(t)) return false;
    try {
      // Same field names/serialization as a /v1/traceroutes?slim=1 row.
      const row = t as unknown as ITraceroutesResponse;
      const key = `${row.id}:${row.from}`; // Map.tsx's merge key
      const upsert = (max: number) => (draft: ITraceroutesResponse[]) => {
        // Key collision = another gateway's copy of a row we already hold.
        // Keep the FIRST copy, matching the DB's ON CONFLICT DO NOTHING — a
        // later refetch would return the first-written copy, and replacing it
        // here would let per-gateway rssi/snr diverge from REST.
        if (draft.some((tr) => `${tr.id}:${tr.from}` === key)) return;
        // Cache is newest-first (ORDER BY created_at DESC); a live row is
        // almost always the newest, so this loop exits at index 0.
        let i = 0;
        while (i < draft.length && (draft[i].timestamp ?? 0) > row.timestamp) i++;
        draft.splice(i, 0, row);
        if (draft.length > max) draft.length = max; // hold the REST window size
      };
      const from = toolFromIdRef.current;
      const to = toolToIdRef.current;
      dispatch(apiSlice.util.updateQueryData("getTraceroutes", undefined, upsert(1000)));
      if (from && to && tracePairMatches(t)) {
        // Identical arg to Map.tsx's pair query — else the patch hits nothing.
        dispatch(apiSlice.util.updateQueryData("getTraceroutes", { from, to, limit: 500 }, upsert(500)));
      }
      // A refetch already in flight (tool entry / backstop) will REPLACE the
      // cache when it lands — getTraceroutes has no `merge` — and its server
      // snapshot may predate this row, silently wiping the patch for up to
      // 300 s. Re-sync shortly after it settles instead.
      const state = store.getState();
      const pendingGlobal =
        apiSlice.endpoints.getTraceroutes.select(undefined)(state).status === "pending";
      const pendingPair =
        from && to
          ? apiSlice.endpoints.getTraceroutes.select({ from, to, limit: 500 })(state).status === "pending"
          : false;
      if (pendingGlobal || pendingPair) scheduleInvalidate(2_000);
      return true;
    } catch {
      return false; // malformed enriched event — let the skinny path refetch
    }
  };

  useLiveEvent<TraceEv>("traceroute", (t) => {
    if (activeToolRef.current !== "traceroute") return;
    // Enriched backend: the event IS the row — patch the cache directly and
    // skip the refetch. Only the rare consistency backstop remains (missed
    // events are the sole drift source; see FULL_ROW_BACKSTOP_MS).
    if (upsertFullTraceRow(t)) {
      scheduleInvalidate(
        Math.max(FULL_ROW_BACKSTOP_MS - (Date.now() - traceRefetchAtRef.current), 0),
      );
      return;
    }
    // Skinny event (older backend, or a row the guard rejected): leading +
    // trailing throttle — an event inside the window schedules one deferred
    // refetch instead of being dropped (the page never polls, so a dropped
    // event would leave the just-run traceroute invisible). 30 s: every
    // invalidation refetches BOTH the 1000-row global window and the 500-row
    // pair window (~0.4–1 MB). The open pair's own traceroutes still land
    // fast via the catcher's 2 s path below.
    const remaining = 30_000 - (Date.now() - traceRefetchAtRef.current);
    if (remaining > 0) {
      scheduleInvalidate(remaining);
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
        // heard. A full-row event was already upserted into the pair cache at
        // ingest — no refetch needed, only the toast + comet. Skinny events
        // still need the 2 s refetch trailing the debounce so the DB write has
        // landed. Preempt (don't schedule behind) any ambient trailing timer —
        // that one can be up to 30 s (or 300 s, backstop) out, and the open
        // pair's own result must not wait.
        if (!isFullTraceRow(entry.ev)) {
          if (traceRefetchTimerRef.current != null) clearTimeout(traceRefetchTimerRef.current);
          traceRefetchDueAtRef.current = Date.now() + 2_000;
          traceRefetchTimerRef.current = setTimeout(() => {
            traceRefetchTimerRef.current = null;
            if (activeToolRef.current === "traceroute") invalidateTraceroutes();
          }, 2_000);
        }
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
