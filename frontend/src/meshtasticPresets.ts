/**
 * The channel names Meshtastic firmware itself emits (`DisplayFormatters.cpp`).
 * Firmware substitutes the modem-preset display string when a channel's name is
 * blank, so an unrenamed node reports one of these; anything else is human-typed.
 */
export interface FirmwareModemPreset {
  /** Firmware display string == the wire channel name an unnamed channel hashes. */
  name: string;
  /** Two-letter chip label ("LF", "LT", ...). */
  short: string;
  sf: number;
  bwKhz: number;
  cr: number;
  /** Real-world SX1262 sensitivity (datasheet + 3 dB) — used by link-budget math. */
  sensitivityDbm: number;
  /** SX1262 datasheet spec sensitivity. */
  datasheetSensitivityDbm: number;
}

/**
 * Names from firmware `DisplayFormatters.cpp`, RF params from `MeshRadio.h`; LongSlow
 * −134 is a deliberate +2 dB off the Semtech ladder. All preset lists derive from here — do not fork.
 */
export const FIRMWARE_MODEM_PRESETS: readonly FirmwareModemPreset[] = [
  { name: "ShortTurbo", short: "ST", sf: 7,  bwKhz: 500, cr: 5, sensitivityDbm: -115, datasheetSensitivityDbm: -118 },
  { name: "ShortFast",  short: "SF", sf: 7,  bwKhz: 250, cr: 5, sensitivityDbm: -118, datasheetSensitivityDbm: -121 },
  { name: "ShortSlow",  short: "SS", sf: 8,  bwKhz: 250, cr: 5, sensitivityDbm: -121, datasheetSensitivityDbm: -124 },
  { name: "MediumFast", short: "MF", sf: 9,  bwKhz: 250, cr: 5, sensitivityDbm: -124, datasheetSensitivityDbm: -127 },
  { name: "MediumSlow", short: "MS", sf: 10, bwKhz: 250, cr: 5, sensitivityDbm: -127, datasheetSensitivityDbm: -130 },
  { name: "LongFast",   short: "LF", sf: 11, bwKhz: 250, cr: 5, sensitivityDbm: -130, datasheetSensitivityDbm: -133 },
  { name: "LongTurbo",  short: "LT", sf: 11, bwKhz: 500, cr: 8, sensitivityDbm: -127, datasheetSensitivityDbm: -130 },
  { name: "LongMod",    short: "LM", sf: 11, bwKhz: 125, cr: 8, sensitivityDbm: -133, datasheetSensitivityDbm: -136 },
  { name: "LongSlow",   short: "LS", sf: 12, bwKhz: 125, cr: 8, sensitivityDbm: -134, datasheetSensitivityDbm: -137 },
];

export const FIRMWARE_PRESET_NAMES: ReadonlySet<string> = new Set(
  FIRMWARE_MODEM_PRESETS.map((p) => p.name)
);

/**
 * Historical config preset names -> firmware names. "LongModerate" is LongMod's enum
 * long name; "VeryLongSlow" was removed upstream and such radios actually run LongFast params.
 */
export const PRESET_ALIASES: Readonly<Record<string, string>> = {
  LongModerate: "LongMod",
  VeryLongSlow: "LongFast",
};

/** Resolve a possibly-historical preset name to its firmware name. */
export function canonicalPresetName(name: string): string {
  return PRESET_ALIASES[name] ?? name;
}

/** True when `name` is a stock modem-preset channel. Exact wire-string match on
 *  purpose — aliases are config-side only and never appear on air. */
export function isFirmwarePreset(name: string | undefined | null): boolean {
  return !!name && FIRMWARE_PRESET_NAMES.has(name);
}
