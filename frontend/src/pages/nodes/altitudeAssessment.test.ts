/**
 * Unit tests for altitude assessment classification + Meshtastic position-precision math.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import {
  classifyAltitude,
  type GroundSample,
  MAX_VALIDATABLE_UNCERTAINTY_M,
  positionUncertaintyM,
} from "./altitudeAssessment";

const ground = (min: number, max: number, center = (min + max) / 2): GroundSample => ({
  min,
  max,
  center,
});

describe("positionUncertaintyM", () => {
  it("treats undefined / full precision as zero uncertainty", () => {
    expect(positionUncertaintyM(undefined)).toBe(0);
    expect(positionUncertaintyM(null)).toBe(0);
    expect(positionUncertaintyM(32)).toBe(0);
    expect(positionUncertaintyM(0)).toBe(0);
  });

  it("matches Meshtastic precision presets (half-step error)", () => {
    expect(positionUncertaintyM(13)).toBeCloseTo(2918, 0); // ~2.9 km
    expect(positionUncertaintyM(16)).toBeCloseTo(365, 0); // ~365 m
    expect(positionUncertaintyM(18)).toBeCloseTo(91, 0); // ~91 m
  });
});

describe("classifyAltitude", () => {
  it("passes a missing reading", () => {
    expect(classifyAltitude(null, ground(2480, 2520)).severity).toBeNull();
    expect(classifyAltitude(undefined, null).severity).toBeNull();
  });

  it("flags the 65535 firmware sentinel as bad", () => {
    const s = classifyAltitude(65535, null);
    expect(s.severity).toBe("bad");
    expect(s.suspectReason).toMatch(/sentinel/);
  });

  it("flags absolutely implausible altitudes as bad", () => {
    expect(classifyAltitude(-501, null).severity).toBe("bad");
    expect(classifyAltitude(50_001, null).severity).toBe("bad");
    expect(classifyAltitude(-500, null).severity).toBeNull(); // boundary is inclusive-OK
  });

  it("skips the terrain check when the position is too imprecise", () => {
    // precision 13 (~2.9 km) > MAX_VALIDATABLE; the +353 m valley false-positive case.
    expect(positionUncertaintyM(13)).toBeGreaterThan(MAX_VALIDATABLE_UNCERTAINTY_M);
    const s = classifyAltitude(2508, ground(2150, 2160, 2155), 13);
    expect(s.severity).toBeNull();
    expect(s.suspectReason).toBeNull();
  });

  it("flags below-terrain readings on precise positions", () => {
    const s = classifyAltitude(100, ground(2000, 2100, 2050), 32);
    expect(s.severity).toBe("bad");
    expect(s.suspectReason).toMatch(/below terrain/);
  });

  it("marks far-above-terrain readings as a neutral note, not bad", () => {
    const s = classifyAltitude(2508, ground(2150, 2160, 2155), 32);
    expect(s.severity).toBe("info");
    expect(s.suspectReason).toMatch(/above terrain/);
  });

  it("passes a node sitting near its (bracketed) terrain", () => {
    // Reported within ground spread + tolerances.
    expect(classifyAltitude(2508, ground(2480, 2520, 2507), 32).severity).toBeNull();
    expect(classifyAltitude(2508, ground(2480, 2520, 2507)).severity).toBeNull();
  });

  it("allows mast/rooftop height above terrain without flagging", () => {
    expect(classifyAltitude(2200 + 100, ground(2200, 2200, 2200), 32).severity).toBeNull();
  });
});
