/**
 * Tests for canopyTiles.ts. Network calls are stubbed via global `fetch`;
 * the raster build path runs without OffscreenCanvas (404 path only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetCanopyCacheForTests,
  buildCanopyRaster,
  type CanopyRaster,
  downsampleCanopyRaster,
  sampleCanopyAt,
  selectCanopyZoom,
} from "./canopyTiles";
import type { DEMBounds } from "./terrainDEM";

const CA_BBOX: DEMBounds = { west: -120, east: -119, south: 36, north: 37 };

describe("selectCanopyZoom", () => {
  it("picks a higher zoom for a smaller bbox at the same target px size", () => {
    const small: DEMBounds = { west: -120, east: -119.9, south: 36, north: 36.1 };
    const big: DEMBounds = { west: -125, east: -115, south: 36, north: 46 };
    expect(selectCanopyZoom(small, 30)).toBeGreaterThanOrEqual(selectCanopyZoom(big, 30));
  });

  it("clamps at MAX_ZOOM (12)", () => {
    expect(selectCanopyZoom(CA_BBOX, 0.1)).toBeLessThanOrEqual(12);
  });
});

function buildSyntheticRaster(opts: {
  width: number;
  height: number;
  heights: number[]; // row-major; length width*height
  std?: number[];    // row-major; same length
  mask?: number[];   // 1 = valid, 0 = nodata
}): CanopyRaster {
  const { width, height, heights } = opts;
  if (heights.length !== width * height) throw new Error("len mismatch");
  return {
    heightM: Float32Array.from(heights),
    stdM: Float32Array.from(opts.std ?? new Array(width * height).fill(0)),
    mask: Float32Array.from(opts.mask ?? new Array(width * height).fill(1)),
    width,
    height,
    bounds: CA_BBOX,
    tilesPresent: 1,
    tilesTotal: 1,
  };
}

describe("sampleCanopyAt — bilinear over valid pixels", () => {
  // 2×2 raster covering CA_BBOX with corner heights [10, 20 | 30, 40]
  //   row 0 (north): 10 (W), 20 (E)
  //   row 1 (south): 30 (W), 40 (E)
  const raster = buildSyntheticRaster({
    width: 2,
    height: 2,
    heights: [10, 20, 30, 40],
  });

  it("returns north-west corner exactly", () => {
    const s = sampleCanopyAt(raster, CA_BBOX.west, CA_BBOX.north);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(10, 5);
  });

  it("returns south-east corner exactly", () => {
    const s = sampleCanopyAt(raster, CA_BBOX.east, CA_BBOX.south);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(40, 5);
  });

  it("interpolates the centre as the mean of all four corners", () => {
    const midLng = (CA_BBOX.west + CA_BBOX.east) / 2;
    const midLat = (CA_BBOX.north + CA_BBOX.south) / 2;
    const s = sampleCanopyAt(raster, midLng, midLat);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(25, 5);
  });

  it("returns null for out-of-bounds queries", () => {
    expect(sampleCanopyAt(raster, -130, 36.5)).toBeNull();
    expect(sampleCanopyAt(raster, -119.5, 50)).toBeNull();
  });
});

describe("sampleCanopyAt — nodata-aware blending", () => {
  it("returns null when every neighbour is masked off", () => {
    const raster = buildSyntheticRaster({
      width: 2,
      height: 2,
      heights: [10, 20, 30, 40],
      mask: [0, 0, 0, 0],
    });
    expect(sampleCanopyAt(raster, -119.5, 36.5)).toBeNull();
  });

  it("uses only the valid neighbour when one corner is masked off", () => {
    // Three corners 10 m valid, NW corner nodata. Sample at NW corner: must NOT
    // return the NW value; bilinear weights collapse to neighbours.
    const raster = buildSyntheticRaster({
      width: 2,
      height: 2,
      heights: [99, 10, 10, 10],
      mask: [0, 1, 1, 1],
    });
    // Sample slightly inside the bbox so all four corners contribute.
    const s = sampleCanopyAt(raster, CA_BBOX.west + 0.1, CA_BBOX.north - 0.1);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeLessThan(20); // would-be 99 corner is excluded
  });
});

describe("downsampleCanopyRaster", () => {
  it("preserves bilinear means under downsample", () => {
    const src = buildSyntheticRaster({
      width: 4,
      height: 4,
      heights: [
        10, 10, 10, 10,
        10, 10, 10, 10,
        10, 10, 10, 10,
        10, 10, 10, 10,
      ],
    });
    const ds = downsampleCanopyRaster(src, 2, 2);
    expect(ds.width).toBe(2);
    expect(ds.height).toBe(2);
    for (let i = 0; i < 4; i++) expect(ds.heightM[i]).toBeCloseTo(10, 5);
    for (let i = 0; i < 4; i++) expect(ds.mask[i]).toBe(1);
  });
});

describe("buildCanopyRaster — out-of-bbox (all tiles 404)", () => {
  beforeEach(() => {
    _resetCanopyCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a zero raster with mask=0 when every tile 404s", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const raster = await buildCanopyRaster({
      bounds: CA_BBOX,
      targetWidth: 16,
      targetHeight: 16,
    });
    expect(raster.width).toBe(16);
    expect(raster.height).toBe(16);
    expect(raster.tilesPresent).toBe(0);
    expect(raster.tilesTotal).toBeGreaterThan(0);
    // No measured heights; consumer must fall back to class-nominal.
    expect(raster.heightM.every((v) => v === 0)).toBe(true);
    expect(raster.mask.every((v) => v === 0)).toBe(true);
  });

  it("does not throw on transient network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const raster = await buildCanopyRaster({
      bounds: CA_BBOX,
      targetWidth: 16,
      targetHeight: 16,
    });
    expect(raster.tilesPresent).toBe(0);
    expect(raster.heightM.every((v) => v === 0)).toBe(true);
    expect(raster.mask.every((v) => v === 0)).toBe(true);
  });
});
