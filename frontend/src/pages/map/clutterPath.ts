/**
 * Path-aware clutter loss = P.452-17 endpoint clutter (TX & RX) + P.833-9 §4.1
 * MED for path-traversed vegetation. The two recommendations are designed to be
 * additive; we skip the first/last d_k km of the profile from MED accumulation
 * to avoid double-counting the near-antenna zone P.452 already covers.
 *
 * z_path(s) is a linear lerp of TX/RX MSL antenna heights — ITM handles terrain
 * diffraction internally, so canopy along ITM-blocked paths is moot anyway.
 */
import {
  classForId,
  endpointClutterDb,
  NLCD_CLASSES,
  vegetationPathLossDb,
} from "./clutterClasses";

/** NLCD legend max ID is 95; +1 for inclusive index. */
export const CLUTTER_SCRATCH_LEN = 96;

export function makeClutterScratch(): Float32Array {
  return new Float32Array(CLUTTER_SCRATCH_LEN);
}

/**
 * Total clutter loss in dB for one TX→RX profile.
 *
 * `profileClasses[0]` and `profileClasses[nSamples-1]` are the TX/RX endpoints.
 * `scratch` (length ≥ 96, reused across pixels) accumulates per-class distance
 * to avoid per-call allocation; touched slots are reset before return.
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

  const skipDistanceM =
    Math.max(txClass.nominalDistanceKm, rxClass.nominalDistanceKm) * 1000;
  const skipN = Math.ceil(skipDistanceM / pointSpacingM);

  // Track touched slots so cleanup is O(touched), not O(96).
  const touched: number[] = [];

  const lastIdx = nSamples - 1;
  for (let s = skipN; s <= lastIdx - skipN; s++) {
    const id = profileClasses[s];
    const cls = classForId(id);
    if (!cls.penetrable) continue;

    const t = s / lastIdx;
    const zPath = txMsl + (rxMsl - txMsl) * t;
    const zTerrain = profileM[s];
    const canopyTop = zTerrain + cls.nominalHeightM;

    if (zPath >= canopyTop) continue;
    if (zPath < zTerrain) continue;

    if (scratch[id] === 0) touched.push(id);
    scratch[id] += pointSpacingM;
  }

  let lV = 0;
  for (const id of touched) {
    lV += vegetationPathLossDb(NLCD_CLASSES[id] ?? classForId(id), scratch[id]);
    scratch[id] = 0;
  }

  return aggression * (aHTx + aHRx + lV);
}
