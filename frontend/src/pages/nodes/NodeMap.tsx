import "maplibre-gl/dist/maplibre-gl.css";
import "../../maps/maplibreWorker";

import * as maplibregl from "maplibre-gl";
import {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";

import { env } from "../../env";
import { buildMapStyle, type MapProvider, type OsmBasemap } from "../../maps/mapStyle";
import { INode } from "../../types";

interface NodePosition {
  longitude?: number;
  latitude?: number;
  longitude_i?: number;
  latitude_i?: number;
}

interface NodeLocationData {
  map_position?: [number, number];
  position?: NodePosition;
  last_seen?: string;
  active?: boolean;
  id?: string | number;
  shortname?: string;
  longname?: string;
}

type NodeWithLocationData = INode & NodeLocationData;

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

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getLonLat(node: INode): [number, number] | null {
  const nodeWithLocation = node as NodeWithLocationData;

  const mp = nodeWithLocation.map_position;
  if (Array.isArray(mp) && mp.length === 2) {
    const lng = num(mp[0]);
    const lat = num(mp[1]);
    if (lng != null && lat != null) return [lng, lat];
  }

  const p = nodeWithLocation.position;
  if (!p) return null;

  const lngF = num(p.longitude);
  const latF = num(p.latitude);
  if (lngF != null && latF != null) return [lngF, latF];

  const lngI = num(p.longitude_i);
  const latI = num(p.latitude_i);
  if (lngI != null && latI != null) return [lngI / 10_000_000, latI / 10_000_000];

  return null;
}

function isNodeOnline(node: INode): boolean {
  const nodeWithStatus = node as NodeWithLocationData;

  const lastSeen = nodeWithStatus.last_seen;
  if (lastSeen) {
    const t = new Date(lastSeen).getTime();
    if (!Number.isNaN(t)) {
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      return Date.now() - t < SIX_HOURS_MS;
    }
  }
  return Boolean(nodeWithStatus.active);
}

function makeNodeGeoJSON(node: INode) {
  const lonLat = getLonLat(node);
  if (!lonLat) {
    return { type: "FeatureCollection" as const, features: [] as any[] };
  }

  const nodeWithData = node as NodeWithLocationData;
  const [lng, lat] = lonLat;
  const online = isNodeOnline(node);

  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        id: nodeWithData.id ?? nodeWithData.shortname ?? "node",
        properties: {
          id: String(nodeWithData.id ?? ""),
          shortname: nodeWithData.shortname ?? "",
          longname: nodeWithData.longname ?? "",
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

// Signature of everything that affects the rendered feature.
// JSON.stringify (not join) so free-text names can't collide across field boundaries.
function nodeFeatureSig(node: INode, lonLat: [number, number]): string {
  const n = node as NodeWithLocationData;
  return JSON.stringify([
    lonLat[0],
    lonLat[1],
    n.id ?? "",
    n.shortname ?? "",
    n.longname ?? "",
    isNodeOnline(node),
  ]);
}

function bumpMb(map: MlMap): () => void {
  const safe = () => {
    try {
      map.resize();
      map.triggerRepaint();
      return true;
    } catch {
      return false;
    }
  };

  safe();
  const raf = requestAnimationFrame(() => { safe(); });
  const t = window.setTimeout(() => { safe(); }, 200);

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(t);
  };
}

export const NodeMap = ({ node }: { node: INode }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mbMapRef = useRef<MlMap | null>(null);
  const cancelBumpRef = useRef<(() => void) | null>(null);
  const prevLonLatRef = useRef<[number, number] | null>(null);
  const prevSigRef = useRef<string | null>(null);

  const mapboxToken = env.MAPBOX_TOKEN;
  const hasMapbox = Boolean(mapboxToken);

  const settings = useMemo(() => {
    const storedProvider = readJson<MapProvider | null>(LS_KEYS.provider, null);
    const provider: MapProvider =
      storedProvider === "mapbox" && !hasMapbox
        ? "osm"
        : storedProvider ?? (hasMapbox ? "mapbox" : "osm");

    const mapboxStyle =
      readJson<string | null>(LS_KEYS.mapboxStyle, null) ??
      env.MAPBOX_STYLE ??
      "mapbox/dark-v11";

    const osmBasemap =
      readJson<OsmBasemap | null>(LS_KEYS.osmBasemap, null) ?? "carto_dark";

    return { provider, mapboxStyle, osmBasemap };
  }, [hasMapbox]);

  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;

    const lonLat = getLonLat(node);
    cancelBumpRef.current?.();
    cancelBumpRef.current = null;

    if (!lonLat) return;

    const existing = mbMapRef.current;
    if (!existing) {
      el.innerHTML = "";

      const style = buildMapStyle({
        provider: settings.provider,
        osmBasemap: settings.osmBasemap,
        mapboxToken,
        mapboxStyle: settings.mapboxStyle,
      });

      const map = new maplibregl.Map({
        container: el,
        style,
        center: lonLat,
        zoom: 12,
        attributionControl: { compact: true },
        maxPitch: 85,
      });

      // MapLibre 5 lands compact attributions expanded. MutationObserver beats
      // the paint so there's no flicker; see Map.tsx for the longer rationale.
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
      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-left");

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
      map.once("load", () => {
        ensureLayers();
        cancelBumpRef.current?.();
        cancelBumpRef.current = bumpMb(map);
      });

      prevLonLatRef.current = lonLat;
      prevSigRef.current = nodeFeatureSig(node, lonLat);
      cancelBumpRef.current = bumpMb(map);
    } else {
      // Gate updates so SSE node churn doesn't repaint or snap the user's pan
      const sig = nodeFeatureSig(node, lonLat);
      const src = existing.getSource("node") as MlGeoJSONSource | undefined;
      if (src && sig !== prevSigRef.current) {
        prevSigRef.current = sig;
        src.setData(makeNodeGeoJSON(node) as any);
      }
      const prev = prevLonLatRef.current;
      if (!prev || prev[0] !== lonLat[0] || prev[1] !== lonLat[1]) {
        prevLonLatRef.current = lonLat;
        existing.jumpTo({ center: lonLat });
      }
    }

    return () => {
      cancelBumpRef.current?.();
      cancelBumpRef.current = null;
    };
  }, [
    node,
    mapboxToken,
    settings.provider,
    settings.mapboxStyle,
    settings.osmBasemap,
  ]);

  useEffect(() => {
    return () => {
      cancelBumpRef.current?.();
      cancelBumpRef.current = null;
      if (mbMapRef.current) {
        try {
          mbMapRef.current.remove();
        } catch {
          // ignore
        }
        mbMapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className="node-map-preview"
      ref={mapRef}
      style={{
        position: "relative",
        height: "300px",
        width: "100%",
        borderRadius: "12px",
        overflow: "hidden",
        background: "rgba(0,0,0,0.25)",
      }}
    />
  );
};
