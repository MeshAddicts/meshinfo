import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";

import type { IMapNode } from "./types";

/** Owns ?node= deep-link fly-to + debounced URL sync for center/zoom. */
export function useUrlMapSync(
  nodes: Record<string, IMapNode>,
  mbMapRef: React.RefObject<MlMap | null>,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  // Ref'd so writes don't depend on setSearchParams' rotating identity.
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  const urlNodeId = searchParams.get("node") ?? "";
  const urlNodeIdRef = useRef(urlNodeId);
  urlNodeIdRef.current = urlNodeId;

  const flyToTarget = useMemo(() => {
    if (!urlNodeId) return null;
    const node = nodes[urlNodeId] ?? nodes[`!${urlNodeId}`];
    if (!node?.map_position) return null;
    return node.map_position as [number, number]; // [lon, lat]
  }, [urlNodeId, nodes]);
  const flyToTargetRef = useRef(flyToTarget);
  flyToTargetRef.current = flyToTarget;

  const flyToHandledRef = useRef<string>("");

  // Retry until map is ready
  useEffect(() => {
    if (!urlNodeId || !flyToTarget) return;
    if (flyToHandledRef.current === urlNodeId) return;

    const [lon, lat] = flyToTarget;

    const tryFlyTo = () => {
      if (flyToHandledRef.current === urlNodeId) return true;

      const mbMap = mbMapRef.current;
      if (mbMap) {
        flyToHandledRef.current = urlNodeId;
        mbMap.easeTo({ center: [lon, lat], zoom: 14, duration: 1200 });
        setSearchParams((prev) => { prev.delete("node"); return prev; }, { replace: true });
        return true;
      }

      return false;
    };

    if (tryFlyTo()) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [200, 500, 1000, 2000, 3500]) {
      timers.push(setTimeout(() => {
        if (urlNodeIdRef.current !== urlNodeId) return;
        tryFlyTo();
      }, delay));
    }

    return () => timers.forEach(clearTimeout);
  }, [urlNodeId, flyToTarget, setSearchParams, mbMapRef]);

  // Debounced ?lat/lng/z writer. Called from Map.tsx's moveend (always the live
  // map) — a listener bound here would go stale when the map is recreated.
  const viewSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushViewToUrl = useCallback(() => {
    if (viewSyncTimerRef.current) clearTimeout(viewSyncTimerRef.current);
    viewSyncTimerRef.current = setTimeout(() => {
      const mb = mbMapRef.current;
      if (!mb) return;
      const c = mb.getCenter();
      const sp = new URLSearchParams(searchParamsRef.current);
      sp.set("lat", String(+c.lat.toFixed(5)));
      sp.set("lng", String(+c.lng.toFixed(5)));
      sp.set("z", String(+mb.getZoom().toFixed(2)));
      setSearchParamsRef.current(sp, { replace: true });
    }, 600);
  }, [mbMapRef]);
  const pushViewToUrlRef = useRef(pushViewToUrl);
  pushViewToUrlRef.current = pushViewToUrl;

  return { searchParams, flyToTargetRef, pushViewToUrlRef };
}
