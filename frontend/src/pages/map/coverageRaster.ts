/**
 * Per-pixel RGBA coverage renderer — Longley-Rice (ITM v1.4) edition.
 *
 * For every pixel in the DEM grid we:
 *   1. Compute its lng/lat and great-circle distance to the origin.
 *   2. Ray-march the DEM along the origin→pixel line, sampling a small
 *      terrain profile (elevations at regular spacing).
 *   3. Hand the profile + antenna + freq + climate params to the ITM
 *      WASM module, which returns basic transmission loss in dB.
 *   4. Compute RSSI + link-budget margin and paint the pixel with the
 *      same orange/yellow/green gradient as before.
 *
 * Replaces the older knife-edge + NLoS penalty path. ITM handles LoS,
 * diffraction, troposcatter, earth-bulge, and ground-reflection
 * regimes internally, so the output is a lot more defensible.
 *
 * Performance notes:
 *   - ItmContext pre-allocates WASM scratch buffers once; the hot loop
 *     does zero allocation.
 *   - Profile length adapts to path distance (15–96 samples). Short
 *     paths get fewer samples to keep per-pixel compute tight.
 *   - DEM sampling uses the existing bilinear `sampleDEMAt`.
 */
import { type DEM, sampleDEMAt } from "./terrainDEM";
import {
  Climate,
  computeP2PLossFast,
  type ItmContext,
  ModeOfVariability,
  Polarization,
} from "./itm";

const R_EARTH_KM = 6371;

export interface RasterParams {
  /** Frequency in MHz. */
  freqMhz: number;
  /** TX power in dBm. */
  txDbm: number;
  /** Symmetric antenna gain (applied at both TX and RX). */
  antennaDbi: number;
  /** Receiver sensitivity floor (dBm). */
  rxSensitivityDbm: number;
  /** Fade margin (dB) added to the sensitivity threshold. */
  fadeMarginDb: number;
  /** Cable/feedline loss (dB). */
  cableLossDb: number;
  /**
   * Environment clutter loss (dB), added on top of ITM's own terrain
   * prediction. ITM doesn't model buildings/foliage, so this is a
   * crude compensation for suburban/urban/dense-vegetation settings.
   * Open: 0 dB. Light terrain: 2 dB. Suburban: 5 dB. Urban: 10 dB.
   */
  clutterLossDb: number;
  /** ITM climate region. */
  climate: Climate;
  /** Surface refractivity in N-units (e.g. 301 for continental). */
  surfaceRefractivityN: number;
  /** Antenna polarization. */
  polarization: Polarization;
  /** Ground dielectric constant ε_r. */
  groundDielectric: number;
  /** Ground conductivity σ (S/m). */
  groundConductivity: number;
  /** TLS reliability percentages (time/location/situation). Default 50/50/50. */
  timePct?: number;
  locationPct?: number;
  situationPct?: number;
}

export interface RasterOrigin {
  /** Origin lng/lat. */
  position: [number, number];
  /** Resolved origin MSL height in meters. */
  heightM: number;
}

export interface RasterResult {
  /** RGBA bytes, row-major, length = width × height × 4. */
  rgba: Uint8ClampedArray;
  /**
   * Per-pixel link margin in dB (RSSI − sensitivity − fade). `NaN` for
   * pixels with no terrain data or where the compute failed. Used
   * downstream for contour extraction (marching squares) and export.
   * Row-major, same dimensions as rgba/width×height.
   */
  marginDb: Float32Array;
  width: number;
  height: number;
  /** Pixels clearly within budget (margin ≥ 15 dB). */
  clearCount: number;
  /** Pixels marginally within budget (0 ≤ margin < 15 dB). */
  fresnelCount: number;
  /** Placeholder so the existing result type still shapes the same —
   *  LR doesn't return a separate "diffracted" bucket. */
  diffractedCount: number;
  /** Pixels below threshold (margin < 0 or compute failed). */
  blockedCount: number;
  /** Max margin across reachable pixels. */
  maxMarginDb: number;
}

// ---------------------------------------------------------------------------
// Gradient painting — unchanged
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradient(marginDb: number): [number, number, number, number] {
  // orange #f97316 → yellow #eab308 → green #22c55e → dark green #16a34a
  let r: number, g: number, b: number;
  if (marginDb <= 0) {
    r = 249; g = 115; b = 22;
  } else if (marginDb < 5) {
    const t = marginDb / 5;
    r = lerp(249, 234, t); g = lerp(115, 179, t); b = lerp(22, 8, t);
  } else if (marginDb < 15) {
    const t = (marginDb - 5) / 10;
    r = lerp(234, 34, t); g = lerp(179, 197, t); b = lerp(8, 94, t);
  } else if (marginDb < 25) {
    const t = (marginDb - 15) / 10;
    r = lerp(34, 22, t); g = lerp(197, 163, t); b = lerp(94, 74, t);
  } else {
    r = 22; g = 163; b = 74;
  }
  const aT = Math.min(1, Math.max(0, marginDb / 25));
  const a = Math.round(255 * (0.35 + 0.35 * aT));
  return [Math.round(r), Math.round(g), Math.round(b), a];
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

function haversineKm(
  lng1: number, lat1: number, lng2: number, lat2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;
  const a1 = (lat1 * Math.PI) / 180;
  const a2 = (lat2 * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(a1) * Math.cos(a2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/**
 * Pick a sensible number of terrain-profile samples for a given path
 * length. ITM's accuracy improves with more samples but so does the
 * per-pixel cost. Roughly 1.5 samples/km, clamped to [15, 96].
 */
function profileSampleCount(distanceKm: number): number {
  const raw = Math.round(distanceKm * 1.5);
  return Math.max(15, Math.min(96, raw));
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

/**
 * Optional row-range — when present, only the rows in
 * `[rowStart, rowEnd)` are computed and the returned RGBA has height
 * `rowEnd - rowStart`. Used by the worker pool to split work across
 * cores; each worker fills its own slice and the main thread stitches
 * them back together.
 */
export interface RowRange {
  rowStart: number;
  rowEnd: number;
}

/**
 * Paint a DEM slice via ITM. The `profileBuf` parameter is reused
 * across pixels to avoid per-pixel allocation (Float64Array). Its length
 * must be ≥ `profileSampleCount(maxDistance)` — we size it to the DEM
 * diagonal in km × 1.5 rounded up.
 *
 * When `rowRange` is omitted the full grid is rendered (preserves old
 * behavior for tests / non-parallel callers). When provided, only rows
 * `[rowStart, rowEnd)` are painted and the returned `rgba` has height
 * `rowEnd - rowStart` (callers stitch by writing into the full-size
 * buffer at `rowStart * width * 4`).
 */
export function renderCoverageRaster(
  dem: DEM,
  params: RasterParams,
  itm: ItmContext,
  origin: RasterOrigin,
  rowRange?: RowRange,
): RasterResult {
  const { width, height, bounds } = dem;
  const rowStart = rowRange?.rowStart ?? 0;
  const rowEnd = rowRange?.rowEnd ?? height;
  const sliceHeight = rowEnd - rowStart;
  const rgba = new Uint8ClampedArray(width * sliceHeight * 4);
  const marginDbBuf = new Float32Array(width * sliceHeight);
  // Default to NaN so "unreachable" / "no data" pixels distinguish from
  // "0 dB margin reachable" in downstream contour work.
  marginDbBuf.fill(Number.NaN);
  const {
    freqMhz, txDbm, antennaDbi,
    rxSensitivityDbm, fadeMarginDb, cableLossDb, clutterLossDb,
    climate, surfaceRefractivityN, polarization,
    groundDielectric, groundConductivity,
    timePct = 50, locationPct = 50, situationPct = 50,
  } = params;

  let clearCount = 0;
  let fresnelCount = 0;
  let blockedCount = 0;
  let maxMarginDb = -Infinity;

  // Pre-allocate a profile buffer big enough for the worst-case path.
  // DEM bbox diagonal is a decent upper bound for how far any pixel can
  // be from the origin. We size the buffer accordingly.
  const diagonalKm = haversineKm(
    bounds.west, bounds.south, bounds.east, bounds.north,
  );
  const maxSamples = profileSampleCount(diagonalKm);
  const profileBuf = new Float64Array(maxSamples);

  const [origLng, origLat] = origin.position;
  const lonStep = (bounds.east - bounds.west) / (width - 1);
  const latStep = (bounds.north - bounds.south) / (height - 1);

  // Reusable input object — mutating it in-place avoids GC pressure
  // from allocating 65k+ objects per compute.
  const itmInput = {
    txHeightM: origin.heightM,
    rxHeightM: 0, // rebuilt per-pixel from terrain
    profileM: profileBuf,
    pointSpacingM: 0,
    climate,
    surfaceRefractivityN,
    freqMhz,
    polarization,
    groundDielectric,
    groundConductivity,
    mdvar: ModeOfVariability.SingleMessage,
    time: timePct,
    location: locationPct,
    situation: situationPct,
  };

  const receiverAntennaAboveGroundM = 2; // mirrors previous pipeline
  const txGain = antennaDbi;
  const rxGain = antennaDbi;

  for (let j = rowStart; j < rowEnd; j++) {
    const lat = bounds.north - j * latStep;
    const demRowOffset = j * width;
    // Output row offset is relative to the slice, not the full grid.
    const outRowOffset = (j - rowStart) * width;
    for (let i = 0; i < width; i++) {
      const pxIdx = demRowOffset + i;
      const outPxIdx = outRowOffset + i;
      const demElev = dem.data[pxIdx];
      if (Number.isNaN(demElev)) {
        // No terrain data — leave transparent.
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }
      const lng = bounds.west + i * lonStep;
      const distKm = haversineKm(origLng, origLat, lng, lat);

      // Degenerate: origin itself. Paint as dark green (max margin).
      if (distKm < 0.01) {
        const [r, g, b, a] = gradient(50);
        rgba[outPxIdx * 4] = r;
        rgba[outPxIdx * 4 + 1] = g;
        rgba[outPxIdx * 4 + 2] = b;
        rgba[outPxIdx * 4 + 3] = a;
        clearCount++;
        if (50 > maxMarginDb) maxMarginDb = 50;
        continue;
      }

      // Build the terrain profile by linearly interpolating the path in
      // lng/lat space and sampling the DEM at each step. For the short
      // paths Meshtastic cares about (up to ~500 km) this is accurate
      // enough — great-circle curvature deviation stays under 1% of the
      // straight-line distance.
      const nSamples = profileSampleCount(distKm);
      let validProfile = true;
      for (let s = 0; s < nSamples; s++) {
        const t = s / (nSamples - 1);
        const sLng = origLng + (lng - origLng) * t;
        const sLat = origLat + (lat - origLat) * t;
        const elev = sampleDEMAt(dem, sLng, sLat);
        if (Number.isNaN(elev)) {
          validProfile = false;
          break;
        }
        profileBuf[s] = elev;
      }
      if (!validProfile) {
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }

      // Resample the profile view into the first `nSamples` slots — the
      // buffer can be longer than we need for short paths. ITM reads
      // exactly `pfl[0]+1` elevations starting at `pfl[2]`, so length
      // beyond that is ignored, but we still set profileM.length
      // correctly by giving ITM the subview.
      // We can't slice here (profileBuf is Float64Array, slice would
      // alloc). Instead, pass a subarray (no-copy view).
      itmInput.profileM = profileBuf.subarray(0, nSamples);
      itmInput.pointSpacingM = (distKm * 1000) / (nSamples - 1);
      itmInput.rxHeightM = receiverAntennaAboveGroundM;

      const lossDb = computeP2PLossFast(itm, itmInput);
      if (!Number.isFinite(lossDb) || lossDb <= 0) {
        // ITM error — paint transparent so user sees something's off
        // rather than coloring by garbage.
        rgba[outPxIdx * 4 + 3] = 0;
        blockedCount++;
        continue;
      }

      const totalLossDb = lossDb + clutterLossDb + cableLossDb;
      const rssiDbm = txDbm + txGain + rxGain - totalLossDb;
      const marginDb = rssiDbm - rxSensitivityDbm - fadeMarginDb;

      // Record the real margin even for blocked pixels — contour
      // extraction needs both sides of the 0-dB boundary.
      marginDbBuf[outPxIdx] = marginDb;

      if (marginDb < 0) {
        blockedCount++;
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }

      if (marginDb >= 15) {
        clearCount++;
      } else {
        fresnelCount++;
      }
      if (marginDb > maxMarginDb) maxMarginDb = marginDb;

      const [r, g, b, a] = gradient(marginDb);
      const o = outPxIdx * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }

  return {
    rgba,
    marginDb: marginDbBuf,
    width,
    height: sliceHeight,
    clearCount,
    fresnelCount,
    diffractedCount: 0,
    blockedCount,
    maxMarginDb: maxMarginDb === -Infinity ? 0 : maxMarginDb,
  };
}
