/**
 * Coverage prediction — shared constants, presets, and link-budget helpers.
 *
 * The actual coverage painting runs through `coverageWorker.ts` which uses
 * `viewshed.ts` + `coverageRaster.ts`. This module just holds the pure
 * helpers shared between the panel (UI) and the worker (math).
 */

/**
 * Propagation environment — affects excess path loss beyond free space.
 * Exponents are typical for log-distance path loss models.
 */
export interface Environment {
  id: string;
  label: string;
  /**
   * Path-loss exponent for the legacy log-distance model. Still used by
   * `linkBudgetMaxKm()` to drive the "theoretical range" preview in the
   * panel. The actual per-pixel coverage math (ITM / Longley-Rice) uses
   * the `clutterLossDb` field below.
   */
  pathLossExponent: number;
  /**
   * Excess loss (dB) added on top of ITM's terrain-aware prediction to
   * represent building / vegetation clutter. ITM itself doesn't model
   * buildings or foliage — this is a crude but tunable compensation.
   */
  clutterLossDb: number;
  description: string;
}
export const ENVIRONMENTS: Environment[] = [
  { id: "open",     label: "Open / Rural",         pathLossExponent: 2.0, clutterLossDb: 0,  description: "Line-of-sight with no obstacles — open country, water, desert" },
  { id: "mixed",    label: "Light terrain",        pathLossExponent: 2.5, clutterLossDb: 3,  description: "Scattered trees and rolling hills — mixed countryside" },
  { id: "suburban", label: "Suburban",             pathLossExponent: 3.0, clutterLossDb: 6,  description: "Residential neighborhoods with buildings and moderate clutter" },
  { id: "urban",    label: "Urban / Dense forest", pathLossExponent: 3.5, clutterLossDb: 12, description: "Heavy obstruction — city core, thick canopy, industrial" },
];

/**
 * Meshtastic modem presets. Sensitivity values match Meshtastic's documented
 * theoretical figures for SX126x chipsets at the given SF/BW combinations.
 * (See: meshtastic.org/docs/overview/radio-settings/modem-presets/)
 *
 * Real-world sensitivity is typically 1–3 dB worse than theoretical due to
 * PCB noise, temperature, and antenna system losses. The 15 dB fade margin
 * in the link budget already accounts for some of this.
 */
export interface ModemPreset {
  id: string;
  label: string;
  sensitivityDbm: number;
  sf: number;
  bwKhz: number;
  isCustom?: boolean;
}
export const MESHTASTIC_PRESETS: ModemPreset[] = [
  { id: "MediumFast", label: "MediumFast (SF9, 250 kHz)",  sensitivityDbm: -127, sf: 9,  bwKhz: 250 },
  { id: "LongFast",   label: "LongFast (SF11, 250 kHz)",   sensitivityDbm: -133, sf: 11, bwKhz: 250 },
  { id: "LongSlow",   label: "LongSlow (SF12, 125 kHz)",   sensitivityDbm: -137, sf: 12, bwKhz: 125 },
  { id: "Custom",     label: "Custom",                      sensitivityDbm: -133, sf: 11, bwKhz: 250, isCustom: true },
];

/**
 * Path loss at distance `dKm` for a given frequency and environment exponent.
 * Uses free-space as the d=1km reference, plus excess clutter loss that scales
 * with the environment exponent. Clamped to d≥10m to avoid weirdness at zero.
 */
export function pathLossDb(dKm: number, freqMhz: number, envExponent: number): number {
  const d = Math.max(0.01, dKm);
  const freeSpace = 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(d);
  const excess = (envExponent - 2) * 10 * Math.log10(Math.max(1, d));
  return freeSpace + excess;
}

/**
 * Compute the theoretical max range (km) for a symmetric link using free-space
 * path loss at the given frequency. Reasonable for clear-LoS planning.
 *
 * Budget = TX + G_tx + G_rx − sensitivity − margin − cable_loss
 * Free-space path loss (915 MHz): PL = 32.45 + 20·log10(f_MHz) + 20·log10(d_km)
 *                               = 91.67 + 20·log10(d_km)  at 915 MHz
 * Solving for d: d_km = 10^((budget − 91.67) / 20)
 */
export function linkBudgetMaxKm(opts: {
  antennaDbi: number;
  txDbm?: number;
  rxSensitivityDbm?: number;
  fadeMarginDb?: number;
  cableLossDb?: number;
  freqMhz?: number;
  /** Environment path-loss exponent (2.0 = free space). */
  envExponent?: number;
}): number {
  const {
    antennaDbi,
    txDbm = 22,
    rxSensitivityDbm = -133, // LongFast (Meshtastic docs theoretical)
    fadeMarginDb = 15,
    cableLossDb = 2,
    freqMhz = 915,
    envExponent = 2.0,
  } = opts;

  const budgetDb = txDbm + 2 * antennaDbi - rxSensitivityDbm - fadeMarginDb - cableLossDb;
  // Solve budgetDb = pathLossDb(d) = 91.67 + 10·n·log10(d)  (for d ≥ 1km)
  // → d = 10^((budget - 91.67) / (10·n))
  const plConstant = 32.45 + 20 * Math.log10(freqMhz);
  const dKm = Math.pow(10, (budgetDb - plConstant) / (10 * envExponent));
  return dKm;
}

/**
 * Common Meshtastic antenna gains. Descriptors like "omni" / "yagi" are
 * intentionally omitted for now — the coverage model assumes isotropic
 * radiation and can't yet account for directional patterns. When directional
 * antennas are added, specific models (e.g. Rockland, Signal Plus) should
 * go here with their radiation patterns.
 */
export const COMMON_ANTENNAS: { dbi: number; label: string }[] = [
  { dbi: 3,   label: "3 dBi" },
  { dbi: 5.8, label: "5.8 dBi" },
  { dbi: 6,   label: "6 dBi" },
  { dbi: 8,   label: "8 dBi" },
  { dbi: 10,  label: "10 dBi" },
  { dbi: 12,  label: "12 dBi" },
];

/**
 * Common Meshtastic hardware with typical max TX power (dBm).
 * Values are realistic defaults — most boards ship at these figures,
 * though actual output can vary by firmware settings and region.
 */
// Ordered by TX power (descending), ties broken alphabetically. Custom last.
export const COMMON_HARDWARE: { label: string; txDbm: number; isCustom?: boolean }[] = [
  { label: "LILYGO T3-S3 1W", txDbm: 30 },
  { label: "Heltec V3", txDbm: 22 },
  { label: "Heltec V4", txDbm: 22 },
  { label: "LILYGO T-Beam", txDbm: 22 },
  { label: "LILYGO T-Deck", txDbm: 22 },
  { label: "LILYGO T-Echo", txDbm: 22 },
  { label: "RAK WisBlock (RAK4631)", txDbm: 22 },
  { label: "Seeed T1000-E", txDbm: 22 },
  { label: "Station G2", txDbm: 22 },
  { label: "Heltec LoRa32 v2 (SX1276)", txDbm: 20 },
  { label: "nRF52 (generic)", txDbm: 20 },
  { label: "Custom", txDbm: 22, isCustom: true },
];

/**
 * Summary of a coverage computation — populated from the worker response.
 * The actual pixel data lives on the Mapbox image source; this struct just
 * carries the stats and link-budget context shown in the side panel.
 */
export interface CoverageResult {
  origin: [number, number];
  originHeightM: number;
  originIsFallback: boolean;
  radiusKm: number;
  /** Pixels that pass link budget with full LoS. */
  clearCount: number;
  /** Pixels that pass link budget but have Fresnel intrusion or diffraction loss. */
  fresnelCount: number;
  /** Pixels below the link-budget threshold (un-paintable). */
  blockedCount: number;
  frequencyGHz: number;
  antennaDbi: number;
  txDbm: number;
  /** Theoretical max range (km) from the link budget at this config. */
  linkBudgetMaxKm: number;
  envExponent: number;
  rxSensitivityDbm: number;
}
