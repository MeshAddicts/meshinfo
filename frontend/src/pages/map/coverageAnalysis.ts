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
  { id: "MediumFast",   label: "MediumFast (SF9, 250 kHz)",    sensitivityDbm: -124, datasheetSensitivityDbm: -127, sf: 9,  bwKhz: 250 },
  { id: "LongFast",     label: "LongFast (SF11, 250 kHz)",     sensitivityDbm: -130, datasheetSensitivityDbm: -133, sf: 11, bwKhz: 250 },
  { id: "LongSlow",     label: "LongSlow (SF12, 125 kHz)",     sensitivityDbm: -134, datasheetSensitivityDbm: -137, sf: 12, bwKhz: 125 },
  { id: "VeryLongSlow", label: "VeryLongSlow (SF12, 62.5 kHz)", sensitivityDbm: -137, datasheetSensitivityDbm: -140, sf: 12, bwKhz: 62.5 },
  { id: "Custom",       label: "Custom",                        sensitivityDbm: -130, datasheetSensitivityDbm: -133, sf: 11, bwKhz: 250, isCustom: true },
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
  boardOffsetDb = 0,
): number {
  return presetSensitivityDbm + (chipset === "SX1276" ? SX1276_SENSITIVITY_OFFSET_DB : 0) + boardOffsetDb;
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
 * Common Meshtastic antenna models with real-world gains. All current
 * entries are omnidirectional verticals — the coverage model applies gain
 * isotropically. A directional (Yagi) option is planned but requires
 * bearing/pattern-aware logic in the render loop.
 *
 * Gains listed are the manufacturer's spec rating. Community testing on
 * these specific Rokland and Alfa models shows them tracking within
 * ~0.5 dB of spec. Cheap no-name antennas often underperform by 2–3 dB.
 */
export const COMMON_ANTENNAS: { dbi: number; label: string }[] = [
  { dbi: 1.5, label: "Stock (rubber duck) · 1.5 dBi" },
  { dbi: 3,   label: "Alfa AOA-8696-3ACM · 3 dBi" },
  { dbi: 3,   label: "Rokland Omni · 3 dBi" },
  { dbi: 5.8, label: "Rokland N-Male Omni · 5.8 dBi" },
  { dbi: 6,   label: "Rokland Low Profile Omni · 6 dBi" },
  { dbi: 8,   label: "Rokland Low Profile Omni · 8 dBi" },
  { dbi: 10,  label: "Rokland Backcountry 45\" Omni · 10 dBi" },
];

/**
 * Common Meshtastic hardware with **real-world typical** TX power (dBm).
 *
 * These are NOT spec-sheet values — they reflect community-measured output
 * at 915 MHz under normal operating conditions. Sources: Meshtastic
 * Discord #hardware-testing, YouTube teardowns (Andreas Spiess, The Comms
 * Channel), and FCC test reports where available.
 *
 * Spec-sheet values are typically 1–3 dB higher due to PA saturation,
 * impedance mismatch, and board-level RF losses at 915 MHz.
 */
export interface HardwareEntry {
  label: string;
  txDbm: number;
  chipset: LoraChipset;
  /**
   * Board-specific sensitivity adjustment in dB, applied on top of the
   * modem preset's real-world sensitivity + chipset correction. Negative
   * values mean the board is noisier than the baseline (common for
   * compact / budget designs); positive means better (rare). All boards
   * are 0 dB until per-board measurements are available — the field is
   * wired through so plugging in real data later is a one-line change.
   */
  sensitivityOffsetDb?: number;
  isCustom?: boolean;
}

// Ordered by TX power (descending), ties broken alphabetically. Custom last.
// `chipset` drives the sensitivity offset: SX1276 boards are typically ~2 dB
// less sensitive than SX1262 at the same preset.
export const COMMON_HARDWARE: HardwareEntry[] = [
  { label: "Station G2",                   txDbm: 33, chipset: "SX1262" },  // spec 36.5, external PA
  { label: "LILYGO T3-S3 1W",             txDbm: 30, chipset: "SX1262" },  // spec 32, PA saturation ~2 dB
  { label: "RAK WisBlock (RAK4631)",       txDbm: 22, chipset: "SX1262" },  // good RF design, tracks spec
  { label: "WisMesh Pocket",               txDbm: 22, chipset: "SX1262" },  // RAK4631-based
  { label: "Heltec V3",                    txDbm: 21, chipset: "SX1262" },  // spec 22, ~1 dB board loss
  { label: "Heltec V4",                    txDbm: 26, chipset: "SX1262" },  // spec 28, has PA unlike V3
  { label: "LILYGO T-Beam",               txDbm: 21, chipset: "SX1262" },  // spec 22
  { label: "LILYGO T-Deck",               txDbm: 20, chipset: "SX1262" },  // spec 22, compact board losses
  { label: "LILYGO T-Echo",               txDbm: 20, chipset: "SX1262" },  // spec 22, compact nRF52 board
  { label: "Seeed T1000-E",               txDbm: 20, chipset: "SX1262" },  // spec 22, tiny tracker form
  { label: "Heltec LoRa32 v2 (SX1276)",   txDbm: 19, chipset: "SX1276" },  // spec 20, older chipset
  { label: "nRF52 (generic)",              txDbm: 20, chipset: "SX1262" },
  { label: "Custom",                       txDbm: 22, chipset: "SX1262", isCustom: true },
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
