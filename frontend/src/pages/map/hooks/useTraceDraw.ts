/** Draws the traceroute tool's observed paths: selected path per-leg (dashed
 *  over ghost gaps, '?' chip markers), alternates recency-faded with
 *  usage-weighted widths, endpoint markers, one-shot fitBounds per pair, and
 *  the lit-up picking rings. Owns the marker/fit refs so resetTool can clear them. */
import * as maplibregl from "maplibre-gl";
import { GeoJSONSource as MlGeoJSONSource, Map as MlMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

import { normalizeLng, unwrapLngTo } from "../lib/geo";
import { recencyOpacityFromAgeMs } from "../lib/linkFeatures";
import { type AnalyzedPath, tsToMs } from "../lib/pathAnalysis";
import type { IMapNode } from "../lib/types";

export type TraceDrawParams = {
  mbMapRef: { current: MlMap | null };
  nodesRef: { current: Record<string, IMapNode> };
  activeTool: "los" | "traceroute" | "coverage" | "scan" | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolToId: string | null;
  tracePaths: AnalyzedPath[];
  traceSelectedPath: AnalyzedPath | null;
  traceCandidates: string[];
  pairTraceroutesLoading: boolean;
  styleEpoch: number;
};

export function useTraceDraw({
  mbMapRef, nodesRef,
  activeTool, toolStep, toolFromId, toolToId,
  tracePaths, traceSelectedPath, traceCandidates,
  pairTraceroutesLoading, styleEpoch,
}: TraceDrawParams) {
  const traceFromMarkerRef = useRef<maplibregl.Marker | null>(null);
  const traceToMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** One-shot fit per pair (`from-to`), gated on the pair history landing. */
  const traceFitKeyRef = useRef<string | null>(null);
  /** '?' markers for position-less hops of the analyzed path. */
  const traceGhostMarkersRef = useRef<maplibregl.Marker[]>([]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const clearTraceMarkers = () => {
      traceFromMarkerRef.current?.remove();
      traceFromMarkerRef.current = null;
      traceToMarkerRef.current?.remove();
      traceToMarkerRef.current = null;
    };
    const clearGhostMarkers = () => {
      for (const m of traceGhostMarkersRef.current) m.remove();
      traceGhostMarkersRef.current = [];
    };

    const src = mb.getSource("path-analysis") as MlGeoJSONSource | undefined;
    if (activeTool !== "traceroute" || toolStep !== "result" || !toolFromId || !toolToId) {
      src?.setData({ type: "FeatureCollection", features: [] });
      clearTraceMarkers();
      clearGhostMarkers();
      traceFitKeyRef.current = null;
      return;
    }
    if (!src) return;

    // nodesRef, not the nodes memo: SSE flushes rebuild `nodes` every 400 ms,
    // which would churn setData/markers here for no visual change.
    const posOf = (id: string): [number, number] | null => {
      const n = nodesRef.current[id] ?? nodesRef.current[`!${id}`];
      return n?.map_position ? [n.map_position[0], n.map_position[1]] : null;
    };

    const primary = traceSelectedPath;
    const now = Date.now();
    const features: GeoJSON.Feature[] = [];
    clearGhostMarkers();

    // Ghost marker: shortname chip over a dashed '?' ring, so you can tell
    // WHICH node's placement is estimated, not just that one is.
    const addGhostMarker = (hopId: string, lngLat: [number, number], offset: [number, number]) => {
      const ghostNode = nodesRef.current[hopId] ?? nodesRef.current[`!${hopId}`];
      const label =
        ghostNode?.shortname?.trim() ||
        (hopId.startsWith("?") ? hopId.slice(1, 11) : hopId.slice(0, 8));
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.title = `${label} — position unknown, placement estimated`;
      el.style.cssText =
        "display:flex;flex-direction:column;align-items:center;gap:2px;pointer-events:auto;";
      const chip = document.createElement("div");
      chip.textContent = label;
      // max-width + ellipsis: stacked edge-ghost chips sit on a fixed pitch,
      // and an unclamped long label would paint over its neighbors.
      chip.style.cssText =
        "padding:1px 6px;border-radius:9999px;background:rgba(17,24,39,0.88);" +
        "border:1px dashed rgba(156,163,175,0.6);color:#d1d5db;font-size:10px;" +
        "font-weight:600;white-space:nowrap;max-width:52px;overflow:hidden;" +
        "text-overflow:ellipsis;";
      const ring = document.createElement("div");
      ring.textContent = "?";
      ring.style.cssText =
        "width:18px;height:18px;border-radius:50%;border:2px dashed #9ca3af;" +
        "background:rgba(17,24,39,0.85);color:#d1d5db;font-size:11px;" +
        "line-height:14px;text-align:center;font-weight:600;";
      el.append(chip, ring);
      traceGhostMarkersRef.current.push(
        new maplibregl.Marker({ element: el, offset }).setLngLat(lngLat).addTo(mb),
      );
    };

    // Selected path: one feature per drawn segment so legs spanning ghost hops
    // render dashed, with '?' markers spread across each gap run.
    if (primary) {
      const positions = primary.hops.map(posOf);
      const positioned = positions
        .map((pos, i) => ({ pos, i }))
        .filter((x): x is { pos: [number, number]; i: number } => x.pos != null);
      let prevLng: number | null = null;
      for (let k = 0; k + 1 < positioned.length; k++) {
        const A = positioned[k];
        const B = positioned[k + 1];
        const aLng = prevLng == null ? A.pos[0] : unwrapLngTo(prevLng, A.pos[0]);
        const bLng = unwrapLngTo(aLng, B.pos[0]);
        prevLng = bLng;
        const isGap = B.i - A.i > 1;
        // Request-only path: the unobserved leg (index from pathAnalysis —
        // last leg when displayed forward, leg 0 when the a→b pick reversed
        // travel order) draws dashed and faded, not solid. This segment spans
        // hop-legs A.i..B.i-1.
        const provisionalLeg =
          primary.provisionalLegIndex != null &&
          A.i <= primary.provisionalLegIndex &&
          primary.provisionalLegIndex < B.i;
        features.push({
          type: "Feature",
          properties: {
            primary: true,
            gap: isGap || provisionalLeg,
            sort: 1000,
            opacity: provisionalLeg ? 0.5 : 0.95,
            width: provisionalLeg ? 3 : 4,
          },
          geometry: { type: "LineString", coordinates: [[aLng, A.pos[1]], [bLng, B.pos[1]]] },
        });
        if (isGap) {
          // Ghost markers evenly spread along the estimated connector.
          for (let g = A.i + 1; g < B.i; g++) {
            const t = (g - A.i) / (B.i - A.i);
            const lng = normalizeLng(aLng + (bLng - aLng) * t);
            const lat = A.pos[1] + (B.pos[1] - A.pos[1]) * t;
            // Offset keeps the '?' ring (not the stack's center) on the point
            addGhostMarker(primary.hops[g], [lng, lat], [0, -10]);
          }
        }
      }

      // Leading/trailing ghosts: hops before the first (or after the last)
      // positioned hop have no gap run to interpolate into, and used to be
      // completely invisible — stack their chips beside the nearest
      // positioned hop instead so the path's true extent is visible.
      if (positioned.length > 0) {
        // Far-to-near add order: markers added later paint on top, and the
        // hop nearest the positioned anchor should win an overlap.
        const first = positioned[0];
        for (let g = 0; g < first.i; g++) {
          addGhostMarker(primary.hops[g], first.pos, [-(first.i - g) * 60, -10]);
        }
        const last = positioned[positioned.length - 1];
        for (let g = primary.hops.length - 1; g > last.i; g--) {
          addGhostMarker(primary.hops[g], last.pos, [(g - last.i) * 60, -10]);
        }
      }
    }

    // Alternates: whole-path lines, recency-faded, braid-style usage-weighted
    // widths so the strand the mesh actually favors reads thicker.
    const primarySig = primary ? primary.hops.join(">") : null;
    const totalCount = tracePaths.reduce((s, p) => s + p.count, 0) || 1;
    tracePaths
      .filter((p) => p.hops.join(">") !== primarySig)
      .slice(0, 5)
      .forEach((p, rank) => {
        // Split the strand at unpositioned hops: silently splicing the nodes
        // on either side of a gap into one segment draws an RF link that was
        // never observed — the same fabrication the primary path avoids with
        // its dashed gap segments.
        const runs: [number, number][][] = [];
        let cur: [number, number][] = [];
        for (const hop of p.hops) {
          const pos = posOf(hop);
          if (!pos) {
            if (cur.length >= 2) runs.push(cur);
            cur = [];
            continue;
          }
          const prev = cur[cur.length - 1];
          // Chain-unwrap so seam-crossing legs draw the short way
          cur.push(prev ? [unwrapLngTo(prev[0], pos[0]), pos[1]] : pos);
        }
        if (cur.length >= 2) runs.push(cur);
        for (const coords of runs) {
          features.push({
            type: "Feature",
            properties: {
              primary: false,
              gap: false,
              sort: -rank,
              opacity: Math.min(0.55, 0.55 * recencyOpacityFromAgeMs(now - tsToMs(p.timestamp))),
              // Capped below the primary's 4 so a dominant alternate can't outweigh it
              width: Math.min(3.4, 1.4 + 3.2 * Math.min(1, p.count / totalCount)),
            },
            geometry: { type: "LineString", coordinates: coords },
          });
        }
      });
    src.setData({ type: "FeatureCollection", features });

    // Endpoint markers placed INDEPENDENTLY: one unpositioned endpoint used
    // to bail out of both, hiding the endpoint we do know about.
    const fromPos = posOf(toolFromId);
    const toPos = posOf(toolToId);
    if (fromPos) {
      if (traceFromMarkerRef.current) traceFromMarkerRef.current.setLngLat(fromPos);
      else traceFromMarkerRef.current = new maplibregl.Marker({ color: "#06b6d4", scale: 0.75 }).setLngLat(fromPos).addTo(mb);
    } else {
      traceFromMarkerRef.current?.remove();
      traceFromMarkerRef.current = null;
    }
    if (toPos) {
      if (traceToMarkerRef.current) traceToMarkerRef.current.setLngLat(toPos);
      else traceToMarkerRef.current = new maplibregl.Marker({ color: "#d946ef", scale: 0.75 }).setLngLat(toPos).addTo(mb);
    } else {
      traceToMarkerRef.current?.remove();
      traceToMarkerRef.current = null;
    }

    // Fit once per pair, not on every data refresh — but not before the
    // pair-scoped history lands, or the fit would exclude the actual routes.
    const fitKey = `${toolFromId}-${toolToId}`;
    if (!pairTraceroutesLoading && traceFitKeyRef.current !== fitKey) {
      const bounds = new maplibregl.LngLatBounds();
      if (fromPos) bounds.extend(fromPos);
      // Unwrap so an antimeridian-crossing pair frames the short way
      if (toPos) bounds.extend(fromPos ? [unwrapLngTo(fromPos[0], toPos[0]), toPos[1]] : toPos);
      for (const f of features) {
        for (const c of (f.geometry as GeoJSON.LineString).coordinates) bounds.extend(c as [number, number]);
      }
      if (!bounds.isEmpty()) {
        // Consume the one-shot key only on a real fit: an empty first pass
        // (positions still loading on a cold deep link) must keep retrying.
        traceFitKeyRef.current = fitKey;
        mb.fitBounds(bounds, { padding: 120, duration: 600, maxZoom: 12 });
      }
    }
    // styleEpoch: setStyle recreates the path-analysis source empty — redraw after style.load
  }, [activeTool, toolStep, toolFromId, toolToId, tracePaths, traceSelectedPath, pairTraceroutesLoading, styleEpoch, mbMapRef, nodesRef]);

  // Lit-up picking: ring every node with an observed route through the origin
  useEffect(() => {
    const mb = mbMapRef.current;
    const src = mb?.getSource("trace-candidates") as MlGeoJSONSource | undefined;
    if (!src) return;
    if (traceCandidates.length === 0) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const features: GeoJSON.Feature[] = [];
    for (const id of traceCandidates) {
      const p = (nodesRef.current[id] ?? nodesRef.current[`!${id}`])?.map_position;
      if (p) features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p[0], p[1]] } });
    }
    src.setData({ type: "FeatureCollection", features });
    // styleEpoch: setStyle recreates the source empty — repaint after style.load
  }, [traceCandidates, styleEpoch, mbMapRef, nodesRef]);

  return { traceFromMarkerRef, traceToMarkerRef, traceFitKeyRef, traceGhostMarkersRef };
}
