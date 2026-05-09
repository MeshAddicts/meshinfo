/**
 * Path-aware clutter loss = P.452-17 endpoint clutter (TX & RX) + P.833-9 §4.1
 * MED for path-traversed vegetation. Skip first txSkipN / last rxSkipN samples
 * from MED accumulation to avoid double-counting the near-antenna zone P.452
 * already covers. z_path is a linear lerp of TX/RX MSL antenna heights.
 *
 * Hot loop is alloc-free — caller allocates ClutterScratch once and reuses
 * across all per-pixel calls. When `canopyCtx` is supplied, per-sample
 * measured ETH heights replace the P.452-Table-4 nominals inside the MED
 * gate; class-nominal is the fallback.
 */
import { type CanopyRaster, sampleCanopyAt } from "./canopyTiles";
import {
  classForId,
  type ClutterClass,
  endpointClutterDb,
  NLCD_CLASSES,
  vegetationPathLossDb,
} from "./clutterClasses";

/** NLCD legend max ID is 95. */
export const CLUTTER_SCRATCH_LEN = 96;

/**
 * Reusable per-call scratch state. `distances` accumulates per-class metres;
 * `touched` records which class IDs were written this call so cleanup is
 * O(touched) instead of O(96). Length tracked locally per call.
 */
export interface ClutterScratch {
  distances: Float32Array;
  touched: Uint8Array;
}

export function makeClutterScratch(): ClutterScratch {
  return {
    distances: new Float32Array(CLUTTER_SCRATCH_LEN),
    touched: new Uint8Array(CLUTTER_SCRATCH_LEN),
  };
}

/**
 * Reuse a single instance and mutate it across pixels — keeps the hot loop
 * alloc-free at 65k+ computes per coverage frame.
 */
export interface CanopyPathContext {
  raster: CanopyRaster;
  origLng: number;
  origLat: number;
  destLng: number;
  destLat: number;
}

/**
 * σ ≥ height = noisy ETH pixel; blend 50/50 with class-nominal so it can't
 * solo-drive the MED loop. σ=0 (the no-SD bake) skips the blend, which is
 * the right behaviour — there's no uncertainty signal to act on.
 */
function effectiveCanopyHeightM(cls: ClutterClass, ctx: CanopyPathContext, lng: number, lat: number): number {
  const sample = sampleCanopyAt(ctx.raster, lng, lat);
  if (sample === null) return cls.nominalHeightM;
  if (sample.heightM <= 0) return 0;
  if (sample.stdM > 0 && sample.stdM >= sample.heightM) {
    return 0.5 * sample.heightM + 0.5 * cls.nominalHeightM;
  }
  return sample.heightM;
}

/**
 * Total clutter loss in dB for one TX→RX profile.
 *
 * `profileClasses[0]` and `profileClasses[nSamples-1]` are TX/RX endpoints.
 */
export function computePathClutterLoss(
  profileM: Float64Array,
  profileClasses: Uint8Array,
  nSamples: number,
  pointSpacingM: number,
  txAntennaAGLm: number,
  rxAntennaAGLm: number,
  freqMhz: number,
  aggression: number,
  scratch: ClutterScratch,
  canopyCtx?: CanopyPathContext | null,
): number {
  if (nSamples < 2 || pointSpacingM <= 0) return 0;

  const txClass = classForId(profileClasses[0]);
  const rxClass = classForId(profileClasses[nSamples - 1]);

  const aHTx = endpointClutterDb(txClass, txAntennaAGLm, freqMhz);
  const aHRx = endpointClutterDb(rxClass, rxAntennaAGLm, freqMhz);

  const txMsl = profileM[0] + txAntennaAGLm;
  const rxMsl = profileM[nSamples - 1] + rxAntennaAGLm;

  const txSkipN = Math.ceil((txClass.nominalDistanceKm * 1000) / pointSpacingM);
  const rxSkipN = Math.ceil((rxClass.nominalDistanceKm * 1000) / pointSpacingM);

  const { distances, touched } = scratch;
  let touchedLen = 0;

  const lastIdx = nSamples - 1;
  for (let s = txSkipN; s <= lastIdx - rxSkipN; s++) {
    const cls = classForId(profileClasses[s]);
    if (!cls.penetrable) continue;

    const t = s / lastIdx;
    const zPath = txMsl + (rxMsl - txMsl) * t;
    const zTerrain = profileM[s];
    let canopyHeightM = cls.nominalHeightM;
    if (canopyCtx) {
      const sLng = canopyCtx.origLng + (canopyCtx.destLng - canopyCtx.origLng) * t;
      const sLat = canopyCtx.origLat + (canopyCtx.destLat - canopyCtx.origLat) * t;
      canopyHeightM = effectiveCanopyHeightM(cls, canopyCtx, sLng, sLat);
    }
    const canopyTop = zTerrain + canopyHeightM;

    if (zPath >= canopyTop) continue;
    if (zPath < zTerrain) continue;

    // Key by canonical cls.id; raw 0 (NLCD nodata) would otherwise split into
    // distances[0] and distances[43] and double-count via concave MED.
    const idx = cls.id;
    if (distances[idx] === 0) {
      touched[touchedLen++] = idx;
    }
    distances[idx] += pointSpacingM;
  }

  let lV = 0;
  for (let i = 0; i < touchedLen; i++) {
    const id = touched[i];
    lV += vegetationPathLossDb(NLCD_CLASSES[id], distances[id]);
    distances[id] = 0;
  }

  return aggression * (aHTx + aHRx + lV);
}
