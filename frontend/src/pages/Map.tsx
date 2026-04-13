import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, {
  GeoJSONSource as MbGeoJSONSource,
  Map as MbMap,
} from "mapbox-gl";
import { Feature, Map as OlMap, Overlay, View } from "ol";
import { Coordinate } from "ol/coordinate";
import { click } from "ol/events/condition";
import { LineString, Polygon } from "ol/geom";
import Point from "ol/geom/Point";
import Select from "ol/interaction/Select";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transform } from "ol/proj";
import { Vector } from "ol/source";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { NodeRole, roleTitles, type ITraceroutesResponse } from "../types";
import { env } from "../env";
import { createBaseTileLayer, type OsmBasemap } from "../maps/baseLayer";
import { reverseGeocode } from "../maps/geocoder";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { buildAllLinksFeatureCollection, buildMapboxLinkFeatureCollection, buildTracerouteLinkFeatureCollection, computeHeardByIds, normNodeId } from "./map/linkFeatures";
import { COMMON_HARDWARE, effectiveSensitivityDbm, ENVIRONMENTS, MESHTASTIC_PRESETS, type CoverageResult } from "./map/coverageAnalysis";
import { demBoundsAround, downsampleDEM, sampleDEMAt, type DEM, type DEMBounds } from "./map/terrainDEM";
import { buildDemFromTerrainRgb } from "./map/terrainRgb";
import { CoverageWorkerPool } from "./map/coverageWorkerPool";
import type { CoverageSliceRequest } from "./map/coverageSliceWorker";
import type { RasterParams } from "./map/coverageRaster";
import { extractCoverageContours, type ContourFeatureCollection } from "./map/coverageContours";
import { analyzeLineOfSight, type LoSResult } from "./map/losAnalysis";
import { Climate, computeP2PLoss, Polarization } from "./map/itm";
import { LosTubeLayer, losPointsToTubeData, obstructionsToGeoJSON, pickObstructions } from "./map/losTubeLayer";
import { runScan, scanToGeoJSON, type ScanSummary, type ScanTarget } from "./map/scanAnalysis";
import { MapScanPanel } from "./map/MapScanPanel";
import { findPathsBetween } from "./map/pathAnalysis";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapHealthWidget } from "./map/MapHealthWidget";
import { MapLosPanel } from "./map/MapLosPanel";
import { MapToolPrompt, MapToolsDrawer } from "./map/MapToolsDrawer";
import { MapTraceroutePanel } from "./map/MapTraceroutePanel";
import { COVERAGE_DETAIL_SIZE, type CoverageDetail, MapCoveragePanel } from "./map/MapCoveragePanel";
import { MapQuickControls } from "./map/MapQuickControls";
import { MapSearchBar } from "./map/MapSearchBar";
import { MapSettingsPanel } from "./map/MapSettingsPanel";
import { LS_KEYS, readJson, toMapboxStyleUrl, writeJson } from "./map/storage";
import type { IFeatureNode, IMapNode, LinkMode, MapProvider, NodeDetailsData, NodeLike } from "./map/types";
import {
  autoSpiderfyVisibleClusters,
  removeSpiderfyLayers,
  spiderfy,
  unspiderfy,
  updateSpiderfyPositions,
  SPIDERFY_LAYER_NODES,
  SPIDERFY_LAYER_LABELS,
  SPIDERFY_SOURCE_NODES,
} from "./map/spiderfy";
import {
  autoOlSpiderfy,
  createOlClusterLayer,
  handleOlClusterClick,
  removeOlSpiderfy,
  updateOlSpiderfyPositions,
  type OlClusterSetup,
} from "./map/spiderfy-ol";
import {
  applyMapboxClusterVisibility,
  buildNodesGeoJSON,
  bumpOlRender,
  calculateGeodesicDistance,
  computeRecentNodes,
  DEFAULT_NODE_COLOR,
  emptyLineFeatureCollection,
  escapeHtml,
  OFFLINE_NODE_COLOR,
  ROLE_COLORS,
} from "./map/utils";

// 1×1 fully transparent PNG — used as the placeholder image for the
// coverage-raster source before a real result is computed.
const TRANSPARENT_1PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// --------------------
// SNR → color/width helpers (shared by OL link styles)
// --------------------
function snrToOlColor(snr: number | null | undefined, kind: string): string {
  if (kind === "traceroute") return "#F59E0B";
  if (snr == null) {
    return kind === "both" ? "#FF66FF" : kind === "heard_by" ? "#6666FF" : "#66FF66";
  }
  if (snr >= 10) return "#44CC44";
  if (snr >= 5) return "#88DD00";
  if (snr >= 0) return "#FFAA00";
  if (snr >= -5) return "#FF6644";
  return "#FF4444";
}

function snrToOlWidth(snr: number | null | undefined): number {
  if (snr == null) return 3;
  return Math.max(1.5, Math.min(9, 3 + snr * 0.4));
}

// ---------------------
// Tooltip helpers
// ---------------------
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

/** SVG signal bars (1-4) colored by best SNR. Returns inline SVG string. */
function signalBarsHtml(snr: number | null): string {
  // Map SNR to 1–4 bars
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

/** Get the best (max) SNR from a node's neighbors. */
function bestSnr(nodeId: string, nodes: Record<string, IMapNode>): number | null {
  const node = nodes[nodeId];
  if (!node?.neighbors?.length) return null;
  let max = -Infinity;
  for (const n of node.neighbors) {
    if (n.snr > max) max = n.snr;
  }
  return max === -Infinity ? null : max;
}

// ---------------------
// Geodesic circle for coverage radius
// ---------------------
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

/**
 * Compute max observed range (km) for a node using ALL connections:
 * neighbors, heard-by, and traceroute peers.
 */
function computeMaxRange(
  nodeId: string,
  nodePos: [number, number], // [lon, lat]
  liveNodes: Record<string, IMapNode>,
  heardBy: string[],
  traceroutes: ITraceroutesResponse[],
): number | null {
  const connectedIds = new Set<string>();

  // Neighbors this node reports
  const node = liveNodes[nodeId];
  for (const n of node?.neighbors ?? []) connectedIds.add(n.id);

  // Nodes that hear this node
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
  return maxDist > 0.05 ? maxDist : null; // skip tiny circles (< 50m)
}

// Mapbox expression: role-based node color (offline nodes stay gray)
const mbRoleColorExpr = [
  "case",
  ["!", ["boolean", ["get", "online"], false]],
  OFFLINE_NODE_COLOR,
  ["match", ["get", "role"],
    ...Object.entries(ROLE_COLORS).flatMap(([k, v]) => [Number(k), v]),
    DEFAULT_NODE_COLOR, // fallback
  ],
] as any;

// --------------------
// OpenLayers styles
// --------------------
const defaultStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "rgba(0, 0, 240, 1)" }),
    stroke: new Stroke({ color: "white", width: 2 }),
  }),
});

const offlineStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "rgba(0, 0, 0, 0.50)" }),
    stroke: new Stroke({ color: "white", width: 2 }),
  }),
});

// Cache OL styles per role to avoid creating new objects every render
const olRoleStyleCache: Record<string, Style[]> = {};

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function getOlNodeStyle(online: boolean, role?: number | null): Style | Style[] {
  if (!online) return offlineStyle;
  const color = (role != null && ROLE_COLORS[role]) || DEFAULT_NODE_COLOR;
  let cached = olRoleStyleCache[color];
  if (!cached) {
    const pulseStyle = new Style({
      image: new Circle({ radius: 12, fill: new Fill({ color: hexToRgba(color, 0.25) }) }),
    });
    const nodeStyle = new Style({
      image: new Circle({
        radius: 6,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: "white", width: 2 }),
      }),
    });
    cached = [pulseStyle, nodeStyle];
    olRoleStyleCache[color] = cached;
  }
  return cached;
}

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  // Settings panel refs (panel + toggle button)
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  // OL map state (OSM path)
  const [olMap, setOlMap] = useState<OlMap>();
  const olBaseLayerRef = useRef<ReturnType<typeof createBaseTileLayer> | null>(null);
  const olNodesSourceRef = useRef<VectorSource<Feature<Point>> | null>(null);
  const olClusterSetupRef = useRef<OlClusterSetup | null>(null);
  const olPersistentLinksLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);
  /**
   * JSON signature of the last persistent-links payload pushed to Mapbox / OL.
   * We skip `setData`/layer rebuild when the computed GeoJSON is byte-identical
   * to avoid thrashing map tiles on every 5s API poll when nothing relevant
   * to links has actually changed. JSON.stringify is O(n) but far cheaper than
   * Mapbox re-tiling or OL re-tessellating line features.
   */
  const persistentLinksMbJsonRef = useRef<string>("");
  const persistentLinksOlJsonRef = useRef<string>("");
  const olHighlightLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);
  const olCoverageLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);
  const olPathLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);

  // Mapbox refs (Mapbox path)
  const mbMapRef = useRef<MbMap | null>(null);
  const mbSelectedIdRef = useRef<string | null>(null);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);
  const mbKeydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  /** Cleanup function for the Mapbox canvas touch-listener trio. */
  const mbTouchCleanupRef = useRef<(() => void) | null>(null);

  // Shared ref for panel node-select callback (set by whichever provider is active)
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

  // ----- env capabilities
  const mapboxToken = env.MAPBOX_TOKEN;
  const hasMapbox = Boolean(mapboxToken);

  // ----- UI settings persistence
  const [provider, setProvider] = useState<MapProvider>(() => {
    const stored = readJson<MapProvider | null>(LS_KEYS.provider, null);
    if (stored) return stored === "mapbox" && !hasMapbox ? "osm" : stored;

    // First-time visitors: always default to OSM
    return "osm";
  });

  const [mapboxStyle, setMapboxStyle] = useState<string>(() => {
    const stored = readJson<string | null>(LS_KEYS.mapboxStyle, null);
    return (
      stored ??
      env.MAPBOX_STYLE ??
      "mapbox/dark-v11"
    );
  });

  const [osmBasemap, setOsmBasemap] = useState<OsmBasemap>(() => {
    const stored = readJson<OsmBasemap | null>(LS_KEYS.osmBasemap, null);
    return stored ?? "carto_dark"; // first-time = dark
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
  // ---------------------
  // Global tool state — tools are independent of the details panel.
  // Each tool drives its own step-based workflow.
  // ---------------------
  const [activeTool, setActiveTool] = useState<"los" | "traceroute" | "coverage" | "scan" | null>(null);
  const [toolStep, setToolStep] = useState<"pickFrom" | "pickTo" | "result">("pickFrom");
  const [toolFromId, setToolFromId] = useState<string | null>(null);
  const [toolToId, setToolToId] = useState<string | null>(null);
  const [toolVirtualPos, setToolVirtualPos] = useState<[number, number] | null>(null);

  // 3D terrain (Mapbox only)
  const [terrain3D, setTerrain3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.terrain3D, false));
  const [terrainExaggeration, setTerrainExaggeration] = useState<number>(
    () => readJson<number>(LS_KEYS.terrainExaggeration, 1.5)
  );
  const [losResult, setLosResult] = useState<LoSResult | null>(null);
  const [coverageResult, setCoverageResult] = useState<CoverageResult | null>(null);
  const [isComputingCoverage, setIsComputingCoverage] = useState(false);
  const [coverageAntennaDbi, setCoverageAntennaDbi] = useState(3);
  const [coverageHardwareIdx, setCoverageHardwareIdx] = useState(0);
  const [coverageCustomTxDbm, setCoverageCustomTxDbm] = useState(22);
  const coverageTxDbm = COMMON_HARDWARE[coverageHardwareIdx].isCustom
    ? coverageCustomTxDbm
    : COMMON_HARDWARE[coverageHardwareIdx].txDbm;
  const [coverageEnvIdx, setCoverageEnvIdx] = useState(0);
  const [coveragePresetIdx, setCoveragePresetIdx] = useState(1); // LongFast default
  const [coverageCustomSensDbm, setCoverageCustomSensDbm] = useState(-133);
  const coverageSensitivityDbm = MESHTASTIC_PRESETS[coveragePresetIdx].isCustom
    ? coverageCustomSensDbm
    : MESHTASTIC_PRESETS[coveragePresetIdx].sensitivityDbm;
  /**
   * Coverage detail level — controls DEM resolution. "standard" (512²) is the
   * default; "high" (768²) and "ultra" (1024²) trade compute time for
   * sharper edges. Session-scoped (not persisted to localStorage).
   */
  const [coverageDetail, setCoverageDetail] = useState<CoverageDetail>("standard");
  /**
   * Analysis radius derived purely from the link-budget math (capped at
   * 500 km beyond which the DEM resolution can't produce meaningful
   * terrain-aware results). No manual override — keeping the derived
   * value keeps the coverage panel simpler and the behavior honest.
   */
  /** Chipset-corrected RX sensitivity actually used in calcs. */
  const coverageEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[coverageHardwareIdx];
    return effectiveSensitivityDbm(coverageSensitivityDbm, hw.chipset);
  }, [coverageSensitivityDbm, coverageHardwareIdx]);
  /**
   * DEM/raster size radius — derived from a simple free-space budget
   * just so the analysis area scales with hardware. Not shown to users
   * and not used for painting (ITM handles that). Capped at 500 km
   * because DEM resolution beyond that is too coarse to be meaningful.
   */
  const coverageRadiusKm = useMemo(() => {
    const CABLE = 0.5;
    const FADE = 15;
    const budget =
      coverageTxDbm +
      2 * coverageAntennaDbi -
      coverageEffectiveSensitivityDbm -
      FADE -
      CABLE;
    const plConstant = 32.45 + 20 * Math.log10(915);
    const maxKm = Math.pow(10, (budget - plConstant) / 20);
    return Math.max(5, Math.min(500, Math.round(maxKm)));
  }, [coverageAntennaDbi, coverageTxDbm, coverageEffectiveSensitivityDbm]);
  /** Custom WebGL layer instance for the 3D LoS tube. Created once per map. */
  const losTubeLayerRef = useRef<LosTubeLayer | null>(null);
  /** DOM-based pin for the Coverage tool's origin (draggable-capable). */
  const coverageOriginMarkerRef = useRef<mapboxgl.Marker | null>(null);
  /** Terrain elevation under the cursor (meters MSL). Null when unavailable. */
  const [hoverElevationM, setHoverElevationM] = useState<number | null>(null);
  // Scan tool state
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanHoverId, setScanHoverId] = useState<string | null>(null);
  /** Monotonic request id — ignore worker replies that aren't the latest. */
  const coverageRequestIdRef = useRef(0);
  /**
   * Worker pool for parallel coverage compute. Lazily created on first
   * use, kept warm across re-computes. Terminated on unmount.
   */
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

  /**
   * Cached authoritative DEM from the most recent coverage compute.
   * Used so the drag-preview pass can skip the tile-fetch step and reuse
   * the already-built terrain data.
   */
  const coverageDemRef = useRef<DEM | null>(null);
  /**
   * Downsampled version of the above (256×256 regardless of the main
   * detail setting). Lets the drag preview run LR at ~8-12fps by cutting
   * the per-frame pixel count by 4–16×.
   */
  const coverageDragDemRef = useRef<DEM | null>(null);
  /**
   * Most recent raster params snapshot — drag preview reuses these
   * untouched. Updated at the end of every full compute.
   */
  const coverageLastRasterParamsRef = useRef<RasterParams | null>(null);
  /**
   * Last-known origin height resolution (height + isFallback) from the
   * most recent full compute. Drag re-samples DEM per move, but uses
   * the last params for frequency/power/etc.
   */
  const coverageLastOriginContextRef = useRef<{ bounds: DEMBounds } | null>(null);
  /**
   * "Busy" flag for drag-preview dispatches — we only allow one
   * preview compute in flight at a time, and remember the latest
   * position so we can re-fire once the previous completes.
   */
  const dragPreviewBusyRef = useRef(false);
  const dragPreviewPendingRef = useRef<[number, number] | null>(null);

  /**
   * Cached GeoJSON of the latest contour extraction. Kept so the panel
   * can hand it off directly to the Export button without recomputing.
   */
  const coverageContoursRef = useRef<ContourFeatureCollection | null>(null);
  /** Cached margin grid from the last full compute — for ad-hoc export. */
  const coverageMarginRef = useRef<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: DEMBounds;
  } | null>(null);
  /** Whether contours are visible on the map. Session-scoped toggle. */
  const [showCoverageContours, setShowCoverageContours] = useState(false);

  /**
   * Export the most recent coverage compute as either GeoJSON or KML.
   * Both formats contain the iso-margin contour polylines (0 / 10 / 20 dB)
   * plus the origin + link-budget metadata. GeoJSON for QGIS, Leaflet,
   * geojson.io; KML for Google Earth, SPLAT!, and similar RF tools.
   */
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
          antennaDbi: result.antennaDbi,
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
      // KML builder. Color format is aabbggrr (alpha, then B, G, R —
      // byte-reversed from CSS hex). Amber #f59e0b → ff0b9ef5, etc.
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
        `TX: ${result.txDbm} dBm, antenna ${result.antennaDbi} dBi`,
        `RX sensitivity: ${result.rxSensitivityDbm} dBm`,
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
      <description><![CDATA[${esc(`${Math.round(result.originHeightM)} m MSL · TX ${result.txDbm} dBm · ${result.antennaDbi} dBi`)}]]></description>
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

  /** Tracks the latest coverage result for export (refs can read it). */
  const coverageResultRef = useRef<CoverageResult | null>(null);
  useEffect(() => {
    coverageResultRef.current = coverageResult;
  }, [coverageResult]);

  /**
   * Shared helper: run the pool over a DEM, stitch the slice responses,
   * and paint the resulting RGBA to the Mapbox `coverage-raster` image
   * source. Used by BOTH the main (authoritative) compute and the
   * drag-preview path; only the DEM size + request id differ.
   *
   * Returns null if the request was superseded by a newer one or the
   * WASM isn't available. Returns summary counts on success.
   */
  const renderCoverageToImageSource = useCallback(async (opts: {
    dem: DEM;
    origin: [number, number];
    originHeightM: number;
    params: RasterParams;
    requestId: number;
  }): Promise<{
    clearCount: number;
    fresnelCount: number;
    blockedCount: number;
    demCoveredPixels: number;
    totalPx: number;
    /** Stitched full-grid margin array (dB). NaN for no-data pixels. */
    marginDb: Float32Array;
    itmUnavailable?: boolean;
  } | null> => {
    const { dem, origin, originHeightM, params, requestId } = opts;
    const mb = mbMapRef.current;
    if (!mb) return null;
    const pool = ensureCoveragePool();
    const poolSize = pool.size;
    const rowsPerTask = Math.ceil(dem.height / poolSize);

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

    for (let i = 0; i < poolSize; i++) {
      const rowStart = i * rowsPerTask;
      if (rowStart >= dem.height) break;
      const rowEnd = Math.min(rowStart + rowsPerTask, dem.height);
      const demCopy = new Float32Array(dem.data);
      const req: CoverageSliceRequest = {
        requestId,
        demBuffer: demCopy.buffer,
        demWidth: dem.width,
        demHeight: dem.height,
        bounds: dem.bounds,
        origin,
        originHeightM,
        params,
        rowStart,
        rowEnd,
      };
      tasks.push(
        pool.dispatch(req, [demCopy.buffer]).then((resp) => {
          sliceResponses.push(resp);
        }),
      );
    }
    await Promise.all(tasks);

    // Stale-request check: if a newer request has started (or the
    // drag-preview counter overtook us), bail without painting.
    if (requestId !== coverageRequestIdRef.current) return null;

    if (sliceResponses.some((r) => r.itmUnavailable)) {
      const nanMargin = new Float32Array(dem.width * dem.height);
      nanMargin.fill(Number.NaN);
      return {
        clearCount: 0, fresnelCount: 0, blockedCount: 0,
        demCoveredPixels: 0, totalPx: dem.width * dem.height,
        marginDb: nanMargin,
        itmUnavailable: true,
      };
    }

    const fullRgba = new Uint8ClampedArray(dem.width * dem.height * 4);
    const fullMargin = new Float32Array(dem.width * dem.height);
    let clearCount = 0;
    let fresnelCount = 0;
    let blockedCount = 0;
    for (const s of sliceResponses) {
      fullRgba.set(s.rgba, s.rowStart * dem.width * 4);
      fullMargin.set(s.marginDb, s.rowStart * dem.width);
      clearCount += s.clearCount;
      fresnelCount += s.fresnelCount;
      blockedCount += s.blockedCount;
    }
    const demCoveredPixels = clearCount + fresnelCount + blockedCount;

    // Encode via a data URL and push to the image source. For small
    // grids (256–1024²) toDataURL is ≈ 3–40 ms and not worth optimizing.
    const canvas = document.createElement("canvas");
    canvas.width = dem.width;
    canvas.height = dem.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imgData = new ImageData(
      fullRgba as Uint8ClampedArray<ArrayBuffer>,
      dem.width,
      dem.height,
    );
    ctx.putImageData(imgData, 0, 0);
    const url = canvas.toDataURL("image/png");

    const src = mb.getSource("coverage-raster") as mapboxgl.ImageSource | undefined;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [dem.bounds.west, dem.bounds.north],
      [dem.bounds.east, dem.bounds.north],
      [dem.bounds.east, dem.bounds.south],
      [dem.bounds.west, dem.bounds.south],
    ];
    if (src && typeof (src as unknown as { updateImage?: Function }).updateImage === "function") {
      (src as unknown as { updateImage: (o: { url: string; coordinates: typeof coords }) => void }).updateImage({ url, coordinates: coords });
    }
    if (mb.getLayer("coverage-raster")) {
      mb.setLayoutProperty("coverage-raster", "visibility", "visible");
    }

    return {
      clearCount,
      fresnelCount,
      blockedCount,
      demCoveredPixels,
      totalPx: dem.width * dem.height,
      marginDb: fullMargin,
    };
  }, [ensureCoveragePool]);

  // Settings panel visibility
  const [settingsPanelOpen, setSettingsPanelOpen] = useState<boolean>(() => {
    const stored = readJson<boolean | null>(LS_KEYS.settingsPanelOpen, null);
    // Default to false on mobile, true on desktop
    return stored ?? (typeof window !== "undefined" && window.innerWidth >= 1024);
  });

  // persist settings
  useEffect(() => writeJson(LS_KEYS.provider, provider), [provider]);
  useEffect(() => writeJson(LS_KEYS.mapboxStyle, mapboxStyle), [mapboxStyle]);
  useEffect(() => writeJson(LS_KEYS.osmBasemap, osmBasemap), [osmBasemap]);
  useEffect(() => writeJson(LS_KEYS.recentDays, recentDays), [recentDays]);
  useEffect(() => writeJson(LS_KEYS.clusterEnabled, clusterEnabled), [clusterEnabled]);
  useEffect(() => writeJson(LS_KEYS.linkMode, linkMode), [linkMode]);
  useEffect(() => writeJson(LS_KEYS.myNodeId, myNodeId), [myNodeId]);
  useEffect(() => writeJson(LS_KEYS.settingsPanelOpen, settingsPanelOpen), [settingsPanelOpen]);
  useEffect(() => writeJson(LS_KEYS.terrain3D, terrain3D), [terrain3D]);
  useEffect(() => writeJson(LS_KEYS.terrainExaggeration, terrainExaggeration), [terrainExaggeration]);

  // If token disappears / not configured, force provider to osm
  useEffect(() => {
    if (provider === "mapbox" && !hasMapbox) setProvider("osm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMapbox]);

  // Close settings panel when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;

      // allow clicks inside the panel OR on the toggle button
      if (settingsPanelRef.current?.contains(target)) return;
      if (settingsToggleRef.current?.contains(target)) return;

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

  // Close settings panel on Escape
  useEffect(() => {
    if (!settingsPanelOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsPanelOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsPanelOpen]);

  // ----------------------------
  // Nodes normalization
  // ----------------------------
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
                ] as Coordinate)
              : undefined,
          neighbors: node.neighborinfo?.neighbors?.map((neighbor) => ({
            id: convertNodeIdFromIntToHex(neighbor.node_id),
            snr: neighbor.snr,
            distance: neighbor.distance ?? 0,
          })),
        },
      ])
    );
  }, [rawNodes]);

  const serverNode = useMemo(
    () => nodes[config?.server?.node_id ?? ""],
    [config?.server?.node_id, nodes]
  );

  // Available channels for filter cycling
  const availableChannels = useMemo(() => {
    const chSet = new Set<string>();
    for (const n of Object.values(rawNodes)) {
      if (n.last_channel) chSet.add(n.last_channel);
    }
    return [...chSet].sort();
  }, [rawNodes]);

  // ----------------------------
  // Details panel state (React-driven)
  // ----------------------------
  const [detailsData, setDetailsData] = useState<NodeDetailsData | null>(null);

  // ----------------------------
  // Refs to avoid stale closures (Mapbox handlers)
  // ----------------------------
  const nodesRef = useRef(nodes);
  const traceroutesRef = useRef(rawTraceroutes);
  const configRef = useRef(config);
  const recentDaysRef = useRef(recentDays);
  const clusterEnabledRef = useRef(clusterEnabled);
  const linkModeRef = useRef(linkMode);
  const myNodeIdRef = useRef(myNodeId);
  const roleFilterRef = useRef(roleFilter);
  const channelFilterRef = useRef(channelFilter);
  // Tool state refs — used in event handler closures
  const activeToolRef = useRef(activeTool);
  const toolStepRef = useRef(toolStep);
  const toolFromIdRef = useRef(toolFromId);

  // Helper: is the tool currently waiting for a node click?
  const isPickingNode = activeTool != null && toolStep !== "result";
  const terrain3DRef = useRef(terrain3D);
  const terrainExaggerationRef = useRef(terrainExaggeration);
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
    terrainExaggerationRef.current = terrainExaggeration;
  }, [terrainExaggeration]);

  // Tool-pick cursor feedback
  useEffect(() => {
    const mb = mbMapRef.current;
    if (mb) {
      mb.getCanvas().style.cursor = isPickingNode ? "crosshair" : "";
    }
    if (olMap) {
      const el = olMap.getTargetElement();
      if (el) el.style.cursor = isPickingNode ? "crosshair" : "";
    }
  }, [isPickingNode, olMap]);

  // Reset the whole tool state. Also imperatively clears map visual geometry
  // so there's no one-tick flash of stale tubes / rasters / scan lines while
  // React re-runs the dependent effects.
  const resetTool = () => {
    setActiveTool(null);
    setToolStep("pickFrom");
    setToolFromId(null);
    setToolToId(null);
    setToolVirtualPos(null);
    setLosResult(null);
    setCoverageResult(null);
    setScanSummary(null);
    setIsComputingCoverage(false);
    setIsScanning(false);

    const mb = mbMapRef.current;
    if (mb) {
      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
      try {
        (mb.getSource("los-obstructions") as MbGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("scan-links") as MbGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("path-analysis") as MbGeoJSONSource | undefined)?.setData(empty);
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
        (mb.getSource("coverage-contours") as MbGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      losTubeLayerRef.current?.setData(null);
      coverageContoursRef.current = null;
      coverageMarginRef.current = null;
    }

    if (olMap) {
      if (olPathLayerRef.current) {
        olMap.removeLayer(olPathLayerRef.current);
        olPathLayerRef.current = null;
      }
    }
  };

  // Draw shortest traceroute path between toolFromId and toolToId (both providers)
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

    // Mapbox path-analysis source
    const mb = mbMapRef.current;
    if (mb) {
      const src = mb.getSource("path-analysis") as MbGeoJSONSource | undefined;
      if (src) {
        const coords = computePathCoords();
        src.setData(
          coords
            ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] }
            : { type: "FeatureCollection", features: [] },
        );
      }
    }

    // OpenLayers path layer
    if (olMap) {
      if (olPathLayerRef.current) {
        olMap.removeLayer(olPathLayerRef.current);
        olPathLayerRef.current = null;
      }
      const coords = computePathCoords();
      if (coords) {
        const coords3857 = coords.map((c) => transform(c, "EPSG:4326", "EPSG:3857"));
        const pathFeature = new Feature({ geometry: new LineString(coords3857) });
        pathFeature.setStyle(new Style({ stroke: new Stroke({ color: "#06b6d4", width: 4 }) }));
        const pathSource = new VectorSource({ features: [pathFeature as Feature] });
        const pathLayer = new VectorLayer({ source: pathSource });
        olPathLayerRef.current = pathLayer;
        olMap.addLayer(pathLayer);
      }
    }
  }, [activeTool, toolStep, toolFromId, toolToId, rawTraceroutes, nodes, olMap]);

  // Line-of-sight analysis between toolFromId and toolToId.
  // Only runs when the LOS tool is active and both picks are done.
  useEffect(() => {
    if (activeTool !== "los" || toolStep !== "result") {
      setLosResult(null);
      return;
    }
    if (!toolFromId || !toolToId) {
      setLosResult(null);
      return;
    }
    if (provider !== "mapbox" || !terrain3D) {
      setLosResult(null);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) {
      setLosResult(null);
      return;
    }
    const fromLive = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
    const toLive = nodes[toolToId] ?? nodes[`!${toolToId}`];
    if (!fromLive?.map_position || !toLive?.map_position) {
      setLosResult(null);
      return;
    }

    const fromPos: [number, number] = [fromLive.map_position[0], fromLive.map_position[1]];
    const toPos: [number, number] = [toLive.map_position[0], toLive.map_position[1]];
    const fromAltitude = fromLive.position?.altitude ?? null;
    const toAltitude = toLive.position?.altitude ?? null;

    // Give terrain DEM tiles a moment to load before sampling
    const run = async () => {
      let result: LoSResult;
      try {
        result = analyzeLineOfSight({
          from: fromPos,
          to: toPos,
          fromAltitudeM: fromAltitude,
          toAltitudeM: toAltitude,
          antennaHeightM: 2,
          freqGHz: 0.915,
          samples: 150,
          queryTerrainM: (lng, lat) => {
            const elev = mb.queryTerrainElevation([lng, lat]);
            return typeof elev === "number" ? elev : null;
          },
        });
      } catch (err) {
        console.warn("[Map] LoS analysis failed:", err);
        setLosResult(null);
        return;
      }
      // Show the geometric result immediately — ITM enhances it
      // asynchronously on top.
      setLosResult(result);

      // Enhance with Longley-Rice path loss. Runs in parallel with the
      // panel first-paint so the panel stays responsive. If the WASM
      // isn't built, we silently skip and the panel keeps the geometric
      // view only.
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

    // Fit the viewport to include both points so terrain tiles load for sampling
    const bounds = new mapboxgl.LngLatBounds(fromPos, toPos);
    mb.fitBounds(bounds, { padding: 120, duration: 600, maxZoom: 11 });

    // Wait for terrain tiles to settle, then sample
    const timer = setTimeout(run, 1200);
    return () => clearTimeout(timer);
  }, [activeTool, toolStep, toolFromId, toolToId, provider, terrain3D, nodes]);

  // Push the current LoS result into the 3D tube layer + obstruction source.
  // Clears them when the LoS tool isn't showing a result.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const showing =
      activeTool === "los" && toolStep === "result" && losResult && toolFromId && toolToId;
    const obsSrc = mb.getSource("los-obstructions") as MbGeoJSONSource | undefined;
    const tube = losTubeLayerRef.current;

    if (!showing) {
      tube?.setData(null);
      obsSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const from = nodes[toolFromId!] ?? nodes[`!${toolFromId!}`];
    const to = nodes[toolToId!] ?? nodes[`!${toolToId!}`];
    if (!from?.map_position || !to?.map_position) return;
    const fromPos: [number, number] = [from.map_position[0], from.map_position[1]];
    const toPos: [number, number] = [to.map_position[0], to.map_position[1]];

    const tubeData = losPointsToTubeData(fromPos, toPos, losResult!.points, losResult!.totalDistanceKm);
    tube?.setData(tubeData);

    const obstructions = pickObstructions(
      fromPos,
      toPos,
      losResult!.points,
      losResult!.totalDistanceKm,
      3,
    );
    obsSrc?.setData(obstructionsToGeoJSON(obstructions, 60));
  }, [activeTool, toolStep, losResult, toolFromId, toolToId, nodes]);

  // -------------------------------------------------------------------------
  // Scan tool (Option C) — batch LoS to every node in view from a chosen origin
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (activeTool !== "scan" || toolStep !== "result") {
      setScanSummary(null);
      setIsScanning(false);
      return;
    }
    if (provider !== "mapbox" || !terrain3D) {
      setScanSummary(null);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) return;

    // Resolve origin (node pick or virtual position)
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

    setIsScanning(true);
    let cancelled = false;

    // Give terrain tiles time to settle, then scan every node in the current
    // viewport. We deliberately don't fitBounds — it'd fight the user's view.
    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        const bounds = mb.getBounds();
        if (!bounds) {
          setIsScanning(false);
          return;
        }
        const w = bounds.getWest();
        const e = bounds.getEast();
        const s = bounds.getSouth();
        const n = bounds.getNorth();

        const targets: ScanTarget[] = [];
        const seen = new Set<string>();
        for (const [rawId, node] of Object.entries(nodes)) {
          if (!node?.map_position) continue;
          const [lng, lat] = node.map_position;
          if (lng < w || lng > e || lat < s || lat > n) continue;
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

        const summary = runScan({
          origin: origin!,
          originAltitudeM: originAltitude,
          originShortname,
          targets,
          raySamples: 60,
          freqGHz: 0.915,
          queryTerrainM: (lng, lat) => {
            const elev = mb.queryTerrainElevation([lng, lat]);
            return typeof elev === "number" ? elev : null;
          },
        });

        if (cancelled) return;
        setScanSummary(summary);
        const src = mb.getSource("scan-links") as MbGeoJSONSource | undefined;
        src?.setData(scanToGeoJSON(summary));
      } catch (err) {
        console.warn("[Map] Scan failed:", err);
        setScanSummary(null);
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    }, 1200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, provider, terrain3D, nodes]);

  // Clear scan-links source when leaving scan tool
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (activeTool !== "scan") {
      try {
        const src = mb.getSource("scan-links") as MbGeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
    }
  }, [activeTool]);

  // Scan hover — highlight a single line using feature-state
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!scanSummary) return;
    // Reset all features' hover state
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
      return;
    }
    if (provider !== "mapbox" || !terrain3D) {
      setCoverageResult(null);
      setIsComputingCoverage(false);
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

    const radKm = coverageRadiusKm;
    const demBounds = demBoundsAround(origin, radKm, 1.05);
    // Gently center on the pin; tiles are fetched directly from Mapbox's
    // terrain-rgb endpoint independent of the viewport.
    mb.easeTo({ center: origin, duration: 300 });

    const mapboxToken = env.MAPBOX_TOKEN;
    if (!mapboxToken) {
      console.warn("[Map] Coverage compute aborted — Mapbox token missing.");
      setIsComputingCoverage(false);
      return;
    }

    const requestId = ++coverageRequestIdRef.current;
    let cancelled = false;

    // Coverage compute now runs across a pool of workers (Phase 10D).
    // Main thread fetches the DEM once, copies it to each worker as a
    // slice task, and stitches the RGBA responses.
    const DEM_SIZE = COVERAGE_DETAIL_SIZE[coverageDetail];
    const envEntry = ENVIRONMENTS[coverageEnvIdx];
    const rasterParams: RasterParams = {
      freqMhz: 915,
      txDbm: coverageTxDbm,
      antennaDbi: coverageAntennaDbi,
      rxSensitivityDbm: coverageEffectiveSensitivityDbm,
      fadeMarginDb: 15,
      cableLossDb: 0.5,
      clutterLossDb: envEntry.clutterLossDb,
      // ITM climate & ground constants. Continental Temperate + N=301 is
      // a reasonable default for most North-American Meshtastic networks.
      climate: 5 /* Climate.ContinentalTemperate */,
      surfaceRefractivityN: 301,
      polarization: 1 /* Polarization.Vertical */,
      groundDielectric: 15,
      groundConductivity: 0.005,
      timePct: 50,
      locationPct: 50,
      situationPct: 50,
    };

    (async () => {
      const t0 = performance.now();
      // Phase-granular timing so we can see where the ~hundreds of ms
      // end up after the worker pool lands.
      const timings: Record<string, number> = {};
      const mark = (name: string, fromMs: number) => {
        timings[name] = performance.now() - fromMs;
      };
      try {
        // 1. Fetch terrain-rgb tiles and build the full DEM on the main
        //    thread. Uses the same `terrainRgb` module the old worker did.
        const tFetch = performance.now();
        const dem = await buildDemFromTerrainRgb({
          bounds: demBounds,
          targetWidth: DEM_SIZE,
          targetHeight: DEM_SIZE,
          token: mapboxToken,
        });
        mark("demFetchMs", tFetch);
        if (cancelled || requestId !== coverageRequestIdRef.current) return;

        // 2. Resolve origin height by sampling the DEM at the pin location.
        const originGround = sampleDEMAt(dem, origin![0], origin![1]);
        const altValid =
          altitude != null &&
          Number.isFinite(altitude) &&
          !Number.isNaN(originGround) &&
          altitude >= originGround;
        const originHeightM = altValid
          ? (altitude as number)
          : (Number.isNaN(originGround) ? 0 : originGround) + 2;
        const originIsFallback = !altValid;

        // 3. Dispatch the pool over the full-resolution DEM.
        const tDispatch = performance.now();
        const rendered = await renderCoverageToImageSource({
          dem,
          origin: origin!,
          originHeightM,
          params: rasterParams,
          requestId,
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
          return;
        }

        // 4. Cache full + downsampled DEM for the drag-preview pass.
        coverageDemRef.current = dem;
        coverageDragDemRef.current = downsampleDEM(dem, 256, 256);
        coverageLastRasterParamsRef.current = rasterParams;
        coverageLastOriginContextRef.current = { bounds: dem.bounds };

        // 5. Extract iso-contours from the margin grid and push them to
        //    the line layer. 0 dB = edge of coverage (most useful),
        //    +10 dB = reliably reachable, +20 dB = strong signal.
        coverageMarginRef.current = {
          data: rendered.marginDb,
          width: dem.width,
          height: dem.height,
          bounds: dem.bounds,
        };
        const contours = extractCoverageContours({
          margin: rendered.marginDb,
          width: dem.width,
          height: dem.height,
          bounds: dem.bounds,
          thresholdsDb: [0, 10, 20],
        });
        coverageContoursRef.current = contours;
        try {
          const src = mb.getSource("coverage-contours") as MbGeoJSONSource | undefined;
          src?.setData(contours);
        } catch {}

        const computeMs = performance.now() - t0;
        console.info(
          `[Map] Coverage compute: ${computeMs.toFixed(0)} ms ` +
            `for ${DEM_SIZE}x${DEM_SIZE} px across ${ensureCoveragePool().size} workers ` +
            `(${Math.round((rendered.demCoveredPixels / rendered.totalPx) * 100)}% terrain-covered)`,
          timings,
        );

        setCoverageResult({
          origin: origin!,
          originHeightM,
          originIsFallback,
          radiusKm: radKm,
          clearCount: rendered.clearCount,
          fresnelCount: rendered.fresnelCount,
          blockedCount: rendered.blockedCount,
          frequencyGHz: 0.915,
          antennaDbi: coverageAntennaDbi,
          txDbm: coverageTxDbm,
          rxSensitivityDbm: coverageEffectiveSensitivityDbm,
        });
        setIsComputingCoverage(false);
      } catch (err) {
        if (cancelled) return;
        console.warn("[Map] Coverage computation failed:", err);
        setCoverageResult(null);
        setIsComputingCoverage(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, coverageRadiusKm, coverageAntennaDbi, coverageTxDbm, coverageEnvIdx, coverageSensitivityDbm, coverageDetail, provider, terrain3D, nodes]);

  // Hide coverage raster when leaving coverage tool. We keep the source/layer
  // around so re-entering the tool reuses them without re-adding.
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
      } catch {}
    }
  }, [activeTool]);

  // Toggle contour layer visibility in step with the panel checkbox
  // (only meaningful while the coverage tool is open).
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

  // Sync the coverage origin pin to the current origin (node pick or
  // virtual placement). A DOM-based mapboxgl.Marker so it stays at a
  // consistent screen size at all zooms and is trivial to make draggable later.
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
      const marker = new mapboxgl.Marker({ color: "#22d3ee", draggable: true })
        .setLngLat(origin)
        .addTo(mb);

      // Live drag preview: re-render LR at a lower resolution (256²)
      // using the cached downsampled DEM. Skips the tile-fetch step
      // entirely — the full DEM was already fetched for the current
      // pin area. At ~50-100 ms per preview pass this feels roughly
      // like 10–15 fps of coverage tracking the pin. Backpressure:
      // one compute in flight at a time; newest position wins.
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
          // Use negative request IDs for drag previews so they never
          // collide with the authoritative compute's id namespace.
          const previewId = -Math.floor(performance.now());
          const ground = sampleDEMAt(dem, lngLat[0], lngLat[1]);
          const originH = (Number.isNaN(ground) ? 0 : ground) + 2;
          coverageRequestIdRef.current = previewId;
          await renderCoverageToImageSource({
            dem,
            origin: lngLat,
            originHeightM: originH,
            params,
            requestId: previewId,
          });
        } finally {
          dragPreviewBusyRef.current = false;
          const pending = dragPreviewPendingRef.current;
          if (pending) {
            dragPreviewPendingRef.current = null;
            // Re-fire with the most recent drag position we saw.
            runDragPreview(pending);
          }
        }
      };

      marker.on("drag", () => {
        const ll = marker.getLngLat();
        runDragPreview([ll.lng, ll.lat]);
      });

      // On drag release: switch to a virtual origin at the new location and
      // kick a fresh compute at full detail. If the origin was a node pick,
      // we "detach" it — the pin is now in free-placement mode.
      marker.on("dragend", () => {
        const ll = marker.getLngLat();
        // Drop the pending preview; the authoritative compute coming
        // from setToolVirtualPos will replace whatever we painted.
        dragPreviewPendingRef.current = null;
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      coverageOriginMarkerRef.current = marker;
    }
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, nodes]);

  // Unmount cleanup for the pin marker
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

  // ----------------------------
  // Deep-link: ?node=<id> flies to a specific node
  // ----------------------------
  const [searchParams, setSearchParams] = useSearchParams();
  const urlNodeId = searchParams.get("node") ?? "";
  const urlNodeIdRef = useRef(urlNodeId);
  urlNodeIdRef.current = urlNodeId;

  // Resolve the target node's coords (used both by init override and fly-to)
  const flyToTarget = useMemo(() => {
    if (!urlNodeId) return null;
    const node = nodes[urlNodeId] ?? nodes[`!${urlNodeId}`];
    if (!node?.map_position) return null;
    return node.map_position as [number, number]; // [lon, lat]
  }, [urlNodeId, nodes]);
  const flyToTargetRef = useRef(flyToTarget);
  flyToTargetRef.current = flyToTarget;

  const flyToHandledRef = useRef<string>("");

  // Retry-based fly-to: waits for the map to be ready
  useEffect(() => {
    if (!urlNodeId || !flyToTarget) return;
    if (flyToHandledRef.current === urlNodeId) return;

    const [lon, lat] = flyToTarget;

    const tryFlyTo = () => {
      if (flyToHandledRef.current === urlNodeId) return true;

      // Mapbox path
      const mbMap = mbMapRef.current;
      if (mbMap) {
        flyToHandledRef.current = urlNodeId;
        mbMap.easeTo({ center: [lon, lat], zoom: 14, duration: 1200 });
        setSearchParams((prev) => { prev.delete("node"); return prev; }, { replace: true });
        return true;
      }

      // OpenLayers path
      if (olMap) {
        flyToHandledRef.current = urlNodeId;
        olMap.getView().animate({
          center: fromLonLat([lon, lat]),
          zoom: 14,
          duration: 1200,
        });
        setSearchParams((prev) => { prev.delete("node"); return prev; }, { replace: true });
        return true;
      }

      return false;
    };

    // Try immediately, then retry at increasing delays for map init
    if (tryFlyTo()) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of [200, 500, 1000, 2000, 3500]) {
      timers.push(setTimeout(() => {
        if (urlNodeIdRef.current !== urlNodeId) return;
        tryFlyTo();
      }, delay));
    }

    return () => timers.forEach(clearTimeout);
  }, [urlNodeId, flyToTarget, olMap, setSearchParams]);

  // Sync map center/zoom to URL params (debounced)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const syncUrl = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        let lat: number | undefined;
        let lng: number | undefined;
        let z: number | undefined;

        const mb = mbMapRef.current;
        if (mb && provider === "mapbox") {
          const c = mb.getCenter();
          lat = +c.lat.toFixed(5);
          lng = +c.lng.toFixed(5);
          z = +mb.getZoom().toFixed(2);
        } else if (olMap && provider === "osm") {
          const center = olMap.getView().getCenter();
          const zoom = olMap.getView().getZoom();
          if (center) {
            const [lo, la] = transform(center, "EPSG:3857", "EPSG:4326");
            lat = +la.toFixed(5);
            lng = +lo.toFixed(5);
          }
          if (zoom != null) z = +zoom.toFixed(2);
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
    if (mb && provider === "mapbox") {
      mb.on("moveend", syncUrl);
      return () => { clearTimeout(timer); mb.off("moveend", syncUrl); };
    }
    if (olMap && provider === "osm") {
      olMap.on("moveend", syncUrl);
      return () => { clearTimeout(timer); olMap.un("moveend", syncUrl); };
    }
    return () => clearTimeout(timer);
  }, [provider, olMap, setSearchParams]);

  // Derive "My Node" label from current state
  const myNodeLabel = useMemo(() => {
    if (!myNodeId) return null;
    const n = nodes[myNodeId];
    return n?.shortname || n?.longname || myNodeId;
  }, [myNodeId, nodes]);

  /** Collect neighbor edge keys (for deduplication with traceroute links). */
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

  /** Compute the persistent link GeoJSON for the current linkMode (all/mynode), including traceroute-inferred links. */
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
        // For "mynode", also include traceroute links involving this node
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

  /** Build OL line features for the current persistent link mode. */
  function buildOlPersistentLinkFeatures(): Feature<LineString>[] {
    const geojson = computePersistentLinks();
    return geojson.features.map((f) => {
      const coords = f.geometry.coordinates.map((c) =>
        transform([c[0], c[1]], "EPSG:4326", "EPSG:3857")
      );
      const line = new Feature({ geometry: new LineString(coords) });
      const kind = f.properties?.kind ?? "neighbor";
      const snr = f.properties?.snr as number | null;
      const color = snrToOlColor(snr, kind);
      const width = snrToOlWidth(snr);
      const dash = kind === "heard_by" ? [8, 6] : kind === "traceroute" ? [2, 6] : undefined;
      line.setStyle(
        new Style({
          stroke: new Stroke({ color, width, lineDash: dash }),
        })
      );
      return line;
    });
  }

  /** Refresh the OL persistent links layer. */
  function refreshOlPersistentLinks(map: OlMap) {
    const mode = linkModeRef.current;
    if (mode === "selected") {
      if (olPersistentLinksLayerRef.current) {
        map.removeLayer(olPersistentLinksLayerRef.current);
        olPersistentLinksLayerRef.current = null;
      }
      persistentLinksOlJsonRef.current = "";
      return;
    }

    // Bail out if the underlying GeoJSON hasn't changed since the last rebuild
    // — avoids full layer re-creation on every 5s poll.
    const geojson = computePersistentLinks();
    const json = JSON.stringify(geojson);
    if (json === persistentLinksOlJsonRef.current && olPersistentLinksLayerRef.current) return;
    persistentLinksOlJsonRef.current = json;

    if (olPersistentLinksLayerRef.current) {
      map.removeLayer(olPersistentLinksLayerRef.current);
      olPersistentLinksLayerRef.current = null;
    }
    const features = buildOlPersistentLinkFeatures();
    if (features.length === 0) return;

    const source = new VectorSource({ features: features as Feature[] });
    const layer = new VectorLayer({ source });
    olPersistentLinksLayerRef.current = layer;
    map.addLayer(layer);
  }

  /** Push persistent link data to the Mapbox "links" source. */
  function refreshMapboxLinks() {
    const map = mbMapRef.current;
    if (!map) return;
    try {
      const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
      if (!linksSource) return;
      const fc = computePersistentLinks();
      const json = JSON.stringify(fc);
      if (json === persistentLinksMbJsonRef.current) return; // no-op when unchanged
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

    if (provider === "mapbox" && mbMapRef.current) {
      try {
        // Force a synchronous render so custom layers are captured
        mbMapRef.current.triggerRepaint();
        // Use a short delay to let the frame finish
        setTimeout(() => {
          const canvas = mbMapRef.current!.getCanvas();
          triggerDownload(canvas.toDataURL("image/png"));
        }, 100);
      } catch (err) {
        console.error("Mapbox export failed:", err);
      }
      return;
    }

    if (provider === "osm" && olMap) {
      const mapSize = olMap.getSize();
      if (!mapSize) return;
      const [w, h] = mapSize;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Composite all OL canvases (base + vector layers)
      const olCanvases = olMap.getTargetElement().querySelectorAll<HTMLCanvasElement>(
        ".ol-layer canvas, canvas.ol-layer",
      );
      olCanvases.forEach((srcCanvas) => {
        if (srcCanvas.width === 0 || srcCanvas.height === 0) return;
        const opacity = srcCanvas.parentElement?.style.opacity;
        ctx.globalAlpha = opacity === "" || opacity == null ? 1 : Number(opacity);
        const transform = srcCanvas.style.transform;
        const match = /^matrix\(([^)]+)\)$/.exec(transform);
        if (match) {
          const [a, b, c, d, e, f] = match[1].split(",").map(Number);
          ctx.setTransform(a, b, c, d, e, f);
        } else {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.drawImage(srcCanvas, 0, 0);
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      triggerDownload(canvas.toDataURL("image/png"));
    }
  }

  function clearMapboxSelectionAndOverlays() {
    const map = mbMapRef.current;
    const selectedId = mbSelectedIdRef.current;

    if (map && selectedId) {
      // Clear selection ring (feature-state) for all node sources
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
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(computePersistentLinks());
      } catch {}
      // Clear coverage circle
      try {
        const coverageSrc = map.getSource("coverage") as MbGeoJSONSource | undefined;
        coverageSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      // Clear link highlight
      try {
        const hlSrc = map.getSource("link-highlight") as MbGeoJSONSource | undefined;
        hlSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      // Clear path analysis
      try {
        const paSrc = map.getSource("path-analysis") as MbGeoJSONSource | undefined;
        paSrc?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
    }

    // Hide the panel
    setDetailsData(null);
  }

  // ----------------------------
  // Provider switching cleanup
  // ----------------------------
  useEffect(() => {
    if (provider !== "mapbox" && mbMapRef.current) {
      mbMapRef.current.remove();
      mbMapRef.current = null;
      mbSelectedIdRef.current = null;
      mbHandlersBoundRef.current = false;
      mbCurrentStyleUrlRef.current = null;

      if (mapRef.current) mapRef.current.innerHTML = "";
    }

    if (provider !== "osm" && olMap) {
      olMap.setTarget(undefined);
      if (mapRef.current) mapRef.current.innerHTML = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // ----------------------------
  // Mapbox: init + layers
  // ----------------------------
  useEffect(() => {
    const usingMapbox = provider === "mapbox" && hasMapbox;

    if (!usingMapbox) return;
    if (mbMapRef.current) return;
    if (!mapRef.current) return;

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };

    // Prefer serverNode if available, otherwise fall back to any node with a position
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

    const styleUrl = toMapboxStyleUrl(mapboxStyle);
    mbCurrentStyleUrlRef.current = styleUrl;

    // fresh container
    mapRef.current.innerHTML = "";

    if (!mapboxgl.accessToken) {
      mapboxgl.accessToken = mapboxToken!;
    }

    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: styleUrl,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: false,
      logoPosition: "top-right",
      preserveDrawingBuffer: true, // required for canvas.toDataURL() export
    });

    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "top-right");

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

      const clustered = m.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
      clustered?.setData(data);

      const plain = m.getSource("nodes_plain") as MbGeoJSONSource | undefined;
      plain?.setData(data);
    };

    map.on("moveend", () => {
      const c = map.getCenter();
      localStorage.setItem("savedCenter", JSON.stringify([c.lng, c.lat]));
      localStorage.setItem("savedZoom", map.getZoom().toString());
    });

    const ensureSourcesAndLayers = () => {
      // clustered nodes source
      if (!map.getSource("nodes_clustered")) {
        map.addSource("nodes_clustered", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()),
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 24,
        });
      }

      // plain nodes source
      if (!map.getSource("nodes_plain")) {
        map.addSource("nodes_plain", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()),
        });
      }

      // links source
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

      // Coverage contours — iso-margin lines extracted from the margin
      // grid via marching squares. Painted as lines on top of the raster
      // so edges of coverage and "reliable vs marginal" boundaries read
      // clearly at a glance.
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
            // Color by threshold: 0 dB (edge) = amber, 10 dB = green,
            // 20 dB = bright green ("strongly reliable").
            "line-color": [
              "match", ["get", "thresholdDb"],
              0,  "#f59e0b",
              10, "#22c55e",
              20, "#86efac",
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

      // Note: the coverage origin pin uses mapboxgl.Marker (DOM-based) instead
      // of a source/layer — it's easier to make screen-space-constant-sized
      // and upgrade to draggable in a future pass without re-jiggering the
      // custom layer stack.

      // 3D LoS tube + obstruction pylons (Phase 9+, Option B).
      // The tube is a custom WebGL layer that draws the chord in world space;
      // the pylons are fill-extrusions showing where terrain spikes above it.
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

      // Scan tool links — color-coded lines from origin to each scanned target.
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
              "clear",      "#22c55e",
              "fresnel",    "#eab308",
              "diffracted", "#f97316",
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

      // Shared link paint properties
      const linkWidth = [
        "case",
        ["==", ["get", "snr"], null], 3,
        ["interpolate", ["linear"], ["get", "snr"],
          -10, 1.5, 0, 3, 5, 5, 10, 7, 20, 9,
        ],
      ] as any;
      const linkColor = [
        "case",
        ["==", ["get", "kind"], "traceroute"], "#F59E0B",
        ["==", ["get", "snr"], null], [
          "match", ["get", "kind"],
          "neighbor", "#66FF66",
          "heard_by", "#6666FF",
          "both", "#FF66FF",
          "#FFFFFF",
        ],
        ["interpolate", ["linear"], ["get", "snr"],
          -10, "#FF4444", -5, "#FF6644", 0, "#FFAA00",
          2.5, "#FFDD00", 5, "#88DD00", 10, "#44CC44",
        ],
      ] as any;

      // Neighbor + both links — solid lines (both uses curved arcs from GeoJSON)
      if (!map.getLayer("links-solid")) {
        map.addLayer({
          id: "links-solid",
          type: "line",
          source: "links",
          filter: ["in", ["get", "kind"], ["literal", ["neighbor", "both"]]],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-opacity": 0.9, "line-width": linkWidth, "line-color": linkColor },
        });
      }

      // Heard-by links — dashed lines
      if (!map.getLayer("links-dashed")) {
        map.addLayer({
          id: "links-dashed",
          type: "line",
          source: "links",
          filter: ["==", ["get", "kind"], "heard_by"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-opacity": 0.7,
            "line-width": linkWidth,
            "line-color": linkColor,
            "line-dasharray": [4, 3],
          },
        });
      }

      // Traceroute links — dotted lines
      if (!map.getLayer("links-dotted")) {
        map.addLayer({
          id: "links-dotted",
          type: "line",
          source: "links",
          filter: ["==", ["get", "kind"], "traceroute"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-opacity": 0.7,
            "line-width": linkWidth,
            "line-color": linkColor,
            "line-dasharray": [1, 3],
          },
        });
      }

      // cluster circles
      if (!map.getLayer("clusters")) {
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          paint: {
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
            "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 25, 24, 50, 30],
            "circle-color": "#3b82f6",
            "circle-opacity": 0.85,
          },
        });
      }

      // cluster count
      if (!map.getLayer("cluster-count")) {
        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12 },
          paint: { "text-color": "#ffffff" },
        });
      }

      // online node pulse (behind unclustered nodes)
      if (!map.getLayer("unclustered-pulse")) {
        map.addLayer({
          id: "unclustered-pulse",
          type: "circle",
          source: "nodes_clustered",
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "online"], true]],
          paint: {
            "circle-radius": 12,
            "circle-color": mbRoleColorExpr,
            "circle-opacity": 0.3,
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
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 10, 6],
            "circle-color": mbRoleColorExpr,
            "circle-stroke-width": 2,
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
            "circle-radius": 12,
            "circle-color": mbRoleColorExpr,
            "circle-opacity": 0.3,
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
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 10, 6],
            "circle-color": mbRoleColorExpr,
            "circle-stroke-width": 2,
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
      applyMapboxClusterVisibility(map, clusterEnabledRef.current);

      // Re-apply terrain if it was enabled (style.load wipes this)
      if (terrain3DRef.current) {
        try {
          applyTerrainState(map, true, terrainExaggerationRef.current);
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

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
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
        const coverageSrc = map.getSource("coverage") as MbGeoJSONSource | undefined;
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
        const src = m.getSource("link-highlight") as MbGeoJSONSource | undefined;
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
      bindHover("clusters");
      bindHover("plain-nodes");

      // Clicking a cluster: zoom in, or spiderfy if can't expand further
      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const cluster = features[0];
        if (!cluster) return;

        const clusterId = cluster.properties?.cluster_id;
        const source = map.getSource("nodes_clustered") as MbGeoJSONSource;
        if (!source || clusterId == null) return;

        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err) return;
          if (zoom == null) return;

          const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
          const maxZoom = map.getMaxZoom();

          if (zoom >= maxZoom) {
            // Can't expand further — spiderfy the nodes
            clearMapboxSelectionAndOverlays();
            void spiderfy(map, clusterId, [lng, lat], map.getZoom());
          } else {
            // Zoom in, collapsing any existing spiderfy
            removeSpiderfyLayers(map);
            map.easeTo({ center: [lng, lat], zoom });
          }
        });
      });

      const onNodeLayerClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
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

      // Virtual-origin click (coverage + scan tools). Fires when the user clicks
      // empty map in pickFrom mode — drops a synthetic origin at that lng/lat.
      map.on("click", (e) => {
        const t = activeToolRef.current;
        if ((t !== "coverage" && t !== "scan") || toolStepRef.current !== "pickFrom") return;
        // Ignore if clicking on a node layer (handled by onNodeLayerClick)
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["unclustered-nodes", "plain-nodes", "clusters", SPIDERFY_LAYER_NODES].filter((id) => map.getLayer(id)),
        });
        if (features.length > 0) return;
        setToolVirtualPos([e.lngLat.lng, e.lngLat.lat]);
        setToolStep("result");
        map.getCanvas().style.cursor = "";
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

      // Auto-spiderfy clusters that can't expand further
      map.on("idle", () => {
        if (clusterEnabledRef.current) {
          void autoSpiderfyVisibleClusters(map);
        }
      });

      // Right-click / long-press: "Set as My Node"
      const findNodeIdAtPoint = (point: mapboxgl.PointLike): string | null => {
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
      let longPressPoint: mapboxgl.PointLike | null = null;

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
      const onMapMouseMove = (e: mapboxgl.MapMouseEvent) => {
        pendingElevE = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        if (elevRafQueued) return;
        elevRafQueued = true;
        requestAnimationFrame(() => {
          elevRafQueued = false;
          if (!pendingElevE || !mbMapRef.current) return;
          try {
            const elev = mbMapRef.current.queryTerrainElevation([pendingElevE.lng, pendingElevE.lat]);
            setHoverElevationM(typeof elev === "number" && Number.isFinite(elev) ? elev : null);
          } catch {
            setHoverElevationM(null);
          }
        });
      };
      const onMapMouseOut = () => setHoverElevationM(null);
      map.on("mousemove", onMapMouseMove);
      map.on("mouseout", onMapMouseOut);

      // --- Hover tooltips (desktop only) ---
      const hoverPopup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
        className: "map-hover-tooltip",
      });

      const showTooltip = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
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
    };

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, hasMapbox, serverNode]);

  // Mapbox: style switching (re-style, let style.load re-add layers/sources)
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;
    if (!hasMapbox) return;

    const desired = toMapboxStyleUrl(mapboxStyle);
    if (mbCurrentStyleUrlRef.current === desired) return;

    try {
      // Style change resets sources/layers; style.load handler re-creates them.
      mbCurrentStyleUrlRef.current = desired;

      // Clear selection & overlays to avoid stale feature-state during style swap
      mbSelectedIdRef.current = null;
      setDetailsData(null);
      const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
      linksSource?.setData(emptyLineFeatureCollection());

      map.setStyle(desired);
    } catch {}
  }, [mapboxStyle, provider, hasMapbox]);

  // Mapbox: cluster toggle
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;
    if (!hasMapbox) return;
    applyMapboxClusterVisibility(map, clusterEnabled);
  }, [clusterEnabled, provider, hasMapbox]);

  // Mapbox: 3D terrain — add/remove DEM source, terrain, and sky layer.
  // Safe to call repeatedly: each action is idempotent and survives style reloads.
  const applyTerrainState = (map: MbMap, enabled: boolean, exaggeration: number) => {
    if (enabled) {
      // 1. DEM source (creates raster-dem source for terrain heights)
      if (!map.getSource("mapbox-dem")) {
        map.addSource("mapbox-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14,
        });
      }
      // 2. Apply terrain with current exaggeration
      map.setTerrain({ source: "mapbox-dem", exaggeration });
      // 3. Add atmospheric sky layer (only once)
      if (!map.getLayer("sky")) {
        map.addLayer({
          id: "sky",
          type: "sky",
          paint: {
            "sky-type": "atmosphere",
            "sky-atmosphere-sun": [0.0, 90.0],
            "sky-atmosphere-sun-intensity": 15,
          },
        });
      }
    } else {
      // Disable terrain and remove sky
      try { map.setTerrain(null); } catch {}
      if (map.getLayer("sky")) {
        try { map.removeLayer("sky"); } catch {}
      }
      // Leave the DEM source in place — cheap and allows quick re-enable
    }
  };

  // Effect: react to terrain3D / exaggeration changes
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;
    if (!hasMapbox) return;

    const run = () => {
      try {
        applyTerrainState(map, terrain3D, terrainExaggeration);
      } catch (err) {
        console.warn("[Map] Terrain apply failed:", err);
      }

      // When disabling 3D, reset pitch + bearing to 0 for a clean 2D view
      if (!terrain3D) {
        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
      } else if (map.getPitch() < 5) {
        // Turning on terrain: nudge pitch to 45° so the 3D effect is visible
        map.easeTo({ pitch: 45, duration: 500 });
      }
    };

    if (map.isStyleLoaded()) {
      run();
    } else {
      map.once("style.load", run);
    }
  }, [terrain3D, terrainExaggeration, provider, hasMapbox]);

  // If user switches provider away from Mapbox, disable 3D terrain state
  useEffect(() => {
    if (provider !== "mapbox" && terrain3D) {
      setTerrain3D(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Mapbox: live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;

    const data = buildNodesGeoJSON(nodes, recentDays, { role: roleFilter, channel: channelFilter });

    const clustered = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
    clustered?.setData(data);

    const plain = map.getSource("nodes_plain") as MbGeoJSONSource | undefined;
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

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
        setDetailsData(null);
      }
    }
  }, [nodes, recentDays, provider, roleFilter, channelFilter]);

  // Mapbox: react to linkMode / myNodeId / nodes changes for persistent links
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;

    // In "selected" mode, don't override — handleNodeClick manages links
    if (linkMode === "selected" && !mbSelectedIdRef.current) {
      // Clear any lingering persistent links
      try {
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
      } catch {}
      return;
    }

    if (linkMode !== "selected") {
      refreshMapboxLinks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkMode, myNodeId, nodes, rawTraceroutes, provider]);

  // ----------------------------
  // OpenLayers: init (OSM path)
  // ----------------------------
  useEffect(() => {
    const usingOsm = provider === "osm";

    if (!usingOsm) return;
    if (olMap) {
      const target = olMap.getTarget();
      if (target && target === mapRef.current) return;

      if (mapRef.current) {
        mapRef.current.innerHTML = "";
        olMap.setTarget(mapRef.current as HTMLElement);

        // Prevent "blank until resize" / stalled render
        bumpOlRender(olMap);
        return;
      }
    }
    if (!mapRef.current) return;

    mapRef.current.innerHTML = "";

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };

    // Prefer serverNode if it has a position, otherwise fall back to any node with a position
    const fallbackNodeWithPos =
      serverNode?.map_position ? serverNode : Object.values(nodes).find((n) => n.map_position);

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

    const initialCenter = flyTarget
      ? fromLonLat([flyTarget[0], flyTarget[1]])
      : Number.isFinite(urlLng) && Number.isFinite(urlLat)
        ? fromLonLat([urlLng, urlLat])
        : fromLonLat([savedLon ?? centerPos.longitude, savedLat ?? centerPos.latitude]);

    let initialZoom = flyTarget ? 14 : Number.isFinite(urlZ) ? urlZ : 9.5;
    if (!flyTarget && !Number.isFinite(urlZ)) {
      try {
        const z = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");
        if (typeof z === "number" && Number.isFinite(z)) initialZoom = z;
      } catch {
        // ignore
      }
    }

    const tileLayer = createBaseTileLayer({
      provider: "osm",
      osmBasemap,
    });

    const map = new OlMap({
      layers: [tileLayer],
      target: mapRef.current as HTMLElement,
      view: new View({
        center: initialCenter,
        zoom: initialZoom,
      }),
    });

    setOlMap(map);
    olBaseLayerRef.current = tileLayer;

    // Helps prevent "blank until resize" in some layouts
    bumpOlRender(map);

    map.on("moveend", () => {
      const center = map.getView().getCenter();
      const zoom = map.getView().getZoom();
      if (center) {
        const [lon, lat] = transform(center, "EPSG:3857", "EPSG:4326");
        localStorage.setItem("savedCenter", JSON.stringify([lon, lat]));
      }
      if (zoom != null) {
        localStorage.setItem("savedZoom", zoom.toString());
      }
    });

    // Hover tooltip (desktop only)
    const tooltipEl = document.createElement("div");
    tooltipEl.className = "ol-hover-tooltip";
    tooltipEl.style.cssText =
      "background:rgba(0,0,0,0.85);color:white;padding:6px 10px;border-radius:6px;" +
      "font-size:12px;line-height:1.4;pointer-events:none;white-space:nowrap;";
    const tooltipOverlay = new Overlay({
      element: tooltipEl,
      offset: [12, 0],
      positioning: "center-left",
    });
    map.addOverlay(tooltipOverlay);

    map.on("pointermove", (evt) => {
      const hit = map.hasFeatureAtPixel(evt.pixel);
      map.getTargetElement().style.cursor = hit ? "pointer" : "";

      if (!hit) {
        tooltipOverlay.setPosition(undefined);
        return;
      }

      let found = false;
      map.forEachFeatureAtPixel(evt.pixel, (f) => {
        if (found) return;
        const props = (f as Feature).getProperties();
        const nodeData = props.node as IFeatureNode | undefined;
        if (!nodeData?.id) return;
        found = true;

        const fullNode = nodesRef.current[nodeData.id];
        const role = fullNode?.role != null ? roleTitles[fullNode.role]?.title ?? "" : "";
        const snr = bestSnr(nodeData.id, nodesRef.current);
        tooltipEl.innerHTML =
          `<div style="display:flex;align-items:center;gap:4px">` +
          signalBarsHtml(snr) +
          `<strong>${escapeHtml(nodeData.shortname || nodeData.id)}</strong>` +
          `</div>` +
          (role ? `<span style="opacity:0.6">${role}</span><br/>` : "") +
          `<span style="opacity:0.6">${relativeTime(nodeData.last_seen)}</span>`;
        const geom = (f as Feature<Point>).getGeometry();
        if (geom) tooltipOverlay.setPosition(geom.getCoordinates());
      });

      if (!found) tooltipOverlay.setPosition(undefined);
    });

    // nodes layer
    const nodeEntries = computeRecentNodes(nodes, recentDays);
    const features = nodeEntries
      .map(([id, node]) => {
        if (!node.map_position) return null;

        const feature = new Feature({
          geometry: new Point(fromLonLat([node.map_position[0], node.map_position[1]])),
          node: {
            id,
            shortname: node.shortname,
            longname: node.longname,
            last_seen: node.last_seen,
            position: [node.map_position[0], node.map_position[1]] as Coordinate,
            online: node.online,
            neighbors: node.neighbors,
            gateway: node.gateway,
          } satisfies IFeatureNode,
        });

        feature.setStyle(getOlNodeStyle(node.online, (node as any).role));
        return feature;
      })
      .filter((f): f is Feature<Point> => Boolean(f));

    // Create both plain and clustered layers — toggle via clusterEnabled
    const nodeSource = new VectorSource({ features });
    olNodesSourceRef.current = nodeSource;

    const plainLayer = new VectorLayer({
      style: defaultStyle,
      source: nodeSource,
    });

    const clusterSetup = createOlClusterLayer(features);
    olClusterSetupRef.current = clusterSetup;

    // Add the appropriate layer based on cluster setting
    if (clusterEnabledRef.current) {
      map.addLayer(clusterSetup.clusterLayer);
    } else {
      map.addLayer(plainLayer);
    }

    const neighborLayers: VectorLayer<VectorSource<Feature>, Feature>[] = [];

    const handleNodeDetails = async (node: IFeatureNode) => {
      selectedNodeIdRef.current = node.id;
      const displayName = await reverseGeocode(node.position[0], node.position[1]);

      const liveNodes = nodesRef.current;
      const fullNode = liveNodes[node.id];

      const nodeLike: NodeLike = {
        id: node.id,
        shortname: node.shortname,
        longname: node.longname,
        last_seen: node.last_seen,
        online: Boolean(node.online),
        position: node.position,
        neighbors: node.neighbors,
        gateway: node.gateway,
        role: fullNode?.role,
      };

      const heardBy = computeHeardByIds(liveNodes, node.id);

      const relevantTraceroutes = traceroutesRef.current.filter((tr) => {
        const norm = normNodeId(node.id);
        const from = normNodeId(tr.from);
        const to = normNodeId(tr.to);
        if (from === norm || to === norm) return true;
        const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
        return hops.includes(norm);
      });
      const maxRangeKm = computeMaxRange(node.id, [node.position[0], node.position[1]], liveNodes, heardBy, relevantTraceroutes);

      setDetailsDataRef.current({
        node: nodeLike,
        liveNodes,
        displayName: displayName || "Unknown",
        elsewhereLinks: configRef.current?.mesh?.elsewhere_links,
        traceroutes: traceroutesRef.current,
        channelLabel: resolveChannelLabel((fullNode as any)?.last_channel),
        heardBy,
        maxRangeKm,
      });

      // Draw neighbor lines
      node.neighbors?.forEach((neighbor) => {
        const nnode = nodes[neighbor.id];
        if (!nnode?.map_position) return;

        const points: Coordinate[] = [node.position, nnode.map_position];
        for (let i = 0; i < points.length; i++) {
          points[i] = transform(points[i], "EPSG:4326", "EPSG:3857");
        }

        const featureLine = new Feature({ geometry: new LineString(points) });
        const vectorLine = new Vector({});
        vectorLine.addFeature(featureLine);

        const linkColor = snrToOlColor(neighbor.snr, "neighbor");
        const linkWidth = snrToOlWidth(neighbor.snr);
        const vectorLineLayer = new VectorLayer({
          source: vectorLine,
          style: new Style({
            fill: new Fill({ color: linkColor }),
            stroke: new Stroke({ color: linkColor, width: linkWidth }),
          }),
        });
        neighborLayers.push(vectorLineLayer);
        map.addLayer(vectorLineLayer);
      });

      // Coverage radius circle
      if (olCoverageLayerRef.current) {
        map.removeLayer(olCoverageLayerRef.current);
        olCoverageLayerRef.current = null;
      }
      if (maxRangeKm) {
        const circleLonLat = geodesicCircleCoords([node.position[0], node.position[1]], maxRangeKm);
        const circle3857 = circleLonLat.map((c) => transform(c, "EPSG:4326", "EPSG:3857"));
        const roleColor = ROLE_COLORS[(fullNode as any)?.role] ?? DEFAULT_NODE_COLOR;
        const polyFeature = new Feature({ geometry: new Polygon([circle3857]) });
        polyFeature.setStyle(
          new Style({
            fill: new Fill({ color: hexToRgba(roleColor, 0.08) }),
            stroke: new Stroke({ color: roleColor, width: 1.5, lineDash: [4, 4] }),
          }),
        );
        const covSource = new VectorSource({ features: [polyFeature as Feature] });
        const covLayer = new VectorLayer({ source: covSource });
        olCoverageLayerRef.current = covLayer;
        map.addLayer(covLayer);
      }
    };

    // Expose handleNodeDetails for panel node-select navigation
    handleNodeSelectRef.current = (id: string) => {
      const targetNode = nodesRef.current[id];
      if (!targetNode?.map_position) return;
      void handleNodeDetails({
        id,
        shortname: targetNode.shortname,
        longname: targetNode.longname,
        last_seen: targetNode.last_seen,
        position: [targetNode.map_position[0], targetNode.map_position[1]] as Coordinate,
        online: Boolean(targetNode.online),
        neighbors: targetNode.neighbors,
        gateway: targetNode.gateway,
      });
    };

    // OL: link-highlight callback for details panel hover
    handleLinkHoverRef.current = (otherId: string | null) => {
      if (olHighlightLayerRef.current) {
        map.removeLayer(olHighlightLayerRef.current);
        olHighlightLayerRef.current = null;
      }
      if (!otherId) return;

      const selId = selectedNodeIdRef.current;
      if (!selId) return;
      const selNode = nodesRef.current[selId];
      if (!selNode?.map_position) return;

      const otherNode = nodesRef.current[otherId] ?? nodesRef.current[`!${otherId}`];
      if (!otherNode?.map_position) return;

      const coords = [selNode.map_position, otherNode.map_position].map((c) =>
        transform([c[0], c[1]], "EPSG:4326", "EPSG:3857"),
      );
      const hlFeature = new Feature({ geometry: new LineString(coords) });
      hlFeature.setStyle(
        new Style({ stroke: new Stroke({ color: "#ffffff", width: 5 }) }),
      );
      const hlSource = new VectorSource({ features: [hlFeature as Feature] });
      const hlLayer = new VectorLayer({ source: hlSource });
      olHighlightLayerRef.current = hlLayer;
      map.addLayer(hlLayer);
    };

    // Select interaction for non-clustered mode
    const selectedStyle = new Style({
      image: new Circle({
        radius: 6,
        fill: new Fill({ color: "rgba(0, 0, 240, 1)" }),
        stroke: new Stroke({ color: "orange", width: 2 }),
      }),
    });

    const select = new Select({ condition: click, style: selectedStyle });
    map.addInteraction(select);

    // Draw persistent links if mode is all/mynode at init
    refreshOlPersistentLinks(map);

    // Right-click / long-press: "Set as My Node" (OL)
    const findOlNodeAtPixel = (pixel: number[]): IFeatureNode | null => {
      let found: IFeatureNode | null = null;
      map.forEachFeatureAtPixel(pixel, (f) => {
        const props = f.getProperties();
        if (props.node?.id) found = props.node as IFeatureNode;
      });
      return found;
    };

    const viewport = map.getViewport();
    const onOlContextMenu = (e: MouseEvent) => {
      const pixel = map.getEventPixel(e);
      const node = findOlNodeAtPixel(pixel);
      if (!node) return;
      e.preventDefault();
      setMyNodeId(node.id);
      setLinkMode("mynode");
    };
    viewport.addEventListener("contextmenu", onOlContextMenu);

    // Long-press for mobile (OL)
    let olLongPressTimer: ReturnType<typeof setTimeout> | null = null;
    let olLongPressPixel: number[] | null = null;

    const onOlTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const rect = viewport.getBoundingClientRect();
      olLongPressPixel = [
        e.touches[0].clientX - rect.left,
        e.touches[0].clientY - rect.top,
      ];
      olLongPressTimer = setTimeout(() => {
        if (!olLongPressPixel) return;
        const node = findOlNodeAtPixel(olLongPressPixel);
        if (!node) return;
        setMyNodeId(node.id);
        setLinkMode("mynode");
        olLongPressPixel = null;
      }, 500);
    };
    const onOlTouchCancel = () => {
      if (olLongPressTimer) { clearTimeout(olLongPressTimer); olLongPressTimer = null; }
      olLongPressPixel = null;
    };
    viewport.addEventListener("touchstart", onOlTouchStart, { passive: true });
    viewport.addEventListener("touchmove", onOlTouchCancel, { passive: true });
    viewport.addEventListener("touchend", onOlTouchCancel, { passive: true });

    map.on("singleclick", async (event) => {
      neighborLayers.forEach((layer) => map.removeLayer(layer));
      neighborLayers.length = 0;

      // Clear coverage + path overlays on any click (will be re-added if a node is selected)
      if (olCoverageLayerRef.current) {
        map.removeLayer(olCoverageLayerRef.current);
        olCoverageLayerRef.current = null;
      }
      if (olPathLayerRef.current) {
        map.removeLayer(olPathLayerRef.current);
        olPathLayerRef.current = null;
      }

      // Helper: if a tool is picking a node, intercept the click
      const handleNodeClickMaybePick = (node: IFeatureNode) => {
        const activeToolCur = activeToolRef.current;
        const stepCur = toolStepRef.current;
        if (activeToolCur && stepCur === "pickFrom") {
          setToolFromId(node.id);
          if (activeToolCur === "coverage" || activeToolCur === "scan") {
            setToolStep("result");
          } else {
            setToolStep("pickTo");
          }
          return true;
        }
        if (activeToolCur && stepCur === "pickTo") {
          if (node.id === toolFromIdRef.current) return true;
          setToolToId(node.id);
          setToolStep("result");
          return true;
        }
        return false;
      };

      if (clusterEnabledRef.current) {
        // Clustered mode — use spiderfy-aware click handler
        const node = handleOlClusterClick(map, clusterSetup.clusterSource, event.pixel);
        if (node) {
          if (handleNodeClickMaybePick(node)) return;
          select.getFeatures().clear();
          void handleNodeDetails(node);
        } else if (!map.hasFeatureAtPixel(event.pixel)) {
          setDetailsDataRef.current(null);
        }
        return;
      }

      // Plain mode — original behavior
      if (map.hasFeatureAtPixel(event.pixel) !== true) {
        setDetailsDataRef.current(null);
        return;
      }

      const feature = map.forEachFeatureAtPixel(event.pixel, (f) => f);
      if (!feature) return;

      const props = feature.getProperties();
      const { node } = props as { node: IFeatureNode };
      if (!node?.id) return;

      if (handleNodeClickMaybePick(node)) return;
      void handleNodeDetails(node);
    });

    // Zoom handlers for OL spiderfy
    map.getView().on("change:resolution", () => {
      updateOlSpiderfyPositions(map);
    });

    map.on("moveend", () => {
      if (clusterEnabledRef.current) {
        autoOlSpiderfy(map, clusterSetup.clusterSource);
      }
    });

    // Escape key for OL spiderfy
    const olKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        removeOlSpiderfy(map);
        setDetailsDataRef.current(null);
      }
    };
    document.addEventListener("keydown", olKeydownHandler);

    return () => {
      document.removeEventListener("keydown", olKeydownHandler);
      viewport.removeEventListener("contextmenu", onOlContextMenu);
      viewport.removeEventListener("touchstart", onOlTouchStart);
      viewport.removeEventListener("touchmove", onOlTouchCancel);
      viewport.removeEventListener("touchend", onOlTouchCancel);
      if (olLongPressTimer) clearTimeout(olLongPressTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, serverNode, olMap]);

  // OpenLayers: update nodes in real time when nodes/recentDays change
  useEffect(() => {
    if (provider !== "osm") return;
    if (!olMap) return;

    const nodeEntries = computeRecentNodes(nodes, recentDays);
    const features = nodeEntries
      .map(([id, node]) => {
        if (!node.map_position) return null;

        const feature = new Feature({
          geometry: new Point(fromLonLat([node.map_position[0], node.map_position[1]])),
          node: {
            id,
            shortname: node.shortname,
            longname: node.longname,
            last_seen: node.last_seen,
            position: [node.map_position[0], node.map_position[1]] as Coordinate,
            online: node.online,
            neighbors: node.neighbors,
            gateway: node.gateway,
          } satisfies IFeatureNode,
        });

        feature.setStyle(getOlNodeStyle(node.online, (node as any).role));
        return feature;
      })
      .filter((f): f is Feature<Point> => Boolean(f));

    // Update plain source
    if (olNodesSourceRef.current) {
      olNodesSourceRef.current.clear();
      olNodesSourceRef.current.addFeatures(features);
    }

    // Update cluster source (uses its own feature source)
    if (olClusterSetupRef.current) {
      removeOlSpiderfy(olMap); // clear spiderfy before updating features
      olClusterSetupRef.current.featureSource.clear();
      // Re-create features for cluster source (separate instances)
      const clusterFeatures = nodeEntries
        .map(([id, node]) => {
          if (!node.map_position) return null;
          const f = new Feature({
            geometry: new Point(fromLonLat([node.map_position[0], node.map_position[1]])),
            node: {
              id,
              shortname: node.shortname,
              longname: node.longname,
              last_seen: node.last_seen,
              position: [node.map_position[0], node.map_position[1]] as Coordinate,
              online: node.online,
              neighbors: node.neighbors,
            } satisfies IFeatureNode,
          });
          f.setStyle(getOlNodeStyle(node.online, (node as any).role));
          return f;
        })
        .filter((f): f is Feature<Point> => Boolean(f));
      olClusterSetupRef.current.featureSource.addFeatures(clusterFeatures as Feature[]);
    }
  }, [nodes, recentDays, provider, olMap]);

  // OpenLayers: swap basemap live
  useEffect(() => {
    if (provider !== "osm") return;
    if (!olMap) return;

    const newBase = createBaseTileLayer({ provider: "osm", osmBasemap });

    // Replace layer 0 (base layer)
    olMap.getLayers().setAt(0, newBase);
    olBaseLayerRef.current = newBase;

    bumpOlRender(olMap);
  }, [osmBasemap, provider, olMap]);

  // OpenLayers: cluster toggle — swap between plain and clustered layers
  useEffect(() => {
    if (provider !== "osm") return;
    if (!olMap) return;

    const clusterSetup = olClusterSetupRef.current;
    if (!clusterSetup) return;

    // Remove spiderfy when toggling
    removeOlSpiderfy(olMap);

    const layers = olMap.getLayers();

    if (clusterEnabled) {
      // Remove any plain node layer (index 1+), add cluster layer
      for (let i = layers.getLength() - 1; i >= 1; i--) {
        const layer = layers.item(i);
        // Only remove plain vector layers that use our node source
        if (layer instanceof VectorLayer && (layer as VectorLayer<VectorSource>).getSource() === olNodesSourceRef.current) {
          layers.removeAt(i);
        }
      }
      if (!layers.getArray().includes(clusterSetup.clusterLayer)) {
        olMap.addLayer(clusterSetup.clusterLayer);
      }
    } else {
      // Remove cluster layer, add plain layer
      if (layers.getArray().includes(clusterSetup.clusterLayer)) {
        olMap.removeLayer(clusterSetup.clusterLayer);
      }
      // Re-add a plain layer if not present
      const hasPlain = layers.getArray().some(
        (l) => l instanceof VectorLayer && (l as VectorLayer<VectorSource>).getSource() === olNodesSourceRef.current
      );
      if (!hasPlain && olNodesSourceRef.current) {
        olMap.addLayer(
          new VectorLayer({
            style: defaultStyle,
            source: olNodesSourceRef.current,
          })
        );
      }
    }
  }, [clusterEnabled, provider, olMap]);

  // OpenLayers: react to linkMode / myNodeId / nodes changes for persistent links
  useEffect(() => {
    if (provider !== "osm") return;
    if (!olMap) return;
    refreshOlPersistentLinks(olMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkMode, myNodeId, nodes, rawTraceroutes, provider, olMap]);

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
        provider={provider}
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
        terrainExaggeration={terrainExaggeration}
        setTerrainExaggeration={setTerrainExaggeration}
        onExport={handleExport}
        hidden={!!detailsData}
      />

      <MapQuickControls
        recentDays={recentDays}
        setRecentDays={setRecentDays}
        linkMode={linkMode}
        setLinkMode={setLinkMode}
        clusterEnabled={clusterEnabled}
        setClusterEnabled={setClusterEnabled}
        roleFilter={roleFilter}
        setRoleFilter={setRoleFilter}
        channelFilter={channelFilter}
        setChannelFilter={setChannelFilter}
        availableChannels={availableChannels}
        resolveChannelLabel={resolveChannelLabel}
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
      {provider === "mapbox" && terrain3D && hoverElevationM != null && (
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
        terrainEnabled={provider === "mapbox" && terrain3D}
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
      {activeTool === "los" && toolStep === "result" && toolFromId && toolToId && (
        <MapLosPanel
          result={losResult}
          fromLabel={(nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8)}
          toLabel={(nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8)}
          fromColor="#22c55e"
          toColor="#06b6d4"
          terrainNeeded={provider === "mapbox" && !terrain3D}
          onEnableTerrain={provider === "mapbox" ? () => setTerrain3D(true) : undefined}
          onClose={resetTool}
          isComputing={provider === "mapbox" && terrain3D && !losResult}
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
          terrainNeeded={provider === "mapbox" && !terrain3D}
          onEnableTerrain={provider === "mapbox" ? () => setTerrain3D(true) : undefined}
          onClose={resetTool}
          isComputing={isComputingCoverage}
          antennaDbi={coverageAntennaDbi}
          onAntennaDbiChange={setCoverageAntennaDbi}
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
          showContours={showCoverageContours}
          onShowContoursChange={setShowCoverageContours}
          onExport={handleCoverageExport}
        />
      )}

      {/* Floating Traceroute panel */}
      {activeTool === "traceroute" && toolStep === "result" && toolFromId && toolToId && (
        <MapTraceroutePanel
          fromId={toolFromId}
          toId={toolToId}
          fromLabel={(nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8)}
          toLabel={(nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8)}
          fromColor="#22c55e"
          toColor="#06b6d4"
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
          terrainNeeded={provider === "mapbox" && !terrain3D}
          onEnableTerrain={provider === "mapbox" ? () => setTerrain3D(true) : undefined}
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
