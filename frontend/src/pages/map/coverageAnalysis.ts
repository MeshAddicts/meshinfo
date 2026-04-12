/**
 * Coverage prediction — compute LoS from an origin point to a grid of sample points.
 * Paints the map with color-coded reachability.
 */
import { analyzeLineOfSight, haversineKm, type TerrainSampler } from "./losAnalysis";

const R_EARTH_KM = 6371;

/**
 * Propagation environment — affects excess path loss beyond free space.
 * Exponents are typical for log-distance path loss models.
 */
export interface Environment {
  id: string;
  label: string;
  pathLossExponent: number; // n in PL = 91.67 + 10·n·log10(d_km)
  description: string;
}
export const ENVIRONMENTS: Environment[] = [
  { id: "open",     label: "Open / Rural",        pathLossExponent: 2.0, description: "Line-of-sight, no obstacles" },
  { id: "mixed",    label: "Mixed / Light terrain", pathLossExponent: 2.5, description: "Some trees, rolling hills" },
  { id: "suburban", label: "Suburban",            pathLossExponent: 3.0, description: "Scattered buildings, moderate clutter" },
  { id: "urban",    label: "Urban / Dense forest", pathLossExponent: 3.5, description: "Heavy clutter, thick canopy" },
];

/**
 * Meshtastic modem presets. Sensitivity values match Meshtastic's documented
 * theoretical figures for SX126x chipsets at the given SF/BW combinations.
 * (See: meshtastic.org/docs/overview/radio-settings/modem-presets/)
 *
 * Real-world sensitivity is typically 1–3 dB worse than theoretical due to
 * PCB noise, temperature, and antenna system losses. The 15 dB fade margin
 * in the link budget already accounts for some of this.
 */
export interface ModemPreset {
  id: string;
  label: string;
  sensitivityDbm: number;
  sf: number;
  bwKhz: number;
  isCustom?: boolean;
}
export const MESHTASTIC_PRESETS: ModemPreset[] = [
  { id: "MediumFast", label: "MediumFast (SF9, 250 kHz)",  sensitivityDbm: -127, sf: 9,  bwKhz: 250 },
  { id: "LongFast",   label: "LongFast (SF11, 250 kHz)",   sensitivityDbm: -133, sf: 11, bwKhz: 250 },
  { id: "LongSlow",   label: "LongSlow (SF12, 125 kHz)",   sensitivityDbm: -137, sf: 12, bwKhz: 125 },
  { id: "Custom",     label: "Custom",                      sensitivityDbm: -133, sf: 11, bwKhz: 250, isCustom: true },
];

/**
 * Path loss at distance `dKm` for a given frequency and environment exponent.
 * Uses free-space as the d=1km reference, plus excess clutter loss that scales
 * with the environment exponent. Clamped to d≥10m to avoid weirdness at zero.
 */
export function pathLossDb(dKm: number, freqMhz: number, envExponent: number): number {
  const d = Math.max(0.01, dKm);
  const freeSpace = 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(d);
  const excess = (envExponent - 2) * 10 * Math.log10(Math.max(1, d));
  return freeSpace + excess;
}

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
  /** Environment path-loss exponent (2.0 = free space). */
  envExponent?: number;
}): number {
  const {
    antennaDbi,
    txDbm = 22,
    rxSensitivityDbm = -133, // LongFast (Meshtastic docs theoretical)
    fadeMarginDb = 15,
    cableLossDb = 2,
    freqMhz = 915,
    envExponent = 2.0,
  } = opts;

  const budgetDb = txDbm + 2 * antennaDbi - rxSensitivityDbm - fadeMarginDb - cableLossDb;
  // Solve budgetDb = pathLossDb(d) = 91.67 + 10·n·log10(d)  (for d ≥ 1km)
  // → d = 10^((budget - 91.67) / (10·n))
  const plConstant = 32.45 + 20 * Math.log10(freqMhz);
  const dKm = Math.pow(10, (budgetDb - plConstant) / (10 * envExponent));
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
  /** Status: clear LoS, Fresnel intrusion, diffracted (blocked but recoverable), or blocked. */
  status: "clear" | "fresnel" | "diffracted" | "blocked";
  /** Fraction of Fresnel zone obstructed (0 = none, 1 = fully blocked). */
  fresnelIntrusion: number;
  /** Knife-edge diffraction loss (dB) from worst obstacle on the path. */
  diffractionLossDb: number;
  /** Total path loss (dB) = environment path loss + diffraction. */
  totalLossDb: number;
  /** Predicted RSSI at receiver (dBm). */
  rssiDbm: number;
  /** Margin above receiver sensitivity (dB). Negative means below threshold. */
  marginDb: number;
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
  envExponent: number;
  rxSensitivityDbm: number;
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
  /** Environment path-loss exponent. Default 2.0 (free space). */
  envExponent?: number;
  /** Receiver sensitivity in dBm. Default −134 (LongFast SF11). */
  rxSensitivityDbm?: number;
  /** Fade margin in dB. Default 15. */
  fadeMarginDb?: number;
  /** Cable/feedline loss in dB. Default 2. */
  cableLossDb?: number;
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
    envExponent = 2.0,
    rxSensitivityDbm = -133,
    fadeMarginDb = 15,
    cableLossDb = 2,
    queryTerrainM,
  } = input;

  const lbMaxKm = linkBudgetMaxKm({
    antennaDbi,
    txDbm,
    rxSensitivityDbm,
    fadeMarginDb,
    cableLossDb,
    freqMhz: freqGHz * 1000,
    envExponent,
  });

  const freqMhz = freqGHz * 1000;

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

      // Compute predicted RSSI and margin with environment + diffraction.
      const pl = pathLossDb(actualDist, freqMhz, envExponent);
      const totalLossDb = pl + losResult.diffractionLossDb + cableLossDb;
      const rssiDbm = txDbm + 2 * antennaDbi - totalLossDb;
      const marginDb = rssiDbm - rxSensitivityDbm - fadeMarginDb;

      // Status classification:
      // - clear:      full LoS + fresnel clear + link budget OK
      // - fresnel:    LoS clear but fresnel intruded, link budget OK
      // - diffracted: LoS blocked but diffraction loss small enough that link budget still holds
      // - blocked:    link budget fails (RSSI below sensitivity + margin)
      let status: "clear" | "fresnel" | "diffracted" | "blocked";
      if (marginDb < 0) {
        status = "blocked";
        blockedCount++;
      } else if (!losResult.losClear) {
        status = "diffracted";
        fresnelCount++; // count as non-green for stats
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
        diffractionLossDb: losResult.diffractionLossDb,
        totalLossDb,
        rssiDbm,
        marginDb,
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
    envExponent,
    rxSensitivityDbm,
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

  // Only paint reachable cells (margin ≥ 0). Blocked cells show terrain as-is.
  const features = result.cells.filter((c) => c.marginDb >= 0).map((c) => {
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
        diffractionLossDb: c.diffractionLossDb,
        rssiDbm: c.rssiDbm,
        marginDb: c.marginDb,
      },
      geometry: {
        type: "Polygon" as const,
        coordinates: [coords],
      },
    };
  });

  return { type: "FeatureCollection" as const, features };
}
