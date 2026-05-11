/**
 * Tests for buildingTiles.ts. Network calls are stubbed via global `fetch`;
 * the raster build path runs without OffscreenCanvas (404 path only).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _buildingCacheSizeForTests,
  _decodeBuildingPixelsForTests,
  _putBuildingTileForTests,
  _resetBuildingCacheForTests,
  buildBuildingRaster,
  type BuildingRaster,
  type CachedBuildingTile,
  downsampleBuildingRaster,
  sampleBuildingAt,
  selectBuildingZoom,
} from "./buildingTiles";
import type { DEMBounds } from "./terrainDEM";

const CA_BBOX: DEMBounds = { west: -120, east: -119, south: 36, north: 37 };

describe("selectBuildingZoom", () => {
  it("clamps at MAX_ZOOM (10) — GHS-BUILT-H is 100 m native", () => {
    expect(selectBuildingZoom(CA_BBOX, 0.1)).toBeLessThanOrEqual(10);
  });

  it("picks a higher zoom for a smaller bbox at the same target px size", () => {
    const small: DEMBounds = { west: -120, east: -119.9, south: 36, north: 36.1 };
    const big: DEMBounds = { west: -125, east: -115, south: 36, north: 46 };
    expect(selectBuildingZoom(small, 30)).toBeGreaterThanOrEqual(selectBuildingZoom(big, 30));
  });
});

function buildSyntheticRaster(opts: {
  width: number;
  height: number;
  heights: number[];
  mask?: number[];
}): BuildingRaster {
  const { width, height, heights } = opts;
  if (heights.length !== width * height) throw new Error("len mismatch");
  return {
    heightM: Float32Array.from(heights),
    mask: Float32Array.from(opts.mask ?? new Array(width * height).fill(1)),
    width,
    height,
    bounds: CA_BBOX,
    tilesPresent: 1,
    tilesTotal: 1,
  };
}

describe("sampleBuildingAt — bilinear over valid pixels", () => {
  // 2×2 raster covering CA_BBOX with corner heights [10, 20 | 30, 40]
  const raster = buildSyntheticRaster({
    width: 2,
    height: 2,
    heights: [10, 20, 30, 40],
  });

  it("returns north-west corner exactly", () => {
    const s = sampleBuildingAt(raster, CA_BBOX.west, CA_BBOX.north);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(10, 5);
  });

  it("returns south-east corner exactly", () => {
    const s = sampleBuildingAt(raster, CA_BBOX.east, CA_BBOX.south);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(40, 5);
  });

  it("interpolates the centre as the mean of all four corners", () => {
    const midLng = (CA_BBOX.west + CA_BBOX.east) / 2;
    const midLat = (CA_BBOX.north + CA_BBOX.south) / 2;
    const s = sampleBuildingAt(raster, midLng, midLat);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeCloseTo(25, 5);
  });

  it("returns null for out-of-bounds queries", () => {
    expect(sampleBuildingAt(raster, -130, 36.5)).toBeNull();
    expect(sampleBuildingAt(raster, -119.5, 50)).toBeNull();
  });
});

describe("sampleBuildingAt — nodata-aware blending", () => {
  it("returns null when every neighbour is masked off", () => {
    const raster = buildSyntheticRaster({
      width: 2,
      height: 2,
      heights: [10, 20, 30, 40],
      mask: [0, 0, 0, 0],
    });
    expect(sampleBuildingAt(raster, -119.5, 36.5)).toBeNull();
  });

  it("excludes the masked neighbour from the bilinear weighted average", () => {
    // NW corner masked off; sample close to it should ignore the 99 m sentinel.
    const raster = buildSyntheticRaster({
      width: 2,
      height: 2,
      heights: [99, 10, 10, 10],
      mask: [0, 1, 1, 1],
    });
    const s = sampleBuildingAt(raster, CA_BBOX.west + 0.1, CA_BBOX.north - 0.1);
    expect(s).not.toBeNull();
    expect(s!.heightM).toBeLessThan(20);
  });
});

describe("downsampleBuildingRaster", () => {
  it("preserves uniform-height values under downsample", () => {
    const src = buildSyntheticRaster({
      width: 4,
      height: 4,
      heights: new Array(16).fill(15),
    });
    const ds = downsampleBuildingRaster(src, 2, 2);
    expect(ds.width).toBe(2);
    expect(ds.height).toBe(2);
    for (let i = 0; i < 4; i++) expect(ds.heightM[i]).toBeCloseTo(15, 5);
    for (let i = 0; i < 4; i++) expect(ds.mask[i]).toBe(1);
  });
});

describe("decodeBuildingPixels — RGBA byte unpack", () => {
  it("decodes R/G as uint16 height with R as high byte", () => {
    // R=0x00, G=0x18 → height = 24 m (typical urban). B reserved (0). A=255.
    const px = new Uint8ClampedArray([0x00, 0x18, 0, 255]);
    const { height, mask } = _decodeBuildingPixelsForTests(px, 1);
    expect(height[0]).toBe(24);
    expect(mask[0]).toBe(255);
  });

  it("A=0 zeroes height and marks mask", () => {
    const px = new Uint8ClampedArray([99, 99, 99, 0]);
    const { height, mask } = _decodeBuildingPixelsForTests(px, 1);
    expect(height[0]).toBe(0);
    expect(mask[0]).toBe(0);
  });

  it("decodes max height 65535 m without truncation", () => {
    const px = new Uint8ClampedArray([0xFF, 0xFF, 0, 255]);
    const { height } = _decodeBuildingPixelsForTests(px, 1);
    expect(height[0]).toBe(65535);
  });

  it("decodes a 2-pixel buffer end-to-end", () => {
    const px = new Uint8ClampedArray([
      0, 5, 0, 255,
      77, 88, 99, 0,
    ]);
    const r = _decodeBuildingPixelsForTests(px, 2);
    expect(Array.from(r.height)).toEqual([5, 0]);
    expect(Array.from(r.mask)).toEqual([255, 0]);
  });
});

describe("BuildingTileLRU — eviction", () => {
  beforeEach(() => {
    _resetBuildingCacheForTests();
  });

  function makeTile(h: number): CachedBuildingTile {
    return {
      height: Uint16Array.from([h]),
      mask: Uint8Array.from([255]),
      size: 1,
    };
  }

  it("evicts the oldest entry once maxEntries (256) is exceeded", () => {
    for (let i = 0; i < 256; i++) {
      _putBuildingTileForTests(0, i, 0, makeTile(i));
    }
    expect(_buildingCacheSizeForTests()).toBe(256);
    _putBuildingTileForTests(0, 256, 0, makeTile(256));
    expect(_buildingCacheSizeForTests()).toBe(256);
  });

  it("re-inserting the same key does not grow the cache", () => {
    _putBuildingTileForTests(0, 1, 0, makeTile(1));
    _putBuildingTileForTests(0, 1, 0, makeTile(2));
    expect(_buildingCacheSizeForTests()).toBe(1);
  });
});

describe("buildBuildingRaster — out-of-bbox (all tiles 404)", () => {
  beforeEach(() => {
    _resetBuildingCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a zero raster with mask=0 when every tile 404s", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const raster = await buildBuildingRaster({
      bounds: CA_BBOX,
      targetWidth: 16,
      targetHeight: 16,
    });
    expect(raster.width).toBe(16);
    expect(raster.height).toBe(16);
    expect(raster.tilesPresent).toBe(0);
    expect(raster.tilesTotal).toBeGreaterThan(0);
    expect(raster.heightM.every((v) => v === 0)).toBe(true);
    expect(raster.mask.every((v) => v === 0)).toBe(true);
  });

  it("does not throw on transient network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const raster = await buildBuildingRaster({
      bounds: CA_BBOX,
      targetWidth: 16,
      targetHeight: 16,
    });
    expect(raster.tilesPresent).toBe(0);
    expect(raster.heightM.every((v) => v === 0)).toBe(true);
    expect(raster.mask.every((v) => v === 0)).toBe(true);
  });
});
