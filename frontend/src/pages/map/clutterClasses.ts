/**
 * NLCD land-cover class table + ITU-R clutter math. See RF-MODEL.md for the
 * full derivation; sources are P.452-17 §4.5.4 (endpoint clutter) and P.833-9
 * §4.1 (path-traversed vegetation, MED). γ/A values are calibrated at 915 MHz.
 */

export interface ClutterClass {
  id: number;
  label: string;
  /** P.452-17 §4.5.4 h_a — nominal clutter height (m AGL). 0 for non-clutter. */
  nominalHeightM: number;
  /** P.452-17 §4.5.4 d_k — nominal antenna-to-clutter distance (km). */
  nominalDistanceKm: number;
  /** P.833-9 γ — specific attenuation (dB/m at 915 MHz). 0 if not penetrable. */
  vegAttenuationDbPerM: number;
  /** P.833-9 A — saturation (dB). */
  vegSaturationDb: number;
  /** Whether the propagation path can pass *through* this class. */
  penetrable: boolean;
}

/**
 * Per-row citations: P.452-T4 = ITU-R P.452-17 Table 4; P.833-§4 = P.833-9 §4.1.
 * Where NLCD has no direct ITU analogue, the closest published category is chosen.
 */
export const NLCD_CLASSES: Readonly<Record<number, ClutterClass>> = {
  11: { id: 11, label: "Open Water",            nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },
  12: { id: 12, label: "Perennial Ice/Snow",    nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },
  31: { id: 31, label: "Barren Land",           nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },

  21: { id: 21, label: "Developed, Open Space",      nominalHeightM: 4,  nominalDistanceKm: 0.10,  vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Park land / sparse houses"
  22: { id: 22, label: "Developed, Low Intensity",   nominalHeightM: 9,  nominalDistanceKm: 0.025, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Suburban"
  23: { id: 23, label: "Developed, Medium Intensity", nominalHeightM: 15, nominalDistanceKm: 0.020, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Urban"
  24: { id: 24, label: "Developed, High Intensity",  nominalHeightM: 25, nominalDistanceKm: 0.020, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Dense urban"

  41: { id: 41, label: "Deciduous Forest",  nominalHeightM: 15, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.5, vegSaturationDb: 24, penetrable: true }, // P.833 in-leaf at 900 MHz; out-of-leaf is γ≈0.15, A≈20
  42: { id: 42, label: "Evergreen Forest",  nominalHeightM: 20, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.7, vegSaturationDb: 27, penetrable: true }, // P.833 conifer values
  43: { id: 43, label: "Mixed Forest",      nominalHeightM: 15, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.6, vegSaturationDb: 25, penetrable: true }, // averaged deciduous + evergreen; default fallback class

  51: { id: 51, label: "Dwarf Scrub (AK)",  nominalHeightM: 1, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.2, vegSaturationDb: 6,  penetrable: true },
  52: { id: 52, label: "Shrub/Scrub",       nominalHeightM: 2, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.3, vegSaturationDb: 12, penetrable: true },

  // h_a≈0.5 means h/h_a is large for any handheld → endpoint formula returns ~0 dB.
  71: { id: 71, label: "Grassland/Herbaceous",       nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  72: { id: 72, label: "Sedge/Herbaceous (AK)",      nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  73: { id: 73, label: "Lichens (AK)",               nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  74: { id: 74, label: "Moss (AK)",                  nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },

  81: { id: 81, label: "Pasture/Hay",        nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0,   vegSaturationDb: 0, penetrable: false },
  82: { id: 82, label: "Cultivated Crops",   nominalHeightM: 4,   nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.3, vegSaturationDb: 8, penetrable: true },  // P.452-T4 "High crop fields"; assumes tall crops

  90: { id: 90, label: "Woody Wetlands",                nominalHeightM: 10, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.5, vegSaturationDb: 20, penetrable: true },
  95: { id: 95, label: "Emergent Herbaceous Wetlands",  nominalHeightM: 2,  nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.2, vegSaturationDb: 6,  penetrable: true },
};

/** Mixed Forest — fallback when a tile is missing or the class ID is unknown. */
export const NLCD_DEFAULT_CLASS_ID = 43;

/** Unknown IDs (including the 0 nodata sentinel) return the default class. */
export function classForId(id: number): ClutterClass {
  return NLCD_CLASSES[id] ?? NLCD_CLASSES[NLCD_DEFAULT_CLASS_ID];
}

/**
 * P.452-17 §4.5.4 frequency factor F_fc:
 *   F_fc = 0.25 + 0.375 · {1 + tanh[7.5 · (f − 0.5)]}   (f in GHz)
 * 915 MHz ≈ 0.9986; 868 MHz ≈ 0.9974. Below ~700 MHz the formula's accuracy drops.
 */
export function freqFactor(freqMhz: number): number {
  const fGhz = freqMhz / 1000;
  return 0.25 + 0.375 * (1 + Math.tanh(7.5 * (fGhz - 0.5)));
}

/**
 * P.452-17 §4.5.4 endpoint clutter A_h (dB):
 *   A_h = 10.25 · F_fc · exp(−d_k) · {1 − tanh[6 · (h/h_a − 0.625)]} − 0.33
 * Clamped to ≥0; the −0.33 term lets the formula go mildly negative when the
 * antenna is well above clutter (physically: no clutter loss).
 */
export function endpointClutterDb(
  cls: ClutterClass,
  antennaAGLm: number,
  freqMhz: number,
): number {
  if (cls.nominalHeightM <= 0) return 0;
  const h = Math.max(0, antennaAGLm);
  const ratio = h / cls.nominalHeightM;
  const fc = freqFactor(freqMhz);
  const a =
    10.25 * fc * Math.exp(-cls.nominalDistanceKm) *
      (1 - Math.tanh(6 * (ratio - 0.625))) -
    0.33;
  return a > 0 ? a : 0;
}

/**
 * P.833-9 §4.1 modified exponential decay for path-traversed vegetation:
 *   L = A · {1 − exp[−γ · d / A]}
 * Callers must accumulate `pathLengthThroughClassM` per class — a path crossing
 * multiple class types is summed by class, each evaluated independently.
 */
export function vegetationPathLossDb(
  cls: ClutterClass,
  pathLengthThroughClassM: number,
): number {
  if (!cls.penetrable) return 0;
  const { vegAttenuationDbPerM: gamma, vegSaturationDb: A } = cls;
  if (gamma <= 0 || A <= 0 || pathLengthThroughClassM <= 0) return 0;
  return A * (1 - Math.exp((-gamma * pathLengthThroughClassM) / A));
}
