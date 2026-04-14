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
   * Excess loss (dB) added on top of ITM's terrain-aware prediction to
   * represent building / vegetation clutter. ITM itself doesn't model
   * buildings or foliage — this is a crude but tunable compensation.
   */
  clutterLossDb: number;
  description: string;
}
export const ENVIRONMENTS: Environment[] = [
  { id: "open",     label: "Open / Rural",         clutterLossDb: 0,  description: "Line-of-sight with no obstacles — open country, water, desert" },
  { id: "mixed",    label: "Light terrain",        clutterLossDb: 3,  description: "Scattered trees and rolling hills — mixed countryside" },
  { id: "suburban", label: "Suburban",             clutterLossDb: 6,  description: "Residential neighborhoods with buildings and moderate clutter" },
  { id: "urban",    label: "Urban / Dense forest", clutterLossDb: 12, description: "Heavy obstruction — city core, thick canopy, industrial" },
];

/**
 * Meshtastic modem presets. The `sensitivityDbm` we use in calculations is
 * a **real-world typical** value — roughly 3 dB worse than the SX1262
 * datasheet ("spec") figure. Real-world degradation comes from PCB
 * noise, temperature, antenna system losses, and board-level matching.
 *
 * For SX1276-based boards (Heltec LoRa32 v2 etc.) the sensitivity is
 * typically another ~2 dB worse again — handled via the `chipset` field
 * on COMMON_HARDWARE + the `effectiveSensitivityDbm` helper below.
 *
 * Both values are exposed so the panel tooltip can show spec + real-world
 * side by side for transparency. Datasheet references:
 * meshtastic.org/docs/overview/radio-settings/modem-presets/
 */
export interface ModemPreset {
  id: string;
  label: string;
  /** Real-world typical sensitivity (dBm). Used for link-budget math. */
  sensitivityDbm: number;
  /** Datasheet/spec sensitivity from the SX1262 datasheet (dBm). */
  datasheetSensitivityDbm: number;
  sf: number;
  bwKhz: number;
  isCustom?: boolean;
}
export const MESHTASTIC_PRESETS: ModemPreset[] = [
  { id: "MediumFast", label: "MediumFast (SF9, 250 kHz)",  sensitivityDbm: -124, datasheetSensitivityDbm: -127, sf: 9,  bwKhz: 250 },
  { id: "LongFast",   label: "LongFast (SF11, 250 kHz)",   sensitivityDbm: -130, datasheetSensitivityDbm: -133, sf: 11, bwKhz: 250 },
  { id: "LongSlow",   label: "LongSlow (SF12, 125 kHz)",   sensitivityDbm: -134, datasheetSensitivityDbm: -137, sf: 12, bwKhz: 125 },
  { id: "Custom",     label: "Custom",                      sensitivityDbm: -130, datasheetSensitivityDbm: -133, sf: 11, bwKhz: 250, isCustom: true },
];

/**
 * Additional sensitivity penalty for SX1276-based boards — they use the
 * older chipset which is typically ~2 dB less sensitive than SX1262
 * at the same SF/BW combination.
 */
export const SX1276_SENSITIVITY_OFFSET_DB = -2;

/**
 * Chipset used by a given hardware entry. Drives the sensitivity
 * correction applied in link-budget math.
 */
export type LoraChipset = "SX1262" | "SX1276";

/**
 * Compute the effective RX sensitivity (dBm) for a modem preset +
 * chipset combination. Always more negative (i.e. less sensitive) than
 * the preset's base value when SX1276 is selected.
 */
export function effectiveSensitivityDbm(
  presetSensitivityDbm: number,
  chipset: LoraChipset,
): number {
  return presetSensitivityDbm + (chipset === "SX1276" ? SX1276_SENSITIVITY_OFFSET_DB : 0);
}

/**
 * Simple free-space path loss for backward compatibility with the scan
 * tool (which hasn't been migrated to ITM yet). The coverage tool uses
 * Longley-Rice directly and does not call this. Clamped to d≥10m.
 *
 * PL = 32.45 + 20·log10(f_MHz) + 20·log10(d_km)
 */
export function pathLossDb(dKm: number, freqMhz: number): number {
  const d = Math.max(0.01, dKm);
  return 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(d);
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
export interface HardwareEntry {
  label: string;
  txDbm: number;
  chipset: LoraChipset;
  isCustom?: boolean;
}

// Ordered by TX power (descending), ties broken alphabetically. Custom last.
// `chipset` drives the sensitivity offset: SX1276 boards are typically ~2 dB
// less sensitive than SX1262 at the same preset.
export const COMMON_HARDWARE: HardwareEntry[] = [
  { label: "LILYGO T3-S3 1W", txDbm: 30, chipset: "SX1262" },
  { label: "Heltec V3", txDbm: 22, chipset: "SX1262" },
  { label: "Heltec V4", txDbm: 22, chipset: "SX1262" },
  { label: "LILYGO T-Beam", txDbm: 22, chipset: "SX1262" },
  { label: "LILYGO T-Deck", txDbm: 22, chipset: "SX1262" },
  { label: "LILYGO T-Echo", txDbm: 22, chipset: "SX1262" },
  { label: "RAK WisBlock (RAK4631)", txDbm: 22, chipset: "SX1262" },
  { label: "Seeed T1000-E", txDbm: 22, chipset: "SX1262" },
  { label: "Station G2", txDbm: 22, chipset: "SX1262" },
  { label: "Heltec LoRa32 v2 (SX1276)", txDbm: 20, chipset: "SX1276" },
  { label: "nRF52 (generic)", txDbm: 20, chipset: "SX1262" },
  { label: "Custom", txDbm: 22, chipset: "SX1262", isCustom: true },
];

/**
 * ITM reliability preset — controls the time/location/situation percentages
 * the underlying model uses to answer "at what statistical threshold should
 * we call a pixel 'reachable'?"
 *
 *   - Median (50/50/50): academic median prediction. Half the time, at half
 *     the locations, under half the situations. This is what Radio Mobile /
 *     SPLAT! ship by default; it's informative for comparison but misleading
 *     for planning because users interpret the paint as "will work," when
 *     half the time it in fact won't.
 *   - Typical (90/50/70): normal broadcast/cellular planning default.
 *     90% of the time, at 50% of locations, under 70% of situations.
 *     This is what commercial RF planning suites default to.
 *   - Conservative (95/50/90): mission-critical planning. Paint reflects
 *     what you can count on even in unfavorable conditions.
 *
 * `location=50` stays fixed because higher values aren't really meaningful
 * for a point-to-area prediction (there is only one receiver location per
 * pixel); it's there for the model's statistical machinery.
 */
export type CoverageReliability = "median" | "typical" | "conservative";

export interface ReliabilityPreset {
  id: CoverageReliability;
  label: string;
  /** Percentage of time the received signal meets the threshold. */
  time: number;
  /** Percentage of locations in a receive cell meeting the threshold. */
  location: number;
  /** Percentage of situations (setups/weather/etc.) meeting the threshold. */
  situation: number;
  /** One-line UI description. */
  desc: string;
}

export const RELIABILITY_PRESETS: ReliabilityPreset[] = [
  { id: "median",       label: "Median",       time: 50, location: 50, situation: 50,
    desc: "50/50/50 — median prediction. Paint shows what happens about half the time." },
  { id: "typical",      label: "Typical",      time: 90, location: 50, situation: 70,
    desc: "90/50/70 — normal planning default. Paint shows what you can expect most of the time." },
  { id: "conservative", label: "Conservative", time: 95, location: 50, situation: 90,
    desc: "95/50/90 — worst-case planning. Paint shows what works reliably in tough conditions." },
];

export function reliabilityPreset(id: CoverageReliability): ReliabilityPreset {
  return RELIABILITY_PRESETS.find((p) => p.id === id) ?? RELIABILITY_PRESETS[1];
}

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
  /** Effective RX sensitivity (dBm) used — includes chipset correction. */
  rxSensitivityDbm: number;
}
