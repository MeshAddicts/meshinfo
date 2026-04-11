import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, {
  GeoJSONSource as MbGeoJSONSource,
  Map as MbMap,
} from "mapbox-gl";
import { Feature, Map as OlMap, View } from "ol";
import { Coordinate } from "ol/coordinate";
import { click } from "ol/events/condition";
import { LineString } from "ol/geom";
import Point from "ol/geom/Point";
import Select from "ol/interaction/Select";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transform } from "ol/proj";
import { Vector } from "ol/source";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { env } from "../env";
import { createBaseTileLayer, type OsmBasemap } from "../maps/baseLayer";
import { reverseGeocode } from "../maps/geocoder";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { buildAllLinksFeatureCollection, buildMapboxLinkFeatureCollection, buildTracerouteLinkFeatureCollection, computeHeardByIds, normNodeId } from "./map/linkFeatures";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapQuickControls } from "./map/MapQuickControls";
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
  computeRecentNodes,
  emptyLineFeatureCollection,
} from "./map/utils";

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

const onlineStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: "rgba(50, 240, 50, 1)" }),
    stroke: new Stroke({ color: "white", width: 2 }),
  }),
});

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

  // Mapbox refs (Mapbox path)
  const mbMapRef = useRef<MbMap | null>(null);
  const mbSelectedIdRef = useRef<string | null>(null);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);
  const mbKeydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // Shared ref for panel node-select callback (set by whichever provider is active)
  const handleNodeSelectRef = useRef<(nodeId: string) => void>(() => {});

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
      const color = kind === "traceroute" ? "#F59E0B" : kind === "both" ? "#FF66FF" : kind === "heard_by" ? "#6666FF" : "#66FF66";
      line.setStyle(
        new Style({
          stroke: new Stroke({ color, width: 4 }),
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


    // Restore persistent links (all/mynode) or clear if mode is "selected"
    if (map) {
      try {
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(computePersistentLinks());
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

    // If deep-linking to a node, override initial center/zoom
    const flyTarget = flyToTargetRef.current;
    const initialCenter: [number, number] = flyTarget
      ? [flyTarget[0], flyTarget[1]]
      : [savedLon ?? centerPos.longitude, savedLat ?? centerPos.latitude];

    let initialZoom = flyTarget ? 14 : 9.5;
    if (!flyTarget) {
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
      logoPosition: "bottom-left",
    });

    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-left");

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

    const refreshMapboxNodeData = () => {
      const m = mbMapRef.current;
      if (!m) return;

      const data = buildNodesGeoJSON(nodesRef.current, recentDaysRef.current);

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

    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: true }),
      "top-right"
    );

    const ensureSourcesAndLayers = () => {
      // clustered nodes source
      if (!map.getSource("nodes_clustered")) {
        map.addSource("nodes_clustered", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current),
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 24,
        });
      }

      // plain nodes source
      if (!map.getSource("nodes_plain")) {
        map.addSource("nodes_plain", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current),
        });
      }

      // links source
      if (!map.getSource("links")) {
        map.addSource("links", {
          type: "geojson",
          data: emptyLineFeatureCollection(),
        });
      }

      // links layer
      if (!map.getLayer("links-line")) {
        map.addLayer({
          id: "links-line",
          type: "line",
          source: "links",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-width": 4,
            "line-opacity": 0.9,
            "line-color": [
              "match",
              ["get", "kind"],
              "neighbor",
              "#66FF66",
              "heard_by",
              "#6666FF",
              "both",
              "#FF66FF",
              "traceroute",
              "#F59E0B",
              "#FFFFFF",
            ],
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

      // clustered unclustered nodes
      if (!map.getLayer("unclustered-nodes")) {
        map.addLayer({
          id: "unclustered-nodes",
          type: "circle",
          source: "nodes_clustered",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 10, 6],
            "circle-color": [
              "case",
              ["boolean", ["get", "online"], false],
              "#32f032",
              "rgba(0,0,0,0.50)",
            ],
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

      // plain nodes layer
      if (!map.getLayer("plain-nodes")) {
        map.addLayer({
          id: "plain-nodes",
          type: "circle",
          source: "nodes_plain",
          paint: {
            "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 10, 6],
            "circle-color": [
              "case",
              ["boolean", ["get", "online"], false],
              "#32f032",
              "rgba(0,0,0,0.50)",
            ],
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

      // Ensure sources have current data (important after style changes)
      refreshMapboxNodeData();

      // Bind handlers once
      if (mbHandlersBoundRef.current) return;
      mbHandlersBoundRef.current = true;

      const handleNodeClick = async (id: string) => {
        const liveNodes = nodesRef.current;
        const node = liveNodes[id];
        if (!node?.map_position) return;

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
        };

        const heardBy = computeHeardByIds(liveNodes, id);

        setDetailsDataRef.current({
          node: nodeLike,
          liveNodes,
          displayName: displayName || "Unknown",
          elsewhereLinks: configRef.current?.mesh?.elsewhere_links,
          traceroutes: traceroutesRef.current,
          channelLabel: resolveChannelLabel((node as any).last_channel),
          heardBy,
        });

        // Draw links (neighbor + traceroute)
        const neighborFC = buildMapboxLinkFeatureCollection({ node: nodeLike, liveNodes, heardBy });
        const tracerouteFC = buildTracerouteLinkFeatureCollection(
          traceroutesRef.current.filter((tr) => {
            const norm = normNodeId(id);
            const from = normNodeId(tr.from);
            const to = normNodeId(tr.to);
            if (from === norm || to === norm) return true;
            const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
            return hops.includes(norm);
          }),
          liveNodes,
        );
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
      };

      // Expose handleNodeClick for panel node-select navigation
      handleNodeSelectRef.current = (id: string) => void handleNodeClick(id);

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

      // Clicking nodes (clustered mode)
      map.on("click", "unclustered-nodes", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;
        void handleNodeClick(id);
      });

      // Clicking nodes (plain mode)
      map.on("click", "plain-nodes", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;
        void handleNodeClick(id);
      });

      // Clicking spiderfied nodes
      map.on("click", SPIDERFY_LAYER_NODES, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;
        void handleNodeClick(id);
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

      // Escape key collapses spiderfy
      const handleKeydown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          void unspiderfy(map);
          clearMapboxSelectionAndOverlays();
        }
      };
      mbKeydownHandlerRef.current = handleKeydown;
      document.addEventListener("keydown", handleKeydown);
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

  // Mapbox: live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;

    const data = buildNodesGeoJSON(nodes, recentDays);

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
  }, [nodes, recentDays, provider]);

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

    // If deep-linking to a node, override initial center/zoom
    const flyTarget = flyToTargetRef.current;
    const initialCenter = flyTarget
      ? fromLonLat([flyTarget[0], flyTarget[1]])
      : fromLonLat([savedLon ?? centerPos.longitude, savedLat ?? centerPos.latitude]);

    let initialZoom = flyTarget ? 14 : 9.5;
    if (!flyTarget) {
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

    map.on("pointermove", (evt) => {
      const hit = map.hasFeatureAtPixel(evt.pixel);
      map.getTargetElement().style.cursor = hit ? "pointer" : "";
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

        feature.setStyle(node.online ? onlineStyle : offlineStyle);
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
      };

      const heardBy = computeHeardByIds(liveNodes, node.id);

      setDetailsDataRef.current({
        node: nodeLike,
        liveNodes,
        displayName: displayName || "Unknown",
        elsewhereLinks: configRef.current?.mesh?.elsewhere_links,
        traceroutes: traceroutesRef.current,
        channelLabel: resolveChannelLabel((fullNode as any)?.last_channel),
        heardBy,
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

        const vectorLineLayer = new VectorLayer({
          source: vectorLine,
          style: new Style({
            fill: new Fill({ color: "#66FF66" }),
            stroke: new Stroke({ color: "#66FF66", width: 4 }),
          }),
        });
        neighborLayers.push(vectorLineLayer);
        map.addLayer(vectorLineLayer);
      });
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

      if (clusterEnabledRef.current) {
        // Clustered mode — use spiderfy-aware click handler
        const node = handleOlClusterClick(map, clusterSetup.clusterSource, event.pixel);
        if (node) {
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

        feature.setStyle(node.online ? onlineStyle : offlineStyle);
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
          f.setStyle(node.online ? onlineStyle : offlineStyle);
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
        recentDays={recentDays}
        setRecentDays={setRecentDays}
        clusterEnabled={clusterEnabled}
        setClusterEnabled={setClusterEnabled}
        linkMode={linkMode}
        setLinkMode={setLinkMode}
        myNodeId={myNodeId}
        setMyNodeId={setMyNodeId}
        nodeList={nodeList}
        canUseMapbox={canUseMapbox}
        usingMapbox={usingMapbox}
      />

      <MapQuickControls
        recentDays={recentDays}
        setRecentDays={setRecentDays}
        linkMode={linkMode}
        setLinkMode={setLinkMode}
        clusterEnabled={clusterEnabled}
        setClusterEnabled={setClusterEnabled}
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
      />

      <style>
        {`
          #map { position: absolute; inset: 0; }
        `}
      </style>
    </div>
  );
}
