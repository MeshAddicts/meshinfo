import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";

import { env } from "../../../env";
import { ORIGIN_COLOR } from "../../../palette";
import { normalizeLng } from "../lib/geo";
import type { IMapNode } from "../lib/types";
import { effectiveAltitudeMslM } from "../rf/altitudeAssessment";
import { AGGRESSION_STOPS, type CoverageReliability, reliabilityPreset } from "../rf/coverageAnalysis";
import { type ItmContext, loadItmContext } from "../rf/itm";
import { DEFAULT_ITM_ENV } from "../rf/itmEnv";
import { MAX_SCAN_PATH_POINTS, runScanAsync, type ScanClass, type ScanSummary, type ScanTarget, scanToGeoJSON } from "../rf/scanAnalysis";
import type { BuildingRaster } from "../terrain/buildingTiles";
import type { CanopyRaster } from "../terrain/canopyTiles";
import type { ClutterRaster } from "../terrain/landcoverTiles";
import { buildCoverageRasters } from "../terrain/rasterBuildClient";
import { type DEM, demBoundsAround, sampleDEMAt } from "../terrain/terrainDEM";
import type { DemSource } from "../terrain/terrainRgb";

/** Same 200 km radius as coverage; DEM is sized to it. */
const SCAN_RADIUS_KM = 200;
/** DEM/clutter tile budget per fetch (matches LOS/coverage standard). */
const SCAN_MAX_TILES = 256;
/** GPS altitude farther than this above sampled terrain is treated as bogus. */
const MAX_ORIGIN_HEIGHT_ABOVE_TERRAIN_M = 1000;

type ScanComputeParams = {
  activeTool: "los" | "traceroute" | "coverage" | "scan" | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolVirtualPos: [number, number] | null;
  terrain3D: boolean;
  /** Bumped on style.load — re-pushes scan lines + filter after setStyle wipes them. */
  styleEpoch: number;
  nodes: Record<string, IMapNode>;
  /** Nodes query errored — an empty `nodes` map is a load failure, not still-loading. */
  nodesLoadFailed: boolean;
  scanTxDbm: number;
  scanAntennaDbi: number;
  scanRxAntennaDbi: number;
  scanRxHeightM: number;
  scanFreqMhz: number;
  scanEffectiveSensitivityDbm: number;
  scanAggressionIdx: number;
  scanClutterEnabled: boolean;
  scanCanopyEnabled: boolean;
  scanBuildingsEnabled: boolean;
  scanAntennaHeightM: number;
  scanReliability: CoverageReliability;
  /** Bumped by the Retry button to force a refetch after a failure. */
  scanRetryNonce: number;
  hiddenScanClasses: Set<ScanClass>;
  scanSummary: ScanSummary | null;
  scanHoverId: string | null;
  mbMapRef: React.RefObject<MlMap | null>;
  isDraggingMarkerRef: React.RefObject<boolean>;
  setScanSummary: (s: ScanSummary | null) => void;
  setIsScanning: (b: boolean) => void;
  setScanError: (e: string | null) => void;
  setScanTerrainWarning: (w: string | null) => void;
  setScanDemSource: (s: DemSource | null) => void;
  setScanClutterStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setScanCanopyStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setScanBuildingsStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setToolFromId: (id: string | null) => void;
  setToolVirtualPos: (p: [number, number] | null) => void;
};

interface ScanRasterCache {
  bboxKey: string;
  retryNonce: number;
  dem: DEM;
  demSource: DemSource;
  demMppM: number;
  /** null = tier not fetched yet (fetched lazily as toggles enable it). */
  clutter: ClutterRaster | null;
  canopy: CanopyRaster | null;
  buildings: BuildingRaster | null;
}

export function useScanCompute(params: ScanComputeParams) {
  const {
    activeTool, toolStep, toolFromId, toolVirtualPos,
    terrain3D, styleEpoch, nodes, nodesLoadFailed,
    scanTxDbm, scanAntennaDbi, scanRxAntennaDbi, scanRxHeightM, scanFreqMhz, scanEffectiveSensitivityDbm,
    scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled,
    scanAntennaHeightM, scanReliability, scanRetryNonce,
    hiddenScanClasses, scanSummary, scanHoverId,
    mbMapRef, isDraggingMarkerRef,
    setScanSummary, setIsScanning, setScanDemSource, setScanError, setScanTerrainWarning,
    setScanClutterStatus, setScanCanopyStatus, setScanBuildingsStatus,
    setToolFromId, setToolVirtualPos,
  } = params;

  /** Draggable pin at the scan origin. */
  const scanOriginMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Map view captured when scan starts; restored by the origin row / pin. */
  const scanInitialViewRef = useRef<{ center: [number, number]; zoom: number; pitch: number; bearing: number } | null>(null);
  const scanOriginKeyRef = useRef<string | null>(null);
  // Lazily loaded, reused across scans; same WASM module as the coverage workers (main thread)
  const scanItmContextRef = useRef<ItmContext | null>(null);
  // Cache the bbox-derived rasters so link-budget tweaks reuse them (no refetch).
  const scanRasterCacheRef = useRef<ScanRasterCache | null>(null);
  // Last feature index we set hover:true on, so we can clear just that one.
  const prevHoverIdxRef = useRef<number | null>(null);
  // Latest nodes, read inside the async body without making `nodes` a compute trigger
  // (SSE flushes churn its identity ~2.5 Hz; only real position changes should re-scan).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Resolve the origin to stable scalars so the compute effect re-runs when the
  // ORIGIN moves, not when unrelated node telemetry updates. (Shortname is read
  // inside the async body from the live ref — it's display-only.)
  let originLng: number | null = null;
  let originLat: number | null = null;
  let originAltitude: number | null = null;
  if (toolFromId) {
    const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
    if (n?.map_position) {
      originLng = n.map_position[0];
      originLat = n.map_position[1];
      originAltitude = effectiveAltitudeMslM(n.position);
    }
  } else if (toolVirtualPos) {
    originLng = toolVirtualPos[0];
    originLat = toolVirtualPos[1];
  }

  // Position-only signature of scan targets. Recomputed only when `nodes` identity
  // changes (~400 ms), so mouse-move re-renders don't rebuild it; the expensive scan
  // re-runs only when this VALUE changes (a node's position/altitude actually moved).
  const targetsSig = useMemo(() => {
    let sig = "";
    for (const rawId in nodes) {
      const n = nodes[rawId];
      if (!n?.map_position) continue;
      const alt = effectiveAltitudeMslM(n.position);
      sig += `${rawId}:${n.map_position[0].toFixed(5)},${n.map_position[1].toFixed(5)},${alt == null ? "x" : Math.round(alt)};`;
    }
    return sig;
  }, [nodes]);

  const nodesEmpty = Object.keys(nodes).length === 0;

  // Scan tool: batch LoS to every node in radius from a chosen origin
  useEffect(() => {
    if (activeTool !== "scan" || toolStep !== "result") {
      setScanSummary(null);
      setIsScanning(false);
      setScanError(null);
      setScanTerrainWarning(null);
      return;
    }
    if (!terrain3D) {
      setScanSummary(null);
      setIsScanning(false);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) { setIsScanning(false); return; }

    if (originLng == null || originLat == null) {
      setScanSummary(null);
      // Origin came from a node that hasn't loaded yet (rare — scan picks require
      // rendered nodes): stay quiet and let the nodes arrival retrigger.
      if (nodesEmpty && !nodesLoadFailed) { setIsScanning(false); return; }
      setScanError("The scan origin no longer has a map position.");
      setIsScanning(false);
      return;
    }
    const origin: [number, number] = [originLng, originLat];

    // Snapshot view per-origin so "return to overview" is stable across
    // config re-runs but re-captures when the origin moves.
    const originKey = `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`;
    if (scanOriginKeyRef.current !== originKey) {
      scanOriginKeyRef.current = originKey;
      scanInitialViewRef.current = null;
    }
    if (!scanInitialViewRef.current) {
      const c = mb.getCenter();
      scanInitialViewRef.current = {
        center: [c.lng, c.lat],
        zoom: mb.getZoom(),
        pitch: mb.getPitch(),
        bearing: mb.getBearing(),
      };
    }

    if (scanOriginMarkerRef.current) {
      // Don't yank the pin out from under a live drag.
      if (!isDraggingMarkerRef.current) scanOriginMarkerRef.current.setLngLat(origin);
    } else {
      const marker = new maplibregl.Marker({ color: ORIGIN_COLOR, draggable: true })
        .setLngLat(origin)
        .addTo(mb);
      marker.on("dragstart", () => { isDraggingMarkerRef.current = true; });
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        scanInitialViewRef.current = null;
        scanOriginKeyRef.current = null;
        setToolFromId(null);
        // normalizeLng: a drag across the dateline can leave lng outside ±180.
        setToolVirtualPos([normalizeLng(ll.lng), ll.lat]);
      });
      scanOriginMarkerRef.current = marker;
    }

    let cancelled = false;

    const runAsync = async () => {
      setIsScanning(true);
      setScanError(null);
      try {
        // Collect ALL nodes (read live via ref); runScan's maxDistanceKm applies the radius cutoff
        const liveNodes = nodesRef.current;
        const originNode = toolFromId ? (liveNodes[toolFromId] ?? liveNodes[`!${toolFromId}`]) : undefined;
        const originShortname = originNode?.shortname?.trim() || undefined;
        const targets: ScanTarget[] = [];
        const seen = new Set<string>();
        for (const rawId in liveNodes) {
          const node = liveNodes[rawId];
          if (!node?.map_position) continue;
          const [lng, lat] = node.map_position;
          const norm = rawId.startsWith("!") ? rawId.slice(1) : rawId;
          if (toolFromId && (norm === toolFromId || rawId === toolFromId)) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          targets.push({
            id: norm,
            shortname: node.shortname?.trim() || undefined,
            position: [lng, lat],
            altitudeM: effectiveAltitudeMslM(node.position),
          });
        }

        if (targets.length === 0) {
          // Distinguish "no nodes in range" from a failed nodes fetch.
          setScanError(nodesLoadFailed ? "Couldn't load nodes. Check your connection and retry." : null);
          setScanSummary({
            origin, originShortname,
            results: [], clearCount: 0, fresnelCount: 0, diffractedCount: 0, blockedCount: 0,
          });
          setIsScanning(false);
          return;
        }

        const mapboxToken = env.MAPBOX_TOKEN;
        if (!mapboxToken) {
          console.warn("[Map] Scan aborted — Mapbox token missing.");
          setScanError("Mapbox token not configured — scanning needs terrain elevation data.");
          setIsScanning(false);
          return;
        }

        // Viewport-independent DEM around origin (same 200 km cap as coverage).
        const scanBounds = demBoundsAround(origin, SCAN_RADIUS_KM, 1.05);
        const bboxKey = `${scanBounds.west.toFixed(4)},${scanBounds.south.toFixed(4)},${scanBounds.east.toFixed(4)},${scanBounds.north.toFixed(4)}`;

        // Cache is keyed on bbox ONLY (rasters don't depend on the toggles). Toggling a
        // tier off never refetches; re-enabling reuses the cached tier; only a genuinely
        // new tier (or a moved origin / retry) triggers a fetch.
        let cache = scanRasterCacheRef.current;
        const cacheValid = !!cache && cache.bboxKey === bboxKey && cache.retryNonce === scanRetryNonce;
        const missingTier =
          (scanClutterEnabled && !(cacheValid && cache!.clutter)) ||
          (scanCanopyEnabled && !(cacheValid && cache!.canopy)) ||
          (scanBuildingsEnabled && !(cacheValid && cache!.buildings));

        if (!cacheValid || missingTier) {
          // Request the union of already-cached tiers and currently-enabled tiers so a
          // re-enable keeps prior fetches and only the new tier is added.
          const wantClutter = scanClutterEnabled || !!(cacheValid && cache!.clutter);
          const wantCanopy = scanCanopyEnabled || !!(cacheValid && cache!.canopy);
          const wantBuildings = scanBuildingsEnabled || !!(cacheValid && cache!.buildings);
          // 2048² rasters match coverage's resolution; the tile fetch/decode/resample
          // runs in the raster-build worker (main-thread fallback) so the map stays live.
          const built = await buildCoverageRasters({
            bounds: scanBounds,
            size: 2048,
            maxTiles: SCAN_MAX_TILES,
            token: mapboxToken,
            wantClutter, wantCanopy, wantBuildings,
          });
          const midLat = (built.dem.bounds.north + built.dem.bounds.south) / 2;
          const demWidthM = (built.dem.bounds.east - built.dem.bounds.west) * (Math.PI / 180) * 6371000 * Math.cos(midLat * Math.PI / 180);
          const demMppM = demWidthM / Math.max(1, built.dem.width - 1);
          const fresh: ScanRasterCache = {
            bboxKey, retryNonce: scanRetryNonce,
            dem: built.dem, demSource: built.demSource, demMppM,
            clutter: built.clutter, canopy: built.canopy, buildings: built.buildings,
          };
          // Persist BEFORE the cancel check so a superseded run's completed fetch isn't
          // thrown away — but never cache a holed DEM (failed tiles read as sea level).
          if (built.demTilesFailed === 0) scanRasterCacheRef.current = fresh;
          else scanRasterCacheRef.current = null;
          if (cancelled) return;
          cache = fresh;
          setScanTerrainWarning(
            built.demTilesFailed > 0
              ? `${built.demTilesFailed} of ${built.demTilesTotal} terrain tiles failed to load — gaps read as sea level, so results may be unreliable. Retry to refetch.`
              : null,
          );
        } else {
          setScanTerrainWarning(null);
        }
        if (cancelled || !cache) return;

        const dem = cache.dem;
        const scanClutter = scanClutterEnabled ? cache.clutter : null;
        const scanCanopy = scanCanopyEnabled ? cache.canopy : null;
        const scanBuildings = scanBuildingsEnabled ? cache.buildings : null;
        setScanDemSource(cache.demSource);
        setScanClutterStatus(scanClutter ? { tilesPresent: scanClutter.tilesPresent, tilesTotal: scanClutter.tilesTotal } : null);
        setScanCanopyStatus(scanCanopy ? { tilesPresent: scanCanopy.tilesPresent, tilesTotal: scanCanopy.tilesTotal } : null);
        setScanBuildingsStatus(scanBuildings ? { tilesPresent: scanBuildings.tilesPresent, tilesTotal: scanBuildings.tilesTotal } : null);

        // Origin MSL: prefer the node's GPS altitude when it's plausible vs terrain
        // (matches coverage's precedence), else terrain; then add the antenna height.
        const originTerrainM = sampleDEMAt(dem, origin[0], origin[1]);
        const groundOk = Number.isFinite(originTerrainM);
        const gpsOk =
          originAltitude != null && Number.isFinite(originAltitude) &&
          (!groundOk || (originAltitude >= originTerrainM && originAltitude <= originTerrainM + MAX_ORIGIN_HEIGHT_ABOVE_TERRAIN_M));
        const baseM = gpsOk ? (originAltitude as number) : (groundOk ? originTerrainM : 0);
        const effectiveOriginAltitude = baseM + scanAntennaHeightM;

        if (!scanItmContextRef.current) {
          try {
            scanItmContextRef.current = await loadItmContext(MAX_SCAN_PATH_POINTS);
          } catch (err) {
            console.warn("[Map] Scan ITM WASM unavailable — falling back to FSPL:", err);
          }
        }
        if (cancelled) return;

        const rel = reliabilityPreset(scanReliability);
        const summary = await runScanAsync(
          {
            origin,
            originAltitudeM: effectiveOriginAltitude,
            originShortname,
            targets,
            maxDistanceKm: SCAN_RADIUS_KM,
            demMppM: cache.demMppM,
            freqGHz: scanFreqMhz / 1000,
            txDbm: scanTxDbm,
            txAntennaDbi: scanAntennaDbi,
            rxAntennaDbi: scanRxAntennaDbi,
            rxAntennaHeightM: scanRxHeightM,
            rxSensitivityDbm: scanEffectiveSensitivityDbm,
            clutterRaster: scanClutter,
            canopyRaster: scanCanopy,
            buildingRaster: scanBuildings,
            // aggression = 0 when the user has toggled the model off → ITM-only path loss.
            clutterAggression: scanClutterEnabled ? (AGGRESSION_STOPS[scanAggressionIdx]?.value ?? 1.0) : 0,
            queryTerrainM: (lng, lat) => {
              const elev = sampleDEMAt(dem, lng, lat);
              return Number.isNaN(elev) ? null : elev;
            },
            itm: scanItmContextRef.current
              ? {
                  context: scanItmContextRef.current,
                  ...DEFAULT_ITM_ENV,
                  // Without these, scanAnalysis falls back to 50/50/50 — much
                  // more optimistic than coverage's 90/50/70 default.
                  timePct: rel.time,
                  locationPct: rel.location,
                  situationPct: rel.situation,
                }
              : undefined,
          },
          { shouldCancel: () => cancelled },
        );

        if (cancelled || !summary) return;
        setScanSummary(summary);
        setScanError(null);
        const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
        src?.setData(scanToGeoJSON(summary));
      } catch (err) {
        // A stale run's late rejection must not clobber the newer run's state.
        if (cancelled) return;
        console.warn("[Map] Scan failed:", err);
        // Keep the previous summary + lines so map and panel don't disagree; the
        // panel surfaces the error with a Retry affordance.
        setScanError("Scan failed. Adjust settings and try again.");
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    };

    runAsync();
    return () => { cancelled = true; };
  }, [activeTool, toolStep, toolFromId, originLng, originLat, originAltitude, targetsSig,
      terrain3D, nodesEmpty, nodesLoadFailed, scanRetryNonce,
      scanTxDbm, scanAntennaDbi, scanRxAntennaDbi, scanRxHeightM, scanFreqMhz, scanEffectiveSensitivityDbm,
      scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled,
      scanAntennaHeightM, scanReliability,
      mbMapRef, isDraggingMarkerRef,
      setScanSummary, setIsScanning, setScanDemSource, setScanError, setScanTerrainWarning,
      setScanClutterStatus, setScanCanopyStatus, setScanBuildingsStatus,
      setToolFromId, setToolVirtualPos]);

  // Re-push the current scan geometry after a basemap style change recreated the
  // (now-empty) scan-links source — without recomputing.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb || activeTool !== "scan" || !scanSummary) return;
    try {
      const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
      src?.setData(scanToGeoJSON(scanSummary));
    } catch {}
  }, [styleEpoch, scanSummary, activeTool, mbMapRef]);

  // Per-class map visibility filter (compute still runs for hidden classes).
  // styleEpoch dep re-applies the filter after style.load recreates the layer.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const layer = "scan-links-line";
    if (!mb.getLayer(layer)) return;
    if (hiddenScanClasses.size === 0) {
      mb.setFilter(layer, null);
    } else {
      mb.setFilter(layer, [
        "!",
        ["in", ["get", "cls"], ["literal", Array.from(hiddenScanClasses)]],
      ] as any);
    }
  }, [hiddenScanClasses, activeTool, styleEpoch, mbMapRef]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (activeTool !== "scan") {
      try {
        const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      if (scanOriginMarkerRef.current) {
        scanOriginMarkerRef.current.remove();
        scanOriginMarkerRef.current = null;
      }
      scanInitialViewRef.current = null;
      scanOriginKeyRef.current = null;
      scanRasterCacheRef.current = null;
      prevHoverIdxRef.current = null;
      // Drop stale tile-availability telemetry so the next session doesn't show it.
      setScanClutterStatus(null);
      setScanCanopyStatus(null);
      setScanBuildingsStatus(null);
    }
  }, [activeTool, mbMapRef, setScanClutterStatus, setScanCanopyStatus, setScanBuildingsStatus]);

  // Scan hover via feature-state — clear only the previously-set feature (O(1)).
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb || !scanSummary) return;
    if (prevHoverIdxRef.current != null) {
      try { mb.setFeatureState({ source: "scan-links", id: prevHoverIdxRef.current }, { hover: false }); } catch {}
      prevHoverIdxRef.current = null;
    }
    if (scanHoverId == null) return;
    const idx = scanSummary.results.findIndex((r) => r.id === scanHoverId);
    if (idx >= 0) {
      try { mb.setFeatureState({ source: "scan-links", id: idx }, { hover: true }); } catch {}
      prevHoverIdxRef.current = idx;
    }
  }, [scanHoverId, scanSummary, mbMapRef]);

  return {
    scanOriginMarkerRef,
    scanInitialViewRef,
    scanOriginKeyRef,
    scanItmContextRef,
  };
}
