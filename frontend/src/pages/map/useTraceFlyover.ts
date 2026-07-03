/**
 * "Ride the Packet": a camera chase along the analyzed traceroute path.
 *
 * For each leg, one comet is spawned (slowed below ambient speed — this is a
 * guided tour, not background traffic) and the camera eases to the landing
 * hop over the same duration, pitched and facing the direction of travel.
 * Each landing gets a dwell beat, an arrival pulse, and a persistent
 * shortname chip, so the route annotates itself behind the packet and the
 * final framed shot shows every stop. Any user camera input, Esc, tool
 * close, or path change cancels the tour. Real data only — the comet is the
 * same primitive live traceroutes draw, just choreographed.
 */
import maplibregl, { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "../../utils/reducedMotion";
import type { ActivityLayer } from "./activityLayer";
import { shortestLngDelta, unwrapLngTo } from "./geo";
import { packetColor } from "./packetColors";
import type { AnalyzedPath } from "./pathAnalysis";
import type { IMapNode } from "./types";

const CHASE_PITCH = 60;
const OUTRO_PITCH = 55;
const INTRO_MS = 1600;
/** Dwell at each hop — long enough to read its chip, short enough to keep pace. */
const HOP_PAUSE_MS = 900;
const OUTRO_MS = 1400;
/** Tour comet pacing: slower than ambient traffic, with its own clamps. */
const TOUR_SPEED_SCALE = 0.55;
const TOUR_MIN_LEG_MS = 1100;
const TOUR_MAX_LEG_MS = 4500;
/** Breadcrumb chips outlive the tour briefly so the framed finale stays labeled. */
const LABEL_LINGER_MS = 3500;

/** Initial great-circle bearing a → b (degrees), seam-aware. */
function bearingTo(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLng = shortestLngDelta(a[0], b[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

type FlyoverParams = {
  mbMapRef: React.RefObject<MlMap | null>;
  activityLayerRef: React.RefObject<ActivityLayer | null>;
  nodesRef: React.RefObject<Record<string, IMapNode>>;
};

export function useTraceFlyover({ mbMapRef, activityLayerRef, nodesRef }: FlyoverParams) {
  const [isFlying, setIsFlying] = useState(false);
  /** Ref twin of isFlying for bind-once handlers (Esc, ambient-spawn gate). */
  const flyingRef = useRef(false);
  /** Generation token — bumping it makes the in-flight run loop bail. */
  const genRef = useRef(0);
  /** Breadcrumb shortname chips dropped at each visited hop. */
  const labelMarkersRef = useRef<maplibregl.Marker[]>([]);
  const labelLingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLabels = useCallback(() => {
    if (labelLingerTimerRef.current) {
      clearTimeout(labelLingerTimerRef.current);
      labelLingerTimerRef.current = null;
    }
    for (const m of labelMarkersRef.current) m.remove();
    labelMarkersRef.current = [];
  }, []);

  /** Stops a running tour or dismisses lingering breadcrumbs; returns whether
   *  it had anything to cancel (the Esc chain consumes the keypress on true —
   *  the labeled finale visually extends the tour, so Esc must too). */
  const cancelFlyover = useCallback((): boolean => {
    if (!flyingRef.current) {
      const hadLabels = labelMarkersRef.current.length > 0 || labelLingerTimerRef.current !== null;
      clearLabels();
      return hadLabels;
    }
    genRef.current++;
    flyingRef.current = false;
    setIsFlying(false);
    clearLabels();
    mbMapRef.current?.stop();
    return true;
  }, [mbMapRef, clearLabels]);

  // The user grabbing the camera takes the wheel back. originalEvent is only
  // present on user-initiated camera events, so the tour's own easeTo calls
  // can't self-cancel; this one gate covers drag, wheel, dblclick, pinch, and
  // right-drag rotate/pitch in a single pair of listeners.
  useEffect(() => {
    if (!isFlying) return;
    const mb = mbMapRef.current;
    if (!mb) return;
    const onUserCamera = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) cancelFlyover();
    };
    mb.on("movestart", onUserCamera);
    mb.on("zoomstart", onUserCamera);
    return () => {
      mb.off("movestart", onUserCamera);
      mb.off("zoomstart", onUserCamera);
    };
  }, [isFlying, mbMapRef, cancelFlyover]);

  // Never leave the flying flag stuck (or chips behind) if the page navigates
  // away mid-tour.
  useEffect(() => () => {
    genRef.current++;
    flyingRef.current = false;
    clearLabels();
  }, [clearLabels]);

  /** Starts the tour along the path's positioned hops; false if it can't fly. */
  const startFlyover = useCallback((path: AnalyzedPath): boolean => {
    const mb = mbMapRef.current;
    const layer = activityLayerRef.current;
    if (!mb || !layer || prefersReducedMotion()) return false;

    // Positioned hops (with labels) in one continuous unwrapped longitude frame
    const liveNodes = nodesRef.current ?? {};
    const stops: { pos: [number, number]; label: string }[] = [];
    for (const id of path.hops) {
      const n = liveNodes[id] ?? liveNodes[`!${id}`];
      const p = n?.map_position;
      if (!p) continue;
      const prev = stops[stops.length - 1];
      stops.push({
        pos: prev ? [unwrapLngTo(prev.pos[0], p[0]), p[1]] : [p[0], p[1]],
        label: n?.shortname?.trim() || id.slice(0, 8),
      });
    }
    if (stops.length < 2) return false;

    cancelFlyover(); // restart cleanly if a tour is already running
    const gen = ++genRef.current;
    flyingRef.current = true;
    setIsFlying(true);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const live = () => genRef.current === gen && mbMapRef.current === mb;
    const color = packetColor("traceroute");

    /** Persistent glass chip above a visited hop, popped in on arrival. */
    const dropLabel = (stop: { pos: [number, number]; label: string }) => {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.textContent = stop.label;
      el.style.cssText =
        "padding:2px 7px;border-radius:9999px;background:rgba(17,24,39,0.92);" +
        "border:1px solid rgba(34,211,238,0.45);color:#a5f3fc;font-size:11px;" +
        "font-weight:600;white-space:nowrap;pointer-events:none;" +
        "box-shadow:0 2px 8px rgba(0,0,0,0.5);opacity:0;transform:scale(0.7);" +
        "transition:opacity 240ms ease-out, transform 240ms ease-out;";
      const marker = new maplibregl.Marker({ element: el, offset: [0, -18] })
        .setLngLat(stop.pos)
        .addTo(mb);
      labelMarkersRef.current.push(marker);
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "scale(1)";
      });
    };

    const run = async () => {
      // Intro: drop onto the origin, facing the first leg
      const chaseZoom = Math.min(13.5, Math.max(10.5, mb.getZoom() + 1.5));
      mb.easeTo({
        center: stops[0].pos,
        zoom: chaseZoom,
        pitch: CHASE_PITCH,
        bearing: bearingTo(stops[0].pos, stops[1].pos),
        duration: INTRO_MS,
      });
      await sleep(INTRO_MS + 80);
      if (!live()) return;

      layer.spawnPulse(stops[0].pos, color, performance.now());
      dropLabel(stops[0]);
      await sleep(HOP_PAUSE_MS * 0.6); // shorter beat at the origin
      if (!live()) return;

      for (let i = 0; i + 1 < stops.length; i++) {
        const A = stops[i];
        const B = stops[i + 1];
        const dur = layer.spawnLeg(A.pos, B.pos, color, 0.9, performance.now(), {
          speedScale: TOUR_SPEED_SCALE,
          minMs: TOUR_MIN_LEG_MS,
          maxMs: TOUR_MAX_LEG_MS,
          landingRing: false, // the arrival pulse below owns the landing beat
        });
        if (dur <= 0) break;
        // Linear ease so the camera tracks the comet's constant speed
        mb.easeTo({
          center: B.pos,
          bearing: bearingTo(A.pos, B.pos),
          pitch: CHASE_PITCH,
          zoom: chaseZoom,
          duration: dur,
          easing: (t) => t,
        });
        await sleep(dur);
        if (!live()) return;
        // The stop: arrival pulse + its chip, then a beat to take it in
        layer.spawnPulse(B.pos, color, performance.now());
        dropLabel(B);
        await sleep(HOP_PAUSE_MS);
        if (!live()) return;
      }

      // Outro: frame the whole route, still pitched, chips as breadcrumbs
      const bounds = new maplibregl.LngLatBounds();
      for (const s of stops) bounds.extend(s.pos);
      const cam = mb.cameraForBounds(bounds, { padding: 120, maxZoom: 12 });
      if (cam) mb.easeTo({ ...cam, pitch: OUTRO_PITCH, duration: OUTRO_MS });
      await sleep(OUTRO_MS);
      if (!live()) return;
      flyingRef.current = false;
      setIsFlying(false);
      // Let the labeled finale breathe, then tidy up
      labelLingerTimerRef.current = setTimeout(() => {
        labelLingerTimerRef.current = null;
        if (genRef.current === gen) clearLabels();
      }, LABEL_LINGER_MS);
    };
    void run();
    return true;
  }, [mbMapRef, activityLayerRef, nodesRef, cancelFlyover, clearLabels]);

  return { isFlying, flyingRef, startFlyover, cancelFlyover };
}
