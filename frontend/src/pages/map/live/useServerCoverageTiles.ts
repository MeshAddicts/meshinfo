/**
 * Drapes the server-baked coverage tiles (/tiles/coverage) as a MapLibre raster
 * source and refreshes on the `coverage` SSE event. No client-side compute.
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
const TILE_URLS = [`${API_BASE}/tiles/coverage/{z}/{x}/{y}.png`];

export function useServerCoverageTiles(
  params: UseServerCoverageTilesParams,
): UseServerCoverageTilesResult {
  const { mbMapRef, enabled, mapReady, opacity } = params;
  const [status, setStatus] = useState<ServerCoverageStatus>("off");
  const [meta, setMeta] = useState<CoverageMeta | null>(null);
  const metaRef = useRef<CoverageMeta | null>(null);
  /** What was actually applied to the map — may lag metaRef when the style was
   *  mid-switch, so a dropped application is retried instead of deduped away.
   *  (isStyleLoaded() is no gate: it's false during ordinary tile loading.) */
  const appliedRef = useRef<CoverageMeta | null>(null);
  const enabledRef = useRef(enabled);
  const opacityRef = useRef(opacity);
  enabledRef.current = enabled;
  opacityRef.current = opacity;

  /** Add or refresh the raster source/layer for the current metadata. */
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
        // setTiles only reloads tile data; zoom-range or bounds changes are
        // baked into the source, so those need a fresh one (a grown bbox would
        // otherwise keep culling requests to the old bounds forever).
        const sourceChanged =
          !applied ||
          applied.minZoom !== m.minZoom ||
          applied.maxZoom !== m.maxZoom ||
          applied.bounds.some((v, i) => v !== m.bounds[i]);
        if (existing && existing.type === "raster" && !sourceChanged) {
          // Same bake already applied (e.g. reconnect resync) → nothing to do.
          if (applied && applied.version !== m.version) existing.setTiles(TILE_URLS);
        } else {
          if (map.getLayer(LIVE_COVERAGE_LAYER_ID)) map.removeLayer(LIVE_COVERAGE_LAYER_ID);
          if (map.getSource(LIVE_COVERAGE_SOURCE_ID)) map.removeSource(LIVE_COVERAGE_SOURCE_ID);
          map.addSource(LIVE_COVERAGE_SOURCE_ID, {
            type: "raster",
            tiles: TILE_URLS,
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
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch(`${API_BASE}/v1/coverage/metadata`);
      if (!res.ok) {
        setStatus("unavailable");
        return;
      }
      apply((await res.json()) as CoverageMeta);
    } catch {
      setStatus("unavailable");
    }
  }, [apply]);

  useEffect(() => {
    if (!mapReady) return;
    void fetchMeta();
  }, [mapReady, fetchMeta]);

  // A new bake refreshes the tiles in place.
  useLiveEvent<CoverageMeta>("coverage", (m) => {
    if (m && typeof m.version === "string") apply(m);
  });

  // SSE (re)connect: any bake announced while the connection was down was
  // missed, so resync metadata — apply() no-ops when the version is unchanged.
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
