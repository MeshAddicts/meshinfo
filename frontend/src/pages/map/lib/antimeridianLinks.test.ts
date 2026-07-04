import { describe, expect, it } from "vitest";

import { demBoundsAround, unionDemBoundsAround } from "../terrain/terrainDEM";
import { commitNumericDraft } from "./helpers";
import { buildAllLinksFeatureCollection } from "./linkFeatures";
import type { IMapNode } from "./types";

describe("commitNumericDraft (C4)", () => {
  it("clamps, and falls back on blank/garbage", () => {
    expect(commitNumericDraft("25", 10, 35, 22)).toBe(25);
    expect(commitNumericDraft("99", 10, 35, 22)).toBe(35);
    expect(commitNumericDraft("-99", 10, 35, 22)).toBe(10);
    expect(commitNumericDraft("", 10, 35, 22)).toBe(22);
    expect(commitNumericDraft("abc", 10, 35, 22)).toBe(22);
    expect(commitNumericDraft("-133", -150, -100, -130)).toBe(-133);
  });
});

describe("antimeridian link coords (C16)", () => {
  it("draws an A→B link across ±180 the short way", () => {
    const nodes: Record<string, IMapNode> = {
      a: {
        map_position: [179, 1],
        neighbors: [{ id: "b", snr: 5 }],
      } as unknown as IMapNode,
      b: {
        map_position: [-179, 1],
        neighbors: [],
      } as unknown as IMapNode,
    };
    const fc = buildAllLinksFeatureCollection(nodes);
    expect(fc.features.length).toBe(1);
    const coords = fc.features[0].geometry.coordinates as [number, number][];
    // from stays 179; to is unwrapped to 181 (short way), not -179 (long way)
    expect(coords[0][0]).toBe(179);
    expect(coords[coords.length - 1][0]).toBeCloseTo(181, 6);
  });
});

describe("unionDemBoundsAround (C6)", () => {
  it("single center equals demBoundsAround", () => {
    const u = unionDemBoundsAround([[0, 0]], 200);
    const d = demBoundsAround([0, 0], 200);
    expect(u).toEqual(d);
  });

  it("seam-straddling origins stay a tight continuous bbox, not near-global", () => {
    const u = unionDemBoundsAround([[179, 0], [-179, 0]], 200);
    expect(u.west).toBeLessThan(u.east);
    expect(u.east - u.west).toBeLessThan(10); // not ~360
  });

  it("normal nearby origins union as usual", () => {
    const u = unionDemBoundsAround([[10, 0], [11, 0]], 50);
    expect(u.west).toBeLessThan(10);
    expect(u.east).toBeGreaterThan(11);
  });
});
