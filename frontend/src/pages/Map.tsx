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
import { analyzeLineOfSight, type LoSResult } from "./map/losAnalysis";
import { findPathsBetween } from "./map/pathAnalysis";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapHealthWidget } from "./map/MapHealthWidget";
import { MapLosPanel } from "./map/MapLosPanel";
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
  const olHighlightLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);
  const olCoverageLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);
  const olPathLayerRef = useRef<VectorLayer<VectorSource<Feature>, Feature> | null>(null);

  // Mapbox refs (Mapbox path)
  const mbMapRef = useRef<MbMap | null>(null);
  const mbSelectedIdRef = useRef<string | null>(null);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);
  const mbKeydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

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
  const [pathPickMode, setPathPickMode] = useState(false);
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<"los" | "traceroute" | null>(null);

  // 3D terrain (Mapbox only)
  const [terrain3D, setTerrain3D] = useState<boolean>(() => readJson<boolean>(LS_KEYS.terrain3D, false));
  const [terrainExaggeration, setTerrainExaggeration] = useState<number>(
    () => readJson<number>(LS_KEYS.terrainExaggeration, 1.5)
  );
  const [losResult, setLosResult] = useState<LoSResult | null>(null);

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
  const pathPickModeRef = useRef(pathPickMode);
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
  useEffect(() => {
    pathPickModeRef.current = pathPickMode;
  }, [pathPickMode]);
  useEffect(() => {
    terrain3DRef.current = terrain3D;
  }, [terrain3D]);
  useEffect(() => {
    terrainExaggerationRef.current = terrainExaggeration;
  }, [terrainExaggeration]);

  // Path-pick cursor feedback
  useEffect(() => {
    // Visual feedback: crosshair cursor on map canvas
    const mb = mbMapRef.current;
    if (mb) {
      mb.getCanvas().style.cursor = pathPickMode ? "crosshair" : "";
    }
    if (olMap) {
      const el = olMap.getTargetElement();
      if (el) el.style.cursor = pathPickMode ? "crosshair" : "";
    }
  }, [pathPickMode, olMap]);

  // Clear tool state when selected node changes or panel closes
  useEffect(() => {
    if (!detailsData) {
      setPathTargetId(null);
      setPathPickMode(false);
      setActiveTool(null);
    }
  }, [detailsData]);

  // Draw shortest traceroute path between selected node and pathTargetId (both providers)
  useEffect(() => {
    // Helper: compute shortest path coordinates
    const computePathCoords = (): [number, number][] | null => {
      if (activeTool !== "traceroute" || !pathTargetId || !detailsData) return null;
      const paths = findPathsBetween(detailsData.node.id, pathTargetId, rawTraceroutes);
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
  }, [activeTool, pathTargetId, detailsData, rawTraceroutes, nodes, olMap]);

  // Line-of-sight analysis between selected node and pathTargetId.
  // Only runs when the LOS tool is active.
  useEffect(() => {
    if (activeTool !== "los" || !pathTargetId || !detailsData) {
      setLosResult(null);
      return;
    }
    if (provider !== "mapbox" || !terrain3D) {
      // Terrain not available — mark as needing terrain, clear result
      setLosResult(null);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) {
      setLosResult(null);
      return;
    }
    const fromLive = nodes[detailsData.node.id];
    const toLive = nodes[pathTargetId] ?? nodes[`!${pathTargetId}`];
    if (!fromLive?.map_position || !toLive?.map_position) {
      setLosResult(null);
      return;
    }

    const fromPos: [number, number] = [fromLive.map_position[0], fromLive.map_position[1]];
    const toPos: [number, number] = [toLive.map_position[0], toLive.map_position[1]];
    const fromAltitude = fromLive.position?.altitude ?? null;
    const toAltitude = toLive.position?.altitude ?? null;

    // Give terrain DEM tiles a moment to load before sampling
    const run = () => {
      try {
        const result = analyzeLineOfSight({
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
        setLosResult(result);
      } catch (err) {
        console.warn("[Map] LoS analysis failed:", err);
        setLosResult(null);
      }
    };

    // Fit the viewport to include both points so terrain tiles load for sampling
    const bounds = new mapboxgl.LngLatBounds(fromPos, toPos);
    mb.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 13 });

    // Wait for terrain tiles to settle, then sample
    const timer = setTimeout(run, 1200);
    return () => clearTimeout(timer);
  }, [activeTool, pathTargetId, detailsData, provider, terrain3D, nodes]);

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
    // Remove old layer
    if (olPersistentLinksLayerRef.current) {
      map.removeLayer(olPersistentLinksLayerRef.current);
      olPersistentLinksLayerRef.current = null;
    }

    const mode = linkModeRef.current;
    if (mode === "selected") return;

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
      linksSource?.setData(computePersistentLinks());
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
        // If in path-pick mode, set as path target instead of selecting
        if (pathPickModeRef.current && mbSelectedIdRef.current && id !== mbSelectedIdRef.current) {
          setPathTargetId(id);
          setPathPickMode(false);
          map.getCanvas().style.cursor = "";
          return;
        }
        void handleNodeClick(id);
      };
      map.on("click", "unclustered-nodes", onNodeLayerClick);
      map.on("click", "plain-nodes", onNodeLayerClick);
      map.on("click", SPIDERFY_LAYER_NODES, onNodeLayerClick);

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
      canvas.addEventListener("touchstart", (e) => {
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
      }, { passive: true });

      canvas.addEventListener("touchmove", () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        longPressPoint = null;
      }, { passive: true });

      canvas.addEventListener("touchend", () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        longPressPoint = null;
      }, { passive: true });

      // Keyboard navigation
      const handleKeydown = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        const PAN_PX = 100;
        switch (e.key) {
          case "Escape":
            if (pathPickModeRef.current) {
              setPathPickMode(false);
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

    map.getViewport().addEventListener("contextmenu", (e) => {
      const pixel = map.getEventPixel(e);
      const node = findOlNodeAtPixel(pixel);
      if (!node) return;
      e.preventDefault();
      setMyNodeId(node.id);
      setLinkMode("mynode");
    });

    // Long-press for mobile (OL)
    let olLongPressTimer: ReturnType<typeof setTimeout> | null = null;
    let olLongPressPixel: number[] | null = null;

    map.getViewport().addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const rect = map.getViewport().getBoundingClientRect();
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
    }, { passive: true });

    map.getViewport().addEventListener("touchmove", () => {
      if (olLongPressTimer) { clearTimeout(olLongPressTimer); olLongPressTimer = null; }
      olLongPressPixel = null;
    }, { passive: true });

    map.getViewport().addEventListener("touchend", () => {
      if (olLongPressTimer) { clearTimeout(olLongPressTimer); olLongPressTimer = null; }
      olLongPressPixel = null;
    }, { passive: true });

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

      // Helper: if in path-pick mode, intercept node clicks to set target
      const handleNodeClickMaybePick = (node: IFeatureNode) => {
        if (pathPickModeRef.current && selectedNodeIdRef.current && node.id !== selectedNodeIdRef.current) {
          setPathTargetId(node.id);
          setPathPickMode(false);
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
        pathAnalysis={{
          pickMode: pathPickMode,
          targetId: pathTargetId,
          activeTool,
          onEnterPickMode: (tool) => { setActiveTool(tool); setPathPickMode(true); },
          onClearPath: () => { setPathTargetId(null); setPathPickMode(false); setActiveTool(null); },
        }}
      />

      {/* Floating LoS panel — bottom-center when LOS tool is active */}
      {pathTargetId && detailsData && activeTool === "los" && (
        <MapLosPanel
          result={losResult}
          fromLabel={detailsData.node.shortname ?? detailsData.node.id.slice(0, 8)}
          toLabel={
            (nodes[pathTargetId] ?? nodes[`!${pathTargetId}`])?.shortname
            ?? pathTargetId.slice(0, 8)
          }
          fromColor="#22c55e"
          toColor="#06b6d4"
          terrainNeeded={provider === "mapbox" && !terrain3D}
          onEnableTerrain={provider === "mapbox" ? () => setTerrain3D(true) : undefined}
          onClose={() => { setPathTargetId(null); setPathPickMode(false); }}
          isComputing={provider === "mapbox" && terrain3D && !losResult}
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
