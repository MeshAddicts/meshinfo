/**
 * Per-pixel viewshed: for each DEM pixel, walks origin→pixel ray, tracks
 * earth-bulge-corrected max elevation angle and worst Fresnel-Kirchhoff v
 * for per-pixel knife-edge diffraction loss.
 */
import type { DEM } from "./terrainDEM";
import { sampleDEMAt } from "./terrainDEM";

const R_EARTH_KM = 6371;
const K_REFRACTION = 4 / 3;
const SPEED_OF_LIGHT_MPS = 299_792_458;

/** Great-circle km. Duplicated from losAnalysis so this module is worker-safe. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/** Earth bulge (m) at d1 from A toward B (d2 = D − d1). */
function earthBulgeM(d1Km: number, d2Km: number): number {
  return (d1Km * d2Km * 1000) / (2 * K_REFRACTION * R_EARTH_KM);
}

/** Fresnel-Kirchhoff v for obstruction h (m) above chord. */
function knifeEdgeV(hMeters: number, d1Km: number, d2Km: number, freqMhz: number): number {
  const lambda = SPEED_OF_LIGHT_MPS / (freqMhz * 1e6);
  const d1m = d1Km * 1000;
  const d2m = d2Km * 1000;
  if (d1m <= 0 || d2m <= 0) return -Infinity;
  return hMeters * Math.sqrt((2 * (d1m + d2m)) / (lambda * d1m * d2m));
}

export interface ViewshedInput {
  dem: DEM;
  origin: [number, number];
  /** Origin MSL height (m); pre-resolved (altitude or terrain+antenna). */
  originHeightM: number;
  /** RX antenna AGL (m); default 2. */
  targetAntennaHeightM?: number;
  /** GHz; default 0.915. */
  freqGHz?: number;
  /** Default 48. */
  raySamples?: number;
}

export interface Viewshed {
  width: number;
  height: number;
  /** Worst knife-edge v per pixel; NaN if unreachable. */
  worstV: Float32Array;
  /** km from origin per pixel. */
  distanceKm: Float32Array;
  /** 1 if any ray sample above chord. */
  blocked: Uint8Array;
}

/** Per-pixel viewshed: distance, LoS-blocked flag, worst knife-edge v. */
export function computeViewshed(input: ViewshedInput): Viewshed {
  const {
    dem,
    origin,
    originHeightM,
    targetAntennaHeightM = 2,
    freqGHz = 0.915,
    raySamples = 48,
  } = input;
  const { width, height, bounds } = dem;
  const freqMhz = freqGHz * 1000;

  const worstV = new Float32Array(width * height);
  const distanceKm = new Float32Array(width * height);
  const blocked = new Uint8Array(width * height);

  const lonStep = (bounds.east - bounds.west) / (width - 1);
  const latStep = (bounds.north - bounds.south) / (height - 1);

  for (let y = 0; y < height; y++) {
    const lat = bounds.north - y * latStep;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const lng = bounds.west + x * lonStep;
      const i = rowOffset + x;

      const targetGround = sampleDEMAt(dem, lng, lat);
      if (Number.isNaN(targetGround)) {
        worstV[i] = NaN;
        distanceKm[i] = NaN;
        blocked[i] = 0;
        continue;
      }

      const totalKm = haversineKm(origin, [lng, lat]);
      distanceKm[i] = totalKm;

      // Origin pixel → clear
      if (totalKm < 1e-6) {
        worstV[i] = -Infinity;
        blocked[i] = 0;
        continue;
      }

      const targetHeight = targetGround + targetAntennaHeightM;

      // Walk origin → target, skip endpoints
      let maxV = -Infinity;
      let anyBlocked = false;
      for (let s = 1; s < raySamples; s++) {
        const t = s / raySamples;
        const sampleLng = origin[0] + (lng - origin[0]) * t;
        const sampleLat = origin[1] + (lat - origin[1]) * t;
        const sampleGround = sampleDEMAt(dem, sampleLng, sampleLat);
        if (Number.isNaN(sampleGround)) continue;

        const d1 = totalKm * t;
        const d2 = totalKm - d1;
        if (d1 <= 0 || d2 <= 0) continue;

        const chord = originHeightM + (targetHeight - originHeightM) * t;
        const bulge = earthBulgeM(d1, d2);
        const effectiveGround = sampleGround + bulge;
        const h = effectiveGround - chord; // + = obstructing

        if (h > 0) anyBlocked = true;

        const v = knifeEdgeV(h, d1, d2, freqMhz);
        if (v > maxV) maxV = v;
      }

      worstV[i] = maxV;
      blocked[i] = anyBlocked ? 1 : 0;
    }
  }

  return { width, height, worstV, distanceKm, blocked };
}

/** ITU-R P.526 single knife-edge loss (dB). */
export function knifeEdgeLossDb(v: number): number {
  if (!Number.isFinite(v) || v < -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}
