/**
 * Line-of-Sight and Fresnel zone analysis for LoRa/RF link planning.
 *
 * References:
 * - Earth bulge with k=4/3 atmospheric refraction (standard RF planning convention)
 * - First Fresnel zone: F₁ = 17.32 × √(d₁·d₂ / (f·d)) meters
 * - 60% Fresnel clearance is the typical "usable link" threshold
 */

const R_EARTH_KM = 6371;
const K_REFRACTION = 4 / 3; // 4/3 earth model for radio LoS
const FRESNEL_CLEARANCE_THRESHOLD = 0.6; // 60% = typical usable threshold
const SPEED_OF_LIGHT_MPS = 299_792_458;

/**
 * ITU-R P.526 single knife-edge diffraction loss approximation.
 * Given Fresnel-Kirchhoff parameter v, returns loss in dB.
 * v < -0.7 → no meaningful loss (clear). v=0 is exactly at the edge (6 dB).
 * v grows with deeper obstruction.
 */
function knifeEdgeLossDb(v: number): number {
  if (v < -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/**
 * Fresnel-Kirchhoff parameter for an obstruction of height `hMeters`
 * above the LoS chord, at `d1Km` from transmitter and `d2Km` from receiver.
 * Negative h = below chord (no obstruction).
 */
function knifeEdgeV(hMeters: number, d1Km: number, d2Km: number, freqMhz: number): number {
  const lambda = SPEED_OF_LIGHT_MPS / (freqMhz * 1e6); // wavelength in meters
  const d1m = d1Km * 1000;
  const d2m = d2Km * 1000;
  if (d1m <= 0 || d2m <= 0) return -Infinity;
  return hMeters * Math.sqrt((2 * (d1m + d2m)) / (lambda * d1m * d2m));
}

/** Terrain sampler — returns elevation in meters at a lng/lat, or null if unavailable. */
export type TerrainSampler = (lng: number, lat: number) => number | null;

export interface LoSInput {
  from: [number, number]; // [lng, lat]
  to: [number, number]; // [lng, lat]
  /** MSL altitude of transmitter (meters). Falls back to terrain + antennaHeightM. */
  fromAltitudeM?: number | null;
  /** MSL altitude of receiver (meters). Falls back to terrain + antennaHeightM. */
  toAltitudeM?: number | null;
  /** Added to ground when node has no altitude data. Default 2m (rover/handheld). */
  antennaHeightM?: number;
  /** Frequency in GHz. Default 0.915 (US LoRa). */
  freqGHz?: number;
  /** Number of terrain samples along the path. Default 100. */
  samples?: number;
  /** Terrain sampler — required for meaningful analysis. */
  queryTerrainM: TerrainSampler;
}

export interface LoSPoint {
  distanceKm: number;
  /** Terrain elevation at this point (MSL, meters). */
  ground: number;
  /** Straight-line chord height between endpoints at this distance (MSL, meters). */
  chord: number;
  /** Earth bulge (meters) — amount ground protrudes upward relative to the chord. */
  bulge: number;
  /** Effective ground (terrain + bulge) used for obstruction check. */
  effectiveGround: number;
  /** First Fresnel zone radius at this distance (meters). */
  fresnelRadius: number;
  /** How far below the chord the effective ground is (negative = obstruction). */
  clearance: number;
  /** Clearance / Fresnel radius — 1.0 = at edge of zone, < 0.6 = intrusion. */
  clearanceRatio: number;
  /** True if effective ground is above the chord. */
  blocked: boolean;
  /** True if effective ground intrudes into 60% of the Fresnel zone. */
  fresnelIntruded: boolean;
}

export interface LoSResult {
  totalDistanceKm: number;
  /** Final MSL height of "from" endpoint (altitude if known, else terrain + antenna). */
  fromHeightM: number;
  toHeightM: number;
  /** Did the "from" or "to" endpoint rely on an antenna-height fallback? */
  fromIsFallback: boolean;
  toIsFallback: boolean;
  /** No point along the path has terrain above the LoS chord. */
  losClear: boolean;
  /** No point intrudes into 60% of the first Fresnel zone. */
  fresnelClear: boolean;
  /** Worst obstruction: max meters above the chord (0 if clear). */
  worstObstructionM: number;
  /** Distance (km from "from") of the worst obstruction (or worst Fresnel intrusion). */
  worstObstructionDistKm: number;
  /** Worst Fresnel intrusion: how deep into the Fresnel zone (0 = no intrusion, 1 = fully blocked). */
  worstFresnelIntrusion: number;
  /** Worst-case knife-edge diffraction loss (dB) from the single most blocking obstacle. */
  diffractionLossDb: number;
  /** Sampled points along the path. */
  points: LoSPoint[];
  frequencyGHz: number;
  /** Elevation delta between endpoints (meters). */
  elevationDiffM: number;
  /**
   * Longley-Rice (ITM) basic transmission loss in dB. Populated
   * asynchronously by the caller after the geometric analysis returns;
   * absent when the ITM WASM isn't available.
   */
  itmLossDb?: number;
  /** Free-space loss at the same distance/frequency, for reference. */
  itmFreeSpaceDb?: number;
  /** ITM-reported propagation mode (LoS / diffraction / troposcatter). */
  itmMode?: string;
}

/** Great-circle distance (km) between two lng/lat points. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/** Linearly interpolate between two lng/lat points. */
function lerpLngLat(
  from: [number, number],
  to: [number, number],
  t: number,
): [number, number] {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Earth bulge (meters) at distance d1 from A toward B (d2 = D - d1). */
function earthBulgeM(d1Km: number, d2Km: number): number {
  return (d1Km * d2Km * 1000) / (2 * K_REFRACTION * R_EARTH_KM);
}

/** First Fresnel zone radius (meters) at distance d1 from A. */
function fresnelRadiusM(d1Km: number, d2Km: number, freqGHz: number): number {
  const dKm = d1Km + d2Km;
  if (dKm <= 0 || d1Km <= 0 || d2Km <= 0) return 0;
  return 17.32 * Math.sqrt((d1Km * d2Km) / (freqGHz * dKm));
}

/**
 * Compute a full line-of-sight + Fresnel analysis between two nodes.
 */
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
  } = input;

  const totalDistanceKm = haversineKm(from, to);

  // Ground elevation at each endpoint (for altitude fallback)
  const fromGround = queryTerrainM(from[0], from[1]) ?? 0;
  const toGround = queryTerrainM(to[0], to[1]) ?? 0;

  /**
   * Resolve final node height:
   * - If altitude is missing/invalid → use terrain + antenna (fallback)
   * - If altitude is below terrain (bogus GPS data — nodes can't be
   *   underground) → also fall back to terrain + antenna.
   * - If altitude is unreasonably above terrain (> 1 km AGL — almost
   *   certainly a firmware unit bug or GPS glitch rather than a real
   *   balloon/aircraft node) → fall back too, and log a warning so the
   *   node can be investigated. 1 km covers any realistic ground-based
   *   Meshtastic mount (the tallest building on earth is ~828 m, and
   *   regulatory drone altitude limit is 122 m).
   * - Otherwise use the reported altitude.
   */
  const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;
  const resolveHeight = (altitude: number | null | undefined, ground: number, label: string) => {
    const valid = altitude != null && Number.isFinite(altitude);
    if (!valid) {
      return { height: ground + antennaHeightM, isFallback: true };
    }
    const alt = altitude as number;
    if (alt < ground) {
      return { height: ground + antennaHeightM, isFallback: true };
    }
    if (alt > ground + MAX_HEIGHT_ABOVE_TERRAIN_M) {
      console.warn(
        `[losAnalysis] ${label} reports altitude ${alt.toFixed(0)} m at terrain ${ground.toFixed(0)} m ` +
          `(${(alt - ground).toFixed(0)} m above local ground — likely bad data). ` +
          `Falling back to terrain + ${antennaHeightM} m.`,
      );
      return { height: ground + antennaHeightM, isFallback: true };
    }
    return { height: alt, isFallback: false };
  };

  const fromResolved = resolveHeight(fromAltitudeM, fromGround, "from");
  const toResolved = resolveHeight(toAltitudeM, toGround, "to");
  const fromHeightM = fromResolved.height;
  const toHeightM = toResolved.height;
  const fromIsFallback = fromResolved.isFallback;
  const toIsFallback = toResolved.isFallback;

  const points: LoSPoint[] = [];
  let worstObstructionM = 0;
  let worstObstructionDistKm = 0;
  let worstFresnelIntrusion = 0;
  let worstKnifeEdgeV = -Infinity; // most blocking obstacle (highest v)
  let losClear = true;
  let fresnelClear = true;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const distanceKm = totalDistanceKm * t;
    const d2 = totalDistanceKm - distanceKm;

    const [lng, lat] = lerpLngLat(from, to, t);
    const ground = queryTerrainM(lng, lat) ?? 0;

    const chord = fromHeightM + (toHeightM - fromHeightM) * t;
    const bulge = i === 0 || i === samples ? 0 : earthBulgeM(distanceKm, d2);
    const effectiveGround = ground + bulge;
    const fresnelRadius = i === 0 || i === samples ? 0 : fresnelRadiusM(distanceKm, d2, freqGHz);

    const clearance = chord - effectiveGround; // positive = clear
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

    // Knife-edge diffraction: h = effectiveGround − chord (positive = obstructing)
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
