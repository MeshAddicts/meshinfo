/** Modem-preset RX profiles for the live coverage layer, derived from the
 *  canonical firmware table (never fork a preset list here). Channels are NOT
 *  presets: mapping comes from `[broker.channels.meta.<hash>] preset` config. */

import {
  canonicalPresetName,
  FIRMWARE_MODEM_PRESETS,
} from "../../../meshtasticPresets";

/** Typical real-world SX1262 sensitivity (dBm) per firmware modem preset. */
export const LIVE_PRESET_SENSITIVITY_DBM: Record<string, number> =
  Object.fromEntries(
    FIRMWARE_MODEM_PRESETS.map((p) => [p.name, p.sensitivityDbm])
  );

/** Meshtastic's worldwide default preset — the area-agnostic fallback for
 *  nodes whose channel hash has no meta mapping (override per deployment
 *  with COVERAGE_DEFAULT_PRESET). */
export const DEFAULT_LIVE_PRESET = "LongFast";

/** Accepts firmware names and historical config spellings (via aliases). */
export function isKnownPreset(preset: string): boolean {
  return canonicalPresetName(preset) in LIVE_PRESET_SENSITIVITY_DBM;
}

export function presetSensitivityDbm(preset: string): number {
  return (
    LIVE_PRESET_SENSITIVITY_DBM[canonicalPresetName(preset)] ??
    LIVE_PRESET_SENSITIVITY_DBM[DEFAULT_LIVE_PRESET]
  );
}

/** "MediumFast" → "MF", "LongTurbo" → "LT" — chip labels for the pill. */
export function presetShortLabel(preset: string): string {
  const canonical = canonicalPresetName(preset);
  const known = FIRMWARE_MODEM_PRESETS.find((p) => p.name === canonical);
  if (known) return known.short;
  const caps = canonical.replace(/[^A-Z]/g, "");
  return caps.length >= 2 ? caps : canonical.slice(0, 2).toUpperCase();
}
