import type { Map as MlMap, RasterDEMSourceSpecification, SkySpecification, StyleSpecification } from "maplibre-gl";

export type MapProvider = "osm" | "mapbox";
export type OsmBasemap = "osm" | "osm_hot" | "carto_positron" | "carto_dark";

export interface BuildStyleOptions {
  provider: MapProvider;
  osmBasemap?: OsmBasemap;
  mapboxToken?: string;
  /** "mapbox/streets-v12" or "mapbox://styles/mapbox/streets-v12". */
  mapboxStyle?: string;
}

const ATTRIB_OSM =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const ATTRIB_CARTO =
  '© <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';
const ATTRIB_MAPBOX =
  '© <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a>';
// Tilezen DEM has no required attribution (public-domain USGS/NASA sources).
// The panel's "Terrain data" footer credits it where users actually look.

const TERRAIN_SOURCE_ID = "terrain-dem";
const BASE_SOURCE_ID = "base";
const BASE_LAYER_ID = "base";
const BUILDINGS_3D_SOURCE_ID = "buildings-3d";
const BUILDINGS_3D_LAYER_ID = "buildings-3d";

const ATTRIB_OPENFREEMAP =
  '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>';

const SKY_SPEC: SkySpecification = {
  "sky-color": "#7fb3d5",
  "sky-horizon-blend": 0.5,
  "horizon-color": "#dbe9f6",
  "horizon-fog-blend": 0.5,
  "fog-color": "#ffffff",
  "fog-ground-blend": 0.5,
  "atmosphere-blend": 1.0,
};

/** Sky/fog for dark basemaps; the daytime SKY_SPEC clashes over a dark map. */
const DARK_SKY_SPEC: SkySpecification = {
  "sky-color": "#0b1220",
  "sky-horizon-blend": 0.5,
  "horizon-color": "#1e2a3a",
  "horizon-fog-blend": 0.5,
  "fog-color": "#0f172a",
  "fog-ground-blend": 0.5,
  "atmosphere-blend": 0.6,
};

function normalizeMapboxStylePath(style: string): string {
  return style.startsWith("mapbox://styles/")
    ? style.slice("mapbox://styles/".length)
    : style;
}

function osmTiles(basemap: OsmBasemap): { tiles: string[]; tileSize: 256 | 512; attribution: string } {
  switch (basemap) {
    case "osm_hot":
      return {
        tiles: [
          "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: ATTRIB_OSM,
      };
    case "carto_positron":
      return {
        tiles: [
          "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
          "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
          "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
          "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
        ],
        tileSize: 256,
        attribution: `${ATTRIB_OSM} ${ATTRIB_CARTO}`,
      };
    case "carto_dark":
      return {
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        ],
        tileSize: 256,
        attribution: `${ATTRIB_OSM} ${ATTRIB_CARTO}`,
      };
    case "osm":
    default:
      return {
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: ATTRIB_OSM,
      };
  }
}

function mapboxTiles(token: string, stylePath: string): { tiles: string[]; tileSize: 512; attribution: string } {
  const style = normalizeMapboxStylePath(stylePath);
  return {
    tiles: [
      `https://api.mapbox.com/styles/v1/${style}/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
    ],
    tileSize: 512,
    attribution: `${ATTRIB_MAPBOX} ${ATTRIB_OSM}`,
  };
}

export function buildMapStyle(opts: BuildStyleOptions): StyleSpecification {
  const useMapbox = opts.provider === "mapbox" && !!opts.mapboxToken;
  const base = useMapbox
    ? mapboxTiles(opts.mapboxToken!, opts.mapboxStyle ?? "mapbox/streets-v12")
    : osmTiles(opts.osmBasemap ?? "osm");

  return {
    version: 8,
    sources: {
      [BASE_SOURCE_ID]: {
        type: "raster",
        tiles: base.tiles,
        tileSize: base.tileSize,
        attribution: base.attribution,
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: BASE_LAYER_ID,
        type: "raster",
        source: BASE_SOURCE_ID,
        paint: {},
      },
    ],
  };
}

/** Tilezen everywhere keeps the rendered terrain in lockstep with what the RF
 *  tools (LoS / coverage / scan) feed into ITM. 3DEP 10 m in the US, SRTM 30 m
 *  global, no token. */
export function demSourceSpec(): RasterDEMSourceSpecification {
  return {
    type: "raster-dem",
    tiles: [
      "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    ],
    tileSize: 256,
    maxzoom: 15,
    encoding: "terrarium",
  };
}

/** Idempotent — safe to re-call after style reloads. */
export function ensureTerrain(map: MlMap, exaggeration: number, isDark = false): void {
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, demSourceSpec());
  }
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
  map.setSky(isDark ? DARK_SKY_SPEC : SKY_SPEC);
}

/** A basemap whose tiles are dark (so the daytime sky/fog would clash). */
export function isDarkBasemap(provider: MapProvider, osmBasemap: OsmBasemap, mapboxStyle: string): boolean {
  return provider === "mapbox" ? mapboxStyle.includes("dark") : osmBasemap === "carto_dark";
}

/** `setTerrain(null)` alone leaves MapLibre 5's depth pass referencing destroyed
 *  state (shaderPreludeCode crash + triggerRepaint loop). Removing the DEM source
 *  after halts the pipeline cleanly until ensureTerrain re-adds it. */
export function removeTerrain(map: MlMap): void {
  try { map.setTerrain(null); } catch {}
  try {
    if (map.getSource(TERRAIN_SOURCE_ID)) map.removeSource(TERRAIN_SOURCE_ID);
  } catch {}
  try { map.setSky({}); } catch {}
  try { map.triggerRepaint(); } catch {}
}

/** Cosmetic 3D buildings via OpenFreeMap vector tiles — paint-only, independent
 *  of the RF building-height raster. minzoom=14 because OpenFreeMap doesn't
 *  ship buildings below z13 and z13 is too distant to be visually useful.
 *  Idempotent — safe to re-call after style reloads. */
export function ensureBuildings3D(map: MlMap): void {
  if (!map.getSource(BUILDINGS_3D_SOURCE_ID)) {
    map.addSource(BUILDINGS_3D_SOURCE_ID, {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution: ATTRIB_OPENFREEMAP,
    });
  }
  if (!map.getLayer(BUILDINGS_3D_LAYER_ID)) {
    map.addLayer({
      id: BUILDINGS_3D_LAYER_ID,
      type: "fill-extrusion",
      source: BUILDINGS_3D_SOURCE_ID,
      "source-layer": "building",
      minzoom: 14,
      // OpenMapTiles schema opt-out flag.
      filter: ["!=", ["get", "hide_3d"], true],
      paint: {
        // Low opacity so basemap labels under tall buildings stay readable.
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["get", "render_height"],
          0, "#a8b5c4",
          50, "#8a98aa",
          200, "#6e7d92",
        ],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.65,
      },
    });
  }
}

export function removeBuildings3D(map: MlMap): void {
  try { if (map.getLayer(BUILDINGS_3D_LAYER_ID)) map.removeLayer(BUILDINGS_3D_LAYER_ID); } catch {}
  try { if (map.getSource(BUILDINGS_3D_SOURCE_ID)) map.removeSource(BUILDINGS_3D_SOURCE_ID); } catch {}
}

export const MAP_STYLE_IDS = {
  baseSource: BASE_SOURCE_ID,
  baseLayer: BASE_LAYER_ID,
  terrainSource: TERRAIN_SOURCE_ID,
  buildings3DSource: BUILDINGS_3D_SOURCE_ID,
  buildings3DLayer: BUILDINGS_3D_LAYER_ID,
} as const;
