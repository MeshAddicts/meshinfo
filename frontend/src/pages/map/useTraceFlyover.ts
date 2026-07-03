/**
 * "Ride the Packet": a camera chase along the analyzed traceroute path.
 *
 * For each leg, one comet is spawned (its duration comes from the layer's
 * constant on-screen speed) and the camera eases to the landing hop over the
 * same duration, pitched and facing the direction of travel. Any user camera
 * input, Esc, tool close, or path change cancels the tour; it ends framing
 * the whole route. Real data only — the comet is the same primitive live
 * traceroutes draw, just choreographed.
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
const INTRO_MS = 1300;
const HOP_PAUSE_MS = 250;
const OUTRO_MS = 1400;

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

  /** Stops a running tour; returns whether one was running. */
  const cancelFlyover = useCallback((): boolean => {
    if (!flyingRef.current) return false;
    genRef.current++;
    flyingRef.current = false;
    setIsFlying(false);
    mbMapRef.current?.stop();
    return true;
  }, [mbMapRef]);

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

  // Never leave the flying flag stuck if the page navigates away mid-tour.
  useEffect(() => () => { genRef.current++; flyingRef.current = false; }, []);

  /** Starts the tour along the path's positioned hops; false if it can't fly. */
  const startFlyover = useCallback((path: AnalyzedPath): boolean => {
    const mb = mbMapRef.current;
    const layer = activityLayerRef.current;
    if (!mb || !layer || prefersReducedMotion()) return false;

    // Positioned hops in one continuous unwrapped longitude frame
    const liveNodes = nodesRef.current ?? {};
    const pts: [number, number][] = [];
    for (const id of path.hops) {
      const p = (liveNodes[id] ?? liveNodes[`!${id}`])?.map_position;
      if (!p) continue;
      const prev = pts[pts.length - 1];
      pts.push(prev ? [unwrapLngTo(prev[0], p[0]), p[1]] : [p[0], p[1]]);
    }
    if (pts.length < 2) return false;

    cancelFlyover(); // restart cleanly if a tour is already running
    const gen = ++genRef.current;
    flyingRef.current = true;
    setIsFlying(true);

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const live = () => genRef.current === gen && mbMapRef.current === mb;
    const color = packetColor("traceroute");

    const run = async () => {
      // Intro: drop onto the origin, facing the first leg
      const chaseZoom = Math.min(13.5, Math.max(10.5, mb.getZoom() + 1.5));
      mb.easeTo({
        center: pts[0],
        zoom: chaseZoom,
        pitch: CHASE_PITCH,
        bearing: bearingTo(pts[0], pts[1]),
        duration: INTRO_MS,
      });
      await sleep(INTRO_MS + 80);
      if (!live()) return;

      layer.spawnPulse(pts[0], color, performance.now());
      for (let i = 0; i + 1 < pts.length; i++) {
        const A = pts[i];
        const B = pts[i + 1];
        const dur = layer.spawnLeg(A, B, color, 0.9, performance.now());
        if (dur <= 0) break;
        // Linear ease so the camera tracks the comet's constant speed
        mb.easeTo({
          center: B,
          bearing: bearingTo(A, B),
          pitch: CHASE_PITCH,
          zoom: chaseZoom,
          duration: dur,
          easing: (t) => t,
        });
        await sleep(dur + HOP_PAUSE_MS);
        if (!live()) return;
      }

      // Outro: frame the whole route, still pitched
      const bounds = new maplibregl.LngLatBounds();
      for (const p of pts) bounds.extend(p);
      const cam = mb.cameraForBounds(bounds, { padding: 120, maxZoom: 12 });
      if (cam) mb.easeTo({ ...cam, pitch: OUTRO_PITCH, duration: OUTRO_MS });
      await sleep(OUTRO_MS);
      if (!live()) return;
      flyingRef.current = false;
      setIsFlying(false);
    };
    void run();
    return true;
  }, [mbMapRef, activityLayerRef, nodesRef, cancelFlyover]);

  return { isFlying, flyingRef, startFlyover, cancelFlyover };
}
