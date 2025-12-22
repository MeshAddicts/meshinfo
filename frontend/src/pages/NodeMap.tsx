import "ol/ol.css";
import "mapbox-gl/dist/mapbox-gl.css";

import mapboxgl, {
  GeoJSONSource as MbGeoJSONSource,
  Map as MbMap,
} from "mapbox-gl";

import { Feature, Map as OlMap, View } from "ol";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style } from "ol/style";
import { useEffect, useMemo, useRef } from "react";

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

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getLonLat(node: INode): [number, number] | null {
  const anyNode: any = node as any;

  const mp = anyNode.map_position;
  if (Array.isArray(mp) && mp.length === 2) {
    const lng = num(mp[0]);
    const lat = num(mp[1]);
    if (lng != null && lat != null) return [lng, lat];
  }

  const p: any = anyNode.position;
  if (!p) return null;

  // Float coordinates
  const lngF = num(p.longitude);
  const latF = num(p.latitude);
  if (lngF != null && latF != null) return [lngF, latF];

  // Meshtastic-style scaled ints
  const lngI = num(p.longitude_i);
  const latI = num(p.latitude_i);
  if (lngI != null && latI != null) return [lngI / 10_000_000, latI / 10_000_000];

  return null;
}

function isNodeOnline(node: INode): boolean {
  const lastSeen = (node as any).last_seen as string | undefined;
  if (lastSeen) {
    const t = new Date(lastSeen).getTime();
    if (!Number.isNaN(t)) {
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      return Date.now() - t < SIX_HOURS_MS;
    }
  }
  return Boolean((node as any).active);
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

/** Prevent “blank until resize” and avoid calling OL renderSync after teardown. */
function bumpOl(map: OlMap): () => void {
  const safe = () => {
    const el = map.getTargetElement?.();
    if (!el || !el.isConnected) return false;
    map.updateSize();
    try {
      map.renderSync();
    } catch {
    }
    return true;
  };

  safe();

  const raf = requestAnimationFrame(() => {
    safe();
  });

  const t = window.setTimeout(() => {
    safe();
  }, 200);

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(t);
  };
}

/** Same idea for Mapbox GL */
function bumpMb(map: MbMap): () => void {
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

  const raf = requestAnimationFrame(() => {
    safe();
  });

  const t = window.setTimeout(() => {
    safe();
  }, 200);

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(t);
  };
}

export const NodeMap = ({ node }: { node: INode }) => {
  const mapRef = useRef<HTMLDivElement>(null);

  // Keep instances in refs (avoids state timing / re-render weirdness)
  const olMapRef = useRef<OlMap | null>(null);
  const olMarkerRef = useRef<Feature<Point> | null>(null);
  const olMarkerSourceRef = useRef<VectorSource<Feature<Point>> | null>(null);

  const mbMapRef = useRef<MbMap | null>(null);

  // Cancel queued bumps
  const cancelOlBumpRef = useRef<(() => void) | null>(null);
  const cancelMbBumpRef = useRef<(() => void) | null>(null);

  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  const hasMapbox = Boolean(mapboxToken);

  // Read preferences once per mount (mirrors Map.tsx)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMapbox]);

  const usingMapbox = settings.provider === "mapbox" && hasMapbox;

  // Styles
  const defaultStyle = useMemo(
    () =>
      new Style({
        image: new Circle({
          radius: 6,
          fill: new Fill({ color: "rgba(0, 0, 240, 1)" }),
          stroke: new Stroke({ color: "white", width: 2 }),
        }),
      }),
    []
  );

  const offlineStyle = useMemo(
    () =>
      new Style({
        image: new Circle({
          radius: 6,
          fill: new Fill({ color: "rgba(0, 0, 0, 0.50)" }),
          stroke: new Stroke({ color: "white", width: 2 }),
        }),
      }),
    []
  );

  const onlineStyle = useMemo(
    () =>
      new Style({
        image: new Circle({
          radius: 6,
          fill: new Fill({ color: "rgba(50, 240, 50, 1)" }),
          stroke: new Stroke({ color: "white", width: 2 }),
        }),
      }),
    []
  );

  // ---- Init / attach + update (Mapbox OR OpenLayers)
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;

    const lonLat = getLonLat(node);

    cancelOlBumpRef.current?.();
    cancelOlBumpRef.current = null;
    cancelMbBumpRef.current?.();
    cancelMbBumpRef.current = null;

    // -----------------------
    // Mapbox path
    // -----------------------
    if (usingMapbox) {
      if (olMapRef.current) {
        try {
          olMapRef.current.setTarget(undefined);
        } catch {
        }
        olMapRef.current = null;
        olMarkerRef.current = null;
        olMarkerSourceRef.current = null;
      }

      if (!lonLat) {
        return;
      }

      // Create or update mapbox map
      const existing = mbMapRef.current;
      if (!existing) {
        el.innerHTML = "";

        if (!mapboxgl.accessToken) {
          mapboxgl.accessToken = mapboxToken!;
        }

        const styleUrl = toMapboxStyleUrl(settings.mapboxStyle);

        const map = new mapboxgl.Map({
          container: el,
          style: styleUrl,
          center: lonLat,
          zoom: 12,
          attributionControl: true,
        });

        mbMapRef.current = map;
        map.addControl(
          new mapboxgl.NavigationControl({ showCompass: true }),
          "top-left"
        );

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

        // Ensure on initial style load + future style changes
        map.on("style.load", ensureLayers);
        map.once("load", () => {
          ensureLayers();
          cancelMbBumpRef.current?.();
          cancelMbBumpRef.current = bumpMb(map);
        });

        cancelMbBumpRef.current = bumpMb(map);
      } else {
        const src = existing.getSource("node") as MbGeoJSONSource | undefined;
        if (src) src.setData(makeNodeGeoJSON(node) as any);
        existing.jumpTo({ center: lonLat }); // keep zoom
        cancelMbBumpRef.current = bumpMb(existing);
      }

      return () => {
        cancelMbBumpRef.current?.();
        cancelMbBumpRef.current = null;
      };
    }

    // -----------------------
    // OpenLayers path
    // -----------------------
    if (mbMapRef.current) {
      try {
        mbMapRef.current.remove();
      } catch {
      }
      mbMapRef.current = null;
    }

    if (!lonLat) return;

    const existingOl = olMapRef.current;

    if (!existingOl) {
      // fresh container
      el.innerHTML = "";

      const base = createBaseTileLayer({
        provider: "osm",
        osmBasemap: settings.osmBasemap,
      });

      const map = new OlMap({
        layers: [base],
        target: el as HTMLElement,
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

      olMapRef.current = map;
      olMarkerRef.current = feature;
      olMarkerSourceRef.current = src;

      cancelOlBumpRef.current = bumpOl(map);
    } else {
      // If the target got lost (layout remounts), re-attach
      const target = existingOl.getTarget();
      if (target !== el) {
        try {
          existingOl.setTarget(el as HTMLElement);
        } catch {
        }
      }

      // Update marker + center
      const f = olMarkerRef.current;
      if (f) {
        f.setGeometry(new Point(fromLonLat(lonLat)));
        f.setStyle(isNodeOnline(node) ? onlineStyle : offlineStyle);
      }

      existingOl.getView().setCenter(fromLonLat(lonLat));
      cancelOlBumpRef.current = bumpOl(existingOl);
    }

    return () => {
      cancelOlBumpRef.current?.();
      cancelOlBumpRef.current = null;
    };
  }, [
    node,
    usingMapbox,
    mapboxToken,
    settings.mapboxStyle,
    settings.osmBasemap,
    defaultStyle,
    offlineStyle,
    onlineStyle,
  ]);

  // Final cleanup on unmount
  useEffect(() => {
    return () => {
      cancelOlBumpRef.current?.();
      cancelOlBumpRef.current = null;
      cancelMbBumpRef.current?.();
      cancelMbBumpRef.current = null;

      if (mbMapRef.current) {
        try {
          mbMapRef.current.remove();
        } catch {
        }
        mbMapRef.current = null;
      }
      if (olMapRef.current) {
        try {
          olMapRef.current.setTarget(undefined);
        } catch {
        }
        olMapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      id="map"
      className="map"
      ref={mapRef}
      style={{
        height: "300px",
        width: "100%",
        borderRadius: "12px",
        overflow: "hidden",
        background: "rgba(0,0,0,0.25)",
      }}
    />
  );
};
