/**
 * Modem-preset RX profiles for the live coverage layer.
 *
 * Kept separate from MESHTASTIC_PRESETS on purpose: the tool panels persist
 * `presetIdx` (an array index) in localStorage, so that array's order is
 * load-bearing and can't grow the presets this table needs. Keyed by preset id.
 *
 * A node's preset comes from its `last_channel` hash via the operator's
 * `[broker.channels.meta.<hash>] preset = "..."` config — channels are NOT
 * presets (a future regional channel like "SacValley" maps to a preset by
 * adding one meta entry), so this file never guesses from channel names.
 */

/** Typical real-world SX1262 sensitivity (dBm) per Meshtastic modem preset —
 *  datasheet + 3 dB, anchored to MESHTASTIC_PRESETS' values (MediumFast −124,
 *  LongFast −130, LongSlow −134, VeryLongSlow −137) and extended along the
 *  Semtech ladder: ~3 dB per SF step, +3 dB per bandwidth halving. */
export const LIVE_PRESET_SENSITIVITY_DBM: Record<string, number> = {
  ShortTurbo: -115, // SF7 / 500 kHz
  ShortFast: -118, // SF7 / 250 kHz
  ShortSlow: -121, // SF8 / 250 kHz
  MediumFast: -124, // SF9 / 250 kHz
  MediumSlow: -127, // SF10 / 250 kHz
  LongFast: -130, // SF11 / 250 kHz
  LongModerate: -133, // SF11 / 125 kHz
  LongSlow: -134, // SF12 / 125 kHz
  VeryLongSlow: -137, // SF12 / 62.5 kHz
};

/** Meshtastic's worldwide default preset — the area-agnostic fallback for
 *  nodes whose channel hash has no meta mapping (override per deployment
 *  with COVERAGE_DEFAULT_PRESET). */
export const DEFAULT_LIVE_PRESET = "LongFast";

export function isKnownPreset(preset: string): boolean {
  return preset in LIVE_PRESET_SENSITIVITY_DBM;
}

export function presetSensitivityDbm(preset: string): number {
  return LIVE_PRESET_SENSITIVITY_DBM[preset] ?? LIVE_PRESET_SENSITIVITY_DBM[DEFAULT_LIVE_PRESET];
}

/** "MediumFast" → "MF", "VeryLongSlow" → "VLS" — chip labels for the pill. */
export function presetShortLabel(preset: string): string {
  const caps = preset.replace(/[^A-Z]/g, "");
  return caps.length >= 2 ? caps : preset.slice(0, 2).toUpperCase();
}
