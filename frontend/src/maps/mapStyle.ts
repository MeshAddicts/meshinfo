import type {
  Map as MlMap,
  RasterDEMSourceSpecification,
  RasterLayerSpecification,
  SkySpecification,
  StyleSpecification,
} from "maplibre-gl";

export type MapProvider = "osm" | "mapbox";
export type OsmBasemap = "osm" | "osm_dark" | "osm_hot";

/** Basemap when no Mapbox token is configured (and no choice is stored). */
export const DEFAULT_OSM_BASEMAP: OsmBasemap = "osm_dark";

/** Stored basemap id → a current one. The Carto basemaps were removed when
 *  their tiles began requiring an API key; a saved Carto choice maps to the
 *  OSM basemap of the same brightness. */
export function normalizeOsmBasemap(stored: unknown): OsmBasemap {
  switch (stored) {
    case "osm":
    case "osm_dark":
    case "osm_hot":
      return stored;
    case "carto_positron":
      return "osm";
    default:
      return DEFAULT_OSM_BASEMAP;
  }
}

export interface BuildStyleOptions {
  provider: MapProvider;
  osmBasemap?: OsmBasemap;
  mapboxToken?: string;
  /** "mapbox/streets-v12" or "mapbox://styles/mapbox/streets-v12". */
  mapboxStyle?: string;
}

const ATTRIB_OSM =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
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

type RasterPaint = NonNullable<RasterLayerSpecification["paint"]>;

interface BaseTiles {
  tiles: string[];
  tileSize: 256 | 512;
  attribution: string;
  paint?: RasterPaint;
}

/** Turns the light OSM Standard tiles into a dark basemap in the renderer, so
 *  no dark tile service (or key) is needed. Brightness min above max inverts
 *  lightness; the 180° hue rotation then puts the hues back (water stays blue,
 *  parks green). Saturation and contrast are pulled down so overlays stand out. */
const OSM_DARK_PAINT: RasterPaint = {
  "raster-brightness-min": 0.85,
  "raster-brightness-max": 0.07,
  "raster-hue-rotate": 180,
  "raster-saturation": -0.45,
  "raster-contrast": -0.15,
};

const OSM_STANDARD_TILES = [
  "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
  "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
  "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
];

function osmTiles(basemap: OsmBasemap): BaseTiles {
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
    case "osm_dark":
      return { tiles: OSM_STANDARD_TILES, tileSize: 256, attribution: ATTRIB_OSM, paint: OSM_DARK_PAINT };
    case "osm":
    default:
      return { tiles: OSM_STANDARD_TILES, tileSize: 256, attribution: ATTRIB_OSM };
  }
}

function mapboxTiles(token: string, stylePath: string): BaseTiles {
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
        paint: base.paint ?? {},
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
  return provider === "mapbox" ? mapboxStyle.includes("dark") : osmBasemap === "osm_dark";
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
export function ensureBuildings3D(map: MlMap, isDark = false): void {
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
        // Low opacity so basemap labels under tall buildings stay readable;
        // darker + dimmer on dark basemaps so extrusions don't glow as bright blocks.
        "fill-extrusion-color": isDark
          ? ["interpolate", ["linear"], ["get", "render_height"], 0, "#3a4452", 50, "#2c3340", 200, "#222833"]
          : ["interpolate", ["linear"], ["get", "render_height"], 0, "#a8b5c4", 50, "#8a98aa", 200, "#6e7d92"],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": isDark ? 0.5 : 0.65,
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
