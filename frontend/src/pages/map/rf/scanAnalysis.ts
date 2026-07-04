/**
 * Best-neighbors scan: LoS + link budget from origin to each target, classified and ranked.
 * Runs on the main thread; runScanAsync chunks + yields so a dense mesh doesn't freeze the UI.
 */
import { interpLngLatUnwrapped, unwrapLngTo } from "../lib/geo";
import { type BuildingRaster, sampleBuildingAt } from "../terrain/buildingTiles";
import type { CanopyRaster } from "../terrain/canopyTiles";
import { type ClutterRaster, sampleClutterClassAt } from "../terrain/landcoverTiles";
import { NLCD_DEFAULT_CLASS_ID } from "./clutterClasses";
import { type BuildingPathContext, type CanopyPathContext, computePathClutterLoss, makeClutterScratch } from "./clutterPath";
import { pathLossDb } from "./coverageAnalysis";
import { computeP2PLossFast, type ItmContext,ModeOfVariability } from "./itm";
import { CABLE_LOSS_DB, FADE_MARGIN_DB, FREQ_MHZ } from "./itmEnv";
import { analyzeLineOfSight, haversineKm, type TerrainSampler } from "./losAnalysis";

/** Fallback fixed sample count when no DEM resolution is supplied. */
export const DEFAULT_RAY_SAMPLES = 60;
/** Adaptive-sampling bounds. Max caps per-target ITM cost; the ITM context must
 *  hold MAX_SCAN_PATH_POINTS (= max samples + 1 point + slack) or computeP2PLossFast throws. */
export const MIN_RAY_SAMPLES = 48;
export const MAX_RAY_SAMPLES = 512;
export const MAX_SCAN_PATH_POINTS = MAX_RAY_SAMPLES + 8;

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
  /** Fixed LoS samples per ray when demMppM is absent; default 60. */
  raySamples?: number;
  /** DEM metres/pixel; when set, samples scale per-target to ~native resolution
   *  (clamped MIN_RAY_SAMPLES..MAX_RAY_SAMPLES) so long rays don't alias out ridges. */
  demMppM?: number;
  freqGHz?: number;
  txDbm?: number;
  /** TX-side antenna gain (dBi). */
  txAntennaDbi?: number;
  /** RX-side antenna gain (dBi); defaults to txAntennaDbi for symmetric links. */
  rxAntennaDbi?: number;
  /** RX antenna height AGL (m) at each target; default 2. */
  rxAntennaHeightM?: number;
  rxSensitivityDbm?: number;
  fadeMarginDb?: number;
  cableLossDb?: number;
  /** Optional class-ID raster aligned to bbox; absent → default class everywhere. */
  clutterRaster?: ClutterRaster | null;
  /** Optional canopy-height raster aligned to bbox; absent → class-nominal heights. */
  canopyRaster?: CanopyRaster | null;
  /** Optional building-height raster aligned to bbox; absent → bare-earth + class-nominal. */
  buildingRaster?: BuildingRaster | null;
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

/** Sort key: reachable by margin desc; blocked last, nearest-first (nearest blocked
 *  are the actionable ones). Both bands stay disjoint (blocked keys are ≤ -1000). */
export function scanSortKey(r: ScanResult): number {
  if (r.cls === "blocked") return -1000 - r.distanceKm;
  return r.marginDb - r.distanceKm * 0.01;
}

/** Resolved link-budget scalars shared across every target in a run. */
interface ScanBudget {
  freqGHz: number;
  freqMhz: number;
  raySamples: number;
  demMppM?: number;
  txDbm: number;
  txAntennaDbi: number;
  rxAntennaDbi: number;
  rxAntennaHeightM: number;
  rxSensitivityDbm: number;
  fadeMarginDb: number;
  cableLossDb: number;
  clutterAggression: number;
  maxDistanceKm: number;
}

/** Per-target sample count: ~DEM-native resolution, clamped, when demMppM is known. */
function samplesForDistance(distanceKm: number, budget: ScanBudget): number {
  if (!budget.demMppM || !Number.isFinite(budget.demMppM) || budget.demMppM <= 0) {
    return budget.raySamples;
  }
  const n = Math.ceil((distanceKm * 1000) / budget.demMppM);
  return Math.max(MIN_RAY_SAMPLES, Math.min(MAX_RAY_SAMPLES, n));
}

/** Evaluate one target. Returns null for co-located-or-farther-than-cutoff targets. */
function scanOneTarget(
  t: ScanTarget,
  input: ScanInput,
  budget: ScanBudget,
  clutterScratch: ReturnType<typeof makeClutterScratch>,
  canopyCtx: CanopyPathContext | null,
  buildingCtx: BuildingPathContext | null,
): ScanResult | null {
  const { origin, originAltitudeM, queryTerrainM, clutterRaster, buildingRaster } = input;
  const d = haversineKm(origin, t.position);
  if (d > budget.maxDistanceKm) return null;

  // Co-located node (same rooftop/mast): geometry is degenerate, so synthesize a
  // trivially-clear budget rather than dropping it silently from the results.
  if (d < 0.01) {
    const totalLossDb = pathLossDb(d, budget.freqMhz) + budget.cableLossDb;
    const rssiDbm = budget.txDbm + budget.txAntennaDbi + budget.rxAntennaDbi - totalLossDb;
    const marginDb = rssiDbm - budget.rxSensitivityDbm - budget.fadeMarginDb;
    return {
      id: t.id,
      shortname: t.shortname,
      position: t.position,
      distanceKm: d,
      cls: marginDb < 0 ? "blocked" : "clear",
      rssiDbm,
      marginDb,
      diffractionLossDb: 0,
      losBlocked: false,
      fresnelIntruded: false,
    };
  }

  const samples = samplesForDistance(d, budget);
  const los = analyzeLineOfSight({
    from: origin,
    to: t.position,
    fromAltitudeM: originAltitudeM ?? null,
    toAltitudeM: t.altitudeM ?? null,
    antennaHeightM: budget.rxAntennaHeightM,
    freqGHz: budget.freqGHz,
    samples,
    queryTerrainM,
  });

  // LoS points only carry distanceKm; unwrap lng/lat ourselves (seam-safe, matching
  // the terrain profile) to sample raster lookups. DSM endpoint-skip: see coverageRaster.ts.
  const profileM = new Float64Array(los.points.map((p) => p.ground));
  const profileClasses = new Uint8Array(profileM.length);
  const lastPathIdx = profileM.length - 1;
  for (let s = 0; s < profileM.length; s++) {
    const tFrac = profileM.length > 1 ? s / lastPathIdx : 0;
    const [sLng, sLat] = interpLngLatUnwrapped(origin, t.position, tFrac);
    if (clutterRaster) {
      profileClasses[s] = sampleClutterClassAt(clutterRaster, sLng, sLat);
    } else {
      profileClasses[s] = NLCD_DEFAULT_CLASS_ID;
    }
    if (buildingRaster && s !== 0 && s !== lastPathIdx) {
      const sample = sampleBuildingAt(buildingRaster, sLng, sLat);
      if (sample && sample.heightM > 0) profileM[s] += sample.heightM;
    }
  }

  const spacingM = profileM.length > 1 ? (d * 1000) / (profileM.length - 1) : 0;
  const txAGLm = los.points.length > 0
    ? Math.max(0.5, los.fromHeightM - los.points[0].ground)
    : budget.rxAntennaHeightM;
  const rxAGLm = los.points.length > 0
    ? Math.max(0.5, los.toHeightM - los.points[los.points.length - 1].ground)
    : budget.rxAntennaHeightM;
  if (canopyCtx) {
    canopyCtx.origLng = origin[0];
    canopyCtx.origLat = origin[1];
    canopyCtx.destLng = t.position[0];
    canopyCtx.destLat = t.position[1];
  }
  if (buildingCtx) {
    buildingCtx.origLng = origin[0];
    buildingCtx.origLat = origin[1];
    buildingCtx.destLng = t.position[0];
    buildingCtx.destLat = t.position[1];
  }
  const clutterLossDb = computePathClutterLoss(
    profileM,
    profileClasses,
    profileM.length,
    spacingM,
    txAGLm,
    rxAGLm,
    budget.freqMhz,
    budget.clutterAggression,
    clutterScratch,
    canopyCtx,
    buildingCtx,
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
      freqMhz: budget.freqMhz,
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
        ? itmLoss + clutterLossDb + budget.cableLossDb
        : pathLossDb(d, budget.freqMhz) + los.diffractionLossDb + clutterLossDb + budget.cableLossDb;
  } else {
    totalLossDb = pathLossDb(d, budget.freqMhz) + los.diffractionLossDb + clutterLossDb + budget.cableLossDb;
  }
  const rssiDbm = budget.txDbm + budget.txAntennaDbi + budget.rxAntennaDbi - totalLossDb;
  const marginDb = rssiDbm - budget.rxSensitivityDbm - budget.fadeMarginDb;

  let cls: ScanClass;
  if (marginDb < 0) cls = "blocked";
  else if (!los.losClear) cls = "diffracted";
  else if (!los.fresnelClear) cls = "fresnel";
  else cls = "clear";

  return {
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
  };
}

function resolveBudget(input: ScanInput): ScanBudget {
  const freqGHz = input.freqGHz ?? FREQ_MHZ / 1000;
  return {
    freqGHz,
    freqMhz: freqGHz * 1000,
    raySamples: input.raySamples ?? DEFAULT_RAY_SAMPLES,
    demMppM: input.demMppM,
    txDbm: input.txDbm ?? 22,
    txAntennaDbi: input.txAntennaDbi ?? 3,
    rxAntennaDbi: input.rxAntennaDbi ?? input.txAntennaDbi ?? 3,
    rxAntennaHeightM: input.rxAntennaHeightM ?? 2,
    rxSensitivityDbm: input.rxSensitivityDbm ?? -130,
    fadeMarginDb: input.fadeMarginDb ?? FADE_MARGIN_DB,
    cableLossDb: input.cableLossDb ?? CABLE_LOSS_DB,
    clutterAggression: input.clutterAggression ?? 1.0,
    maxDistanceKm: input.maxDistanceKm ?? Infinity,
  };
}

function summarize(origin: [number, number], originShortname: string | undefined, results: ScanResult[]): ScanSummary {
  let clearCount = 0, fresnelCount = 0, diffractedCount = 0, blockedCount = 0;
  for (const r of results) {
    if (r.cls === "clear") clearCount++;
    else if (r.cls === "fresnel") fresnelCount++;
    else if (r.cls === "diffracted") diffractedCount++;
    else blockedCount++;
  }
  results.sort((a, b) => scanSortKey(b) - scanSortKey(a));
  return { origin, originShortname, results, clearCount, fresnelCount, diffractedCount, blockedCount };
}

/** Synchronous scan (used by tests / small meshes). Prefer runScanAsync in the UI. */
export function runScan(input: ScanInput): ScanSummary {
  const budget = resolveBudget(input);
  const clutterScratch = makeClutterScratch();
  const canopyCtx: CanopyPathContext | null = input.canopyRaster
    ? { raster: input.canopyRaster, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;
  const buildingCtx: BuildingPathContext | null = input.buildingRaster
    ? { raster: input.buildingRaster, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;
  const results: ScanResult[] = [];
  for (const t of input.targets) {
    const r = scanOneTarget(t, input, budget, clutterScratch, canopyCtx, buildingCtx);
    if (r) results.push(r);
  }
  return summarize(input.origin, input.originShortname, results);
}

/** Chunked scan that yields to the event loop between batches so the map stays
 *  interactive on dense meshes. `shouldCancel` aborts mid-run (returns null). */
export async function runScanAsync(
  input: ScanInput,
  opts: { chunkSize?: number; shouldCancel?: () => boolean } = {},
): Promise<ScanSummary | null> {
  const { chunkSize = 40, shouldCancel } = opts;
  const budget = resolveBudget(input);
  const clutterScratch = makeClutterScratch();
  const canopyCtx: CanopyPathContext | null = input.canopyRaster
    ? { raster: input.canopyRaster, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;
  const buildingCtx: BuildingPathContext | null = input.buildingRaster
    ? { raster: input.buildingRaster, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;
  const results: ScanResult[] = [];
  const targets = input.targets;
  for (let i = 0; i < targets.length; i++) {
    if (shouldCancel?.()) return null;
    const r = scanOneTarget(targets[i], input, budget, clutterScratch, canopyCtx, buildingCtx);
    if (r) results.push(r);
    // Yield on a macrotask boundary so paint/input aren't starved.
    if ((i + 1) % chunkSize === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (shouldCancel?.()) return null;
  return summarize(input.origin, input.originShortname, results);
}

/** FeatureCollection of lines from origin → each target (seam-unwrapped for display). */
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
      // Unwrap the target into the origin's longitude frame so a seam-crossing
      // link draws the short hop, not a 359° sweep across the whole map.
      coordinates: [summary.origin, [unwrapLngTo(summary.origin[0], r.position[0]), r.position[1]]],
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
