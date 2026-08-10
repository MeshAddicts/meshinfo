import { describe, expect, it } from "vitest";

import { NodeRole } from "../../../types";
import {
  buildLiveCoverageParams,
  CLIENT_TX_DBM,
  ROUTER_TX_DBM,
  txDbmForRole,
} from "./liveCoverageParams";
import {
  DEFAULT_LIVE_PRESET,
  LIVE_PRESET_SENSITIVITY_DBM,
  presetSensitivityDbm,
  presetShortLabel,
} from "./liveCoveragePresets";

describe("txDbmForRole", () => {
  it("uses the high-power class for dedicated routers/repeaters", () => {
    expect(txDbmForRole(NodeRole.ROUTER)).toBe(ROUTER_TX_DBM);
    expect(txDbmForRole(NodeRole.ROUTER_LATE)).toBe(ROUTER_TX_DBM);
    expect(txDbmForRole(NodeRole.REPEATER)).toBe(ROUTER_TX_DBM);
  });

  it("uses the conservative class for everything else (incl. undefined)", () => {
    expect(txDbmForRole(NodeRole.CLIENT)).toBe(CLIENT_TX_DBM);
    expect(txDbmForRole(NodeRole.SENSOR)).toBe(CLIENT_TX_DBM);
    expect(txDbmForRole(NodeRole.TRACKER)).toBe(CLIENT_TX_DBM);
    expect(txDbmForRole(undefined)).toBe(CLIENT_TX_DBM);
  });
});

describe("buildLiveCoverageParams", () => {
  it("passes the given TX through and uses the fixed live profile", () => {
    const p = buildLiveCoverageParams(ROUTER_TX_DBM);
    expect(p.txDbm).toBe(33);
    expect(p.freqMhz).toBe(915);
    expect(p.clutterAggression).toBe(0); // clutter off unless the caller opts in
    // typical reliability preset (90/50/70)
    expect(p.timePct).toBe(90);
    expect(p.locationPct).toBe(50);
    expect(p.situationPct).toBe(70);
    // default preset = LongFast SX1262, no chipset offset
    expect(p.rxSensitivityDbm).toBe(-130);
  });

  it("swaps RX sensitivity per modem preset", () => {
    expect(buildLiveCoverageParams(ROUTER_TX_DBM, 0, "MediumFast").rxSensitivityDbm).toBe(-124);
    expect(buildLiveCoverageParams(ROUTER_TX_DBM, 0, "MediumSlow").rxSensitivityDbm).toBe(-127);
    // unknown preset falls back to the default, never NaN
    expect(buildLiveCoverageParams(ROUTER_TX_DBM, 0, "NotAPreset").rxSensitivityDbm).toBe(-130);
  });
});

describe("liveCoveragePresets", () => {
  it("orders sensitivities along the SF/BW ladder (slower = more sensitive)", () => {
    const ladder = [
      "ShortTurbo",
      "ShortFast",
      "ShortSlow",
      "MediumFast",
      "MediumSlow",
      "LongFast",
      "LongMod",
      "LongSlow",
    ];
    for (let i = 1; i < ladder.length; i++) {
      expect(LIVE_PRESET_SENSITIVITY_DBM[ladder[i]]).toBeLessThan(LIVE_PRESET_SENSITIVITY_DBM[ladder[i - 1]]);
    }
    // LongTurbo (SF11/500) sits off the SF/BW ladder: same RX class as MediumSlow.
    expect(LIVE_PRESET_SENSITIVITY_DBM["LongTurbo"]).toBe(
      LIVE_PRESET_SENSITIVITY_DBM["MediumSlow"]
    );
  });

  it("falls back to the default preset for unknown ids", () => {
    expect(presetSensitivityDbm("SacValleyCustom")).toBe(LIVE_PRESET_SENSITIVITY_DBM[DEFAULT_LIVE_PRESET]);
  });

  it("builds chip labels from preset capitals", () => {
    expect(presetShortLabel("MediumFast")).toBe("MF");
    expect(presetShortLabel("LongTurbo")).toBe("LT");
    // Historical spellings resolve through PRESET_ALIASES first.
    expect(presetShortLabel("LongModerate")).toBe("LM");
    expect(presetShortLabel("VeryLongSlow")).toBe("LF"); // alias models the RF fallback
    expect(presetShortLabel("weird")).toBe("WE");
  });
});
