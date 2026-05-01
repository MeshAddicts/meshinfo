/**
 * NLCD land-cover class table + ITU-R clutter math for the coverage / scan models.
 *
 * Two-component model (see docs/clutter-design.md):
 *   1. Endpoint clutter loss   — ITU-R P.452-17 §4.5.4 (height-gain at TX & RX)
 *   2. Path-traversed foliage — ITU-R P.833-9   §4.1   (modified exponential decay)
 *
 * All values calibrated for 915 MHz. The frequency factor F_fc for P.452 is
 * computed in `freqFactor` so non-US bands (868/433 MHz) work when wired up;
 * the P.833 γ/A values in the table assume 915 MHz and would need a per-band
 * lookup if the region selector lands.
 */

/** One row of the NLCD → ITU parameter map. */
export interface ClutterClass {
  /** NLCD legend ID (e.g. 42 = Evergreen Forest). */
  id: number;
  label: string;
  /** Nominal clutter height (m AGL). P.452-17 §4.5.4 symbol h_a. 0 for non-clutter. */
  nominalHeightM: number;
  /** Nominal antenna-to-clutter distance (km). P.452-17 §4.5.4 symbol d_k. */
  nominalDistanceKm: number;
  /** P.833-9 specific attenuation γ (dB/m at 915 MHz). 0 when not penetrable. */
  vegAttenuationDbPerM: number;
  /** P.833-9 saturation A (dB). 0 when not penetrable. */
  vegSaturationDb: number;
  /** Whether the propagation path can pass *through* this class (foliage true; built-up/water false). */
  penetrable: boolean;
}

/**
 * NLCD class table. Citations live next to each row so the source of truth is auditable.
 *
 * Sources keyed by abbreviation:
 *   P.452-T4  — ITU-R Rec. P.452-17, Table 4 (nominal clutter heights & distances)
 *   P.833-§4  — ITU-R Rec. P.833-9, §4.1 (vegetation specific attenuation, MED model)
 *
 * Where NLCD has no exact ITU analogue, the closest published category is chosen and noted.
 */
export const NLCD_CLASSES: Readonly<Record<number, ClutterClass>> = {
  // --- No-clutter classes (water, barren, ice/snow) ---
  // h_a=0 means the endpoint formula short-circuits to 0; not penetrable so MED is also 0.
  11: { id: 11, label: "Open Water",            nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },
  12: { id: 12, label: "Perennial Ice/Snow",    nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },
  31: { id: 31, label: "Barren Land",           nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0,   vegSaturationDb: 0,  penetrable: false },

  // --- Developed (built-up); not penetrable, endpoint clutter only. P.452-T4 anchors. ---
  21: { id: 21, label: "Developed, Open Space",      nominalHeightM: 4,  nominalDistanceKm: 0.10,  vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Park land / sparse houses"
  22: { id: 22, label: "Developed, Low Intensity",   nominalHeightM: 9,  nominalDistanceKm: 0.025, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Suburban"
  23: { id: 23, label: "Developed, Medium Intensity", nominalHeightM: 15, nominalDistanceKm: 0.020, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Urban"
  24: { id: 24, label: "Developed, High Intensity",  nominalHeightM: 25, nominalDistanceKm: 0.020, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false }, // P.452-T4 "Dense urban"

  // --- Forest (penetrable). P.452-T4 + P.833-§4. ---
  41: { id: 41, label: "Deciduous Forest",  nominalHeightM: 15, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.5, vegSaturationDb: 24, penetrable: true }, // in-leaf at 900 MHz; out-of-leaf is γ≈0.15, A≈20 (deferred to v2 seasonal)
  42: { id: 42, label: "Evergreen Forest",  nominalHeightM: 20, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.7, vegSaturationDb: 27, penetrable: true }, // P.833-§4 conifer values
  43: { id: 43, label: "Mixed Forest",      nominalHeightM: 15, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.6, vegSaturationDb: 25, penetrable: true }, // averaged deciduous + evergreen; also serves as out-of-bbox default

  // --- Shrub / scrub. No direct P.452-T4 anchor; closest is between "high crop" and "deciduous". ---
  51: { id: 51, label: "Dwarf Scrub (AK)",  nominalHeightM: 1, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.2, vegSaturationDb: 6,  penetrable: true },
  52: { id: 52, label: "Shrub/Scrub",       nominalHeightM: 2, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.3, vegSaturationDb: 12, penetrable: true },

  // --- Herbaceous (too short to attenuate at 915 MHz for typical antennas). ---
  // h_a≈0.5 means h/h_a is large for any handheld → endpoint formula returns ~0 dB.
  71: { id: 71, label: "Grassland/Herbaceous",       nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  72: { id: 72, label: "Sedge/Herbaceous (AK)",      nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  73: { id: 73, label: "Lichens (AK)",               nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },
  74: { id: 74, label: "Moss (AK)",                  nominalHeightM: 0,   nominalDistanceKm: 0,    vegAttenuationDbPerM: 0, vegSaturationDb: 0, penetrable: false },

  // --- Cultivated. ---
  81: { id: 81, label: "Pasture/Hay",        nominalHeightM: 0.5, nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0,   vegSaturationDb: 0, penetrable: false }, // mowed; effectively invisible
  82: { id: 82, label: "Cultivated Crops",   nominalHeightM: 4,   nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.3, vegSaturationDb: 8, penetrable: true },  // P.452-T4 "High crop fields"; conservative — assumes tall crops

  // --- Wetlands. ---
  90: { id: 90, label: "Woody Wetlands",                nominalHeightM: 10, nominalDistanceKm: 0.05, vegAttenuationDbPerM: 0.5, vegSaturationDb: 20, penetrable: true }, // tree-dominated wetland; like deciduous but lower density
  95: { id: 95, label: "Emergent Herbaceous Wetlands",  nominalHeightM: 2,  nominalDistanceKm: 0.10, vegAttenuationDbPerM: 0.2, vegSaturationDb: 6,  penetrable: true }, // cattails / reeds
};

/** Mixed Forest — used when a tile is missing or the class ID is unknown. Conservative default. */
export const NLCD_DEFAULT_CLASS_ID = 43;

/** Lookup with safe fallback. Unknown IDs (including the 0 nodata sentinel) return the default class. */
export function classForId(id: number): ClutterClass {
  return NLCD_CLASSES[id] ?? NLCD_CLASSES[NLCD_DEFAULT_CLASS_ID];
}

/**
 * Frequency factor F_fc for the P.452-17 §4.5.4 endpoint clutter formula.
 *   F_fc = 0.25 + 0.375 · {1 + tanh[7.5 · (f - 0.5)]}   (f in GHz)
 * At 915 MHz ≈ 0.9986; at 868 MHz ≈ 0.9974; at 433 MHz ≈ 0.6839 (formula is
 * defined down to 30 MHz, but accuracy below ~700 MHz is reduced).
 */
export function freqFactor(freqMhz: number): number {
  const fGhz = freqMhz / 1000;
  return 0.25 + 0.375 * (1 + Math.tanh(7.5 * (fGhz - 0.5)));
}

/**
 * Endpoint clutter loss A_h (dB) per ITU-R P.452-17 §4.5.4.
 *
 *   A_h = 10.25 · F_fc · exp(-d_k) · {1 - tanh[6 · (h/h_a - 0.625)]} - 0.33
 *
 * - Returns 0 when the class has no defined clutter (h_a ≤ 0).
 * - Returns 0 when the antenna sits well above clutter (formula goes mildly
 *   negative due to the -0.33 term; physically this means "no clutter loss").
 *
 * Inputs are clamped only where physical: antennaAGLm < 0 is treated as 0.
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
 * Path-traversed vegetation loss L (dB) per ITU-R P.833-9 §4.1 (modified exponential decay).
 *
 *   L = A · {1 - exp[-γ · d / A]}
 *
 * - Linear in d for short grazes; saturates at A for long penetration.
 * - Returns 0 for non-penetrable classes, d ≤ 0, γ ≤ 0, or A ≤ 0.
 *
 * Note: callers should accumulate `pathLengthThroughClassM` per class separately
 * before calling this — a path can traverse multiple class types and each gets
 * its own MED evaluation.
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
