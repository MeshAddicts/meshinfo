import "maplibre-gl/dist/maplibre-gl.css";
import "../maps/maplibreWorker";

import * as maplibregl from "maplibre-gl";
import {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "../components/toastStore";
import { env } from "../env";
import { reverseGeocode } from "../maps/geocoder";
import { buildMapStyle, ensureBuildings3D, ensureTerrain, isDarkBasemap, type OsmBasemap, removeBuildings3D, removeTerrain } from "../maps/mapStyle";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { type INode, type ITraceroutesResponse } from "../types";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { prefersReducedMotion } from "../utils/reducedMotion";
import { type ClusterHover, ClusterHoverCard, type ClusterHoverLeaf } from "./map/components/ClusterHoverCard";
import { FiltersResetPill } from "./map/components/FiltersResetPill";
import { type CoordPillSink, MapCoordinatePill } from "./map/components/MapCoordinatePill";
import { MapDetailsPanel } from "./map/components/MapDetailsPanel";
import { MapHealthWidget } from "./map/components/MapHealthWidget";
import { MapSearchBar } from "./map/components/MapSearchBar";
import { MapSettingsPanel } from "./map/components/MapSettingsPanel";
import { MapToolPrompt, MapToolsDrawer } from "./map/components/MapToolsDrawer";
import { type CorridorSort, type TraceCorridor } from "./map/components/MapTraceCorridorsPanel";
import { useCoverageCompute } from "./map/hooks/useCoverageCompute";
import { useCoverageMergeOrigins } from "./map/hooks/useCoverageMergeOrigins";
import { useCoverageState } from "./map/hooks/useCoverageState";
import { useLivePacketArcs } from "./map/hooks/useLivePacketArcs";
import { useLosCompute } from "./map/hooks/useLosCompute";
import { useLosState } from "./map/hooks/useLosState";
import { useMapKeyboardNav } from "./map/hooks/useMapKeyboardNav";
import { useScanCompute } from "./map/hooks/useScanCompute";
import { useScanState } from "./map/hooks/useScanState";
import { useToolUrlSync } from "./map/hooks/useToolUrlSync";
import { useTraceCompute } from "./map/hooks/useTraceCompute";
import { useTraceDraw } from "./map/hooks/useTraceDraw";
import { useTraceFlyover } from "./map/hooks/useTraceFlyover";
import { useTraceLiveEvents } from "./map/hooks/useTraceLiveEvents";
import { useUrlMapSync } from "./map/hooks/useUrlMapSync";
import type { ActivityLayer } from "./map/layers/activityLayer";
import type { ClusterDonutLayer } from "./map/layers/clusterDonutLayer";
import type { LosTubeLayer } from "./map/layers/losTubeLayer";
import { bindMapHoverUi } from "./map/layers/mapHoverUi";
import { ensureMapSourcesAndLayers, ensureTubeLayers } from "./map/layers/mapLayers";
import {
  anyIdsFanned,
  autoSpiderfyOverlappingPlainNodes,
  autoSpiderfyVisibleClusters,
  dismissClusterSpiderfy,
  dismissPlainSpiderfy,
  getActiveFanCenters,
  isSpiderfied,
  removeSpiderfyLayers,
  spiderfy,
  SPIDERFY_LAYER_LABELS,
  SPIDERFY_LAYER_LEGS,
  SPIDERFY_LAYER_LEGS_SHADOW,
  SPIDERFY_LAYER_NODES,
  SPIDERFY_SOURCE_NODES,
  spiderfyFeatures,
  updateSpiderfyPositions,
} from "./map/layers/spiderfy";
import { circularMeanLng, normalizeLng } from "./map/lib/geo";
import { computeMaxRange, formatLatLng, geodesicCircleCoords, TRANSPARENT_1PX_PNG } from "./map/lib/helpers";
import { buildAllLinksFeatureCollection, buildMapboxLinkFeatureCollection, buildTracerouteLinkFeatureCollection, computeHeardByIds, normalizedTraceroutePath, normNodeId } from "./map/lib/linkFeatures";
import { computeTraceEdgeStats, findPathsBetween, findRunsBetween } from "./map/lib/pathAnalysis";
import { LS_KEYS, readJson, writeJson } from "./map/lib/storage";
import type { IMapNode, LinkMode, MapProvider, NodeDetailsData, NodeLike } from "./map/lib/types";
import {
  applyClusterVisibility,
  createNodesGeoJSONBuilder,
  DEFAULT_NODE_COLOR,
  emptyLineFeatureCollection,
  ROLE_COLORS,
} from "./map/lib/utils";
import { CoverageLookupCard } from "./map/live/CoverageLookupCard";
import { nextCoverageSearch, parseCoverageParam } from "./map/live/coverageUrlParam";
import { LiveCoveragePill } from "./map/live/LiveCoveragePill";
import { useCoverageLookup } from "./map/live/useCoverageLookup";
import { useServerCoverageTiles } from "./map/live/useServerCoverageTiles";
import { haversineKm } from "./map/rf/losAnalysis";
import type { ScanClass } from "./map/rf/scanAnalysis";

// Tool result panels render only while their tool is open — lazy chunks keep
// their ~110 KB (plus pulled-in RF UI) out of the base map bundle.
const MapCoveragePanel = lazy(() =>
  import("./map/components/MapCoveragePanel").then((m) => ({ default: m.MapCoveragePanel })),
);
const MapLosPanel = lazy(() =>
  import("./map/components/MapLosPanel").then((m) => ({ default: m.MapLosPanel })),
);
const MapScanPanel = lazy(() =>
  import("./map/components/MapScanPanel").then((m) => ({ default: m.MapScanPanel })),
);
const MapTraceroutePanel = lazy(() =>
  import("./map/components/MapTraceroutePanel").then((m) => ({ default: m.MapTraceroutePanel })),
);
const MapTraceCorridorsPanel = lazy(() =>
  import("./map/components/MapTraceCorridorsPanel").then((m) => ({ default: m.MapTraceCorridorsPanel })),
);

// Stable empty defaults: `= {}` / `= []` on a query hook mints a fresh identity
// every render while the data is undefined.
const EMPTY_RAW_NODES: Record<string, INode> = {};
const EMPTY_TRACEROUTES: ITraceroutesResponse[] = [];

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);

  // Node-GeoJSON builder with per-feature identity caching; returning the same
  // FeatureCollection identity means "nothing visible changed — skip setData".
  const nodesGeoJSONBuilderRef = useRef(createNodesGeoJSONBuilder());
  const lastUploadedNodesFcRef = useRef<GeoJSON.FeatureCollection | null>(null);
  /** Which of the two node sources holds stale data (only the visible one gets
   *  live setData; the other is refreshed when cluster mode toggles). */
  const nodesFcStaleForRef = useRef<"clustered" | "plain" | null>(null);

  // Persistent-links change detection: per-node link signatures are WeakMap-
  // cached on the derived node identity, so the common SSE flush costs one
  // O(N) pass of cache hits instead of a full rebuild + megabyte stringify.
  const persistentLinksSigRef = useRef("");
  const nodeLinkSigCacheRef = useRef(new WeakMap<IMapNode, string>());
  /** Bumped when the fetched traceroute window changes (identity marker for the sig). */
  const tracerouteEpochRef = useRef(0);

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
  // Bumped per style.load so effects can re-push data into recreated sources/layers.
  const [styleEpoch, setStyleEpoch] = useState(0);
  const mbSelectedIdRef = useRef<string | null>(null);
  // Live packet-arc animation plumbing.
  const activityLayerRef = useRef<ActivityLayer | null>(null);
  /** 3D graded tube for the analyzed route; created once per map. */
  const traceTubeLayerRef = useRef<LosTubeLayer | null>(null);
  /** One-shot play=1 tour request from a shared deep link. */
  const tracePendingPlayRef = useRef(false);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);
  const mbTouchCleanupRef = useRef<(() => void) | null>(null);

  // Set by whichever provider is active
  const handleNodeSelectRef = useRef<(nodeId: string) => void>(() => {});
  const handleLinkHoverRef = useRef<(otherId: string | null) => void>(() => {});
  const selectedNodeIdRef = useRef<string | null>(null);

  const { data: rawNodes = EMPTY_RAW_NODES, isError: nodesQueryFailed } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();
  const { data: rawTraceroutes = EMPTY_TRACEROUTES, isLoading: rawTraceroutesLoading } = useGetTraceroutesQuery();

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
  // Traceroute tool: which observed path is analyzed/bold (null = most recent),
  // and whether the direct-path counterfactual overlay is drawn.
  const [traceSelectedSig, setTraceSelectedSig] = useState<string | null>(null);
  const [traceShowDirect, setTraceShowDirect] = useState(true);
  // Busiest-links column: viewport filter + a moveend tick to recompute on pan
  const [traceCorridorsInView, setTraceCorridorsInView] = useState(true);
  const [traceCorridorSort, setTraceCorridorSort] = useState<CorridorSort>("busiest");
  const [mapMoveEpoch, setMapMoveEpoch] = useState(0);

  // Pair-scoped traceroute history for the tool — escapes the 1000-row global
  // window that makes most pairs come back empty. Merged with the global cache
  // so routes crossing the pair as intermediate hops still count.
  const tracePairActive = activeTool === "traceroute" && !!toolFromId && !!toolToId;
  // isLoading (not isFetching): true only on a pair's first fetch, so throttled
  // background refetches neither flicker the panel nor re-gate the fitBounds.
  const { data: pairTraceroutes = EMPTY_TRACEROUTES, isLoading: pairTraceroutesLoading } = useGetTraceroutesQuery(
    { from: toolFromId ?? "", to: toolToId ?? "", limit: 500 },
    { skip: !tracePairActive },
  );
  const traceData = useMemo(() => {
    if (pairTraceroutes.length === 0) return rawTraceroutes;
    // globalThis: the component name shadows the Map constructor
    const byKey = new globalThis.Map<string, ITraceroutesResponse>();
    for (const tr of [...rawTraceroutes, ...pairTraceroutes]) byKey.set(`${tr.id}:${tr.from}`, tr);
    return [...byKey.values()];
  }, [rawTraceroutes, pairTraceroutes]);
  const tracePaths = useMemo(
    () => (activeTool === "traceroute" && toolFromId && toolToId
      ? findPathsBetween(toolFromId, toolToId, traceData)
      : []),
    [activeTool, toolFromId, toolToId, traceData],
  );
  const traceSelectedPath = useMemo(
    () => tracePaths.find((p) => p.hops.join(">") === traceSelectedSig) ?? tracePaths[0] ?? null,
    [tracePaths, traceSelectedSig],
  );
  // Chronological run history for the time-machine strip (oldest first)
  const traceRuns = useMemo(
    () => (activeTool === "traceroute" && toolFromId && toolToId
      ? findRunsBetween(toolFromId, toolToId, traceData)
      : []),
    [activeTool, toolFromId, toolToId, traceData],
  );
  // 3D terrain. Off by default (same rationale as buildings3D below): DEM tile
  // downloads + a terrain pass on every repaint roughly double render cost, and
  // the RF tools prompt to enable it when they actually need it.
  const [terrain3D, setTerrain3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.terrain3D, false));
  const terrainExaggeration = 1.5;
  // Cosmetic 3D buildings (OpenFreeMap). Off by default to keep slow devices light.
  const [buildings3D, setBuildings3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.buildings3D, false));

  // Live network-coverage layer: a server-baked raster tile pyramid (compute is
  // server-side; this only show/hides + sets opacity). Off (hidden) by default.
  // A shared link's ?cov=1|0 overrides the saved preference for this session.
  // Snapshot at first render — effects rewrite the real URL before a re-render
  // could read it (same rationale as useUrlMapSync's snapshot).
  const urlLiveCoverageRef = useRef<boolean | null | undefined>(undefined);
  if (urlLiveCoverageRef.current === undefined) {
    urlLiveCoverageRef.current = parseCoverageParam(window.location.search);
  }
  const [liveCoverage, setLiveCoverage] = useState<boolean>(
    () => urlLiveCoverageRef.current ?? readJson<boolean>(LS_KEYS.liveCoverage, false),
  );
  const [liveCoverageOpacity, setLiveCoverageOpacity] = useState<number>(
    () => readJson<number>(LS_KEYS.liveCoverageOpacity, 0.6),
  );
  const [liveCoverageHideNodes, setLiveCoverageHideNodes] = useState<boolean>(
    () => readJson<boolean>(LS_KEYS.liveCoverageHideNodes, true),
  );
  const [liveCoverageGroup, setLiveCoverageGroup] = useState<string>(
    () => readJson<string>(LS_KEYS.liveCoverageGroup, "all"),
  );

  // RF tool state hooks (own settings + result state)
  const losState = useLosState();
  const coverage = useCoverageState();
  const scan = useScanState();

  /** 3D LoS tube layer; created once per map. */
  const losTubeLayerRef = useRef<LosTubeLayer | null>(null);
  /** Suppresses the cursor-elevation mousemove handler so marker drag doesn't stutter. */
  const isDraggingMarkerRef = useRef(false);
  /** Hover/center feed for the coordinate pill (per-frame state lives there). */
  const coordPillSinkRef = useRef<CoordPillSink | null>(null);
  /** Whether the jump-to-coordinate pin is currently dropped. */
  const [hasCoordPin, setHasCoordPin] = useState(false);
  /** Draggable jump-to pin; independent of tool state. */
  const coordPinMarkerRef = useRef<maplibregl.Marker | null>(null);
  const coordPinPopupRef = useRef<maplibregl.Popup | null>(null);

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
  useEffect(() => {
    // The sharer's ?cov drives this session but must not overwrite the viewer's
    // saved preference — persist only once the viewer changes the toggle.
    if (urlLiveCoverageRef.current != null && liveCoverage === urlLiveCoverageRef.current) return;
    urlLiveCoverageRef.current = null;
    writeJson(LS_KEYS.liveCoverage, liveCoverage);
  }, [liveCoverage]);
  // Mirror the overlay toggle into ?cov= so the view is shareable. replaceState,
  // not setSearchParams — a router navigation would re-render the whole Map
  // route for a purely cosmetic URL update (same rationale as the lat/lng/z
  // sync), and the no-write cases keep Safari's replaceState rate limit happy.
  useEffect(() => {
    const next = nextCoverageSearch(window.location.search, liveCoverage);
    if (next === null) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?${next}${window.location.hash}`,
    );
  }, [liveCoverage]);
  useEffect(() => writeJson(LS_KEYS.liveCoverageOpacity, liveCoverageOpacity), [liveCoverageOpacity]);
  useEffect(() => writeJson(LS_KEYS.liveCoverageHideNodes, liveCoverageHideNodes), [liveCoverageHideNodes]);
  useEffect(() => writeJson(LS_KEYS.liveCoverageGroup, liveCoverageGroup), [liveCoverageGroup]);

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
      if (e.key !== "Escape") return;
      // Leave Escape for an editable field (e.g. the coordinate pill's input).
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setSettingsPanelOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [settingsPanelOpen]);

  // Re-derives the time-dependent `online` flag once a minute instead of on
  // every SSE flush (and lets aging propagate on a quiet-but-open map).
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinuteTick((v) => v + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  /** Per-raw-node derived cache. SSE flushes replace only the raw objects that
   *  actually changed (immer structural sharing keeps the rest), so unchanged
   *  nodes keep their derived identity across flushes — downstream memo/prop
   *  compares see stable references instead of N fresh objects 2.5×/sec. */
  const derivedNodeCacheRef = useRef(
    new WeakMap<INode, { online: boolean; lastSeenMs: number | null; derived: IMapNode }>(),
  );

  const nodes: Record<string, IMapNode> = useMemo(() => {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const cache = derivedNodeCacheRef.current;
    const out: Record<string, IMapNode> = {};

    for (const [id, node] of Object.entries(rawNodes)) {
      const hit = cache.get(node);
      if (hit) {
        const onlineNow = hit.lastSeenMs != null && hit.lastSeenMs > sixHoursAgo;
        if (onlineNow === hit.online) {
          out[id] = hit.derived;
          continue;
        }
      }
      const parsedLastSeen =
        node.last_seen != null ? new Date(node.last_seen as string).getTime() : NaN;
      const lastSeenMs = Number.isFinite(parsedLastSeen) ? parsedLastSeen : null;
      const online = lastSeenMs != null && lastSeenMs > sixHoursAgo;
      const derived: IMapNode = {
        ...node,
        online,
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
      };
      cache.set(node, { online, lastSeenMs, derived });
      out[id] = derived;
    }
    return out;
    // minuteTick: re-check the time-dependent `online` flag
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawNodes, minuteTick]);

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

  // Coverage merge origins (session-scoped; depends on nodes + toolFromId for
  // primary-id exclusion). Only builds its picker list while the coverage
  // panel can render — incl. the "Scan from here" overlay (keepCoveragePaint),
  // where the minimized panel can be expanded and searched.
  const mergeOrigins = useCoverageMergeOrigins(
    nodes,
    toolFromId,
    activeTool === "coverage" || coverage.keepCoveragePaint,
  );

  // URL deep-link + view sync
  const { searchParams, flyToTargetRef, pushViewToUrlRef } = useUrlMapSync(nodes, mbMapRef);

  // Refs mirroring state — read from MapLibre event handlers + setStyle re-init
  const nodesRef = useRef(nodes);
  const traceroutesRef = useRef(rawTraceroutes);
  const configRef = useRef(config);
  const recentDaysRef = useRef(recentDays);
  const clusterEnabledRef = useRef(clusterEnabled);
  // Initialized false; nodesHidden is derived below the coverage hook and synced there.
  const nodesHiddenRef = useRef(false);
  const livePacketsRef = useRef(livePackets);
  const linkModeRef = useRef(linkMode);
  const myNodeIdRef = useRef(myNodeId);
  const roleFilterRef = useRef(roleFilter);
  const channelFilterRef = useRef(channelFilter);
  const activeToolRef = useRef(activeTool);
  const toolStepRef = useRef(toolStep);
  const toolFromIdRef = useRef(toolFromId);
  const toolToIdRef = useRef(toolToId);
  // Merge-origin pick mode, read by the bind-once node/cluster click handlers
  const pickingMergeOriginRef = useRef(mergeOrigins.pickingMergeOrigin);
  const addMergeOriginByIdRef = useRef(mergeOrigins.addCoverageMergeOriginById);
  // Coverage double-Esc guard: timestamp of the first (arming) Esc press
  const coverageEscArmedAtRef = useRef(0);
  // Scan-from-here overlay state, read by the bind-once Escape handler
  const keepCoveragePaintRef = useRef(coverage.keepCoveragePaint);

  const isPickingNode = activeTool != null && toolStep !== "result";
  const terrain3DRef = useRef(terrain3D);
  const buildings3DRef = useRef(buildings3D);
  const setDetailsDataRef = useRef(setDetailsData);
  const serverNodeRef = useRef(serverNode);
  const pendingServerCenterRef = useRef(false);

  /** Snapshot of the hovered cluster's member nodes for the hover card.
   *  Refreshes when the hover target (or its async leaves fill) changes —
   *  deliberately NOT on node churn while the card is open. */
  const clusterHoverLeaves = useMemo<ClusterHoverLeaf[]>(() => {
    if (!clusterHover) return [];
    const live = nodesRef.current;
    return clusterHover.ids
      .map((id) => live[id] ?? live[`!${id}`])
      .filter((n): n is IMapNode => Boolean(n))
      .map((n) => ({
        id: n.id,
        shortname: n.shortname,
        longname: n.longname,
        online: Boolean(n.online),
        role: n.role,
        last_seen: n.last_seen ?? undefined,
      }));
  }, [clusterHover]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { serverNodeRef.current = serverNode; }, [serverNode]);
  useEffect(() => {
    traceroutesRef.current = rawTraceroutes;
    tracerouteEpochRef.current += 1;
  }, [rawTraceroutes]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { setDetailsDataRef.current = setDetailsData; }, [setDetailsData]);
  useEffect(() => { recentDaysRef.current = recentDays; }, [recentDays]);
  useEffect(() => { clusterEnabledRef.current = clusterEnabled; }, [clusterEnabled]);
  useEffect(() => {
    livePacketsRef.current = livePackets;
    clusterDonutLayerRef.current?.setAnimationsEnabled(livePackets);
  }, [livePackets]);
  useEffect(() => { linkModeRef.current = linkMode; }, [linkMode]);
  useEffect(() => { roleFilterRef.current = roleFilter; }, [roleFilter]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { pickingMergeOriginRef.current = mergeOrigins.pickingMergeOrigin; }, [mergeOrigins.pickingMergeOrigin]);
  useEffect(() => { addMergeOriginByIdRef.current = mergeOrigins.addCoverageMergeOriginById; }, [mergeOrigins.addCoverageMergeOriginById]);
  useEffect(() => { keepCoveragePaintRef.current = coverage.keepCoveragePaint; }, [coverage.keepCoveragePaint]);
  useEffect(() => { toolStepRef.current = toolStep; }, [toolStep]);
  useEffect(() => { toolFromIdRef.current = toolFromId; }, [toolFromId]);
  useEffect(() => { toolToIdRef.current = toolToId; }, [toolToId]);
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

  // LOS/traceroute 3D tubes: shader-compiling custom layers, created on first
  // tool activation (and re-created after a style switch while a tool is
  // active) instead of on every base-map load. Declared BEFORE the tool
  // compute hooks so, within a commit, the layers exist by the time those
  // hooks' effects push data.
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map || !styleEverLoadedRef.current) return;
    if (activeTool === "los" || activeTool === "traceroute") {
      ensureTubeLayers(map, { losTubeLayerRef, traceTubeLayerRef });
      // Tube altitudes are scaled by terrain exaggeration at upload time;
      // re-upload against the final post-style-load exaggeration.
      losTubeLayerRef.current?.refresh();
      traceTubeLayerRef.current?.refresh();
    }
  }, [activeTool, styleEpoch]);

  // Dragging an endpoint marker detaches any node anchor into a virtual pin
  const { setLosVirtualFrom, setLosVirtualTo } = losState;
  const onLosEndpointDragged = useCallback((which: "from" | "to", pos: [number, number]) => {
    if (which === "from") {
      setToolFromId(null);
      setLosVirtualFrom(pos);
    } else {
      setToolToId(null);
      setLosVirtualTo(pos);
    }
  }, [setToolFromId, setToolToId, setLosVirtualFrom, setLosVirtualTo]);

  // LOS compute + tube layer effects
  const losCompute = useLosCompute({
    activeTool, toolStep, toolFromId, toolToId,
    losVirtualFrom: losState.losVirtualFrom,
    losVirtualTo: losState.losVirtualTo,
    losFromHeightM: losState.losFromHeightM,
    losToHeightM: losState.losToHeightM,
    losFreqMhz: losState.losFreqMhz,
    terrain3D, styleEpoch, nodes,
    nodesLoadFailed: nodesQueryFailed,
    losResult: losState.losResult,
    mbMapRef, losTubeLayerRef,
    isDraggingMarkerRef,
    onEndpointDragged: onLosEndpointDragged,
    setLosResult: losState.setLosResult,
    setLosDemSource: losState.setLosDemSource,
    setLosError: losState.setLosError,
    setIsComputingLos: losState.setIsComputingLos,
    setLosTerrainWarning: losState.setLosTerrainWarning,
  });

  // Lit-up picking: nodes sharing any observed route with the picked origin.
  // Identity-stable across SSE flushes (prev-compare) so the draw effect keyed
  // on it doesn't re-upload rings 2.5×/sec during pickTo.
  const traceCandidatesPrevRef = useRef<string[]>([]);
  const traceCandidates = useMemo(() => {
    if (activeTool !== "traceroute" || toolStep !== "pickTo" || !toolFromId) {
      return traceCandidatesPrevRef.current.length === 0
        ? traceCandidatesPrevRef.current
        : (traceCandidatesPrevRef.current = []);
    }
    const a = normNodeId(toolFromId);
    if (!a) return traceCandidatesPrevRef.current.length === 0 ? traceCandidatesPrevRef.current : (traceCandidatesPrevRef.current = []);
    const set = new Set<string>();
    for (const tr of traceData) {
      const path = normalizedTraceroutePath(tr);
      if (path.length < 2 || !path.includes(a)) continue;
      // Positioned candidates only — the rings and the prompt count must agree
      for (const h of path) {
        if (!h || h === a) continue;
        const n = nodes[h] ?? nodes[`!${h}`];
        if (n?.map_position) set.add(h);
      }
    }
    const computed = [...set];
    const prev = traceCandidatesPrevRef.current;
    if (prev.length === computed.length && computed.every((v, i) => v === prev[i])) return prev;
    traceCandidatesPrevRef.current = computed;
    return computed;
  }, [activeTool, toolStep, toolFromId, traceData, nodes]);

  // Position signature of the analyzed hops: a value-stable string, so SSE
  // identity churn doesn't retrigger grading but a hop actually moving does.
  const tracePosKey = useMemo(() => {
    if (!traceSelectedPath) return "";
    return traceSelectedPath.hops
      .map((id) => {
        const p = (nodes[id] ?? nodes[`!${id}`])?.map_position;
        return p ? `${p[0].toFixed(5)},${p[1].toFixed(5)}` : "?";
      })
      .join("|");
  }, [traceSelectedPath, nodes]);

  // Busiest observed links, ranked by traversal count — the tool's browse mode.
  // Counted over rawTraceroutes (the uniform global window), NOT traceData:
  // merging the open pair's deep history would self-inflate whichever corridor
  // was clicked. Stats are split out so pan/zoom only re-runs the cheap filter.
  const traceEdgeStats = useMemo(
    () => (activeTool === "traceroute" ? computeTraceEdgeStats(rawTraceroutes) : []),
    [activeTool, rawTraceroutes],
  );
  // Cheap endpoint signature so the haversine+sort pass below only re-runs when
  // a corridor endpoint actually moved/renamed — not on every SSE flush.
  const corridorPosSig = useMemo(() => {
    if (traceEdgeStats.length === 0) return "";
    let sig = "";
    for (const e of traceEdgeStats) {
      const na = nodes[e.aId] ?? nodes[`!${e.aId}`];
      const nb = nodes[e.bId] ?? nodes[`!${e.bId}`];
      sig += `${na?.map_position ?? ""}~${na?.shortname ?? ""}~${nb?.map_position ?? ""}~${nb?.shortname ?? ""};`;
    }
    return sig;
  }, [traceEdgeStats, nodes]);

  const traceCorridors = useMemo((): TraceCorridor[] => {
    if (traceEdgeStats.length === 0) return [];
    const bounds = traceCorridorsInView ? mbMapRef.current?.getBounds() : null;
    // Seam-tolerant: wrapped node lngs must also match against ±360 aliases,
    // since a viewport straddling the antimeridian has unwrapped bounds.
    const inBounds = (p: [number, number]): boolean =>
      !bounds ||
      bounds.contains(p) ||
      bounds.contains([p[0] + 360, p[1]]) ||
      bounds.contains([p[0] - 360, p[1]]);
    const out: TraceCorridor[] = [];
    for (const e of traceEdgeStats) {
      const na = nodes[e.aId] ?? nodes[`!${e.aId}`];
      const nb = nodes[e.bId] ?? nodes[`!${e.bId}`];
      if (!na?.map_position || !nb?.map_position) continue;
      if (!(inBounds(na.map_position) && inBounds(nb.map_position))) continue;
      out.push({
        aId: e.aId,
        bId: e.bId,
        aLabel: na.shortname?.trim() || e.aId.slice(0, 8),
        bLabel: nb.shortname?.trim() || e.bId.slice(0, 8),
        aPos: na.map_position,
        bPos: nb.map_position,
        count: e.count,
        distanceKm: haversineKm(na.map_position, nb.map_position),
        lastTimestamp: e.lastTimestamp,
      });
    }
    out.sort((x, y) =>
      traceCorridorSort === "longest"
        ? y.distanceKm - x.distanceKm || y.count - x.count
        : y.count - x.count || y.lastTimestamp - x.lastTimestamp,
    );
    return out.slice(0, 15);
    // mapMoveEpoch: pan/zoom re-runs the viewport filter. `nodes` is read from
    // the closure but keyed via corridorPosSig — when the sig is unchanged the
    // node data this memo reads is unchanged too, so skipping the re-run is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceEdgeStats, corridorPosSig, traceCorridorsInView, traceCorridorSort, mapMoveEpoch]);

  // Traceroute per-hop RF analysis ("Why This Path") + graded tube / pylons / direct overlay
  const traceCompute = useTraceCompute({
    activeTool, toolStep,
    path: traceSelectedPath,
    posKey: tracePosKey,
    terrain3D, styleEpoch,
    showDirect: traceShowDirect,
    nodesRef, mbMapRef, traceTubeLayerRef,
  });

  // "Ride the Packet": camera chase along the analyzed route
  const traceFlyover = useTraceFlyover({ mbMapRef, activityLayerRef, nodesRef });
  /** View persistence (localStorage/URL/pill), set by the bind-once moveend block. */
  const saveViewRef = useRef<() => void>(() => {});
  // The tour's final moveend races the flying flag — sync once on tour end
  useEffect(() => {
    if (!traceFlyover.isFlying) saveViewRef.current();
  }, [traceFlyover.isFlying]);
  // Ref twins for the bind-once map handlers (Esc, ambient-spawn gate)
  const flyoverCancelRef = useRef(traceFlyover.cancelFlyover);
  flyoverCancelRef.current = traceFlyover.cancelFlyover;
  const flyoverFlyingRef = traceFlyover.flyingRef;

  // Ambient packet arcs + live traceroute plumbing (SSE → comets + refetch)
  useLivePacketArcs({
    activityLayerRef, clusterDonutLayerRef, mbMapRef, nodesRef,
    clusterEnabledRef, livePacketsRef, flyoverFlyingRef,
  });
  const { clearTraceRefetchTimer } = useTraceLiveEvents({
    activeTool, activeToolRef, toolStepRef, toolFromIdRef, toolToIdRef,
    livePacketsRef, flyoverFlyingRef, clusterEnabledRef,
    nodesRef, mbMapRef, clusterDonutLayerRef, activityLayerRef,
  });

  // Shareable tool deep links (?tool=los|traceroute&from&to…)
  useToolUrlSync({
    activeTool, toolStep, toolFromId, toolToId,
    setActiveTool, setToolStep, setToolFromId, setToolToId,
    losState, tracePendingPlayRef, traceSelectedPath, tracePosKey, styleEpoch,
    startFlyover: traceFlyover.startFlyover,
  });

  // Observed paths + candidate rings on the map (owns endpoint/ghost markers)
  const { traceFromMarkerRef, traceToMarkerRef, traceFitKeyRef, traceGhostMarkersRef } = useTraceDraw({
    mbMapRef, nodesRef,
    activeTool, toolStep, toolFromId, toolToId,
    tracePaths, traceSelectedPath, traceCandidates,
    pairTraceroutesLoading, styleEpoch,
  });

  // Stable callbacks for the memoized trace panels (same pattern as scan's)
  const handleToolPanelClose = useCallback(() => resetToolRef.current(), []);
  const handlePanelNodeSelect = useCallback((id: string) => handleNodeSelectRef.current(id), []);
  const handlePanelHoverLink = useCallback((id: string | null) => handleLinkHoverRef.current(id), []);
  // Ref-backed so MapDetailsPanel's memo isn't defeated by the function
  // declaration below getting a fresh identity each render.
  const handleDetailsClose = useCallback(() => clearSelectionRef.current(), []);
  const handleTraceSelectPath = useCallback((sig: string) => {
    traceFlyover.cancelFlyover(); // a tour follows one path only
    tracePendingPlayRef.current = false;
    setTraceSelectedSig(sig);
    // cancelFlyover is identity-stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleToggleFlyover = useCallback(() => {
    if (traceFlyover.isFlying) traceFlyover.cancelFlyover();
    else if (traceSelectedPath) traceFlyover.startFlyover(traceSelectedPath);
    // start/cancel are identity-stable; only the data deps matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceFlyover.isFlying, traceSelectedPath]);
  const traceActivePair = useMemo(
    () => (toolFromId && toolToId ? ([normNodeId(toolFromId), normNodeId(toolToId)] as [string, string]) : null),
    [toolFromId, toolToId],
  );

  /** Position/label lookup narrowed to the hop ids the traceroute panel
   *  renders. Keyed on the paths + tracePosKey (value-stable across SSE
   *  churn), NOT on `nodes` — so the panel's React.memo actually holds while
   *  live flushes stream in. Hop moves re-key via tracePosKey; label renames
   *  refresh on the next path change (acceptable staleness). */
  const traceHopNodes = useMemo(() => {
    const out: Record<string, IMapNode> = {};
    const addId = (id: string) => {
      if (out[id] || out[`!${id}`]) return;
      const live = nodesRef.current;
      if (live[id]) out[id] = live[id];
      else if (live[`!${id}`]) out[`!${id}`] = live[`!${id}`];
    };
    for (const p of tracePaths) for (const h of p.hops) addId(h);
    for (const r of traceRuns) for (const h of r.hops) addId(h);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracePaths, traceRuns, tracePosKey]);

  // Corridor row click → jump straight to the analysis for that pair
  const handleCorridorPick = useCallback((aId: string, bId: string) => {
    traceFlyover.cancelFlyover();
    tracePendingPlayRef.current = false;
    setTraceSelectedSig(null);
    setToolFromId(aId);
    setToolToId(bId);
    setToolStep("result");
    // The pick flow's crosshair must not survive a jump past pickTo
    const canvas = mbMapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scan compute + per-class visibility + clear-on-tool-change + hover effects
  const scanCompute = useScanCompute({
    activeTool, toolStep, toolFromId, toolVirtualPos,
    terrain3D, styleEpoch, nodes,
    nodesLoadFailed: nodesQueryFailed,
    scanTxDbm: scan.scanTxDbm,
    scanAntennaDbi: scan.scanAntennaDbi,
    scanRxAntennaDbi: scan.scanRxAntennaDbi,
    scanRxHeightM: scan.scanRxHeightM,
    scanFreqMhz: scan.scanFreqMhz,
    scanEffectiveSensitivityDbm: scan.scanEffectiveSensitivityDbm,
    scanAggressionIdx: scan.scanAggressionIdx,
    scanClutterEnabled: scan.scanClutterEnabled,
    scanCanopyEnabled: scan.scanCanopyEnabled,
    scanBuildingsEnabled: scan.scanBuildingsEnabled,
    scanAntennaHeightM: scan.scanAntennaHeightM,
    scanReliability: scan.scanReliability,
    scanRetryNonce: scan.scanRetryNonce,
    hiddenScanClasses: scan.hiddenScanClasses,
    scanSummary: scan.scanSummary,
    scanHoverId: scan.scanHoverId,
    mbMapRef, isDraggingMarkerRef,
    setScanSummary: scan.setScanSummary,
    setIsScanning: scan.setIsScanning,
    setScanError: scan.setScanError,
    setScanTerrainWarning: scan.setScanTerrainWarning,
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
    group: liveCoverageGroup,
  });
  const coverageHover = useCoverageLookup({
    mbMapRef,
    enabled: liveCoverage && liveCoverageState.status === "ready",
    mapReady: mapLoaded,
    suspended: activeTool != null,
    group: liveCoverageGroup,
  });
  // A persisted group can vanish (preset mesh went quiet) — fall back to "all".
  const liveGroups = liveCoverageState.meta?.groups;
  useEffect(() => {
    if (liveGroups && liveCoverageGroup !== "all" && !liveGroups.includes(liveCoverageGroup)) {
      setLiveCoverageGroup("all");
    }
  }, [liveGroups, liveCoverageGroup]);
  // Hide markers only while the layer actually paints — if the worker goes away
  // ("unavailable"), markers come back instead of leaving an empty map.
  const nodesHidden = liveCoverage && liveCoverageHideNodes && liveCoverageState.status === "ready";
  useEffect(() => { nodesHiddenRef.current = nodesHidden; }, [nodesHidden]);

  // Reset the whole tool state. Also imperatively clears map visual geometry
  // so there's no one-tick flash of stale tubes / rasters / scan lines while
  // React re-runs the dependent effects.
  const resetTool = () => {
    setActiveTool(null);
    setToolStep("pickFrom");
    setToolFromId(null);
    setToolToId(null);
    setToolVirtualPos(null);
    // Merge origins are contextual to one analysis; closing the tool ends it
    mergeOrigins.clearCoverageMergeOrigins();
    // Stale arm must not let a later session close on a single Esc
    coverageEscArmedAtRef.current = 0;
    losState.setLosVirtualFrom(null);
    losState.setLosVirtualTo(null);
    losCompute.losFitKeyRef.current = null;
    losCompute.losFromPosRef.current = null;
    losCompute.losToPosRef.current = null;
    // Release the cached rasters (DEM + canopy + buildings — tens of MB on long
    // links) — they only help within one session
    losCompute.losDemCacheRef.current = null;
    losCompute.losHoverMarkerRef.current?.remove();
    losCompute.losHoverMarkerRef.current = null;
    losCompute.losFromMarkerRef.current?.remove();
    losCompute.losFromMarkerRef.current = null;
    losCompute.losToMarkerRef.current?.remove();
    losCompute.losToMarkerRef.current = null;
    traceFromMarkerRef.current?.remove();
    traceFromMarkerRef.current = null;
    traceToMarkerRef.current?.remove();
    traceToMarkerRef.current = null;
    traceFitKeyRef.current = null;
    clearTraceRefetchTimer();
    setTraceSelectedSig(null);
    traceFlyover.cancelFlyover();
    tracePendingPlayRef.current = false;
    for (const m of traceGhostMarkersRef.current) m.remove();
    traceGhostMarkersRef.current = [];
    // Release the route's cached rasters (tens of MB on long routes)
    traceCompute.traceDemCacheRef.current = null;
    try { traceTubeLayerRef.current?.setData(null); } catch {}
    // Removing a marker mid-drag skips its dragend; unstick the shared flag
    isDraggingMarkerRef.current = false;
    losState.setLosResult(null);
    losState.setLosError(null);
    losState.setLosTerrainWarning(null);
    losState.setIsComputingLos(false);
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
    scan.setScanError(null);
    scan.setScanTerrainWarning(null);

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
      // A hop/path spotlight from the traceroute panel must not outlive the tool
      try {
        (mb.getSource("link-highlight") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("trace-obstructions") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("trace-direct") as MlGeoJSONSource | undefined)?.setData(empty);
      } catch {}
      try {
        (mb.getSource("trace-candidates") as MlGeoJSONSource | undefined)?.setData(empty);
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

  // Stable ref to resetTool (recreated each render) so memoized panels can close
  // without a fresh callback identity on every parent render.
  const resetToolRef = useRef(resetTool);
  resetToolRef.current = resetTool;

  // Stable scan-panel callbacks. MapScanPanel is memoized and the map re-renders on
  // every hover (elevation pill), so inline lambdas here would defeat the memo.
  const handleScanClose = useCallback(() => {
    // Overlay close returns to the coverage view; standalone close does a full reset.
    if (keepCoveragePaintRef.current) {
      coverageCompute.skipNextCoverageComputeRef.current = true;
      coverage.setKeepCoveragePaint(false);
      setActiveTool("coverage");
    } else {
      resetToolRef.current();
    }
    // Setters/refs are stable; deps intentionally empty so hover re-renders don't
    // recreate the callback (would defeat MapScanPanel's memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Ref so the bind-once Escape handler can reuse the panel's exact close behavior.
  const handleScanCloseRef = useRef(handleScanClose);
  handleScanCloseRef.current = handleScanClose;

  // Freshest-closure ref for the keyboard hook (the function declaration hoists).
  const clearSelectionRef = useRef(() => {});
  clearSelectionRef.current = clearMapboxSelectionAndOverlays;

  // Arrows pan, +/- zoom, Esc walks the dismiss chain (flyover → tool → selection)
  useMapKeyboardNav({
    mbMapRef, mapContainerRef: mapRef,
    flyoverCancelRef, flyoverFlyingRef,
    activeToolRef, toolStepRef, pickingMergeOriginRef, keepCoveragePaintRef,
    coverageEscArmedAtRef, clusterEnabledRef,
    handleScanCloseRef, resetToolRef, clearSelectionRef,
  });
  const handleScanEnableTerrain = useCallback(() => setTerrain3D(true), []);
  const handleScanSelectResult = useCallback((id: string) => {
    // Fly to the target, then open its details panel.
    const n = nodesRef.current[id] ?? nodesRef.current[`!${id}`];
    const mb = mbMapRef.current;
    if (n?.map_position && mb) {
      mb.easeTo({ center: [n.map_position[0], n.map_position[1]], zoom: Math.max(mb.getZoom(), 13), duration: 800 });
    }
    handleNodeSelectRef.current(id);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleScanHoverResult = useCallback((id: string | null) => scan.setScanHoverId(id), []);
  const handleScanReturnToOrigin = useCallback(() => {
    const mapNow = mbMapRef.current;
    const view = scanCompute.scanInitialViewRef.current;
    if (!mapNow || !view) return;
    mapNow.easeTo({ center: view.center, zoom: view.zoom, pitch: view.pitch, bearing: view.bearing, duration: 800 });
  }, [scanCompute.scanInitialViewRef]);
  const handleScanToggleClassVisibility = useCallback((cls: ScanClass) => {
    scan.setHiddenScanClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleScanRetry = useCallback(() => scan.setScanRetryNonce((n) => n + 1), []);

  // Swap LOS endpoints including their per-endpoint configs; the compute
  // effect picks the change up via its endpoint-scalar deps.
  const swapLosEndpoints = () => {
    const fid = toolFromId;
    setToolFromId(toolToId);
    setToolToId(fid);
    const vf = losState.losVirtualFrom;
    losState.setLosVirtualFrom(losState.losVirtualTo);
    losState.setLosVirtualTo(vf);
    const hw = losState.losFromHwIdx;
    losState.setLosFromHwIdx(losState.losToHwIdx);
    losState.setLosToHwIdx(hw);
    const ant = losState.losFromAntIdx;
    losState.setLosFromAntIdx(losState.losToAntIdx);
    losState.setLosToAntIdx(ant);
    const h = losState.losFromHeightM;
    losState.setLosFromHeightM(losState.losToHeightM);
    losState.setLosToHeightM(h);
  };

  // Typed "lat, lng" for a LOS endpoint becomes a virtual pin (detaches any node anchor)
  const setLosFromPosition = (pos: [number, number]) => {
    setToolFromId(null);
    losState.setLosVirtualFrom(pos);
  };
  const setLosToPosition = (pos: [number, number]) => {
    setToolToId(null);
    losState.setLosVirtualTo(pos);
  };

  // Opens the settings panel at the terrain section (drawer + trace panel share it).
  const openTerrainSetup = useCallback(() => {
    setSettingsOpenSections((prev) => {
      const next = new Set(prev);
      next.add("terrain");
      return next;
    });
    setSettingsPanelOpen(true);
  }, []);

  // Traceroute panel hover → spotlight the hovered leg / alternate path.
  const handleTraceHighlight = useCallback((coords: [number, number][] | null) => {
    const src = mbMapRef.current?.getSource("link-highlight") as MlGeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      coords && coords.length >= 2
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] }
        : { type: "FeatureCollection", features: [] },
    );
  }, []);

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
        const norm = normNodeId(id);
        const tracerouteFC = buildTracerouteLinkFeatureCollection(
          traceroutes.filter((tr) => normalizedTraceroutePath(tr).includes(norm)),
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

  /** Per-node signature over everything the link builders read (position,
   *  neighbor entries, minute-bucketed last_seen). WeakMap-cached on the
   *  derived node identity, so unchanged nodes cost a lookup. */
  function nodeLinkSig(id: string, node: IMapNode): string {
    const cached = nodeLinkSigCacheRef.current.get(node);
    if (cached !== undefined) return cached;
    const lastSeenMs = node.last_seen ? new Date(node.last_seen as string).getTime() : NaN;
    let sig = `${id}@${node.map_position ?? ""}~${Number.isFinite(lastSeenMs) ? Math.floor(lastSeenMs / 60_000) : ""}`;
    if (node.neighbors) {
      for (const nb of node.neighbors) sig += `|${nb.id}:${nb.snr}:${nb.lastRxTime ?? ""}`;
    }
    nodeLinkSigCacheRef.current.set(node, sig);
    return sig;
  }

  /** Signature of the persistent-links inputs; equality ⇒ the rebuild+upload
   *  can be skipped. Includes a minute component so recency buckets still age. */
  function computeLinksSig(): string {
    const mode = linkModeRef.current;
    if (mode === "selected") return "selected";
    let h = 0x811c9dc5;
    const mix = (s: string) => {
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x2c, 0x01000193);
    };
    mix(mode);
    mix(myNodeIdRef.current ?? "");
    mix(String(tracerouteEpochRef.current));
    mix(String(Math.floor(Date.now() / 60_000)));
    for (const [id, node] of Object.entries(nodesRef.current)) {
      if (!node.neighbors?.length && !node.map_position) continue;
      mix(nodeLinkSig(id, node));
    }
    return String(h >>> 0);
  }

  /** Push persistent link data to the "links" source (skipped when the
   *  link-relevant inputs are signature-identical to the last upload). */
  function refreshMapboxLinks() {
    const map = mbMapRef.current;
    if (!map) return;
    try {
      const linksSource = map.getSource("links") as MlGeoJSONSource | undefined;
      if (!linksSource) return;
      const sig = computeLinksSig();
      if (sig === persistentLinksSigRef.current) return;
      persistentLinksSigRef.current = sig;
      linksSource.setData(computePersistentLinks());
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
        // Wait for a settled frame ('idle': tiles loaded, fades finished),
        // then capture synchronously inside the next 'render' callback — the
        // just-drawn frame is still in the WebGL buffer there, so the map
        // doesn't need preserveDrawingBuffer (a per-frame GPU tax).
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
        map.once("idle", () => {
          if (done) return;
          map.once("render", capture);
          map.triggerRepaint();
        });
        map.triggerRepaint();
        // Slow tile loads can hold 'idle' off for a while; report failure
        // rather than silently downloading a blank or half-loaded frame.
        setTimeout(() => {
          if (done) return;
          done = true;
          toast("Couldn't export the map — rendering didn't settle in time", { kind: "error" });
        }, 8000);
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
      // The traceroute tool owns link-highlight + path-analysis while showing
      // results (empty-map clicks and panel closes must not wipe its routes —
      // nothing would redraw them).
      const traceResultActive = activeToolRef.current === "traceroute" && toolStepRef.current === "result";
      if (!traceResultActive) {
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
    }

    // Hide the panel
    setDetailsData(null);
  }

  /** Center the map on a coordinate and drop (or move) the jump-to pin. Camera +
   *  DOM marker only, so it doesn't touch tool state. */
  const jumpToCoord = useCallback((lngLat: [number, number]) => {
    const map = mbMapRef.current;
    if (!map) return;
    const [lng, lat] = lngLat;

    // Center on the point; zoom in to a useful level but never zoom out.
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });

    const popupHtml = () => {
      const ll = coordPinMarkerRef.current?.getLngLat() ?? { lng, lat };
      return `<div style="font-size:11px;font-weight:600;white-space:nowrap">📍 ${formatLatLng(ll.lng, ll.lat)}</div>`;
    };

    if (coordPinMarkerRef.current) {
      coordPinMarkerRef.current.setLngLat([lng, lat]);
      coordPinPopupRef.current?.setHTML(popupHtml());
      if (coordPinPopupRef.current && !coordPinPopupRef.current.isOpen()) {
        coordPinMarkerRef.current.togglePopup();
      }
    } else {
      const popup = new maplibregl.Popup({ offset: 28, closeButton: true, className: "map-coord-pin-popup" }).setHTML(popupHtml());
      const marker = new maplibregl.Marker({ color: "#ec4899", draggable: true })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);
      // Pause the cursor-elevation handler while dragging; refresh coords on drop.
      marker.on("dragstart", () => { isDraggingMarkerRef.current = true; });
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        popup.setHTML(popupHtml());
      });
      coordPinMarkerRef.current = marker;
      coordPinPopupRef.current = popup;
      marker.togglePopup(); // open initially
    }
    setHasCoordPin(true);
  }, []);

  /** Remove the jump-to pin (and its popup). */
  const clearCoordPin = useCallback(() => {
    coordPinPopupRef.current?.remove();
    coordPinPopupRef.current = null;
    coordPinMarkerRef.current?.remove();
    coordPinMarkerRef.current = null;
    setHasCoordPin(false);
  }, []);

  // Tear down the jump-to pin when the map page unmounts.
  useEffect(() => {
    return () => {
      coordPinPopupRef.current?.remove();
      coordPinMarkerRef.current?.remove();
    };
  }, []);

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
      // PNG export captures inside a 'render' callback (see handleExport), so
      // preserveDrawingBuffer — a per-frame GPU copy for the page lifetime —
      // stays off.
      maxPitch: 85,
      // Cap the per-source out-of-view tile cache; the viewport-scaled default
      // (~270 tiles/source) can pin hundreds of MB of GPU textures with @2x
      // rasters + a DEM source.
      maxTileCacheSize: 128,
      // Shorter raster crossfade → shorter forced-repaint tail per tile load.
      fadeDuration: 100,
      // Basemap/DEM tiles barely change; don't re-request them when their
      // ~25h max-age lapses in a long-open tab.
      refreshExpiredTiles: false,
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
    // Seed the pill before the first moveend (child effects registered the sink first)
    coordPillSinkRef.current?.setCenter(initialCenter);

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
    const buildNodesFc = () =>
      nodesGeoJSONBuilderRef.current(nodesRef.current, recentDaysRef.current, getFilters());

    const refreshMapboxNodeData = () => {
      const m = mbMapRef.current;
      if (!m) return;

      const data = buildNodesFc();

      const clustered = m.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
      clustered?.setData(data);

      const plain = m.getSource("nodes_plain") as MlGeoJSONSource | undefined;
      plain?.setData(data);
      lastUploadedNodesFcRef.current = data;
      nodesFcStaleForRef.current = null;
    };

    const saveView = () => {
      const c = map.getCenter();
      localStorage.setItem("savedCenter", JSON.stringify([c.lng, c.lat]));
      localStorage.setItem("savedZoom", map.getZoom().toString());
      localStorage.setItem("savedPitch", map.getPitch().toString());
      localStorage.setItem("savedBearing", map.getBearing().toString());
      // Keep the coordinate pill's not-hovering fallback in sync with the view.
      coordPillSinkRef.current?.setCenter([c.lng, c.lat]);
      // Mirror view into ?lat/lng/z (debounced); here so it follows recreation.
      pushViewToUrlRef.current();
    };
    saveViewRef.current = saveView;
    map.on("moveend", () => {
      // Tours fire one moveend per leg — save only when the camera is the user's
      if (flyoverFlyingRef.current) return;
      saveView();
    });

    const ensureSourcesAndLayers = () => {
      ensureMapSourcesAndLayers(map, {
        getNodesData: buildNodesFc,
        clusterDonutLayerRef,
        activityLayerRef,
        animationsEnabled: livePacketsRef.current,
        dimForTool: activeToolRef.current != null && toolStepRef.current === "result",
      });

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

      // The LOS/trace tube layers are lazily (re-)added by the styleEpoch effect
      // while their tool is active; nothing to refresh here.

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
        const normId = normNodeId(id);
        const relevantTraceroutes = traceroutesRef.current.filter((tr) =>
          normalizedTraceroutePath(tr).includes(normId),
        );

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

      // Viewport refilter for the top-links panel — not per tour leg
      map.on("moveend", () => {
        if (activeToolRef.current === "traceroute" && !flyoverFlyingRef.current) {
          setMapMoveEpoch((v) => v + 1);
        }
      });

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

      // True when the click point lands on a fanned spiderfy marker — those
      // clicks must win over the layers still rendered underneath the fan.
      const hitsSpiderfyNode = (point: maplibregl.Point): boolean =>
        !!map.getLayer(SPIDERFY_LAYER_NODES) &&
        map.queryRenderedFeatures(point, { layers: [SPIDERFY_LAYER_NODES] }).length > 0;

      // Cluster click — handler is on the invisible circle hit-test layer
      // ("clusters"), NOT the symbol donut layer. Circle hit-testing is reliable
      // geometry; symbol hit-testing is flaky with dynamic icon-size expressions.
      map.on("click", "clusters", (e) => {
        const cluster = e.features?.[0];
        if (!cluster) return;

        // A cluster click zooms; while picking a merge origin it must not
        // also drop a coordinate pin underneath.
        if (pickingMergeOriginRef.current) {
          (e.originalEvent as MouseEvent & { _mergePickConsumed?: boolean })._mergePickConsumed = true;
        }

        // Spiral fans put inner leaves inside the donut's hit circle — let the
        // leaf click be handled by onNodeLayerClick instead of re-spiderfying.
        if (hitsSpiderfyNode(e.point)) return;

        const clusterId = cluster.properties?.cluster_id;
        const source = map.getSource("nodes_clustered") as MlGeoJSONSource;
        if (!source || clusterId == null) return;

        const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];

        // Re-clicking the fanned cluster's own donut toggles the fan closed
        // instead of wiping the selection and re-animating it.
        if (isSpiderfied(map)) {
          const b = map.project([lng, lat]);
          const isActiveFan = getActiveFanCenters().some((c) => {
            const a = map.project(c);
            return Math.hypot(a.x - b.x, a.y - b.y) < 10;
          });
          if (isActiveFan) {
            dismissClusterSpiderfy(map);
            return;
          }
        }

        const currentZoom = map.getZoom();
        const maxZoom = map.getMaxZoom();

        let handled = false;
        const zoomFallback = () => {
          if (handled) return;
          handled = true;
          removeSpiderfyLayers(map);
          map.easeTo({ center: [lng, lat], zoom: Math.min(currentZoom + 2, maxZoom) });
        };
        // getClusterExpansionZoom can be slow (or hang on a stale cluster_id
        // after setData); fall back to a plain zoom-in if no answer in time.
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
            const pool = buildNodesFc().features
              .filter((f) => f.geometry?.type === "Point") as any;
            const count = (cluster.properties?.point_count as number) ?? 0;
            void spiderfy(map, clusterId, [lng, lat], true, pool, count);
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

        // Merge-origin pick mode: a node click adds that node (with its GPS
        // altitude) instead of dropping a coordinate pin or opening selection
        if (pickingMergeOriginRef.current) {
          (e.originalEvent as MouseEvent & { _mergePickConsumed?: boolean })._mergePickConsumed = true;
          const cleanId = id.startsWith("!") ? id.slice(1) : id;
          const primaryId = (toolFromIdRef.current ?? "").replace(/^!/, "");
          if (cleanId === primaryId) {
            toast("That node is already the primary origin.");
          } else {
            addMergeOriginByIdRef.current(id);
          }
          mergeOrigins.setPickingMergeOrigin(false);
          return;
        }

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
        if (!clusterEnabledRef.current) {
          const overlap = findOverlappingPlainNodes(e.point);
          if (overlap.length >= 2) {
            const ids = overlap.map((f) => (f.properties?.id ?? "") as string);
            // Clicking the stacked originals under an open fan: keep the fan
            // and let the user pick a leaf instead of re-fanning.
            if (anyIdsFanned(ids)) return;
            const center: [number, number] = [
              circularMeanLng(overlap.map((f) => f.geometry.coordinates[0])),
              overlap.reduce((s, f) => s + f.geometry.coordinates[1], 0) / overlap.length,
            ];
            void spiderfyFeatures(map, center, overlap as any, true);
            return;
          }
        }

        void handleNodeClick(id);
      };
      // The base layers keep rendering under an open fan; when a click lands on
      // a fanned marker, only the spiderfy binding may handle it (else one click
      // selects two different nodes or double-consumes a tool pick).
      map.on("click", "unclustered-nodes", (e) => {
        if (!hitsSpiderfyNode(e.point)) onNodeLayerClick(e);
      });
      map.on("click", "plain-nodes", (e) => {
        if (!hitsSpiderfyNode(e.point)) onNodeLayerClick(e);
      });
      map.on("click", SPIDERFY_LAYER_NODES, onNodeLayerClick);
      map.on("click", SPIDERFY_LAYER_LABELS, (e) => {
        if (!hitsSpiderfyNode(e.point)) onNodeLayerClick(e);
      });

      // Virtual-origin click (coverage, scan, LOS tools). Fires when the
      // user clicks empty map during pick mode — drops a synthetic pin at
      // that lng/lat instead of requiring an existing node.
      map.on("click", (e) => {
        const t = activeToolRef.current;
        const step = toolStepRef.current;
        // Ignore if clicking on a node layer (handled by onNodeLayerClick) — the
        // label layers count too, or a label click drops a pin beside the node.
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["unclustered-nodes", "plain-nodes", "unclustered-labels", "plain-labels", "clusters", SPIDERFY_LAYER_NODES, SPIDERFY_LAYER_LABELS].filter((id) => map.getLayer(id)),
        });
        if (features.length > 0) return;

        if ((t === "coverage" || t === "scan") && step === "pickFrom") {
          // normalizeLng: clicks on a wrapped world copy give lngs outside ±180.
          setToolVirtualPos([normalizeLng(e.lngLat.lng), e.lngLat.lat]);
          setToolStep("result");
          map.getCanvas().style.cursor = "";
        } else if (t === "los" && step === "pickFrom") {
          setToolFromId(null);
          // normalizeLng: clicks on a wrapped world copy give lngs outside ±180
          losState.setLosVirtualFrom([normalizeLng(e.lngLat.lng), e.lngLat.lat]);
          setToolStep("pickTo");
        } else if (t === "los" && step === "pickTo") {
          setToolToId(null);
          losState.setLosVirtualTo([normalizeLng(e.lngLat.lng), e.lngLat.lat]);
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
        if (map.getLayer(SPIDERFY_LAYER_LEGS)) nodeLayers.push(SPIDERFY_LAYER_LEGS, SPIDERFY_LAYER_LEGS_SHADOW);

        // Small pad so a near-miss while aiming at a fan marker doesn't count
        // as "empty space" and nuke the whole fan.
        const PAD = 4;
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - PAD, e.point.y - PAD],
          [e.point.x + PAD, e.point.y + PAD],
        ];
        const hitNode = map.queryRenderedFeatures(bbox, { layers: nodeLayers }).length > 0;
        const hitCluster =
          map.queryRenderedFeatures(bbox, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        // Dismiss-and-remember in both modes so the auto pass won't immediately
        // re-open the set the user just closed.
        if (clusterEnabledRef.current) dismissClusterSpiderfy(map);
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
          // Chase zoom is below the spiderfy threshold — skip the O(N) pool per leg
          if (flyoverFlyingRef.current) return;
          if (nodesHiddenRef.current) return;
          if (clusterEnabledRef.current) {
            // Cache-hit in the builder — reuses the FC last uploaded to the source
            const pool = buildNodesFc().features
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

      // Hover UI: cursor elevation feed, node tooltips, link hover cards
      bindMapHoverUi(map, { mbMapRef, nodesRef, coordPillSinkRef, isDraggingMarkerRef, terrain3DRef });
    };

    map.on("style.load", () => {
      styleEverLoadedRef.current = true;
      setStyleEpoch((e) => e + 1);
    });
    map.on("style.load", ensureSourcesAndLayers);

    return () => {
      if (mapLoadFallbackRef.current) clearTimeout(mapLoadFallbackRef.current);
      if (mbTouchCleanupRef.current) {
        mbTouchCleanupRef.current();
        mbTouchCleanupRef.current = null;
      }
      if (mbMapRef.current) {
        // Reset the spiderfy module state before the map dies — it's module-
        // global and would otherwise leak a phantom fan into the next mount.
        removeSpiderfyLayers(mbMapRef.current);
        // map.remove() tears the style down without calling custom layers'
        // onRemove — the activity overlay's canvas/context/listeners only get
        // cleaned through an explicit removeLayer (or its own dispose).
        try {
          if (mbMapRef.current.getLayer("activity")) mbMapRef.current.removeLayer("activity");
          else activityLayerRef.current?.onRemove(mbMapRef.current);
        } catch {}
        activityLayerRef.current = null;
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
      // The recreated links source starts empty — invalidate the sig so the
      // next links effect re-pushes instead of skipping as "unchanged".
      persistentLinksSigRef.current = "";
      // setStyle wipes the fan layers; reset the module state with them or the
      // auto passes stay blocked on a fan that no longer exists.
      removeSpiderfyLayers(map);

      map.setStyle(buildMapStyle({ provider, osmBasemap, mapboxToken, mapboxStyle }));
    } catch {}
  }, [mapboxStyle, osmBasemap, provider, mapboxToken]);

  // Cluster toggle + coverage-layer node hiding
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    // Live setData only feeds the visible source; refresh the one we're about
    // to show if it went stale while hidden.
    const stale = nodesFcStaleForRef.current;
    const fc = lastUploadedNodesFcRef.current;
    if (
      fc &&
      ((clusterEnabled && stale === "clustered") || (!clusterEnabled && stale === "plain"))
    ) {
      const src = map.getSource(clusterEnabled ? "nodes_clustered" : "nodes_plain") as
        | MlGeoJSONSource
        | undefined;
      src?.setData(fc as any);
      nodesFcStaleForRef.current = null;
    }
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

    const data = nodesGeoJSONBuilderRef.current(nodes, recentDays, { role: roleFilter, channel: channelFilter });

    // Identical FC identity ⇒ nothing GL-visible changed ⇒ skip the upload
    // (each nodes_clustered setData forces a full cluster-donut rebuild).
    // Only the visible source gets live data; the hidden one is refreshed by
    // the cluster-toggle effect when it's about to be shown.
    if (data !== lastUploadedNodesFcRef.current) {
      lastUploadedNodesFcRef.current = data;
      if (clusterEnabled) {
        (map.getSource("nodes_clustered") as MlGeoJSONSource | undefined)?.setData(data);
        nodesFcStaleForRef.current = "plain";
      } else {
        (map.getSource("nodes_plain") as MlGeoJSONSource | undefined)?.setData(data);
        nodesFcStaleForRef.current = "clustered";
      }
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
  }, [nodes, recentDays, roleFilter, channelFilter, clusterEnabled, minuteTick]);

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
      // The source no longer matches the last computed signature — invalidate,
      // or switching back to all/mynode within the minute would skip the
      // re-upload and leave the map without link lines.
      persistentLinksSigRef.current = "";
      return;
    }

    if (linkMode !== "selected") {
      refreshMapboxLinks();
    }
    // minuteTick: recency-bucket aging; styleEpoch: recreated (empty) source
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkMode, myNodeId, nodes, rawTraceroutes, minuteTick, styleEpoch]);

  // ----------------------------
  // Settings panel UI
  // ----------------------------
  const canUseMapbox = hasMapbox;
  const usingMapbox = provider === "mapbox" && canUseMapbox;

  // Flat sorted list of nodes with positions for the My Node picker.
  // Signature-gated: the O(N log N) sort + N object allocations only re-run
  // when an id/name/position-presence actually changed, not per SSE flush.
  const pickerSigCacheRef = useRef(new WeakMap<IMapNode, string>());
  const nodeListPrevRef = useRef<{ sig: number; list: { id: string; shortname?: string; longname?: string }[] }>({ sig: -1, list: [] });
  const nodeList = useMemo(() => {
    const cache = pickerSigCacheRef.current;
    let h = 0x811c9dc5;
    for (const [id, n] of Object.entries(nodes)) {
      if (!n.map_position) continue;
      let s = cache.get(n);
      if (s === undefined) {
        s = `${id}|${n.shortname ?? ""}|${n.longname ?? ""}`;
        cache.set(n, s);
      }
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 0x2c, 0x01000193);
    }
    const sig = h >>> 0;
    if (nodeListPrevRef.current.sig === sig) return nodeListPrevRef.current.list;
    const list = Object.entries(nodes)
      .filter(([, n]) => n.map_position)
      .map(([id, n]) => ({ id, shortname: n.shortname, longname: n.longname }))
      .sort((a, b) => (a.shortname ?? "").localeCompare(b.shortname ?? ""));
    nodeListPrevRef.current = { sig, list };
    return list;
  }, [nodes]);

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

      {/* Top-bar widgets in visual order below xl (DOM order = tab order):
          search, tools, health, coverage. At xl+ coverage returns to the top
          row visually LEFT of health — a known tab-order mismatch, accepted to
          keep the phone/tablet order correct. The open tools menu paints above
          the row-2 pills via its z-40. */}
      <MapSearchBar
        nodes={nodes}
        onSelect={handlePanelNodeSelect}
      />

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
        onRequestTerrainSetup={openTerrainSetup}
      />

      <MapHealthWidget nodes={nodes} hidden={activeTool != null} />

      <LiveCoveragePill
        enabled={liveCoverage}
        onToggle={() => setLiveCoverage((v) => !v)}
        status={liveCoverageState.status}
        meta={liveCoverageState.meta}
        opacity={liveCoverageOpacity}
        onOpacityChange={setLiveCoverageOpacity}
        hideNodes={liveCoverageHideNodes}
        onHideNodesChange={setLiveCoverageHideNodes}
        group={liveCoverageGroup}
        onGroupChange={setLiveCoverageGroup}
        hidden={activeTool != null}
      />

      {/* Before MapSettingsPanel so the bottom row tabs left-to-right and the
          mobile settings sheet (also z-1100, later in DOM) paints above it. */}
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
        hidden={!!detailsData || activeTool != null || settingsPanelOpen}
      />

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

      {myNodeLabel && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-1060 px-3 py-1.5 rounded-xl shadow-2xl bg-gray-900/95 text-sm border border-white/10 flex items-center gap-2">
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
        onClose={handleDetailsClose}
        onNodeSelect={handlePanelNodeSelect}
        onHoverLink={handlePanelHoverLink}
      />

      <ClusterHoverCard hover={clusterHover} leaves={clusterHoverLeaves} />
      <CoverageLookupCard hover={clusterHover ? null : coverageHover} nodes={nodes} />

      <button
        type="button"
        onClick={() => setLivePackets((v) => !v)}
        // lg+: right of the filters pill, which owns the corner (fixed at
        // map-pad+1rem; this button is absolute inside the rail-shifted map
        // container, so plain left-32 lands just past the pill's 192px edge).
        // Below lg the filters pill stacks above this button instead. Hidden
        // during tool sessions: the centered result panels (coverage 560px,
        // traceroute 560px, LOS 1200px) all reach this spot at lg widths.
        className={`absolute bottom-3 left-3 lg:left-32 z-30 flex items-center gap-2 rounded-xl border border-white/10 bg-gray-900/95 px-3 py-1.5 text-xs font-medium shadow-2xl transition hover:bg-gray-900 ${activeTool != null ? "hidden" : ""}`}
        title={livePackets ? "Live map animations on — click to turn off" : "Live map animations off — click to turn on"}
      >
        <span className={`h-2 w-2 rounded-full ${livePackets ? "bg-emerald-400 animate-pulse" : "bg-gray-500"}`} />
        <span className="text-gray-200">Animations</span>
      </button>

      <MapCoordinatePill
        sinkRef={coordPillSinkRef}
        hasPin={hasCoordPin}
        onJump={jumpToCoord}
        onClearPin={clearCoordPin}
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
                  ? "LOS: pick the first node (or click anywhere on the map)"
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
              ? "LOS: pick the second node (or click anywhere on the map)"
              : traceCandidates.length > 0
                ? `Traceroute: pick the second node — ${traceCandidates.length} ringed ${traceCandidates.length === 1 ? "node has" : "nodes have"} observed routes`
                : "Traceroute: pick the second node (no routes in the recent window touch this origin)"
          }
          hint="Press Esc to cancel"
          onCancel={resetTool}
        />
      )}

      {/* Floating LoS panel when LOS tool reached result step */}
      {activeTool === "los" && toolStep === "result" && (toolFromId || losState.losVirtualFrom) && (toolToId || losState.losVirtualTo) && (
        <Suspense fallback={null}>
        <MapLosPanel
          result={losState.losResult}
          fromLabel={
            toolFromId
              // `||` not `??` — some nodes report an empty shortname
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname?.trim() || toolFromId.slice(0, 8))
              : losState.losVirtualFrom
                ? `${losState.losVirtualFrom[1].toFixed(5)}, ${losState.losVirtualFrom[0].toFixed(5)}`
                : ""
          }
          toLabel={
            toolToId
              ? ((nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname?.trim() || toolToId.slice(0, 8))
              : losState.losVirtualTo
                ? `${losState.losVirtualTo[1].toFixed(5)}, ${losState.losVirtualTo[0].toFixed(5)}`
                : ""
          }
          fromColor="#06b6d4"
          toColor="#d946ef"
          terrainNeeded={!terrain3D}
          onEnableTerrain={() => setTerrain3D(true)}
          onClose={resetTool}
          isComputing={losState.isComputingLos}
          isRecomputing={losState.isComputingLos && !!losState.losResult}
          error={losState.losError}
          terrainWarning={losState.losTerrainWarning}
          fromHwIdx={losState.losFromHwIdx} onFromHwIdxChange={losState.setLosFromHwIdx}
          fromAntIdx={losState.losFromAntIdx} onFromAntIdxChange={losState.setLosFromAntIdx}
          fromHeightM={losState.losFromHeightM} onFromHeightChange={losState.setLosFromHeightM}
          toHwIdx={losState.losToHwIdx} onToHwIdxChange={losState.setLosToHwIdx}
          toAntIdx={losState.losToAntIdx} onToAntIdxChange={losState.setLosToAntIdx}
          toHeightM={losState.losToHeightM} onToHeightChange={losState.setLosToHeightM}
          freqMhz={losState.losFreqMhz} onFreqMhzChange={losState.setLosFreqMhz}
          presetIdx={losState.losPresetIdx} onPresetIdxChange={losState.setLosPresetIdx}
          fromPosition={
            toolFromId
              ? (() => { const p = (nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.map_position; return p ? [p[0], p[1]] as [number, number] : null; })()
              : losState.losVirtualFrom
          }
          toPosition={
            toolToId
              ? (() => { const p = (nodes[toolToId] ?? nodes[`!${toolToId}`])?.map_position; return p ? [p[0], p[1]] as [number, number] : null; })()
              : losState.losVirtualTo
          }
          onFromPositionChange={setLosFromPosition}
          onToPositionChange={setLosToPosition}
          onSwapEndpoints={swapLosEndpoints}
          demSource={losState.losDemSource}
          onProfileHover={losCompute.handleLosProfileHover}
        />
        </Suspense>
      )}

      {/* Stays mounted (force-minimized) during a Scan-from-here overlay so
          the user knows coverage is paused, not closed. */}
      {((activeTool === "coverage") || coverage.keepCoveragePaint) && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <Suspense fallback={null}>
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
            // Flag the never-painted settings so re-selecting them offers Recalculate
            coverageCompute.markComputeCancelled();
            coverage.setIsComputingCoverage(false);
            coverage.setIsFetchingCoverageTerrain(false);
            coverage.setCoverageProgress({ completed: 0, total: 0 });
          }}
          autoRecalc={coverage.coverageAutoRecalc}
          onAutoRecalcChange={coverage.setCoverageAutoRecalc}
          paramsDirty={coverage.coverageParamsDirty}
          onRecalculate={() => coverage.setCoverageRecalcNonce((n) => n + 1)}
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
            // Mirror coverage's RF settings so the scan results match the painted
            // prediction. applyMirror updates state WITHOUT persisting, so an overlay
            // scan never overwrites the user's own saved scan defaults. Origin
            // (toolFromId / toolVirtualPos) is already shared between the tools.
            scan.applyMirror({
              hardwareIdx: coverage.coverageHardwareIdx,
              antennaIdx: coverage.coverageAntennaIdx,
              antennaHeightM: coverage.coverageAntennaHeightM,
              customTxDbm: coverage.coverageCustomTxDbm,
              rxHardwareIdx: coverage.coverageRxHardwareIdx,
              rxAntennaIdx: coverage.coverageRxAntennaIdx,
              rxHeightM: coverage.coverageRxHeightM,
              presetIdx: coverage.coveragePresetIdx,
              customSensDbm: coverage.coverageCustomSensDbm,
              aggressionIdx: coverage.coverageAggressionIdx,
              clutterEnabled: coverage.coverageClutterEnabled,
              canopyEnabled: coverage.coverageCanopyEnabled,
              buildingsEnabled: coverage.coverageBuildingsEnabled,
              reliability: coverage.coverageReliability,
            });
            coverageCompute.skipNextCoverageComputeRef.current = true;
            coverage.setKeepCoveragePaint(true);
            setActiveTool("scan");
          }}
        />
        </Suspense>
      )}

      {/* Busiest-links column — browse corridors while the traceroute tool is active */}
      {activeTool === "traceroute" && (
        <Suspense fallback={null}>
        <MapTraceCorridorsPanel
          corridors={traceCorridors}
          sortMode={traceCorridorSort}
          onSortModeChange={setTraceCorridorSort}
          inViewOnly={traceCorridorsInView}
          onToggleInView={setTraceCorridorsInView}
          activePair={traceActivePair}
          hideOnMobile={toolStep === "result"}
          onHover={handleTraceHighlight}
          onPick={handleCorridorPick}
        />
        </Suspense>
      )}

      {/* Floating Traceroute panel */}
      {activeTool === "traceroute" && toolStep === "result" && toolFromId && toolToId && (
        <Suspense fallback={null}>
        <MapTraceroutePanel
          fromId={toolFromId}
          toId={toolToId}
          fromLabel={(nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname ?? toolFromId.slice(0, 8)}
          toLabel={(nodes[toolToId] ?? nodes[`!${toolToId}`])?.shortname ?? toolToId.slice(0, 8)}
          fromColor="#06b6d4"
          toColor="#d946ef"
          paths={tracePaths}
          runs={traceRuns}
          selectedSig={traceSelectedPath ? traceSelectedPath.hops.join(">") : null}
          onSelectPath={handleTraceSelectPath}
          analysis={traceCompute.traceAnalysis}
          isComputing={traceCompute.isComputingTrace}
          analysisError={traceCompute.traceError}
          analysisWarning={traceCompute.traceWarning}
          terrain3D={terrain3D}
          onEnableTerrain={openTerrainSetup}
          showDirect={traceShowDirect}
          onToggleDirect={setTraceShowDirect}
          isFlying={traceFlyover.isFlying}
          canFly={!prefersReducedMotion()}
          onToggleFlyover={handleToggleFlyover}
          loading={rawTraceroutesLoading || pairTraceroutesLoading}
          liveNodes={traceHopNodes}
          onNodeSelect={handlePanelNodeSelect}
          onHighlight={handleTraceHighlight}
          onClose={handleToolPanelClose}
        />
        </Suspense>
      )}

      {/* Floating Scan panel */}
      {activeTool === "scan" && toolStep === "result" && (toolFromId || toolVirtualPos) && (
        <Suspense fallback={null}>
        <MapScanPanel
          summary={scan.scanSummary}
          originLabel={
            toolFromId
              ? ((nodes[toolFromId] ?? nodes[`!${toolFromId}`])?.shortname?.trim() || toolFromId.slice(0, 8))
              : toolVirtualPos
                ? `${toolVirtualPos[1].toFixed(5)}, ${toolVirtualPos[0].toFixed(5)}`
                : "Virtual location"
          }
          isScanning={scan.isScanning}
          scanError={scan.scanError}
          terrainWarning={scan.scanTerrainWarning}
          onRetry={handleScanRetry}
          demSource={scan.scanDemSource}
          terrainNeeded={!terrain3D}
          onEnableTerrain={handleScanEnableTerrain}
          onClose={handleScanClose}
          onSelectResult={handleScanSelectResult}
          onHoverResult={handleScanHoverResult}
          onReturnToOrigin={handleScanReturnToOrigin}
          hiddenClasses={scan.hiddenScanClasses}
          onToggleClassVisibility={handleScanToggleClassVisibility}
          antennaIdx={scan.scanAntennaIdx}
          onAntennaIdxChange={scan.setScanAntennaIdx}
          hardwareIdx={scan.scanHardwareIdx}
          onHardwareIdxChange={scan.setScanHardwareIdx}
          antennaHeightM={scan.scanAntennaHeightM}
          onAntennaHeightChange={scan.setScanAntennaHeightM}
          rxHeightM={scan.scanRxHeightM}
          onRxHeightChange={scan.setScanRxHeightM}
          freqMhz={scan.scanFreqMhz}
          onFreqMhzChange={scan.setScanFreqMhz}
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
        </Suspense>
      )}
    </div>
  );
}
