import { describe, expect, it } from "vitest";

import { FIRMWARE_PRESET_NAMES, isFirmwarePreset } from "./meshtasticPresets";

describe("isFirmwarePreset", () => {
  it("recognizes every name firmware emits", () => {
    for (const name of [
      "ShortTurbo", "ShortFast", "ShortSlow",
      "MediumFast", "MediumSlow",
      "LongFast", "LongMod", "LongSlow", "LongTurbo",
    ]) {
      expect(isFirmwarePreset(name)).toBe(true);
    }
  });

  it("treats community channel names as custom", () => {
    for (const name of ["Test", "SVComm", "DiabloView", "turlock.onl", "NCAlerts"]) {
      expect(isFirmwarePreset(name)).toBe(false);
    }
  });

  it("treats unresolved placeholder labels as custom", () => {
    // A bucket whose name never healed off the wire must not be promoted.
    expect(isFirmwarePreset("Channel 50")).toBe(false);
    expect(isFirmwarePreset("General")).toBe(false);
  });

  it("is exact, not fuzzy", () => {
    // Case and spacing matter: these are wire strings, not display text.
    expect(isFirmwarePreset("longfast")).toBe(false);
    expect(isFirmwarePreset("Long Fast")).toBe(false);
    expect(isFirmwarePreset("LongFast2")).toBe(false);
  });

  it("handles absent names", () => {
    expect(isFirmwarePreset(undefined)).toBe(false);
    expect(isFirmwarePreset(null)).toBe(false);
    expect(isFirmwarePreset("")).toBe(false);
  });

  it("excludes the two names liveCoveragePresets wrongly carries", () => {
    // Neither appears in any firmware build; both hash to buckets that can
    // never populate. Pinned so a future "sync with the RF table" does not
    // quietly reintroduce them.
    expect(FIRMWARE_PRESET_NAMES.has("LongModerate")).toBe(false);
    expect(FIRMWARE_PRESET_NAMES.has("VeryLongSlow")).toBe(false);
  });
});
