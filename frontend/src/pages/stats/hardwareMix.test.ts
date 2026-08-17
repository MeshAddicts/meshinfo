import { describe, expect, it } from "vitest";

import {
  foldHardwareSlices,
  HARDWARE_TOP_N,
  hardwareSlicesFrom,
} from "./hardwareMix";

describe("hardwareSlicesFrom", () => {
  it("returns no slices for missing or empty input", () => {
    expect(hardwareSlicesFrom(undefined)).toEqual([]);
    expect(hardwareSlicesFrom({})).toEqual([]);
  });

  it("resolves enum ids to readable names, commonest first", () => {
    expect(hardwareSlicesFrom({ "9": 5, "43": 10, "110": 7 })).toEqual([
      { name: "HELTEC v3", count: 10 },
      { name: "HELTEC v4", count: 7 },
      { name: "RAK4631", count: 5 },
    ]);
  });

  it("keeps unmapped numeric ids as raw numbers and junk keys as text", () => {
    expect(hardwareSlicesFrom({ "999": 3, HELTEC_V3: 2 })).toEqual([
      { name: "999", count: 3 },
      { name: "HELTEC_V3", count: 2 },
    ]);
  });

  it("merges keys that resolve to the same label", () => {
    expect(hardwareSlicesFrom({ "9": 2, "09": 3 })).toEqual([
      { name: "RAK4631", count: 5 },
    ]);
  });

  it("drops non-positive and non-numeric counts", () => {
    expect(hardwareSlicesFrom({ "9": 0, "43": -1, "4": Number.NaN })).toEqual([]);
  });

  it("skips UNSET (0)", () => {
    expect(hardwareSlicesFrom({ "0": 4, "9": 1 })).toEqual([
      { name: "RAK4631", count: 1 },
    ]);
  });

  it("keeps hex/exponent/float keys as raw text instead of misattributing them", () => {
    expect(hardwareSlicesFrom({ "0x10": 2, "1e2": 3, "9.0": 1 })).toEqual([
      { name: "1e2", count: 3 },
      { name: "0x10", count: 2 },
      { name: "9.0", count: 1 },
    ]);
  });
});

describe("foldHardwareSlices", () => {
  const slices = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `HW${i}`, count: 100 - i }));

  it("passes short lists through untouched", () => {
    expect(foldHardwareSlices(slices(HARDWARE_TOP_N))).toHaveLength(HARDWARE_TOP_N);
    expect(foldHardwareSlices([])).toEqual([]);
  });

  it("folds entries past the top N into Other", () => {
    const folded = foldHardwareSlices(slices(HARDWARE_TOP_N + 2));
    expect(folded).toHaveLength(HARDWARE_TOP_N + 1);
    const other = folded[folded.length - 1];
    expect(other.name).toBe("Other");
    // the two least common entries land in Other
    expect(other.count).toBe(100 - HARDWARE_TOP_N + (100 - (HARDWARE_TOP_N + 1)));
  });

  it("honors a custom top N", () => {
    const folded = foldHardwareSlices(slices(6), 2);
    expect(folded.map((s) => s.name)).toEqual(["HW0", "HW1", "Other"]);
  });
});
