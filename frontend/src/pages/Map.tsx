import "maplibre-gl/dist/maplibre-gl.css";

import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "../components/toastStore";
import { env } from "../env";
import { useLiveEvent } from "../hooks/useLiveEvent";
import { reverseGeocode } from "../maps/geocoder";
import { buildMapStyle, ensureBuildings3D, ensureTerrain, isDarkBasemap, type OsmBasemap, removeBuildings3D, removeTerrain } from "../maps/mapStyle";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { NodeRole, roleTitles } from "../types";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { normalizeNodeId8 } from "../utils/normalizeNodeId8";
import { prefersReducedMotion } from "../utils/reducedMotion";
import { ActivityLayer } from "./map/activityLayer";
import { ClusterDonutLayer } from "./map/clusterDonutLayer";
import { type ClusterHover,ClusterHoverCard } from "./map/ClusterHoverCard";
import { FiltersResetPill } from "./map/FiltersResetPill";
import { circularMeanLng } from "./map/geo";
import { bestSnr, computeMaxRange, geodesicCircleCoords, mbRoleColorExpr, queryTerrainElevationMSL, relativeTime, signalBarsHtml, TRANSPARENT_1PX_PNG } from "./map/helpers";
import { buildAllLinksFeatureCollection, buildMapboxLinkFeatureCollection, buildTracerouteLinkFeatureCollection, computeHeardByIds, normNodeId } from "./map/linkFeatures";
import { CoverageLookupCard } from "./map/live/CoverageLookupCard";
import { LiveCoveragePill } from "./map/live/LiveCoveragePill";
import { useCoverageLookup } from "./map/live/useCoverageLookup";
import { useServerCoverageTiles } from "./map/live/useServerCoverageTiles";
import { LosTubeLayer } from "./map/losTubeLayer";
import { MapCoveragePanel } from "./map/MapCoveragePanel";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapHealthWidget } from "./map/MapHealthWidget";
import { MapLosPanel } from "./map/MapLosPanel";
import { MapScanPanel } from "./map/MapScanPanel";
import { MapSearchBar } from "./map/MapSearchBar";
import { MapSettingsPanel } from "./map/MapSettingsPanel";
import { MapToolPrompt, MapToolsDrawer } from "./map/MapToolsDrawer";
import { MapTraceroutePanel } from "./map/MapTraceroutePanel";
import { type PacketArc, PacketCoalescer, type RawPacket } from "./map/packetCoalescer";
import { packetColor } from "./map/packetColors";
import { findPathsBetween } from "./map/pathAnalysis";
import {
  autoSpiderfyOverlappingPlainNodes,
  autoSpiderfyVisibleClusters,
  dismissPlainSpiderfy,
  isSpiderfied,
  removeSpiderfyLayers,
  spiderfy,
  SPIDERFY_LAYER_LABELS,
  SPIDERFY_LAYER_NODES,
  SPIDERFY_SOURCE_NODES,
  spiderfyFeatures,
  unspiderfy,
  updateSpiderfyPositions,
} from "./map/spiderfy";
import { LS_KEYS, readJson, writeJson } from "./map/storage";
import type { IMapNode, LinkMode, MapProvider, NodeDetailsData, NodeLike } from "./map/types";
import { useCoverageCompute } from "./map/useCoverageCompute";
import { useCoverageMergeOrigins } from "./map/useCoverageMergeOrigins";
import { useCoverageState } from "./map/useCoverageState";
import { useLosCompute } from "./map/useLosCompute";
import { useLosState } from "./map/useLosState";
import { useScanCompute } from "./map/useScanCompute";
import { useScanState } from "./map/useScanState";
import { useUrlMapSync } from "./map/useUrlMapSync";
import {
  applyClusterVisibility,
  buildNodesGeoJSON,
  DEFAULT_NODE_COLOR,
  emptyLineFeatureCollection,
  escapeHtml,
  nodesDataSignature,
  ROLE_COLORS,
} from "./map/utils";

// Cap arcs spawned per flush so a burst can't stall a frame (drop oldest excess).
const MAX_ARCS_PER_FLUSH = 40;

const samePoint = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

type TraceEv = { from?: number | string; to?: number | string; route_ids?: (number | string)[]; id?: number | string };
// Wait this long for other gateways' copies of one traceroute before drawing the best.
const TRACEROUTE_DEBOUNCE_MS = 1200;

/** Map a reported signal to a 0..1 arc intensity — prefer SNR, fall back to RSSI. */
function packetWeight(rssi?: number, snr?: number): number {
  const clamp = (v: number) => Math.max(0.15, Math.min(1, v));
  if (typeof snr === "number") return clamp((snr + 20) / 30);
  if (typeof rssi === "number") return clamp((rssi + 120) / 90);
  return 0.5;
}

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  // JSON signature skips setData when the GeoJSON is byte-identical across polls
  const persistentLinksMbJsonRef = useRef<string>("");

  const mbMapRef = useRef<MlMap | null>(null);
  const authErrorToastedRef = useRef(false);
  const clusterDonutLayerRef = useRef<ClusterDonutLayer | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const mapLoadFallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Currently hover-focused node id, or null. Drives focus-on-hover dimming
   *  alongside the per-tool dim — the cluster layer applies whichever is dimmer. */
  const focusedNodeIdRef = useRef<string | null>(null);
  // Sticky after first style.load — `isStyleLoaded()` momentarily lies post-removeSource.
  const styleEverLoadedRef = useRef(false);
  const mbSelectedIdRef = useRef<string | null>(null);
  // Last node-source signature; skips redundant setData. -1 = never set.
  const lastNodesSigRef = useRef<number>(-1);
  // Live packet-arc animation plumbing.
  const activityLayerRef = useRef<ActivityLayer | null>(null);
  const coalescerRef = useRef<PacketCoalescer | null>(null);
  const pendingArcsRef = useRef<PacketArc[]>([]);
  const flushRafRef = useRef<number | null>(null);
  // Per-mesh-id debounce of multi-gateway traceroute copies → one comet, longest route.
  const tracerouteBufRef = useRef<Map<string, { ev: TraceEv; timer: ReturnType<typeof setTimeout> }> | null>(null);
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
  const { data: rawTraceroutes = [], isLoading: rawTraceroutesLoading } = useGetTraceroutesQuery();

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

  const [livePackets, setLivePackets] = useState<boolean>(() => readJson<boolean>(LS_KEYS.livePackets, true));
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
  // Cosmetic 3D buildings (OpenFreeMap). Off by default to keep slow devices light.
  const [buildings3D, setBuildings3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.buildings3D, false));

  // Live network-coverage layer: a server-baked raster tile pyramid (compute is
  // server-side; this only show/hides + sets opacity). Off (hidden) by default.
  const [liveCoverage, setLiveCoverage] = useState<boolean>(() => readJson<boolean>(LS_KEYS.liveCoverage, false));
  const [liveCoverageOpacity, setLiveCoverageOpacity] = useState<number>(
    () => readJson<number>(LS_KEYS.liveCoverageOpacity, 0.6),
  );
  const [liveCoverageHideNodes, setLiveCoverageHideNodes] = useState<boolean>(
    () => readJson<boolean>(LS_KEYS.liveCoverageHideNodes, true),
  );
  const nodesHidden = liveCoverage && liveCoverageHideNodes;

  // RF tool state hooks (own settings + result state)
  const losState = useLosState();
  const coverage = useCoverageState();
  const scan = useScanState();

  /** 3D LoS tube layer; created once per map. */
  const losTubeLayerRef = useRef<LosTubeLayer | null>(null);
  /** Suppresses the cursor-elevation mousemove handler so marker drag doesn't stutter. */
  const isDraggingMarkerRef = useRef(false);
  /** Terrain elevation (MSL m) under the cursor. */
  const [hoverElevationM, setHoverElevationM] = useState<number | null>(null);

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
  useEffect(() => writeJson(LS_KEYS.livePackets, livePackets), [livePackets]);
  useEffect(() => writeJson(LS_KEYS.linkMode, linkMode), [linkMode]);
  useEffect(() => writeJson(LS_KEYS.myNodeId, myNodeId), [myNodeId]);
  useEffect(() => writeJson(LS_KEYS.settingsPanelOpen, settingsPanelOpen), [settingsPanelOpen]);
  useEffect(() => writeJson(LS_KEYS.terrain3D, terrain3D), [terrain3D]);
  useEffect(() => writeJson(LS_KEYS.buildings3D, buildings3D), [buildings3D]);
  useEffect(() => writeJson(LS_KEYS.liveCoverage, liveCoverage), [liveCoverage]);
  useEffect(() => writeJson(LS_KEYS.liveCoverageOpacity, liveCoverageOpacity), [liveCoverageOpacity]);
  useEffect(() => writeJson(LS_KEYS.liveCoverageHideNodes, liveCoverageHideNodes), [liveCoverageHideNodes]);

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
  const [clusterHover, setClusterHover] = useState<ClusterHover | null>(null);

  // Coverage merge origins (session-scoped; depends on nodes + toolFromId for primary-id exclusion)
  const mergeOrigins = useCoverageMergeOrigins(nodes, toolFromId);

  // URL deep-link + view sync
  const { searchParams, flyToTargetRef, pushViewToUrlRef } = useUrlMapSync(nodes, mbMapRef);

  // Refs mirroring state — read from MapLibre event handlers + setStyle re-init
  const nodesRef = useRef(nodes);
  const traceroutesRef = useRef(rawTraceroutes);
  const configRef = useRef(config);
  const recentDaysRef = useRef(recentDays);
  const clusterEnabledRef = useRef(clusterEnabled);
  const nodesHiddenRef = useRef(nodesHidden);
  const livePacketsRef = useRef(livePackets);
  const linkModeRef = useRef(linkMode);
  const myNodeIdRef = useRef(myNodeId);
  const roleFilterRef = useRef(roleFilter);
  const channelFilterRef = useRef(channelFilter);
  const activeToolRef = useRef(activeTool);
  const toolStepRef = useRef(toolStep);
  const toolFromIdRef = useRef(toolFromId);

  const isPickingNode = activeTool != null && toolStep !== "result";
  const terrain3DRef = useRef(terrain3D);
  const buildings3DRef = useRef(buildings3D);
  const setDetailsDataRef = useRef(setDetailsData);
  const serverNodeRef = useRef(serverNode);
  const pendingServerCenterRef = useRef(false);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { serverNodeRef.current = serverNode; }, [serverNode]);
  useEffect(() => { traceroutesRef.current = rawTraceroutes; }, [rawTraceroutes]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { setDetailsDataRef.current = setDetailsData; }, [setDetailsData]);
  useEffect(() => { recentDaysRef.current = recentDays; }, [recentDays]);
  useEffect(() => { clusterEnabledRef.current = clusterEnabled; }, [clusterEnabled]);
  useEffect(() => { nodesHiddenRef.current = nodesHidden; }, [nodesHidden]);
  useEffect(() => {
    livePacketsRef.current = livePackets;
    clusterDonutLayerRef.current?.setAnimationsEnabled(livePackets);
  }, [livePackets]);
  useEffect(() => { linkModeRef.current = linkMode; }, [linkMode]);
  useEffect(() => { roleFilterRef.current = roleFilter; }, [roleFilter]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { toolStepRef.current = toolStep; }, [toolStep]);
  useEffect(() => { toolFromIdRef.current = toolFromId; }, [toolFromId]);
  useEffect(() => { terrain3DRef.current = terrain3D; }, [terrain3D]);
  useEffect(() => { buildings3DRef.current = buildings3D; }, [buildings3D]);
  useEffect(() => { channelFilterRef.current = channelFilter; }, [channelFilter]);
  useEffect(() => { myNodeIdRef.current = myNodeId; }, [myNodeId]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (mb) {
      mb.getCanvas().style.cursor = isPickingNode ? "crosshair" : "";
    }
  }, [isPickingNode]);

  // LOS compute + tube layer effects
  const losCompute = useLosCompute({
    activeTool, toolStep, toolFromId, toolToId,
    losVirtualFrom: losState.losVirtualFrom,
    losVirtualTo: losState.losVirtualTo,
    losFromHeightM: losState.losFromHeightM,
    losToHeightM: losState.losToHeightM,
    provider, terrain3D, nodes,
    losResult: losState.losResult,
    mbMapRef, losTubeLayerRef,
    setLosResult: losState.setLosResult,
    setLosDemSource: losState.setLosDemSource,
    setLosError: losState.setLosError,
    setIsComputingLos: losState.setIsComputingLos,
  });

  // Scan compute + per-class visibility + clear-on-tool-change + hover effects
  const scanCompute = useScanCompute({
    activeTool, toolStep, toolFromId, toolVirtualPos,
    provider, terrain3D, nodes,
    scanTxDbm: scan.scanTxDbm,
    scanAntennaDbi: scan.scanAntennaDbi,
    scanRxAntennaDbi: scan.scanRxAntennaDbi,
    scanEffectiveSensitivityDbm: scan.scanEffectiveSensitivityDbm,
    scanAggressionIdx: scan.scanAggressionIdx,
    scanClutterEnabled: scan.scanClutterEnabled,
    scanCanopyEnabled: scan.scanCanopyEnabled,
    scanBuildingsEnabled: scan.scanBuildingsEnabled,
    scanAntennaHeightM: scan.scanAntennaHeightM,
    scanReliability: scan.scanReliability,
    hiddenScanClasses: scan.hiddenScanClasses,
    scanSummary: scan.scanSummary,
    scanHoverId: scan.scanHoverId,
    mbMapRef, isDraggingMarkerRef,
    setScanSummary: scan.setScanSummary,
    setIsScanning: scan.setIsScanning,
    setScanError: scan.setScanError,
    setScanDemSource: scan.setScanDemSource,
    setScanClutterStatus: scan.setScanClutterStatus,
    setScanCanopyStatus: scan.setScanCanopyStatus,
    setScanBuildingsStatus: scan.setScanBuildingsStatus,
    setToolFromId, setToolVirtualPos,
  });

  // Coverage compute + render + origin marker + drag preview + merge markers
  const coverageCompute = useCoverageCompute({
    coverage,
    activeTool, toolStep, toolFromId, toolVirtualPos,
    setToolFromId, setToolVirtualPos,
    provider, terrain3D, nodes,
    mbMapRef, isDraggingMarkerRef,
    coverageMergeOrigins: mergeOrigins.coverageMergeOrigins,
    setCoverageMergeOrigins: mergeOrigins.setCoverageMergeOrigins,
    pickingMergeOrigin: mergeOrigins.pickingMergeOrigin,
    setPickingMergeOrigin: mergeOrigins.setPickingMergeOrigin,
    moveCoverageMergeOrigin: mergeOrigins.moveCoverageMergeOrigin,
  });

  // Live network-coverage layer — server-baked raster tiles (meshinfo /tiles/coverage),
  // refreshed on the `coverage` SSE event. No client-side RF compute.
  const liveCoverageState = useServerCoverageTiles({
    mbMapRef,
    enabled: liveCoverage,
    mapReady: mapLoaded,
    opacity: liveCoverageOpacity,
  });
  const coverageHover = useCoverageLookup({
    mbMapRef,
    enabled: liveCoverage && liveCoverageState.status === "ready",
    mapReady: mapLoaded,
    suspended: activeTool != null,
  });

  // Reset the whole tool state. Also imperatively clears map visual geometry
  // so there's no one-tick flash of stale tubes / rasters / scan lines while
  // React re-runs the dependent effects.
  const resetTool = () => {
    setActiveTool(null);
    setToolStep("pickFrom");
    setToolFromId(null);
    setToolToId(null);
    setToolVirtualPos(null);
    losState.setLosVirtualFrom(null);
    losState.setLosVirtualTo(null);
    losCompute.losFitKeyRef.current = null;
    losCompute.losFromPosRef.current = null;
    losCompute.losToPosRef.current = null;
    losCompute.losHoverMarkerRef.current?.remove();
    losCompute.losHoverMarkerRef.current = null;
    losState.setLosResult(null);
    losState.setLosError(null);
    coverage.setCoverageResult(null);
    coverage.setKeepCoveragePaint(false);
    scan.setScanSummary(null);
    coverage.setIsComputingCoverage(false);
    coverage.setIsFetchingCoverageTerrain(false);
    coverage.setCoverageError(null);
    coverage.setCoverageProgress({ completed: 0, total: 0 });
    coverage.setCoverageDemSource(null);
    losState.setLosDemSource(null);
    scan.setScanDemSource(null);
    scan.setIsScanning(false);

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
      if (coverageCompute.coverageOriginMarkerRef.current) {
        coverageCompute.coverageOriginMarkerRef.current.remove();
        coverageCompute.coverageOriginMarkerRef.current = null;
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
        type UpdateImageFn = (o: { url: string; coordinates: [[number, number], [number, number], [number, number], [number, number]] }) => void;
        const updateImage = (rasterSrc as unknown as { updateImage?: UpdateImageFn } | undefined)?.updateImage;
        if (rasterSrc && typeof updateImage === "function") {
          updateImage.call(rasterSrc, {
            url: TRANSPARENT_1PX_PNG,
            coordinates: [[-180, 85], [180, 85], [180, -85], [-180, -85]],
          });
        }
        if (coverageCompute.coverageRasterUrlRef.current) {
          URL.revokeObjectURL(coverageCompute.coverageRasterUrlRef.current);
          coverageCompute.coverageRasterUrlRef.current = null;
        }
      } catch {}
      losTubeLayerRef.current?.setData(null);
      coverageCompute.coverageContoursRef.current = null;
      coverageCompute.coverageRaysRef.current = null;
      coverageCompute.coverageMarginRef.current = null;
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

  /** Cluster donut + count text dim. Combines the tool-active dim (when an RF
   *  tool is in result step, so the raster reads clearly) with focus-on-hover
   *  dim (everything outside the hovered node's ego-network), taking whichever
   *  is dimmer. Reads from refs so it's safe to call from any code path. */
  const applyClusterDim = () => {
    const toolDim = activeToolRef.current != null && toolStepRef.current === "result" ? 0.25 : 1;
    const focusDim = focusedNodeIdRef.current != null ? 0.2 : 1;
    const alpha = Math.min(toolDim, focusDim);

    clusterDonutLayerRef.current?.setAlpha(alpha);

    const mb = mbMapRef.current;
    if (mb && mb.getLayer("clusters-count")) {
      try { mb.setPaintProperty("clusters-count", "text-opacity", alpha); } catch {}
    }
  };

  useEffect(() => {
    applyClusterDim();
  }, [activeTool, toolStep]);

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

    const map = mbMapRef.current;
    if (map) {
      try {
        // Capture on the next actually-drawn frame (custom layers included);
        // fall back to a timeout if 'idle' never fires.
        let done = false;
        const capture = () => {
          if (done) return;
          done = true;
          try {
            triggerDownload(map.getCanvas().toDataURL("image/png"));
            toast("Map exported as PNG", { kind: "success" });
          } catch (err) {
            console.error("Map export failed:", err);
            toast("Couldn't export the map", { kind: "error" });
          }
        };
        map.triggerRepaint();
        map.once("idle", capture);
        setTimeout(capture, 1500);
      } catch (err) {
        console.error("Map export failed:", err);
        toast("Couldn't export the map", { kind: "error" });
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
      serverNodeRef.current?.map_position
        ? serverNodeRef.current
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

    const hasExplicitCenter =
      !!flyTarget ||
      (Number.isFinite(urlLng) && Number.isFinite(urlLat)) ||
      (savedLon !== undefined && savedLat !== undefined);

    pendingServerCenterRef.current = !hasExplicitCenter && !fallbackNodeWithPos;

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
    // MapLibre 5 lands compact attributions EXPANDED on first content (sets
    // `maplibregl-compact-show` + <details open>). MutationObserver beats the
    // paint — microtask drains before render, so no flicker. once('idle') was
    // too late: it fires after the browser has already painted the open state.
    const attribEl = map.getContainer().querySelector<HTMLElement>(".maplibregl-ctrl-attrib");
    if (attribEl) {
      const observer = new MutationObserver(() => {
        if (attribEl.classList.contains("maplibregl-compact-show")) {
          attribEl.classList.remove("maplibregl-compact-show");
          attribEl.removeAttribute("open");
          observer.disconnect();
        }
      });
      observer.observe(attribEl, { attributes: true, attributeFilter: ["class", "open"] });
    }

    mbMapRef.current = map;

    // Surface style/source/tile load failures instead of a silent blank map.
    map.on("error", (e) => {
      const err = e.error as { status?: number } | undefined;
      if (import.meta.env.DEV) console.warn("[Map] GL error:", err ?? e);
      if (!authErrorToastedRef.current && (err?.status === 401 || err?.status === 403)) {
        authErrorToastedRef.current = true;
        toast("Map tiles failed to load — the Mapbox token may be missing or invalid.", { kind: "error" });
      }
    });

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
      // Mirror view into ?lat/lng/z (debounced); here so it follows recreation.
      pushViewToUrlRef.current();
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

      // The live network-coverage layer (server-baked raster tiles) is added
      // dynamically by useServerCoverageTiles once /v1/coverage/metadata is known.

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
        // 0.6 = unknown-recency default (see recencyOpacityFromAgeMs).
        ["*", base, ["coalesce", ["get", "recencyOpacity"], 0.6]] as any;

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
        donutLayer.setAnimationsEnabled(livePacketsRef.current);
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
            // Recency brightness via `dim`; selected stays full-bright.
            "circle-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
            "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
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
            // Recency brightness via `dim`; selected stays full-bright.
            "circle-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
            "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
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

      // Live packet activity (custom WebGL layer; drawn above nodes)
      if (!map.getLayer("activity")) {
        const al = new ActivityLayer();
        map.addLayer(al);
        activityLayerRef.current = al;
      }

      // Apply current cluster visibility (use refs to avoid stale closure)
      applyClusterVisibility(map, clusterEnabledRef.current, nodesHiddenRef.current);

      // Re-apply terrain if it was enabled (style.load wipes this)
      if (terrain3DRef.current) {
        try {
          ensureTerrain(map, terrainExaggeration, isDarkBasemap(provider, osmBasemap, mapboxStyle));
        } catch (err) {
          console.warn("[Map] Terrain re-apply failed after style load:", err);
        }
      }
      if (buildings3DRef.current) {
        try {
          ensureBuildings3D(map, isDarkBasemap(provider, osmBasemap, mapboxStyle));
        } catch (err) {
          console.warn("[Map] 3D buildings re-apply failed after style load:", err);
        }
      }

      // Ensure sources have current data (important after style changes)
      refreshMapboxNodeData();

      // Bind handlers once
      if (mbHandlersBoundRef.current) return;
      mbHandlersBoundRef.current = true;

      const handleNodeClick = (id: string) => {
        const liveNodes = nodesRef.current;
        const node = liveNodes[id];
        if (!node?.map_position) return;

        selectedNodeIdRef.current = id;
        setSelected(id);

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
          displayName: "Locating…",
          elsewhereLinks: configRef.current?.mesh?.elsewhere_links,
          traceroutes: traceroutesRef.current,
          channelLabel: resolveChannelLabel((node as any).last_channel),
          heardBy,
          maxRangeKm,
        });

        // Geocode without blocking the panel; ignore the result if selection moved on.
        void reverseGeocode(node.map_position[0], node.map_position[1])
          .then((name) => {
            if (selectedNodeIdRef.current !== id) return;
            setDetailsDataRef.current((prev) =>
              prev && prev.node.id === id ? { ...prev, displayName: name || "—" } : prev,
            );
          })
          .catch(() => {});

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
      // const NODE_DIM_OPACITY = 0.2;  // Re-enable with the disabled block in applyLinkFocus.

      const recencyExpr = ["coalesce", ["get", "recencyOpacity"], 0.6] as any;

      const linkOpacityForFocus = (base: number, focusedId: string | null) => {
        if (!focusedId) return ["*", base, recencyExpr] as any;
        return [
          "case",
          ["any", ["==", ["get", "aId"], focusedId], ["==", ["get", "bId"], focusedId]],
          ["*", base, recencyExpr],
          ["*", LINK_DIM_OPACITY, recencyExpr],
        ] as any;
      };

      // Node + cluster dimming helpers — kept for easy re-enable; see applyLinkFocus.
      // const nodeOpacityForFocus = (relatedIds: string[] | null) => {
      //   if (!relatedIds || relatedIds.length === 0) return 1.0 as any;
      //   return [
      //     "case",
      //     ["match", ["get", "id"], relatedIds, true, false],
      //     1.0,
      //     NODE_DIM_OPACITY,
      //   ] as any;
      // };
      //
      // const collectRelatedIds = (focusedId: string): string[] => {
      //   const liveNodes = nodesRef.current;
      //   const ids = new Set<string>([focusedId]);
      //   const focusedNode = liveNodes[focusedId] ?? liveNodes[`!${focusedId}`];
      //   for (const nb of focusedNode?.neighbors ?? []) ids.add(nb.id);
      //   // heardBy: nodes whose neighbor list includes the focused node
      //   for (const [otherId, other] of Object.entries(liveNodes)) {
      //     if (other.neighbors?.some((n) => n.id === focusedId)) ids.add(otherId);
      //   }
      //   return [...ids];
      // };

      const applyLinkFocus = (focusedId: string | null) => {
        for (const [layerId, base] of Object.entries(LINK_LAYER_BASE_OPACITY)) {
          if (map.getLayer(layerId)) {
            try { map.setPaintProperty(layerId, "line-opacity", linkOpacityForFocus(base, focusedId)); } catch {}
          }
        }

        // Node + cluster dimming intentionally disabled — pure link focus reads
        // cleanly without the ambient nodes/clusters fading away. Re-enable as
        // a single block if we want full ego-network dimming back.
        // focusedNodeIdRef.current = focusedId;
        // const related = focusedId ? collectRelatedIds(focusedId) : null;
        // const nodeExpr = nodeOpacityForFocus(related);
        // for (const layerId of ["plain-nodes", "unclustered-nodes"]) {
        //   if (map.getLayer(layerId)) {
        //     try { map.setPaintProperty(layerId, "circle-opacity", nodeExpr); } catch {}
        //   }
        // }
        // applyClusterDim();
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
        // getClusterExpansionZoom can be slow on first call; don't discard a slightly-late answer.
        const timer = setTimeout(zoomFallback, 600);

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

      // Live cluster hover card (display-only; closes on map move to avoid drift)
      let clusterHoverTimer: number | null = null;
      let hoveredClusterId: number | null = null;
      const readCluster = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        const cid = f?.properties?.cluster_id;
        if (f == null || cid == null) return null;
        const [lng, lat] = (f.geometry as any).coordinates as [number, number];
        return {
          cid: cid as number,
          lng,
          lat,
          count: (f.properties?.point_count as number) ?? 0,
          online: (f.properties?.onlineCount as number) ?? 0,
        };
      };
      const fillClusterHover = (cid: number, lng: number, lat: number, count: number, online: number) => {
        const p = map.project([lng, lat]);
        setClusterHover({ ids: [], count, online, x: p.x, y: p.y });
        const source = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
        source
          ?.getClusterLeaves(cid, Infinity, 0)
          .then((feats) => {
            if (hoveredClusterId !== cid) return;
            const ids = (feats ?? [])
              .map((f) => String((f.properties as any)?.id ?? ""))
              .filter(Boolean);
            setClusterHover((prev) => (prev ? { ...prev, ids } : null));
          })
          .catch(() => {});
      };
      const onClusterIntent = (c: { cid: number; lng: number; lat: number; count: number; online: number }) => {
        hoveredClusterId = c.cid;
        if (clusterHoverTimer != null) clearTimeout(clusterHoverTimer);
        clusterHoverTimer = window.setTimeout(
          () => fillClusterHover(c.cid, c.lng, c.lat, c.count, c.online),
          120,
        );
      };
      const closeClusterHover = () => {
        hoveredClusterId = null;
        if (clusterHoverTimer != null) {
          clearTimeout(clusterHoverTimer);
          clusterHoverTimer = null;
        }
        setClusterHover(null);
      };
      map.on("mouseenter", "clusters", (e) => {
        const c = readCluster(e);
        if (c) onClusterIntent(c);
      });
      map.on("mousemove", "clusters", (e) => {
        const c = readCluster(e);
        if (c && c.cid !== hoveredClusterId) onClusterIntent(c);
      });
      map.on("mouseleave", "clusters", closeClusterHover);
      map.on("movestart", closeClusterHover);

      // Distinct plain nodes whose circles overlap near `point` (clustering off).
      // Circle radius is 8px, so a one-radius box catches genuinely-stacked nodes.
      const OVERLAP_PX = 8;
      const findOverlappingPlainNodes = (
        point: maplibregl.Point,
      ): GeoJSON.Feature<GeoJSON.Point>[] => {
        if (!map.getLayer("plain-nodes")) return [];
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
          [point.x - OVERLAP_PX, point.y - OVERLAP_PX],
          [point.x + OVERLAP_PX, point.y + OVERLAP_PX],
        ];
        const feats = map.queryRenderedFeatures(bbox, { layers: ["plain-nodes"] });
        const seen = new Set<string>();
        const out: GeoJSON.Feature<GeoJSON.Point>[] = [];
        for (const f of feats) {
          const id = (f.properties?.id ?? "") as string;
          if (!id || seen.has(id) || f.geometry?.type !== "Point") continue;
          seen.add(id);
          out.push(f as unknown as GeoJSON.Feature<GeoJSON.Point>);
        }
        return out;
      };

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

        // Clustering OFF: co-located nodes stack so only the top one is
        // clickable. If several overlap at the click, fan them out instead of
        // selecting whichever rendered on top. (#475)
        if (!clusterEnabledRef.current && !isSpiderfied(map)) {
          const overlap = findOverlappingPlainNodes(e.point);
          if (overlap.length >= 2) {
            const center: [number, number] = [
              circularMeanLng(overlap.map((f) => f.geometry.coordinates[0])),
              overlap.reduce((s, f) => s + f.geometry.coordinates[1], 0) / overlap.length,
            ];
            void spiderfyFeatures(map, center, overlap as any, map.getZoom(), true);
            return;
          }
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
          losState.setLosVirtualFrom([e.lngLat.lng, e.lngLat.lat]);
          setToolStep("pickTo");
        } else if (t === "los" && step === "pickTo") {
          setToolToId(null);
          losState.setLosVirtualTo([e.lngLat.lng, e.lngLat.lat]);
          setToolStep("result");
          map.getCanvas().style.cursor = "";
        }
      });

      bindHover(SPIDERFY_LAYER_NODES);

      // Clicking empty space clears selection and collapses spiderfy
      map.on("click", (e) => {
        // While an RF tool is mid-pick, an empty click is dropping a virtual
        // origin — don't also clear the selection/spiderfy.
        if (activeToolRef.current && toolStepRef.current !== "result") return;

        // Build the list of interactive layers, including spiderfy layers if present
        const nodeLayers = ["unclustered-nodes", "plain-nodes", "unclustered-labels", "plain-labels"];
        if (map.getLayer(SPIDERFY_LAYER_NODES)) nodeLayers.push(SPIDERFY_LAYER_NODES);
        if (map.getLayer(SPIDERFY_LAYER_LABELS)) nodeLayers.push(SPIDERFY_LAYER_LABELS);

        const hitNode = map.queryRenderedFeatures(e.point, { layers: nodeLayers }).length > 0;
        const hitCluster =
          map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        // Clustering off: fans are automatic, so dismiss-and-remember (the auto
        // pass won't immediately re-open the same set). Clustering on: a cluster
        // donut stays put, so a plain collapse is fine.
        if (clusterEnabledRef.current) void unspiderfy(map);
        else dismissPlainSpiderfy(map);
        clearMapboxSelectionAndOverlays();
      });

      // Update spiderfy positions when zoom changes (keeps fan-out consistent)
      map.on("zoomend", () => {
        updateSpiderfyPositions(map);
      });

      // Auto-spiderfy stacked nodes once zoomed in. Clustering ON: fan clusters
      // whose children can't be separated by further zoom. Clustering OFF: fan
      // the largest group of plain nodes whose circles overlap at this zoom.
      // Driven by moveend (reliable, independent of GL render state) with `idle`
      // as a backup and a one-shot on `load` for the initial view. Debounced so
      // a single gesture doesn't run multiple passes.
      let spiderfyDebounce: number | null = null;
      const triggerAutoSpiderfy = () => {
        if (spiderfyDebounce != null) window.clearTimeout(spiderfyDebounce);
        spiderfyDebounce = window.setTimeout(() => {
          spiderfyDebounce = null;
          if (nodesHiddenRef.current) return;
          if (clusterEnabledRef.current) {
            const pool = buildNodesGeoJSON(nodesRef.current, recentDaysRef.current, getFilters()).features
              .filter((f) => f.geometry?.type === "Point") as any;
            void autoSpiderfyVisibleClusters(map, pool);
          } else {
            void autoSpiderfyOverlappingPlainNodes(map);
          }
        }, 150);
      };
      map.on("moveend", triggerAutoSpiderfy);
      map.on("idle", triggerAutoSpiderfy);
      map.once("load", triggerAutoSpiderfy);
      // Clear the loading overlay on first render; backstop in case 'load' never
      // fires (hard style/tile/token failure emits 'error', not 'load').
      mapLoadFallbackRef.current = window.setTimeout(() => setMapLoaded(true), 10000);
      map.once("load", () => { setMapLoaded(true); if (mapLoadFallbackRef.current) clearTimeout(mapLoadFallbackRef.current); });

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

        // Escape works from anywhere; pan/zoom only when focus is on the map
        // itself (or nothing), so arrowing a focused panel control isn't hijacked.
        if (e.key !== "Escape") {
          const ae = document.activeElement as HTMLElement | null;
          const navOk =
            !ae ||
            ae === document.body ||
            ae === map.getCanvas() ||
            ae === mapRef.current ||
            ae.classList?.contains("maplibregl-canvas");
          if (!navOk) return;
        }

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

      // Only rebuild the popup HTML when the hovered link changes; otherwise just
      // move it (setLngLat) as the cursor travels along the same link.
      let lastLinkKey: string | null = null;
      const showLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties ?? {};
        lastLinkKey = `${props.aId}|${props.bId}`;
        linkPopup.setLngLat(e.lngLat).setHTML(buildLinkPopupHtml(props)).addTo(map);
      };
      const moveLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties ?? {};
        const key = `${props.aId}|${props.bId}`;
        if (key !== lastLinkKey) {
          lastLinkKey = key;
          linkPopup.setHTML(buildLinkPopupHtml(props));
        }
        linkPopup.setLngLat(e.lngLat);
      };
      const hideLinkPopup = () => { lastLinkKey = null; linkPopup.remove(); };

      for (const layerId of ["links-solid", "links-dashed", "links-dotted"]) {
        map.on("mouseenter", layerId, showLinkPopup);
        map.on("mousemove", layerId, moveLinkPopup);
        map.on("mouseleave", layerId, hideLinkPopup);
      }
    };

    map.on("style.load", () => { styleEverLoadedRef.current = true; });
    map.on("style.load", ensureSourcesAndLayers);

    return () => {
      if (mapLoadFallbackRef.current) clearTimeout(mapLoadFallbackRef.current);
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
  }, []);

  useEffect(() => {
    if (!pendingServerCenterRef.current) return;
    const map = mbMapRef.current;
    if (!map) return;
    const target = serverNode?.map_position
      ? serverNode
      : Object.values(nodesRef.current).find((n) => n.map_position);
    if (!target?.map_position) return;
    pendingServerCenterRef.current = false;
    map.jumpTo({ center: [target.map_position[0], target.map_position[1]] });
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

  // Cluster toggle + coverage-layer node hiding
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    applyClusterVisibility(map, clusterEnabled, nodesHidden);
  }, [clusterEnabled, nodesHidden]);

  // Initial mount is handled by ensureSourcesAndLayers on style.load; this only runs live toggles.
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map || !styleEverLoadedRef.current) return;

    try {
      if (terrain3D) {
        ensureTerrain(map, terrainExaggeration, isDarkBasemap(provider, osmBasemap, mapboxStyle));
      } else {
        removeTerrain(map);
      }
    } catch (err) {
      console.warn("[Map] Terrain apply failed:", err);
    }
  }, [terrain3D, provider, mapboxToken, mapboxStyle, osmBasemap]);

  useEffect(() => {
    const map = mbMapRef.current;
    if (!map || !styleEverLoadedRef.current) return;
    try {
      if (buildings3D) ensureBuildings3D(map, isDarkBasemap(provider, osmBasemap, mapboxStyle));
      else removeBuildings3D(map);
    } catch (err) {
      console.warn("[Map] 3D buildings apply failed:", err);
    }
  }, [buildings3D, provider, mapboxToken, mapboxStyle, osmBasemap]);

  // Live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const data = buildNodesGeoJSON(nodes, recentDays, { role: roleFilter, channel: channelFilter });

    // Skip re-upload when visible state is unchanged; each nodes_clustered
    // setData forces a full cluster-donut rebuild.
    const sig = nodesDataSignature(data);
    if (sig !== lastNodesSigRef.current) {
      lastNodesSigRef.current = sig;
      const clustered = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
      clustered?.setData(data);

      const plain = map.getSource("nodes_plain") as MlGeoJSONSource | undefined;
      plain?.setData(data);
    }

    // If selected node disappears, clear selection + links/panel
    const selectedId = mbSelectedIdRef.current;
    if (selectedId) {
      // Check the unfiltered nodes: a filtered-out node keeps its panel open.
      const stillExists = Boolean(nodes[selectedId]);
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

  // Live packet arcs: resolve from→sender positions and spawn into the layer.
  const flushPacketArcs = useCallback(() => {
    flushRafRef.current = null;
    const layer = activityLayerRef.current;
    const all = pendingArcsRef.current;
    pendingArcsRef.current = [];
    if (!layer || all.length === 0) return;
    // Drop oldest excess on a burst; keep the most recent so the feed stays live.
    const arcs = all.length > MAX_ARCS_PER_FLUSH ? all.slice(-MAX_ARCS_PER_FLUSH) : all;
    const liveNodes = nodesRef.current;
    const now = performance.now();

    // With clustering on, snap endpoints to the donut that visually covers them so
    // arcs line up with the clusters on screen. Project cluster centroids once.
    const map = mbMapRef.current;
    const projected =
      clusterEnabledRef.current && map && clusterDonutLayerRef.current
        ? clusterDonutLayerRef.current.visibleClusters().map((c) => {
            const p = map.project([c.lng, c.lat]);
            return { x: p.x, y: p.y, r: c.r, lngLat: [c.lng, c.lat] as [number, number] };
          })
        : null;
    const anchor = (pos: [number, number]): [number, number] => {
      if (!projected || !map) return pos;
      const p = map.project(pos);
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const c of projected) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d <= c.r && d < bestD) {
          bestD = d;
          best = c.lngLat;
        }
      }
      return best ?? pos;
    };

    layer.beginBatch(); // coalesce this flush into one GPU upload
    for (const a of arcs) {
      const fromRaw = liveNodes[a.fromId]?.map_position;
      const senderRaw = liveNodes[a.senderId]?.map_position;
      const fromPos = fromRaw ? anchor(fromRaw) : undefined;
      const senderPos = senderRaw ? anchor(senderRaw) : undefined;
      const color = packetColor(a.type);
      if (a.isNewTransmission && fromPos) layer.spawnPulse(fromPos, color, now);
      if (fromPos && senderPos && !samePoint(fromPos, senderPos)) {
        layer.spawnArc(fromPos, senderPos, color, packetWeight(a.rssi, a.snr), now);
      } else if (!fromPos && senderPos) {
        layer.spawnRipple(senderPos, color, now); // heard, origin position unknown
      }
    }
    layer.endBatch();
  }, []);

  useLiveEvent<RawPacket>("packet", (p) => {
    if (!livePacketsRef.current || prefersReducedMotion()) return;
    if (p.type === "traceroute") return; // handled by the dedicated multi-hop tracer
    const coalescer = (coalescerRef.current ??= new PacketCoalescer());
    const arc = coalescer.ingest(p, Date.now());
    if (!arc) return;
    pendingArcsRef.current.push(arc);
    if (flushRafRef.current == null) flushRafRef.current = requestAnimationFrame(flushPacketArcs);
  });

  // Resolve a traceroute's hops to positions and draw one sequential comet along
  // [from, ...route, to], snapping each hop to its cluster and skipping hops with
  // no known position.
  const animateTraceroute = useCallback((t: TraceEv) => {
    const layer = activityLayerRef.current;
    if (!layer) return;
    const liveNodes = nodesRef.current;
    const map = mbMapRef.current;
    const donut = clusterDonutLayerRef.current;
    const clusters = clusterEnabledRef.current && map && donut ? donut.visibleClusters() : null;
    const snap = (pos: [number, number]): [number, number] => {
      if (!clusters || !map) return pos;
      const p = map.project(pos);
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const c of clusters) {
        const cp = map.project([c.lng, c.lat]);
        const d = Math.hypot(cp.x - p.x, cp.y - p.y);
        if (d <= c.r && d < bestD) {
          bestD = d;
          best = [c.lng, c.lat];
        }
      }
      return best ?? pos;
    };
    const pts: [number, number][] = [];
    for (const raw of [t.from, ...(t.route_ids ?? []), t.to]) {
      const id = normalizeNodeId8(raw);
      const pos = id ? liveNodes[id]?.map_position : undefined;
      if (!pos) continue; // hop with unknown position — skip (honest gap)
      const a = snap(pos);
      const last = pts[pts.length - 1];
      if (!last || !samePoint(last, a)) pts.push(a); // collapse same-cluster hops
    }
    if (pts.length === 0) return;
    layer.spawnPath(pts, packetColor("traceroute"), 0.9, performance.now());
  }, []);

  // The same traceroute is uploaded by many gateways with divergent recorded
  // routes; debounce by mesh id and draw only the single most complete path.
  useLiveEvent<TraceEv>("traceroute", (t) => {
    if (!livePacketsRef.current || prefersReducedMotion()) return;
    const buf = (tracerouteBufRef.current ??= new globalThis.Map());
    const key = t.id != null ? `id:${t.id}` : `ft:${t.from}:${t.to}`;
    const existing = buf.get(key);
    if (existing) {
      if ((t.route_ids?.length ?? 0) > (existing.ev.route_ids?.length ?? 0)) existing.ev = t;
      return;
    }
    const timer = setTimeout(() => {
      const entry = buf.get(key);
      buf.delete(key);
      if (entry) animateTraceroute(entry.ev);
    }, TRACEROUTE_DEBOUNCE_MS);
    buf.set(key, { ev: t, timer });
  });

  useEffect(
    () => () => {
      if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
      const buf = tracerouteBufRef.current;
      if (buf) {
        for (const { timer } of buf.values()) clearTimeout(timer);
        buf.clear();
      }
    },
    [],
  );

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
      <div
        id="map"
        ref={mapRef}
        role="application"
        aria-label="Mesh node map"
        aria-describedby="map-a11y-hint"
        className="absolute inset-0"
      />
      <p id="map-a11y-hint" className="sr-only">
        Interactive map of mesh nodes. Use the search box to find and select a node by name.
        Arrow keys pan and plus or minus zoom while the map is focused.
      </p>
      <div className="sr-only" aria-live="polite">
        {detailsData
          ? `Selected ${detailsData.node.longname || detailsData.node.shortname || detailsData.node.id}`
          : ""}
      </div>

      {!mapLoaded && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="w-8 h-8 rounded-full border-2 border-white/20 border-t-cyan-400 animate-spin" />
        </div>
      )}

      <MapSearchBar
        nodes={nodes}
        onSelect={(id) => handleNodeSelectRef.current(id)}
      />

      <LiveCoveragePill
        enabled={liveCoverage}
        onToggle={() => setLiveCoverage((v) => !v)}
        status={liveCoverageState.status}
        meta={liveCoverageState.meta}
        opacity={liveCoverageOpacity}
        onOpacityChange={setLiveCoverageOpacity}
        hideNodes={liveCoverageHideNodes}
        onHideNodesChange={setLiveCoverageHideNodes}
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
        buildings3D={buildings3D}
        setBuildings3D={setBuildings3D}
        livePackets={livePackets}
        setLivePackets={setLivePackets}
        onExport={handleExport}
        hidden={!!detailsData || activeTool != null}
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
        hidden={!!detailsData || activeTool != null}
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

      <ClusterHoverCard hover={clusterHover} nodes={nodes} />
      <CoverageLookupCard hover={clusterHover ? null : coverageHover} nodes={nodes} />

      <button
        type="button"
        onClick={() => setLivePackets((v) => !v)}
        className="absolute bottom-3 left-3 z-30 flex items-center gap-2 rounded-xl border border-white/10 bg-gray-900/80 px-3 py-1.5 text-xs font-medium shadow-2xl backdrop-blur-xl transition hover:bg-gray-900/90"
        title={livePackets ? "Live map animations on — click to turn off" : "Live map animations off — click to turn on"}
      >
        <span className={`h-2 w-2 rounded-full ${livePackets ? "bg-emerald-400 animate-pulse" : "bg-gray-500"}`} />
        <span className="text-gray-200">Animations</span>
      </button>

      {/* Live terrain elevation under the cursor — helps sanity-check coverage
          paints. Only renders when 3D terrain is on and we got a valid sample. */}
      {terrain3D && hoverElevationM != null && (
        <div className="fixed top-3 left-[calc(var(--map-pad)+30rem)] sm:left-[calc(var(--map-pad)+33.75rem)] z-30 px-2.5 py-1 rounded-full text-[11px] font-medium border border-white/10 bg-gray-900/80 backdrop-blur-xl text-gray-300 shadow-2xl pointer-events-none select-none flex items-center gap-1.5">
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
      {activeTool === "los" && toolStep === "result" && (toolFromId || losState.losVirtualFrom) && (toolToId || losState.losVirtualTo) && (
        <MapLosPanel
          result={losState.losResult}
          fromLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8))
              : losState.losVirtualFrom
                ? `${losState.losVirtualFrom[1].toFixed(5)}, ${losState.losVirtualFrom[0].toFixed(5)}`
                : ""
          }
          toLabel={
            toolToId
              ? ((nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8))
              : losState.losVirtualTo
                ? `${losState.losVirtualTo[1].toFixed(5)}, ${losState.losVirtualTo[0].toFixed(5)}`
                : ""
          }
          fromColor="#06b6d4"
          toColor="#d946ef"
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={resetTool}
          isComputing={terrain3D && !losState.losResult && !losState.losError}
          isRecomputing={losState.isComputingLos && !!losState.losResult}
          error={losState.losError}
          fromHwIdx={losState.losFromHwIdx} onFromHwIdxChange={losState.setLosFromHwIdx}
          fromAntIdx={losState.losFromAntIdx} onFromAntIdxChange={losState.setLosFromAntIdx}
          fromHeightM={losState.losFromHeightM} onFromHeightChange={losState.setLosFromHeightM}
          toHwIdx={losState.losToHwIdx} onToHwIdxChange={losState.setLosToHwIdx}
          toAntIdx={losState.losToAntIdx} onToAntIdxChange={losState.setLosToAntIdx}
          toHeightM={losState.losToHeightM} onToHeightChange={losState.setLosToHeightM}
          demSource={losState.losDemSource}
          onProfileHover={losCompute.handleLosProfileHover}
        />
      )}

      {/* Stays mounted (force-minimized) during a Scan-from-here overlay so
          the user knows coverage is paused, not closed. */}
      {((activeTool === "coverage") || coverage.keepCoveragePaint) && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <MapCoveragePanel
          overlayMode={coverage.keepCoveragePaint}
          result={coverage.coverageResult}
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
          isComputing={coverage.isComputingCoverage}
          isFetchingTerrain={coverage.isFetchingCoverageTerrain}
          progressCompleted={coverage.coverageProgress.completed}
          progressTotal={coverage.coverageProgress.total}
          demSource={coverage.coverageDemSource}
          errorMessage={coverage.coverageError}
          onRetry={() => {
            coverage.setCoverageError(null);
            coverage.setCoverageRetryNonce((n) => n + 1);
          }}
          onCancel={() => {
            // Kill the live pool so any in-flight ITM ray-marches stop
            // burning CPU. Bump the requestId so anything that already
            // completed gets filtered as stale. Next compute recreates
            // the pool via ensureCoveragePool() on demand.
            coverageCompute.coveragePoolRef.current?.terminate();
            coverageCompute.coveragePoolRef.current = null;
            coverageCompute.coverageRequestIdRef.current += 1;
            coverage.setIsComputingCoverage(false);
            coverage.setIsFetchingCoverageTerrain(false);
            coverage.setCoverageProgress({ completed: 0, total: 0 });
          }}
          rxHardwareIdx={coverage.coverageRxHardwareIdx}
          onRxHardwareIdxChange={coverage.setCoverageRxHardwareIdx}
          rxAntennaIdx={coverage.coverageRxAntennaIdx}
          onRxAntennaIdxChange={coverage.setCoverageRxAntennaIdx}
          rxHeightM={coverage.coverageRxHeightM}
          onRxHeightChange={coverage.setCoverageRxHeightM}
          antennaIdx={coverage.coverageAntennaIdx}
          onAntennaIdxChange={coverage.setCoverageAntennaIdx}
          hardwareIdx={coverage.coverageHardwareIdx}
          onHardwareIdxChange={coverage.setCoverageHardwareIdx}
          customTxDbm={coverage.coverageCustomTxDbm}
          onCustomTxDbmChange={coverage.setCoverageCustomTxDbm}
          aggressionIdx={coverage.coverageAggressionIdx}
          onAggressionIdxChange={coverage.setCoverageAggressionIdx}
          clutterEnabled={coverage.coverageClutterEnabled}
          onClutterEnabledChange={coverage.setCoverageClutterEnabled}
          clutterStatus={coverage.coverageClutterStatus}
          canopyEnabled={coverage.coverageCanopyEnabled}
          onCanopyEnabledChange={coverage.setCoverageCanopyEnabled}
          canopyStatus={coverage.coverageCanopyStatus}
          buildingsEnabled={coverage.coverageBuildingsEnabled}
          onBuildingsEnabledChange={coverage.setCoverageBuildingsEnabled}
          buildingsStatus={coverage.coverageBuildingsStatus}
          mergeOrigins={mergeOrigins.coverageMergeOrigins}
          onAddMergeOriginById={mergeOrigins.addCoverageMergeOriginById}
          onRemoveMergeOrigin={mergeOrigins.removeCoverageMergeOrigin}
          onClearMergeOrigins={mergeOrigins.clearCoverageMergeOrigins}
          mergeNodeOptions={mergeOrigins.mergeNodeOptions}
          pickingMergeOrigin={mergeOrigins.pickingMergeOrigin}
          onStartPickMergeOrigin={() => mergeOrigins.setPickingMergeOrigin(true)}
          onCancelPickMergeOrigin={() => mergeOrigins.setPickingMergeOrigin(false)}
          presetIdx={coverage.coveragePresetIdx}
          onPresetIdxChange={coverage.setCoveragePresetIdx}
          customSensitivityDbm={coverage.coverageCustomSensDbm}
          onCustomSensitivityChange={coverage.setCoverageCustomSensDbm}
          detail={coverage.coverageDetail}
          onDetailChange={coverage.setCoverageDetail}
          antennaHeightM={coverage.coverageAntennaHeightM}
          onAntennaHeightChange={coverage.setCoverageAntennaHeightM}
          reliability={coverage.coverageReliability}
          onReliabilityChange={coverage.setCoverageReliability}
          showContours={coverage.showCoverageContours}
          onShowContoursChange={coverage.setShowCoverageContours}
          showRays={coverage.showCoverageRays}
          onShowRaysChange={coverage.setShowCoverageRays}
          onExport={coverageCompute.handleCoverageExport}
          onOriginChange={(lngLat) => {
            // Typing a custom coord always detaches from any node anchor
            // and places a virtual pin. Mirrors the marker dragend path so
            // the existing recompute pipeline picks it up.
            setToolFromId(null);
            setToolVirtualPos(lngLat);
            mbMapRef.current?.easeTo({ center: lngLat, duration: 600 });
          }}
          onScanFromHere={() => {
            // Mirror coverage's RF settings so the scan results match the
            // painted prediction. Origin (toolFromId / toolVirtualPos) is
            // already shared between the tools.
            scan.setScanHardwareIdx(coverage.coverageHardwareIdx);
            scan.setScanAntennaIdx(coverage.coverageAntennaIdx);
            scan.setScanAntennaHeightM(coverage.coverageAntennaHeightM);
            scan.setScanCustomTxDbm(coverage.coverageCustomTxDbm);
            scan.setScanRxHardwareIdx(coverage.coverageRxHardwareIdx);
            scan.setScanRxAntennaIdx(coverage.coverageRxAntennaIdx);
            scan.setScanPresetIdx(coverage.coveragePresetIdx);
            scan.setScanCustomSensDbm(coverage.coverageCustomSensDbm);
            scan.setScanAggressionIdx(coverage.coverageAggressionIdx);
            scan.setScanClutterEnabled(coverage.coverageClutterEnabled);
            scan.setScanCanopyEnabled(coverage.coverageCanopyEnabled);
            scan.setScanBuildingsEnabled(coverage.coverageBuildingsEnabled);
            scan.setScanReliability(coverage.coverageReliability);
            coverageCompute.skipNextCoverageComputeRef.current = true;
            coverage.setKeepCoveragePaint(true);
            setActiveTool("scan");
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
          loading={rawTraceroutesLoading}
          liveNodes={nodes}
          onNodeSelect={(id) => handleNodeSelectRef.current(id)}
          onHoverLink={(id) => handleLinkHoverRef.current(id)}
          onClose={resetTool}
        />
      )}

      {/* Floating Scan panel */}
      {activeTool === "scan" && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <MapScanPanel
          summary={scan.scanSummary}
          originLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8))
              : "Virtual location"
          }
          isScanning={scan.isScanning}
          scanError={scan.scanError}
          demSource={scan.scanDemSource}
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={() => {
            // Overlay close returns to the coverage view; standalone close
            // does a full reset.
            if (coverage.keepCoveragePaint) {
              coverageCompute.skipNextCoverageComputeRef.current = true;
              coverage.setKeepCoveragePaint(false);
              setActiveTool("coverage");
            } else {
              resetTool();
            }
          }}
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
          onHoverResult={(id) => scan.setScanHoverId(id)}
          onReturnToOrigin={() => {
            const mapNow = mbMapRef.current;
            const view = scanCompute.scanInitialViewRef.current;
            if (!mapNow || !view) return;
            mapNow.easeTo({
              center: view.center,
              zoom: view.zoom,
              pitch: view.pitch,
              bearing: view.bearing,
              duration: 800,
            });
          }}
          hiddenClasses={scan.hiddenScanClasses}
          onToggleClassVisibility={(cls) =>
            scan.setHiddenScanClasses((prev) => {
              const next = new Set(prev);
              if (next.has(cls)) next.delete(cls);
              else next.add(cls);
              return next;
            })
          }
          antennaIdx={scan.scanAntennaIdx}
          onAntennaIdxChange={scan.setScanAntennaIdx}
          hardwareIdx={scan.scanHardwareIdx}
          onHardwareIdxChange={scan.setScanHardwareIdx}
          antennaHeightM={scan.scanAntennaHeightM}
          onAntennaHeightChange={scan.setScanAntennaHeightM}
          rxHardwareIdx={scan.scanRxHardwareIdx}
          onRxHardwareIdxChange={scan.setScanRxHardwareIdx}
          rxAntennaIdx={scan.scanRxAntennaIdx}
          onRxAntennaIdxChange={scan.setScanRxAntennaIdx}
          customTxDbm={scan.scanCustomTxDbm}
          onCustomTxDbmChange={scan.setScanCustomTxDbm}
          aggressionIdx={scan.scanAggressionIdx}
          onAggressionIdxChange={scan.setScanAggressionIdx}
          clutterEnabled={scan.scanClutterEnabled}
          onClutterEnabledChange={scan.setScanClutterEnabled}
          clutterStatus={scan.scanClutterStatus}
          canopyEnabled={scan.scanCanopyEnabled}
          onCanopyEnabledChange={scan.setScanCanopyEnabled}
          canopyStatus={scan.scanCanopyStatus}
          buildingsEnabled={scan.scanBuildingsEnabled}
          onBuildingsEnabledChange={scan.setScanBuildingsEnabled}
          buildingsStatus={scan.scanBuildingsStatus}
          presetIdx={scan.scanPresetIdx}
          onPresetIdxChange={scan.setScanPresetIdx}
          customSensitivityDbm={scan.scanCustomSensDbm}
          onCustomSensitivityChange={scan.setScanCustomSensDbm}
          reliability={scan.scanReliability}
          onReliabilityChange={scan.setScanReliability}
        />
      )}
    </div>
  );
}
