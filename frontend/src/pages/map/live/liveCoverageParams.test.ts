import { describe, expect, it } from "vitest";

import { NodeRole } from "../../../types";
import {
  buildLiveCoverageParams,
  CLIENT_TX_DBM,
  ROUTER_TX_DBM,
  txDbmForRole,
} from "./liveCoverageParams";

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
    expect(p.clutterAggression).toBe(0); // clutter off for the live layer
    // typical reliability preset (90/50/70)
    expect(p.timePct).toBe(90);
    expect(p.locationPct).toBe(50);
    expect(p.situationPct).toBe(70);
    // MediumFast SX1262 → -124 dBm, no chipset offset
    expect(p.rxSensitivityDbm).toBe(-124);
  });
});
