import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, { GeoJSONSource as MbGeoJSONSource, Map as MbMap } from "mapbox-gl";

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

import { createBaseTileLayer } from "../maps/baseLayer";
import { reverseGeocode } from "../maps/geocoder";
import { useEffect, useMemo, useRef, useState } from "react";

import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import { INode } from "../types";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";

const RECENT_DAYS = 30;

type MapProvider = "osm" | "mapbox";

type IMapNode = INode & {
  online: boolean;
  position?: Coordinate; // [lon, lat]
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
    fill: new Fill({
      color: "rgba(0, 0, 240, 1)",
    }),
    stroke: new Stroke({
      color: "white",
      width: 2,
    }),
  }),
});

const offlineStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({
      color: "rgba(0, 0, 0, 0.50)",
    }),
    stroke: new Stroke({
      color: "white",
      width: 2,
    }),
  }),
});

const onlineStyle = new Style({
  image: new Circle({
    radius: 6,
    fill: new Fill({
      color: "rgba(50, 240, 50, 1)",
    }),
    stroke: new Stroke({
      color: "white",
      width: 2,
    }),
  }),
});

// --------------------
// Helpers
// --------------------
function computeRecentNodes(nodes: Record<string, IMapNode>) {
  const recentCutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;

  return Object.entries(nodes).filter(([_, node]) => {
    if (node.online) return true;
    if (!node.last_seen) return false;

    const lastSeenMs = new Date(node.last_seen).getTime();
    if (Number.isNaN(lastSeenMs)) return false;

    return lastSeenMs > recentCutoff;
  });
}

function buildNodesGeoJSON(nodes: Record<string, IMapNode>) {
  const recentNodeEntries = computeRecentNodes(nodes);

  return {
    type: "FeatureCollection" as const,
    features: recentNodeEntries
      .map(([id, node]) => {
        if (!node.position) return null;

        return {
          type: "Feature" as const,
          id, // for feature-state selection
          properties: {
            id,
            shortname: node.shortname ?? "",
            longname: node.longname ?? "",
            last_seen: node.last_seen ?? "",
            online: Boolean(node.online),
          },
          geometry: {
            type: "Point" as const,
            coordinates: [node.position[0], node.position[1]] as [number, number],
          },
        };
      })
      .filter(Boolean),
  };
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection" as const, features: [] as any[] };
}

export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);

  // OL map state (OSM / fallback path)
  const [olMap, setOlMap] = useState<OlMap>();

  // Mapbox refs (Mapbox path)
  const mbMapRef = useRef<MbMap | null>(null);
  const mbSelectedIdRef = useRef<string | null>(null);

  const { data: rawNodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const nodes: Record<string, IMapNode> = useMemo(() => {
    const now = new Date();
    const sixHoursAgo = now.getTime() - 6 * 60 * 60 * 1000; // 6 hours

    return Object.fromEntries(
      Object.entries(rawNodes).map(([id, node]) => [
        id,
        {
          ...node,
          online: node.last_seen && new Date(node.last_seen).getTime() > sixHoursAgo,
          position:
            node.position && node.position.latitude_i && node.position.longitude_i
              ? [
                  (node.position.longitude_i ?? 0) / 10_000_000,
                  (node.position.latitude_i ?? 0) / 10_000_000,
                ]
              : undefined,
          neighbors: node.neighborinfo?.neighbors?.map((neighbor) => ({
            id: convertNodeIdFromIntToHex(neighbor.node_id),
            snr: neighbor.snr,
            distance: neighbor.distance,
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
  // Mapbox: init + layers
  // ----------------------------
  useEffect(() => {
    const provider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
    const usingMapbox = provider === "mapbox" && Boolean(token);

    if (!usingMapbox) return;
    if (mbMapRef.current) return; // already created
    if (!mapRef.current) return;
    if (!serverNode || !nodes) return;

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode?.position
      ? { latitude: serverNode.position[1], longitude: serverNode.position[0] }
      : defaultPosition;

    const savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    const initialCenter: [number, number] = [
      savedCenter[0] ?? serverPosition.longitude,
      savedCenter[1] ?? serverPosition.latitude,
    ];
    const initialZoom = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");

    const stylePath = (import.meta.env.VITE_MAPBOX_STYLE ?? "mapbox/streets-v12") as string;
    const styleUrl = stylePath.startsWith("mapbox://") ? stylePath : `mapbox://styles/${stylePath}`;

    mapboxgl.accessToken = token!;

    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: styleUrl,
      center: initialCenter,
      zoom: initialZoom,
      attributionControl: true,
    });

    mbMapRef.current = map;

    // Persist center/zoom like OL path
    map.on("moveend", () => {
      const c = map.getCenter();
      localStorage.setItem("savedCenter", JSON.stringify([c.lng, c.lat]));
      localStorage.setItem("savedZoom", map.getZoom().toString());
    });

    // Add basic controls 
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-left");

    // Ensure sources/layers exist on style load 
    const ensureSourcesAndLayers = () => {
      // Nodes source (clustered)
      if (!map.getSource("nodes")) {
        map.addSource("nodes", {
          type: "geojson",
          data: buildNodesGeoJSON(nodes),
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
        });
      }

      // Links source (neighbor/heard-by lines)
      if (!map.getSource("links")) {
        map.addSource("links", {
          type: "geojson",
          data: emptyFeatureCollection(),
        });
      }

      // Links layer (draw under markers)
      if (!map.getLayer("links-line")) {
        map.addLayer({
          id: "links-line",
          type: "line",
          source: "links",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-width": 4,
            "line-opacity": 0.9,
            // match legend colors
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

      // Cluster circles
      if (!map.getLayer("clusters")) {
        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "nodes",
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
            // neutral cluster color 
            "circle-color": "#3b82f6",
            "circle-opacity": 0.85,
          },
        });
      }

      // Cluster count labels
      if (!map.getLayer("cluster-count")) {
        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "nodes",
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-size": 12,
          },
          paint: {
            "text-color": "#ffffff",
          },
        });
      }

      // Unclustered nodes (circles)
      if (!map.getLayer("unclustered-nodes")) {
        map.addLayer({
          id: "unclustered-nodes",
          type: "circle",
          source: "nodes",
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
              "#32f032", // online
              "rgba(0,0,0,0.50)", // offline
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

      // Unclustered labels (shortname)
      if (!map.getLayer("unclustered-labels")) {
        map.addLayer({
          id: "unclustered-labels",
          type: "symbol",
          source: "nodes",
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

      // Cursor behaviors
      map.on("mouseenter", "unclustered-nodes", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "unclustered-nodes", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });

      // Clicking a cluster zooms in
      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const cluster = features[0];
        if (!cluster) return;

        const clusterId = cluster.properties?.cluster_id;
        const source = map.getSource("nodes") as MbGeoJSONSource;
        if (!source || clusterId == null) return;

        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err) return;
          const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
          map.easeTo({ center: [lng, lat], zoom });
        });
      });

      // Clicking a node shows details + draws links
      map.on("click", "unclustered-nodes", async (e) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const id = (feature.properties?.id ?? "") as string;
        const node = nodes[id];
        if (!node || !node.position) return;

        // feature-state selection highlight
        if (mbSelectedIdRef.current && map.getSource("nodes")) {
          try {
            map.setFeatureState({ source: "nodes", id: mbSelectedIdRef.current }, { selected: false });
          } catch {
            // ignore if feature vanished due to filter updates
          }
        }
        mbSelectedIdRef.current = id;
        map.setFeatureState({ source: "nodes", id }, { selected: true });

        // Build the panel 
        const displayName = await reverseGeocode(node.position[0], node.position[1]);

        let panel =
          `<b>${node.longname}</b><br/>${node.shortname} / ${id}<br/><br/>` +
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
              if (nnode.position) {
                distance =
                  Math.sqrt(
                    (node.position![0] - nnode.position[0]) ** 2 +
                      (node.position![1] - nnode.position[1]) ** 2
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
              if (nnode.position) {
                distance =
                  Math.sqrt(
                    (node.position![0] - nnode.position[0]) ** 2 +
                      (node.position![1] - nnode.position[1]) ** 2
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

        // Draw links in Mapbox: build a GeoJSON LineString set and setData()
        const linkFeatures: any[] = [];

        const neighborSet = new Set((node.neighbors ?? []).map((n) => n.id));
        const heardBySet = new Set(heardBy);

        const union = new Set<string>([...neighborSet, ...heardBySet]);

        union.forEach((otherId) => {
          const other = nodes[otherId];
          if (!other?.position) return;

          const isNeighbor = neighborSet.has(otherId);
          const isHeardBy = heardBySet.has(otherId);

          const kind = isNeighbor && isHeardBy ? "both" : isNeighbor ? "neighbor" : "heard_by";

          linkFeatures.push({
            type: "Feature",
            properties: { kind },
            geometry: {
              type: "LineString",
              coordinates: [
                [node.position![0], node.position![1]],
                [other.position[0], other.position[1]],
              ],
            },
          });
        });

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        if (linksSource) {
          linksSource.setData({
            type: "FeatureCollection",
            features: linkFeatures,
          } as any);
        }
      });

      // Clicking empty space clears panel + links / keeps selection until next click
      map.on("click", (e) => {
        const hitNode = map.queryRenderedFeatures(e.point, { layers: ["unclustered-nodes"] }).length > 0;
        const hitCluster = map.queryRenderedFeatures(e.point, { layers: ["clusters"] }).length > 0;
        if (hitNode || hitCluster) return;

        clearDetailsPanel();

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyFeatureCollection() as any);
      });
    };

    map.on("style.load", ensureSourcesAndLayers);

    // cleanup
    return () => {
      if (mbMapRef.current) {
        mbMapRef.current.remove();
        mbMapRef.current = null;
        mbSelectedIdRef.current = null;
      }
    };
  }, [nodes, serverNode]);

  // Mapbox: live updates (nodes appear/disappear) via setData()
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const src = map.getSource("nodes") as MbGeoJSONSource | undefined;
    if (!src) return;

    const data = buildNodesGeoJSON(nodes);
    src.setData(data as any);

    // If selected node disappears (no longer recent), clear selection + links/panel
    const selectedId = mbSelectedIdRef.current;
    if (selectedId) {
      const stillExists = (data.features as any[]).some((f) => f?.properties?.id === selectedId);
      if (!stillExists) {
        try {
          map.setFeatureState({ source: "nodes", id: selectedId }, { selected: false });
        } catch {
          // ignore
        }
        mbSelectedIdRef.current = null;

        const linksSource = map.getSource("links") as MbGeoJSONSource | undefined;
        linksSource?.setData(emptyFeatureCollection() as any);
        clearDetailsPanel();
      }
    }
  }, [nodes]);

  // ----------------------------
  // OpenLayers: (OSM default / fallback path)
  // ----------------------------
  useEffect(() => {
    const provider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
    const usingMapbox = provider === "mapbox" && Boolean(token);

    // If Mapbox is active, OL is not used on this page
    if (usingMapbox) return;

    if (olMap) return;
    if (!serverNode || !nodes || !mapRef) {
      return;
    }

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode?.position
      ? {
          latitude: serverNode.position[1],
          longitude: serverNode.position[0],
        }
      : defaultPosition;

    const savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    const initialCenter = fromLonLat([
      savedCenter[0] ?? serverPosition.longitude,
      savedCenter[1] ?? serverPosition.latitude,
    ]);
    const initialZoom = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");

    const tileLayer = createBaseTileLayer();

    // Only apply the "dark invert" filter for OSM (including mapbox-without-token fallback)
    const hasMapboxToken = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);
    const reallyUsingMapbox = provider === "mapbox" && hasMapboxToken;

    if (
      !reallyUsingMapbox &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      tileLayer.on("prerender", (evt: RenderEvent) => {
        if (evt.context) {
          const context = evt.context as CanvasRenderingContext2D;
          context.filter = "grayscale(80%) invert(100%) ";
          context.globalCompositeOperation = "source-over";
        }
      });

      tileLayer.on("postrender", (evt: RenderEvent) => {
        if (evt.context) {
          const context = evt.context as CanvasRenderingContext2D;
          context.filter = "none";
        }
      });
    }

    const map = new OlMap({
      layers: [tileLayer],
      target: mapRef.current as HTMLElement,
      view: new View({
        center: initialCenter,
        zoom: initialZoom,
      }),
    });
    setOlMap(map);

    map.on("moveend", () => {
      const center = map.getView().getCenter();
      const zoom = map.getView().getZoom();
      if (center) {
        const [lon, lat] = transform(center, "EPSG:3857", "EPSG:4326");
        if (lon && lat) {
          localStorage.setItem("savedCenter", JSON.stringify([lon, lat]));
        }
      }
      if (zoom) {
        localStorage.setItem("savedZoom", zoom.toString());
      }
    });

    map.on("pointermove", (evt) => {
      const hit = map.hasFeatureAtPixel(evt.pixel);
      map.getTargetElement().style.cursor = hit ? "pointer" : "";
    });

    const neighborLayers: VectorLayer<Feature<Geometry>>[] = [];

    const recentNodeEntries = computeRecentNodes(nodes);

    const features = recentNodeEntries
      .map(([id, node]) => {
        if (!node.position) return null;

        const feature = new Feature({
          geometry: new Point(fromLonLat([node.position[0], node.position[1]])),
          node: {
            id,
            shortname: node.shortname,
            longname: node.longname,
            last_seen: node.last_seen,
            position: [node.position[0], node.position[1]],
            online: node.online,
            neighbors: node.neighbors,
          },
        });

        if (node.online) {
          feature.setStyle(onlineStyle);
        } else {
          feature.setStyle(offlineStyle);
        }

        return feature;
      })
      .filter(Boolean) as Feature<Point>[];

    const vectorLayer = new VectorLayer({
      style: defaultStyle,
      source: new VectorSource({ features }),
    });

    map.addLayer(vectorLayer);

    const nodePanel = document.getElementById("details");
    const nodeTitle = document.getElementById("details-title");
    const nodeSubtitle = document.getElementById("details-subtitle");
    const nodeContent = document.getElementById("details-content");

    if (!nodePanel || !nodeTitle || !nodeSubtitle || !nodeContent) {
      return;
    }

    const selectedStyle = new Style({
      image: new Circle({
        radius: 6,
        fill: new Fill({
          color: "rgba(0, 0, 240, 1)",
        }),
        stroke: new Stroke({
          color: "orange",
          width: 2,
        }),
      }),
    });

    const select = new Select({
      condition: click,
      style: selectedStyle,
    });
    map.addInteraction(select);

    map.on("singleclick", async (event) => {
      neighborLayers.forEach((layer) => {
        map.removeLayer(layer);
      });
      neighborLayers.length = 0;

      if (map.hasFeatureAtPixel(event.pixel) === true) {
        const feature = map.forEachFeatureAtPixel(event.pixel, (f) => f);
        if (feature) {
          const properties = feature.getProperties();
          const { node } = properties as {
            node: IMapNode & { position: Coordinate };
          };
          const displayName = await reverseGeocode(node.position[0], node.position[1]);

          let panel =
            `<b>${node.longname}</b><br/>${node.shortname} / ${node.id}<br/><br/>` +
            `<b>Position</b><br/>${node.position}<br/><br/>` +
            `<b>Location</b><br/>${displayName || "Unknown"}<br/><br/>` +
            `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
            `<b>Last Seen</b><br/>${node.last_seen}<br/><br/>`;

          panel += "<b>Neighbors Heard</b><br/>";
          if (node.neighbors?.length === 0) {
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
                if (nnode.position) {
                  distance =
                    Math.sqrt(
                      (node.position[0] - nnode.position[0]) ** 2 +
                        (node.position[1] - nnode.position[1]) ** 2
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
              if (!nnode || !nnode.position) {
                return;
              }
              const points = [node.position, nnode.position];

              // eslint-disable-next-line no-plusplus
              for (let i = 0; i < points.length; i++) {
                points[i] = transform(points[i], "EPSG:4326", "EPSG:3857");
              }

              const featureLine = new Feature({
                geometry: new LineString(points),
              });

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
          const heardBy = Object.keys(nodes).filter((id) =>
            nodes[id].neighbors?.some((neighbor) => neighbor.id === node.id)
          );
          if (heardBy.length === 0) {
            panel += "None<br/>";
          } else {
            panel +=
              "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
            panel +=
              "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";
            panel += heardBy
              .map((id) => {
                const nnode = nodes[id];
                const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);
                if (!nnode) {
                  return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor?.snr}</td><td></td></tr>`;
                }
                let distance;

                if (nnode.position) {
                  distance =
                    Math.sqrt(
                      (node.position[0] - nnode.position[0]) ** 2 +
                        (node.position[1] - nnode.position[1]) ** 2
                    ) * 111.32;
                }
                return `<tr><td align=left>${nnode.shortname}</td><td align=center>${neighbor?.snr}</td><td align=right>${
                  distance ? distance.toFixed(2) : "unk"
                } km</td></tr>`;
              })
              .join("");
            panel += "</table>";

            // add the heard_by lines
            heardBy.forEach((id) => {
              const nnode = nodes[id];
              if (!nnode || !nnode.position) {
                return;
              }
              const points = [node.position, nnode.position];

              // eslint-disable-next-line no-plusplus
              for (let i = 0; i < points.length; i++) {
                points[i] = transform(points[i], "EPSG:4326", "EPSG:3857");
              }

              const featureLine = new Feature({
                geometry: new LineString(points),
              });

              const vectorLine = new Vector({});
              vectorLine.addFeature(featureLine);

              let lineStyle = new Style({
                fill: new Fill({ color: "#6666FF" }),
                stroke: new Stroke({ color: "#6666FF", width: 4 }),
              });

              // if the nnode is also a neighbor of the node, make the line purple
              if (node.neighbors?.some((neighbor) => neighbor.id === id)) {
                lineStyle = new Style({
                  fill: new Fill({ color: "#FF66FF" }),
                  stroke: new Stroke({ color: "#FF66FF", width: 4 }),
                });
              }

              const vectorLineLayer = new VectorLayer({
                source: vectorLine,
                style: lineStyle,
              });
              neighborLayers.push(vectorLineLayer);
              map.addLayer(vectorLineLayer);
            });
          }

          panel += "<br/>";

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
        } else {
          nodeTitle.innerHTML = "Unknown";
          nodeSubtitle.innerHTML = "UNK";
          nodeContent.innerHTML = "";
          nodePanel.classList.remove("hidden");
        }
      } else {
        nodeTitle.innerHTML = "";
        nodeSubtitle.innerHTML = "";
        nodeContent.innerHTML = "";
      }
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, serverNode, mapRef, olMap]);

  return (
    <div className="h-screen">
      <div id="map" className="map" ref={mapRef} />
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
