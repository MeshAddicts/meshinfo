/**
 * Path-aware clutter loss = P.452-17 endpoint clutter (TX & RX) + P.833-9 §4.1
 * MED for path-traversed vegetation. Skip first txSkipN / last rxSkipN samples
 * from MED accumulation to avoid double-counting the near-antenna zone P.452
 * already covers. z_path is a linear lerp of TX/RX MSL antenna heights.
 */
import {
  classForId,
  endpointClutterDb,
  NLCD_CLASSES,
  vegetationPathLossDb,
} from "./clutterClasses";

/** NLCD legend max ID is 95. */
export const CLUTTER_SCRATCH_LEN = 96;

export function makeClutterScratch(): Float32Array {
  return new Float32Array(CLUTTER_SCRATCH_LEN);
}

/**
 * `scratch` (length ≥ 96, reused across pixels) accumulates per-class distance;
 * touched slots are reset before return.
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
  scratch: Float32Array,
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

  const touched: number[] = [];

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
    // scratch[0] and scratch[43] and double-count via concave MED.
    const idx = cls.id;
    if (scratch[idx] === 0) touched.push(idx);
    scratch[idx] += pointSpacingM;
  }

  let lV = 0;
  for (const id of touched) {
    lV += vegetationPathLossDb(NLCD_CLASSES[id], scratch[id]);
    scratch[id] = 0;
  }

  return aggression * (aHTx + aHRx + lV);
}
