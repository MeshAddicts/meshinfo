import { describe, expect, it } from "vitest";

import { circularMeanLng, interpLngLatUnwrapped, normalizeLng, shortestLngDelta, unwrapLngTo } from "./geo";

describe("geo longitude helpers", () => {
  it("normalizeLng wraps into [-180,180)", () => {
    expect(normalizeLng(190)).toBe(-170);
    expect(normalizeLng(-190)).toBe(170);
    expect(normalizeLng(540)).toBe(-180);
    expect(normalizeLng(-1000)).toBeCloseTo(80, 9);
    expect(normalizeLng(45)).toBe(45);
  });

  it("shortestLngDelta crosses the seam the short way", () => {
    expect(shortestLngDelta(179, -179)).toBe(2);
    expect(shortestLngDelta(-179, 179)).toBe(-2);
    expect(shortestLngDelta(10, 20)).toBe(10);
  });

  it("unwrapLngTo keeps the segment short", () => {
    expect(unwrapLngTo(179, -179)).toBe(181);
    expect(unwrapLngTo(-179, 179)).toBe(-181);
    expect(unwrapLngTo(10, 20)).toBe(20);
  });

  it("circularMeanLng averages across the seam", () => {
    expect(Math.abs(circularMeanLng([179, -179]))).toBeCloseTo(180, 6);
    expect(circularMeanLng([10, 20])).toBeCloseTo(15, 6);
  });

  it("interpLngLatUnwrapped crosses the seam without smearing", () => {
    const mid = interpLngLatUnwrapped([179, 0], [-179, 0], 0.5);
    expect(Math.abs(mid[0])).toBeCloseTo(180, 6);
    const q = interpLngLatUnwrapped([10, 0], [20, 10], 0.5);
    expect(q[0]).toBeCloseTo(15, 6);
    expect(q[1]).toBeCloseTo(5, 6);
  });
});
