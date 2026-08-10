/**
 * Antimeridian regression for the tile fetchers. demBoundsAround can produce
 * longitudes outside [-180, 180] near ±180°; the fetch loop must wrap x to a
 * canonical [0, 2^zoom) index so URLs are valid and the lookup (which also
 * wraps via modulo) finds the tile it expects.
 *
 * Cross-cutting because the same wrap pattern lives in landcoverTiles,
 * canopyTiles, buildingTiles, and terrainRgb (Tilezen path); if any drifts
 * back to unwrapped iteration this file catches it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetBuildingCacheForTests, buildBuildingRaster } from "./buildingTiles";
import { _resetCanopyCacheForTests, buildCanopyRaster } from "./canopyTiles";
import { _resetLandcoverCacheForTests, buildClutterRaster } from "./landcoverTiles";
import type { DEMBounds } from "./terrainDEM";
import { buildDemFromTilezen } from "./terrainRgb";

// Antimeridian-crossing bbox produced by demBoundsAround(origin=[180, 0], radiusKm=50).
const STRADDLE_BOUNDS: DEMBounds = { west: 179.5, east: 180.5, south: -0.5, north: 0.5 };

/** Stub fetch and record requested (z, x, y) tuples. Returns 404 so the caller
 *  takes the "missing tile" path without needing OffscreenCanvas (absent under jsdom).
 *  Regex matches both `/tiles/<layer>/{z}/{x}/{y}.png` and Tilezen CDN URLs. */
function captureFetchedTileCoords() {
  const requests: Array<{ z: number; x: number; y: number }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (m) {
      requests.push({
        z: parseInt(m[1], 10),
        x: parseInt(m[2], 10),
        y: parseInt(m[3], 10),
      });
    }
    return new Response(null, { status: 404 });
  });
  return requests;
}

function assertAllInRange(requests: Array<{ z: number; x: number; y: number }>) {
  expect(requests.length).toBeGreaterThan(0);
  for (const r of requests) {
    const scale = Math.pow(2, r.z);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeLessThan(scale);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeLessThan(scale);
  }
}

describe("Antimeridian: tile fetchers wrap x into [0, 2^zoom)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("landcover bbox crossing ±180", async () => {
    _resetLandcoverCacheForTests();
    const requests = captureFetchedTileCoords();
    await buildClutterRaster({
      bounds: STRADDLE_BOUNDS,
      targetWidth: 32,
      targetHeight: 32,
    });
    assertAllInRange(requests);
  });

  it("canopy bbox crossing ±180", async () => {
    _resetCanopyCacheForTests();
    const requests = captureFetchedTileCoords();
    await buildCanopyRaster({
      bounds: STRADDLE_BOUNDS,
      targetWidth: 32,
      targetHeight: 32,
    });
    assertAllInRange(requests);
  });

  it("buildings bbox crossing ±180", async () => {
    _resetBuildingCacheForTests();
    const requests = captureFetchedTileCoords();
    await buildBuildingRaster({
      bounds: STRADDLE_BOUNDS,
      targetWidth: 32,
      targetHeight: 32,
    });
    assertAllInRange(requests);
  });

  it("tilezen DEM bbox crossing ±180", async () => {
    // All-404 here makes buildDemFromTilezen throw (>50% failure); the throw
    // is fine — we just need to inspect the URLs requested before it bailed.
    const requests = captureFetchedTileCoords();
    await expect(
      buildDemFromTilezen({
        bounds: STRADDLE_BOUNDS,
        targetWidth: 32,
        targetHeight: 32,
        token: "", // unused on the Tilezen path; satisfies the typing
      }),
    ).rejects.toThrow();
    assertAllInRange(requests);
  });

  it("dedupes repeated wrapped tiles when the bbox spans > 360° at low zoom", async () => {
    _resetLandcoverCacheForTests();
    const requests = captureFetchedTileCoords();
    // A 720° span produces the same wrapped tile twice in the un-wrapped x range;
    // the sync pre-seed + dedupe should fire so each (z, x, y) is fetched once.
    await buildClutterRaster({
      bounds: { west: -180, east: 540, south: -10, north: 10 },
      targetWidth: 16,
      targetHeight: 16,
    });
    const seen = new Set<string>();
    for (const r of requests) {
      const key = `${r.z}/${r.x}/${r.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
