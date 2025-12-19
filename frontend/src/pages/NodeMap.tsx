import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, { GeoJSONSource as MbGeoJSONSource, Map as MbMap } from "mapbox-gl";

import { Feature, Map as OlMap, View } from "ol";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import type RenderEvent from "ol/render/Event";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useRef, useState } from "react";

import { createBaseTileLayer } from "../maps/baseLayer";
import { INode } from "../types";

type MapProvider = "osm" | "mapbox";

function toMapboxStyleUrl(style: string) {
  return style.startsWith("mapbox://") ? style : `mapbox://styles/${style}`;
}

function makeNodeGeoJSON(node: INode) {
  if (!node.position) {
    return { type: "FeatureCollection" as const, features: [] as any[] };
  }

  const lng = node.position.longitude;
  const lat = node.position.latitude;

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: node.node_id ?? node.shortname ?? "node",
        properties: {
          id: node.node_id ?? "",
          shortname: node.shortname ?? "",
          longname: node.longname ?? "",
          online: Boolean((node as any).active),
        },
        geometry: {
          type: "Point" as const,
          coordinates: [lng, lat] as [number, number],
        },
      },
    ],
  };
}

export const NodeMap = ({ node }: { node: INode }) => {
  const mapRef = useRef<HTMLDivElement>(null);

  // OpenLayers map state
  const [olMap, setOlMap] = useState<OlMap>();

  // Mapbox map ref
  const mbMapRef = useRef<MbMap | null>(null);

  // ---------- OpenLayers styles (unchanged) ----------
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

  // ---------- Mapbox init (only when provider=mapbox and token exists) ----------
  useEffect(() => {
    const provider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
    const usingMapbox = provider === "mapbox" && Boolean(token);

    if (!usingMapbox) return;
    if (!mapRef.current) return;
    if (!node.position) return;
    if (mbMapRef.current) return;

    const stylePath = (import.meta.env.VITE_MAPBOX_STYLE ?? "mapbox/streets-v12") as string;
    const styleUrl = toMapboxStyleUrl(stylePath);

    mapboxgl.accessToken = token!;

    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: styleUrl,
      center: [node.position.longitude, node.position.latitude],
      zoom: 12,
      attributionControl: true,
    });

    mbMapRef.current = map;

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-left");

    map.on("style.load", () => {
      // Source
      if (!map.getSource("node")) {
        map.addSource("node", {
          type: "geojson",
          data: makeNodeGeoJSON(node),
        });
      }

      // Marker circle
      if (!map.getLayer("node-circle")) {
        map.addLayer({
          id: "node-circle",
          type: "circle",
          source: "node",
          paint: {
            "circle-radius": 8,
            "circle-color": ["case", ["boolean", ["get", "online"], false], "#32f032", "rgba(0,0,0,0.50)"],
            "circle-stroke-width": 2,
            "circle-stroke-color": "white",
          },
        });
      }

      // Shortname label
      if (!map.getLayer("node-label")) {
        map.addLayer({
          id: "node-label",
          type: "symbol",
          source: "node",
          layout: {
            "text-field": ["get", "shortname"],
            "text-size": 13,
            "text-offset": [0, 1.2],
            "text-anchor": "top",
            "text-optional": true,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#000000",
            "text-halo-width": 1.25,
          },
        });
      }
    });

    return () => {
      if (mbMapRef.current) {
        mbMapRef.current.remove();
        mbMapRef.current = null;
      }
    };
  }, [node]);

  // ---------- Mapbox live updates via setData() ----------
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const src = map.getSource("node") as MbGeoJSONSource | undefined;
    if (!src) return;

    src.setData(makeNodeGeoJSON(node) as any);

    // If position changed, re-center
    if (node.position) {
      map.jumpTo({
        center: [node.position.longitude, node.position.latitude],
        zoom: 12,
      });
    }
  }, [node]);

  // ---------- OpenLayers path (default / fallback) ----------
  useEffect(() => {
    const provider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
    const hasMapboxToken = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);
    const usingMapbox = provider === "mapbox" && hasMapboxToken;

    // If Mapbox renderer is active, don't create OL map
    if (usingMapbox) return;

    if (olMap) return;
    if (!node.position || !mapRef.current) return;

    const tileLayer = createBaseTileLayer();

    // Only apply the "dark invert" filter for OSM (including mapbox-without-token fallback)
    if (
      !usingMapbox &&
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
      target: mapRef.current,
      view: new View({
        center: fromLonLat([node.position.longitude, node.position.latitude]),
        zoom: 12,
      }),
    });
    setOlMap(map);

    const features: Feature<Point>[] = [];
    const feature = new Feature({
      geometry: new Point(fromLonLat([node.position.longitude, node.position.latitude])),
      node,
    });

    feature.setStyle((node as any).active ? onlineStyle : offlineStyle);
    features.push(feature);

    const layer = new VectorLayer({
      style: defaultStyle,
      source: new VectorSource({ features }),
    });
    map.addLayer(layer);

    return () => {
      map.setTarget(undefined);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      id="map"
      className="map"
      ref={mapRef}
      style={{ height: "300px", width: "100%" }}
    />
  );
};
