import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import type TileSource from "ol/source/Tile";
import XYZ from "ol/source/XYZ";

type MapProvider = "osm" | "mapbox";
export type OsmBasemap = "osm" | "osm_hot" | "carto_positron" | "carto_dark";

type CreateBaseLayerOptions = {
  provider?: MapProvider;
  osmBasemap?: OsmBasemap;

  mapboxToken?: string;
  mapboxStyle?: string;
};

const ATTRIB_OSM =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ATTRIB_OSM_SHORT =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const ATTRIB_CARTO =
  '© <a href="https://carto.com/attributions">CARTO</a>';

const ATTRIB_MAPBOX =
  '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a>';

function normalizeMapboxStylePath(style: string): string {
  if (style.startsWith("mapbox://styles/")) {
    return style.replace("mapbox://styles/", "");
  }
  return style;
}

function createOsmSource(osmBasemap: OsmBasemap): TileSource {
  switch (osmBasemap) {
    case "osm_hot":
      return new XYZ({
        url: "https://{a-c}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
        crossOrigin: "anonymous",
        attributions: ATTRIB_OSM,
      });

    case "carto_positron":
      return new XYZ({
        // CARTO Positron (light)
        url: "https://{a-d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        crossOrigin: "anonymous",
        attributions: `${ATTRIB_OSM} ${ATTRIB_CARTO}`,
      });

    case "carto_dark":
      return new XYZ({
        // CARTO Dark Matter (dark)
        url: "https://{a-d}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        crossOrigin: "anonymous",
        attributions: `${ATTRIB_OSM} ${ATTRIB_CARTO}`,
      });

    case "osm":
    default:
      return new OSM({
        attributions: ATTRIB_OSM_SHORT,
      });
  }
}

export function createBaseTileLayer(
  opts: CreateBaseLayerOptions = {}
): TileLayer<TileSource> {
  const provider =
    (opts.provider ??
      (import.meta.env.VITE_MAP_PROVIDER ?? "osm")) as MapProvider;

  const osmBasemap = (opts.osmBasemap ?? "osm") as OsmBasemap;

  const token =
    (opts.mapboxToken ??
      (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)) as
      | string
      | undefined;

  const styleRaw =
    (opts.mapboxStyle ??
      (import.meta.env.VITE_MAPBOX_STYLE ?? "mapbox/streets-v12")) as string;

  // Mapbox raster tiles (Styles API). EPSG:3857-compatible.
  // If provider=mapbox but token is missing, intentionally fall back to OSM variants
  if (provider === "mapbox" && token) {
    const style = normalizeMapboxStylePath(styleRaw);

    const url =
      `https://api.mapbox.com/styles/v1/${style}/tiles/512/{z}/{x}/{y}@2x` +
      `?access_token=${token}`;

    return new TileLayer({
      source: new XYZ({
        url,
        tileSize: 512,
        crossOrigin: "anonymous",
        attributions: `${ATTRIB_MAPBOX} ${ATTRIB_OSM}`,
      }),
    });
  }

  // Default: OSM variants
  return new TileLayer({
    source: createOsmSource(osmBasemap),
  });
}
