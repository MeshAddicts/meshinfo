import type { CoverageResult } from "./coverageAnalysis";
import type { ContourFeatureCollection } from "./coverageContours";

/** Export coverage as GeoJSON or KML (iso-margin 0/10/20 dB contours + metadata). */
export function exportCoverage(
  format: "geojson" | "kml",
  contours: ContourFeatureCollection | null,
  result: CoverageResult | null,
): void {
  if (!contours || !result) {
    console.warn("[Map] Coverage export: no data to export.");
    return;
  }
  const now = new Date();
  const stamp = now.toISOString();
  const p = (n: number) => String(n).padStart(2, "0");
  const fileStamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;

  let payload: string;
  let mime: string;
  let ext: string;

  if (format === "geojson") {
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
        model: "Longley-Rice v1.4 (ITS) via WASM",
        generatedAt: stamp,
      },
    };
    payload = JSON.stringify({
      type: "FeatureCollection",
      features: [originGeo, ...contours.features],
    }, null, 2);
    mime = "application/geo+json";
    ext = "geojson";
  } else {
    // KML color format: aabbggrr (byte-reversed from CSS hex)
    const styleFor = (threshold: number) => {
      if (threshold <= 0) return "contour0";
      if (threshold <= 10) return "contour10";
      return "contour20";
    };
    const coordsToKml = (coords: [number, number][]) =>
      coords.map(([lng, lat]) => `${lng},${lat},0`).join(" ");

    const placemarks = contours.features.map((f) => `
    <Placemark>
      <name>${f.properties.thresholdDb} dB margin contour</name>
      <styleUrl>#${styleFor(f.properties.thresholdDb)}</styleUrl>
      <LineString>
        <altitudeMode>clampToGround</altitudeMode>
        <tessellate>1</tessellate>
        <coordinates>${coordsToKml(f.geometry.coordinates)}</coordinates>
      </LineString>
    </Placemark>`).join("");

    // Lands inside CDATA — escaping would double-encode
    const description = [
      `Model: Longley-Rice v1.4 (ITS) via WASM`,
      `Origin height: ${Math.round(result.originHeightM)} m${result.originIsFallback ? " (fallback)" : ""}`,
      `Analysis radius: ${result.radiusKm} km`,
      `TX: ${result.txDbm} dBm, antenna ${result.txAntennaDbi} dBi`,
      `RX: antenna ${result.rxAntennaDbi} dBi @ ${Math.round(result.rxAntennaHeightAboveGroundM)} m AGL, sensitivity ${result.rxSensitivityDbm} dBm`,
      `Generated: ${stamp}`,
    ].join("\n");

    payload = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>MeshInfo coverage</name>
    <description><![CDATA[${description}]]></description>
    <Style id="origin">
      <IconStyle>
        <color>ffd3f322</color>
        <scale>1.1</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon>
      </IconStyle>
    </Style>
    <Style id="contour0">
      <LineStyle><color>ff0b9ef5</color><width>3</width></LineStyle>
    </Style>
    <Style id="contour10">
      <LineStyle><color>ff5ec522</color><width>2</width></LineStyle>
    </Style>
    <Style id="contour20">
      <LineStyle><color>ffacef86</color><width>2</width></LineStyle>
    </Style>
    <Placemark>
      <name>Coverage origin</name>
      <description><![CDATA[${`${Math.round(result.originHeightM)} m MSL · TX ${result.txDbm} dBm · ${result.txAntennaDbi} dBi`}]]></description>
      <styleUrl>#origin</styleUrl>
      <Point>
        <coordinates>${result.origin[0]},${result.origin[1]},${Math.round(result.originHeightM)}</coordinates>
      </Point>
    </Placemark>${placemarks}
  </Document>
</kml>`;
    mime = "application/vnd.google-earth.kml+xml";
    ext = "kml";
  }

  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meshinfo-coverage-${fileStamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
