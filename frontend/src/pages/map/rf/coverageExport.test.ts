import { describe, expect, it } from "vitest";

import type { CoverageResult } from "./coverageAnalysis";
import { extractCoverageContours } from "./coverageContours";
import { buildCoverageGeoJson, buildCoverageKml, buildCoverageKmz, marginGridToRgba } from "./coverageExport";
import { gradient } from "./coverageRaster";

const NOW = new Date("2026-11-12T08:09:10Z");

const RESULT: CoverageResult = {
  origin: [-122.4194, 37.7749],
  originHeightM: 61.6,
  originIsFallback: false,
  radiusKm: 25,
  clearCount: 10,
  fresnelCount: 20,
  blockedCount: 30,
  scannedPixels: 60,
  frequencyGHz: 0.915,
  txAntennaDbi: 3,
  rxAntennaDbi: 1.5,
  rxAntennaHeightAboveGroundM: 1.5,
  txDbm: 22,
  rxSensitivityDbm: -127,
};

const BOUNDS = { west: -122.72, east: -122.12, south: 37.54, north: 38.01 };

function parseKml(kml: string): Document {
  const doc = new DOMParser().parseFromString(kml, "application/xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

const text = (doc: Document, selector: string) => doc.querySelector(selector)?.textContent;

describe("marginGridToRgba", () => {
  it("paints reachable cells with the map's color ramp and leaves the rest transparent", () => {
    const rgba = marginGridToRgba(new Float32Array([Number.NaN, -0.5, 0, 12, 40]));

    expect(Array.from(rgba.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(rgba.subarray(8, 12))).toEqual(gradient(0));
    expect(Array.from(rgba.subarray(12, 16))).toEqual(gradient(12));
    expect(Array.from(rgba.subarray(16, 20))).toEqual(gradient(40));
  });
});

describe("buildCoverageKml", () => {
  it("is one ground overlay spanning the analysis bounds, plus the origin", () => {
    const doc = parseKml(buildCoverageKml(RESULT, BOUNDS, NOW));

    expect(doc.querySelectorAll("GroundOverlay")).toHaveLength(1);
    expect(text(doc, "GroundOverlay > Icon > href")).toBe("files/coverage.png");
    expect(text(doc, "LatLonBox > north")).toBe("38.01");
    expect(text(doc, "LatLonBox > south")).toBe("37.54");
    expect(text(doc, "LatLonBox > east")).toBe("-122.12");
    expect(text(doc, "LatLonBox > west")).toBe("-122.72");

    expect(doc.querySelectorAll("Placemark")).toHaveLength(1);
    expect(text(doc, "Placemark > name")).toBe("Coverage origin");
    expect(text(doc, "Placemark > Point > coordinates")).toBe("-122.4194,37.7749,62");
  });

  it("carries no contour geometry", () => {
    const kml = buildCoverageKml(RESULT, BOUNDS, NOW);
    expect(parseKml(kml).querySelectorAll("LineString")).toHaveLength(0);
    expect(kml).not.toMatch(/contour/i);
  });

  it("describes the link budget", () => {
    const description = text(parseKml(buildCoverageKml(RESULT, BOUNDS, NOW)), "Document > description");
    expect(description).toContain("Analysis radius: 25 km");
    expect(description).toContain("TX: 22 dBm, antenna 3 dBi");
    expect(description).toContain("sensitivity -127 dBm");
    expect(description).toContain("Generated: 2026-11-12T08:09:10.000Z");
  });

  it.each([
    [{ west: 179.5, east: 180.5 }, { west: "179.5", east: "180.5" }],
    [{ west: -180.5, east: -179.5 }, { west: "179.5", east: "180.5" }],
    [{ west: 180.25, east: 181.25 }, { west: "-179.75", east: "-178.75" }],
  ])("keeps <west> within ±180 for bounds %o", (lng, expected) => {
    const doc = parseKml(buildCoverageKml(RESULT, { ...BOUNDS, ...lng }, NOW));
    expect(text(doc, "LatLonBox > west")).toBe(expected.west);
    expect(text(doc, "LatLonBox > east")).toBe(expected.east);
  });
});

describe("buildCoverageKmz", () => {
  it("packs doc.kml first, then the overlay image it references", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const kmz = buildCoverageKmz(RESULT, BOUNDS, png, NOW);
    // One char per byte, so string offsets are byte offsets.
    const bytes = new TextDecoder("latin1").decode(kmz);

    // The first entry's name follows the 30-byte local header.
    expect(bytes.indexOf("doc.kml")).toBe(30);
    expect(bytes).toContain("<Icon><href>files/coverage.png</href></Icon>");

    const imageName = bytes.indexOf("files/coverage.png", bytes.indexOf("</kml>"));
    expect(imageName).toBeGreaterThan(0);
    const imageStart = imageName + "files/coverage.png".length;
    expect(kmz.subarray(imageStart, imageStart + png.length)).toEqual(png);
  });
});

describe("buildCoverageGeoJson", () => {
  it("keeps the origin and the contour features", () => {
    // 4×4 grid with one reachable 2×2 block → a closed 0 dB contour.
    const margin = new Float32Array(16).fill(-10);
    for (const i of [5, 6, 9, 10]) margin[i] = 10;
    const contours = extractCoverageContours({ margin, width: 4, height: 4, bounds: BOUNDS, thresholdsDb: [0] });
    expect(contours.features.length).toBeGreaterThan(0);

    const geo = JSON.parse(buildCoverageGeoJson(contours, RESULT, NOW));
    expect(geo.type).toBe("FeatureCollection");
    expect(geo.features).toHaveLength(1 + contours.features.length);
    expect(geo.features[0].geometry).toEqual({ type: "Point", coordinates: [-122.4194, 37.7749] });
    expect(geo.features[0].properties).toMatchObject({ kind: "origin", originHeightM: 62, radiusKm: 25 });
    expect(geo.features[1].properties).toEqual({ thresholdDb: 0 });
  });
});
