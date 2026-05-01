/**
 * Path-aware clutter loss orchestration.
 *
 * Composes:
 *   - ITU-R P.452-17 §4.5.4 endpoint clutter at TX & RX (height-gain function)
 *   - ITU-R P.833-9 §4.1   path-traversed vegetation (modified exponential decay)
 *
 * The two ITU recommendations are explicitly designed to be additive: the P.452
 * formula models near-antenna scattering / multipath, while P.833 models direct
 * absorption through a volume of foliage along the path. To avoid double-counting
 * the immediate near-antenna zone, MED accumulation skips the first/last d_k km
 * of the profile.
 *
 * "Inside canopy" geometry uses a linear lerp of TX/RX MSL antenna heights as
 * z_path(s); ITM internally accounts for terrain diffraction so canopy along
 * obstructed paths is mostly irrelevant anyway. This is the standard
 * simplification (SPLAT!, Radio Mobile, CloudRF use the same).
 *
 * Hot-loop notes:
 *   - Caller passes a `scratch` Float32Array (length ≥ 96) reused across pixels
 *     to avoid per-pixel allocation. Length 96 covers all NLCD class IDs (0..95).
 *   - We accumulate touched class IDs in a small stack so cleanup is O(touched)
 *     rather than O(96) per call.
 */
import {
  classForId,
  endpointClutterDb,
  NLCD_CLASSES,
  vegetationPathLossDb,
} from "./clutterClasses";

/** Class ID range; NLCD legend tops out at 95. */
export const CLUTTER_SCRATCH_LEN = 96;

/** Allocate a reusable per-class distance accumulator. Length matches CLUTTER_SCRATCH_LEN. */
export function makeClutterScratch(): Float32Array {
  return new Float32Array(CLUTTER_SCRATCH_LEN);
}

/**
 * Total clutter loss in dB for a single TX→RX profile.
 *
 * @param profileM         Terrain MSL per sample (length ≥ nSamples).
 * @param profileClasses   NLCD class ID per sample (length ≥ nSamples). 0 falls back to default class.
 * @param nSamples         Number of valid samples to consume from the buffers (≥ 2).
 * @param pointSpacingM    Distance between consecutive samples (m).
 * @param txAntennaAGLm    TX antenna height above local terrain (m).
 * @param rxAntennaAGLm    RX antenna height above local terrain (m).
 * @param freqMhz          Operating frequency (MHz).
 * @param aggression       User-facing scalar (0.7 / 1.0 / 1.3) applied to the final result.
 * @param scratch          Length-96 Float32Array; cleared internally for the IDs touched by this call.
 * @returns Clutter loss in dB; always ≥ 0.
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

  // Endpoint classes are sampled at the literal first/last profile points.
  // In coverageRaster these are the TX origin and the RX pixel respectively.
  const txClass = classForId(profileClasses[0]);
  const rxClass = classForId(profileClasses[nSamples - 1]);

  const aHTx = endpointClutterDb(txClass, txAntennaAGLm, freqMhz);
  const aHRx = endpointClutterDb(rxClass, rxAntennaAGLm, freqMhz);

  // z_path is linear MSL between (TX terrain + TX AGL) and (RX terrain + RX AGL).
  // 4/3-Earth bulge ignored; ITM already handles diffraction over terrain.
  const txMsl = profileM[0] + txAntennaAGLm;
  const rxMsl = profileM[nSamples - 1] + rxAntennaAGLm;

  // Endpoint exclusion: skip first/last d_k km of profile (P.452 captures it as endpoint clutter).
  const skipDistanceM =
    Math.max(txClass.nominalDistanceKm, rxClass.nominalDistanceKm) * 1000;
  const skipN = Math.ceil(skipDistanceM / pointSpacingM);

  // Track which scratch slots got written so cleanup is O(touched), not O(96).
  // Worst-case ~16 distinct classes per path; 32 is generous.
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

    if (zPath >= canopyTop) continue; // path above canopy
    if (zPath < zTerrain) continue;   // sanity (shouldn't happen)

    if (scratch[id] === 0) touched.push(id);
    scratch[id] += pointSpacingM;
  }

  // Sum MED contribution per class encountered, then reset scratch slots.
  let lV = 0;
  for (const id of touched) {
    lV += vegetationPathLossDb(NLCD_CLASSES[id] ?? classForId(id), scratch[id]);
    scratch[id] = 0;
  }

  return aggression * (aHTx + aHRx + lV);
}
