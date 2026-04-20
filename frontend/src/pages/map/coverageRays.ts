import type { Feature, FeatureCollection, LineString } from "geojson";

import type { DEM, DEMBounds } from "./terrainDEM";

/**
 * Visibility-ray extraction for the coverage tool.
 *
 * For each azimuth around the origin we trace a radial line outward
 * and emit the sub-ranges where:
 *
 *   (a) the receiver has a **geometrically clear line-of-sight** from
 *       the TX — tracked via the R2 viewshed algorithm (walk outward,
 *       keep a running max horizon-angle; a pixel is visible iff its
 *       top is above the running horizon). Uses the full DEM for
 *       terrain accuracy and includes a 4/3-earth curvature correction
 *       so long rays don't fake-over-reach the true horizon.
 *
 *   (b) the ITM link budget ALSO closes (`margin ≥ 0` in the
 *       coverage grid). This keeps the rays bounded by the same
 *       "signal reaches" envelope the raster shows, so users don't
 *       see rays punching out into areas the raster marks unreachable.
 *
 * Unlike the prior "sample margin per pixel" approach, this will NOT
 * draw a ray across terrain it can't physically see — behind a ridge,
 * the ITM margin grid often stays ≥ 0 because the signal diffracts
 * around the obstruction, but the HWT-style visibility ray should stop
 * at the ridge.
 */

export interface ExtractRaysOptions {
  /** Full terrain DEM — row-major elevations (meters, NaN = no data). */
  dem: DEM;
  /** Row-major ITM link-budget margin (dB), NaN = no-data. */
  margin: Float32Array;
  /** Margin-grid dimensions (may differ from DEM dims at non-Survey Detail). */
  width: number;
  height: number;
  /** Geographic bounds of both DEM and margin grids (shared). */
  bounds: DEMBounds;
  /** TX position as `[lng, lat]`. */
  origin: [number, number];
  /**
   * TX elevation MSL in meters (terrain + antenna above ground). This
   * is the "observer eye height" for the viewshed; same value ITM's
   * per-pixel pass treats as the TX.
   */
  originHeightM: number;
  /**
   * RX height above terrain at each sampled pixel (meters). Default 2
   * (handheld). Needs to match the value ITM uses or rays and raster
   * subtly disagree on what "reachable" means at the fringe.
   */
  rxHeightM?: number;
  /**
   * Angular spacing between rays in degrees. 1° gives 360 rays (HWT-
   * like density); 2° is lighter on render cost. Default 1°.
   */
  azimuthStepDeg?: number;
  /**
   * Minimum segment length (in DEM pixels) to keep. Filters single-
   * pixel flicker along ridge edges where the viewshed oscillates.
   */
  minSegmentPx?: number;
}

export type VisibilityRayFeatureCollection = FeatureCollection<
  LineString,
  {
    azimuth: number;
    /**
     * Peak link-margin (dB) within the segment, driving data-driven
     * Mapbox styling so ray tint matches the raster gradient.
     */
    marginDb: number;
  }
>;

/** 4/3 × mean earth radius — standard radio-horizon approximation. */
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

  // Walk in DEM coordinates — the DEM is our finest terrain detail, so
  // visibility is accurate regardless of the margin grid's density.
  const demW = dem.width;
  const demH = dem.height;

  const ox = ((origin[0] - bounds.west) / (bounds.east - bounds.west)) * (demW - 1);
  const oy = ((bounds.north - origin[1]) / (bounds.north - bounds.south)) * (demH - 1);

  const demToLng = (gx: number) =>
    bounds.west + (gx / (demW - 1)) * (bounds.east - bounds.west);
  const demToLat = (gy: number) =>
    bounds.north - (gy / (demH - 1)) * (bounds.north - bounds.south);

  // Fast mapping from DEM pixel index to margin-grid pixel index.
  const margScaleX = marginW / demW;
  const margScaleY = marginH / demH;

  // Physical distance per DEM pixel at bbox mid-latitude. Used for the
  // viewshed's angular math and the earth-bulge correction.
  const midLat = (bounds.north + bounds.south) / 2;
  const bboxWidthM =
    (bounds.east - bounds.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const metersPerDemPixel = bboxWidthM / (demW - 1);

  const features: Feature<LineString, { azimuth: number; marginDb: number }>[] = [];

  const maxSteps = Math.ceil(Math.hypot(demW, demH));

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
    // Azimuth convention: 0° = north, clockwise. Grid Y increases
    // southward, so north-going rays have negative dy.
    const dx = Math.sin(azRad);
    const dy = -Math.cos(azRad);

    // R2 viewshed state: highest terrain-to-observer angle seen so far.
    // Any pixel whose top is above this is visible; a pixel at-or-below
    // is blocked. Start at -Infinity so the first step is always
    // considered visible (nothing yet occludes it).
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

      const distM = t * metersPerDemPixel;
      // 4/3-earth bulge: terrain appears lower by d² / (2 × R_eff)
      // as distance grows. Keeps long rays from optimistically reaching
      // over the true radio horizon.
      const earthDrop = (distM * distM) / (2 * EFFECTIVE_EARTH_RADIUS_M);
      const effTerrainElev = terrainElev - earthDrop;
      const effPixelTop = effTerrainElev + rxHeightM;

      // Angles relative to the observer (tan θ ≈ θ for small angles;
      // the ratio form is what matters for ordering).
      const terrainAngle = (effTerrainElev - originHeightM) / distM;
      const pixelAngle = (effPixelTop - originHeightM) / distM;

      // R2: visible when the pixel's top is above the horizon so far.
      // The running max is then updated from the BARE terrain angle —
      // the receiver's height doesn't occlude further pixels, only the
      // terrain itself does.
      const visible = pixelAngle > maxAngle;
      if (terrainAngle > maxAngle) maxAngle = terrainAngle;

      // Gate on link budget too — no point drawing rays to places the
      // raster marks unreachable.
      const margPx = Math.min(marginW - 1, Math.floor(gx * margScaleX));
      const margPy = Math.min(marginH - 1, Math.floor(gy * margScaleY));
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
