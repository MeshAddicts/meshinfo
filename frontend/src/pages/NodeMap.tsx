import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, { GeoJSONSource as MbGeoJSONSource, Map as MbMap } from "mapbox-gl";

import { Feature, Map as OlMap, View } from "ol";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useMemo, useRef, useState } from "react";

import { createBaseTileLayer, type OsmBasemap } from "../maps/baseLayer";
import { INode } from "../types";

type MapProvider = "osm" | "mapbox";

const LS_KEYS = {
  provider: "meshinfo.map.provider",
  mapboxStyle: "meshinfo.map.mapboxStyle",
  osmBasemap: "meshinfo.map.osmBasemap",
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

function toMapboxStyleUrl(style: string) {
  return style.startsWith("mapbox://") ? style : `mapbox://styles/${style}`;
}

function bumpOlRender(map: OlMap) {
  map.updateSize();
  map.renderSync();

  requestAnimationFrame(() => {
    map.updateSize();
    map.renderSync();
  });

  window.setTimeout(() => {
    map.updateSize();
    map.renderSync();
  }, 200);
}

function getLonLat(node: INode): [number, number] | null {
  const p: any = (node as any).position;
  if (!p) return null;

  // Float coordinates
  if (typeof p.longitude === "number" && typeof p.latitude === "number") {
    return [p.longitude, p.latitude];
  }

  // Meshtastic-style scaled ints
  if (typeof p.longitude_i === "number" && typeof p.latitude_i === "number") {
    return [p.longitude_i / 10_000_000, p.latitude_i / 10_000_000];
  }

  return null;
}

function isNodeOnline(node: INode): boolean {
  // Prefer last_seen if available (match Map.tsx “recent online” concept)
  const lastSeen = (node as any).last_seen as string | undefined;
  if (lastSeen) {
    const t = new Date(lastSeen).getTime();
    if (!Number.isNaN(t)) {
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      return Date.now() - t < SIX_HOURS_MS;
    }
  }

  // Fallback to legacy/other field if present
  const active = (node as any).active;
  return Boolean(active);
}

function makeNodeGeoJSON(node: INode) {
  const lonLat = getLonLat(node);
  if (!lonLat) {
    return { type: "FeatureCollection" as const, features: [] as any[] };
  }

  const [lng, lat] = lonLat;
  const online = isNodeOnline(node);

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: (node as any).id ?? (node as any).shortname ?? "node",
        properties: {
          id: (node as any).id ?? "",
          shortname: (node as any).shortname ?? "",
          longname: (node as any).longname ?? "",
          online,
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

  // OL map + marker refs
  const [olMap, setOlMap] = useState<OlMap>();
  const olMarkerRef = useRef<Feature<Point> | null>(null);
  const olMarkerSourceRef = useRef<VectorSource<Feature<Point>> | null>(null);

  // Mapbox map ref
  const mbMapRef = useRef<MbMap | null>(null);

  // ----- capabilities
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  const hasMapbox = Boolean(mapboxToken);

  // ----- settings (read once per mount; mirrors Map.tsx behavior)
  const settings = useMemo(() => {
    const storedProvider = readJson<MapProvider | null>(LS_KEYS.provider, null);
    const provider: MapProvider =
      storedProvider === "mapbox" && !hasMapbox ? "osm" : storedProvider ?? "osm";

    const mapboxStyle =
      readJson<string | null>(LS_KEYS.mapboxStyle, null) ??
      (import.meta.env.VITE_MAPBOX_STYLE as string | undefined) ??
      "mapbox/dark-v11";

    const osmBasemap =
      readJson<OsmBasemap | null>(LS_KEYS.osmBasemap, null) ?? "carto_dark";

    return { provider, mapboxStyle, osmBasemap };
    // NOTE: intentionally not reactive to future localStorage changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMapbox]);

  const usingMapbox = settings.provider === "mapbox" && hasMapbox;

  // ---------- OpenLayers styles ----------
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

  // ---------- Mapbox init ----------
  useEffect(() => {
    if (!usingMapbox) return;
    if (!mapRef.current) return;
    if (mbMapRef.current) return;

    const lonLat = getLonLat(node);
    if (!lonLat) return;

    const styleUrl = toMapboxStyleUrl(settings.mapboxStyle);

    // fresh container (safe)
    mapRef.current.innerHTML = "";

    mapboxgl.accessToken = mapboxToken!;

    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: styleUrl,
      center: lonLat,
      zoom: 12,
      attributionControl: true,
    });

    mbMapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-left");

    const ensureLayers = () => {
      if (!map.getSource("node")) {
        map.addSource("node", {
          type: "geojson",
          data: makeNodeGeoJSON(node),
        });
      }

      if (!map.getLayer("node-circle")) {
        map.addLayer({
          id: "node-circle",
          type: "circle",
          source: "node",
          paint: {
            "circle-radius": 8,
            "circle-color": [
              "case",
              ["boolean", ["get", "online"], false],
              "#32f032",
              "rgba(0,0,0,0.50)",
            ],
            "circle-stroke-width": 2,
            "circle-stroke-color": "white",
          },
        });
      }

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
    };

    map.on("style.load", ensureLayers);

    return () => {
      if (mbMapRef.current) {
        mbMapRef.current.remove();
        mbMapRef.current = null;
      }
    };
  }, [usingMapbox, mapboxToken, node, settings.mapboxStyle]);

  // ---------- Mapbox live updates ----------
  useEffect(() => {
    const map = mbMapRef.current;
    if (!map) return;

    const src = map.getSource("node") as MbGeoJSONSource | undefined;
    if (src) src.setData(makeNodeGeoJSON(node) as any);

    const lonLat = getLonLat(node);
    if (lonLat) {
      map.jumpTo({ center: lonLat }); // keep zoom
    }
  }, [node]);

  // ---------- OpenLayers init ----------
  useEffect(() => {
    if (usingMapbox) return;
    if (olMap) return;
    if (!mapRef.current) return;

    const lonLat = getLonLat(node);
    if (!lonLat) return;

    // fresh container (safe)
    mapRef.current.innerHTML = "";

    const base = createBaseTileLayer({
      provider: "osm",
      osmBasemap: settings.osmBasemap,
    });

    const map = new OlMap({
      layers: [base],
      target: mapRef.current as HTMLElement,
      view: new View({
        center: fromLonLat(lonLat),
        zoom: 12,
      }),
    });

    // marker
    const feature = new Feature({
      geometry: new Point(fromLonLat(lonLat)),
      node,
    });
    feature.setStyle(isNodeOnline(node) ? onlineStyle : offlineStyle);

    const src = new VectorSource({ features: [feature] });
    const layer = new VectorLayer({
      style: defaultStyle,
      source: src,
    });

    map.addLayer(layer);

    setOlMap(map);
    olMarkerRef.current = feature;
    olMarkerSourceRef.current = src;

    bumpOlRender(map);

    return () => {
      map.setTarget(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingMapbox, olMap, node, settings.osmBasemap]);

  // ---------- OpenLayers live updates ----------
  useEffect(() => {
    if (usingMapbox) return;
    if (!olMap) return;

    const lonLat = getLonLat(node);
    if (!lonLat) return;

    const f = olMarkerRef.current;
    if (f) {
      f.setGeometry(new Point(fromLonLat(lonLat)));
      f.setStyle(isNodeOnline(node) ? onlineStyle : offlineStyle);
    }

    // re-center (keep zoom)
    const view = olMap.getView();
    view.setCenter(fromLonLat(lonLat));

    bumpOlRender(olMap);
  }, [node, usingMapbox, olMap]);

  return <div id="map" className="map" ref={mapRef} style={{ height: "300px", width: "100%" }} />;
};
