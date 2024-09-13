import "ol/ol.css";

import { Feature, Map as OlMap, View } from "ol";
import { Coordinate } from "ol/coordinate";
import { click } from "ol/events/condition";
import { Geometry, LineString } from "ol/geom";
import Point from "ol/geom/Point";
import Select from "ol/interaction/Select";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transform } from "ol/proj";
import { Vector } from "ol/source";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useMemo, useRef, useState } from "react";

import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import { INode, NodeRole } from "../types";

type IMapNode = INode & {
  online: boolean;
  position?: Coordinate;
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

const determineStyleForNode = (node: IMapNode | undefined) : Style => {
  // calculate style based on node status (outer ring) and node type (inner circle)
  let stroke;
  let fill;
  const radius = 7;

  if (node) {
    switch (node?.role?.valueOf()) {
      case 0: {
        fill = "rgba(69, 158, 234, 1)";
        break;
      }
      case NodeRole.CLIENT_MUTE: {
        fill = "rgba(69, 158, 234, 1)";
        break;
      }
      case NodeRole.ROUTER: {
        fill = "rgba(140, 20, 252, 1)";
        break;
      }
      case NodeRole.ROUTER_CLIENT: {
        fill = "rgba(140, 20, 252, 1)";
        break;
      }
      case NodeRole.REPEATER: {
        fill = "rgba(140, 20, 252, 1)";
        break;
      }
      case NodeRole.TRACKER: {
        fill = "rgba(175, 65, 84, 1)";
        break;
      }
      case NodeRole.SENSOR: {
        fill = "rgba(0, 0, 240, 1)";
        break;
      }
      case NodeRole.ATAK: {
        fill = "rgba(175, 65, 84, 1)";
        break;
      }
      case NodeRole.CLIENT_HIDDEN: {
        fill = "rgba(0, 0, 240, 1)";
        break;
      }
      case NodeRole.LOST_AND_FOUND: {
        fill = "rgba(242, 38, 19, 1)";
        break;
      }
      case NodeRole.ATAK_TRACKER: {
        fill = "rgba(175, 65, 84, 1)";
        break;
      }
      default: {
        fill = "rgba(69, 158, 234, 1)";
        break;
      }
    }

    if (node.online) {
      stroke = "rgba(69, 234, 129, 1)";
    } else {
      stroke = "rgba(100, 100, 100, 1)";
    }
  } else {
    fill = "rgba(69, 158, 234, 1)";
    stroke = "rgba(100, 100, 100, 1)";
  }

  return new Style({
    image: new Circle({
      radius,
      fill: new Fill({
        color: fill,
      }),
      stroke: new Stroke({
        color: stroke,
        width: 3,
      }),
    }),
  });
}


export function Map() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [olMap, setMap] = useState<OlMap>();

  const { data: rawNodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const nodes = useMemo(() => {
    const now = new Date();
    return Object.fromEntries(
      Object.entries(rawNodes).map(([id, node]) => [
        id,
        {
          ...node,
          online: node.active,
          position:
            node.position &&
            node.position.latitude_i &&
            node.position.longitude_i
              ? [
                  (node.position?.longitude_i ?? 0) / 10000000,
                  (node.position?.latitude_i ?? 0) / 10000000,
                ]
              : undefined,
          neighbors: node.neighborinfo?.neighbors?.map((neighbor) => ({
            id: neighbor.node_id.toString(16),
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

  const reverseGeocode = async (
    lon: string,
    lat: string
  ): Promise<{
    address?: {
      town?: string;
      city?: string;
      county?: string;
      state?: string;
      country?: string;
    };
  }> =>
    (
      await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lon}&lat=${lat}`
      )
    ).json();

  useEffect(() => {
    if (olMap) return;
    if (!serverNode || !nodes || !mapRef) {
      return;
    }

    const defaultPosition = { latitude: 38.5816, longitude: -121.4944 };
    const serverPosition = serverNode?.position
      ? {
          latitude: serverNode.position[0],
          longitude: serverNode.position[1],
        }
      : defaultPosition;

    const savedCenter = JSON.parse(localStorage.getItem("savedCenter") ?? "[]");
    const initialCenter = fromLonLat([
      savedCenter[0] ?? serverPosition.latitude,
      savedCenter[1] ?? serverPosition.longitude,
    ]);
    const initialZoom = JSON.parse(localStorage.getItem("savedZoom") ?? "9.5");

    const tileLayer = new TileLayer({
      source: new OSM(),
    });

    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      tileLayer.on("prerender", (evt) => {
        if (evt.context) {
          const context = evt.context as CanvasRenderingContext2D;
          context.filter = "grayscale(80%) invert(100%) ";
          context.globalCompositeOperation = "source-over";
        }
      });
      tileLayer.on("postrender", (evt) => {
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
    setMap(map);

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

    const features = Object.entries(nodes)
      .map(([id, node]) => {
        if (node.position) {
          const feature = new Feature({
            geometry: new Point(
              fromLonLat([node.position[0], node.position[1]])
            ),
            node: {
              id,
              shortname: node.shortname,
              longname: node.longname,
              last_seen: node.last_seen,
              position: [node.position[0], node.position[1]],
            },
          });
          feature.setStyle(determineStyleForNode(node as IMapNode));
          return feature;
        }
        return null;
      })
      .filter(Boolean) as Feature<Point>[];

    const vectorLayer = new VectorLayer({
      style: determineStyleForNode(undefined),
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
            node: IMapNode & { position: Coordinate }; // if it's a node, it will have a position
          };
          const address = await reverseGeocode(
            node.position[0].toString(),
            node.position[1].toString()
          );
          const displayName = [
            address.address?.town,
            address.address?.city,
            address.address?.county,
            address.address?.state,
            address.address?.country,
          ]
            .filter(Boolean)
            .join(", ");

          let panel =
            `<b>${node.longname}</b><br/>${node.shortname} / ${
              node.id
            }<br/><br/>` +
            `<b>Position</b><br/>${node.position}<br/><br/>` +
            `<b>Location</b><br/>${displayName}<br/><br/>` +
            `<b>Status</b><br/>${
              node.online ? "Online" : "Offline"
            }<br/><br/>` +
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
                  return `<tr><td class="text-gray-600">UNK</td><td align=center>${
                    neighbor.snr
                  }</td><td></td></tr>`;
                }
                let distance;
                if (nnode.position) {
                  distance =
                    Math.sqrt(
                      (node.position[0] - nnode.position[0]) ** 2 +
                        (node.position[1] - nnode.position[1]) ** 2
                    ) * 111.32;
                }
                return `<tr><td align=left>${
                  nnode.shortname
                }</td><td align=center>${
                  neighbor.snr
                }</td><td align=right>${distance ? distance.toFixed(2) : "unk"} km</td></tr>`;
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
                const neighbor = nnode?.neighbors?.find(
                  (n) => n.id === node.id
                );
                if (!nnode) {
                  return `<tr><td class="text-gray-600">UNK</td><td align=center>${
                    neighbor?.snr
                  }</td><td></td></tr>`;
                }
                let distance;

                if (nnode.position) {
                  distance =
                    Math.sqrt(
                      (node.position[0] - nnode.position[0]) ** 2 +
                        (node.position[1] - nnode.position[1]) ** 2
                    ) * 111.32;
                }
                // calculate distance between two nodes without using ol.sphere
                return `<tr><td align=left>${
                  nnode.shortname
                }</td><td align=center>${
                  neighbor?.snr
                }</td><td align=right>${distance ? distance.toFixed(2) : "unk"} km</td></tr>`;
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
          panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshview.armooo.net/packet_list/${
            nodeId
          }" target="_blank">Armooo's MeshView</a><br/>`;
          panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${
            node.id
          }" target="_blank">Bay Mesh Explorer</a><br/>`;
          panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${
            nodeId
          }" target="_blank">Liam's Map</a><br/>`;
          panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${
            nodeId
          }" target="_blank">MeshMap</a><br/>`;

          nodeTitle.innerHTML = node.longname;
          nodeSubtitle.innerHTML = node.shortname;
          nodeContent.innerHTML = panel;
          nodePanel.classList.remove("hidden");
        } else {
          // content.innerHTML = '<b>Unknown</b>';
          // overlay.setPosition(coordinate);

          nodeTitle.innerHTML = "Unknown";
          nodeSubtitle.innerHTML = "UNK";
          nodeContent.innerHTML = "";
          nodePanel.classList.remove("hidden");
        }
      } else {
        if (nodeTitle) {
          nodeTitle.innerHTML = "";
        }
        if (nodeSubtitle) {
          nodeSubtitle.innerHTML = "";
        }
        if (nodeContent) {
          nodeContent.innerHTML = "";
        }
      }
    });

    // don't need to watch olMap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, serverNode, mapRef]);

  return (
    <div className="h-screen">
      <div id="map" className="map" ref={mapRef} />
      <div id="details" className="p-4 bg-white dark:bg-black hidden">
        <div className="flex items-center w-full justify-items-stretch">
          <div id="details-title" className="flex-auto text-lg text-start">
            NODE NAME
          </div>
          <div
            id="details-subtitle"
            className="flex-auto ml-4 text-sm text-end"
          >
            NODE
          </div>
        </div>
        <div id="details-content" className="align-items-center" />
      </div>
      <div id="legend" className="p-2 bg-white dark:bg-black">
        <div className="text-lg">LEGEND</div>
        <div className="align-items-center">
          <div className="inline-block w-12 h-1 bg-green-400" /> Heard A
          Neighbor
        </div>
        <div>
          <div className="inline-block w-12 h-1 bg-blue-400" /> Heard By
          Neighbor
        </div>
        <div>
          <div className="inline-block w-12 h-1 bg-purple-400" /> Both Heard
          Each Other
        </div>
      </div>
      <style>
        {`
          #map {
            height: 100%;
            width: 100%;
          }
          #legend {
            position: absolute;
            bottom: 10px;
            right: 10px;
            z-index: 1000;
          }
          #details {
            position: absolute;
            top: 10px;
            right: 10px;
            z-index: 1000;
          }
          .ol-popup {
            position: absolute;
            background-color: white;
            box-shadow: 0 1px 4px rgba(0,0,0,0.2);
            padding: 15px;
            border-radius: 10px;
            border: 1px solid #cccccc;
            bottom: 12px;
            left: -50px;
            min-width: 280px;
          }
          .ol-popup:after, .ol-popup:before {
            top: 100%;
            border: solid transparent;
            content: " ";
            height: 0;
            width: 0;
            position: absolute;
            pointer-events: none;
          }
          .ol-popup:after {
            border-top-color: white;
            border-width: 10px;
            left: 48px;
            margin-left: -10px;
          }
          .ol-popup:before {
            border-top-color: #cccccc;
            border-width: 11px;
            left: 48px;
            margin-left: -11px;
          }
          .ol-popup-closer {
            text-decoration: none;
            position: absolute;
            top: 2px;
            right: 8px;
          }
          .ol-popup-closer:after {
            content: "x";
          }
      `}
      </style>
    </div>
  );
}
