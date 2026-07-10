/**
 * Drapes the server-baked coverage tiles (/tiles/coverage/{group}) as a MapLibre
 * raster source and refreshes on the `coverage` SSE event. No client-side compute.
 */
import type { Map as MlMap, RasterTileSource } from "maplibre-gl";
import { type RefObject, useCallback, useContext, useEffect, useRef, useState } from "react";

import { env } from "../../../env";
import { LiveEventsContext, useLiveEvent } from "../../../hooks/useLiveEvent";
import type { CoverageMeta } from "./coverageMeta";
import { LIVE_COVERAGE_LAYER_ID, LIVE_COVERAGE_SOURCE_ID } from "./liveCoverageConstants";

export type { CoverageMeta };

export type ServerCoverageStatus = "off" | "loading" | "ready" | "unavailable";

export interface UseServerCoverageTilesParams {
  mbMapRef: RefObject<MlMap | null>;
  enabled: boolean;
  mapReady: boolean;
  opacity: number;
  /** Pyramid to drape: "all" or a modem-preset id (e.g. "LongFast"). */
  group: string;
}

export interface UseServerCoverageTilesResult {
  status: ServerCoverageStatus;
  meta: CoverageMeta | null;
}

const API_BASE = env.API_BASE_URL ?? "";
/** Insert below the interactive tool's raster (and nodes/links/activity). */
const BEFORE_ID = "coverage-raster";

/** Stable URLs (no cache-buster): the server sends Cache-Control: no-cache, so
 *  clients revalidate per use and unchanged tiles are free 304s (the bake keeps
 *  their ETags stable). A new bake refreshes via setTiles(same URLs), which
 *  expires MapLibre's in-memory tiles and refetches only what changed. */
function tileUrls(group: string): string[] {
  return [`${API_BASE}/tiles/coverage/${encodeURIComponent(group)}/{z}/{x}/{y}.png`];
}

export function useServerCoverageTiles(
  params: UseServerCoverageTilesParams,
): UseServerCoverageTilesResult {
  const { mbMapRef, enabled, mapReady, opacity, group } = params;
  const [status, setStatus] = useState<ServerCoverageStatus>("off");
  const [meta, setMeta] = useState<CoverageMeta | null>(null);
  const metaRef = useRef<CoverageMeta | null>(null);
  /** What was actually applied to the map — may lag metaRef when the style was
   *  mid-switch, so a dropped application is retried instead of deduped away.
   *  (isStyleLoaded() is no gate: it's false during ordinary tile loading.) */
  const appliedRef = useRef<CoverageMeta | null>(null);
  const enabledRef = useRef(enabled);
  const opacityRef = useRef(opacity);
  const groupRef = useRef(group);
  enabledRef.current = enabled;
  opacityRef.current = opacity;
  groupRef.current = group;

  /** Add or refresh the raster source/layer for the given metadata. */
  const apply = useCallback(
    (m: CoverageMeta) => {
      const map = mbMapRef.current;
      if (!map) return;
      metaRef.current = m;
      setMeta(m);
      setStatus("ready");
      const applied = appliedRef.current;
      try {
        const existing = map.getSource(LIVE_COVERAGE_SOURCE_ID) as RasterTileSource | undefined;
        // setTiles only reloads tile data; group, zoom-range, or bounds changes
        // are baked into the source, so those need a fresh one (a grown bbox
        // would otherwise keep culling requests to the old bounds forever).
        const sourceChanged =
          !applied ||
          applied.group !== m.group ||
          applied.minZoom !== m.minZoom ||
          applied.maxZoom !== m.maxZoom ||
          applied.bounds.some((v, i) => v !== m.bounds[i]);
        if (existing && existing.type === "raster" && !sourceChanged) {
          // Same bake already applied (e.g. reconnect resync) → nothing to do.
          if (applied && applied.version !== m.version) existing.setTiles(tileUrls(m.group));
        } else {
          if (map.getLayer(LIVE_COVERAGE_LAYER_ID)) map.removeLayer(LIVE_COVERAGE_LAYER_ID);
          if (map.getSource(LIVE_COVERAGE_SOURCE_ID)) map.removeSource(LIVE_COVERAGE_SOURCE_ID);
          map.addSource(LIVE_COVERAGE_SOURCE_ID, {
            type: "raster",
            tiles: tileUrls(m.group),
            tileSize: 256,
            minzoom: m.minZoom,
            maxzoom: m.maxZoom,
            bounds: m.bounds,
          });
          map.addLayer(
            {
              id: LIVE_COVERAGE_LAYER_ID,
              type: "raster",
              source: LIVE_COVERAGE_SOURCE_ID,
              layout: { visibility: enabledRef.current ? "visible" : "none" },
              paint: { "raster-opacity": opacityRef.current, "raster-fade-duration": 300 },
            },
            map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined,
          );
        }
        appliedRef.current = m; // only after the map accepted it
      } catch {
        // Style mid-switch (addSource throws) — appliedRef stays stale, so the
        // style.load handler / next event retries instead of no-opping.
      }
    },
    [mbMapRef],
  );

  const fetchMeta = useCallback(async () => {
    const wanted = groupRef.current;
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch(`${API_BASE}/v1/coverage/metadata?group=${encodeURIComponent(wanted)}`);
      if (!res.ok) {
        if (res.status === 404 && wanted !== "all") {
          // The selected pyramid vanished (its preset mesh went quiet). Fetch
          // the "all" metadata for a fresh groups list so the group picker can
          // fall back — without this, a persisted dead group is a dead end.
          try {
            const all = await fetch(`${API_BASE}/v1/coverage/metadata?group=all`);
            if (all.ok && wanted === groupRef.current) {
              const am = (await all.json()) as CoverageMeta;
              metaRef.current = { ...am, group: am.group ?? "all", groups: am.groups ?? ["all"] };
              setMeta(metaRef.current);
            }
          } catch {
            // fall through — unavailable either way
          }
          setStatus("unavailable");
          return;
        }
        // Transient server trouble: tiles already painted are still valid.
        setStatus((s) => (res.status === 404 || !appliedRef.current ? "unavailable" : s));
        return;
      }
      const m = (await res.json()) as CoverageMeta;
      // Drop stale responses from a quick group toggle (each toggle refetches).
      if ((m.group ?? "all") !== groupRef.current) return;
      apply({ ...m, group: m.group ?? "all", groups: m.groups ?? ["all"] });
    } catch {
      setStatus((s) => (appliedRef.current ? s : "unavailable"));
    }
  }, [apply]);

  useEffect(() => {
    if (!mapReady) return;
    void fetchMeta();
  }, [mapReady, group, fetchMeta]);

  // A new bake announces itself with the "all" metadata. Viewers of "all" can
  // apply the payload directly (no extra fetch — most clients sit on "all");
  // preset viewers refetch their own group's metadata.
  useLiveEvent<CoverageMeta>("coverage", (m) => {
    if (!m || typeof m.version !== "string") return;
    if (appliedRef.current?.version === m.version && appliedRef.current?.group === groupRef.current) return;
    if (groupRef.current === "all" && (m.group ?? "all") === "all" && Array.isArray(m.bounds)) {
      apply({ ...m, group: "all", groups: m.groups ?? ["all"] });
      return;
    }
    void fetchMeta();
  });

  // SSE (re)connect: any bake announced while the connection was down was
  // missed, so resync metadata.
  const liveSource = useContext(LiveEventsContext);
  useEffect(() => {
    if (!liveSource || !mapReady) return;
    const onOpen = () => void fetchMeta();
    liveSource.addEventListener("open", onOpen);
    return () => liveSource.removeEventListener("open", onOpen);
  }, [liveSource, mapReady, fetchMeta]);

  // A basemap/style switch wipes the source; re-add it.
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map || !mapReady) return;
    const onStyle = () => {
      if (metaRef.current) apply(metaRef.current);
    };
    map.on("style.load", onStyle);
    return () => {
      map.off("style.load", onStyle);
    };
  }, [mapReady, mbMapRef, apply]);

  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    try {
      if (map.getLayer(LIVE_COVERAGE_LAYER_ID)) {
        map.setLayoutProperty(LIVE_COVERAGE_LAYER_ID, "visibility", enabled ? "visible" : "none");
      }
    } catch { /* layer not ready */ }
  }, [enabled, status, mbMapRef]);

  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    try {
      if (map.getLayer(LIVE_COVERAGE_LAYER_ID)) {
        map.setPaintProperty(LIVE_COVERAGE_LAYER_ID, "raster-opacity", opacity);
      }
    } catch { /* layer not ready */ }
  }, [opacity, status, mbMapRef]);

  return { status, meta };
}
