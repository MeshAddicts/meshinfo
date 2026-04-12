/**
 * Coverage prediction — compute LoS from an origin point to a grid of sample points.
 * Paints the map with color-coded reachability.
 */
import { analyzeLineOfSight, haversineKm, type TerrainSampler } from "./losAnalysis";

const R_EARTH_KM = 6371;

/**
 * Compute the theoretical max range (km) for a symmetric link using free-space
 * path loss at the given frequency. Reasonable for clear-LoS planning.
 *
 * Budget = TX + G_tx + G_rx − sensitivity − margin − cable_loss
 * Free-space path loss (915 MHz): PL = 32.45 + 20·log10(f_MHz) + 20·log10(d_km)
 *                               = 91.67 + 20·log10(d_km)  at 915 MHz
 * Solving for d: d_km = 10^((budget − 91.67) / 20)
 */
export function linkBudgetMaxKm(opts: {
  antennaDbi: number;
  txDbm?: number;
  rxSensitivityDbm?: number;
  fadeMarginDb?: number;
  cableLossDb?: number;
  freqMhz?: number;
}): number {
  const {
    antennaDbi,
    txDbm = 27,              // Meshtastic default (500 mW)
    rxSensitivityDbm = -124, // LoRa LongFast (SF11) typical
    fadeMarginDb = 15,       // conservative margin for real-world
    cableLossDb = 2,         // typical coax loss
    freqMhz = 915,           // US Meshtastic
  } = opts;

  const budgetDb = txDbm + 2 * antennaDbi - rxSensitivityDbm - fadeMarginDb - cableLossDb;
  const plConstant = 32.45 + 20 * Math.log10(freqMhz); // 91.67 at 915 MHz
  const dKm = Math.pow(10, (budgetDb - plConstant) / 20);
  return dKm;
}

/** Common Meshtastic antenna gains. */
export const COMMON_ANTENNAS: { dbi: number; label: string }[] = [
  { dbi: 3, label: "3 dBi (stock/rubber duck)" },
  { dbi: 5.8, label: "5.8 dBi (mid omni)" },
  { dbi: 6, label: "6 dBi (omni)" },
  { dbi: 8, label: "8 dBi (high-gain omni)" },
  { dbi: 10, label: "10 dBi (tall omni)" },
  { dbi: 12, label: "12 dBi (yagi/panel)" },
];

/**
 * Common Meshtastic hardware with typical max TX power (dBm).
 * Values are realistic defaults — most boards ship at these figures,
 * though actual output can vary by firmware settings and region.
 */
export const COMMON_HARDWARE: { label: string; txDbm: number; isCustom?: boolean }[] = [
  { label: "Heltec V3", txDbm: 22 },
  { label: "LILYGO T-Beam", txDbm: 22 },
  { label: "LILYGO T-Echo", txDbm: 22 },
  { label: "LILYGO T-Deck", txDbm: 22 },
  { label: "RAK WisBlock (RAK4631)", txDbm: 22 },
  { label: "Station G2", txDbm: 22 },
  { label: "Seeed T1000-E", txDbm: 22 },
  { label: "Heltec LoRa32 v2 (SX1276)", txDbm: 20 },
  { label: "nRF52 (generic)", txDbm: 20 },
  { label: "E22-900M30S (high-power)", txDbm: 30 },
  { label: "Custom", txDbm: 22, isCustom: true },
];

export interface CoverageCell {
  /** Center of this sample cell (lng, lat). */
  position: [number, number];
  /** Distance from origin in km. */
  distanceKm: number;
  /** Bearing from origin in degrees (0 = N). */
  bearingDeg: number;
  /** Status: clear LoS, Fresnel intrusion, or blocked. */
  status: "clear" | "fresnel" | "blocked";
  /** Fraction of Fresnel zone obstructed (0 = none, 1 = fully blocked). */
  fresnelIntrusion: number;
  /** Which ring (0 = closest to origin). */
  ring: number;
  /** Which bearing slot. */
  bearingIndex: number;
}

export interface CoverageResult {
  origin: [number, number];
  originHeightM: number;
  originIsFallback: boolean;
  radiusKm: number;
  rings: number;
  samplesPerRing: number;
  cells: CoverageCell[];
  clearCount: number;
  fresnelCount: number;
  blockedCount: number;
  frequencyGHz: number;
  /** Antenna dBi used for this analysis. */
  antennaDbi: number;
  /** TX power (dBm) used for this analysis. */
  txDbm: number;
  /** Theoretical max range (km) from the link budget with this dBi. */
  linkBudgetMaxKm: number;
}

export interface CoverageInput {
  origin: [number, number];
  /** MSL altitude of origin (meters). Falls back to terrain + antennaHeightM. */
  originAltitudeM?: number | null;
  antennaHeightM?: number;
  /** Frequency in GHz. Default 0.915 (US LoRa). */
  freqGHz?: number;
  /** Max radius from origin (km). Default 10. */
  radiusKm?: number;
  /** Number of rings (concentric circles of samples). Default 8. */
  rings?: number;
  /** Number of samples per ring. Default 24 (every 15°). */
  samplesPerRing?: number;
  /** Samples along each LoS ray when checking obstructions. Default 40. */
  losSamples?: number;
  /** Assumed target antenna height for receiver (matches origin antenna). Default 2m. */
  targetAntennaHeightM?: number;
  /** Antenna gain in dBi (symmetric — same at TX and RX). Affects link budget range. */
  antennaDbi?: number;
  /** TX power in dBm. Default 22 (typical Meshtastic board). */
  txDbm?: number;
  /** Terrain sampler — required. */
  queryTerrainM: TerrainSampler;
}

/** Destination point given origin, bearing (deg), and distance (km). */
function destinationPoint(
  origin: [number, number],
  bearingDeg: number,
  distanceKm: number,
): [number, number] {
  const brng = (bearingDeg * Math.PI) / 180;
  const d = distanceKm / R_EARTH_KM;
  const lat1 = (origin[1] * Math.PI) / 180;
  const lon1 = (origin[0] * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

/**
 * Compute a coverage prediction from an origin point.
 * Generates a polar grid of sample points and checks LoS to each.
 */
export function computeCoverage(input: CoverageInput): CoverageResult {
  const {
    origin,
    originAltitudeM,
    antennaHeightM = 2,
    targetAntennaHeightM,
    freqGHz = 0.915,
    radiusKm = 10,
    rings = 8,
    samplesPerRing = 24,
    losSamples = 40,
    antennaDbi = 3,
    txDbm = 22,
    queryTerrainM,
  } = input;

  const lbMaxKm = linkBudgetMaxKm({
    antennaDbi,
    txDbm,
    freqMhz: freqGHz * 1000,
  });

  const originGround = queryTerrainM(origin[0], origin[1]) ?? 0;
  const originIsFallback =
    originAltitudeM == null ||
    !Number.isFinite(originAltitudeM) ||
    (originAltitudeM as number) < originGround;
  const originHeightM = originIsFallback ? originGround + antennaHeightM : (originAltitudeM as number);

  const cells: CoverageCell[] = [];
  let clearCount = 0;
  let fresnelCount = 0;
  let blockedCount = 0;

  // Concentric rings, each with N samples around the bearing
  for (let r = 1; r <= rings; r++) {
    const ringDist = (radiusKm * r) / rings;
    for (let s = 0; s < samplesPerRing; s++) {
      const bearing = (360 * s) / samplesPerRing;
      const target = destinationPoint(origin, bearing, ringDist);
      const actualDist = haversineKm(origin, target);

      const losResult = analyzeLineOfSight({
        from: origin,
        to: target,
        fromAltitudeM: originHeightM,
        toAltitudeM: null,
        antennaHeightM: targetAntennaHeightM ?? antennaHeightM,
        freqGHz,
        samples: losSamples,
        queryTerrainM,
      });

      let status: "clear" | "fresnel" | "blocked";
      // If beyond link-budget range, mark as blocked regardless of LoS
      if (actualDist > lbMaxKm) {
        status = "blocked";
        blockedCount++;
      } else if (!losResult.losClear) {
        status = "blocked";
        blockedCount++;
      } else if (!losResult.fresnelClear) {
        status = "fresnel";
        fresnelCount++;
      } else {
        status = "clear";
        clearCount++;
      }

      cells.push({
        position: target,
        distanceKm: actualDist,
        bearingDeg: bearing,
        status,
        fresnelIntrusion: losResult.worstFresnelIntrusion,
        ring: r,
        bearingIndex: s,
      });
    }
  }

  return {
    origin,
    originHeightM,
    originIsFallback,
    radiusKm,
    rings,
    samplesPerRing,
    cells,
    clearCount,
    fresnelCount,
    blockedCount,
    frequencyGHz: freqGHz,
    antennaDbi,
    txDbm,
    linkBudgetMaxKm: lbMaxKm,
  };
}

/**
 * Export each cell as a pie-sector polygon (annulus wedge) so the coverage
 * area paints the terrain in a continuous splatter instead of dots.
 *
 * Geometry: each cell covers
 *   bearing ∈ [bearing - halfSlice, bearing + halfSlice]
 *   distance ∈ [innerRadius, outerRadius]
 * Innermost ring uses a full pie wedge (no inner arc) so the center is filled.
 */
export function coverageToGeoJSON(result: CoverageResult) {
  const { origin, rings, samplesPerRing, radiusKm } = result;
  const halfSliceDeg = 180 / samplesPerRing; // each wedge spans 360/samples degrees, half on each side
  const ringStepKm = radiusKm / rings;
  const arcPoints = 5; // number of intermediate points along each arc for smoothness

  // Only paint reachable cells (clear + fresnel). Blocked cells show terrain as-is.
  const features = result.cells.filter((c) => c.status !== "blocked").map((c) => {
    const outerKm = c.ring * ringStepKm;
    const innerKm = Math.max(0, (c.ring - 1) * ringStepKm);
    const startBearing = c.bearingDeg - halfSliceDeg;
    const endBearing = c.bearingDeg + halfSliceDeg;

    const coords: [number, number][] = [];

    // Outer arc (start → end bearing at outerKm)
    for (let i = 0; i <= arcPoints; i++) {
      const t = i / arcPoints;
      const bearing = startBearing + (endBearing - startBearing) * t;
      coords.push(destinationPoint(origin, bearing, outerKm));
    }

    if (innerKm > 0) {
      // Inner arc (end → start bearing at innerKm)
      for (let i = 0; i <= arcPoints; i++) {
        const t = i / arcPoints;
        const bearing = endBearing - (endBearing - startBearing) * t;
        coords.push(destinationPoint(origin, bearing, innerKm));
      }
    } else {
      // Innermost wedge — close with the origin
      coords.push(origin);
    }

    // Close polygon
    coords.push(coords[0]);

    return {
      type: "Feature" as const,
      properties: {
        status: c.status,
        distanceKm: c.distanceKm,
        bearingDeg: c.bearingDeg,
        fresnelIntrusion: c.fresnelIntrusion,
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [coords],
      },
    };
  });

  return { type: "FeatureCollection" as const, features };
}
