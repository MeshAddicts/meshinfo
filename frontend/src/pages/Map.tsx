import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, {
  GeoJSONSource as MbGeoJSONSource,
  Map as MbMap,
} from "mapbox-gl";

import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import { Feature, Map as OlMap, View } from "ol";
import { Coordinate } from "ol/coordinate";
import { click } from "ol/events/condition";
import { Geometry, LineString } from "ol/geom";
import Point from "ol/geom/Point";
import Select from "ol/interaction/Select";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transform } from "ol/proj";
import { Vector } from "ol/source";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useMemo, useRef, useState } from "react";

import { createBaseTileLayer, type OsmBasemap } from "../maps/baseLayer";
import { reverseGeocode } from "../maps/geocoder";
import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import { INode } from "../types";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";

// --------------------
// Settings + storage
// --------------------
type MapProvider = "osm" | "mapbox";

const LS_KEYS = {
  provider: "meshinfo.map.provider",
  mapboxStyle: "meshinfo.map.mapboxStyle",
  osmBasemap: "meshinfo.map.osmBasemap",
  recentDays: "meshinfo.map.recentDays",
  clusterEnabled: "meshinfo.map.clusterEnabled",
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Log storage write failures (e.g., quota exceeded, storage disabled) instead of failing silently
    // This keeps normal behavior unchanged while making issues diagnosable
    // eslint-disable-next-line no-console
    console.warn("Failed to persist map setting to localStorage", { key, error: err });
  }
}

function toMapboxStyleUrl(stylePath: string): string {
  // Accept:
  // - "mapbox://styles/..."
  // - "mapbox/streets-v12" or "user/styleid"
  if (stylePath.startsWith("mapbox://")) return stylePath;
  return `mapbox://styles/${stylePath}`;
}

// --------------------
// Utilities
// --------------------
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function calculateGeodesicDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// --------------------
// Types
// --------------------
type IMapNode = INode & {
  online: boolean;
  map_position?: Coordinate; // [lon, lat]
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// OL Feature properties for click handling
type IFeatureNode = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  position: Coordinate; // [lon, lat]
  online: boolean;
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

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

// --------------------
// Helpers
// --------------------
function computeRecentNodes(
  nodes: Record<string, IMapNode>,
  recentDays: number
) {
  const recentCutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

  return Object.entries(nodes).filter(([_, node]) => {
    if (node.online) return true;
    if (!node.last_seen) return false;

    const lastSeenMs = new Date(node.last_seen).getTime();
    if (Number.isNaN(lastSeenMs)) return false;

    return lastSeenMs > recentCutoff;
  });
}

function bumpOlRender(map: OlMap) {
  map.updateSize();
  map.renderSync();

  requestAnimationFrame(() => {
    map.updateSize();
    map.renderSync();
  });

  // One more delayed bump catches late layout/font/sidebar shifts.
  window.setTimeout(() => {
    map.updateSize();
    map.renderSync();
  }, 200);
}


function buildNodesGeoJSON(
  nodes: Record<string, IMapNode>,
  recentDays: number
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  const recentNodeEntries = computeRecentNodes(nodes, recentDays);

  const features: GeoFeature<GeoPoint, GeoJsonProperties>[] = [];

  for (const [id, node] of recentNodeEntries) {
    if (!node.map_position) continue;

    features.push({
      type: "Feature",
      id, // important for feature-state selection
      properties: {
        id,
        shortname: node.shortname ?? "",
        longname: node.longname ?? "",
        last_seen: node.last_seen ?? "",
        online: Boolean(node.online),
      },
      geometry: {
        type: "Point",
        coordinates: [node.map_position[0], node.map_position[1]],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

function emptyLineFeatureCollection(): FeatureCollection<
  GeoLineString,
  GeoJsonProperties
> {
  return { type: "FeatureCollection", features: [] };
}

function applyMapboxClusterVisibility(map: MbMap, enabled: boolean): void {
  const set = (layerId: string, visible: boolean) => {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  };

  // clustered set
  set("clusters", enabled);
  set("cluster-count", enabled);
  set("unclustered-nodes", enabled);
  set("unclustered-labels", enabled);

  // plain set
  set("plain-nodes", !enabled);
  set("plain-labels", !enabled);
}

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  // OL map state (OSM path)
  const [olMap, setOlMap] = useState<OlMap>();
  const olBaseLayerRef = useRef<ReturnType<typeof createBaseTileLayer> | null>(
    null
  );
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

  // ----- UI settings (persisted)
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

  // persist settings
  useEffect(() => writeJson(LS_KEYS.provider, provider), [provider]);
  useEffect(() => writeJson(LS_KEYS.mapboxStyle, mapboxStyle), [mapboxStyle]);
  useEffect(() => writeJson(LS_KEYS.osmBasemap, osmBasemap), [osmBasemap]);
  useEffect(() => writeJson(LS_KEYS.recentDays, recentDays), [recentDays]);
  useEffect(
    () => writeJson(LS_KEYS.clusterEnabled, clusterEnabled),
    [clusterEnabled]
  );

  // If token disappears / not configured, force provider to osm
  useEffect(() => {
    if (provider === "mapbox" && !hasMapbox) setProvider("osm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMapbox]);

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
            Boolean(node.last_seen) &&
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
  // Shared DOM refs for the side panel
  // ----------------------------
  function getDetailsDom() {
    const nodePanel = document.getElementById("details");
    const nodeTitle = document.getElementById("details-title");
    const nodeSubtitle = document.getElementById("details-subtitle");
    const nodeContent = document.getElementById("details-content");

    return { nodePanel, nodeTitle, nodeSubtitle, nodeContent };
  }

  function clearDetailsPanel() {
    const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
    if (!nodePanel || !nodeTitle || !nodeSubtitle || !nodeContent) return;

    nodeTitle.innerHTML = "";
    nodeSubtitle.innerHTML = "";
    nodeContent.innerHTML = "";
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
    if (!serverNode) return;

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode.map_position
      ? {
          latitude: serverNode.map_position[1],
          longitude: serverNode.map_position[0],
        }
      : defaultPosition;

    const savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    const initialCenter: [number, number] = [
      savedCenter[0] ?? serverPosition.longitude,
      savedCenter[1] ?? serverPosition.latitude,
    ];
    const initialZoom = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");

    const styleUrl = toMapboxStyleUrl(mapboxStyle);
    mbCurrentStyleUrlRef.current = styleUrl;

    // fresh container
    mapRef.current.innerHTML = "";

    mapboxgl.accessToken = mapboxToken!;

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

    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: true }),
      "top-left"
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

        let panel =
          `<b>${escapeHtml(node.longname ?? "")}</b><br/>${escapeHtml(node.shortname ?? "")} / ${escapeHtml(id)}<br/><br/>` +
          `<b>Position</b><br/>${escapeHtml(node.map_position.toString())}<br/><br/>` +
          `<b>Location</b><br/>${escapeHtml(displayName || "Unknown")}<br/><br/>` +
          `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
          `<b>Last Seen</b><br/>${escapeHtml(node.last_seen ?? "")}<br/><br/>`;

        panel += "<b>Neighbors Heard</b><br/>";
        if ((node.neighbors?.length ?? 0) === 0) {
          panel += "None";
        } else {
          panel +=
            "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
          panel +=
            "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

          panel += (node.neighbors ?? [])
            .map((neighbor) => {
              const nnode = liveNodes[neighbor.id];
              if (!nnode) {
                return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor.snr}</td><td></td></tr>`;
              }

              let distance;
              if (nnode.map_position) {
                distance = calculateGeodesicDistance(
                  node.map_position![1], node.map_position![0],
                  nnode.map_position[1], nnode.map_position[0]
                );
              }

              return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor.snr}</td><td align=right>${
                distance ? distance.toFixed(2) : "unk"
              } km</td></tr>`;
            })
            .join("");

          panel += "</table>";
        }
        panel += "<br/><br/>";

        panel += "<b>Heard By Neighbors</b><br/>";
        const heardBy = Object.keys(liveNodes).filter((nid) =>
          liveNodes[nid].neighbors?.some((neighbor) => neighbor.id === id)
        );

        if (heardBy.length === 0) {
          panel += "None<br/>";
        } else {
          panel +=
            "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
          panel +=
            "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

          panel += heardBy
            .map((nid) => {
              const nnode = liveNodes[nid];
              const neighbor = nnode?.neighbors?.find((n) => n.id === id);

              if (!nnode) {
                return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor?.snr}</td><td></td></tr>`;
              }

              let distance;
              if (nnode.map_position) {
                distance = calculateGeodesicDistance(
                  node.map_position![1], node.map_position![0],
                  nnode.map_position[1], nnode.map_position[0]
                );
              }

              return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor?.snr}</td><td align=right>${
                distance ? distance.toFixed(2) : "unk"
              } km</td></tr>`;
            })
            .join("");

          panel += "</table>";
        }

        panel += "<br/><br/>";

        panel += "<b>Elsewhere</b><br/>";
        const nodeId = parseInt(id, 16);
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshview.armooo.net/packet_list/${nodeId}" target="_blank">Armooo's MeshView</a><br/>`;
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${encodeURIComponent(id)}" target="_blank">Bay Mesh Explorer</a><br/>`;
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${nodeId}" target="_blank">Liam's Map</a><br/>`;
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${nodeId}" target="_blank">MeshMap</a><br/>`;

        const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
        if (nodePanel && nodeTitle && nodeSubtitle && nodeContent) {
          nodeTitle.textContent = node.longname ?? "";
          nodeSubtitle.textContent = node.shortname ?? "";
          nodeContent.innerHTML = panel;
          nodePanel.classList.remove("hidden");
        }

        // Draw links
        const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

        const neighborSet = new Set((node.neighbors ?? []).map((n) => n.id));
        const heardBySet = new Set(heardBy);
        const union = new Set<string>([...neighborSet, ...heardBySet]);

        union.forEach((otherId) => {
          const other = liveNodes[otherId];
          if (!other?.map_position) return;

          const isNeighbor = neighborSet.has(otherId);
          const isHeardBy = heardBySet.has(otherId);
          const kind =
            isNeighbor && isHeardBy ? "both" : isNeighbor ? "neighbor" : "heard_by";

          linkFeatures.push({
            type: "Feature",
            properties: { kind },
            geometry: {
              type: "LineString",
              coordinates: [
                [node.map_position![0], node.map_position![1]],
                [other.map_position[0], other.map_position[1]],
              ],
            },
          });
        });

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData({
          type: "FeatureCollection",
          features: linkFeatures,
        } as FeatureCollection<GeoLineString, GeoJsonProperties>);
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
          map.queryRenderedFeatures(e.point, { layers: ["unclustered-nodes", "plain-nodes"] })
            .length > 0;
        const hitCluster =
          map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        clearSelected();
        clearDetailsPanel();
        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
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
    } catch {
    }
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
      const stillExists = data.features.some(
        (f) => (f.properties?.id as string | undefined) === selectedId
      );
      if (!stillExists) {
        try {
          map.setFeatureState({ source: "nodes_clustered", id: selectedId }, { selected: false });
        } catch {
        }
        try {
          map.setFeatureState({ source: "nodes_plain", id: selectedId }, { selected: false });
        } catch {
        }
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
    if (!serverNode || !mapRef.current) return;

    mapRef.current.innerHTML = "";

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode.map_position
      ? {
          latitude: serverNode.map_position[1],
          longitude: serverNode.map_position[0],
        }
      : defaultPosition;

    const savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    const initialCenter = fromLonLat([
      savedCenter[0] ?? serverPosition.longitude,
      savedCenter[1] ?? serverPosition.latitude,
    ]);
    const initialZoom = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");

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

    const neighborLayers: VectorLayer<Feature<Geometry>>[] = [];

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
        nodeTitle.innerHTML = "";
        nodeSubtitle.innerHTML = "";
        nodeContent.innerHTML = "";
        return;
      }

      const feature = map.forEachFeatureAtPixel(event.pixel, (f) => f);
      if (!feature) return;

      const props = feature.getProperties();
      const { node } = props as { node: IFeatureNode };

      const displayName = await reverseGeocode(node.position[0], node.position[1]);

      let panel =
        `<b>${escapeHtml(node.longname ?? "")}</b><br/>${escapeHtml(node.shortname ?? "")} / ${escapeHtml(node.id)}<br/><br/>` +
        `<b>Position</b><br/>${escapeHtml(node.position.toString())}<br/><br/>` +
        `<b>Location</b><br/>${escapeHtml(displayName || "Unknown")}<br/><br/>` +
        `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
        `<b>Last Seen</b><br/>${escapeHtml(node.last_seen ?? "")}<br/><br/>`;

      panel += "<b>Neighbors Heard</b><br/>";
      if ((node.neighbors?.length ?? 0) === 0) {
        panel += "None";
      } else {
        panel +=
          "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
        panel +=
          "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

        panel += (node.neighbors ?? [])
          .map((neighbor) => {
            const nnode = nodes[neighbor.id];
            if (!nnode) {
              return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor.snr}</td><td></td></tr>`;
            }

            let distance;
            if (nnode.map_position) {
              distance = calculateGeodesicDistance(
                node.position[1], node.position[0],
                nnode.map_position[1], nnode.map_position[0]
              );
            }

            return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor.snr}</td><td align=right>${
              distance ? distance.toFixed(2) : "unk"
            } km</td></tr>`;
          })
          .join("");

        panel += "</table>";

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
      }

      panel += "<br/><br/>";

      panel += "<b>Heard By Neighbors</b><br/>";
      const heardBy = Object.keys(nodes).filter((nid) =>
        nodes[nid].neighbors?.some((neighbor) => neighbor.id === node.id)
      );

      if (heardBy.length === 0) {
        panel += "None<br/>";
      } else {
        panel +=
          "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
        panel +=
          "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

        panel += heardBy
          .map((nid) => {
            const nnode = nodes[nid];
            const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);

            if (!nnode) {
              return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor?.snr}</td><td></td></tr>`;
            }

            let distance;
            if (nnode.map_position) {
              distance = calculateGeodesicDistance(
                node.position[1], node.position[0],
                nnode.map_position[1], nnode.map_position[0]
              );
            }

            return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor?.snr}</td><td align=right>${
              distance ? distance.toFixed(2) : "unk"
            } km</td></tr>`;
          })
          .join("");

        panel += "</table>";
      }

      panel += "<br/><br/>";

      panel += "<b>Elsewhere</b><br/>";
      const nodeId = parseInt(node.id, 16);
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshview.armooo.net/packet_list/${nodeId}" target="_blank">Armooo's MeshView</a><br/>`;
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${encodeURIComponent(node.id)}" target="_blank">Bay Mesh Explorer</a><br/>`;
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${nodeId}" target="_blank">Liam's Map</a><br/>`;
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${nodeId}" target="_blank">MeshMap</a><br/>`;

      nodeTitle.textContent = node.longname ?? "";
      nodeSubtitle.textContent = node.shortname ?? "";
      nodeContent.innerHTML = panel;
      nodePanel.classList.remove("hidden");
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
    <div className="h-screen relative">
      <div id="map" className="map" ref={mapRef} />

      <div
        id="map-settings"
        role="region"
        aria-label="Map Settings"
        className="absolute left-2 top-1/2 -translate-y-1/2 z-[1100] w-56 rounded-xl shadow-lg border border-gray-200/70 dark:border-gray-700/70 bg-white/90 dark:bg-black/70 backdrop-blur p-3"
      >
        <div className="font-semibold text-sm mb-2 dark:text-gray-100">
          Map Settings
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="provider-select" className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1 block">
              Provider
            </label>
            <select
              id="provider-select"
              aria-label="Map provider selection"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
              value={provider}
              onChange={(e) => setProvider(e.target.value as MapProvider)}
            >
              <option value="osm">OSM (OpenLayers)</option>
              <option value="mapbox" disabled={!canUseMapbox}>
                Mapbox (GL JS){!canUseMapbox ? " — token not configured" : ""}
              </option>
            </select>
          </div>

          {usingMapbox ? (
            <div>
              <label htmlFor="mapbox-style-select" className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1 block">
                Mapbox style
              </label>
              <select
                id="mapbox-style-select"
                aria-label="Mapbox map style selection"
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
                value={mapboxStyle}
                onChange={(e) => setMapboxStyle(e.target.value)}
              >
                <option value="mapbox/dark-v11">Dark</option>
                <option value="mapbox/streets-v12">Streets</option>
                <option value="mapbox/satellite-streets-v12">Satellite Streets</option>
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="osm-basemap-select" className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1 block">
                OSM basemap
              </label>
              <select
                id="osm-basemap-select"
                aria-label="OpenStreetMap basemap selection"
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
                value={osmBasemap}
                onChange={(e) => setOsmBasemap(e.target.value as OsmBasemap)}
              >
                <option value="osm">OSM Standard</option>
                <option value="osm_hot">OSM HOT</option>
                <option value="carto_positron">Carto Positron (Light)</option>
                <option value="carto_dark">Carto Dark Matter (Dark)</option>
              </select>
            </div>
          )}

          <div>
            <label htmlFor="recent-days-select" className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1 block">
              Last seen
            </label>
            <select
              id="recent-days-select"
              aria-label="Filter nodes by last seen timeframe"
              className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
              value={recentDays}
              onChange={(e) => setRecentDays(Number(e.target.value))}
            >
              <option value={30}>30 days</option>
              <option value={14}>14 days</option>
              <option value={7}>7 days</option>
              <option value={5}>5 days</option>
              <option value={3}>3 days</option>
              <option value={1}>1 day</option>
            </select>
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="clustering-checkbox" className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300">
              Clustering
            </label>
            <input
              id="clustering-checkbox"
              type="checkbox"
              checked={clusterEnabled}
              onChange={(e) => setClusterEnabled(e.target.checked)}
              disabled={!usingMapbox}
              className="h-4 w-4"
              aria-label="Toggle node clustering (Mapbox only)"
              title={!usingMapbox ? "Clustering is Mapbox-only (for now)" : ""}
            />
          </div>

          {!canUseMapbox && (
            <div className="text-xs text-gray-600 dark:text-gray-300">
              Mapbox is disabled because <code>VITE_MAPBOX_TOKEN</code> is not set.
            </div>
          )}
        </div>
      </div>

      <div id="details" className="p-4 bg-white dark:bg-black hidden">
        <div className="flex items-center w-full justify-items-stretch">
          <div id="details-title" className="flex-auto text-lg text-start">
            NODE NAME
          </div>
          <div id="details-subtitle" className="flex-auto ml-4 text-sm text-end">
            NODE
          </div>
        </div>
        <div id="details-content" className="align-items-center" />
      </div>

      <div id="legend" className="p-2 bg-white dark:bg-black">
        <div className="text-lg">LEGEND</div>
        <div className="align-items-center">
          <div className="inline-block w-12 h-1 bg-green-400" /> Heard A Neighbor
        </div>
        <div>
          <div className="inline-block w-12 h-1 bg-blue-400" /> Heard By Neighbor
        </div>
        <div>
          <div className="inline-block w-12 h-1 bg-purple-400" /> Both Heard Each Other
        </div>
      </div>

      <style>
        {`
          #map { height: 100%; width: 100%; }
          #legend { position: absolute; bottom: 10px; right: 10px; z-index: 1000; }
          #details { position: absolute; top: 10px; right: 10px; z-index: 1000; }
        `}
      </style>
    </div>
  );
}
