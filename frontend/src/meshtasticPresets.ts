/**
 * The channel names Meshtastic firmware itself emits.
 *
 * A channel's name is half of its id: `channel_id = xorHash(name) ^ xorHash(psk)`.
 * Firmware substitutes the modem-preset display string when a channel's name
 * field is blank (`Channels::getName`), so a node that was never renamed
 * reports one of these. Anything else is a name a human typed — a community,
 * regional, or private channel.
 *
 * Source of truth is firmware's `DisplayFormatters.cpp`. Note this list is
 * deliberately NOT taken from `liveCoveragePresets.ts`, whose keys include
 * `LongModerate` and `VeryLongSlow` — strings no firmware emits — and omit
 * `LongTurbo`, which is live on air today.
 */
export interface FirmwareModemPreset {
  /** Firmware display string == the wire channel name an unnamed channel hashes. */
  name: string;
  /** Two-letter chip label ("LF", "LT", ...). */
  short: string;
  sf: number;
  bwKhz: number;
  cr: number;
  /** Typical real-world SX1262 sensitivity (datasheet + 3 dB) — the value
   *  link-budget math uses. */
  sensitivityDbm: number;
  /** SX1262 datasheet spec sensitivity. */
  datasheetSensitivityDbm: number;
}

/**
 * The canonical modem-preset table, verified against firmware source:
 * names from `DisplayFormatters.cpp`, RF parameters from `MeshRadio.h`'s
 * `modemPresetToParams()`. Sensitivities follow the Semtech ladder anchored to
 * the long-standing tool values (−3 dB per SF step, +3 dB per BW halving;
 * LongSlow's −134 is the tools' historical anchor, kept as-is).
 *
 * Every other preset list in the app derives from this one — the live-coverage
 * sensitivity table and the interactive tool presets both import it. Do not
 * fork a new copy.
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
 * Historical preset names -> the firmware name to treat them as. Operator
 * configs written against older MeshInfo docs carry these in
 * `broker.channels.meta.<hash>.preset`; they must keep working.
 *
 *  - "LongModerate": the enum's long name; firmware's display string (and
 *    therefore the wire channel name) has always been "LongMod". Same RF.
 *  - "VeryLongSlow": removed upstream — current firmware has neither a display
 *    case nor a modemPresetToParams case for it, so a node still configured
 *    with it transmits with the DEFAULT (LongFast) parameters. Mapping it to
 *    LongFast matches what the radio actually does.
 */
export const PRESET_ALIASES: Readonly<Record<string, string>> = {
  LongModerate: "LongMod",
  VeryLongSlow: "LongFast",
};

/** Resolve a possibly-historical preset name to its firmware name. */
export function canonicalPresetName(name: string): string {
  return PRESET_ALIASES[name] ?? name;
}

/** True when `name` is a stock modem-preset channel rather than a custom one.
 *  Exact wire-string match on purpose — aliases are config-side only and never
 *  appear on air, so they do not count. */
export function isFirmwarePreset(name: string | undefined | null): boolean {
  return !!name && FIRMWARE_PRESET_NAMES.has(name);
}
