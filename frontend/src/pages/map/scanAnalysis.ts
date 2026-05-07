/**
 * Best-neighbors scan: LoS + link budget from origin to each target, classified and ranked.
 * Stays on the main thread with 60 samples/ray.
 */
import { NLCD_DEFAULT_CLASS_ID } from "./clutterClasses";
import { computePathClutterLoss, makeClutterScratch } from "./clutterPath";
import { pathLossDb } from "./coverageAnalysis";
import { computeP2PLossFast, type ItmContext,ModeOfVariability } from "./itm";
import { type ClutterRaster, sampleClutterClassAt } from "./landcoverTiles";
import { analyzeLineOfSight, haversineKm, type TerrainSampler } from "./losAnalysis";

/** Optional ITM config; when provided, ITM replaces FSPL+knife-edge for path loss. */
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
  rssiDbm: number;
  /** Margin above sensitivity+fade (dB); negative = unreachable. */
  marginDb: number;
  /** Worst knife-edge diffraction loss (dB). */
  diffractionLossDb: number;
  /** Straight-LoS terrain-blocked (diffraction may still recover). */
  losBlocked: boolean;
  fresnelIntruded: boolean;
}

export interface ScanInput {
  origin: [number, number];
  originAltitudeM?: number | null;
  originShortname?: string;
  targets: ScanTarget[];
  queryTerrainM: TerrainSampler;
  /** LoS samples per ray; default 60. */
  raySamples?: number;
  freqGHz?: number;
  txDbm?: number;
  /** TX-side antenna gain (dBi). */
  txAntennaDbi?: number;
  /** RX-side antenna gain (dBi); defaults to txAntennaDbi for symmetric links. */
  rxAntennaDbi?: number;
  rxSensitivityDbm?: number;
  fadeMarginDb?: number;
  cableLossDb?: number;
  /** Optional class-ID raster aligned to bbox; absent → default class everywhere. */
  clutterRaster?: ClutterRaster | null;
  /** Scalar on the ITU clutter model output. 1.0 = calibrated baseline. */
  clutterAggression?: number;
  /** Skip targets farther than this km. Default Infinity. */
  maxDistanceKm?: number;
  /** Use ITM for path loss; LoS/Fresnel classification still comes from analyzeLineOfSight. */
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

/** Sort key: reachable by margin desc, blocked last by nearest-first. */
export function scanSortKey(r: ScanResult): number {
  if (r.cls === "blocked") return -1000 - 1 / Math.max(0.1, r.distanceKm);
  return r.marginDb - r.distanceKm * 0.01;
}

/** Synchronous scan. Caller must chunk if jank becomes an issue. */
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
    txAntennaDbi = 3,
    rxAntennaDbi = txAntennaDbi ?? 3,
    rxSensitivityDbm = -130,
    fadeMarginDb = 15,
    cableLossDb = 0.5,
    clutterRaster = null,
    clutterAggression = 1.0,
    maxDistanceKm = Infinity,
  } = input;

  const freqMhz = freqGHz * 1000;
  const results: ScanResult[] = [];
  let clearCount = 0;
  let fresnelCount = 0;
  let diffractedCount = 0;
  let blockedCount = 0;

  const clutterScratch = makeClutterScratch();

  for (const t of targets) {
    const d = haversineKm(origin, t.position);
    if (d > maxDistanceKm) continue;
    if (d < 0.01) continue;

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

    // LoS points only carry distanceKm; lerp lng/lat ourselves to sample classes.
    const profileM = new Float64Array(los.points.map((p) => p.ground));
    const profileClasses = new Uint8Array(profileM.length);
    if (clutterRaster) {
      for (let s = 0; s < profileM.length; s++) {
        const tFrac = profileM.length > 1 ? s / (profileM.length - 1) : 0;
        const sLng = origin[0] + (t.position[0] - origin[0]) * tFrac;
        const sLat = origin[1] + (t.position[1] - origin[1]) * tFrac;
        profileClasses[s] = sampleClutterClassAt(clutterRaster, sLng, sLat);
      }
    } else {
      profileClasses.fill(NLCD_DEFAULT_CLASS_ID);
    }

    const spacingM = profileM.length > 1 ? (d * 1000) / (profileM.length - 1) : 0;
    const txAGLm = los.points.length > 0
      ? Math.max(0.5, los.fromHeightM - los.points[0].ground)
      : 2;
    const rxAGLm = los.points.length > 0
      ? Math.max(0.5, los.toHeightM - los.points[los.points.length - 1].ground)
      : 2;
    const clutterLossDb = computePathClutterLoss(
      profileM,
      profileClasses,
      profileM.length,
      spacingM,
      txAGLm,
      rxAGLm,
      freqMhz,
      clutterAggression,
      clutterScratch,
    );

    // Path loss: ITM (terrain-aware) when available, else FSPL + knife-edge
    let totalLossDb: number;
    if (input.itm && los.points.length >= 2) {
      const itmLoss = computeP2PLossFast(input.itm.context, {
        txHeightM: txAGLm,
        rxHeightM: rxAGLm,
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
      // Fallback to FSPL if ITM returns garbage
      totalLossDb =
        Number.isFinite(itmLoss) && itmLoss > 0
          ? itmLoss + clutterLossDb + cableLossDb
          : pathLossDb(d, freqMhz) + los.diffractionLossDb + clutterLossDb + cableLossDb;
    } else {
      totalLossDb = pathLossDb(d, freqMhz) + los.diffractionLossDb + clutterLossDb + cableLossDb;
    }
    const rssiDbm = txDbm + txAntennaDbi + rxAntennaDbi - totalLossDb;
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

/** FeatureCollection of lines from origin → each target. */
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
    id: i, // stable id for setFeatureState
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
