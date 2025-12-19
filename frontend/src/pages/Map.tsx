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
import type RenderEvent from "ol/render/Event";
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
  } catch {
    // ignore
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
function computeRecentNodes(nodes: Record<string, IMapNode>, recentDays: number) {
  const recentCutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

  return Object.entries(nodes).filter(([_, node]) => {
    if (node.online) return true;
    if (!node.last_seen) return false;

    const lastSeenMs = new Date(node.last_seen).getTime();
    if (Number.isNaN(lastSeenMs)) return false;

    return lastSeenMs > recentCutoff;
  });
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
  const envProvider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  const hasMapbox = Boolean(mapboxToken);

  // ----- UI settings (persisted)
  const [provider, setProvider] = useState<MapProvider>(() => {
    const stored = readJson<MapProvider | null>(LS_KEYS.provider, null);
    const desired = stored ?? envProvider;
    if (desired === "mapbox" && !hasMapbox) return "osm";
    return desired;
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
    return stored ?? "osm";
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
      setOlMap(undefined);
      olBaseLayerRef.current = null;
      olNodesSourceRef.current = null;

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
      if (!map.getSource("nodes_clustered")) {
        map.addSource("nodes_clustered", {
          type: "geojson",
          data: buildNodesGeoJSON(nodes, recentDays),
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
        });
      }

      if (!map.getSource("nodes_plain")) {
        map.addSource("nodes_plain", {
          type: "geojson",
          data: buildNodesGeoJSON(nodes, recentDays),
        });
      }

      if (!map.getSource("links")) {
        map.addSource("links", {
          type: "geojson",
          data: emptyLineFeatureCollection(),
        });
      }

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

      if (!map.getLayer("clusters")) {
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          paint: {
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
            "circle-radius": [
              "step",
              ["get", "point_count"],
              14,
              10,
              18,
              25,
              24,
              50,
              30,
            ],
            "circle-color": "#3b82f6",
            "circle-opacity": 0.85,
          },
        });
      }

      if (!map.getLayer("cluster-count")) {
        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "nodes_clustered",
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": 12,
          },
          paint: { "text-color": "#ffffff" },
        });
      }

      if (!map.getLayer("unclustered-nodes")) {
        map.addLayer({
          id: "unclustered-nodes",
          type: "circle",
          source: "nodes_clustered",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              10,
              6,
            ],
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
            "text-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              9,
              10,
              13,
              14,
              16,
              16,
            ],
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

      if (!map.getLayer("plain-nodes")) {
        map.addLayer({
          id: "plain-nodes",
          type: "circle",
          source: "nodes_plain",
          paint: {
            "circle-radius": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              10,
              6,
            ],
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
            "text-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              9,
              10,
              13,
              14,
              16,
              16,
            ],
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

      applyMapboxClusterVisibility(map, clusterEnabled);

      if (mbHandlersBoundRef.current) return;
      mbHandlersBoundRef.current = true;

      const setSelected = (id: string) => {
        if (mbSelectedIdRef.current) {
          const prev = mbSelectedIdRef.current;
          try {
            map.setFeatureState(
              { source: "nodes_clustered", id: prev },
              { selected: false }
            );
          } catch {
            // ignore
          }
          try {
            map.setFeatureState(
              { source: "nodes_plain", id: prev },
              { selected: false }
            );
          } catch {
            // ignore
          }
        }
        mbSelectedIdRef.current = id;
        try {
          map.setFeatureState({ source: "nodes_clustered", id }, { selected: true });
        } catch {
          // ignore
        }
        try {
          map.setFeatureState({ source: "nodes_plain", id }, { selected: true });
        } catch {
          // ignore
        }
      };

      const handleNodeClick = async (id: string) => {
        const node = nodes[id];
        if (!node?.map_position) return;

        setSelected(id);

        const displayName = await reverseGeocode(
          node.map_position[0],
          node.map_position[1]
        );

        let panel =
          `<b>${node.longname}</b><br/>${node.shortname} / ${id}<br/><br/>` +
          `<b>Position</b><br/>${node.map_position}<br/><br/>` +
          `<b>Location</b><br/>${displayName || "Unknown"}<br/><br/>` +
          `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
          `<b>Last Seen</b><br/>${node.last_seen}<br/><br/>`;

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
                distance =
                  Math.sqrt(
                    (node.map_position![0] - nnode.map_position[0]) ** 2 +
                      (node.map_position![1] - nnode.map_position[1]) ** 2
                  ) * 111.32;
              }

              return `<tr><td align=left>${nnode.shortname}</td><td align=center>${neighbor.snr}</td><td align=right>${
                distance ? distance.toFixed(2) : "unk"
              } km</td></tr>`;
            })
            .join("");

          panel += "</table>";
        }
        panel += "<br/><br/>";

        panel += "<b>Heard By Neighbors</b><br/>";
        const heardBy = Object.keys(nodes).filter((nid) =>
          nodes[nid].neighbors?.some((neighbor) => neighbor.id === id)
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
              const neighbor = nnode?.neighbors?.find((n) => n.id === id);

              if (!nnode) {
                return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor?.snr}</td><td></td></tr>`;
              }

              let distance;
              if (nnode.map_position) {
                distance =
                  Math.sqrt(
                    (node.map_position![0] - nnode.map_position[0]) ** 2 +
                      (node.map_position![1] - nnode.map_position[1]) ** 2
                  ) * 111.32;
              }

              return `<tr><td align=left>${nnode.shortname}</td><td align=center>${neighbor?.snr}</td><td align=right>${
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
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${id}" target="_blank">Bay Mesh Explorer</a><br/>`;
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${nodeId}" target="_blank">Liam's Map</a><br/>`;
        panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${nodeId}" target="_blank">MeshMap</a><br/>`;

        const { nodePanel, nodeTitle, nodeSubtitle, nodeContent } = getDetailsDom();
        if (nodePanel && nodeTitle && nodeSubtitle && nodeContent) {
          nodeTitle.innerHTML = node.longname ?? "";
          nodeSubtitle.innerHTML = node.shortname ?? "";
          nodeContent.innerHTML = panel;
          nodePanel.classList.remove("hidden");
        }

        const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

        const neighborSet = new Set((node.neighbors ?? []).map((n) => n.id));
        const heardBySet = new Set(heardBy);
        const union = new Set<string>([...neighborSet, ...heardBySet]);

        union.forEach((otherId) => {
          const other = nodes[otherId];
          if (!other?.map_position) return;

          const isNeighbor = neighborSet.has(otherId);
          const isHeardBy = heardBySet.has(otherId);
          const kind =
            isNeighbor && isHeardBy
              ? "both"
              : isNeighbor
              ? "neighbor"
              : "heard_by";

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

      map.on("click", "unclustered-nodes", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;
        void handleNodeClick(id);
      });

      map.on("click", "plain-nodes", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const id = (feature.properties?.id ?? "") as string;
        if (!id) return;
        void handleNodeClick(id);
      });

      map.on("click", (e) => {
        const hitNode =
          map.queryRenderedFeatures(e.point, {
            layers: ["unclustered-nodes", "plain-nodes"],
          }).length > 0;
        const hitCluster =
          map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

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
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, hasMapbox, serverNode]);

  // Mapbox: style switching (no restart)
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    if (provider !== "mapbox") return;
    if (!hasMapbox) return;

    const desired = toMapboxStyleUrl(mapboxStyle);

    if (mbCurrentStyleUrlRef.current === desired) return;

    const apply = () => {
      const m = mbMapRef.current;
      if (!m) return;

      try {
        m.setStyle(desired);
        mbCurrentStyleUrlRef.current = desired;
      } catch {
        // ignore
      }
    };

    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once("style.load", apply);
    }
  }, [mapboxStyle, provider, hasMapbox]);

  // Mapbox: cluster toggle (just visibility switch between sources/layers)
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;
    applyMapboxClusterVisibility(map, clusterEnabled);
  }, [clusterEnabled]);

  // Mapbox: live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const data = buildNodesGeoJSON(nodes, recentDays);

    const clustered = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
    clustered?.setData(data);

    const plain = map.getSource("nodes_plain") as MbGeoJSONSource | undefined;
    plain?.setData(data);

    const selectedId = mbSelectedIdRef.current;
    if (selectedId) {
      const stillExists = data.features.some(
        (f) => (f.properties?.id as string | undefined) === selectedId
      );
      if (!stillExists) {
        try {
          map.setFeatureState(
            { source: "nodes_clustered", id: selectedId },
            { selected: false }
          );
        } catch {
          // ignore
        }
        try {
          map.setFeatureState(
            { source: "nodes_plain", id: selectedId },
            { selected: false }
          );
        } catch {
          // ignore
        }
        mbSelectedIdRef.current = null;

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyLineFeatureCollection());
        clearDetailsPanel();
      }
    }
  }, [nodes, recentDays]);

  // ----------------------------
  // OpenLayers: init (OSM path)
  // ----------------------------
  useEffect(() => {
    const usingOsm = provider === "osm";

    if (!usingOsm) return;
    if (!serverNode || !mapRef.current) return;

    if (mbMapRef.current) {
      mbMapRef.current.remove();
      mbMapRef.current = null;
      mbSelectedIdRef.current = null;
      mbHandlersBoundRef.current = false;
      mbCurrentStyleUrlRef.current = null;
    }

    if (olMap) {
      if (mapRef.current) {
        mapRef.current.innerHTML = "";
        olMap.setTarget(mapRef.current as HTMLElement);
        olMap.updateSize();
        requestAnimationFrame(() => olMap.updateSize());
      }
      return;
    }

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

    if (mapRef.current) mapRef.current.innerHTML = "";

    const tileLayer = createBaseTileLayer({
      provider: "osm",
      osmBasemap,
    });

    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      tileLayer.on("prerender", (evt: RenderEvent) => {
        if (!evt.context) return;
        const context = evt.context as CanvasRenderingContext2D;
        context.filter = "grayscale(80%) invert(100%) ";
        context.globalCompositeOperation = "source-over";
      });

      tileLayer.on("postrender", (evt: RenderEvent) => {
        if (!evt.context) return;
        const context = evt.context as CanvasRenderingContext2D;
        context.filter = "none";
      });
    }

    const srcAny = (tileLayer as any)?.getSource?.();
    srcAny?.on?.("tileloaderror", (e: any) => {
      console.warn("OSM tile load error:", e);
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

    map.updateSize();
    requestAnimationFrame(() => map.updateSize());

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
        `<b>${node.longname}</b><br/>${node.shortname} / ${node.id}<br/><br/>` +
        `<b>Position</b><br/>${node.position}<br/><br/>` +
        `<b>Location</b><br/>${displayName || "Unknown"}<br/><br/>` +
        `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
        `<b>Last Seen</b><br/>${node.last_seen}<br/><br/>`;

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
              distance =
                Math.sqrt(
                  (node.position[0] - nnode.map_position[0]) ** 2 +
                    (node.position[1] - nnode.map_position[1]) ** 2
                ) * 111.32;
            }

            return `<tr><td align=left>${nnode.shortname}</td><td align=center>${neighbor.snr}</td><td align=right>${
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
              distance =
                Math.sqrt(
                  (node.position[0] - nnode.map_position[0]) ** 2 +
                    (node.position[1] - nnode.map_position[1]) ** 2
                ) * 111.32;
            }

            return `<tr><td align=left>${nnode.shortname}</td><td align=center>${neighbor?.snr}</td><td align=right>${
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
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${node.id}" target="_blank">Bay Mesh Explorer</a><br/>`;
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${nodeId}" target="_blank">Liam's Map</a><br/>`;
      panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${nodeId}" target="_blank">MeshMap</a><br/>`;

      nodeTitle.innerHTML = node.longname ?? "";
      nodeSubtitle.innerHTML = node.shortname ?? "";
      nodeContent.innerHTML = panel;
      nodePanel.classList.remove("hidden");
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, serverNode, olMap, osmBasemap, recentDays, nodes]);

  // OpenLayers: update nodes live when nodes/recentDays change
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

    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      newBase.on("prerender", (evt: RenderEvent) => {
        if (!evt.context) return;
        const context = evt.context as CanvasRenderingContext2D;
        context.filter = "grayscale(80%) invert(100%) ";
        context.globalCompositeOperation = "source-over";
      });

      newBase.on("postrender", (evt: RenderEvent) => {
        if (!evt.context) return;
        const context = evt.context as CanvasRenderingContext2D;
        context.filter = "none";
      });
    }

    olMap.getLayers().setAt(0, newBase);
    olBaseLayerRef.current = newBase;

    olMap.updateSize();
    requestAnimationFrame(() => olMap.updateSize());
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
        className="absolute left-2 top-1/2 -translate-y-1/2 z-[1100] w-64 rounded-xl shadow-lg border border-gray-200/70 dark:border-gray-700/70 bg-white/90 dark:bg-black/70 backdrop-blur p-3"
      >
        <div className="font-semibold text-sm mb-2 dark:text-gray-100">
          Map Settings
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1">
              Provider
            </div>
            <select
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
              <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1">
                Mapbox style
              </div>
              <select
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
                value={mapboxStyle}
                onChange={(e) => setMapboxStyle(e.target.value)}
              >
                <option value="mapbox/dark-v11">Dark</option>
                <option value="mapbox/streets-v12">Streets</option>
                <option value="mapbox/satellite-streets-v12">
                  Satellite Streets
                </option>
              </select>
            </div>
          ) : (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1">
                OSM basemap
              </div>
              <select
                className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-black px-2 py-1 dark:text-gray-100"
                value={osmBasemap}
                onChange={(e) => setOsmBasemap(e.target.value as OsmBasemap)}
              >
                <option value="osm">OSM Standard</option>
                <option value="osm_hot">OSM HOT</option>
              </select>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1">
              Last seen
            </div>
            <select
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
            <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300">
              Clustering
            </div>
            <input
              type="checkbox"
              checked={clusterEnabled}
              onChange={(e) => setClusterEnabled(e.target.checked)}
              disabled={!usingMapbox}
              className="h-4 w-4"
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
          <div className="inline-block w-12 h-1 bg-purple-400" /> Both Heard Each
          Other
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
