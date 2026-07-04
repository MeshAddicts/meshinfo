/**
 * Tests for landcoverTiles.ts. Network calls are stubbed via global `fetch`;
 * decode-path tests use jsdom's OffscreenCanvas polyfill (skipped when absent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NLCD_DEFAULT_CLASS_ID } from "../rf/clutterClasses";
import {
  _resetLandcoverCacheForTests,
  buildClutterRaster,
  sampleClutterClassAt,
  selectLandcoverZoom,
} from "./landcoverTiles";
import type { DEMBounds } from "./terrainDEM";

const CA_BBOX: DEMBounds = { west: -120, east: -119, south: 36, north: 37 };

describe("selectLandcoverZoom", () => {
  it("picks a higher zoom for a smaller bbox at the same target px size", () => {
    const small: DEMBounds = { west: -120, east: -119.9, south: 36, north: 36.1 };
    const big: DEMBounds = { west: -120, east: -110, south: 36, north: 46 };
    const zSmall = selectLandcoverZoom(small, 30);
    const zBig = selectLandcoverZoom(big, 30);
    expect(zSmall).toBeGreaterThanOrEqual(zBig);
  });

  it("clamps at MAX_ZOOM (12) regardless of how fine the request is", () => {
    expect(selectLandcoverZoom(CA_BBOX, 0.1)).toBeLessThanOrEqual(12);
  });

  it("respects the maxTiles budget (degrades to coarser zoom)", () => {
    // CONUS-scale bbox forces a coarse zoom under a tight tile cap.
    const conus: DEMBounds = { west: -125, east: -67, south: 24, north: 49 };
    const z = selectLandcoverZoom(conus, 1, 16);
    expect(z).toBeLessThan(12);
  });
});

describe("sampleClutterClassAt", () => {
  // Hand-build a 4×4 raster covering CA_BBOX with deliberate class IDs:
  //   row 0 (north): 11 11 11 11   (water)
  //   row 1:         42 42 42 42   (evergreen)
  //   row 2:         24 24 24 24   (high-density urban)
  //   row 3 (south): 71 71 71 71   (grassland)
  const raster = (() => {
    const data = new Uint8Array(16);
    for (let i = 0; i < 4; i++) data[0 * 4 + i] = 11;
    for (let i = 0; i < 4; i++) data[1 * 4 + i] = 42;
    for (let i = 0; i < 4; i++) data[2 * 4 + i] = 24;
    for (let i = 0; i < 4; i++) data[3 * 4 + i] = 71;
    return { data, width: 4, height: 4, bounds: CA_BBOX };
  })();

  it("returns the class at the north edge", () => {
    expect(sampleClutterClassAt(raster, -119.5, 37)).toBe(11);
  });

  it("returns the class at the south edge", () => {
    expect(sampleClutterClassAt(raster, -119.5, 36)).toBe(71);
  });

  it("returns the class somewhere in the middle (band-2 row)", () => {
    // Lat 36.34 is in row 2 (high-density urban).
    expect(sampleClutterClassAt(raster, -119.5, 36.34)).toBe(24);
  });

  it("returns NLCD_DEFAULT_CLASS_ID for out-of-bounds queries", () => {
    expect(sampleClutterClassAt(raster, -130, 36.5)).toBe(NLCD_DEFAULT_CLASS_ID);
    expect(sampleClutterClassAt(raster, -119.5, 50)).toBe(NLCD_DEFAULT_CLASS_ID);
  });

  it("uses nearest-neighbor (categorical), not bilinear", () => {
    // Query at the exact midpoint between two rows of distinct classes;
    // bilinear would invent (11+42)/2 = 26.5 (a non-existent ID).
    // Nearest-neighbor must pick one or the other (whichever the rounding lands on).
    const v = sampleClutterClassAt(raster, -119.5, (37 + 36) / 2 + 0.001);
    expect([11, 42, 24, 71]).toContain(v);
  });
});

describe("buildClutterRaster — out-of-bbox (all tiles 404)", () => {
  beforeEach(() => {
    _resetLandcoverCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills every pixel with the default class when every tile 404s", async () => {
    // jsdom doesn't ship URL utility for window.location.origin in some setups;
    // make sure it's at least a string the fetch URL builder can use.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));

    const raster = await buildClutterRaster({
      bounds: CA_BBOX,
      targetWidth: 32,
      targetHeight: 32,
    });

    expect(raster.width).toBe(32);
    expect(raster.height).toBe(32);
    expect(raster.tilesPresent).toBe(0);
    expect(raster.tilesTotal).toBeGreaterThan(0);
    // All pixels should be the default class.
    expect(raster.data.every((v) => v === NLCD_DEFAULT_CLASS_ID)).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does not throw on transient network errors (treats them as missing tiles)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const raster = await buildClutterRaster({
      bounds: CA_BBOX,
      targetWidth: 16,
      targetHeight: 16,
    });
    expect(raster.tilesPresent).toBe(0);
    expect(raster.data.every((v) => v === NLCD_DEFAULT_CLASS_ID)).toBe(true);
  });
});
