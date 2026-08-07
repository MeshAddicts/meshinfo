/**
 * Line-of-Sight + Fresnel analysis.
 * Earth bulge at k=4/3; First Fresnel F₁ = 17.32·√(d₁·d₂/(f·d)) m; 60% clearance threshold.
 */

import { interpLngLatUnwrapped } from "../lib/geo";

const R_EARTH_KM = 6371;
const K_REFRACTION = 4 / 3;
const FRESNEL_CLEARANCE_THRESHOLD = 0.6;
const SPEED_OF_LIGHT_MPS = 299_792_458;

/** ITU-R P.526 single knife-edge loss (dB) for Fresnel-Kirchhoff v. v<-0.7 clear, v=0 → 6 dB. */
function knifeEdgeLossDb(v: number): number {
  if (v < -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Fresnel-Kirchhoff v for obstruction h (m) above chord. Negative h = below chord (clear). */
function knifeEdgeV(hMeters: number, d1Km: number, d2Km: number, freqMhz: number): number {
  const lambda = SPEED_OF_LIGHT_MPS / (freqMhz * 1e6);
  const d1m = d1Km * 1000;
  const d2m = d2Km * 1000;
  if (d1m <= 0 || d2m <= 0) return -Infinity;
  return hMeters * Math.sqrt((2 * (d1m + d2m)) / (lambda * d1m * d2m));
}

/** Terrain sampler returning elevation (m), or null. */
export type TerrainSampler = (lng: number, lat: number) => number | null;

export interface LoSInput {
  from: [number, number]; // [lng, lat]
  to: [number, number]; // [lng, lat]
  /** TX MSL (m); falls back to terrain + antennaHeightM. */
  fromAltitudeM?: number | null;
  /** RX MSL (m); falls back to terrain + antennaHeightM. */
  toAltitudeM?: number | null;
  /** Shared antenna AGL (m); default 2. Overridden by per-endpoint fields. */
  antennaHeightM?: number;
  fromAntennaHeightM?: number;
  toAntennaHeightM?: number;
  /** GHz; default 0.915 (US LoRa). */
  freqGHz?: number;
  /** Path samples; default 100. */
  samples?: number;
  queryTerrainM: TerrainSampler;
  /** Optional clutter samplers (canopy/building height above ground, m). Display
   *  only — clutter is drawn on the profile, not part of the LOS/Fresnel verdict
   *  (coverage/ITM model it as loss, not hard blockage). */
  queryCanopyM?: TerrainSampler;
  queryBuildingM?: TerrainSampler;
}

export interface LoSPoint {
  distanceKm: number;
  /** Terrain MSL (m). */
  ground: number;
  /** Chord height at distance (MSL, m). */
  chord: number;
  /** Earth bulge (m) — terrain apparent rise vs chord. */
  bulge: number;
  /** terrain + bulge */
  effectiveGround: number;
  /** First Fresnel radius (m). */
  fresnelRadius: number;
  /** Chord − effectiveGround (negative = obstructed). */
  clearance: number;
  /** clearance / fresnelRadius; <0.6 → intrusion. */
  clearanceRatio: number;
  blocked: boolean;
  fresnelIntruded: boolean;
  /** Canopy height above ground (m); 0 = none/unknown. Chart display only. */
  canopyM: number;
  /** Building height above ground (m); 0 = none/unknown. Chart display only. */
  buildingM: number;
}

export interface LoSResult {
  totalDistanceKm: number;
  fromHeightM: number;
  toHeightM: number;
  /** Endpoint fell back to terrain + antenna (no altitude). */
  fromIsFallback: boolean;
  toIsFallback: boolean;
  losClear: boolean;
  fresnelClear: boolean;
  /** Max terrain height above chord (m); 0 if clear. */
  worstObstructionM: number;
  worstObstructionDistKm: number;
  /** Fresnel intrusion 0..1 (1 = fully blocked). */
  worstFresnelIntrusion: number;
  diffractionLossDb: number;
  points: LoSPoint[];
  frequencyGHz: number;
  elevationDiffM: number;
  /** ITM basic transmission loss (dB); async-filled by caller; absent if WASM missing. */
  itmLossDb?: number;
  /** Free-space loss at same d/f for reference. */
  itmFreeSpaceDb?: number;
  /** ITM mode: line_of_sight / diffraction / troposcatter. */
  itmMode?: string;
}

/** Great-circle km. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/** Earth bulge (m) at d1 from A toward B (d2 = D - d1). */
function earthBulgeM(d1Km: number, d2Km: number): number {
  return (d1Km * d2Km * 1000) / (2 * K_REFRACTION * R_EARTH_KM);
}

/** First Fresnel radius (m) at d1 from A. */
function fresnelRadiusM(d1Km: number, d2Km: number, freqGHz: number): number {
  const dKm = d1Km + d2Km;
  if (dKm <= 0 || d1Km <= 0 || d2Km <= 0) return 0;
  return 17.32 * Math.sqrt((d1Km * d2Km) / (freqGHz * dKm));
}

/** Full LoS + Fresnel analysis between two nodes. */
export function analyzeLineOfSight(input: LoSInput): LoSResult {
  const {
    from,
    to,
    fromAltitudeM,
    toAltitudeM,
    antennaHeightM = 2,
    freqGHz = 0.915,
    samples = 100,
    queryTerrainM,
    queryCanopyM,
    queryBuildingM,
  } = input;
  const fromAntH = input.fromAntennaHeightM ?? antennaHeightM;
  const toAntH = input.toAntennaHeightM ?? antennaHeightM;

  const totalDistanceKm = haversineKm(from, to);

  const fromGround = queryTerrainM(from[0], from[1]) ?? 0;
  const toGround = queryTerrainM(to[0], to[1]) ?? 0;

  /** Resolve node height: fall back to terrain+antenna when altitude is missing,
   *  below terrain (bad GPS), or >1 km AGL (firmware unit bug / glitch). */
  const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;
  const resolveHeight = (altitude: number | null | undefined, ground: number, antH: number, label: string) => {
    const valid = altitude != null && Number.isFinite(altitude);
    if (!valid) {
      return { height: ground + antH, isFallback: true };
    }
    const alt = altitude as number;
    if (alt < ground) {
      return { height: ground + antH, isFallback: true };
    }
    if (alt > ground + MAX_HEIGHT_ABOVE_TERRAIN_M) {
      console.warn(
        `[losAnalysis] ${label} reports altitude ${alt.toFixed(0)} m at terrain ${ground.toFixed(0)} m ` +
          `(${(alt - ground).toFixed(0)} m above local ground — likely bad data). ` +
          `Falling back to terrain + ${antH} m.`,
      );
      return { height: ground + antH, isFallback: true };
    }
    return { height: alt, isFallback: false };
  };

  const fromResolved = resolveHeight(fromAltitudeM, fromGround, fromAntH, "from");
  const toResolved = resolveHeight(toAltitudeM, toGround, toAntH, "to");
  const fromHeightM = fromResolved.height;
  const toHeightM = toResolved.height;
  const fromIsFallback = fromResolved.isFallback;
  const toIsFallback = toResolved.isFallback;

  const points: LoSPoint[] = [];
  let worstObstructionM = 0;
  let worstObstructionDistKm = 0;
  let worstFresnelIntrusion = 0;
  let worstKnifeEdgeV = -Infinity;
  let losClear = true;
  let fresnelClear = true;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const distanceKm = totalDistanceKm * t;
    const d2 = totalDistanceKm - distanceKm;

    // Seam-aware interp: keeps antimeridian-crossing paths on the short way,
    // matching the tube layer / hover marker / DEM bbox.
    const [lng, lat] = interpLngLatUnwrapped(from, to, t);
    const ground = queryTerrainM(lng, lat) ?? 0;

    const chord = fromHeightM + (toHeightM - fromHeightM) * t;
    const bulge = i === 0 || i === samples ? 0 : earthBulgeM(distanceKm, d2);
    const effectiveGround = ground + bulge;
    const fresnelRadius = i === 0 || i === samples ? 0 : fresnelRadiusM(distanceKm, d2, freqGHz);

    const clearance = chord - effectiveGround; // + = clear
    const clearanceRatio = fresnelRadius > 0 ? clearance / fresnelRadius : Infinity;

    const blocked = clearance < 0;
    const fresnelIntruded = clearanceRatio < FRESNEL_CLEARANCE_THRESHOLD;

    if (blocked) {
      losClear = false;
      if (-clearance > worstObstructionM) {
        worstObstructionM = -clearance;
        worstObstructionDistKm = distanceKm;
      }
    }

    if (fresnelIntruded) {
      fresnelClear = false;
      const intrusion = Math.max(0, Math.min(1, (FRESNEL_CLEARANCE_THRESHOLD - clearanceRatio) / FRESNEL_CLEARANCE_THRESHOLD));
      if (intrusion > worstFresnelIntrusion) {
        worstFresnelIntrusion = intrusion;
        if (!blocked && worstObstructionM === 0) {
          worstObstructionDistKm = distanceKm;
        }
      }
    }

    // Knife-edge: h = effectiveGround − chord (+ = obstructing)
    if (i > 0 && i < samples && d2 > 0) {
      const h = effectiveGround - chord;
      const v = knifeEdgeV(h, distanceKm, d2, freqGHz * 1000);
      if (v > worstKnifeEdgeV) worstKnifeEdgeV = v;
    }

    points.push({
      distanceKm,
      ground,
      chord,
      bulge,
      effectiveGround,
      fresnelRadius,
      clearance,
      clearanceRatio,
      blocked,
      fresnelIntruded,
      canopyM: Math.max(0, queryCanopyM?.(lng, lat) ?? 0),
      buildingM: Math.max(0, queryBuildingM?.(lng, lat) ?? 0),
    });
  }

  const diffractionLossDb = knifeEdgeLossDb(worstKnifeEdgeV);

  return {
    totalDistanceKm,
    fromHeightM,
    toHeightM,
    fromIsFallback,
    toIsFallback,
    losClear,
    fresnelClear,
    worstObstructionM,
    worstObstructionDistKm,
    worstFresnelIntrusion,
    diffractionLossDb,
    points,
    frequencyGHz: freqGHz,
    elevationDiffM: toHeightM - fromHeightM,
  };
}
