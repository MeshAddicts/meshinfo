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
export const FIRMWARE_PRESET_NAMES: ReadonlySet<string> = new Set([
  "ShortTurbo",
  "ShortFast",
  "ShortSlow",
  "MediumFast",
  "MediumSlow",
  "LongFast",
  "LongMod",
  "LongSlow",
  "LongTurbo",
]);

/** True when `name` is a stock modem-preset channel rather than a custom one. */
export function isFirmwarePreset(name: string | undefined | null): boolean {
  return !!name && FIRMWARE_PRESET_NAMES.has(name);
}
