import "maplibre-gl/dist/maplibre-gl.css";

import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { env } from "../env";
import { reverseGeocode } from "../maps/geocoder";
import { buildMapStyle, ensureTerrain, type OsmBasemap,removeTerrain } from "../maps/mapStyle";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { type ITraceroutesResponse,NodeRole, roleTitles } from "../types";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { ClusterDonutLayer } from "./map/clusterDonutLayer";
import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, type CoverageResult,effectiveSensitivityDbm, ENVIRONMENTS, MESHTASTIC_PRESETS, reliabilityPreset } from "./map/coverageAnalysis";
import { type ContourFeatureCollection,extractCoverageContours } from "./map/coverageContours";
import type { RasterParams } from "./map/coverageRaster";
import { extractCoverageRays, type VisibilityRayFeatureCollection } from "./map/coverageRays";
import type { CoverageSliceRequest } from "./map/coverageSliceWorker";
import { CoverageWorkerPool } from "./map/coverageWorkerPool";
import { FiltersResetPill } from "./map/FiltersResetPill";
import { Climate, computeP2PLoss, type ItmContext, loadItmContext, Polarization } from "./map/itm";
import { buildAllLinksFeatureCollection, buildMapboxLinkFeatureCollection, buildTracerouteLinkFeatureCollection, computeHeardByIds, normNodeId } from "./map/linkFeatures";
import { analyzeLineOfSight, type LoSResult } from "./map/losAnalysis";
import { losPointsToTubeData, LosTubeLayer, obstructionsToGeoJSON, pickObstructions } from "./map/losTubeLayer";
import { COVERAGE_DETAIL_MAX_TILES, COVERAGE_DETAIL_SIZE, type CoverageDetail, MapCoveragePanel } from "./map/MapCoveragePanel";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapHealthWidget } from "./map/MapHealthWidget";
import { MapLosPanel } from "./map/MapLosPanel";
import { MapScanPanel } from "./map/MapScanPanel";
import { MapSearchBar } from "./map/MapSearchBar";
import { MapSettingsPanel } from "./map/MapSettingsPanel";
import { MapToolPrompt, MapToolsDrawer } from "./map/MapToolsDrawer";
import { MapTraceroutePanel } from "./map/MapTraceroutePanel";
import { findPathsBetween } from "./map/pathAnalysis";
import { runScan, type ScanClass, type ScanSummary, type ScanTarget,scanToGeoJSON } from "./map/scanAnalysis";
import {
  autoSpiderfyVisibleClusters,
  removeSpiderfyLayers,
  spiderfy,
  SPIDERFY_LAYER_LABELS,
  SPIDERFY_LAYER_NODES,
  SPIDERFY_SOURCE_NODES,
  unspiderfy,
  updateSpiderfyPositions,
} from "./map/spiderfy";
import { LS_KEYS, readJson, writeJson } from "./map/storage";
import { type DEM, type DEMBounds,demBoundsAround, downsampleDEM, sampleDEMAt } from "./map/terrainDEM";
import { buildDem, type DemSource,fetchElevationAt } from "./map/terrainRgb";
import type { IMapNode, LinkMode, MapProvider, NodeDetailsData, NodeLike } from "./map/types";
import {
  applyClusterVisibility,
  buildNodesGeoJSON,
  calculateGeodesicDistance,
  DEFAULT_NODE_COLOR,
  emptyLineFeatureCollection,
  escapeHtml,
  OFFLINE_NODE_COLOR,
  ROLE_COLORS,
} from "./map/utils";

// 1×1 transparent PNG placeholder for the coverage-raster source
const TRANSPARENT_1PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** `map.queryTerrainElevation` returns `dem_m × exaggeration` with no opt-out;
 *  divide it back out for real MSL (RF math, hover pill, anywhere needing physical metres). */
function queryTerrainElevationMSL(map: MlMap, lnglat: [number, number]): number | null {
  const e = map.queryTerrainElevation(lnglat);
  if (typeof e !== "number" || !Number.isFinite(e)) return null;
  const ex = map.getTerrain()?.exaggeration;
  const exaggeration = typeof ex === "number" && ex > 0 ? ex : 1;
  return e / exaggeration;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** SVG signal bars (1-4) colored by best SNR. */
function signalBarsHtml(snr: number | null): string {
  let bars: number;
  let color: string;
  if (snr == null) { bars = 0; color = "#6b7280"; }
  else if (snr >= 10) { bars = 4; color = "#22c55e"; }
  else if (snr >= 5) { bars = 3; color = "#84cc16"; }
  else if (snr >= 0) { bars = 2; color = "#eab308"; }
  else { bars = 1; color = "#ef4444"; }

  const heights = [4, 7, 10, 13];
  const rects = heights.map((h, i) => {
    const fill = i < bars ? color : "#374151";
    return `<rect x="${i * 5}" y="${16 - h}" width="3.5" height="${h}" rx="0.5" fill="${fill}"/>`;
  }).join("");
  return `<svg width="20" height="16" viewBox="0 0 20 16" style="vertical-align:middle;margin-right:4px">${rects}</svg>`;
}

/** Best (max) SNR from a node's neighbors. */
function bestSnr(nodeId: string, nodes: Record<string, IMapNode>): number | null {
  const node = nodes[nodeId];
  if (!node?.neighbors?.length) return null;
  let max = -Infinity;
  for (const n of node.neighbors) {
    if (n.snr > max) max = n.snr;
  }
  return max === -Infinity ? null : max;
}

function geodesicCircleCoords(
  center: [number, number], // [lon, lat]
  radiusKm: number,
  points: number = 64,
): [number, number][] {
  const R = 6371;
  const lat1 = (center[1] * Math.PI) / 180;
  const lon1 = (center[0] * Math.PI) / 180;
  const d = radiusKm / R;

  const coords: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const brng = (2 * Math.PI * i) / points;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return coords;
}

/** Max observed range (km) across neighbors, heard-by, and traceroute peers. */
function computeMaxRange(
  nodeId: string,
  nodePos: [number, number], // [lon, lat]
  liveNodes: Record<string, IMapNode>,
  heardBy: string[],
  traceroutes: ITraceroutesResponse[],
): number | null {
  const connectedIds = new Set<string>();

  const node = liveNodes[nodeId];
  for (const n of node?.neighbors ?? []) connectedIds.add(n.id);

  for (const id of heardBy) connectedIds.add(id);

  // Traceroute peers (adjacent hops)
  const normId = normNodeId(nodeId);
  for (const tr of traceroutes) {
    const from = normNodeId(tr?.from);
    const to = normNodeId(tr?.to);
    const route: string[] = (tr?.route_ids ?? tr?.route ?? [])
      .map(normNodeId)
      .filter(Boolean);
    const path = [from, ...route, to].filter(Boolean);
    const idx = path.indexOf(normId);
    if (idx === -1) continue;
    if (idx > 0 && path[idx - 1]) connectedIds.add(path[idx - 1]);
    if (idx < path.length - 1 && path[idx + 1]) connectedIds.add(path[idx + 1]);
  }

  let maxDist = 0;
  for (const id of connectedIds) {
    const other = liveNodes[id] ?? liveNodes[`!${id}`];
    if (!other?.map_position) continue;
    const dist = calculateGeodesicDistance(
      nodePos[1], nodePos[0],
      other.map_position[1], other.map_position[0],
    );
    if (dist > maxDist) maxDist = dist;
  }
  return maxDist > 0.05 ? maxDist : null; // skip <50 m
}

// Role-based node color (offline = gray)
const mbRoleColorExpr = [
  "case",
  ["!", ["boolean", ["get", "online"], false]],
  OFFLINE_NODE_COLOR,
  ["match", ["get", "role"],
    ...Object.entries(ROLE_COLORS).flatMap(([k, v]) => [Number(k), v]),
    DEFAULT_NODE_COLOR,
  ],
] as any;

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  // JSON signature skips setData when the GeoJSON is byte-identical across polls
  const persistentLinksMbJsonRef = useRef<string>("");

  const mbMapRef = useRef<MlMap | null>(null);
  const clusterDonutLayerRef = useRef<ClusterDonutLayer | null>(null);
  // Sticky after first style.load — `isStyleLoaded()` momentarily lies post-removeSource.
  const styleEverLoadedRef = useRef(false);
  const mbSelectedIdRef = useRef<string | null>(null);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);
  const mbKeydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const mbTouchCleanupRef = useRef<(() => void) | null>(null);

  // Set by whichever provider is active
  const handleNodeSelectRef = useRef<(nodeId: string) => void>(() => {});
  const handleLinkHoverRef = useRef<(otherId: string | null) => void>(() => {});
  const selectedNodeIdRef = useRef<string | null>(null);

  const { data: rawNodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();
  const { data: rawTraceroutes = [] } = useGetTraceroutesQuery();

  const resolveChannelLabel = useCallback(
    (channelId: string | null | undefined): string | null => {
      if (!channelId) return null;
      const meta = (config as any)?.broker?.channels?.meta?.[channelId];
      return meta?.label ? String(meta.label) : null;
    },
    [config],
  );

  const mapboxToken = env.MAPBOX_TOKEN;
  const hasMapbox = Boolean(mapboxToken);

  const [provider, setProvider] = useState<MapProvider>(() => {
    const stored = readJson<MapProvider | null>(LS_KEYS.provider, null);
    if (stored) return stored === "mapbox" && !hasMapbox ? "osm" : stored;
    return hasMapbox ? "mapbox" : "osm";
  });

  const [mapboxStyle, setMapboxStyle] = useState<string>(() => {
    const stored = readJson<string | null>(LS_KEYS.mapboxStyle, null);
    return (
      stored ??
      env.MAPBOX_STYLE ??
      "mapbox/satellite-streets-v12"
    );
  });

  const [osmBasemap, setOsmBasemap] = useState<OsmBasemap>(() => {
    const stored = readJson<OsmBasemap | null>(LS_KEYS.osmBasemap, null);
    return stored ?? "carto_dark";
  });

  const [recentDays, setRecentDays] = useState<number>(() => {
    const stored = readJson<number | null>(LS_KEYS.recentDays, null);
    return stored ?? 30;
  });

  const [clusterEnabled, setClusterEnabled] = useState<boolean>(() => {
    const stored = readJson<boolean | null>(LS_KEYS.clusterEnabled, null);
    return stored ?? true;
  });

  const [linkMode, setLinkMode] = useState<LinkMode>(() => {
    const stored = readJson<LinkMode | null>(LS_KEYS.linkMode, null);
    return stored ?? "selected";
  });

  const [myNodeId, setMyNodeId] = useState<string>(() => {
    return readJson<string>(LS_KEYS.myNodeId, "");
  });

  const [roleFilter, setRoleFilter] = useState<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  // Global tool state; each drives its own step-based workflow
  const [activeTool, setActiveTool] = useState<"los" | "traceroute" | "coverage" | "scan" | null>(null);
  const [toolStep, setToolStep] = useState<"pickFrom" | "pickTo" | "result">("pickFrom");
  const [toolFromId, setToolFromId] = useState<string | null>(null);
  const [toolToId, setToolToId] = useState<string | null>(null);
  const [toolVirtualPos, setToolVirtualPos] = useState<[number, number] | null>(null);

  // 3D terrain
  const [terrain3D, setTerrain3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.terrain3D, true));
  const terrainExaggeration = 1.5;
  const [losResult, setLosResult] = useState<LoSResult | null>(null);
  /** DEM tile source used for the last LoS compute. */
  const [losDemSource, setLosDemSource] = useState<DemSource | null>(null);
  // LOS virtual pins — endpoints can be arbitrary map points, not just nodes
  const [losVirtualFrom, setLosVirtualFrom] = useState<[number, number] | null>(null);
  const [losVirtualTo, setLosVirtualTo] = useState<[number, number] | null>(null);
  // Per-endpoint hardware/antenna/height for asymmetric LOS
  const [losFromHwIdx, setLosFromHwIdx] = useState(0);
  const [losFromAntIdx, setLosFromAntIdx] = useState(3); // Rokland 5.8 dBi
  const [losFromHeightM, setLosFromHeightM] = useState(2);
  const [losToHwIdx, setLosToHwIdx] = useState(0);
  const [losToAntIdx, setLosToAntIdx] = useState(3);
  const [losToHeightM, setLosToHeightM] = useState(2);
  const [coverageResult, setCoverageResult] = useState<CoverageResult | null>(null);
  const [isComputingCoverage, setIsComputingCoverage] = useState(false);
  const [isFetchingCoverageTerrain, setIsFetchingCoverageTerrain] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  // Bumped by the panel's Retry button to force a recompute
  const [coverageRetryNonce, setCoverageRetryNonce] = useState(0);
  // total === 0 means idle / drag preview / terrain fetch
  const [coverageProgress, setCoverageProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 });
  const [coverageDemSource, setCoverageDemSource] = useState<DemSource | null>(null);
  // Index into COMMON_ANTENNAS (value-based <select> can't distinguish same-dBi models)
  const [coverageAntennaIdx, setCoverageAntennaIdx] = useState(3);
  const coverageAntennaDbi = COMMON_ANTENNAS[coverageAntennaIdx]?.dbi ?? 3;
  const [coverageHardwareIdx, setCoverageHardwareIdx] = useState(0);
  // Asymmetric RX defaults: Heltec V3 + rubber duck @ 2 m (stock portable)
  const [coverageRxHardwareIdx, setCoverageRxHardwareIdx] = useState(4);
  const [coverageRxAntennaIdx, setCoverageRxAntennaIdx] = useState(0);
  const coverageRxAntennaDbi = COMMON_ANTENNAS[coverageRxAntennaIdx]?.dbi ?? 3;
  const [coverageRxHeightM, setCoverageRxHeightM] = useState(2);
  const [coverageCustomTxDbm, setCoverageCustomTxDbm] = useState(22);
  const coverageTxDbm = COMMON_HARDWARE[coverageHardwareIdx].isCustom
    ? coverageCustomTxDbm
    : COMMON_HARDWARE[coverageHardwareIdx].txDbm;
  const [coverageEnvIdx, setCoverageEnvIdx] = useState(0);
  const [coveragePresetIdx, setCoveragePresetIdx] = useState(0); // MediumFast
  const [coverageCustomSensDbm, setCoverageCustomSensDbm] = useState(-133);
  const coverageSensitivityDbm = MESHTASTIC_PRESETS[coveragePresetIdx].isCustom
    ? coverageCustomSensDbm
    : MESHTASTIC_PRESETS[coveragePresetIdx].sensitivityDbm;
  // Session-scoped (not persisted)
  const [coverageDetail, setCoverageDetail] = useState<CoverageDetail>("standard");
  // Antenna AGL (m); overrides GPS altitude on node-anchored origins
  const [coverageAntennaHeightM, setCoverageAntennaHeightM] = useState(2);
  const [coverageReliability, setCoverageReliability] = useState<CoverageReliability>("typical");
  // Ref mirror so the drag-preview closure sees latest without re-binding
  const coverageAntennaHeightMRef = useRef(2);
  useEffect(() => {
    coverageAntennaHeightMRef.current = coverageAntennaHeightM;
  }, [coverageAntennaHeightM]);
  // Chipset-corrected RX sensitivity, keyed on RX hardware (sensitivity lives on the receiver)
  const coverageEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[coverageRxHardwareIdx];
    return effectiveSensitivityDbm(coverageSensitivityDbm, hw.chipset, hw.sensitivityOffsetDb ?? 0);
  }, [coverageSensitivityDbm, coverageRxHardwareIdx]);
  // Scan tool link-budget config — independent from coverage.
  const [scanAntennaIdx, setScanAntennaIdx] = useState(3);
  const scanAntennaDbi = COMMON_ANTENNAS[scanAntennaIdx]?.dbi ?? 3;
  const [scanHardwareIdx, setScanHardwareIdx] = useState(0);
  const [scanAntennaHeightM, setScanAntennaHeightM] = useState(2);
  const [scanRxHardwareIdx, setScanRxHardwareIdx] = useState(4);
  const [scanRxAntennaIdx, setScanRxAntennaIdx] = useState(0);
  const scanRxAntennaDbi = COMMON_ANTENNAS[scanRxAntennaIdx]?.dbi ?? 3;
  const [scanCustomTxDbm, setScanCustomTxDbm] = useState(22);
  const scanTxDbm = COMMON_HARDWARE[scanHardwareIdx].isCustom
    ? scanCustomTxDbm
    : COMMON_HARDWARE[scanHardwareIdx].txDbm;
  const [scanEnvIdx, setScanEnvIdx] = useState(0);
  const [scanPresetIdx, setScanPresetIdx] = useState(0);
  const [scanCustomSensDbm, setScanCustomSensDbm] = useState(-133);
  const scanSensitivityDbm = MESHTASTIC_PRESETS[scanPresetIdx].isCustom
    ? scanCustomSensDbm
    : MESHTASTIC_PRESETS[scanPresetIdx].sensitivityDbm;
  const scanEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[scanRxHardwareIdx];
    return effectiveSensitivityDbm(scanSensitivityDbm, hw.chipset, hw.sensitivityOffsetDb ?? 0);
  }, [scanSensitivityDbm, scanRxHardwareIdx]);
  // Blocked hidden by default — the count can dominate on dense meshes.
  const [hiddenScanClasses, setHiddenScanClasses] = useState<Set<ScanClass>>(() => new Set(["blocked"]));

  // DEM/raster bbox size from free-space budget. Capped at 200 km — beyond that
  // low tile-zoom averages terrain away (Mt. Oso reads ~200 m low at 500 km bbox).
  const coverageRadiusKm = useMemo(() => {
    const CABLE = 0.5;
    const FADE = 15;
    const clutter = ENVIRONMENTS[coverageEnvIdx]?.clutterLossDb ?? 0;
    const budget =
      coverageTxDbm +
      coverageAntennaDbi +
      coverageRxAntennaDbi -
      coverageEffectiveSensitivityDbm -
      FADE -
      CABLE -
      clutter;
    const plConstant = 32.45 + 20 * Math.log10(915);
    const maxKm = Math.pow(10, (budget - plConstant) / 20);
    return Math.max(5, Math.min(200, Math.round(maxKm)));
  }, [coverageAntennaDbi, coverageRxAntennaDbi, coverageTxDbm, coverageEffectiveSensitivityDbm, coverageEnvIdx]);
  /** 3D LoS tube layer; created once per map. */
  const losTubeLayerRef = useRef<LosTubeLayer | null>(null);
  /** DOM pin for the Coverage origin (draggable). */
  const coverageOriginMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Draggable pin at the scan origin. */
  const scanOriginMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Map view captured when scan starts; restored by the origin row / pin. */
  const scanInitialViewRef = useRef<{ center: [number, number]; zoom: number; pitch: number; bearing: number } | null>(null);
  const scanOriginKeyRef = useRef<string | null>(null);
  /** Suppresses the cursor-elevation mousemove handler so marker drag doesn't stutter. */
  const isDraggingMarkerRef = useRef(false);
  /** Terrain elevation (MSL m) under the cursor. */
  const [hoverElevationM, setHoverElevationM] = useState<number | null>(null);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanHoverId, setScanHoverId] = useState<string | null>(null);
  /** DEM tile source used for the last scan. */
  const [scanDemSource, setScanDemSource] = useState<DemSource | null>(null);
  /** Monotonic request id — stale worker replies are dropped. */
  const coverageRequestIdRef = useRef(0);
  /** Lazily-created coverage worker pool; terminated on unmount. */
  const coveragePoolRef = useRef<CoverageWorkerPool | null>(null);
  const ensureCoveragePool = useCallback((): CoverageWorkerPool => {
    if (!coveragePoolRef.current) {
      coveragePoolRef.current = new CoverageWorkerPool();
    }
    return coveragePoolRef.current;
  }, []);
  useEffect(() => {
    return () => {
      coveragePoolRef.current?.terminate();
      coveragePoolRef.current = null;
    };
  }, []);

  /** Cached authoritative DEM; drag-preview reuses it without re-fetching tiles. */
  const coverageDemRef = useRef<DEM | null>(null);
  /** 256² downsample of the above; lets drag preview run LR at ~8-12 fps. */
  const coverageDragDemRef = useRef<DEM | null>(null);
  /** Latest raster params snapshot (drag preview reuses untouched). */
  const coverageLastRasterParamsRef = useRef<RasterParams | null>(null);
  /** Last origin context (bounds); drag re-samples DEM per move. */
  const coverageLastOriginContextRef = useRef<{ bounds: DEMBounds } | null>(null);
  /** Single-flight drag preview; latest pending position fires when current completes. */
  const dragPreviewBusyRef = useRef(false);
  const dragPreviewPendingRef = useRef<[number, number] | null>(null);
  // LOS endpoints from the compute effect; refs so the hover-marker callback reads them without deps churn
  const losFromPosRef = useRef<[number, number] | null>(null);
  const losToPosRef = useRef<[number, number] | null>(null);
  // Marker for the LOS elevation-chart hover
  const losHoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const handleLosProfileHover = useCallback((fraction: number | null) => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (fraction == null) {
      losHoverMarkerRef.current?.remove();
      losHoverMarkerRef.current = null;
      return;
    }
    const from = losFromPosRef.current;
    const to = losToPosRef.current;
    if (!from || !to) return;
    const lng = from[0] + (to[0] - from[0]) * fraction;
    const lat = from[1] + (to[1] - from[1]) * fraction;
    if (!losHoverMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:14px;height:14px;border-radius:50%;background:#f97316;" +
        "border:2px solid white;box-shadow:0 0 8px rgba(0,0,0,0.5);" +
        "pointer-events:none;";
      losHoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(mb);
    } else {
      losHoverMarkerRef.current.setLngLat([lng, lat]);
    }
  }, []);

  // Skips fitBounds re-zoom when the user changes config without moving endpoints
  const losFitKeyRef = useRef<string | null>(null);
  // Lazily loaded, reused across scans; same WASM module as the coverage workers (main thread)
  const scanItmContextRef = useRef<ItmContext | null>(null);

  /** Cached contour GeoJSON for Export without recomputing. */
  const coverageContoursRef = useRef<ContourFeatureCollection | null>(null);
  /** Cached visibility-ray fan. */
  const coverageRaysRef = useRef<VisibilityRayFeatureCollection | null>(null);
  /** Cached margin grid for export. */
  const coverageMarginRef = useRef<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: DEMBounds;
  } | null>(null);
  /** Blob URL for coverage-raster; tracked so we revoke on update/close (else ~5 MB leak per Survey compute). */
  const coverageRasterUrlRef = useRef<string | null>(null);
  const [showCoverageContours, setShowCoverageContours] = useState(false);
  const [showCoverageRays, setShowCoverageRays] = useState(false);

  /** Export coverage as GeoJSON or KML (iso-margin 0/10/20 dB contours + metadata). */
  const handleCoverageExport = useCallback((format: "geojson" | "kml") => {
    const contours = coverageContoursRef.current;
    const result = coverageResultRef.current;
    if (!contours || !result) {
      console.warn("[Map] Coverage export: no data to export.");
      return;
    }
    const stamp = new Date().toISOString();
    const fileStamp = stamp.replace(/[:.]/g, "-");

    let payload: string;
    let mime: string;
    let ext: string;

    if (format === "geojson") {
      const originGeo = {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [result.origin[0], result.origin[1]] },
        properties: {
          kind: "origin",
          originHeightM: Math.round(result.originHeightM),
          originIsFallback: result.originIsFallback,
          radiusKm: result.radiusKm,
          txAntennaDbi: result.txAntennaDbi,
          rxAntennaDbi: result.rxAntennaDbi,
          rxAntennaHeightAboveGroundM: result.rxAntennaHeightAboveGroundM,
          txDbm: result.txDbm,
          rxSensitivityDbm: result.rxSensitivityDbm,
          model: "Longley-Rice v1.4 (ITS) via WASM",
          generatedAt: stamp,
        },
      };
      payload = JSON.stringify({
        type: "FeatureCollection",
        features: [originGeo, ...contours.features],
      }, null, 2);
      mime = "application/geo+json";
      ext = "geojson";
    } else {
      // KML color format: aabbggrr (byte-reversed from CSS hex)
      const esc = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const styleFor = (threshold: number) => {
        if (threshold <= 0) return "contour0";
        if (threshold <= 10) return "contour10";
        return "contour20";
      };
      const coordsToKml = (coords: [number, number][]) =>
        coords.map(([lng, lat]) => `${lng},${lat},0`).join(" ");

      const placemarks = contours.features.map((f) => `
    <Placemark>
      <name>${f.properties.thresholdDb} dB margin contour</name>
      <styleUrl>#${styleFor(f.properties.thresholdDb)}</styleUrl>
      <LineString>
        <altitudeMode>clampToGround</altitudeMode>
        <tessellate>1</tessellate>
        <coordinates>${coordsToKml(f.geometry.coordinates)}</coordinates>
      </LineString>
    </Placemark>`).join("");

      const description = [
        `Model: Longley-Rice v1.4 (ITS) via WASM`,
        `Origin height: ${Math.round(result.originHeightM)} m${result.originIsFallback ? " (fallback)" : ""}`,
        `Analysis radius: ${result.radiusKm} km`,
        `TX: ${result.txDbm} dBm, antenna ${result.txAntennaDbi} dBi`,
        `RX: antenna ${result.rxAntennaDbi} dBi @ ${Math.round(result.rxAntennaHeightAboveGroundM)} m AGL, sensitivity ${result.rxSensitivityDbm} dBm`,
        `Generated: ${stamp}`,
      ].map(esc).join("\n");

      payload = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>MeshInfo coverage</name>
    <description><![CDATA[${description}]]></description>
    <Style id="origin">
      <IconStyle>
        <color>ffd3f322</color>
        <scale>1.1</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="contour0">
      <LineStyle><color>ff0b9ef5</color><width>3</width></LineStyle>
    </Style>
    <Style id="contour10">
      <LineStyle><color>ff5ec522</color><width>2</width></LineStyle>
    </Style>
    <Style id="contour20">
      <LineStyle><color>ffacef86</color><width>2</width></LineStyle>
    </Style>
    <Placemark>
      <name>Coverage origin</name>
      <description><![CDATA[${esc(`${Math.round(result.originHeightM)} m MSL · TX ${result.txDbm} dBm · ${result.txAntennaDbi} dBi`)}]]></description>
      <styleUrl>#origin</styleUrl>
      <Point>
        <coordinates>${result.origin[0]},${result.origin[1]},${Math.round(result.originHeightM)}</coordinates>
      </Point>
    </Placemark>${placemarks}
  </Document>
</kml>`;
      mime = "application/vnd.google-earth.kml+xml";
      ext = "kml";
    }

    const blob = new Blob([payload], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meshinfo-coverage-${fileStamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  /** Latest coverage result exposed via ref for export. */
  const coverageResultRef = useRef<CoverageResult | null>(null);
  useEffect(() => {
    coverageResultRef.current = coverageResult;
  }, [coverageResult]);

  /** Run pool over a DEM, stitch slices, paint RGBA to `coverage-raster`.
   *  Shared by main compute + drag preview. Null = superseded or WASM missing. */
  const renderCoverageToImageSource = useCallback(async (opts: {
    dem: DEM;
    origin: [number, number];
    originHeightM: number;
    /** TX antenna AGL (m); ITM wants AGL not MSL. */
    originAntennaHeightAboveGroundM: number;
    params: RasterParams;
    requestId: number;
    /** Defaults to DEM dims (drag-preview path where DEM == output == 256²). */
    outputWidth?: number;
    outputHeight?: number;
    /** Per-slice progress (completed, total); drag preview omits this. */
    onSliceProgress?: (completed: number, total: number) => void;
  }): Promise<{
    clearCount: number;
    fresnelCount: number;
    blockedCount: number;
    demCoveredPixels: number;
    totalPx: number;
    /** Stitched margin dB; NaN = no-data. */
    marginDb: Float32Array;
    /** Actual output dims (callers use these for contours). */
    outputWidth: number;
    outputHeight: number;
    itmUnavailable?: boolean;
  } | null> => {
    const { dem, origin, originHeightM, originAntennaHeightAboveGroundM, params, requestId, onSliceProgress } = opts;
    const outputWidth = opts.outputWidth ?? dem.width;
    const outputHeight = opts.outputHeight ?? dem.height;
    const mb = mbMapRef.current;
    if (!mb) return null;
    const pool = ensureCoveragePool();
    const poolSize = pool.size;
    const rowsPerTask = Math.ceil(outputHeight / poolSize);

    const sliceResponses: Array<{
      rgba: Uint8ClampedArray;
      marginDb: Float32Array;
      rowStart: number;
      rowEnd: number;
      clearCount: number;
      fresnelCount: number;
      blockedCount: number;
      itmUnavailable?: boolean;
    }> = [];
    const tasks: Promise<unknown>[] = [];
    const totalSlices = Math.min(
      poolSize,
      Math.ceil(outputHeight / rowsPerTask),
    );
    let completedSlices = 0;
    onSliceProgress?.(0, totalSlices);

    for (let i = 0; i < poolSize; i++) {
      const rowStart = i * rowsPerTask;
      if (rowStart >= outputHeight) break;
      const rowEnd = Math.min(rowStart + rowsPerTask, outputHeight);
      const demCopy = new Float32Array(dem.data);
      const req: CoverageSliceRequest = {
        requestId,
        demBuffer: demCopy.buffer,
        demWidth: dem.width,
        demHeight: dem.height,
        bounds: dem.bounds,
        origin,
        originHeightM,
        originAntennaHeightAboveGroundM,
        params,
        outputWidth,
        outputHeight,
        rowStart,
        rowEnd,
      };
      tasks.push(
        pool.dispatch(req, [demCopy.buffer]).then((resp) => {
          sliceResponses.push(resp);
          completedSlices += 1;
          if (requestId === coverageRequestIdRef.current) {
            onSliceProgress?.(completedSlices, totalSlices);
          }
        }),
      );
    }
    await Promise.all(tasks);

    // Bail if superseded
    if (requestId !== coverageRequestIdRef.current) return null;

    if (sliceResponses.some((r) => r.itmUnavailable)) {
      const nanMargin = new Float32Array(outputWidth * outputHeight);
      nanMargin.fill(Number.NaN);
      return {
        clearCount: 0, fresnelCount: 0, blockedCount: 0,
        demCoveredPixels: 0, totalPx: outputWidth * outputHeight,
        marginDb: nanMargin,
        outputWidth, outputHeight,
        itmUnavailable: true,
      };
    }

    const fullRgba = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    const fullMargin = new Float32Array(outputWidth * outputHeight);
    let clearCount = 0;
    let fresnelCount = 0;
    let blockedCount = 0;
    for (const s of sliceResponses) {
      fullRgba.set(s.rgba, s.rowStart * outputWidth * 4);
      fullMargin.set(s.marginDb, s.rowStart * outputWidth);
      clearCount += s.clearCount;
      fresnelCount += s.fresnelCount;
      blockedCount += s.blockedCount;
    }
    const demCoveredPixels = clearCount + fresnelCount + blockedCount;

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imgData = new ImageData(
      fullRgba as Uint8ClampedArray<ArrayBuffer>,
      outputWidth,
      outputHeight,
    );
    ctx.putImageData(imgData, 0, 0);

    // Blob URL (not data URL): at 2048² raw RGBA is ~16 MB, data URL would base64-encode 22 MB
    const url = await new Promise<string>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
        resolve(URL.createObjectURL(blob));
      }, "image/png");
    });

    const src = mb.getSource("coverage-raster") as maplibregl.ImageSource | undefined;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [dem.bounds.west, dem.bounds.north],
      [dem.bounds.east, dem.bounds.north],
      [dem.bounds.east, dem.bounds.south],
      [dem.bounds.west, dem.bounds.south],
    ];
    if (src && typeof (src as unknown as { updateImage?: Function }).updateImage === "function") {
      (src as unknown as { updateImage: (o: { url: string; coordinates: typeof coords }) => void }).updateImage({ url, coordinates: coords });
      // Revoke previous blob — the GPU already holds the new texture.
      const previous = coverageRasterUrlRef.current;
      coverageRasterUrlRef.current = url;
      if (previous) URL.revokeObjectURL(previous);
    } else {
      URL.revokeObjectURL(url);
    }
    if (mb.getLayer("coverage-raster")) {
      mb.setLayoutProperty("coverage-raster", "visibility", "visible");
    }

    return {
      clearCount,
      fresnelCount,
      blockedCount,
      demCoveredPixels,
      totalPx: outputWidth * outputHeight,
      marginDb: fullMargin,
      outputWidth,
      outputHeight,
    };
  }, [ensureCoveragePool]);

  const [settingsPanelOpen, setSettingsPanelOpen] = useState<boolean>(() => {
    const stored = readJson<boolean | null>(LS_KEYS.settingsPanelOpen, null);
    // Desktop default open
    return stored ?? (typeof window !== "undefined" && window.innerWidth >= 1024);
  });
  // Which accordion section is expanded in the settings panel. Lifted to
  // Map.tsx so the tools drawer can jump the user to the "terrain" section
  // when they click a terrain-gated tool with 3D off.
  const [settingsOpenSections, setSettingsOpenSections] = useState<Set<string>>(
    () => new Set(["appearance"]),
  );

  useEffect(() => writeJson(LS_KEYS.provider, provider), [provider]);
  useEffect(() => writeJson(LS_KEYS.mapboxStyle, mapboxStyle), [mapboxStyle]);
  useEffect(() => writeJson(LS_KEYS.osmBasemap, osmBasemap), [osmBasemap]);
  useEffect(() => writeJson(LS_KEYS.recentDays, recentDays), [recentDays]);
  useEffect(() => writeJson(LS_KEYS.clusterEnabled, clusterEnabled), [clusterEnabled]);
  useEffect(() => writeJson(LS_KEYS.linkMode, linkMode), [linkMode]);
  useEffect(() => writeJson(LS_KEYS.myNodeId, myNodeId), [myNodeId]);
  useEffect(() => writeJson(LS_KEYS.settingsPanelOpen, settingsPanelOpen), [settingsPanelOpen]);
  useEffect(() => writeJson(LS_KEYS.terrain3D, terrain3D), [terrain3D]);

  // Obsolete key from the prior exaggeration slider; removeItem is idempotent.
  useEffect(() => {
    try { localStorage.removeItem("meshinfo.map.terrainExaggeration"); } catch {}
  }, []);

  // If token disappears, force provider to osm
  useEffect(() => {
    if (provider === "mapbox" && !hasMapbox) setProvider("osm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMapbox]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;

      if (settingsPanelRef.current?.contains(target)) return;
      if (settingsToggleRef.current?.contains(target)) return;
      // FilterDropup menus are portaled to <body>, outside the panel tree.
      // A click on one of them shouldn't close the settings panel.
      if ((target as Element | null)?.closest?.("[data-filter-menu]")) return;

      setSettingsPanelOpen(false);
    };

    if (settingsPanelOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [settingsPanelOpen]);

  useEffect(() => {
    if (!settingsPanelOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsPanelOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsPanelOpen]);

  const nodes: Record<string, IMapNode> = useMemo(() => {
    const now = new Date();
    const sixHoursAgo = now.getTime() - 6 * 60 * 60 * 1000;

    return Object.fromEntries(
      Object.entries(rawNodes).map(([id, node]) => [
        id,
        {
          ...node,
          online:
            node.last_seen != null &&
            new Date(node.last_seen as string).getTime() > sixHoursAgo,
          map_position:
            node.position &&
            node.position.latitude_i != null &&
            node.position.longitude_i != null
              ? ([
                  (node.position.longitude_i ?? 0) / 10_000_000,
                  (node.position.latitude_i ?? 0) / 10_000_000,
                ] as [number, number])
              : undefined,
          neighbors: node.neighborinfo?.neighbors?.map((neighbor) => ({
            id: convertNodeIdFromIntToHex(neighbor.node_id),
            snr: neighbor.snr,
            distance: neighbor.distance ?? 0,
            lastRxTime: neighbor.last_rx_time,
          })),
        },
      ])
    );
  }, [rawNodes]);

  const serverNode = useMemo(
    () => nodes[config?.server?.node_id ?? ""],
    [config?.server?.node_id, nodes]
  );

  const availableChannels = useMemo(() => {
    const chSet = new Set<string>();
    for (const n of Object.values(rawNodes)) {
      if (n.last_channel) chSet.add(n.last_channel);
    }
    return [...chSet].sort();
  }, [rawNodes]);

  const [detailsData, setDetailsData] = useState<NodeDetailsData | null>(null);

  // Refs to avoid stale closures in long-lived map event handlers.
  const nodesRef = useRef(nodes);
  const traceroutesRef = useRef(rawTraceroutes);
  const configRef = useRef(config);
  const recentDaysRef = useRef(recentDays);
  const clusterEnabledRef = useRef(clusterEnabled);
  const linkModeRef = useRef(linkMode);
  const myNodeIdRef = useRef(myNodeId);
  const roleFilterRef = useRef(roleFilter);
  const channelFilterRef = useRef(channelFilter);
  const activeToolRef = useRef(activeTool);
  const toolStepRef = useRef(toolStep);
  const toolFromIdRef = useRef(toolFromId);

  const isPickingNode = activeTool != null && toolStep !== "result";
  const terrain3DRef = useRef(terrain3D);
  const setDetailsDataRef = useRef(setDetailsData);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    traceroutesRef.current = rawTraceroutes;
  }, [rawTraceroutes]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    setDetailsDataRef.current = setDetailsData;
  }, [setDetailsData]);

  useEffect(() => {
    recentDaysRef.current = recentDays;
  }, [recentDays]);

  useEffect(() => {
    clusterEnabledRef.current = clusterEnabled;
  }, [clusterEnabled]);

  useEffect(() => {
    linkModeRef.current = linkMode;
  }, [linkMode]);

  useEffect(() => { roleFilterRef.current = roleFilter; }, [roleFilter]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { toolStepRef.current = toolStep; }, [toolStep]);
  useEffect(() => { toolFromIdRef.current = toolFromId; }, [toolFromId]);
  useEffect(() => {
    terrain3DRef.current = terrain3D;
  }, [terrain3D]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (mb) {
      mb.getCanvas().style.cursor = isPickingNode ? "crosshair" : "";
    }
  }, [isPickingNode]);

  // Reset the whole tool state. Also imperatively clears map visual geometry
  // so there's no one-tick flash of stale tubes / rasters / scan lines while
  // React re-runs the dependent effects.
  const resetTool = () => {
    setActiveTool(null);
    setToolStep("pickFrom");
    setToolFromId(null);
    setToolToId(null);
    setToolVirtualPos(null);
    setLosVirtualFrom(null);
    setLosVirtualTo(null);
    losFitKeyRef.current = null;
    losFromPosRef.current = null;
    losToPosRef.current = null;
    losHoverMarkerRef.current?.remove();
    losHoverMarkerRef.current = null;
    setLosResult(null);
    setCoverageResult(null);
    setScanSummary(null);
    setIsComputingCoverage(false);
    setIsFetchingCoverageTerrain(false);
    setCoverageError(null);
    setCoverageProgress({ completed: 0, total: 0 });
    setCoverageDemSource(null);
    setLosDemSource(null);
    setScanDemSource(null);
    setIsScanning(false);

    const mb = mbMapRef.current;
    if (mb) {
      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
      try {
        (mb.getSource("los-obstructions") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("scan-links") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("path-analysis") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
      try {
        if (mb.getLayer("coverage-raster")) {
          mb.setLayoutProperty("coverage-raster", "visibility", "none");
        }
        if (mb.getLayer("coverage-contours-line")) {
          mb.setLayoutProperty("coverage-contours-line", "visibility", "none");
        }
        if (mb.getLayer("coverage-rays-line")) {
          mb.setLayoutProperty("coverage-rays-line", "visibility", "none");
        }
        (mb.getSource("coverage-contours") as MlGeoJSONSource | undefined)?.setData(empty);
        (mb.getSource("coverage-rays") as MlGeoJSONSource | undefined)?.setData(empty);
        // Swap to 1×1 PNG to release the 16 MB GPU texture (visibility:none keeps it resident)
        const rasterSrc = mb.getSource("coverage-raster") as maplibregl.ImageSource | undefined;
        if (rasterSrc && typeof (rasterSrc as unknown as { updateImage?: Function }).updateImage === "function") {
          (rasterSrc as unknown as { updateImage: (o: { url: string; coordinates: [[number, number], [number, number], [number, number], [number, number]] }) => void }).updateImage({
            url: TRANSPARENT_1PX_PNG,
            coordinates: [[-180, 85], [180, 85], [180, -85], [-180, -85]],
          });
        }
        if (coverageRasterUrlRef.current) {
          URL.revokeObjectURL(coverageRasterUrlRef.current);
          coverageRasterUrlRef.current = null;
        }
      } catch {}
      losTubeLayerRef.current?.setData(null);
      coverageContoursRef.current = null;
      coverageRaysRef.current = null;
      coverageMarginRef.current = null;
    }
  };

  // Draw shortest traceroute path on both providers
  useEffect(() => {
    const computePathCoords = (): [number, number][] | null => {
      if (activeTool !== "traceroute" || toolStep !== "result") return null;
      if (!toolFromId || !toolToId) return null;
      const paths = findPathsBetween(toolFromId, toolToId, rawTraceroutes);
      if (paths.length === 0) return null;
      const shortest = paths[0];
      const coords: [number, number][] = [];
      for (const hop of shortest.hops) {
        const n = nodes[hop] ?? nodes[`!${hop}`];
        if (n?.map_position) coords.push([n.map_position[0], n.map_position[1]]);
      }
      return coords.length >= 2 ? coords : null;
    };

    const mb = mbMapRef.current;
    if (mb) {
      const src = mb.getSource("path-analysis") as MlGeoJSONSource | undefined;
      if (src) {
        const coords = computePathCoords();
        src.setData(
          coords
            ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] }
            : { type: "FeatureCollection", features: [] },
        );
      }
    }

  }, [activeTool, toolStep, toolFromId, toolToId, rawTraceroutes, nodes]);

  // LoS analysis between toolFromId and toolToId (LOS tool active + both picks done)
  useEffect(() => {
    if (activeTool !== "los" || toolStep !== "result") {
      setLosResult(null);
      return;
    }
    const hasFrom = toolFromId || losVirtualFrom;
    const hasTo = toolToId || losVirtualTo;
    if (!hasFrom || !hasTo) { setLosResult(null); return; }
    if (!terrain3D) { setLosResult(null); return; }
    const mb = mbMapRef.current;
    if (!mb) { setLosResult(null); return; }

    let fromPos: [number, number];
    let fromAltitude: number | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (!n?.map_position) { setLosResult(null); return; }
      fromPos = [n.map_position[0], n.map_position[1]];
      fromAltitude = n.position?.altitude ?? null;
    } else {
      fromPos = losVirtualFrom!;
    }

    let toPos: [number, number];
    let toAltitude: number | null = null;
    if (toolToId) {
      const n = nodes[toolToId] ?? nodes[`!${toolToId}`];
      if (!n?.map_position) { setLosResult(null); return; }
      toPos = [n.map_position[0], n.map_position[1]];
      toAltitude = n.position?.altitude ?? null;
    } else {
      toPos = losVirtualTo!;
    }

    // Stashed for the hover-marker callback (refs avoid deps churn)
    losFromPosRef.current = fromPos;
    losToPosRef.current = toPos;

    const run = async () => {
      // Fetch our own DEM sized to the link bbox; queryTerrainElevation is viewport-limited (~400 m peak underread at low zoom)
      const midLng = (fromPos[0] + toPos[0]) / 2;
      const midLat = (fromPos[1] + toPos[1]) / 2;
      const dLat = (toPos[1] - fromPos[1]) * Math.PI / 180;
      const dLng = (toPos[0] - fromPos[0]) * Math.PI / 180;
      const midLatRad = midLat * Math.PI / 180;
      const linkKm = 6371 * Math.sqrt(
        dLat * dLat + (dLng * Math.cos(midLatRad)) ** 2,
      );
      // Square bbox, 15 km minimum so short links still get a useful bbox
      const halfSpanKm = Math.max(15, linkKm / 2 + Math.max(15, linkKm * 0.15));
      const demBounds = demBoundsAround([midLng, midLat], halfSpanKm, 1.0);

      const mapboxToken = env.MAPBOX_TOKEN;
      if (!mapboxToken) {
        console.warn("[Map] LoS aborted — Mapbox token missing.");
        setLosResult(null);
        return;
      }

      let dem: DEM;
      let demSourceUsedForLos: DemSource;
      try {
        // 2048² → ~115 m/px at 200 km. buildDem tries Tilezen first, falls back to Mapbox.
        ({ dem, source: demSourceUsedForLos } = await buildDem({
          bounds: demBounds,
          targetWidth: 2048,
          targetHeight: 2048,
          token: mapboxToken,
        }));
        setLosDemSource(demSourceUsedForLos);
      } catch (err) {
        console.warn("[Map] LoS DEM fetch failed:", err);
        setLosResult(null);
        return;
      }

      let result: LoSResult;
      try {
        result = analyzeLineOfSight({
          from: fromPos,
          to: toPos,
          fromAltitudeM: fromAltitude,
          toAltitudeM: toAltitude,
          fromAntennaHeightM: losFromHeightM,
          toAntennaHeightM: losToHeightM,
          freqGHz: 0.915,
          samples: 150,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            return Number.isNaN(elev) ? null : elev;
          },
        });
      } catch (err) {
        console.warn("[Map] LoS analysis failed:", err);
        setLosResult(null);
        return;
      }
      // Show geometric result immediately; ITM enhances async
      setLosResult(result);

      // ITM enhancement — silently skips if WASM isn't built
      try {
        const profileM = new Float64Array(result.points.map((p) => p.ground));
        if (profileM.length < 2) return;
        const spacingM = (result.totalDistanceKm * 1000) / (profileM.length - 1);
        const fromGroundM = result.points[0].ground;
        const toGroundM = result.points[result.points.length - 1].ground;
        const itm = await computeP2PLoss({
          txHeightM: Math.max(0.5, result.fromHeightM - fromGroundM),
          rxHeightM: Math.max(0.5, result.toHeightM - toGroundM),
          profileM,
          pointSpacingM: spacingM,
          climate: Climate.ContinentalTemperate,
          surfaceRefractivityN: 301,
          freqMhz: result.frequencyGHz * 1000,
          polarization: Polarization.Vertical,
          groundDielectric: 15,
          groundConductivity: 0.005,
        });
        setLosResult({
          ...result,
          itmLossDb: itm.lossDb,
          itmFreeSpaceDb: itm.intermediate.aFreeSpaceDb,
          itmMode: itm.intermediate.mode,
        });
      } catch (itmErr) {
        console.warn("[Map] LoS ITM enhancement unavailable:", itmErr);
      }
    };

    // Fit viewport only when endpoints change, not on config tweaks
    const fitKey = `${fromPos[0]},${fromPos[1]}-${toPos[0]},${toPos[1]}`;
    if (losFitKeyRef.current !== fitKey) {
      losFitKeyRef.current = fitKey;
      const bounds = new maplibregl.LngLatBounds(fromPos, toPos);
      mb.fitBounds(bounds, { padding: 120, duration: 600, maxZoom: 11 });
    }

    let cancelled = false;
    run().catch((err) => {
      if (!cancelled) console.warn("[Map] LoS run failed:", err);
    });
    return () => { cancelled = true; };
  }, [activeTool, toolStep, toolFromId, toolToId, losVirtualFrom, losVirtualTo, losFromHeightM, losToHeightM, provider, terrain3D, nodes]);

  // Push LoS result → 3D tube layer + obstruction source.
  // Altitudes are scaled by terrain exaggeration to stay pinned to the visual surface.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const hasFrom = toolFromId || losVirtualFrom;
    const hasTo = toolToId || losVirtualTo;
    const showing =
      activeTool === "los" && toolStep === "result" && losResult && hasFrom && hasTo;
    const obsSrc = mb.getSource("los-obstructions") as MlGeoJSONSource | undefined;
    const tube = losTubeLayerRef.current;

    if (!showing) {
      tube?.setData(null);
      obsSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    let fromPos: [number, number];
    let toPos: [number, number];
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (!n?.map_position) return;
      fromPos = [n.map_position[0], n.map_position[1]];
    } else {
      fromPos = losVirtualFrom!;
    }
    if (toolToId) {
      const n = nodes[toolToId] ?? nodes[`!${toolToId}`];
      if (!n?.map_position) return;
      toPos = [n.map_position[0], n.map_position[1]];
    } else {
      toPos = losVirtualTo!;
    }

    // Tube layer scales altitudes internally
    const tubeData = losPointsToTubeData(fromPos, toPos, losResult!.points, losResult!.totalDistanceKm);
    tube?.setData(tubeData);

    // fill-extrusion doesn't auto-scale base/top — scale manually
    const obstructions = pickObstructions(
      fromPos,
      toPos,
      losResult!.points,
      losResult!.totalDistanceKm,
      3,
    );
    const exagRaw = mb.getTerrain()?.exaggeration;
    const exag = typeof exagRaw === "number" ? exagRaw : 1;
    const obsGeo = obstructionsToGeoJSON(obstructions, 60);
    obsGeo.features.forEach((f) => {
      f.properties.baseM *= exag;
      f.properties.topM *= exag;
    });
    obsSrc?.setData(obsGeo);
  }, [activeTool, toolStep, losResult, toolFromId, toolToId, losVirtualFrom, losVirtualTo, nodes]);

  // Scan tool: batch LoS to every node in radius from a chosen origin
  useEffect(() => {
    if (activeTool !== "scan" || toolStep !== "result") {
      setScanSummary(null);
      setIsScanning(false);
      return;
    }
    if (!terrain3D) {
      setScanSummary(null);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) return;

    let origin: [number, number] | null = null;
    let originAltitude: number | null = null;
    let originShortname: string | undefined;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) {
        origin = [n.map_position[0], n.map_position[1]];
        originAltitude = n.position?.altitude ?? null;
        originShortname = n.shortname ?? undefined;
      }
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
    }
    if (!origin) {
      setScanSummary(null);
      return;
    }

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
      scanOriginMarkerRef.current.setLngLat(origin);
    } else {
      const marker = new maplibregl.Marker({ color: "#22d3ee", draggable: true })
        .setLngLat(origin)
        .addTo(mb);
      marker.on("dragstart", () => { isDraggingMarkerRef.current = true; });
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        scanInitialViewRef.current = null;
        scanOriginKeyRef.current = null;
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      scanOriginMarkerRef.current = marker;
    }

    setIsScanning(true);
    let cancelled = false;

    const SCAN_RADIUS_KM = 200;

    const runAsync = async () => {
      try {
        // Collect ALL nodes; runScan's maxDistanceKm applies the radius cutoff
        const targets: ScanTarget[] = [];
        const seen = new Set<string>();
        for (const [rawId, node] of Object.entries(nodes)) {
          if (!node?.map_position) continue;
          const [lng, lat] = node.map_position;
          const norm = rawId.startsWith("!") ? rawId.slice(1) : rawId;
          if (toolFromId && (norm === toolFromId || rawId === toolFromId)) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          targets.push({
            id: norm,
            shortname: node.shortname ?? undefined,
            position: [lng, lat],
            altitudeM: node.position?.altitude ?? null,
          });
        }

        if (targets.length === 0) {
          setScanSummary({
            origin: origin!,
            originShortname,
            results: [],
            clearCount: 0,
            fresnelCount: 0,
            diffractedCount: 0,
            blockedCount: 0,
          });
          setIsScanning(false);
          return;
        }

        // Viewport-independent DEM around origin (same 200 km cap as coverage)
        const mapboxToken = env.MAPBOX_TOKEN;
        if (!mapboxToken) {
          console.warn("[Map] Scan aborted — Mapbox token missing.");
          setIsScanning(false);
          return;
        }
        const scanBounds = demBoundsAround(origin!, SCAN_RADIUS_KM, 1.05);
        const { dem, source: demSourceUsedForScan } = await buildDem({
          bounds: scanBounds,
          targetWidth: 1024,
          targetHeight: 1024,
          token: mapboxToken,
        });
        if (cancelled) return;
        setScanDemSource(demSourceUsedForScan);

        // Override GPS altitude with terrain + configured AGL (matches coverage).
        // Falls back to GPS altitude if DEM sampling fails.
        const originTerrainM = sampleDEMAt(dem, origin![0], origin![1]);
        const terrainValid = Number.isFinite(originTerrainM) && !Number.isNaN(originTerrainM);
        const effectiveOriginAltitude = terrainValid
          ? originTerrainM + scanAntennaHeightM
          : originAltitude;

        if (!scanItmContextRef.current) {
          try {
            scanItmContextRef.current = await loadItmContext(128);
          } catch (err) {
            console.warn("[Map] Scan ITM WASM unavailable — falling back to FSPL:", err);
          }
        }
        if (cancelled) return;

        const summary = runScan({
          origin: origin!,
          originAltitudeM: effectiveOriginAltitude,
          originShortname,
          targets,
          maxDistanceKm: SCAN_RADIUS_KM,
          raySamples: 60,
          freqGHz: 0.915,
          txDbm: scanTxDbm,
          txAntennaDbi: scanAntennaDbi,
          rxAntennaDbi: scanRxAntennaDbi,
          rxSensitivityDbm: scanEffectiveSensitivityDbm,
          clutterLossDb: ENVIRONMENTS[scanEnvIdx]?.clutterLossDb ?? 0,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            return Number.isNaN(elev) ? null : elev;
          },
          itm: scanItmContextRef.current
            ? {
                context: scanItmContextRef.current,
                climate: 5 /* ContinentalTemperate */,
                surfaceRefractivityN: 301,
                polarization: 1 /* Vertical */,
                groundDielectric: 15,
                groundConductivity: 0.005,
              }
            : undefined,
        });

        if (cancelled) return;
        setScanSummary(summary);
        const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
        src?.setData(scanToGeoJSON(summary));
      } catch (err) {
        console.warn("[Map] Scan failed:", err);
        setScanSummary(null);
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    };

    runAsync();
    return () => { cancelled = true; };
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, provider, terrain3D, nodes,
      scanTxDbm, scanAntennaDbi, scanRxAntennaDbi, scanEffectiveSensitivityDbm,
      scanEnvIdx, scanAntennaHeightM]);

  // Per-class map visibility filter (compute still runs for hidden classes).
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
  }, [hiddenScanClasses, activeTool]);

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
    }
  }, [activeTool]);

  // Scan hover via feature-state
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!scanSummary) return;
    for (let i = 0; i < scanSummary.results.length; i++) {
      try {
        mb.setFeatureState(
          { source: "scan-links", id: i },
          { hover: false },
        );
      } catch {}
    }
    if (scanHoverId == null) return;
    const idx = scanSummary.results.findIndex((r) => r.id === scanHoverId);
    if (idx >= 0) {
      try {
        mb.setFeatureState(
          { source: "scan-links", id: idx },
          { hover: true },
        );
      } catch {}
    }
  }, [scanHoverId, scanSummary]);

  // Coverage prediction — runs when Coverage tool reaches result step.
  useEffect(() => {
    if (activeTool !== "coverage" || toolStep !== "result") {
      setCoverageResult(null);
      setIsComputingCoverage(false);
      setIsFetchingCoverageTerrain(false);
      setCoverageError(null);
      setCoverageProgress({ completed: 0, total: 0 });
      return;
    }
    if (!terrain3D) {
      setCoverageResult(null);
      setIsComputingCoverage(false);
      setIsFetchingCoverageTerrain(false);
      setCoverageProgress({ completed: 0, total: 0 });
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) {
      setCoverageResult(null);
      return;
    }

    // Determine origin: either a node, or a virtual position on the map
    let origin: [number, number] | null = null;
    let altitude: number | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) {
        origin = [n.map_position[0], n.map_position[1]];
        altitude = n.position?.altitude ?? null;
      }
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
      altitude = null; // virtual = no known altitude, will fall back to terrain + antenna
    }
    if (!origin) {
      setCoverageResult(null);
      return;
    }

    // Mark as computing but keep the previous result visible so controls stay up
    setIsComputingCoverage(true);
    setCoverageError(null);
    setCoverageProgress({ completed: 0, total: 0 });

    const radKm = coverageRadiusKm;
    const demBounds = demBoundsAround(origin, radKm, 1.05);
    // Recenter on the pin; tile fetch is viewport-independent so we don't need to fly.
    mb.easeTo({ center: origin, duration: 300 });

    const mapboxToken = env.MAPBOX_TOKEN;
    if (!mapboxToken) {
      console.warn("[Map] Coverage compute aborted — Mapbox token missing.");
      setIsComputingCoverage(false);
      return;
    }

    const requestId = ++coverageRequestIdRef.current;
    let cancelled = false;

    // Pool-based compute: fetch DEM once, slice to workers, stitch RGBA.
    // DEM is fixed 2048²; "Detail" only changes OUTPUT_SIZE (paint pixelation, not RF accuracy).
    const DEM_SIZE = 2048;
    const OUTPUT_SIZE = COVERAGE_DETAIL_SIZE[coverageDetail];
    const envEntry = ENVIRONMENTS[coverageEnvIdx];
    const rel = reliabilityPreset(coverageReliability);
    const rasterParams: RasterParams = {
      freqMhz: 915,
      txDbm: coverageTxDbm,
      txAntennaDbi: coverageAntennaDbi,
      rxAntennaDbi: coverageRxAntennaDbi,
      rxAntennaHeightAboveGroundM: coverageRxHeightM,
      rxSensitivityDbm: coverageEffectiveSensitivityDbm,
      fadeMarginDb: 15,
      cableLossDb: 0.5,
      clutterLossDb: envEntry.clutterLossDb,
      // Continental Temperate + N=301 is the NA Meshtastic default
      climate: 5 /* Climate.ContinentalTemperate */,
      surfaceRefractivityN: 301,
      polarization: 1 /* Polarization.Vertical */,
      groundDielectric: 15,
      groundConductivity: 0.005,
      timePct: rel.time,
      locationPct: rel.location,
      situationPct: rel.situation,
    };

    (async () => {
      const t0 = performance.now();
      const timings: Record<string, number> = {};
      const mark = (name: string, fromMs: number) => {
        timings[name] = performance.now() - fromMs;
      };
      try {
        // 1. Fetch terrain tiles, build full DEM on main thread (Tilezen → Mapbox fallback)
        const tFetch = performance.now();
        setIsFetchingCoverageTerrain(true);
        const { dem, source: demSourceUsed } = await buildDem({
          bounds: demBounds,
          targetWidth: DEM_SIZE,
          targetHeight: DEM_SIZE,
          token: mapboxToken,
          maxTiles: COVERAGE_DETAIL_MAX_TILES[coverageDetail],
        });
        setCoverageDemSource(demSourceUsed);
        mark("demFetchMs", tFetch);
        if (cancelled || requestId !== coverageRequestIdRef.current) {
          setIsFetchingCoverageTerrain(false);
          return;
        }
        setIsFetchingCoverageTerrain(false);

        // Resolve origin ground via two independent sources; we take the MAX because
        // a low-zoom-averaged reading can only under-report a peak, never over-report:
        //   1. `queryTerrainElevation` reads the loaded raster-dem tiles. Accurate when
        //      zoomed in (~5-30 m px at z=13-14); at low zoom can under-read a peak by ~180 m.
        //   2. `fetchElevationAt` does a dedicated z=15 fetch — viewport-independent,
        //      LRU-cached. Source: Tilezen (USGS 3DEP / SRTM), Mapbox terrain-RGB fallback.
        // queryTerrainElevationMSL undoes MapLibre's built-in exaggeration multiply.
        const mbElev = queryTerrainElevationMSL(mb, origin!);
        const mbElevOk = typeof mbElev === "number" && Number.isFinite(mbElev);
        const fetchElev = await fetchElevationAt(origin![0], origin![1], mapboxToken);
        const fetchOk = fetchElev != null && Number.isFinite(fetchElev);
        let originGroundHighZoom: number | null = null;
        if (mbElevOk && fetchOk) {
          originGroundHighZoom = Math.max(mbElev, fetchElev);
        } else if (mbElevOk) {
          originGroundHighZoom = mbElev;
        } else if (fetchOk) {
          originGroundHighZoom = fetchElev;
        }
        const originGroundFromDem = sampleDEMAt(dem, origin![0], origin![1]);
        const groundOkDem = !Number.isNaN(originGroundFromDem);
        const groundOkHz = originGroundHighZoom != null;
        const groundOk = groundOkHz || groundOkDem;
        // Narrowed to number with a 0 fallback; downstream usage is guarded by groundOk.
        const originGround: number = groundOkHz
          ? (originGroundHighZoom as number)
          : groundOkDem
            ? originGroundFromDem
            : 0;
        // Guards against junk altitudes (GPS glitch, unit-scaled values); matches losAnalysis.ts
        const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;
        const altValid =
          altitude != null &&
          Number.isFinite(altitude) &&
          (!groundOk ||
            (altitude >= originGround &&
              altitude <= originGround + MAX_HEIGHT_ABOVE_TERRAIN_M));
        const baseM = altValid
          ? (altitude as number)
          : (groundOk ? originGround : 0);
        const originHeightM = baseM + coverageAntennaHeightM;
        const originIsFallback = !groundOk && !altValid;
        // ITM wants TX height above profile[0] (bbox DEM value). Compensate so TX MSL matches
        // originHeightM after profile[0]+txHeight. Collapses to antennaHeight on flat terrain.
        const txAboveGroundM = groundOkDem
          ? originHeightM - originGroundFromDem
          : coverageAntennaHeightM;

        // 3. Dispatch pool; OUTPUT_SIZE decoupled from DEM_SIZE so Detail only changes paint sharpness
        const tDispatch = performance.now();
        const rendered = await renderCoverageToImageSource({
          dem,
          origin: origin!,
          originHeightM,
          originAntennaHeightAboveGroundM: txAboveGroundM,
          params: rasterParams,
          requestId,
          outputWidth: OUTPUT_SIZE,
          outputHeight: OUTPUT_SIZE,
          onSliceProgress: (completed, total) => {
            setCoverageProgress({ completed, total });
          },
        });
        mark("poolComputeMs", tDispatch);
        if (cancelled || requestId !== coverageRequestIdRef.current) return;
        if (!rendered) return;
        if (rendered.itmUnavailable) {
          console.warn(
            "[Map] Coverage compute: ITM WASM not built. Run `yarn build:wasm`.",
          );
          setCoverageResult(null);
          setIsComputingCoverage(false);
          setCoverageProgress({ completed: 0, total: 0 });
          setCoverageError(
            "Coverage model unavailable — the ITM WebAssembly module failed to load. " +
              "Try refreshing the page; if the problem persists, check the developer console.",
          );
          return;
        }

        // 4. Cache full + downsampled DEM for the drag-preview pass.
        coverageDemRef.current = dem;
        coverageDragDemRef.current = downsampleDEM(dem, 256, 256);
        coverageLastRasterParamsRef.current = rasterParams;
        coverageLastOriginContextRef.current = { bounds: dem.bounds };

        // 5. Iso-contours (0 dB = edge, +10 reliable, +20 strong) from output-sized margin grid
        coverageMarginRef.current = {
          data: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
        };
        const contours = extractCoverageContours({
          margin: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
          thresholdsDb: [0, 10, 20],
        });
        coverageContoursRef.current = contours;
        try {
          const src = mb.getSource("coverage-contours") as MlGeoJSONSource | undefined;
          src?.setData(contours);
        } catch {}

        // 6. Visibility rays: R2 viewshed AND margin grid; costs ~50-100 ms
        const rays = extractCoverageRays({
          dem,
          margin: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
          origin: origin!,
          originHeightM,
          azimuthStepDeg: 1,
        });
        coverageRaysRef.current = rays;
        try {
          const src = mb.getSource("coverage-rays") as MlGeoJSONSource | undefined;
          src?.setData(rays);
        } catch {}

        const computeMs = performance.now() - t0;
        if (import.meta.env.DEV) {
          console.info(
            `[Map] Coverage compute: ${computeMs.toFixed(0)} ms ` +
              `for ${OUTPUT_SIZE}² output / ${DEM_SIZE}² dem across ${ensureCoveragePool().size} workers ` +
              `(${Math.round((rendered.demCoveredPixels / rendered.totalPx) * 100)}% terrain-covered)`,
            timings,
          );
        }

        setCoverageResult({
          origin: origin!,
          originHeightM,
          originIsFallback,
          radiusKm: radKm,
          clearCount: rendered.clearCount,
          fresnelCount: rendered.fresnelCount,
          blockedCount: rendered.blockedCount,
          scannedPixels: rendered.totalPx,
          frequencyGHz: 0.915,
          txAntennaDbi: coverageAntennaDbi,
          rxAntennaDbi: coverageRxAntennaDbi,
          rxAntennaHeightAboveGroundM: coverageRxHeightM,
          txDbm: coverageTxDbm,
          rxSensitivityDbm: coverageEffectiveSensitivityDbm,
        });
        setIsComputingCoverage(false);
        setCoverageProgress({ completed: 0, total: 0 });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // User cancel rejects pool tasks with "pool terminated" — expected, not an error
        if (/pool terminated/i.test(msg)) {
          setIsComputingCoverage(false);
          setIsFetchingCoverageTerrain(false);
          setCoverageProgress({ completed: 0, total: 0 });
          return;
        }
        console.warn("[Map] Coverage computation failed:", err);
        setCoverageResult(null);
        setIsComputingCoverage(false);
        setIsFetchingCoverageTerrain(false);
        setCoverageProgress({ completed: 0, total: 0 });
        const isTerrain = /terrain|tile|fetch|network|cors|http/i.test(msg);
        setCoverageError(
          isTerrain
            ? "Couldn't fetch terrain tiles. Check your connection and try again."
            : "Coverage compute failed. See the developer console and try again.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, coverageRadiusKm, coverageAntennaDbi, coverageRxAntennaDbi, coverageRxHeightM, coverageTxDbm, coverageEnvIdx, coverageSensitivityDbm, coverageDetail, coverageAntennaHeightM, coverageReliability, provider, terrain3D, nodes, coverageRetryNonce]);

  // Hide coverage raster when leaving tool; sources/layers stay for fast re-entry
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (activeTool !== "coverage") {
      try {
        if (mb.getLayer("coverage-raster")) {
          mb.setLayoutProperty("coverage-raster", "visibility", "none");
        }
        if (mb.getLayer("coverage-contours-line")) {
          mb.setLayoutProperty("coverage-contours-line", "visibility", "none");
        }
        if (mb.getLayer("coverage-rays-line")) {
          mb.setLayoutProperty("coverage-rays-line", "visibility", "none");
        }
      } catch {}
    }
  }, [activeTool]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!mb.getLayer("coverage-contours-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-contours-line",
        "visibility",
        activeTool === "coverage" && showCoverageContours ? "visible" : "none",
      );
    } catch {}
  }, [activeTool, showCoverageContours, coverageResult]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!mb.getLayer("coverage-rays-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-rays-line",
        "visibility",
        activeTool === "coverage" && showCoverageRays ? "visible" : "none",
      );
    } catch {}
  }, [activeTool, showCoverageRays, coverageResult]);

  // Dim cluster donuts/count once a tool reaches its result step (origin placed / link picked)
  // so the raster + overlays read clearly.
  useEffect(() => {
    const dimmed = activeTool != null && toolStep === "result";
    const alpha = dimmed ? 0.25 : 1;

    clusterDonutLayerRef.current?.setAlpha(alpha);

    const mb = mbMapRef.current;
    if (mb && mb.getLayer("clusters-count")) {
      try { mb.setPaintProperty("clusters-count", "text-opacity", alpha); } catch {}
    }
  }, [activeTool, toolStep]);

  // Sync coverage pin to origin (node pick or virtual placement)
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const clear = () => {
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
    };

    if (activeTool !== "coverage" || toolStep !== "result") {
      clear();
      return;
    }

    let origin: [number, number] | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) origin = [n.map_position[0], n.map_position[1]];
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
    }
    if (!origin) {
      clear();
      return;
    }

    if (coverageOriginMarkerRef.current) {
      coverageOriginMarkerRef.current.setLngLat(origin);
    } else {
      const marker = new maplibregl.Marker({ color: "#22d3ee", draggable: true })
        .setLngLat(origin)
        .addTo(mb);

      // Drag preview: 256² compute off cached downsampled DEM, single-flight, newest-wins
      const runDragPreview = async (lngLat: [number, number]) => {
        if (dragPreviewBusyRef.current) {
          dragPreviewPendingRef.current = lngLat;
          return;
        }
        const dem = coverageDragDemRef.current;
        const params = coverageLastRasterParamsRef.current;
        if (!dem || !params) return;
        dragPreviewBusyRef.current = true;
        try {
          // Negative id keeps drag previews out of the authoritative id namespace
          const previewId = -Math.floor(performance.now());
          const demGround = sampleDEMAt(dem, lngLat[0], lngLat[1]);
          const demGroundOk = !Number.isNaN(demGround);
          // Real MSL — see queryTerrainElevationMSL helper for the exaggeration math.
          const mbGround = queryTerrainElevationMSL(mb, lngLat);
          const mbGroundOk = typeof mbGround === "number" && Number.isFinite(mbGround);
          const accurateGround = mbGroundOk ? mbGround : (demGroundOk ? demGround : 0);
          const antennaH = coverageAntennaHeightMRef.current;
          const originH = accurateGround + antennaH;
          const txAboveGroundM = demGroundOk
            ? originH - demGround
            : antennaH;
          coverageRequestIdRef.current = previewId;
          await renderCoverageToImageSource({
            dem,
            origin: lngLat,
            originHeightM: originH,
            originAntennaHeightAboveGroundM: txAboveGroundM,
            params,
            requestId: previewId,
          });
        } finally {
          dragPreviewBusyRef.current = false;
          const pending = dragPreviewPendingRef.current;
          if (pending) {
            dragPreviewPendingRef.current = null;
            runDragPreview(pending);
          }
        }
      };

      marker.on("dragstart", () => {
        isDraggingMarkerRef.current = true;
      });
      marker.on("drag", () => {
        const ll = marker.getLngLat();
        runDragPreview([ll.lng, ll.lat]);
      });

      // On dragend: switch to a virtual origin (detach any node pick) and kick a full recompute
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        dragPreviewPendingRef.current = null;
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      coverageOriginMarkerRef.current = marker;
    }
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, nodes]);

  useEffect(() => {
    return () => {
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
    };
  }, []);

  useEffect(() => { channelFilterRef.current = channelFilter; }, [channelFilter]);

  useEffect(() => {
    myNodeIdRef.current = myNodeId;
  }, [myNodeId]);

  // Deep-link ?node=<id>
  const [searchParams, setSearchParams] = useSearchParams();
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
  }, [urlNodeId, flyToTarget, setSearchParams]);

  // Debounced URL sync for center/zoom
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const syncUrl = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        let lat: number | undefined;
        let lng: number | undefined;
        let z: number | undefined;

        const mb = mbMapRef.current;
        if (mb) {
          const c = mb.getCenter();
          lat = +c.lat.toFixed(5);
          lng = +c.lng.toFixed(5);
          z = +mb.getZoom().toFixed(2);
        }

        if (lat != null && lng != null && z != null) {
          setSearchParams((prev) => {
            prev.set("lat", String(lat));
            prev.set("lng", String(lng));
            prev.set("z", String(z));
            return prev;
          }, { replace: true });
        }
      }, 800);
    };

    const mb = mbMapRef.current;
    if (mb) {
      mb.on("moveend", syncUrl);
      return () => { clearTimeout(timer); mb.off("moveend", syncUrl); };
    }
    return () => clearTimeout(timer);
  }, [setSearchParams]);

  const myNodeLabel = useMemo(() => {
    if (!myNodeId) return null;
    const n = nodes[myNodeId];
    return n?.shortname || n?.longname || myNodeId;
  }, [myNodeId, nodes]);

  /** Neighbor edge keys for dedup vs traceroute links. */
  function collectNeighborEdgeKeys(liveNodes: Record<string, IMapNode>): Set<string> {
    const keys = new Set<string>();
    for (const [nodeId, node] of Object.entries(liveNodes)) {
      if (!node.neighbors?.length) continue;
      for (const nb of node.neighbors) {
        const normA = normNodeId(nodeId);
        const normB = normNodeId(nb.id);
        if (!normA || !normB || normA === normB) continue;
        const a = normA < normB ? normA : normB;
        const b = normA < normB ? normB : normA;
        keys.add(`${a}|${b}`);
      }
    }
    return keys;
  }

  /** Persistent link GeoJSON for current linkMode (incl. traceroute-inferred). */
  function computePersistentLinks() {
    const mode = linkModeRef.current;
    const liveNodes = nodesRef.current;
    const traceroutes = traceroutesRef.current;

    if (mode === "all") {
      const neighborFC = buildAllLinksFeatureCollection(liveNodes);
      const neighborKeys = collectNeighborEdgeKeys(liveNodes);
      const tracerouteFC = buildTracerouteLinkFeatureCollection(traceroutes, liveNodes, neighborKeys);
      return {
        type: "FeatureCollection" as const,
        features: [...neighborFC.features, ...tracerouteFC.features],
      };
    }

    if (mode === "mynode") {
      const id = myNodeIdRef.current;
      const node = liveNodes[id];
      if (node?.map_position) {
        const nodeLike: NodeLike = {
          id,
          shortname: node.shortname,
          longname: node.longname,
          last_seen: node.last_seen,
          online: Boolean(node.online),
          position: node.map_position,
          neighbors: node.neighbors,
          gateway: node.gateway,
          role: (node as any).role,
        };
        const heardBy = computeHeardByIds(liveNodes, id);
        const neighborFC = buildMapboxLinkFeatureCollection({ node: nodeLike, liveNodes, heardBy });
        const tracerouteFC = buildTracerouteLinkFeatureCollection(
          traceroutes.filter((tr) => {
            const norm = normNodeId(id);
            const from = normNodeId(tr.from);
            const to = normNodeId(tr.to);
            if (from === norm || to === norm) return true;
            const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
            return hops.includes(norm);
          }),
          liveNodes,
        );
        return {
          type: "FeatureCollection" as const,
          features: [...neighborFC.features, ...tracerouteFC.features],
        };
      }
    }

    return emptyLineFeatureCollection();
  }

  /** Push persistent link data to the "links" source. */
  function refreshMapboxLinks() {
    const map = mbMapRef.current;
    if (!map) return;
    try {
      const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
      if (!linksSource) return;
      const fc = computePersistentLinks();
      const json = JSON.stringify(fc);
      if (json === persistentLinksMbJsonRef.current) return;
      persistentLinksMbJsonRef.current = json;
      linksSource.setData(fc);
    } catch {}
  }

  /** Export the current map view as a PNG download. */
  function handleExport() {
    const triggerDownload = (dataUrl: string) => {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `meshinfo-map-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    if (mbMapRef.current) {
      try {
        // Force repaint so custom layers are captured, then wait a frame
        mbMapRef.current.triggerRepaint();
        setTimeout(() => {
          const canvas = mbMapRef.current!.getCanvas();
          triggerDownload(canvas.toDataURL("image/png"));
        }, 100);
      } catch (err) {
        console.error("Map export failed:", err);
      }
    }
  }

  function clearMapboxSelectionAndOverlays() {
    const map = mbMapRef.current;
    const selectedId = mbSelectedIdRef.current;

    if (map && selectedId) {
      // Clear feature-state across all node sources
      for (const src of ["nodes_clustered", "nodes_plain", SPIDERFY_SOURCE_NODES]) {
        try {
          if (map.getSource(src)) {
            map.setFeatureState({ source: src, id: selectedId }, { selected: false });
          }
        } catch {}
      }
    }

    mbSelectedIdRef.current = null;
    selectedNodeIdRef.current = null;

    // Restore persistent links (all/mynode) or clear if mode is "selected"
    if (map) {
      try {
        const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
        linksSource?.setData(computePersistentLinks());
      } catch {}
      // Clear coverage circle
      try {
        const coverageSrc = map.getSource("coverage") as MlGeoJSONSource | undefined;
        coverageSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      // Clear link highlight
      try {
        const hlSrc = map.getSource("link-highlight") as MlGeoJSONSource | undefined;
        hlSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      // Clear path analysis
      try {
        const paSrc = map.getSource("path-analysis") as MlGeoJSONSource | undefined;
        paSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
    }

    // Hide the panel
    setDetailsData(null);
  }

  // ----------------------------
  // MapLibre: init + layers
  // ----------------------------
  useEffect(() => {
    if (mbMapRef.current) return;
    if (!mapRef.current) return;

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };

    const fallbackNodeWithPos =
      serverNode?.map_position
        ? serverNode
        : Object.values(nodesRef.current).find((n) => n.map_position);

    const centerPos = fallbackNodeWithPos?.map_position
      ? {
          latitude: fallbackNodeWithPos.map_position[1],
          longitude: fallbackNodeWithPos.map_position[0],
        }
      : defaultPosition;

    // Safer savedCenter parsing (avoid NaN / wrong shape)
    let savedCenter: unknown = [];
    try {
      savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    } catch {
      savedCenter = [];
    }
    const saved = Array.isArray(savedCenter) ? savedCenter : [];
    const savedLon = typeof saved[0] === "number" ? saved[0] : undefined;
    const savedLat = typeof saved[1] === "number" ? saved[1] : undefined;

    // Priority: ?node= fly-to > URL lat/lng/z > localStorage > defaults
    const flyTarget = flyToTargetRef.current;
    const urlLat = parseFloat(searchParams.get("lat") ?? "");
    const urlLng = parseFloat(searchParams.get("lng") ?? "");
    const urlZ = parseFloat(searchParams.get("z") ?? "");

    const initialCenter: [number, number] = flyTarget
      ? [flyTarget[0], flyTarget[1]]
      : Number.isFinite(urlLng) && Number.isFinite(urlLat)
        ? [urlLng, urlLat]
        : [savedLon ?? centerPos.longitude, savedLat ?? centerPos.latitude];

    let initialZoom = flyTarget ? 14 : Number.isFinite(urlZ) ? urlZ : 9.5;
    if (!flyTarget && !Number.isFinite(urlZ)) {
      try {
        const z = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");
        if (typeof z === "number" && Number.isFinite(z)) initialZoom = z;
      } catch {
        // ignore
      }
    }

    const styleSpec = buildMapStyle({
      provider,
      osmBasemap,
      mapboxToken,
      mapboxStyle,
    });
    mbCurrentStyleUrlRef.current = JSON.stringify({ provider, mapboxStyle, osmBasemap });

    mapRef.current.innerHTML = "";

    // Persisted pitch/bearing (center + zoom persisted separately)
    let initialPitch = 0;
    let initialBearing = 0;
    try {
      const p = parseFloat(localStorage.getItem("savedPitch") ?? "0");
      if (Number.isFinite(p)) initialPitch = p;
      const b = parseFloat(localStorage.getItem("savedBearing") ?? "0");
      if (Number.isFinite(b)) initialBearing = b;
    } catch {}

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: styleSpec,
      center: initialCenter,
      zoom: initialZoom,
      pitch: initialPitch,
      bearing: initialBearing,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, // required for canvas.toDataURL() export
      maxPitch: 85,
      // Spread keeps drag-rotate direction consistent regardless of cursor position.
      // `aroundCenter` isn't in public MapOptions but is destructured by the internal handler.
      ...({ aroundCenter: false } as object),
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");

    mbMapRef.current = map;

    const NODE_SOURCES = ["nodes_clustered", "nodes_plain", SPIDERFY_SOURCE_NODES] as const;

    const clearSelected = () => {
      const prev = mbSelectedIdRef.current;
      if (!prev) return;
      for (const src of NODE_SOURCES) {
        try {
          if (map.getSource(src)) {
            map.setFeatureState({ source: src, id: prev }, { selected: false });
          }
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error(`Failed to clear feature state for ${src}`, error);
          }
        }
      }
      mbSelectedIdRef.current = null;
    };

    const setSelected = (id: string) => {
      if (mbSelectedIdRef.current && mbSelectedIdRef.current !== id) {
        clearSelected();
      }

      mbSelectedIdRef.current = id;

      for (const src of NODE_SOURCES) {
        try {
          if (map.getSource(src)) {
            map.setFeatureState({ source: src, id }, { selected: true });
          }
        } catch (error) {
          if (import.meta.env.DEV) {
            console.error(`Failed to set feature state for ${src}`, error);
          }
        }
      }
    };

    const getFilters = () => ({ role: roleFilterRef.current, channel: channelFilterRef.current });

    const refreshMapboxNodeData = () => {
      const m = mbMapRef.current;
      if (!m) return;

      const data = buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters());

      const clustered = m.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
      clustered?.setData(data);

      const plain = m.getSource("nodes_plain") as MlGeoJSONSource | undefined;
      plain?.setData(data);
    };

    map.on("moveend", () => {
      const c = map.getCenter();
      localStorage.setItem("savedCenter", JSON.stringify([c.lng, c.lat]));
      localStorage.setItem("savedZoom", map.getZoom().toString());
      localStorage.setItem("savedPitch", map.getPitch().toString());
      localStorage.setItem("savedBearing", map.getBearing().toString());
    });

    const ensureSourcesAndLayers = () => {
      if (!map.getSource("nodes_clustered")) {
        map.addSource("nodes_clustered", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()),
          cluster: true,
          // 80 (vs default 50) spaces large donut centroids enough to avoid overlap
          clusterRadius: 80,
          // Align zoom range with map's (default 22); source defaults (18/17) break auto-spiderfy for stacked nodes
          maxzoom: 22,
          clusterMaxZoom: 21,
          clusterProperties: {
            onlineCount: ["+", ["case", ["get", "online"], 1, 0]],
          },
        });
      }

      if (!map.getSource("nodes_plain")) {
        map.addSource("nodes_plain", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()),
        });
      }

      if (!map.getSource("links")) {
        map.addSource("links", {
          type: "geojson",
          data: emptyLineFeatureCollection(),
        });
      }

      // Link highlight source + layer (for hover-highlight from details panel)
      if (!map.getSource("link-highlight")) {
        map.addSource("link-highlight", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("link-highlight-line")) {
        map.addLayer({
          id: "link-highlight-line",
          type: "line",
          source: "link-highlight",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": 5,
            "line-opacity": 0.9,
            "line-blur": 1,
          },
        });
      }

      // Path analysis source + layer
      if (!map.getSource("path-analysis")) {
        map.addSource("path-analysis", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("path-analysis-line")) {
        map.addLayer({
          id: "path-analysis-line",
          type: "line",
          source: "path-analysis",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#06b6d4",
            "line-width": 4,
            "line-opacity": 0.95,
          },
        });
      }

      // Coverage radius source + layers
      if (!map.getSource("coverage")) {
        map.addSource("coverage", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("coverage-fill")) {
        map.addLayer({
          id: "coverage-fill",
          type: "fill",
          source: "coverage",
          paint: {
            "fill-color": ["coalesce", ["get", "color"], "#32f032"],
            "fill-opacity": 0.08,
          },
        });
      }
      if (!map.getLayer("coverage-outline")) {
        map.addLayer({
          id: "coverage-outline",
          type: "line",
          source: "coverage",
          paint: {
            "line-color": ["coalesce", ["get", "color"], "#32f032"],
            "line-width": 1.5,
            "line-opacity": 0.5,
            "line-dasharray": [4, 4],
          },
        });
      }

      // Coverage-prediction raster (Phase 9.5 — raster+viewshed tool).
      // The worker posts back an RGBA buffer; we upload it as an image source
      // anchored to the DEM's lng/lat bounds, so it drapes on 3D terrain.
      // Initial placeholder: a 1×1 transparent PNG at a degenerate quad near 0,0.
      if (!map.getSource("coverage-raster")) {
        map.addSource("coverage-raster", {
          type: "image",
          url: TRANSPARENT_1PX_PNG,
          coordinates: [
            [0, 0.0001],
            [0.0001, 0.0001],
            [0.0001, 0],
            [0, 0],
          ],
        });
      }
      if (!map.getLayer("coverage-raster")) {
        map.addLayer({
          id: "coverage-raster",
          type: "raster",
          source: "coverage-raster",
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 0.7,
            "raster-fade-duration": 300,
            "raster-resampling": "linear",
          },
        });
      }

      // Iso-margin contour lines
      if (!map.getSource("coverage-contours")) {
        map.addSource("coverage-contours", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("coverage-contours-line")) {
        map.addLayer({
          id: "coverage-contours-line",
          type: "line",
          source: "coverage-contours",
          layout: {
            "line-join": "round",
            "line-cap": "round",
            visibility: "none",
          },
          paint: {
            // 0 dB = magenta (edge), 10 = cyan, 20 = deep cyan
            "line-color": [
              "match", ["get", "thresholdDb"],
              0,  "#d946ef",
              10, "#06b6d4",
              20, "#0891b2",
              "#a1a1aa",
            ],
            "line-width": [
              "match", ["get", "thresholdDb"],
              0,  2.2,
              10, 1.6,
              20, 1.2,
              1,
            ],
            "line-opacity": 0.92,
          },
        });
      }

      // Visibility rays; rendered under contours for layer order
      if (!map.getSource("coverage-rays")) {
        map.addSource("coverage-rays", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("coverage-rays-line")) {
        map.addLayer(
          {
            id: "coverage-rays-line",
            type: "line",
            source: "coverage-rays",
            layout: {
              "line-cap": "butt",
              visibility: "none",
            },
            paint: {
              // Interpolated on segment peak marginDb, matching raster gradient
              "line-color": [
                "interpolate",
                ["linear"],
                ["get", "marginDb"],
                0,  "#d946ef",
                5,  "#f97316",
                15, "#06b6d4",
                25, "#0891b2",
              ],
              "line-width": 1,
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["get", "marginDb"],
                0,  0.2,
                5,  0.35,
                15, 0.55,
                25, 0.65,
              ],
            },
          },
          "coverage-contours-line",
        );
      }

      // 3D LoS tube (WebGL) + obstruction fill-extrusion pylons
      if (!map.getSource("los-obstructions")) {
        map.addSource("los-obstructions", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("los-obstructions-fill")) {
        map.addLayer({
          id: "los-obstructions-fill",
          type: "fill-extrusion",
          source: "los-obstructions",
          paint: {
            "fill-extrusion-color": [
              "interpolate", ["linear"], ["get", "severity"],
              0, "#f87171",
              1, "#b91c1c",
            ],
            "fill-extrusion-base": ["get", "baseM"],
            "fill-extrusion-height": ["get", "topM"],
            "fill-extrusion-opacity": 0.75,
            "fill-extrusion-vertical-gradient": true,
          },
        });
      }
      if (!map.getLayer("los-tube")) {
        try {
          if (!losTubeLayerRef.current) losTubeLayerRef.current = new LosTubeLayer();
          map.addLayer(losTubeLayerRef.current);
        } catch (err) {
          console.warn("[Map] Failed to add LoS tube layer:", err);
        }
      }

      if (!map.getSource("scan-links")) {
        map.addSource("scan-links", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("scan-links-line")) {
        map.addLayer({
          id: "scan-links-line",
          type: "line",
          source: "scan-links",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": [
              "match", ["get", "cls"],
              "clear",      "#06b6d4",
              "fresnel",    "#f97316",
              "diffracted", "#d946ef",
              "blocked",    "#ef4444",
              "#9ca3af",
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "hover"], false], 4,
              2,
            ],
            "line-opacity": [
              "match", ["get", "cls"],
              "blocked", 0.4,
              0.85,
            ],
          },
        });
      }

      const linkWidth = [
        "case",
        ["==", ["get", "snr"], null], 3,
        ["interpolate", ["linear"], ["get", "snr"],
          -10, 1.5, 0, 3, 5, 5, 10, 7, 20, 9,
        ],
      ] as any;
      // Color = SNR (link quality); kind is conveyed by line style. Traceroute
      // keeps its orange — per-hop SNR isn't meaningful on an inferred path.
      const linkColor = [
        "case",
        ["==", ["get", "kind"], "traceroute"], "#F59E0B",
        ["==", ["get", "snr"], null], "#9ca3af",
        ["interpolate", ["linear"], ["get", "snr"],
          -10, "#FF4444", -5, "#FF6644", 0, "#FFAA00",
          2.5, "#FFDD00", 5, "#88DD00", 10, "#44CC44",
        ],
      ] as any;

      // Initial line-opacity bakes recencyOpacity from the feature; focus-on-hover
      // swaps these expressions in to dim non-connected links.
      const linkOpacityInitial = (base: number) =>
        ["*", base, ["coalesce", ["get", "recencyOpacity"], 1.0]] as any;

      // Neighbor + both links (solid; "both" uses curved arcs)
      if (!map.getLayer("links-solid")) {
        map.addLayer({
          id: "links-solid",
          type: "line",
          source: "links",
          filter: ["in", ["get", "kind"], ["literal", ["neighbor", "both"]]],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-opacity": linkOpacityInitial(0.9),
            "line-width": linkWidth,
            "line-color": linkColor,
          },
        });
      }

      if (!map.getLayer("links-dashed")) {
        map.addLayer({
          id: "links-dashed",
          type: "line",
          source: "links",
          filter: ["==", ["get", "kind"], "heard_by"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-opacity": linkOpacityInitial(0.7),
            "line-width": linkWidth,
            "line-color": linkColor,
            "line-dasharray": [4, 3],
          },
        });
      }

      if (!map.getLayer("links-dotted")) {
        map.addLayer({
          id: "links-dotted",
          type: "line",
          source: "links",
          filter: ["==", ["get", "kind"], "traceroute"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-opacity": linkOpacityInitial(0.7),
            "line-width": linkWidth,
            "line-color": linkColor,
            "line-dasharray": [1, 3],
          },
        });
      }

      // Invisible hit-test layer for cluster clicks (donut layer is visual-only)
      if (!map.getLayer("clusters")) {
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          paint: {
            // ~2 px larger than donut for forgiving click target
            "circle-radius": ["interpolate", ["linear"], ["get", "point_count"],
              2, 20, 10, 26, 25, 34, 100, 48, 200, 56],
            "circle-color": "#000000",
            "circle-opacity": 0.005,
            "circle-stroke-width": 0,
            "circle-pitch-alignment": "viewport",
          },
        });
      }

      if (!map.getLayer("clusters-donuts")) {
        const donutLayer = new ClusterDonutLayer();
        map.addLayer(donutLayer);
        clusterDonutLayerRef.current = donutLayer;
        if (activeToolRef.current != null && toolStepRef.current === "result") donutLayer.setAlpha(0.25);
      }

      if (!map.getLayer("clusters-count")) {
        map.addLayer({
          id: "clusters-count",
          type: "symbol",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": ["interpolate", ["linear"], ["get", "point_count"],
              2, 12, 10, 15, 25, 18, 100, 21, 200, 24],
            "text-font": ["DIN Pro Medium", "Arial Unicode MS Bold"],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": "#ffffff",
            "text-opacity": activeToolRef.current != null && toolStepRef.current === "result" ? 0.25 : 1,
          },
        });
      }

      // Online node pulse behind unclustered nodes
      if (!map.getLayer("unclustered-pulse")) {
        map.addLayer({
          id: "unclustered-pulse",
          type: "circle",
          source: "nodes_clustered",
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "online"], true]],
          paint: {
            "circle-radius": 16,
            "circle-color": mbRoleColorExpr,
            "circle-opacity": 0.28,
            "circle-stroke-width": 0,
          },
        });
      }

      // clustered unclustered nodes
      if (!map.getLayer("unclustered-nodes")) {
        map.addLayer({
          id: "unclustered-nodes",
          type: "circle",
          source: "nodes_clustered",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 8],
            "circle-color": mbRoleColorExpr,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "orange",
              "white",
            ],
          },
        });
      }

      if (!map.getLayer("unclustered-labels")) {
        map.addLayer({
          id: "unclustered-labels",
          type: "symbol",
          source: "nodes_clustered",
          filter: ["!", ["has", "point_count"]],
          minzoom: 9,
          layout: {
            "text-field": ["get", "shortname"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 14, 16, 16],
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-optional": true,
          },
          paint: {
            "text-halo-color": "#000000",
            "text-halo-width": 1.25,
            "text-color": "#ffffff",
          },
        });
      }

      // online node pulse (behind plain nodes)
      if (!map.getLayer("plain-pulse")) {
        map.addLayer({
          id: "plain-pulse",
          type: "circle",
          source: "nodes_plain",
          filter: ["==", ["get", "online"], true],
          paint: {
            "circle-radius": 16,
            "circle-color": mbRoleColorExpr,
            "circle-opacity": 0.28,
            "circle-stroke-width": 0,
          },
        });
      }

      // plain nodes layer
      if (!map.getLayer("plain-nodes")) {
        map.addLayer({
          id: "plain-nodes",
          type: "circle",
          source: "nodes_plain",
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 8],
            "circle-color": mbRoleColorExpr,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "orange",
              "white",
            ],
          },
        });
      }

      if (!map.getLayer("plain-labels")) {
        map.addLayer({
          id: "plain-labels",
          type: "symbol",
          source: "nodes_plain",
          minzoom: 9,
          layout: {
            "text-field": ["get", "shortname"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 14, 16, 16],
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-optional": true,
          },
          paint: {
            "text-halo-color": "#000000",
            "text-halo-width": 1.25,
            "text-color": "#ffffff",
          },
        });
      }

      // Apply current cluster visibility (use ref to avoid stale closure)
      applyClusterVisibility(map, clusterEnabledRef.current);

      // Re-apply terrain if it was enabled (style.load wipes this)
      if (terrain3DRef.current) {
        try {
          ensureTerrain(map, terrainExaggeration);
        } catch (err) {
          console.warn("[Map] Terrain re-apply failed after style load:", err);
        }
      }

      // Ensure sources have current data (important after style changes)
      refreshMapboxNodeData();

      // Bind handlers once
      if (mbHandlersBoundRef.current) return;
      mbHandlersBoundRef.current = true;

      const handleNodeClick = async (id: string) => {
        const liveNodes = nodesRef.current;
        const node = liveNodes[id];
        if (!node?.map_position) return;

        selectedNodeIdRef.current = id;
        setSelected(id);

        const displayName = await reverseGeocode(node.map_position[0], node.map_position[1]);

        const nodeLike: NodeLike = {
          id,
          shortname: node.shortname,
          longname: node.longname,
          last_seen: node.last_seen,
          online: Boolean(node.online),
          position: node.map_position,
          neighbors: node.neighbors,
          gateway: node.gateway,
          role: (node as any).role,
        };

        const heardBy = computeHeardByIds(liveNodes, id);

        // Filter traceroutes relevant to this node (used for links + coverage)
        const relevantTraceroutes = traceroutesRef.current.filter((tr) => {
          const norm = normNodeId(id);
          const from = normNodeId(tr.from);
          const to = normNodeId(tr.to);
          if (from === norm || to === norm) return true;
          const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
          return hops.includes(norm);
        });

        const maxRangeKm = computeMaxRange(id, [nodeLike.position[0], nodeLike.position[1]], liveNodes, heardBy, relevantTraceroutes);

        setDetailsDataRef.current({
          node: nodeLike,
          liveNodes,
          displayName: displayName || "Unknown",
          elsewhereLinks: configRef.current?.mesh?.elsewhere_links,
          traceroutes: traceroutesRef.current,
          channelLabel: resolveChannelLabel((node as any).last_channel),
          heardBy,
          maxRangeKm,
        });

        // Draw links (neighbor + traceroute)
        const neighborFC = buildMapboxLinkFeatureCollection({ node: nodeLike, liveNodes, heardBy });
        const tracerouteFC = buildTracerouteLinkFeatureCollection(relevantTraceroutes, liveNodes);
        const mergedFC = {
          type: "FeatureCollection" as const,
          features: [...neighborFC.features, ...tracerouteFC.features],
        };

        const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
        if (linkModeRef.current === "selected") {
          linksSource?.setData(mergedFC);
        } else {
          // In all/mynode mode, merge with persistent links
          const persistent = computePersistentLinks();
          linksSource?.setData({
            type: "FeatureCollection",
            features: [...persistent.features, ...mergedFC.features],
          });
        }

        // Coverage radius circle — always shown on selection
        const coverageSrc = map.getSource("coverage") as MlGeoJSONSource | undefined;
        if (coverageSrc) {
          if (maxRangeKm) {
            const roleColor = ROLE_COLORS[(node as any).role] ?? DEFAULT_NODE_COLOR;
            const circle = geodesicCircleCoords([nodeLike.position[0], nodeLike.position[1]], maxRangeKm);
            coverageSrc.setData({
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                properties: { color: roleColor },
                geometry: { type: "Polygon", coordinates: [circle] },
              }],
            });
          } else {
            coverageSrc.setData({ type: "FeatureCollection", features: [] });
          }
        }
      };

      // Expose handleNodeClick for panel node-select navigation
      handleNodeSelectRef.current = (id: string) => void handleNodeClick(id);

      // Hover callback for details-panel link highlight
      handleLinkHoverRef.current = (otherId: string | null) => {
        const m = mbMapRef.current;
        if (!m) return;
        const src = m.getSource("link-highlight") as MlGeoJSONSource | undefined;
        if (!src) return;
        const selectedId = mbSelectedIdRef.current;
        if (!otherId || !selectedId) {
          src.setData({ type: "FeatureCollection", features: [] });
          return;
        }
        const liveNodes = nodesRef.current;
        const selected = liveNodes[selectedId];
        const other = liveNodes[otherId] ?? liveNodes[`!${otherId}`];
        if (!selected?.map_position || !other?.map_position) {
          src.setData({ type: "FeatureCollection", features: [] });
          return;
        }
        src.setData({
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [selected.map_position[0], selected.map_position[1]],
                [other.map_position[0], other.map_position[1]],
              ],
            },
          }],
        });
      };

      // Cursor behaviors (both render modes)
      const setCursor = (value: string) => {
        map.getCanvas().style.cursor = value;
      };

      const bindHover = (layerId: string) => {
        map.on("mouseenter", layerId, () => setCursor("pointer"));
        map.on("mouseleave", layerId, () => setCursor(""));
      };

      bindHover("unclustered-nodes");
      bindHover("plain-nodes");

      // Focus-on-hover: hovering a node highlights its ego-network (the node +
      // its neighbors + nodes that heard it) and dims everything else.
      const LINK_LAYER_BASE_OPACITY: Record<string, number> = {
        "links-solid": 0.9,
        "links-dashed": 0.7,
        "links-dotted": 0.7,
      };
      const LINK_DIM_OPACITY = 0.1;
      const NODE_DIM_OPACITY = 0.2;

      const recencyExpr = ["coalesce", ["get", "recencyOpacity"], 1.0] as any;

      const linkOpacityForFocus = (base: number, focusedId: string | null) => {
        if (!focusedId) return ["*", base, recencyExpr] as any;
        return [
          "case",
          ["any", ["==", ["get", "aId"], focusedId], ["==", ["get", "bId"], focusedId]],
          ["*", base, recencyExpr],
          ["*", LINK_DIM_OPACITY, recencyExpr],
        ] as any;
      };

      const nodeOpacityForFocus = (relatedIds: string[] | null) => {
        if (!relatedIds || relatedIds.length === 0) return 1.0 as any;
        return [
          "case",
          ["match", ["get", "id"], relatedIds, true, false],
          1.0,
          NODE_DIM_OPACITY,
        ] as any;
      };

      const collectRelatedIds = (focusedId: string): string[] => {
        const liveNodes = nodesRef.current;
        const ids = new Set<string>([focusedId]);
        const focusedNode = liveNodes[focusedId] ?? liveNodes[`!${focusedId}`];
        for (const nb of focusedNode?.neighbors ?? []) ids.add(nb.id);
        // heardBy: nodes whose neighbor list includes the focused node
        for (const [otherId, other] of Object.entries(liveNodes)) {
          if (other.neighbors?.some((n) => n.id === focusedId)) ids.add(otherId);
        }
        return [...ids];
      };

      const applyLinkFocus = (focusedId: string | null) => {
        for (const [layerId, base] of Object.entries(LINK_LAYER_BASE_OPACITY)) {
          if (map.getLayer(layerId)) {
            try { map.setPaintProperty(layerId, "line-opacity", linkOpacityForFocus(base, focusedId)); } catch {}
          }
        }
        const related = focusedId ? collectRelatedIds(focusedId) : null;
        const nodeExpr = nodeOpacityForFocus(related);
        for (const layerId of ["plain-nodes", "unclustered-nodes"]) {
          if (map.getLayer(layerId)) {
            try { map.setPaintProperty(layerId, "circle-opacity", nodeExpr); } catch {}
          }
        }
      };

      const bindFocusHover = (layerId: string) => {
        map.on("mouseenter", layerId, (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const f = e.features?.[0];
          const id = f?.properties?.id as string | undefined;
          if (id) applyLinkFocus(id);
        });
        map.on("mouseleave", layerId, () => applyLinkFocus(null));
      };
      bindFocusHover("unclustered-nodes");
      bindFocusHover("plain-nodes");

      // Cluster click — handler is on the invisible circle hit-test layer
      // ("clusters"), NOT the symbol donut layer. Circle hit-testing is reliable
      // geometry; symbol hit-testing is flaky with dynamic icon-size expressions.
      map.on("click", "clusters", (e) => {
        const cluster = e.features?.[0];
        if (!cluster) return;

        const clusterId = cluster.properties?.cluster_id;
        const source = map.getSource("nodes_clustered") as MlGeoJSONSource;
        if (!source || clusterId == null) return;

        const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
        const currentZoom = map.getZoom();
        const maxZoom = map.getMaxZoom();

        let handled = false;
        const zoomFallback = () => {
          if (handled) return;
          handled = true;
          removeSpiderfyLayers(map);
          map.easeTo({ center: [lng, lat], zoom: Math.min(currentZoom + 2, maxZoom) });
        };
        const timer = setTimeout(zoomFallback, 300);

        source.getClusterExpansionZoom(clusterId).then((zoom) => {
          if (handled) return;
          handled = true;
          clearTimeout(timer);

          if (zoom == null) { zoomFallback(); return; }

          if (zoom >= maxZoom) {
            clearMapboxSelectionAndOverlays();
            // Pass raw node features as fallback — getClusterLeaves can fail
            // silently on stale cluster_ids, and querySourceFeatures can't
            // see nodes hidden inside their cluster aggregate.
            const pool = buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()).features
              .filter((f) => f.geometry?.type === "Point") as any;
            const count = (cluster.properties?.point_count as number) ?? 0;
            void spiderfy(map, clusterId, [lng, lat], currentZoom, true, pool, count);
          } else {
            // Ensure the zoom change is always perceptible. getClusterExpansionZoom
            // can return values only a tiny delta above current zoom, making the
            // easeTo feel like "nothing happened".
            const targetZoom = Math.min(Math.max(zoom, currentZoom + 1), maxZoom);
            removeSpiderfyLayers(map);
            map.easeTo({ center: [lng, lat], zoom: targetZoom });
          }
        }).catch(() => {
          if (handled) return;
          handled = true;
          clearTimeout(timer);
          zoomFallback();
        });
      });

      // Cluster hover cursor (donut icons are GL-native, no HTML to highlight)
      bindHover("clusters");

      const onNodeLayerClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;

        // Tool pick modes intercept node clicks
        const activeToolCur = activeToolRef.current;
        const stepCur = toolStepRef.current;
        if (activeToolCur && stepCur === "pickFrom") {
          setToolFromId(id);
          if (activeToolCur === "coverage" || activeToolCur === "scan") {
            // Single-origin tools skip pickTo
            setToolStep("result");
          } else {
            setToolStep("pickTo");
          }
          map.getCanvas().style.cursor = "crosshair";
          return;
        }
        if (activeToolCur && stepCur === "pickTo") {
          if (id === toolFromIdRef.current) return; // ignore same-node
          setToolToId(id);
          setToolStep("result");
          map.getCanvas().style.cursor = "";
          return;
        }

        void handleNodeClick(id);
      };
      map.on("click", "unclustered-nodes", onNodeLayerClick);
      map.on("click", "plain-nodes", onNodeLayerClick);
      map.on("click", SPIDERFY_LAYER_NODES, onNodeLayerClick);

      // Virtual-origin click (coverage, scan, LOS tools). Fires when the
      // user clicks empty map during pick mode — drops a synthetic pin at
      // that lng/lat instead of requiring an existing node.
      map.on("click", (e) => {
        const t = activeToolRef.current;
        const step = toolStepRef.current;
        // Ignore if clicking on a node layer (handled by onNodeLayerClick)
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["unclustered-nodes", "plain-nodes", "clusters", SPIDERFY_LAYER_NODES].filter((id) => map.getLayer(id)),
        });
        if (features.length > 0) return;

        if ((t === "coverage" || t === "scan") && step === "pickFrom") {
          setToolVirtualPos([e.lngLat.lng, e.lngLat.lat]);
          setToolStep("result");
          map.getCanvas().style.cursor = "";
        } else if (t === "los" && step === "pickFrom") {
          setToolFromId(null);
          setLosVirtualFrom([e.lngLat.lng, e.lngLat.lat]);
          setToolStep("pickTo");
        } else if (t === "los" && step === "pickTo") {
          setToolToId(null);
          setLosVirtualTo([e.lngLat.lng, e.lngLat.lat]);
          setToolStep("result");
          map.getCanvas().style.cursor = "";
        }
      });

      bindHover(SPIDERFY_LAYER_NODES);

      // Clicking empty space clears selection and collapses spiderfy
      map.on("click", (e) => {
        // Build the list of interactive layers, including spiderfy layers if present
        const nodeLayers = ["unclustered-nodes", "plain-nodes", "unclustered-labels", "plain-labels"];
        if (map.getLayer(SPIDERFY_LAYER_NODES)) nodeLayers.push(SPIDERFY_LAYER_NODES);
        if (map.getLayer(SPIDERFY_LAYER_LABELS)) nodeLayers.push(SPIDERFY_LAYER_LABELS);

        const hitNode = map.queryRenderedFeatures(e.point, { layers: nodeLayers }).length > 0;
        const hitCluster =
          map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        void unspiderfy(map);
        clearMapboxSelectionAndOverlays();
      });

      // Update spiderfy positions when zoom changes (keeps fan-out consistent)
      map.on("zoomend", () => {
        updateSpiderfyPositions(map);
      });

      // Auto-spiderfy clusters whose children can't be separated by further zoom.
      // Driven by moveend (reliable, independent of GL render state) with `idle`
      // as a backup and a one-shot on `load` for the initial view. Debounced so
      // a single gesture doesn't run multiple passes.
      let spiderfyDebounce: number | null = null;
      const triggerAutoSpiderfy = () => {
        if (!clusterEnabledRef.current) return;
        if (spiderfyDebounce != null) window.clearTimeout(spiderfyDebounce);
        spiderfyDebounce = window.setTimeout(() => {
          spiderfyDebounce = null;
          const pool = buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()).features
            .filter((f) => f.geometry?.type === "Point") as any;
          void autoSpiderfyVisibleClusters(map, pool);
        }, 150);
      };
      map.on("moveend", triggerAutoSpiderfy);
      map.on("idle", triggerAutoSpiderfy);
      map.once("load", triggerAutoSpiderfy);

      // Right-click / long-press: "Set as My Node"
      const findNodeIdAtPoint = (point: maplibregl.PointLike): string | null => {
        const nodeLayers = ["unclustered-nodes", "plain-nodes"];
        if (map.getLayer(SPIDERFY_LAYER_NODES)) nodeLayers.push(SPIDERFY_LAYER_NODES);
        const features = map.queryRenderedFeatures(point, { layers: nodeLayers });
        return (features[0]?.properties?.id as string) ?? null;
      };

      // Right-click (desktop)
      map.on("contextmenu", (e) => {
        const id = findNodeIdAtPoint(e.point);
        if (!id) return;
        e.preventDefault();
        setMyNodeId(id);
        setLinkMode("mynode");
      });

      // Long-press (mobile) — 500ms threshold
      let longPressTimer: ReturnType<typeof setTimeout> | null = null;
      let longPressPoint: maplibregl.PointLike | null = null;

      const canvas = map.getCanvas();
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const rect = canvas.getBoundingClientRect();
        longPressPoint = [
          e.touches[0].clientX - rect.left,
          e.touches[0].clientY - rect.top,
        ];
        longPressTimer = setTimeout(() => {
          if (!longPressPoint) return;
          const id = findNodeIdAtPoint(longPressPoint);
          if (!id) return;
          setMyNodeId(id);
          setLinkMode("mynode");
          longPressPoint = null;
        }, 500);
      };
      const onTouchCancel = () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        longPressPoint = null;
      };
      canvas.addEventListener("touchstart", onTouchStart, { passive: true });
      canvas.addEventListener("touchmove", onTouchCancel, { passive: true });
      canvas.addEventListener("touchend", onTouchCancel, { passive: true });
      mbTouchCleanupRef.current = () => {
        canvas.removeEventListener("touchstart", onTouchStart);
        canvas.removeEventListener("touchmove", onTouchCancel);
        canvas.removeEventListener("touchend", onTouchCancel);
        if (longPressTimer) clearTimeout(longPressTimer);
      };

      // Keyboard navigation
      const handleKeydown = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        const PAN_PX = 100;
        switch (e.key) {
          case "Escape":
            if (activeToolRef.current) {
              resetTool();
              break;
            }
            void unspiderfy(map);
            clearMapboxSelectionAndOverlays();
            break;
          case "ArrowLeft":
            e.preventDefault();
            map.panBy([-PAN_PX, 0], { duration: 200 });
            break;
          case "ArrowRight":
            e.preventDefault();
            map.panBy([PAN_PX, 0], { duration: 200 });
            break;
          case "ArrowUp":
            e.preventDefault();
            map.panBy([0, -PAN_PX], { duration: 200 });
            break;
          case "ArrowDown":
            e.preventDefault();
            map.panBy([0, PAN_PX], { duration: 200 });
            break;
          case "=":
          case "+":
            e.preventDefault();
            map.zoomIn({ duration: 200 });
            break;
          case "-":
            e.preventDefault();
            map.zoomOut({ duration: 200 });
            break;
        }
      };
      mbKeydownHandlerRef.current = handleKeydown;
      document.addEventListener("keydown", handleKeydown);

      // Live terrain elevation under the cursor (when 3D terrain is on).
      // Throttled via rAF so we don't call queryTerrainElevation on every pixel.
      let elevRafQueued = false;
      let pendingElevE: { lng: number; lat: number } | null = null;
      const onMapMouseMove = (e: maplibregl.MapMouseEvent) => {
        // Skip during marker drag — setHoverElevationM re-renders Map.tsx each
        // frame and stutters the marker behind the cursor.
        if (isDraggingMarkerRef.current) return;
        pendingElevE = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        if (elevRafQueued) return;
        elevRafQueued = true;
        requestAnimationFrame(() => {
          elevRafQueued = false;
          if (!pendingElevE || !mbMapRef.current) return;
          try {
            // Real MSL meters — users expect the elevation pill to match a topo map,
            // not the rendered terrain's exaggerated value. See queryTerrainElevationMSL.
            const elev = queryTerrainElevationMSL(mbMapRef.current, [pendingElevE.lng, pendingElevE.lat]);
            setHoverElevationM(elev);
          } catch {
            setHoverElevationM(null);
          }
        });
      };
      const onMapMouseOut = () => setHoverElevationM(null);
      map.on("mousemove", onMapMouseMove);
      map.on("mouseout", onMapMouseOut);

      // --- Hover tooltips (desktop only) ---
      const hoverPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "map-hover-tooltip",
      });

      const showTooltip = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties!;
        const nodeId = p.id as string;
        const role = p.role != null ? roleTitles[p.role as NodeRole]?.title ?? "" : "";
        const snr = bestSnr(nodeId, nodesRef.current);
        hoverPopup
          .setLngLat((feature.geometry as any).coordinates)
          .setHTML(
            `<div style="display:flex;align-items:center;gap:4px">` +
            signalBarsHtml(snr) +
            `<strong>${escapeHtml(p.shortname || nodeId)}</strong>` +
            `</div>` +
            (role ? `<span style="opacity:0.6">${role}</span><br/>` : "") +
            `<span style="opacity:0.6">${relativeTime(p.last_seen)}</span>`
          )
          .addTo(map);
      };
      const hideTooltip = () => hoverPopup.remove();

      for (const layerId of ["unclustered-nodes", "plain-nodes", SPIDERFY_LAYER_NODES]) {
        map.on("mouseenter", layerId, showTooltip);
        map.on("mouseleave", layerId, hideTooltip);
      }

      // --- Link hover card ---
      const linkPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "map-link-tooltip",
      });

      const KIND_LABEL: Record<string, string> = {
        neighbor: "Neighbor",
        heard_by: "Heard by",
        both: "Mutual",
        traceroute: "Traceroute",
      };

      const buildLinkPopupHtml = (p: Record<string, unknown>): string => {
        const liveNodes = nodesRef.current;
        const aId = String(p.aId ?? "");
        const bId = String(p.bId ?? "");
        const aShort = liveNodes[aId]?.shortname ?? aId.slice(0, 8);
        const bShort = liveNodes[bId]?.shortname ?? bId.slice(0, 8);
        const kind = String(p.kind ?? "");
        const kindLabel = KIND_LABEL[kind] ?? kind;
        const snrRaw = p.snr;
        const snrStr = typeof snrRaw === "number" && Number.isFinite(snrRaw)
          ? `${snrRaw.toFixed(1)} dB`
          : "—";
        const lastHeardMs = p.lastHeardMs;
        const heardStr = typeof lastHeardMs === "number" && Number.isFinite(lastHeardMs)
          ? relativeTime(new Date(lastHeardMs).toISOString())
          : "—";

        return (
          `<div style="display:flex;align-items:center;gap:6px;font-size:11px">` +
            `<strong>${escapeHtml(aShort)}</strong>` +
            `<span style="opacity:0.6">↔</span>` +
            `<strong>${escapeHtml(bShort)}</strong>` +
          `</div>` +
          `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;font-size:10px;opacity:0.85">` +
            `<span>${escapeHtml(kindLabel)}</span>` +
            `<span>SNR <strong>${snrStr}</strong></span>` +
          `</div>` +
          `<div style="font-size:10px;opacity:0.6;margin-top:2px">${escapeHtml(heardStr)}</div>`
        );
      };

      const showLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        linkPopup
          .setLngLat(e.lngLat)
          .setHTML(buildLinkPopupHtml(f.properties ?? {}))
          .addTo(map);
      };
      const moveLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        linkPopup.setLngLat(e.lngLat).setHTML(buildLinkPopupHtml(f.properties ?? {}));
      };
      const hideLinkPopup = () => linkPopup.remove();

      for (const layerId of ["links-solid", "links-dashed", "links-dotted"]) {
        map.on("mouseenter", layerId, showLinkPopup);
        map.on("mousemove", layerId, moveLinkPopup);
        map.on("mouseleave", layerId, hideLinkPopup);
      }
    };

    map.on("style.load", () => { styleEverLoadedRef.current = true; });
    map.on("style.load", ensureSourcesAndLayers);

    return () => {
      if (mbKeydownHandlerRef.current) {
        document.removeEventListener("keydown", mbKeydownHandlerRef.current);
        mbKeydownHandlerRef.current = null;
      }
      if (mbTouchCleanupRef.current) {
        mbTouchCleanupRef.current();
        mbTouchCleanupRef.current = null;
      }
      if (mbMapRef.current) {
        mbMapRef.current.remove();
        mbMapRef.current = null;
        mbSelectedIdRef.current = null;
        mbHandlersBoundRef.current = false;
        mbCurrentStyleUrlRef.current = null;
      }
      if (coverageRasterUrlRef.current) {
        URL.revokeObjectURL(coverageRasterUrlRef.current);
        coverageRasterUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverNode]);

  // Style switching (re-style, let style.load re-add layers/sources)
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const desired = JSON.stringify({ provider, mapboxStyle, osmBasemap });
    if (mbCurrentStyleUrlRef.current === desired) return;

    try {
      mbCurrentStyleUrlRef.current = desired;

      // Clear selection & overlays to avoid stale feature-state during style swap
      mbSelectedIdRef.current = null;
      setDetailsData(null);
      const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
      linksSource?.setData(emptyLineFeatureCollection());

      map.setStyle(buildMapStyle({ provider, osmBasemap, mapboxToken, mapboxStyle }));
    } catch {}
  }, [mapboxStyle, osmBasemap, provider, mapboxToken]);

  // Cluster toggle
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    applyClusterVisibility(map, clusterEnabled);
  }, [clusterEnabled]);

  // Initial mount is handled by ensureSourcesAndLayers on style.load; this only runs live toggles.
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map || !styleEverLoadedRef.current) return;

    try {
      if (terrain3D) {
        ensureTerrain(map, terrainExaggeration);
      } else {
        removeTerrain(map);
      }
    } catch (err) {
      console.warn("[Map] Terrain apply failed:", err);
    }
  }, [terrain3D, provider, mapboxToken, mapboxStyle, osmBasemap]);

  // Live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const data = buildNodesGeoJSON(nodes, recentDays, { role: roleFilter, channel: channelFilter });

    const clustered = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
    clustered?.setData(data);

    const plain = map.getSource("nodes_plain") as MlGeoJSONSource | undefined;
    plain?.setData(data);

    // If selected node disappears, clear selection + links/panel
    const selectedId = mbSelectedIdRef.current;
    if (selectedId) {
      const stillExists = data.features.some((f) => (f.properties?.id as string | undefined) === selectedId);
      if (!stillExists) {
        try {
          map.setFeatureState({ source: "nodes_clustered", id: selectedId }, { selected: false });
        } catch {}
        try {
          map.setFeatureState({ source: "nodes_plain", id: selectedId }, { selected: false });
        } catch {}

        mbSelectedIdRef.current = null;

        const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
        setDetailsData(null);
      }
    }
  }, [nodes, recentDays, roleFilter, channelFilter]);

  // React to linkMode / myNodeId / nodes changes for persistent links
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    // In "selected" mode, don't override — handleNodeClick manages links
    if (linkMode === "selected" && !mbSelectedIdRef.current) {
      // Clear any lingering persistent links
      try {
        const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
      } catch {}
      return;
    }

    if (linkMode !== "selected") {
      refreshMapboxLinks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkMode, myNodeId, nodes, rawTraceroutes]);

  // ----------------------------
  // Settings panel UI
  // ----------------------------
  const canUseMapbox = hasMapbox;
  const usingMapbox = provider === "mapbox" && canUseMapbox;

  // Flat sorted list of nodes with positions for the My Node picker
  const nodeList = useMemo(
    () =>
      Object.entries(nodes)
        .filter(([, n]) => n.map_position)
        .map(([id, n]) => ({ id, shortname: n.shortname, longname: n.longname }))
        .sort((a, b) => (a.shortname ?? "").localeCompare(b.shortname ?? "")),
    [nodes]
  );

  return (
    <div className="relative w-full h-full min-h-0 overflow-hidden overscroll-none">
      <div id="map" ref={mapRef} className="absolute inset-0" />

      <MapSearchBar
        nodes={nodes}
        onSelect={(id) => handleNodeSelectRef.current(id)}
      />

      <MapHealthWidget nodes={nodes} />

      <MapSettingsPanel
        settingsPanelRef={settingsPanelRef}
        settingsToggleRef={settingsToggleRef}
        settingsPanelOpen={settingsPanelOpen}
        setSettingsPanelOpen={setSettingsPanelOpen}
        openSections={settingsOpenSections}
        setOpenSections={setSettingsOpenSections}
        setProvider={setProvider}
        mapboxStyle={mapboxStyle}
        setMapboxStyle={setMapboxStyle}
        osmBasemap={osmBasemap}
        setOsmBasemap={setOsmBasemap}
        linkMode={linkMode}
        setLinkMode={setLinkMode}
        myNodeId={myNodeId}
        setMyNodeId={setMyNodeId}
        nodeList={nodeList}
        canUseMapbox={canUseMapbox}
        usingMapbox={usingMapbox}
        terrain3D={terrain3D}
        setTerrain3D={setTerrain3D}
        onExport={handleExport}
        hidden={!!detailsData}
        recentDays={recentDays}
        setRecentDays={setRecentDays}
        clusterEnabled={clusterEnabled}
        setClusterEnabled={setClusterEnabled}
        roleFilter={roleFilter}
        setRoleFilter={setRoleFilter}
        channelFilter={channelFilter}
        setChannelFilter={setChannelFilter}
        availableChannels={availableChannels}
        resolveChannelLabel={resolveChannelLabel}
      />

      <FiltersResetPill
        recentDays={recentDays}
        setRecentDays={setRecentDays}
        linkMode={linkMode}
        setLinkMode={setLinkMode}
        roleFilter={roleFilter}
        setRoleFilter={setRoleFilter}
        channelFilter={channelFilter}
        setChannelFilter={setChannelFilter}
        onOpenFilters={() => {
          setSettingsOpenSections((prev) => {
            const next = new Set(prev);
            next.add("filters");
            return next;
          });
          setSettingsPanelOpen(true);
        }}
        hidden={!!detailsData}
      />

      {myNodeLabel && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-1060 px-3 py-1.5 rounded-xl shadow-2xl bg-gray-900/80 backdrop-blur-xl text-sm border border-white/10 flex items-center gap-2">
          <span className="text-gray-400">My Node:</span>
          <span className="font-medium text-gray-200">{myNodeLabel}</span>
          <button
            type="button"
            onClick={() => {
              setMyNodeId("");
              setLinkMode("selected");
            }}
            className="text-gray-500 hover:text-gray-300 transition-colors ml-1"
            aria-label="Clear My Node"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <MapDetailsPanel
        data={detailsData}
        onClose={clearMapboxSelectionAndOverlays}
        onNodeSelect={(id) => handleNodeSelectRef.current(id)}
        onHoverLink={(id) => handleLinkHoverRef.current(id)}
      />

      {/* Live terrain elevation under the cursor — helps sanity-check coverage
          paints. Only renders when 3D terrain is on and we got a valid sample. */}
      {terrain3D && hoverElevationM != null && (
        <div className="fixed top-3 left-120 sm:left-135 z-30 px-2.5 py-1 rounded-full text-[11px] font-medium border border-white/10 bg-gray-900/80 backdrop-blur-xl text-gray-300 shadow-2xl pointer-events-none select-none flex items-center gap-1.5">
          <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21l6-6 4 4 8-8" />
          </svg>
          <span className="tabular-nums">{Math.round(hoverElevationM)} m</span>
          <span className="text-gray-600 text-[9px] uppercase tracking-wider">elev</span>
        </div>
      )}

      {/* Tools drawer — global, top-left next to search */}
      <MapToolsDrawer
        activeTool={activeTool}
        onSelect={(tool) => {
          resetTool();
          if (tool) {
            setActiveTool(tool);
            setToolStep("pickFrom");
          }
        }}
        terrainEnabled={terrain3D}
        onRequestTerrainSetup={() => {
          setSettingsOpenSections((prev) => {
            const next = new Set(prev);
            next.add("terrain");
            return next;
          });
          setSettingsPanelOpen(true);
        }}
      />

      {/* Tool prompts — guide the user through picks */}
      {activeTool && toolStep === "pickFrom" && (
        <MapToolPrompt
          message={
            activeTool === "coverage"
              ? "Click a node (or click anywhere on the map for a virtual location)"
              : activeTool === "scan"
                ? "Scan: pick an origin (or click anywhere for a virtual location)"
                : activeTool === "los"
                  ? "LOS: pick the first node"
                  : "Traceroute: pick the first node"
          }
          hint="Press Esc to cancel"
          onCancel={resetTool}
        />
      )}
      {activeTool && toolStep === "pickTo" && (
        <MapToolPrompt
          message={
            activeTool === "los"
              ? "LOS: pick the second node"
              : "Traceroute: pick the second node"
          }
          hint="Press Esc to cancel"
          onCancel={resetTool}
        />
      )}

      {/* Floating LoS panel when LOS tool reached result step */}
      {activeTool === "los" && toolStep === "result" && (toolFromId || losVirtualFrom) && (toolToId || losVirtualTo) && (
        <MapLosPanel
          result={losResult}
          fromLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8))
              : losVirtualFrom
                ? `${losVirtualFrom[1].toFixed(5)}, ${losVirtualFrom[0].toFixed(5)}`
                : ""
          }
          toLabel={
            toolToId
              ? ((nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8))
              : losVirtualTo
                ? `${losVirtualTo[1].toFixed(5)}, ${losVirtualTo[0].toFixed(5)}`
                : ""
          }
          fromColor="#06b6d4"
          toColor="#d946ef"
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={resetTool}
          isComputing={terrain3D && !losResult}
          fromHwIdx={losFromHwIdx} onFromHwIdxChange={setLosFromHwIdx}
          fromAntIdx={losFromAntIdx} onFromAntIdxChange={setLosFromAntIdx}
          fromHeightM={losFromHeightM} onFromHeightChange={setLosFromHeightM}
          toHwIdx={losToHwIdx} onToHwIdxChange={setLosToHwIdx}
          toAntIdx={losToAntIdx} onToAntIdxChange={setLosToAntIdx}
          toHeightM={losToHeightM} onToHeightChange={setLosToHeightM}
          demSource={losDemSource}
          onProfileHover={handleLosProfileHover}
        />
      )}

      {/* Floating Coverage panel */}
      {activeTool === "coverage" && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <MapCoveragePanel
          result={coverageResult}
          originLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8))
              : toolVirtualPos
                ? `${toolVirtualPos[1].toFixed(5)}, ${toolVirtualPos[0].toFixed(5)}`
                : ""
          }
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={resetTool}
          isComputing={isComputingCoverage}
          isFetchingTerrain={isFetchingCoverageTerrain}
          progressCompleted={coverageProgress.completed}
          progressTotal={coverageProgress.total}
          demSource={coverageDemSource}
          errorMessage={coverageError}
          onRetry={() => {
            setCoverageError(null);
            setCoverageRetryNonce((n) => n + 1);
          }}
          onCancel={() => {
            // Kill the live pool so any in-flight ITM ray-marches stop
            // burning CPU. Bump the requestId so anything that already
            // completed gets filtered as stale. Next compute recreates
            // the pool via ensureCoveragePool() on demand.
            coveragePoolRef.current?.terminate();
            coveragePoolRef.current = null;
            coverageRequestIdRef.current += 1;
            setIsComputingCoverage(false);
            setIsFetchingCoverageTerrain(false);
            setCoverageProgress({ completed: 0, total: 0 });
          }}
          rxHardwareIdx={coverageRxHardwareIdx}
          onRxHardwareIdxChange={setCoverageRxHardwareIdx}
          rxAntennaIdx={coverageRxAntennaIdx}
          onRxAntennaIdxChange={setCoverageRxAntennaIdx}
          rxHeightM={coverageRxHeightM}
          onRxHeightChange={setCoverageRxHeightM}
          antennaIdx={coverageAntennaIdx}
          onAntennaIdxChange={setCoverageAntennaIdx}
          hardwareIdx={coverageHardwareIdx}
          onHardwareIdxChange={setCoverageHardwareIdx}
          customTxDbm={coverageCustomTxDbm}
          onCustomTxDbmChange={setCoverageCustomTxDbm}
          envIdx={coverageEnvIdx}
          onEnvIdxChange={setCoverageEnvIdx}
          presetIdx={coveragePresetIdx}
          onPresetIdxChange={setCoveragePresetIdx}
          customSensitivityDbm={coverageCustomSensDbm}
          onCustomSensitivityChange={setCoverageCustomSensDbm}
          detail={coverageDetail}
          onDetailChange={setCoverageDetail}
          antennaHeightM={coverageAntennaHeightM}
          onAntennaHeightChange={setCoverageAntennaHeightM}
          reliability={coverageReliability}
          onReliabilityChange={setCoverageReliability}
          showContours={showCoverageContours}
          onShowContoursChange={setShowCoverageContours}
          showRays={showCoverageRays}
          onShowRaysChange={setShowCoverageRays}
          onExport={handleCoverageExport}
          onOriginChange={(lngLat) => {
            // Typing a custom coord always detaches from any node anchor
            // and places a virtual pin. Mirrors the marker dragend path so
            // the existing recompute pipeline picks it up.
            setToolFromId(null);
            setToolVirtualPos(lngLat);
            mbMapRef.current?.easeTo({ center: lngLat, duration: 600 });
          }}
        />
      )}

      {/* Floating Traceroute panel */}
      {activeTool === "traceroute" && toolStep === "result" && toolFromId && toolToId && (
        <MapTraceroutePanel
          fromId={toolFromId}
          toId={toolToId}
          fromLabel={(nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8)}
          toLabel={(nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8)}
          fromColor="#06b6d4"
          toColor="#d946ef"
          traceroutes={rawTraceroutes}
          liveNodes={nodes}
          onNodeSelect={(id) => handleNodeSelectRef.current(id)}
          onHoverLink={(id) => handleLinkHoverRef.current(id)}
          onClose={resetTool}
        />
      )}

      {/* Floating Scan panel */}
      {activeTool === "scan" && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <MapScanPanel
          summary={scanSummary}
          originLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8))
              : "Virtual location"
          }
          isScanning={isScanning}
          demSource={scanDemSource}
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={resetTool}
          onSelectResult={(id) => {
            // Fly to the target, then open its details panel.
            const n = nodes[id] ?? nodes[`!${id}`];
            const mb = mbMapRef.current;
            if (n?.map_position && mb) {
              mb.easeTo({
                center: [n.map_position[0], n.map_position[1]],
                zoom: Math.max(mb.getZoom(), 13),
                duration: 800,
              });
            }
            handleNodeSelectRef.current(id);
          }}
          onHoverResult={(id) => setScanHoverId(id)}
          onReturnToOrigin={() => {
            const mapNow = mbMapRef.current;
            const view = scanInitialViewRef.current;
            if (!mapNow || !view) return;
            mapNow.easeTo({
              center: view.center,
              zoom: view.zoom,
              pitch: view.pitch,
              bearing: view.bearing,
              duration: 800,
            });
          }}
          hiddenClasses={hiddenScanClasses}
          onToggleClassVisibility={(cls) =>
            setHiddenScanClasses((prev) => {
              const next = new Set(prev);
              if (next.has(cls)) next.delete(cls);
              else next.add(cls);
              return next;
            })
          }
          antennaIdx={scanAntennaIdx}
          onAntennaIdxChange={setScanAntennaIdx}
          hardwareIdx={scanHardwareIdx}
          onHardwareIdxChange={setScanHardwareIdx}
          antennaHeightM={scanAntennaHeightM}
          onAntennaHeightChange={setScanAntennaHeightM}
          rxHardwareIdx={scanRxHardwareIdx}
          onRxHardwareIdxChange={setScanRxHardwareIdx}
          rxAntennaIdx={scanRxAntennaIdx}
          onRxAntennaIdxChange={setScanRxAntennaIdx}
          customTxDbm={scanCustomTxDbm}
          onCustomTxDbmChange={setScanCustomTxDbm}
          envIdx={scanEnvIdx}
          onEnvIdxChange={setScanEnvIdx}
          presetIdx={scanPresetIdx}
          onPresetIdxChange={setScanPresetIdx}
          customSensitivityDbm={scanCustomSensDbm}
          onCustomSensitivityChange={setScanCustomSensDbm}
        />
      )}

      <style>
        {`
          #map { position: absolute; inset: 0; }
        `}
      </style>
    </div>
  );
}
