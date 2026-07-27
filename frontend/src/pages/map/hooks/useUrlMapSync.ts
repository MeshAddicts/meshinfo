import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";

import type { IMapNode } from "../lib/types";

/** Owns ?node= deep-link fly-to + debounced URL sync for center/zoom. */
export function useUrlMapSync(
  nodes: Record<string, IMapNode>,
  mbMapRef: React.RefObject<MlMap | null>,
) {
  // Router subscription kept ONLY for the ?node= deep link, which must react
  // to in-app navigations (the node panel's "show on map" link). Everything
  // else reads window.location fresh and writes via history.replaceState so
  // the constant pan/zoom sync never re-renders the whole Map route.
  const [searchParams, setSearchParams] = useSearchParams();
  // Ref'd so writes don't depend on setSearchParams' rotating identity.
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

  // Stable mount-time snapshot for Map.tsx's init-only ?lat/lng/z reads — a
  // live params object would re-run init-keyed consumers on every navigation.
  const initialSearchParamsRef = useRef<URLSearchParams | null>(null);
  if (initialSearchParamsRef.current === null) {
    initialSearchParamsRef.current = new URLSearchParams(window.location.search);
  }
  const initialSearchParams = initialSearchParamsRef.current;

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
        // Build from window.location, not the router's params: lat/lng/z and
        // tool params are written via replaceState behind the router's back,
        // so its stale copy would resurrect old values here.
        const sp = new URLSearchParams(window.location.search);
        sp.delete("node");
        setSearchParamsRef.current(sp, { replace: true });
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
  }, [urlNodeId, flyToTarget, mbMapRef]);

  // Debounced ?lat/lng/z writer. Called from Map.tsx's moveend (always the live
  // map) — a listener bound here would go stale when the map is recreated.
  // Writes via history.replaceState, NOT setSearchParams: a router navigation
  // here would re-render the entire Map route per pan/zoom, purely cosmetic.
  const viewSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushViewToUrl = useCallback(() => {
    if (viewSyncTimerRef.current) clearTimeout(viewSyncTimerRef.current);
    viewSyncTimerRef.current = setTimeout(() => {
      const mb = mbMapRef.current;
      if (!mb) return;
      const c = mb.getCenter();
      // Read fresh at write time so tool params and ?node= are preserved.
      const sp = new URLSearchParams(window.location.search);
      sp.set("lat", String(+c.lat.toFixed(5)));
      sp.set("lng", String(+c.lng.toFixed(5)));
      sp.set("z", String(+mb.getZoom().toFixed(2)));
      const next = `${window.location.pathname}?${sp.toString()}${window.location.hash}`;
      // Keep the router's history.state (usr/key/idx) — nulling it would break
      // react-router's back/forward bookkeeping.
      window.history.replaceState(window.history.state, "", next);
    }, 600);
  }, [mbMapRef]);

  // Drop a pending debounced URL write if we unmount mid-debounce.
  useEffect(() => () => {
    if (viewSyncTimerRef.current) clearTimeout(viewSyncTimerRef.current);
  }, []);

  const pushViewToUrlRef = useRef(pushViewToUrl);
  pushViewToUrlRef.current = pushViewToUrl;

  // `searchParams` is a frozen mount-time snapshot — Map.tsx only reads it at
  // map init (?lat/lng/z priority), and a live object is no longer available.
  return { searchParams: initialSearchParams, flyToTargetRef, pushViewToUrlRef };
}
