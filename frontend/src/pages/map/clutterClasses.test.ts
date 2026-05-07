/**
 * Unit tests for ITU-R P.452-17 §4.5.4 endpoint clutter and P.833-9 §4.1 MED
 * vegetation loss. Worked examples in RF-MODEL.md were derived from the same
 * formulas, so these tests double as a numerical regression suite.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import {
  classForId,
  type ClutterClass,
  endpointClutterDb,
  freqFactor,
  NLCD_CLASSES,
  NLCD_DEFAULT_CLASS_ID,
  vegetationPathLossDb,
} from "./clutterClasses";

const F_915 = 915;

describe("freqFactor (P.452-17 §4.5.4 F_fc)", () => {
  it("≈ 0.9986 at 915 MHz", () => {
    expect(freqFactor(F_915)).toBeCloseTo(0.9986, 3);
  });

  it("≈ 0.9974 at 868 MHz (EU band)", () => {
    expect(freqFactor(868)).toBeCloseTo(0.9974, 3);
  });

  it("saturates near 1.0 at 2400 MHz", () => {
    expect(freqFactor(2400)).toBeGreaterThan(0.999);
    expect(freqFactor(2400)).toBeLessThanOrEqual(1.0);
  });

  it("approaches 0.25 at very low frequency", () => {
    // f → 0: tanh(7.5·(0 - 0.5)) = tanh(-3.75) ≈ -0.99887, so F_fc ≈ 0.25 + 0.375·0.00113
    expect(freqFactor(1)).toBeCloseTo(0.25, 2);
  });
});

describe("endpointClutterDb (P.452-17 §4.5.4)", () => {
  // Convenience accessors so each test reads as a physical scenario.
  const denseUrban = NLCD_CLASSES[24];
  const suburban = NLCD_CLASSES[22];
  const evergreen = NLCD_CLASSES[42];
  const deciduous = NLCD_CLASSES[41];
  const water = NLCD_CLASSES[11];

  it("returns 0 for h_a = 0 (water) regardless of antenna height", () => {
    expect(endpointClutterDb(water, 0, F_915)).toBe(0);
    expect(endpointClutterDb(water, 100, F_915)).toBe(0);
  });

  it("dense urban handheld (h=2, h_a=25): ≈ 19.7 dB", () => {
    expect(endpointClutterDb(denseUrban, 2, F_915)).toBeCloseTo(19.71, 1);
  });

  it("dense urban tower (h=30, h_a=25): clamped to 0", () => {
    expect(endpointClutterDb(denseUrban, 30, F_915)).toBe(0);
  });

  it("suburban handheld (h=2, h_a=9): ≈ 19.5 dB", () => {
    expect(endpointClutterDb(suburban, 2, F_915)).toBeCloseTo(19.48, 1);
  });

  it("suburban above clutter (h=10, h_a=9): clamped to 0", () => {
    expect(endpointClutterDb(suburban, 10, F_915)).toBe(0);
  });

  it("evergreen handheld (h=2, h_a=20): ≈ 19.1 dB", () => {
    expect(endpointClutterDb(evergreen, 2, F_915)).toBeCloseTo(19.11, 1);
  });

  it("evergreen above canopy (h=25, h_a=20): clamped to 0", () => {
    expect(endpointClutterDb(evergreen, 25, F_915)).toBe(0);
  });

  it("monotonically non-increasing as antenna rises through the clutter layer", () => {
    let prev = Infinity;
    for (const h of [0, 1, 2, 5, 10, 15, 20, 30]) {
      const a = endpointClutterDb(deciduous, h, F_915);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
  });

  it("never returns a negative value (clamp at 0)", () => {
    // Sweep 100 (class, height) pairs; clamp must hold everywhere.
    for (const cls of Object.values(NLCD_CLASSES)) {
      for (const h of [0, 0.5, 1, 2, 5, 10, 20, 50, 100, 1000]) {
        expect(endpointClutterDb(cls, h, F_915)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("clamps negative antenna height to 0 instead of producing garbage", () => {
    const a0 = endpointClutterDb(deciduous, 0, F_915);
    const aNeg = endpointClutterDb(deciduous, -5, F_915);
    expect(aNeg).toBeCloseTo(a0, 6);
  });
});

describe("vegetationPathLossDb (P.833-9 §4.1 MED)", () => {
  const evergreen = NLCD_CLASSES[42]; // γ=0.7, A=27
  const water = NLCD_CLASSES[11];
  const denseUrban = NLCD_CLASSES[24];
  const grassland = NLCD_CLASSES[71];

  it("returns 0 for non-penetrable classes (water, built-up, grassland)", () => {
    expect(vegetationPathLossDb(water, 1000)).toBe(0);
    expect(vegetationPathLossDb(denseUrban, 1000)).toBe(0);
    expect(vegetationPathLossDb(grassland, 1000)).toBe(0);
  });

  it("returns 0 for d ≤ 0", () => {
    expect(vegetationPathLossDb(evergreen, 0)).toBe(0);
    expect(vegetationPathLossDb(evergreen, -10)).toBe(0);
  });

  it("evergreen 10 m graze: ≈ 6.2 dB", () => {
    expect(vegetationPathLossDb(evergreen, 10)).toBeCloseTo(6.17, 1);
  });

  it("evergreen 50 m: ≈ 19.6 dB (worked example in design doc)", () => {
    expect(vegetationPathLossDb(evergreen, 50)).toBeCloseTo(19.62, 1);
  });

  it("evergreen 200 m: ≈ 26.9 dB (near saturation)", () => {
    expect(vegetationPathLossDb(evergreen, 200)).toBeCloseTo(26.85, 1);
  });

  it("evergreen 1000 m: saturates at A = 27 dB", () => {
    const L = vegetationPathLossDb(evergreen, 1000);
    expect(L).toBeGreaterThan(26.99);
    expect(L).toBeLessThanOrEqual(27.0);
  });

  it("L → A as d → ∞", () => {
    const L = vegetationPathLossDb(evergreen, 1e6);
    expect(L).toBeCloseTo(27, 6);
  });

  it("monotonically non-decreasing in d", () => {
    let prev = -Infinity;
    for (const d of [0, 1, 5, 10, 50, 100, 500, 5000]) {
      const L = vegetationPathLossDb(evergreen, d);
      expect(L).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = L;
    }
  });

  it("never exceeds the class saturation A", () => {
    for (const cls of Object.values(NLCD_CLASSES).filter((c) => c.penetrable)) {
      const L = vegetationPathLossDb(cls, 1e6);
      expect(L).toBeLessThanOrEqual(cls.vegSaturationDb + 1e-9);
    }
  });
});

describe("classForId + NLCD_CLASSES table integrity", () => {
  it("default class is 43 (Mixed Forest)", () => {
    expect(NLCD_DEFAULT_CLASS_ID).toBe(43);
    expect(NLCD_CLASSES[43]).toBeDefined();
    expect(NLCD_CLASSES[43].label).toMatch(/Mixed Forest/i);
  });

  it("returns the matching class for known IDs", () => {
    expect(classForId(42).label).toMatch(/Evergreen/);
    expect(classForId(11).label).toMatch(/Water/);
  });

  it("falls back to default class for unknown IDs", () => {
    // 0 = nodata sentinel; 99 / 100 / 200 are unused in the NLCD legend.
    for (const id of [0, 99, 100, 200, 255]) {
      expect(classForId(id).id).toBe(NLCD_DEFAULT_CLASS_ID);
    }
  });

  it("every entry's key matches its id field", () => {
    for (const [key, cls] of Object.entries(NLCD_CLASSES)) {
      expect(cls.id).toBe(Number(key));
    }
  });

  it("penetrable classes have non-zero gamma and A; non-penetrable have both zero", () => {
    for (const cls of Object.values(NLCD_CLASSES)) {
      if (cls.penetrable) {
        expect(cls.vegAttenuationDbPerM).toBeGreaterThan(0);
        expect(cls.vegSaturationDb).toBeGreaterThan(0);
      } else {
        expect(cls.vegAttenuationDbPerM).toBe(0);
        expect(cls.vegSaturationDb).toBe(0);
      }
    }
  });

  it("contains all CONUS NLCD classes documented in the design", () => {
    const expectedIds = [11, 12, 21, 22, 23, 24, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95];
    for (const id of expectedIds) {
      expect(NLCD_CLASSES[id]).toBeDefined();
    }
  });

  it("readonly type — runtime guarantees not enforced, just spot-check structure", () => {
    // Sanity that every row has the full ClutterClass shape.
    const required: (keyof ClutterClass)[] = [
      "id", "label", "nominalHeightM", "nominalDistanceKm",
      "vegAttenuationDbPerM", "vegSaturationDb", "penetrable",
    ];
    for (const cls of Object.values(NLCD_CLASSES)) {
      for (const k of required) {
        expect(cls).toHaveProperty(k);
      }
    }
  });
});
