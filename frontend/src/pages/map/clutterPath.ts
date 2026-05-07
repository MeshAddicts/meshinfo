/**
 * Path-aware clutter loss = P.452-17 endpoint clutter (TX & RX) + P.833-9 §4.1
 * MED for path-traversed vegetation. Skip first txSkipN / last rxSkipN samples
 * from MED accumulation to avoid double-counting the near-antenna zone P.452
 * already covers. z_path is a linear lerp of TX/RX MSL antenna heights.
 *
 * Hot loop is alloc-free — caller allocates ClutterScratch once and reuses
 * across all per-pixel calls.
 */
import {
  classForId,
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
    const canopyTop = zTerrain + cls.nominalHeightM;

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
