/**
 * Per-pixel RGBA coverage renderer using Longley-Rice ITM v1.4.
 * Hot loop is alloc-free (shared Float64 profile buffer, pre-allocated WASM ctx).
 * Profile length adapts to path length (15-96 samples, ~1.5/km).
 */
import { type BuildingRaster, sampleBuildingAt } from "./buildingTiles";
import type { CanopyRaster } from "./canopyTiles";
import {
  type BuildingPathContext,
  type CanopyPathContext,
  computePathClutterLoss,
  makeClutterScratch,
} from "./clutterPath";
import {
  Climate,
  computeP2PLossFast,
  type ItmContext,
  ModeOfVariability,
  Polarization,
} from "./itm";
import type { ClutterRaster } from "./landcoverTiles";
import { sampleClutterClassAt } from "./landcoverTiles";
import { type DEM, sampleDEMAt } from "./terrainDEM";

const R_EARTH_KM = 6371;

export interface RasterParams {
  freqMhz: number;
  txDbm: number;
  txAntennaDbi: number;
  /** RX antenna gain (dBi); can differ from TX for asymmetric links. */
  rxAntennaDbi: number;
  /** RX antenna height above terrain (m), clamped to ITM's 0.5-3000 m range. */
  rxAntennaHeightAboveGroundM: number;
  rxSensitivityDbm: number;
  fadeMarginDb: number;
  cableLossDb: number;
  /** Scalar on the ITU-R clutter model output. 1.0 = calibrated baseline. */
  clutterAggression: number;
  climate: Climate;
  /** Surface refractivity in N-units (e.g. 301 continental). */
  surfaceRefractivityN: number;
  polarization: Polarization;
  /** Ground ε_r. */
  groundDielectric: number;
  /** Ground σ (S/m). */
  groundConductivity: number;
  /** TLS reliability %, default 50/50/50. */
  timePct?: number;
  locationPct?: number;
  situationPct?: number;
}

export interface RasterOrigin {
  position: [number, number];
  /** Origin MSL height (m); display/export only — ITM doesn't receive this. */
  heightM: number;
  /** TX antenna AGL height (m), fed to ITM as txHeightM (must be AGL, not MSL). Clamped 0.5-3000 m. */
  antennaHeightAboveGroundM: number;
}

export interface RasterResult {
  /** RGBA row-major, length width*height*4. */
  rgba: Uint8ClampedArray;
  /** Per-pixel margin dB (RSSI - sens - fade). NaN for no-data/failure. Row-major. */
  marginDb: Float32Array;
  width: number;
  height: number;
  /** margin ≥ 15 dB */
  clearCount: number;
  /** 0 ≤ margin < 15 dB */
  fresnelCount: number;
  /** Always 0; LR has no separate "diffracted" bucket. */
  diffractedCount: number;
  /** margin < 0 or compute failed */
  blockedCount: number;
  maxMarginDb: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradient(marginDb: number): [number, number, number, number] {
  // 0→5→15→25 dB: magenta #d946ef → orange #f97316 → cyan #06b6d4 → deep #0891b2
  let r: number, g: number, b: number;
  if (marginDb <= 0) {
    r = 217; g = 70; b = 239;
  } else if (marginDb < 5) {
    const t = marginDb / 5;
    r = lerp(217, 249, t); g = lerp(70, 115, t); b = lerp(239, 22, t);
  } else if (marginDb < 15) {
    const t = (marginDb - 5) / 10;
    r = lerp(249, 6, t); g = lerp(115, 182, t); b = lerp(22, 212, t);
  } else if (marginDb < 25) {
    const t = (marginDb - 15) / 10;
    r = lerp(6, 8, t); g = lerp(182, 145, t); b = lerp(212, 178, t);
  } else {
    r = 8; g = 145; b = 178;
  }
  const aT = Math.min(1, Math.max(0, marginDb / 25));
  const a = Math.round(255 * (0.35 + 0.35 * aT));
  return [Math.round(r), Math.round(g), Math.round(b), a];
}

function haversineKm(
  lng1: number, lat1: number, lng2: number, lat2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;
  const a1 = (lat1 * Math.PI) / 180;
  const a2 = (lat2 * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(a1) * Math.cos(a2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(s));
}

/** ~1.5 samples/km, clamped [15, 96]. */
function profileSampleCount(distanceKm: number): number {
  const raw = Math.round(distanceKm * 1.5);
  return Math.max(15, Math.min(96, raw));
}

/** Output row slice in output-grid coords; used by worker pool to parallelize. */
export interface RowRange {
  rowStart: number;
  rowEnd: number;
}

/** Output raster dims, decoupled from DEM dims (DEM = accuracy, Output = paint detail). */
export interface OutputGrid {
  width: number;
  height: number;
}

/** Paint `rowRange` (or full grid) of the output raster via ITM. */
export function renderCoverageRaster(
  dem: DEM,
  params: RasterParams,
  itm: ItmContext,
  origin: RasterOrigin,
  rowRange?: RowRange,
  output?: OutputGrid,
  /** Optional class-ID raster aligned to the DEM bounds. Null = treat every sample as default class. */
  clutter?: ClutterRaster | null,
  /** Optional canopy-height raster aligned to the DEM bounds. Null = use class-nominal heights. */
  canopy?: CanopyRaster | null,
  /** Optional building-height raster aligned to the DEM bounds. Drives the ITM
   *  DSM (mid-path) and P.452 endpoint h_a override. Null = class-nominal. */
  buildings?: BuildingRaster | null,
): RasterResult {
  const { bounds } = dem;
  const outputWidth = output?.width ?? dem.width;
  const outputHeight = output?.height ?? dem.height;
  const rowStart = rowRange?.rowStart ?? 0;
  const rowEnd = rowRange?.rowEnd ?? outputHeight;
  const sliceHeight = rowEnd - rowStart;
  const rgba = new Uint8ClampedArray(outputWidth * sliceHeight * 4);
  const marginDbBuf = new Float32Array(outputWidth * sliceHeight);
  // NaN distinguishes "no data" from "0 dB reachable" for contour extraction
  marginDbBuf.fill(Number.NaN);
  const {
    freqMhz, txDbm, txAntennaDbi, rxAntennaDbi, rxAntennaHeightAboveGroundM,
    rxSensitivityDbm, fadeMarginDb, cableLossDb, clutterAggression,
    climate, surfaceRefractivityN, polarization,
    groundDielectric, groundConductivity,
    timePct = 50, locationPct = 50, situationPct = 50,
  } = params;

  let clearCount = 0;
  let fresnelCount = 0;
  let blockedCount = 0;
  let maxMarginDb = -Infinity;

  // Pre-allocate profile buffer sized to DEM diagonal (worst-case path length)
  const diagonalKm = haversineKm(
    bounds.west, bounds.south, bounds.east, bounds.north,
  );
  const maxSamples = profileSampleCount(diagonalKm);
  const profileBuf = new Float64Array(maxSamples);
  const profileClassBuf = new Uint8Array(maxSamples);
  const clutterScratch = makeClutterScratch();

  const [origLng, origLat] = origin.position;
  // Step over OUTPUT grid; terrain via bilinear sampleDEMAt is (lng,lat)-continuous
  const lonStep = (bounds.east - bounds.west) / (outputWidth - 1);
  const latStep = (bounds.north - bounds.south) / (outputHeight - 1);

  // Reusable input object (65k+ computes per frame → don't allocate). ITM wants AGL, clamped [0.5, 3000].
  const txHeightAgM = Math.max(0.5, Math.min(3000, origin.antennaHeightAboveGroundM));
  const itmInput = {
    txHeightM: txHeightAgM,
    rxHeightM: 0, // set per-pixel
    profileM: profileBuf,
    pointSpacingM: 0,
    climate,
    surfaceRefractivityN,
    freqMhz,
    polarization,
    groundDielectric,
    groundConductivity,
    mdvar: ModeOfVariability.SingleMessage,
    time: timePct,
    location: locationPct,
    situation: situationPct,
  };

  const receiverAntennaAboveGroundM = Math.max(0.5, Math.min(3000, rxAntennaHeightAboveGroundM));
  const txGain = txAntennaDbi;
  const rxGain = rxAntennaDbi;

  // Mutated per-pixel rather than reallocated — see CanopyPathContext docstring.
  const canopyCtx: CanopyPathContext | null = canopy
    ? { raster: canopy, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;
  const buildingCtx: BuildingPathContext | null = buildings
    ? { raster: buildings, origLng: 0, origLat: 0, destLng: 0, destLat: 0 }
    : null;

  for (let j = rowStart; j < rowEnd; j++) {
    const lat = bounds.north - j * latStep;
    const outRowOffset = (j - rowStart) * outputWidth;
    for (let i = 0; i < outputWidth; i++) {
      const outPxIdx = outRowOffset + i;
      const lng = bounds.west + i * lonStep;
      const demElev = sampleDEMAt(dem, lng, lat);
      if (Number.isNaN(demElev)) {
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }
      const distKm = haversineKm(origLng, origLat, lng, lat);

      // Origin pixel — paint max-margin color
      if (distKm < 0.01) {
        const [r, g, b, a] = gradient(50);
        rgba[outPxIdx * 4] = r;
        rgba[outPxIdx * 4 + 1] = g;
        rgba[outPxIdx * 4 + 2] = b;
        rgba[outPxIdx * 4 + 3] = a;
        clearCount++;
        if (50 > maxMarginDb) maxMarginDb = 50;
        continue;
      }

      // Linear lng/lat interp is within ~1% of great-circle at Meshtastic distances
      const nSamples = profileSampleCount(distKm);
      const lastIdx = nSamples - 1;
      let validProfile = true;
      for (let s = 0; s < nSamples; s++) {
        const t = s / lastIdx;
        const sLng = origLng + (lng - origLng) * t;
        const sLat = origLat + (lat - origLat) * t;
        const elev = sampleDEMAt(dem, sLng, sLat);
        if (Number.isNaN(elev)) {
          validProfile = false;
          break;
        }
        // Endpoints stay bare-earth so AGL antenna heights aren't placed on
        // top of a presumed building — that's captured by P.452 instead.
        let dsmElev = elev;
        if (buildings && s !== 0 && s !== lastIdx) {
          const sample = sampleBuildingAt(buildings, sLng, sLat);
          if (sample && sample.heightM > 0) dsmElev = elev + sample.heightM;
        }
        profileBuf[s] = dsmElev;
        profileClassBuf[s] = clutter ? sampleClutterClassAt(clutter, sLng, sLat) : 0;
      }
      if (!validProfile) {
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }

      // subarray = no-copy view; slice() would allocate
      itmInput.profileM = profileBuf.subarray(0, nSamples);
      const pointSpacingM = (distKm * 1000) / (nSamples - 1);
      itmInput.pointSpacingM = pointSpacingM;
      itmInput.rxHeightM = receiverAntennaAboveGroundM;

      const lossDb = computeP2PLossFast(itm, itmInput);
      if (!Number.isFinite(lossDb) || lossDb <= 0) {
        // ITM failure — transparent rather than garbage color
        rgba[outPxIdx * 4 + 3] = 0;
        blockedCount++;
        continue;
      }

      if (canopyCtx) {
        canopyCtx.origLng = origLng;
        canopyCtx.origLat = origLat;
        canopyCtx.destLng = lng;
        canopyCtx.destLat = lat;
      }
      if (buildingCtx) {
        buildingCtx.origLng = origLng;
        buildingCtx.origLat = origLat;
        buildingCtx.destLng = lng;
        buildingCtx.destLat = lat;
      }
      const clutterLossDb = computePathClutterLoss(
        profileBuf,
        profileClassBuf,
        nSamples,
        pointSpacingM,
        txHeightAgM,
        receiverAntennaAboveGroundM,
        freqMhz,
        clutterAggression,
        clutterScratch,
        canopyCtx,
        buildingCtx,
      );

      const totalLossDb = lossDb + clutterLossDb + cableLossDb;
      const rssiDbm = txDbm + txGain + rxGain - totalLossDb;
      const marginDb = rssiDbm - rxSensitivityDbm - fadeMarginDb;

      // Record margin for blocked pixels too — contour extraction needs both sides of 0 dB
      marginDbBuf[outPxIdx] = marginDb;

      if (marginDb < 0) {
        blockedCount++;
        rgba[outPxIdx * 4 + 3] = 0;
        continue;
      }

      if (marginDb >= 15) {
        clearCount++;
      } else {
        fresnelCount++;
      }
      if (marginDb > maxMarginDb) maxMarginDb = marginDb;

      const [r, g, b, a] = gradient(marginDb);
      const o = outPxIdx * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }

  return {
    rgba,
    marginDb: marginDbBuf,
    width: outputWidth,
    height: sliceHeight,
    clearCount,
    fresnelCount,
    diffractedCount: 0,
    blockedCount,
    maxMarginDb: maxMarginDb === -Infinity ? 0 : maxMarginDb,
  };
}
