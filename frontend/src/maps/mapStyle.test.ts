import type { RasterLayerSpecification, RasterSourceSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import { buildMapStyle, DEFAULT_OSM_BASEMAP, isDarkBasemap, normalizeOsmBasemap, type OsmBasemap } from "./mapStyle";

const OSM_BASEMAPS: OsmBasemap[] = ["osm", "osm_dark", "osm_hot"];

function base(style: ReturnType<typeof buildMapStyle>) {
  return {
    source: style.sources.base as RasterSourceSpecification,
    layer: style.layers[0] as RasterLayerSpecification,
  };
}

describe("normalizeOsmBasemap", () => {
  it("keeps current ids", () => {
    for (const id of OSM_BASEMAPS) expect(normalizeOsmBasemap(id)).toBe(id);
  });

  it("maps the removed Carto basemaps to the OSM one of the same brightness", () => {
    expect(normalizeOsmBasemap("carto_dark")).toBe("osm_dark");
    expect(normalizeOsmBasemap("carto_positron")).toBe("osm");
  });

  it("falls back to the dark default when nothing usable is stored", () => {
    expect(DEFAULT_OSM_BASEMAP).toBe("osm_dark");
    for (const stored of [null, undefined, "", "nope", 3]) expect(normalizeOsmBasemap(stored)).toBe("osm_dark");
  });
});

describe("buildMapStyle", () => {
  it("serves every OSM basemap from OpenStreetMap hosts", () => {
    for (const osmBasemap of OSM_BASEMAPS) {
      const { source } = base(buildMapStyle({ provider: "osm", osmBasemap }));
      expect(source.tiles?.length).toBeGreaterThan(0);
      for (const url of source.tiles ?? []) expect(new URL(url).hostname).toMatch(/\.tile\.openstreetmap\.(org|fr)$/);
    }
  });

  it("draws OSM Dark from the OSM Standard tiles, inverted in the renderer", () => {
    const standard = base(buildMapStyle({ provider: "osm", osmBasemap: "osm" }));
    const dark = base(buildMapStyle({ provider: "osm", osmBasemap: "osm_dark" }));

    expect(dark.source.tiles).toEqual(standard.source.tiles);
    expect(standard.layer.paint).toEqual({});
    // min above max flips lightness; the half-turn of hue undoes the color flip
    expect(dark.layer.paint?.["raster-brightness-min"]).toBeGreaterThan(
      dark.layer.paint?.["raster-brightness-max"] as number,
    );
    expect(dark.layer.paint?.["raster-hue-rotate"]).toBe(180);
  });

  it("uses Mapbox only when a token is present", () => {
    const withToken = base(buildMapStyle({ provider: "mapbox", mapboxToken: "pk.test", mapboxStyle: "mapbox/dark-v11" }));
    expect(withToken.source.tiles?.[0]).toContain("api.mapbox.com/styles/v1/mapbox/dark-v11/");
    expect(withToken.layer.paint).toEqual({});

    const withoutToken = base(buildMapStyle({ provider: "mapbox", osmBasemap: "osm_dark" }));
    expect(withoutToken.source.tiles).toEqual(base(buildMapStyle({ provider: "osm", osmBasemap: "osm_dark" })).source.tiles);
  });
});

describe("isDarkBasemap", () => {
  it("tracks the selected basemap of the active provider", () => {
    expect(isDarkBasemap("osm", "osm_dark", "mapbox/streets-v12")).toBe(true);
    expect(isDarkBasemap("osm", "osm", "mapbox/dark-v11")).toBe(false);
    expect(isDarkBasemap("mapbox", "osm", "mapbox/dark-v11")).toBe(true);
    expect(isDarkBasemap("mapbox", "osm_dark", "mapbox/streets-v12")).toBe(false);
  });
});
