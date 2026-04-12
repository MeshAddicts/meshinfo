/**
 * Per-pixel RGBA coverage renderer.
 *
 * Given a DEM + viewshed (precomputed per-pixel distance and worst knife-edge
 * Fresnel parameter), compute link budget / RSSI / margin per pixel and paint
 * the output RGBA buffer using the same gradient as the old polygon layer:
 *   0 dB  → orange (#f97316)
 *   5 dB  → yellow (#eab308)
 *  15 dB  → green  (#22c55e)
 *  25 dB  → dark   (#16a34a)
 * Alpha scales with margin; margin < 0 pixels are fully transparent so the
 * terrain shows through unchanged.
 */
import type { DEM } from "./terrainDEM";
import { knifeEdgeLossDb, type Viewshed } from "./viewshed";

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
  /** Environment path-loss exponent (2.0 = free space). */
  envExponent: number;
}

export interface RasterResult {
  /** RGBA bytes, row-major, length = width × height × 4. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Summary counts from classification. */
  clearCount: number;
  fresnelCount: number;
  diffractedCount: number;
  blockedCount: number;
  /** Max margin (dB) seen across all reachable pixels. */
  maxMarginDb: number;
}

/** Same formula as coverageAnalysis.pathLossDb, duplicated to avoid importing into worker. */
function pathLossDb(dKm: number, freqMhz: number, envExponent: number): number {
  const d = Math.max(0.01, dKm);
  const freeSpace = 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(d);
  const excess = (envExponent - 2) * 10 * Math.log10(Math.max(1, d));
  return freeSpace + excess;
}

/** Linearly interpolate between two 0–255 channel values. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Gradient: orange → yellow → green → darkGreen, keyed by marginDb.
 * Alpha ramps from 0.35 at margin=0 to 0.7 at margin=25.
 */
function gradient(marginDb: number): [number, number, number, number] {
  // Stops: [marginDb, r, g, b]
  // orange   #f97316 = (249,115,22)
  // yellow   #eab308 = (234,179,8)
  // green    #22c55e = (34,197,94)
  // darkgrn  #16a34a = (22,163,74)
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

  // Alpha: 0.35 at margin=0 up to 0.7 at margin=25, clamped.
  const aT = Math.min(1, Math.max(0, marginDb / 25));
  const a = Math.round(255 * (0.35 + 0.35 * aT));
  return [Math.round(r), Math.round(g), Math.round(b), a];
}

/**
 * Compute per-pixel RSSI margin from a viewshed and paint the RGBA buffer.
 *
 * `dem` is only used to confirm pixel validity (NaN elevations → transparent).
 */
export function renderCoverageRaster(
  dem: DEM,
  viewshed: Viewshed,
  params: RasterParams,
): RasterResult {
  const { width, height } = viewshed;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const {
    freqMhz,
    txDbm,
    antennaDbi,
    rxSensitivityDbm,
    fadeMarginDb,
    cableLossDb,
    envExponent,
  } = params;

  let clearCount = 0;
  let fresnelCount = 0;
  let diffractedCount = 0;
  let blockedCount = 0;
  let maxMarginDb = -Infinity;

  for (let i = 0; i < width * height; i++) {
    const dKm = viewshed.distanceKm[i];
    const v = viewshed.worstV[i];
    const demElev = dem.data[i];

    // Pixels outside the DEM or missing terrain → fully transparent.
    if (Number.isNaN(dKm) || Number.isNaN(demElev)) {
      rgba[i * 4 + 3] = 0;
      continue;
    }

    const diffractionLossDb = knifeEdgeLossDb(v);
    const totalLossDb = pathLossDb(dKm, freqMhz, envExponent) + diffractionLossDb + cableLossDb;
    const rssiDbm = txDbm + 2 * antennaDbi - totalLossDb;
    const marginDb = rssiDbm - rxSensitivityDbm - fadeMarginDb;

    if (marginDb < 0) {
      blockedCount++;
      rgba[i * 4 + 3] = 0;
      continue;
    }

    // Classify for summary stats (mirrors old coverageAnalysis logic).
    if (viewshed.blocked[i]) {
      diffractedCount++;
    } else if (diffractionLossDb > 0.1) {
      fresnelCount++;
    } else {
      clearCount++;
    }
    if (marginDb > maxMarginDb) maxMarginDb = marginDb;

    const [r, g, b, a] = gradient(marginDb);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }

  return {
    rgba,
    width,
    height,
    clearCount,
    fresnelCount,
    diffractedCount,
    blockedCount,
    maxMarginDb: maxMarginDb === -Infinity ? 0 : maxMarginDb,
  };
}
