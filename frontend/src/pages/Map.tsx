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
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { createBaseTileLayer, type OsmBasemap } from "../maps/baseLayer";
import { reverseGeocode } from "../maps/geocoder";
import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { clearDetailsPanel, getDetailsDom, setDetailsPanelContent } from "./map/detailsDom";
import { buildMapboxLinkFeatureCollection, buildNodeDetailsHtml } from "./map/detailsHtml";
import { MapDetailsPanel } from "./map/MapDetailsPanel";
import { MapSettingsPanel } from "./map/MapSettingsPanel";
import { LS_KEYS, readJson, toMapboxStyleUrl, writeJson } from "./map/storage";
import type { IFeatureNode, IMapNode, MapProvider, NodeLike } from "./map/types";
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

  // Mapbox refs (Mapbox path)
  const mbMapRef = useRef<MbMap | null>(null);
  const mbSelectedIdRef = useRef<string | null>(null);
  const mbHandlersBoundRef = useRef(false);
  const mbCurrentStyleUrlRef = useRef<string | null>(null);

  const { data: rawNodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  // ----- env capabilities
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
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
      (import.meta.env.VITE_MAPBOX_STYLE as string | undefined) ??
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
  // Refs to avoid stale closures (Mapbox handlers)
  // ----------------------------
  const nodesRef = useRef(nodes);
  const recentDaysRef = useRef(recentDays);
  const clusterEnabledRef = useRef(clusterEnabled);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    recentDaysRef.current = recentDays;
  }, [recentDays]);

  useEffect(() => {
    clusterEnabledRef.current = clusterEnabled;
  }, [clusterEnabled]);

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

  function clearMapboxSelectionAndOverlays() {
    const map = mbMapRef.current;
    const selectedId = mbSelectedIdRef.current;

    if (map && selectedId) {
      // Clear selection ring (feature-state) for both sources (clustered + plain)
      try {
        if (map.getSource("nodes_clustered")) {
          map.setFeatureState({ source: "nodes_clustered", id: selectedId }, { selected: false });
        }
      } catch {}

      try {
        if (map.getSource("nodes_plain")) {
          map.setFeatureState({ source: "nodes_plain", id: selectedId }, { selected: false });
        }
      } catch {}
    }

    mbSelectedIdRef.current = null;

    // Clear link lines if present
    if (map) {
      try {
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
      } catch {}
    }

    // Hide + clear the panel
    clearDetailsPanel();
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
      attributionControl: true,
    });

    mbMapRef.current = map;

    const clearSelected = () => {
      const prev = mbSelectedIdRef.current;
      if (!prev) return;
      try {
        map.setFeatureState({ source: "nodes_clustered", id: prev }, { selected: false });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to clear feature state for nodes_clustered", error);
        }
      }
      try {
        map.setFeatureState({ source: "nodes_plain", id: prev }, { selected: false });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to clear feature state for nodes_plain", error);
        }
      }
      mbSelectedIdRef.current = null;
    };

    const setSelected = (id: string) => {
      if (mbSelectedIdRef.current && mbSelectedIdRef.current !== id) {
        clearSelected();
      }

      mbSelectedIdRef.current = id;

      try {
        map.setFeatureState({ source: "nodes_clustered", id }, { selected: true });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to set feature state for nodes_clustered", error);
        }
      }
      try {
        map.setFeatureState({ source: "nodes_plain", id }, { selected: true });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to set feature state for nodes_plain", error);
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

    const isMobile = window.innerWidth < 1024;
    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: true }),
      isMobile ? "top-right" : "top-left"
    );

    const ensureSourcesAndLayers = () => {
      // clustered nodes source
      if (!map.getSource("nodes_clustered")) {
        map.addSource("nodes_clustered", {
          type: "geojson",
          data: buildNodesGeoJSON(nodesRef.current, recentDaysRef.current),
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
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
        };

        const { html, heardBy } = buildNodeDetailsHtml({
          node: nodeLike,
          liveNodes,
          displayName,
          elsewhereLinks: config?.mesh?.elsewhere_links,
        });

        setDetailsPanelContent({
          title: node.longname ?? "",
          subtitle: node.shortname ?? "",
          html,
        });

        // Draw links
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(buildMapboxLinkFeatureCollection({ node: nodeLike, liveNodes, heardBy }));
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

      // Clicking a cluster zooms in
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
          map.easeTo({ center: [lng, lat], zoom });
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

      // Clicking empty space clears
      map.on("click", (e) => {
        const hitNode =
          map.queryRenderedFeatures(e.point, {
            layers: ["unclustered-nodes", "plain-nodes", "unclustered-labels", "plain-labels"],
          }).length > 0;
        const hitCluster =
          map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        clearMapboxSelectionAndOverlays();
      });
    };

    map.on("style.load", ensureSourcesAndLayers);

    return () => {
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
      clearDetailsPanel();
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
        clearDetailsPanel();
      }
    }
  }, [nodes, recentDays, provider]);

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
          } satisfies IFeatureNode,
        });

        feature.setStyle(node.online ? onlineStyle : offlineStyle);
        return feature;
      })
      .filter((f): f is Feature<Point> => Boolean(f));

    const nodeSource = new VectorSource({ features });
    olNodesSourceRef.current = nodeSource;

    const vectorLayer = new VectorLayer({
      style: defaultStyle,
      source: nodeSource,
    });
    map.addLayer(vectorLayer);

    const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
    if (!nodePanel || !nodeTitle || !nodeSubtitle || !nodeContent) return;

    const neighborLayers: VectorLayer<VectorSource<Feature>, Feature>[] = [];

    const selectedStyle = new Style({
      image: new Circle({
        radius: 6,
        fill: new Fill({ color: "rgba(0, 0, 240, 1)" }),
        stroke: new Stroke({ color: "orange", width: 2 }),
      }),
    });

    const select = new Select({ condition: click, style: selectedStyle });
    map.addInteraction(select);

    map.on("singleclick", async (event) => {
      neighborLayers.forEach((layer) => map.removeLayer(layer));
      neighborLayers.length = 0;

      if (map.hasFeatureAtPixel(event.pixel) !== true) {
        clearDetailsPanel();
        return;
      }

      const feature = map.forEachFeatureAtPixel(event.pixel, (f) => f);
      if (!feature) return;

      const props = feature.getProperties();
      const { node } = props as { node: IFeatureNode };

      const displayName = await reverseGeocode(node.position[0], node.position[1]);

      const nodeLike: NodeLike = {
        id: node.id,
        shortname: node.shortname,
        longname: node.longname,
        last_seen: node.last_seen,
        online: Boolean(node.online),
        position: node.position,
        neighbors: node.neighbors,
      };

      const { html } = buildNodeDetailsHtml({
        node: nodeLike,
        liveNodes: nodes,
        displayName,
        elsewhereLinks: config?.mesh?.elsewhere_links,
      });

      setDetailsPanelContent({
        title: node.longname ?? "",
        subtitle: node.shortname ?? "",
        html,
      });

      // Draw neighbor lines (OpenLayers map overlay)
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
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, serverNode, olMap]);

  // OpenLayers: update nodes in real time when nodes/recentDays change
  useEffect(() => {
    if (provider !== "osm") return;
    if (!olMap) return;
    if (!olNodesSourceRef.current) return;

    const src = olNodesSourceRef.current;
    src.clear();

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
          } satisfies IFeatureNode,
        });

        feature.setStyle(node.online ? onlineStyle : offlineStyle);
        return feature;
      })
      .filter((f): f is Feature<Point> => Boolean(f));

    src.addFeatures(features);
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

  // ----------------------------
  // Settings panel UI
  // ----------------------------
  const canUseMapbox = hasMapbox;
  const usingMapbox = provider === "mapbox" && canUseMapbox;

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
        canUseMapbox={canUseMapbox}
        usingMapbox={usingMapbox}
      />

      <MapDetailsPanel onClose={clearMapboxSelectionAndOverlays} />

      <style>
        {`
          #map { position: absolute; inset: 0; }
        `}
      </style>
    </div>
  );
}
