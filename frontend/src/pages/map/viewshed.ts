/**
 * Terrain-aware viewshed + worst-obstacle computation.
 *
 * For each pixel in a DEM, march a ray from the origin toward that pixel and
 * track the largest vertical angle seen along the way (earth-bulge corrected).
 * If that angle exceeds the angle from origin to the pixel's own terrain, the
 * pixel is "blocked" — out of line-of-sight.
 *
 * We also record the worst Fresnel-Kirchhoff knife-edge parameter `v` along
 * each ray so the coverage pass can compute diffraction loss per pixel rather
 * than treating blocked/unblocked as binary.
 *
 * Algorithm is a "reverse R2" variant: for each target pixel we re-walk the
 * origin→target ray. Slightly redundant vs. a sweeping radial scan, but
 * trivially parallelizable and numerically robust for our ≤ 256×256 grids.
 */
import type { DEM } from "./terrainDEM";
import { sampleDEMAt } from "./terrainDEM";

const R_EARTH_KM = 6371;
const K_REFRACTION = 4 / 3;
const SPEED_OF_LIGHT_MPS = 299_792_458;

/**
 * Great-circle distance (km) between two lng/lat points.
 * Duplicated from losAnalysis.ts so this module is dependency-free
 * and safe to import from a worker.
 */
function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/** Earth bulge (m) at distance d1 from A toward B (d2 = D − d1). */
function earthBulgeM(d1Km: number, d2Km: number): number {
  return (d1Km * d2Km * 1000) / (2 * K_REFRACTION * R_EARTH_KM);
}

/** Fresnel-Kirchhoff parameter `v` for obstruction of height `h` (m) above chord. */
function knifeEdgeV(hMeters: number, d1Km: number, d2Km: number, freqMhz: number): number {
  const lambda = SPEED_OF_LIGHT_MPS / (freqMhz * 1e6);
  const d1m = d1Km * 1000;
  const d2m = d2Km * 1000;
  if (d1m <= 0 || d2m <= 0) return -Infinity;
  return hMeters * Math.sqrt((2 * (d1m + d2m)) / (lambda * d1m * d2m));
}

export interface ViewshedInput {
  dem: DEM;
  /** Origin position (lng, lat). */
  origin: [number, number];
  /** Origin MSL height (m). Already resolved (altitude or terrain+antenna). */
  originHeightM: number;
  /** Receiver antenna height above pixel ground (m). Default 2. */
  targetAntennaHeightM?: number;
  /** Frequency in GHz. Default 0.915. */
  freqGHz?: number;
  /** Samples along each ray. Default 48. */
  raySamples?: number;
}

export interface Viewshed {
  width: number;
  height: number;
  /** Worst knife-edge `v` along the ray to each pixel. NaN if pixel unreachable. */
  worstV: Float32Array;
  /** Distance (km) from origin to each pixel. */
  distanceKm: Float32Array;
  /** True if any terrain sample along the ray was above the LoS chord (blocked). */
  blocked: Uint8Array;
}

/**
 * Compute a per-pixel viewshed over `dem` from `origin`.
 * For each pixel, tracks:
 *   - distance from origin
 *   - whether the straight LoS is terrain-blocked
 *   - worst Fresnel-Kirchhoff `v` for knife-edge diffraction loss
 */
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

      // Degenerate case: target is the origin pixel. Mark clear.
      if (totalKm < 1e-6) {
        worstV[i] = -Infinity;
        blocked[i] = 0;
        continue;
      }

      const targetHeight = targetGround + targetAntennaHeightM;

      // Step along the ray from origin to target. Skip endpoints.
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
        const h = effectiveGround - chord; // positive = obstructing

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

/** ITU-R P.526 single knife-edge diffraction loss for Fresnel `v`. */
export function knifeEdgeLossDb(v: number): number {
  if (!Number.isFinite(v) || v < -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}
