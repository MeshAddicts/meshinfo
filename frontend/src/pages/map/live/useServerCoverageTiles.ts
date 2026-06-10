/**
 * Drapes the server-baked coverage tiles (/tiles/coverage) as a MapLibre raster
 * source and refreshes on the `coverage` SSE event. No client-side compute.
 */
import type { Map as MlMap, RasterTileSource } from "maplibre-gl";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { env } from "../../../env";
import { useLiveEvent } from "../../../hooks/useLiveEvent";
import { LIVE_COVERAGE_LAYER_ID, LIVE_COVERAGE_SOURCE_ID } from "./liveCoverageConstants";

export interface CoverageMeta {
  version: string;
  generatedAt: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  nodeCount: number;
  tileCount: number;
  recencyHours: number;
  sources: string[];
}

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

function tileUrls(version: string): string[] {
  return [`${API_BASE}/tiles/coverage/{z}/{x}/{y}.png?v=${encodeURIComponent(version)}`];
}

export function useServerCoverageTiles(
  params: UseServerCoverageTilesParams,
): UseServerCoverageTilesResult {
  const { mbMapRef, enabled, mapReady, opacity } = params;
  const [status, setStatus] = useState<ServerCoverageStatus>("off");
  const [meta, setMeta] = useState<CoverageMeta | null>(null);
  const metaRef = useRef<CoverageMeta | null>(null);
  const enabledRef = useRef(enabled);
  const opacityRef = useRef(opacity);
  enabledRef.current = enabled;
  opacityRef.current = opacity;

  /** Add or refresh the raster source/layer for the current metadata. */
  const apply = useCallback(
    (m: CoverageMeta) => {
      const map = mbMapRef.current;
      if (!map) return;
      const prev = metaRef.current;
      metaRef.current = m;
      const tiles = tileUrls(m.version);
      const existing = map.getSource(LIVE_COVERAGE_SOURCE_ID) as RasterTileSource | undefined;
      // setTiles only swaps URLs; a zoom-range change needs a fresh source.
      const rangeChanged = !prev || prev.minZoom !== m.minZoom || prev.maxZoom !== m.maxZoom;
      if (existing && existing.type === "raster" && !rangeChanged) {
        existing.setTiles(tiles);
      } else {
        if (map.getLayer(LIVE_COVERAGE_LAYER_ID)) map.removeLayer(LIVE_COVERAGE_LAYER_ID);
        if (map.getSource(LIVE_COVERAGE_SOURCE_ID)) map.removeSource(LIVE_COVERAGE_SOURCE_ID);
        map.addSource(LIVE_COVERAGE_SOURCE_ID, {
          type: "raster",
          tiles,
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
      setMeta(m);
      setStatus("ready");
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
