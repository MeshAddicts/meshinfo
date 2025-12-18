import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";

type MapProvider = "osm" | "mapbox";

export function createBaseTileLayer(): TileLayer {
  const provider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm") as MapProvider;
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  const style = (import.meta.env.VITE_MAPBOX_STYLE ??
    "mapbox/streets-v12") as string;

  // If mapbox selected but no token, fall back to OSM.
  if (provider === "mapbox" && token) {
    // Mapbox raster tiles (Styles API). EPSG:3857-compatible.
    // 512px tiles => tell OL tileSize=512.
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

  return new TileLayer({
    source: new OSM({
      attributions:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
  });
}
