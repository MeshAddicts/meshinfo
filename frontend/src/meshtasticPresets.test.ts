import { describe, expect, it } from "vitest";

import {
  FIRMWARE_MODEM_PRESETS,
  FIRMWARE_PRESET_NAMES,
  canonicalPresetName,
  isFirmwarePreset,
} from "./meshtasticPresets";

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

  it("excludes the two historical names no firmware emits", () => {
    // Neither string is emitted by any firmware build, so their buckets only
    // populate if someone literally NAMES a channel that way. Pinned so a
    // future edit does not quietly reintroduce them — they live in
    // PRESET_ALIASES instead.
    expect(FIRMWARE_PRESET_NAMES.has("LongModerate")).toBe(false);
    expect(FIRMWARE_PRESET_NAMES.has("VeryLongSlow")).toBe(false);
  });
});

describe("FIRMWARE_MODEM_PRESETS (canonical RF table)", () => {
  it("carries firmware MeshRadio.h parameters", () => {
    const by = Object.fromEntries(FIRMWARE_MODEM_PRESETS.map((p) => [p.name, p]));
    // Spot-pins from modemPresetToParams(): the two easy-to-fork entries.
    expect(by.LongTurbo).toMatchObject({ sf: 11, bwKhz: 500, cr: 8, sensitivityDbm: -127 });
    expect(by.LongMod).toMatchObject({ sf: 11, bwKhz: 125, cr: 8, sensitivityDbm: -133 });
    expect(by.LongFast).toMatchObject({ sf: 11, bwKhz: 250, cr: 5, sensitivityDbm: -130 });
  });

  it("keeps datasheet sensitivity exactly 3 dB below typical", () => {
    for (const p of FIRMWARE_MODEM_PRESETS) {
      expect(p.datasheetSensitivityDbm).toBe(p.sensitivityDbm - 3);
    }
  });

  it("covers every firmware preset name exactly once", () => {
    expect(FIRMWARE_MODEM_PRESETS.length).toBe(FIRMWARE_PRESET_NAMES.size);
  });
});

describe("canonicalPresetName", () => {
  it("maps historical config spellings to firmware names", () => {
    expect(canonicalPresetName("LongModerate")).toBe("LongMod");
    // VeryLongSlow was removed upstream; firmware falls back to default
    // (LongFast) params for a node still configured with it.
    expect(canonicalPresetName("VeryLongSlow")).toBe("LongFast");
  });

  it("passes firmware names and unknowns through", () => {
    expect(canonicalPresetName("LongTurbo")).toBe("LongTurbo");
    expect(canonicalPresetName("SacValley")).toBe("SacValley");
  });
});
