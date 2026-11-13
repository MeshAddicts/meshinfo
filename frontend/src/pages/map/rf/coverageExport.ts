import { zipStore } from "../lib/zipStore";
import type { DEMBounds } from "../terrain/terrainDEM";
import type { CoverageResult } from "./coverageAnalysis";
import type { ContourFeatureCollection } from "./coverageContours";
import { gradient } from "./coverageRaster";

export type CoverageExportFormat = "geojson" | "kmz";

/** Margin grid of a finished compute. Row 0 = north; NaN = no data. Cells are
 *  evenly spaced in longitude and latitude across `bounds`. */
export interface CoverageMarginGrid {
  data: Float32Array;
  width: number;
  height: number;
  bounds: DEMBounds;
}

const MODEL = "Longley-Rice v1.4 (ITS) via WASM";
/** Overlay image inside the KMZ, relative to doc.kml. */
const KMZ_IMAGE_PATH = "files/coverage.png";

function fileStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

function download(payload: BlobPart, mime: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([payload], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** GeoJSON: origin point (with the link-budget metadata) + iso-margin contours. */
export function buildCoverageGeoJson(
  contours: ContourFeatureCollection,
  result: CoverageResult,
  now: Date,
): string {
  const originGeo = {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [result.origin[0], result.origin[1]] },
    properties: {
      kind: "origin",
      originHeightM: Math.round(result.originHeightM),
      originIsFallback: result.originIsFallback,
      radiusKm: result.radiusKm,
      txAntennaDbi: result.txAntennaDbi,
      rxAntennaDbi: result.rxAntennaDbi,
      rxAntennaHeightAboveGroundM: result.rxAntennaHeightAboveGroundM,
      txDbm: result.txDbm,
      rxSensitivityDbm: result.rxSensitivityDbm,
      model: MODEL,
      generatedAt: now.toISOString(),
    },
  };
  return JSON.stringify({
    type: "FeatureCollection",
    features: [originGeo, ...contours.features],
  }, null, 2);
}

/** The on-map paint: margin → color ramp, transparent where the link budget
 *  fails (margin < 0) or there is no data. */
export function marginGridToRgba(margin: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(margin.length * 4);
  for (let i = 0; i < margin.length; i++) {
    const m = margin[i];
    if (!(m >= 0)) continue; // also skips NaN
    const [r, g, b, a] = gradient(m);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }
  return rgba;
}

/** KML keeps <west> within ±180; a box crossing the antimeridian keeps its
 *  width by letting <east> run past 180. */
function latLonBox(bounds: DEMBounds): DEMBounds {
  const shift = -360 * Math.floor((bounds.west + 180) / 360);
  return { north: bounds.north, south: bounds.south, east: bounds.east + shift, west: bounds.west + shift };
}

const deg = (n: number) => String(Number(n.toFixed(7)));

/** KML for Google Earth: the coverage paint as one ground overlay draped on the
 *  terrain, plus the origin. Contours are left out — each fragment would be its
 *  own entry in the Places list, thousands per export. */
export function buildCoverageKml(result: CoverageResult, bounds: DEMBounds, now: Date): string {
  const box = latLonBox(bounds);
  const originHeightM = Math.round(result.originHeightM);

  // Descriptions sit inside CDATA (escaping would double-encode) and render as
  // HTML in Google Earth, hence <br/> instead of newlines.
  const description = [
    `Model: ${MODEL}`,
    `Origin height: ${originHeightM} m${result.originIsFallback ? " (fallback)" : ""}`,
    `Analysis radius: ${result.radiusKm} km`,
    `TX: ${result.txDbm} dBm, antenna ${result.txAntennaDbi} dBi`,
    `RX: antenna ${result.rxAntennaDbi} dBi @ ${Math.round(result.rxAntennaHeightAboveGroundM)} m AGL, sensitivity ${result.rxSensitivityDbm} dBm`,
    `Generated: ${now.toISOString()}`,
  ].join("<br/>");

  const swatch = (color: string, label: string) => `<span style="color:${color}">&#9632;</span> ${label}`;
  const legend = [
    "Link margin above the receiver's sensitivity:",
    swatch("#d946ef", "0 dB (edge of coverage)"),
    swatch("#f97316", "+5 dB"),
    swatch("#06b6d4", "+15 dB"),
    swatch("#0891b2", "+25 dB and above"),
    "Unpainted areas are not predicted to be reachable.",
  ].join("<br/>");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>MeshInfo coverage</name>
    <open>1</open>
    <description><![CDATA[${description}]]></description>
    <Style id="origin">
      <IconStyle>
        <color>ffd3f322</color>
        <scale>1.1</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon>
      </IconStyle>
    </Style>
    <GroundOverlay>
      <name>Predicted coverage</name>
      <description><![CDATA[${legend}]]></description>
      <Icon><href>${KMZ_IMAGE_PATH}</href></Icon>
      <LatLonBox>
        <north>${deg(box.north)}</north>
        <south>${deg(box.south)}</south>
        <east>${deg(box.east)}</east>
        <west>${deg(box.west)}</west>
      </LatLonBox>
    </GroundOverlay>
    <Placemark>
      <name>Coverage origin</name>
      <description><![CDATA[${originHeightM} m MSL · TX ${result.txDbm} dBm · ${result.txAntennaDbi} dBi]]></description>
      <styleUrl>#origin</styleUrl>
      <Point>
        <coordinates>${result.origin[0]},${result.origin[1]},${originHeightM}</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>
`;
}

/** KMZ = ZIP holding doc.kml and the overlay image it points at. */
export function buildCoverageKmz(
  result: CoverageResult,
  bounds: DEMBounds,
  png: Uint8Array,
  now: Date,
): Uint8Array<ArrayBuffer> {
  return zipStore(
    [
      { name: "doc.kml", data: new TextEncoder().encode(buildCoverageKml(result, bounds, now)) },
      { name: KMZ_IMAGE_PATH, data: png },
    ],
    now,
  );
}

async function encodePng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function exportCoverageGeoJson(contours: ContourFeatureCollection, result: CoverageResult): void {
  const now = new Date();
  download(
    buildCoverageGeoJson(contours, result, now),
    "application/geo+json",
    `meshinfo-coverage-${fileStamp(now)}.geojson`,
  );
}

/** Painted from the margin grid rather than the on-map image, which a drag
 *  preview may have replaced with a coarser one. */
export async function exportCoverageKmz(grid: CoverageMarginGrid, result: CoverageResult): Promise<void> {
  const now = new Date();
  const png = await encodePng(marginGridToRgba(grid.data), grid.width, grid.height);
  download(
    buildCoverageKmz(result, grid.bounds, png, now),
    "application/vnd.google-earth.kmz",
    `meshinfo-coverage-${fileStamp(now)}.kmz`,
  );
}
