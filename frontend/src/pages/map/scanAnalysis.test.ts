import { describe, expect, it } from "vitest";

import { runScan, type ScanResult, scanSortKey, type ScanSummary,scanToGeoJSON } from "./scanAnalysis";

function mkResult(over: Partial<ScanResult>): ScanResult {
  return {
    id: "x", position: [0, 0], distanceKm: 1, cls: "clear",
    rssiDbm: -100, marginDb: 10, diffractionLossDb: 0, losBlocked: false, fresnelIntruded: false,
    ...over,
  };
}

describe("scanSortKey", () => {
  it("ranks reachable above blocked", () => {
    const reachable = mkResult({ cls: "clear", marginDb: -5, distanceKm: 199 });
    const blocked = mkResult({ cls: "blocked", marginDb: -1, distanceKm: 1 });
    expect(scanSortKey(reachable)).toBeGreaterThan(scanSortKey(blocked));
  });

  it("orders blocked targets nearest-first (documented intent)", () => {
    const near = mkResult({ cls: "blocked", distanceKm: 1 });
    const far = mkResult({ cls: "blocked", distanceKm: 150 });
    // Descending sort by key → nearest must produce the LARGER key.
    expect(scanSortKey(near)).toBeGreaterThan(scanSortKey(far));
  });

  it("orders reachable by margin descending", () => {
    const strong = mkResult({ marginDb: 30, distanceKm: 10 });
    const weak = mkResult({ marginDb: 3, distanceKm: 10 });
    expect(scanSortKey(strong)).toBeGreaterThan(scanSortKey(weak));
  });
});

describe("scanToGeoJSON", () => {
  it("unwraps a seam-crossing link the short way (not around the globe)", () => {
    const summary: ScanSummary = {
      origin: [179.9, 1],
      results: [mkResult({ id: "b", position: [-179.9, 1] })],
      clearCount: 1, fresnelCount: 0, diffractedCount: 0, blockedCount: 0,
    };
    const fc = scanToGeoJSON(summary);
    const coords = fc.features[0].geometry.coordinates as [number, number][];
    expect(coords[0][0]).toBe(179.9);
    // Target unwrapped to ~180.1 (short hop across the seam), not -179.9.
    expect(coords[1][0]).toBeCloseTo(180.1, 6);
  });

  it("assigns stable feature ids matching result order", () => {
    const summary: ScanSummary = {
      origin: [0, 0],
      results: [mkResult({ id: "a" }), mkResult({ id: "b" })],
      clearCount: 2, fresnelCount: 0, diffractedCount: 0, blockedCount: 0,
    };
    const fc = scanToGeoJSON(summary);
    expect(fc.features.map((f) => f.id)).toEqual([0, 1]);
  });
});

describe("runScan", () => {
  const flatTerrain = () => 0;

  it("includes a co-located target instead of silently dropping it", () => {
    const summary = runScan({
      origin: [10, 10],
      originAltitudeM: 30,
      targets: [
        { id: "same", position: [10, 10], altitudeM: 30 },
        { id: "near", position: [10.05, 10], altitudeM: 30 },
      ],
      queryTerrainM: flatTerrain,
    });
    const ids = summary.results.map((r) => r.id);
    expect(ids).toContain("same");
    expect(ids).toContain("near");
    expect(summary.results.length).toBe(2);
  });

  it("applies the maxDistanceKm cutoff", () => {
    const summary = runScan({
      origin: [10, 10],
      originAltitudeM: 30,
      targets: [
        { id: "inside", position: [10.1, 10], altitudeM: 30 },
        { id: "outside", position: [20, 10], altitudeM: 30 },
      ],
      queryTerrainM: flatTerrain,
      maxDistanceKm: 50,
    });
    const ids = summary.results.map((r) => r.id);
    expect(ids).toContain("inside");
    expect(ids).not.toContain("outside");
  });

  it("does not sweep the globe for a seam-crossing pair (antimeridian-safe)", () => {
    // A ~22 km neighbour across the seam. A raw linear lerp would sample terrain
    // ~360° the wrong way; the seam-safe interp keeps the run finite and sane.
    const summary = runScan({
      origin: [179.9, 1],
      originAltitudeM: 30,
      targets: [{ id: "b", position: [-179.9, 1], altitudeM: 30 }],
      queryTerrainM: flatTerrain,
    });
    expect(summary.results.length).toBe(1);
    expect(summary.results[0].distanceKm).toBeLessThan(30);
    expect(Number.isFinite(summary.results[0].rssiDbm)).toBe(true);
  });
});
