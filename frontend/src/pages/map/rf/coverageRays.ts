import type { Feature, FeatureCollection, LineString } from "geojson";

import type { DEM, DEMBounds } from "../terrain/terrainDEM";

/**
 * Visibility-ray extraction for the coverage tool. Emits ray segments where BOTH:
 *  (a) R2 viewshed says the RX top is above the running horizon (4/3-earth corrected), AND
 *  (b) ITM link budget closes (margin ≥ 0). Keeps rays from punching past ridges where
 *  diffraction kept margin positive but geometry says no LoS.
 */

export interface ExtractRaysOptions {
  /** Full DEM (m, NaN = no data). */
  dem: DEM;
  /** Row-major ITM margin (dB), NaN = no data. */
  margin: Float32Array;
  /** Margin-grid dims (may differ from DEM at non-Survey Detail). */
  width: number;
  height: number;
  bounds: DEMBounds;
  origin: [number, number];
  /** TX MSL height (terrain + antenna AGL); same value ITM uses. */
  originHeightM: number;
  /** RX height above terrain (m); default 2 (handheld). Must match ITM's RX height. */
  rxHeightM?: number;
  /** Degrees between rays; default 1° = 360 rays. */
  azimuthStepDeg?: number;
  /** Filter out segments shorter than this many DEM pixels. */
  minSegmentPx?: number;
}

export type VisibilityRayFeatureCollection = FeatureCollection<
  LineString,
  {
    azimuth: number;
    /** Peak link margin (dB) in segment; drives Mapbox tint. */
    marginDb: number;
  }
>;

/** 4/3 × mean earth radius for radio horizon. */
const EFFECTIVE_EARTH_RADIUS_M = (4 / 3) * 6_371_000;

export function extractCoverageRays(opts: ExtractRaysOptions): VisibilityRayFeatureCollection {
  const {
    dem,
    margin,
    width: marginW,
    height: marginH,
    bounds,
    origin,
    originHeightM,
    rxHeightM = 2,
    azimuthStepDeg = 1,
    minSegmentPx = 2,
  } = opts;

  // Walk in DEM coords (finest terrain detail regardless of margin-grid density)
  const demW = dem.width;
  const demH = dem.height;

  const ox = ((origin[0] - bounds.west) / (bounds.east - bounds.west)) * (demW - 1);
  const oy = ((bounds.north - origin[1]) / (bounds.north - bounds.south)) * (demH - 1);

  const demToLng = (gx: number) =>
    bounds.west + (gx / (demW - 1)) * (bounds.east - bounds.west);
  const demToLat = (gy: number) =>
    bounds.north - (gy / (demH - 1)) * (bounds.north - bounds.south);

  // Per-axis DEM-pixel metres: union bboxes (merge origins) aren't square in
  // metres, so a single scale would skew azimuths and distances N-S vs E-W.
  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    (bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const bboxHeightM = (bounds.north - bounds.south) * 111_320;
  const mPerPxX = bboxWidthM / (demW - 1);
  const mPerPxY = bboxHeightM / (demH - 1);
  /** Step length in true metres (finest pixel), so distM = t × stepM exactly. */
  const stepM = Math.min(mPerPxX, mPerPxY);

  const features: Feature<LineString, { azimuth: number; marginDb: number }>[] = [];

  const maxSteps = Math.ceil(Math.hypot(demW * mPerPxX, demH * mPerPxY) / stepM);

  const pushSegment = (
    az: number,
    startGx: number,
    startGy: number,
    endGx: number,
    endGy: number,
    maxMarginDb: number,
  ) => {
    features.push({
      type: "Feature",
      properties: { azimuth: az, marginDb: maxMarginDb },
      geometry: {
        type: "LineString",
        coordinates: [
          [demToLng(startGx), demToLat(startGy)],
          [demToLng(endGx), demToLat(endGy)],
        ],
      },
    });
  };

  for (let az = 0; az < 360; az += azimuthStepDeg) {
    const azRad = (az * Math.PI) / 180;
    // Azimuth: 0° = N, clockwise; grid y+ = south. Direction is a true-metre
    // unit vector converted to (anisotropic) grid units per step.
    const dx = (Math.sin(azRad) * stepM) / mPerPxX;
    const dy = (-Math.cos(azRad) * stepM) / mPerPxY;

    // R2 viewshed: running max terrain-to-observer angle. Visible iff pixel top exceeds it.
    let maxAngle = -Infinity;

    let segStart: { gx: number; gy: number; step: number } | null = null;
    let segMaxMargin = 0;

    const closeSegment = (endStep: number) => {
      if (segStart !== null && endStep - segStart.step >= minSegmentPx) {
        pushSegment(
          az,
          segStart.gx,
          segStart.gy,
          ox + (endStep - 1) * dx,
          oy + (endStep - 1) * dy,
          segMaxMargin,
        );
      }
      segStart = null;
      segMaxMargin = 0;
    };

    for (let t = 1; t <= maxSteps; t++) {
      const gx = ox + t * dx;
      const gy = oy + t * dy;

      if (gx < 0 || gx >= demW || gy < 0 || gy >= demH) {
        closeSegment(t);
        break;
      }

      const px = Math.floor(gx);
      const py = Math.floor(gy);
      const terrainElev = dem.data[py * demW + px];

      if (Number.isNaN(terrainElev)) {
        closeSegment(t);
        continue;
      }

      const distM = t * stepM;
      // 4/3-earth bulge: d²/(2·R_eff). Keeps long rays from faking over-the-horizon.
      const earthDrop = (distM * distM) / (2 * EFFECTIVE_EARTH_RADIUS_M);
      const effTerrainElev = terrainElev - earthDrop;
      const effPixelTop = effTerrainElev + rxHeightM;

      const terrainAngle = (effTerrainElev - originHeightM) / distM;
      const pixelAngle = (effPixelTop - originHeightM) / distM;

      // Update horizon from BARE terrain (RX height doesn't occlude)
      const visible = pixelAngle > maxAngle;
      if (terrainAngle > maxAngle) maxAngle = terrainAngle;

      // DEM edge-convention coord → normalized position → margin CELL (the
      // margin grid uses cell-center convention)
      const margPx = Math.min(marginW - 1, Math.max(0, Math.floor((gx / (demW - 1)) * marginW)));
      const margPy = Math.min(marginH - 1, Math.max(0, Math.floor((gy / (demH - 1)) * marginH)));
      const m = margin[margPy * marginW + margPx];
      const marginOk = !Number.isNaN(m) && m >= 0;

      const reachable = visible && marginOk;

      if (reachable && segStart === null) {
        segStart = { gx, gy, step: t };
        segMaxMargin = m;
      } else if (reachable && segStart !== null) {
        if (m > segMaxMargin) segMaxMargin = m;
      } else if (!reachable && segStart !== null) {
        closeSegment(t);
      }
    }
  }

  return { type: "FeatureCollection", features };
}
