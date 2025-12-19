import TileLayer from "ol/layer/Tile";
import type TileSource from "ol/source/Tile";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";

type MapProvider = "osm" | "mapbox";
export type OsmBasemap = "osm" | "osm_hot";

type CreateBaseLayerOptions = {
  provider?: MapProvider;
  osmBasemap?: OsmBasemap;

  // used only for OL raster Mapbox fallback path (NodeMap etc)
  mapboxToken?: string;
  mapboxStyle?: string;
};

function createOsmSource(osmBasemap: OsmBasemap): TileSource {
  if (osmBasemap === "osm_hot") {
    return new XYZ({
      url: "https://{a-c}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      crossOrigin: "anonymous",
      attributions:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
  }

  return new OSM({
    attributions:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
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

  const style =
    (opts.mapboxStyle ??
      (import.meta.env.VITE_MAPBOX_STYLE ?? "mapbox/streets-v12")) as string;

  // Mapbox raster tiles (Styles API). EPSG:3857-compatible.
  if (provider === "mapbox" && token) {
    const url =
      `https://api.mapbox.com/styles/v1/${style}/tiles/512/{z}/{x}/{y}@2x` +
      `?access_token=${token}`;

    return new TileLayer({
      source: new XYZ({
        url,
        tileSize: 512,
        crossOrigin: "anonymous",
        attributions:
          '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' +
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }),
    });
  }

  // Default: OSM variants
  return new TileLayer({
    source: createOsmSource(osmBasemap),
  });
}
