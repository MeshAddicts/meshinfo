/** Coverage prediction constants/presets shared between the panel UI and the worker. */

/**
 * Aggression scaler stops for the per-pixel ITU clutter model.
 * 1.0 is the calibrated default (matches ITU-R P.452-17 + P.833-9 published values);
 * <1 dials conservatism down (your measured links beat predictions);
 * >1 dials it up (your area has heavier clutter than the published averages).
 *
 * This value is multiplied into the final A_h_tx + A_h_rx + L_v sum in computePathClutterLoss.
 */
export interface AggressionStop {
  id: string;
  label: string;
  /** Short label for the compact 3-button row. */
  short: string;
  value: number;
  description: string;
}
export const AGGRESSION_STOPS: AggressionStop[] = [
  { id: "conservative", label: "Conservative", short: "Cons.", value: 0.7, description: "Predictions are pessimistic — measured links are reaching farther than the model says." },
  { id: "calibrated",   label: "Calibrated",   short: "Cal.",  value: 1.0, description: "ITU-R P.452 / P.833 calibrated baseline. Use this unless you have measured-link data telling you otherwise." },
  { id: "aggressive",   label: "Aggressive",   short: "Aggr.", value: 1.3, description: "Predictions are optimistic — measured links fall short. Heavier clutter than published averages (dense canopy, urban valleys)." },
];

/** Index of the calibrated-default stop. Keep in sync with AGGRESSION_STOPS. */
export const DEFAULT_AGGRESSION_IDX = 1;
export const DEFAULT_AGGRESSION = AGGRESSION_STOPS[DEFAULT_AGGRESSION_IDX].value;

/**
 * Representative clutter dB used by the bbox sizer when picking a coverage radius.
 * The sizer can't run the per-pixel model before knowing the bbox, so it scales
 * a Mixed-Forest-handheld endpoint estimate (~16 dB) by the active aggression.
 * Approximate; the bbox is a sizing heuristic, not the RF answer.
 */
export const REPRESENTATIVE_CLUTTER_DB = 16;

/** Meshtastic modem presets. `sensitivityDbm` is real-world typical (~3 dB worse than
 *  SX1262 datasheet). SX1276 adds another ~2 dB (see COMMON_HARDWARE.chipset + effectiveSensitivityDbm).
 *  Refs: meshtastic.org/docs/overview/radio-settings/modem-presets/ */
export interface ModemPreset {
  id: string;
  label: string;
  /** Real-world typical sensitivity (dBm); used in link-budget math. */
  sensitivityDbm: number;
  /** SX1262 datasheet spec sensitivity (dBm). */
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

/** SX1276 is ~2 dB less sensitive than SX1262 at the same SF/BW.
 *  Offset is added to sensitivity (dBm); a less-sensitive chipset needs a stronger
 *  signal to decode, which in dBm terms means a less-negative value → positive offset. */
export const SX1276_SENSITIVITY_OFFSET_DB = +2;

export type LoraChipset = "SX1262" | "SX1276";

/** Effective RX sensitivity (dBm) = preset + chipset offset + board offset. */
export function effectiveSensitivityDbm(
  presetSensitivityDbm: number,
  chipset: LoraChipset,
  boardOffsetDb = 0,
): number {
  return presetSensitivityDbm + (chipset === "SX1276" ? SX1276_SENSITIVITY_OFFSET_DB : 0) + boardOffsetDb;
}

/** Free-space path loss (dB). `PL = 32.45 + 20·log10(f_MHz) + 20·log10(d_km)`. Coverage tool uses ITM instead. */
export function pathLossDb(dKm: number, freqMhz: number): number {
  const d = Math.max(0.01, dKm);
  return 32.45 + 20 * Math.log10(freqMhz) + 20 * Math.log10(d);
}

/** Common omnidirectional Meshtastic antennas. Gains are manufacturer spec (community-verified). */
export const COMMON_ANTENNAS: { dbi: number; label: string }[] = [
  { dbi: 1.5, label: "Stock (rubber duck) · 1.5 dBi" },
  { dbi: 3,   label: "Alfa AOA-8696-3ACM · 3 dBi" },
  { dbi: 3,   label: "Rokland Omni · 3 dBi" },
  { dbi: 5.8, label: "Rokland N-Male Omni · 5.8 dBi" },
  { dbi: 6,   label: "Rokland Low Profile Omni · 6 dBi" },
  { dbi: 8,   label: "Rokland Low Profile Omni · 8 dBi" },
  { dbi: 10,  label: "Rokland Backcountry 45\" Omni · 10 dBi" },
];

/** Meshtastic hardware with real-world typical TX power (dBm) at 915 MHz.
 *  Values are community-measured (Discord #hardware-testing, teardowns, FCC reports),
 *  typically 1-3 dB lower than spec due to PA saturation and RF losses. */
export interface HardwareEntry {
  label: string;
  txDbm: number;
  chipset: LoraChipset;
  /** Per-board sensitivity offset (dB) on top of preset + chipset. 0 until measured. */
  sensitivityOffsetDb?: number;
  isCustom?: boolean;
}

// Ordered by TX power desc, alpha tie-break, Custom last. chipset drives SX1276 -2 dB offset.
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

/** ITM reliability preset — time/location/situation percentages for the statistical threshold.
 *  location stays 50 (single RX per pixel). */
export type CoverageReliability = "median" | "typical" | "conservative";

export interface ReliabilityPreset {
  id: CoverageReliability;
  label: string;
  time: number;      // % of time signal meets threshold
  location: number;  // % of locations in RX cell
  situation: number; // % of situations (setups/weather)
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

/** Coverage computation summary (pixel stats + link-budget context). Raster lives on the Mapbox source. */
export interface CoverageResult {
  origin: [number, number];
  originHeightM: number;
  originIsFallback: boolean;
  radiusKm: number;
  /** Pixels passing link budget with full LoS. */
  clearCount: number;
  /** Pixels passing link budget with Fresnel intrusion/diffraction loss. */
  fresnelCount: number;
  /** Pixels below link-budget threshold. */
  blockedCount: number;
  /** outputWidth × outputHeight; low (clear+fresnel+blocked)/scanned ratio → DEM missing over bbox. */
  scannedPixels: number;
  frequencyGHz: number;
  txAntennaDbi: number;
  /** RX antenna gain (dBi); can differ from TX when asymmetric. */
  rxAntennaDbi: number;
  /** RX antenna height above sampled terrain (m). */
  rxAntennaHeightAboveGroundM: number;
  txDbm: number;
  /** Effective RX sensitivity (dBm), chipset-corrected. */
  rxSensitivityDbm: number;
}
