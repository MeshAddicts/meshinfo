/**
 * Antimeridian regression for the Group E1 tile-fetch fix.
 *
 * demBoundsAround(origin, radius) produces longitudes outside [-180, 180]
 * when the origin is near ±180° (e.g. west=179.5, east=180.5). Before the
 * fix, the fetcher iterated absolute tile-x indices and hit URLs like
 * `/tiles/landcover/4/16/y.png` (x out of range → 404). The lookup wraps
 * via modulo, so it then searched for the wrapped tile that was never
 * fetched, and the east-of-seam half of the raster came back empty.
 *
 * Same wrap logic now lives in landcoverTiles, canopyTiles, buildingTiles,
 * and terrainRgb. Test all three of the tile-only fetchers here in one
 * cross-cutting place; if any drifts back to unwrapped iteration, this
 * file fails before the regression ships.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetBuildingCacheForTests, buildBuildingRaster } from "../pages/map/buildingTiles";
import { _resetCanopyCacheForTests, buildCanopyRaster } from "../pages/map/canopyTiles";
import { _resetLandcoverCacheForTests, buildClutterRaster } from "../pages/map/landcoverTiles";
import type { DEMBounds } from "../pages/map/terrainDEM";
import { buildDemFromTilezen } from "../pages/map/terrainRgb";

// Antimeridian-crossing bbox produced by demBoundsAround(origin=[180, 0], radiusKm=50).
const STRADDLE_BOUNDS: DEMBounds = { west: 179.5, east: 180.5, south: -0.5, north: 0.5 };

/**
 * Stub global fetch and record every (z, x, y) tuple that the fetcher asks for.
 * Returns 404 so the caller falls through to the "missing tile" path without
 * touching the canvas decoder (jsdom has no OffscreenCanvas). Matches both the
 * baked-tile URL shape (`/tiles/<layer>/{z}/{x}/{y}.png`) and the external
 * Tilezen CDN shape (`.../{z}/{x}/{y}.png`).
 */
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
    // Tilezen is the primary terrain source (see project_coverage_terrain_accuracy_options).
    // The Mapbox-fallback path is exercised by the production buildDem(); the Tilezen
    // path is what most users actually hit, and it shipped its wrap separately from the
    // tile-bake files.
    const requests = captureFetchedTileCoords();
    // All-404 path: buildDemFromTilezen throws (>50% failure) — that's expected; we
    // just need to verify the URLs it issued before throwing were canonical.
    await expect(
      buildDemFromTilezen({
        bounds: STRADDLE_BOUNDS,
        targetWidth: 32,
        targetHeight: 32,
        token: "", // Tilezen path doesn't use the Mapbox token; satisfy the typing.
      }),
    ).rejects.toThrow();
    assertAllInRange(requests);
  });

  it("dedupes repeated wrapped tiles when the bbox spans > 360° at low zoom", async () => {
    _resetLandcoverCacheForTests();
    const requests = captureFetchedTileCoords();
    // 720° span at low detail forces the same wrapped tile to appear twice in
    // the un-wrapped x range; the dedupe `if (tileMap.has(key)) continue` skip
    // should ensure no fetch URL appears more than once per (z, x, y) tuple.
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
