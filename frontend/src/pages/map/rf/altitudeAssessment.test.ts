/**
 * Unit tests for altitude assessment: MSL/HAE normalization, position-precision math,
 * and terrain classification.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import {
  ALT_SOURCE,
  classifyAltitude,
  effectiveAltitudeMslM,
  type GroundSample,
  LOC_SOURCE,
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

describe("effectiveAltitudeMslM", () => {
  it("prefers the MSL altitude field", () => {
    expect(effectiveAltitudeMslM({ altitude: 2508, altitude_hae: 2478 })).toBe(2508);
  });

  it("falls back to HAE converted via geoidal separation when MSL is absent", () => {
    // MSL = HAE - geoid_sep; geoid ~ -30 m in the western US → MSL ~ HAE + 30.
    expect(effectiveAltitudeMslM({ altitude_hae: 2478, altitude_geoidal_separation: -30 })).toBe(2508);
  });

  it("uses raw HAE when geoidal separation is unknown", () => {
    expect(effectiveAltitudeMslM({ altitude_hae: 2478 })).toBe(2478);
  });

  it("returns null with no usable altitude", () => {
    expect(effectiveAltitudeMslM(null)).toBeNull();
    expect(effectiveAltitudeMslM({})).toBeNull();
  });
});

describe("classifyAltitude", () => {
  it("passes a missing reading", () => {
    expect(classifyAltitude(null, ground(2480, 2520)).severity).toBeNull();
    expect(classifyAltitude({}, null).severity).toBeNull();
  });

  it("flags the 65535 firmware sentinel as bad", () => {
    const s = classifyAltitude({ altitude: 65535 }, null);
    expect(s.severity).toBe("bad");
    expect(s.suspectReason).toMatch(/sentinel/);
  });

  it("flags absolutely implausible altitudes as bad", () => {
    expect(classifyAltitude({ altitude: -501 }, null).severity).toBe("bad");
    expect(classifyAltitude({ altitude: 50_001 }, null).severity).toBe("bad");
    expect(classifyAltitude({ altitude: -500 }, null).severity).toBeNull(); // boundary inclusive-OK
  });

  it("skips the terrain check when the position is too imprecise", () => {
    // precision 13 (~2.9 km) > MAX_VALIDATABLE; the +353 m valley false-positive case.
    expect(positionUncertaintyM(13)).toBeGreaterThan(MAX_VALIDATABLE_UNCERTAINTY_M);
    const s = classifyAltitude({ altitude: 2508, precision_bits: 13 }, ground(2150, 2160, 2155));
    expect(s.severity).toBeNull();
    expect(s.suspectReason).toBeNull();
  });

  it("flags below-terrain readings on precise positions", () => {
    const s = classifyAltitude({ altitude: 100, precision_bits: 32 }, ground(2000, 2100, 2050));
    expect(s.severity).toBe("bad");
    expect(s.suspectReason).toMatch(/below terrain/);
  });

  it("marks far-above-terrain readings as a neutral note, not bad", () => {
    const s = classifyAltitude({ altitude: 2508, precision_bits: 32 }, ground(2150, 2160, 2155));
    expect(s.severity).toBe("info");
    expect(s.suspectReason).toMatch(/above terrain/);
  });

  it("relabels manually-set readings but still flags them", () => {
    const s = classifyAltitude(
      { altitude: 100, precision_bits: 32, location_source: LOC_SOURCE.MANUAL },
      ground(2000, 2100, 2050),
    );
    expect(s.severity).toBe("bad");
    expect(s.suspectReason).toMatch(/Manually-set/);
  });

  it("widens tolerance for barometric altitude sources", () => {
    // 130 m above terrain: would be 'info' for GPS (>120), but within barometric slack (120+60).
    const g = ground(2000, 2000, 2000);
    expect(classifyAltitude({ altitude: 2130, precision_bits: 32 }, g).severity).toBe("info");
    expect(
      classifyAltitude({ altitude: 2130, precision_bits: 32, altitude_source: ALT_SOURCE.BAROMETRIC }, g).severity,
    ).toBeNull();
  });

  it("normalizes an HAE-only node before comparing to terrain", () => {
    // HAE 2478 + geoid -30 → MSL 2508, sitting right on 2507 terrain → fine (no false flag).
    const s = classifyAltitude(
      { altitude_hae: 2478, altitude_geoidal_separation: -30, precision_bits: 32 },
      ground(2490, 2520, 2507),
    );
    expect(s.reportedM).toBe(2508);
    expect(s.severity).toBeNull();
  });

  it("passes a node sitting near its (bracketed) terrain", () => {
    expect(classifyAltitude({ altitude: 2508, precision_bits: 32 }, ground(2480, 2520, 2507)).severity).toBeNull();
    expect(classifyAltitude({ altitude: 2508 }, ground(2480, 2520, 2507)).severity).toBeNull();
  });

  it("allows mast/rooftop height above terrain without flagging", () => {
    expect(classifyAltitude({ altitude: 2300, precision_bits: 32 }, ground(2200, 2200, 2200)).severity).toBeNull();
  });
});
