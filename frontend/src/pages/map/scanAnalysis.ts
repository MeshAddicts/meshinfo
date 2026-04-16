/**
 * Best-neighbors scan: given an origin node, compute line-of-sight + link
 * budget to every other node within a bounding box (typically the current
 * viewport), then classify and rank them.
 *
 * The scan reuses `analyzeLineOfSight` under the hood. We keep sample counts
 * modest (60/ray) so a batch of ~50 nodes completes in well under a second
 * on the main thread.
 */
import { analyzeLineOfSight, haversineKm, type TerrainSampler } from "./losAnalysis";
import { pathLossDb } from "./coverageAnalysis";
import { computeP2PLossFast, ModeOfVariability, type ItmContext } from "./itm";

/**
 * Pre-configured ITM context + climate/ground parameters. When provided
 * to `runScan`, terrain-aware Longley-Rice replaces the old free-space +
 * knife-edge path loss, dramatically improving accuracy in mountainous
 * or hilly terrain. Without it, scan falls back to the legacy FSPL model
 * for backward compatibility.
 */
export interface ScanItmConfig {
  context: ItmContext;
  climate: number;
  surfaceRefractivityN: number;
  polarization: number;
  groundDielectric: number;
  groundConductivity: number;
  timePct?: number;
  locationPct?: number;
  situationPct?: number;
}

export type ScanClass = "clear" | "fresnel" | "diffracted" | "blocked";

export interface ScanTarget {
  id: string;
  shortname?: string;
  position: [number, number];
  altitudeM?: number | null;
}

export interface ScanResult {
  id: string;
  shortname?: string;
  position: [number, number];
  distanceKm: number;
  cls: ScanClass;
  /** Predicted RSSI (dBm). */
  rssiDbm: number;
  /** Margin above sensitivity+fade (dB). Negative = un-reachable. */
  marginDb: number;
  /** Worst knife-edge diffraction loss (dB) on this path. */
  diffractionLossDb: number;
  /** Whether the straight LoS was terrain-blocked (even if diffraction recovers it). */
  losBlocked: boolean;
  /** Whether the first Fresnel zone was intruded. */
  fresnelIntruded: boolean;
}

export interface ScanInput {
  origin: [number, number];
  originAltitudeM?: number | null;
  originShortname?: string;
  targets: ScanTarget[];
  /** Sampler — `(lng, lat) => meters` or `null`. */
  queryTerrainM: TerrainSampler;
  /** LoS samples per ray. Default 60. */
  raySamples?: number;
  freqGHz?: number;
  txDbm?: number;
  antennaDbi?: number;
  rxSensitivityDbm?: number;
  fadeMarginDb?: number;
  cableLossDb?: number;
  /**
   * If set, targets farther than this from the origin are skipped before the
   * (expensive) LoS call. Speeds up big scans. Default Infinity.
   */
  maxDistanceKm?: number;
  /**
   * If provided, use Longley-Rice (ITM) for terrain-aware path loss
   * instead of free-space + knife-edge. Geometric LoS/Fresnel
   * classification is kept from `analyzeLineOfSight`; only the loss
   * calculation changes.
   */
  itm?: ScanItmConfig;
}

export interface ScanSummary {
  origin: [number, number];
  originShortname?: string;
  results: ScanResult[];
  clearCount: number;
  fresnelCount: number;
  diffractedCount: number;
  blockedCount: number;
}

/**
 * Quality score for sorting. Reachable first, by margin. Blocked last, by
 * shortest distance (nearest "almost made it" first).
 */
export function scanSortKey(r: ScanResult): number {
  if (r.cls === "blocked") return -1000 - 1 / Math.max(0.1, r.distanceKm);
  // Reachable: higher margin = better; tiebreak by distance (closer wins).
  return r.marginDb - r.distanceKm * 0.01;
}

/**
 * Run a scan synchronously. For MVP we stay on the main thread with reduced
 * sample counts; chunking is the caller's job if jank becomes an issue.
 */
export function runScan(input: ScanInput): ScanSummary {
  const {
    origin,
    originAltitudeM,
    originShortname,
    targets,
    queryTerrainM,
    raySamples = 60,
    freqGHz = 0.915,
    txDbm = 22,
    antennaDbi = 3,
    rxSensitivityDbm = -130,
    fadeMarginDb = 15,
    cableLossDb = 0.5,
    maxDistanceKm = Infinity,
  } = input;

  const freqMhz = freqGHz * 1000;
  const results: ScanResult[] = [];
  let clearCount = 0;
  let fresnelCount = 0;
  let diffractedCount = 0;
  let blockedCount = 0;

  for (const t of targets) {
    const d = haversineKm(origin, t.position);
    if (d > maxDistanceKm) continue;
    if (d < 0.01) continue; // origin itself

    const los = analyzeLineOfSight({
      from: origin,
      to: t.position,
      fromAltitudeM: originAltitudeM ?? null,
      toAltitudeM: t.altitudeM ?? null,
      antennaHeightM: 2,
      freqGHz,
      samples: raySamples,
      queryTerrainM,
    });

    // Path loss: use ITM (terrain-aware) when available, else FSPL + knife-edge.
    let totalLossDb: number;
    if (input.itm && los.points.length >= 2) {
      const profileM = new Float64Array(los.points.map((p) => p.ground));
      const spacingM = (d * 1000) / (profileM.length - 1);
      const itmLoss = computeP2PLossFast(input.itm.context, {
        txHeightM: Math.max(0.5, los.fromHeightM - los.points[0].ground),
        rxHeightM: Math.max(0.5, los.toHeightM - los.points[los.points.length - 1].ground),
        profileM,
        pointSpacingM: spacingM,
        climate: input.itm.climate,
        surfaceRefractivityN: input.itm.surfaceRefractivityN,
        freqMhz: freqGHz * 1000,
        polarization: input.itm.polarization,
        groundDielectric: input.itm.groundDielectric,
        groundConductivity: input.itm.groundConductivity,
        mdvar: ModeOfVariability.SingleMessage,
        time: input.itm.timePct ?? 50,
        location: input.itm.locationPct ?? 50,
        situation: input.itm.situationPct ?? 50,
      });
      // Fallback to FSPL if ITM returns garbage (shouldn't happen for
      // valid profiles, but safety).
      totalLossDb =
        Number.isFinite(itmLoss) && itmLoss > 0
          ? itmLoss + cableLossDb
          : pathLossDb(d, freqMhz) + los.diffractionLossDb + cableLossDb;
    } else {
      totalLossDb = pathLossDb(d, freqMhz) + los.diffractionLossDb + cableLossDb;
    }
    const rssiDbm = txDbm + 2 * antennaDbi - totalLossDb;
    const marginDb = rssiDbm - rxSensitivityDbm - fadeMarginDb;

    let cls: ScanClass;
    if (marginDb < 0) {
      cls = "blocked";
      blockedCount++;
    } else if (!los.losClear) {
      cls = "diffracted";
      diffractedCount++;
    } else if (!los.fresnelClear) {
      cls = "fresnel";
      fresnelCount++;
    } else {
      cls = "clear";
      clearCount++;
    }

    results.push({
      id: t.id,
      shortname: t.shortname,
      position: t.position,
      distanceKm: d,
      cls,
      rssiDbm,
      marginDb,
      diffractionLossDb: los.diffractionLossDb,
      losBlocked: !los.losClear,
      fresnelIntruded: !los.fresnelClear,
    });
  }

  // Sort descending by score (best reachable first; blocked grouped at end).
  results.sort((a, b) => scanSortKey(b) - scanSortKey(a));

  return {
    origin,
    originShortname,
    results,
    clearCount,
    fresnelCount,
    diffractedCount,
    blockedCount,
  };
}

/** Build a GeoJSON FeatureCollection of lines from origin → each target. */
export function scanToGeoJSON(
  summary: ScanSummary,
): GeoJSON.FeatureCollection<GeoJSON.LineString, {
  cls: ScanClass;
  marginDb: number;
  distanceKm: number;
  targetId: string;
}> {
  const features = summary.results.map((r, i) => ({
    type: "Feature" as const,
    id: i, // stable integer id so Mapbox setFeatureState can target a line
    geometry: {
      type: "LineString" as const,
      coordinates: [summary.origin, r.position],
    },
    properties: {
      cls: r.cls,
      marginDb: r.marginDb,
      distanceKm: r.distanceKm,
      targetId: r.id,
    },
  }));
  return { type: "FeatureCollection", features };
}
