import { describe, expect, it } from "vitest";

import { bilinearMarginQ8, gridFraction, marginQ8At, quantizeMargin } from "./cache";

const bounds = { west: -120, south: 35, east: -119, north: 36 };

describe("quantizeMargin", () => {
  it("round-trips margins at 0.25 dB steps within the clamp range", () => {
    const m = new Float32Array([-20, -5.25, 0, 12.5, 25, 43.5]);
    const q = quantizeMargin(m);
    for (let i = 0; i < m.length; i++) {
      expect((q[i] - 1) / 4 - 20).toBeCloseTo(m[i], 5);
    }
  });

  it("maps NaN to the 0 sentinel", () => {
    expect(quantizeMargin(new Float32Array([Number.NaN]))[0]).toBe(0);
  });
});

describe("gridFraction (pixel-center registration)", () => {
  const width = 4;
  const height = 4;

  it("inverts renderCoverageRaster's west + (i + 0.5) * step sampling exactly", () => {
    const lng = bounds.west + (1.5 / width) * (bounds.east - bounds.west);
    const lat = bounds.north - (2.5 / height) * (bounds.north - bounds.south);
    const f = gridFraction(bounds, width, height, lng, lat)!;
    expect(f.fx).toBeCloseTo(1, 6);
    expect(f.fy).toBeCloseTo(2, 6);
  });

  it("clamps the outer half-pixel to the edge center and rejects beyond bounds", () => {
    const f = gridFraction(bounds, width, height, bounds.west, bounds.north)!;
    expect(f.fx).toBe(0);
    expect(f.fy).toBe(0);
    expect(gridFraction(bounds, width, height, bounds.west - 0.01, 35.5)).toBeNull();
  });

  it("shifts ±360 into a seam-straddling (unwrapped) frame", () => {
    const seam = { west: 178, south: -20, east: 182, north: -16 };
    // -179.5° lives inside [178, 182] as +180.5°
    const f = gridFraction(seam, width, height, -179.5, -18);
    expect(f).not.toBeNull();
    expect(f!.fx).toBeCloseTo(((180.5 - 178) / 4) * width - 0.5, 6);
  });
});

describe("marginQ8At", () => {
  it("returns exact values at pixel centers", () => {
    const data = quantizeMargin(new Float32Array([0, 4, 8, 12]));
    const g = { data, width: 2, height: 2, bounds };
    const lngAt = (i: number) => bounds.west + ((i + 0.5) / 2) * (bounds.east - bounds.west);
    const latAt = (j: number) => bounds.north - ((j + 0.5) / 2) * (bounds.north - bounds.south);
    expect(marginQ8At(g, lngAt(0), latAt(0))).toBeCloseTo(0, 5);
    expect(marginQ8At(g, lngAt(1), latAt(0))).toBeCloseTo(4, 5);
    expect(marginQ8At(g, lngAt(0), latAt(1))).toBeCloseTo(8, 5);
    expect(marginQ8At(g, lngAt(1), latAt(1))).toBeCloseTo(12, 5);
  });

  it("is NaN outside bounds and where a corner holds the sentinel", () => {
    const g = { data: new Uint8Array([81, 97, 113, 0]), width: 2, height: 2, bounds };
    expect(Number.isNaN(marginQ8At(g, bounds.west - 1, 35.5))).toBe(true);
    // interior sample touches the 0-sentinel corner
    expect(Number.isNaN(marginQ8At(g, (bounds.west + bounds.east) / 2, 35.5))).toBe(true);
  });
});

describe("bilinearMarginQ8", () => {
  it("propagates the NaN sentinel from any corner", () => {
    expect(Number.isNaN(bilinearMarginQ8(0, 100, 100, 100, 0.5, 0.5))).toBe(true);
  });

  it("interpolates between corners", () => {
    // q=81 → 0 dB, q=97 → 4 dB; midpoint → 2 dB
    expect(bilinearMarginQ8(81, 97, 81, 97, 0.5, 0)).toBeCloseTo(2, 6);
  });
});
