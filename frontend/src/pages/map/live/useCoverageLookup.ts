/** Hover (desktop) / long-press (touch) lookup: which nodes cover this point.
 *  Debounced fetch of /v1/coverage/lookup against the worker's margin cache. */
import type { Map as MlMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";
import { type RefObject, useEffect, useRef, useState } from "react";

import { env } from "../../../env";

export interface CoverageLookupEntry {
  id: string;
  marginDb: number;
}

export interface CoverageLookupHover {
  /** Screen position within the map container. */
  x: number;
  y: number;
  entries: CoverageLookupEntry[];
  total: number;
  /** Long-press results stay until dismissed; hover results follow the cursor. */
  pinned: boolean;
}

export interface UseCoverageLookupParams {
  mbMapRef: RefObject<MlMap | null>;
  enabled: boolean;
  mapReady: boolean;
  /** Pause while an RF tool is mid-flow so the tooltip doesn't fight tool UI. */
  suspended: boolean;
  /** Pyramid to query: "all" or a modem-preset id — must match the drawn layer. */
  group: string;
}

const API_BASE = env.API_BASE_URL ?? "";
const HOVER_DEBOUNCE_MS = 140;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

export function useCoverageLookup({ mbMapRef, enabled, mapReady, suspended, group }: UseCoverageLookupParams): CoverageLookupHover | null {
  const [hover, setHover] = useState<CoverageLookupHover | null>(null);
  const activeRef = useRef(enabled && !suspended);
  const groupRef = useRef(group);
  groupRef.current = group;
  useEffect(() => {
    activeRef.current = enabled && !suspended;
    if (!activeRef.current) setHover(null);
  }, [enabled, suspended]);

  useEffect(() => {
    const m = mbMapRef.current;
    if (!m || !mapReady || !enabled) return;

    let debounce: number | null = null;
    let pressTimer: number | null = null;
    let pressStart: { x: number; y: number } | null = null;
    let abort: AbortController | null = null;

    const clearTimers = () => {
      if (debounce != null) window.clearTimeout(debounce);
      if (pressTimer != null) window.clearTimeout(pressTimer);
      debounce = pressTimer = null;
    };

    const lookup = async (lng: number, lat: number, x: number, y: number, pinned: boolean) => {
      abort?.abort();
      abort = new AbortController();
      try {
        const res = await fetch(
          `${API_BASE}/v1/coverage/lookup?lng=${lng.toFixed(5)}&lat=${lat.toFixed(5)}&group=${encodeURIComponent(groupRef.current)}`,
          { signal: abort.signal },
        );
        if (!res.ok) return setHover(null);
        const data = (await res.json()) as { total: number; entries: CoverageLookupEntry[] };
        if (!activeRef.current || !data.entries?.length) return setHover(null);
        setHover({ x, y, entries: data.entries, total: data.total, pinned });
      } catch {
        // aborted or unreachable: leave state as-is
      }
    };

    const onMouseMove = (e: MapMouseEvent) => {
      if (!activeRef.current || m.isMoving()) return;
      setHover((h) => (h?.pinned ? h : null));
      if (debounce != null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        if (activeRef.current && !m.isMoving()) {
          // wrap(): over a repeated world copy lng exceeds ±180 and the worker 400s
          const { lng, lat } = e.lngLat.wrap();
          void lookup(lng, lat, e.point.x, e.point.y, false);
        }
      }, HOVER_DEBOUNCE_MS);
    };
    const onMouseOut = () => {
      clearTimers();
      setHover((h) => (h?.pinned ? h : null));
    };

    const onTouchStart = (e: MapTouchEvent) => {
      setHover(null);
      if (!activeRef.current || e.points.length !== 1) return;
      pressStart = { x: e.points[0].x, y: e.points[0].y };
      const { lng, lat } = e.lngLat.wrap();
      const { x, y } = e.point;
      if (pressTimer != null) window.clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => void lookup(lng, lat, x, y, true), LONG_PRESS_MS);
    };
    const onTouchMove = (e: MapTouchEvent) => {
      if (!pressStart || pressTimer == null) return;
      const dx = e.points[0].x - pressStart.x;
      const dy = e.points[0].y - pressStart.y;
      if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) {
        window.clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    const onTouchEnd = () => {
      if (pressTimer != null) window.clearTimeout(pressTimer);
      pressTimer = null;
    };
    const onMoveStart = () => {
      clearTimers();
      setHover(null);
    };

    m.on("mousemove", onMouseMove);
    m.on("mouseout", onMouseOut);
    m.on("touchstart", onTouchStart);
    m.on("touchmove", onTouchMove);
    m.on("touchend", onTouchEnd);
    m.on("movestart", onMoveStart);
    return () => {
      clearTimers();
      abort?.abort();
      m.off("mousemove", onMouseMove);
      m.off("mouseout", onMouseOut);
      m.off("touchstart", onTouchStart);
      m.off("touchmove", onTouchMove);
      m.off("touchend", onTouchEnd);
      m.off("movestart", onMoveStart);
      setHover(null);
    };
  }, [mbMapRef, mapReady, enabled]);

  return hover;
}
