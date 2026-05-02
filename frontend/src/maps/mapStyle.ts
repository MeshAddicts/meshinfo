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
// Tilezen elevation has no required attribution: 3DEP/SRTM/GMTED are public-domain
// USGS / NASA data, and Mapzen (the Tilezen project) is defunct. Source is still
// credited where users actually look — the panel's "Terrain data" footer.

const TERRAIN_SOURCE_ID = "terrain-dem";
const BASE_SOURCE_ID = "base";
const BASE_LAYER_ID = "base";

const SKY_SPEC: SkySpecification = {
  "sky-color": "#7fb3d5",
  "sky-horizon-blend": 0.5,
  "horizon-color": "#dbe9f6",
  "horizon-fog-blend": 0.5,
  "fog-color": "#ffffff",
  "fog-ground-blend": 0.5,
  "atmosphere-blend": 1.0,
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
export function ensureTerrain(map: MlMap, exaggeration: number): void {
  if (!map.getSource(TERRAIN_SOURCE_ID)) {
    map.addSource(TERRAIN_SOURCE_ID, demSourceSpec());
  }
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
  map.setSky(SKY_SPEC);
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

export const MAP_STYLE_IDS = {
  baseSource: BASE_SOURCE_ID,
  baseLayer: BASE_LAYER_ID,
  terrainSource: TERRAIN_SOURCE_ID,
} as const;
