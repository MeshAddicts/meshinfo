import { describe, expect, it } from "vitest";

import type { MarginGridQ8 } from "./cache";
import { colorizeMargin, colorizeQ8 } from "./colorize";
import { TILE_SIZE } from "./mercator";
import { blendGridIntoTileQ8, compositeTileMargin, tileRectForBounds } from "./nodeRender";

/**
 * Parity: the streaming q8 compositor (blendGridIntoTileQ8 + colorizeQ8) must
 * match the float reference (compositeTileMargin + colorizeMargin) within the
 * q8 rounding budget — the bilinear interpolation commutes with the affine
 * dequantization, so the only divergence is rounding the blended q to a byte:
 * ≤0.125 dB of margin. The steepest gradient band moves blue 217 units over
 * 5 dB (43.4 units/dB), so the channel budget is ceil(43.4 × 0.125) = 6, and
 * alpha may flip only where the reference margin sits within the rounding
 * budget of the 0 dB visibility threshold.
 */
const MAX_CHANNEL_DELTA = 6;

/** Deterministic LCG so failures reproduce. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Synthetic grid with smooth structure, hard NaN holes, and full q range. */
function syntheticGrid(seed: number, bounds: MarginGridQ8["bounds"], width: number, height: number): MarginGridQ8 {
  const rand = lcg(seed);
  const fx = 1 + Math.floor(rand() * 4);
  const fy = 1 + Math.floor(rand() * 4);
  const phase = rand() * Math.PI * 2;
  const holeCx = rand() * width;
  const holeCy = rand() * height;
  const holeR2 = (rand() * width * 0.2) ** 2;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - holeCx) ** 2 + (y - holeCy) ** 2 < holeR2) continue; // 0 = NaN sentinel
      // margins sweep roughly -20..+40 dB across the grid
      const m = 10 + 30 * Math.sin((x / width) * fx * Math.PI + phase) * Math.cos((y / height) * fy * Math.PI) - 20 * (y / height);
      data[y * width + x] = Math.max(1, Math.min(255, 1 + Math.round((m + 20) * 4)));
    }
  }
  return { data, width, height, bounds };
}

describe("streaming q8 compositor parity", () => {
  it("matches the float reference within the rounding budget over random grids", () => {
    const z = 11;
    const grids: MarginGridQ8[] = [];
    // Overlapping cluster around Sacramento-ish coordinates, varied sizes.
    for (let i = 0; i < 8; i++) {
      const rand = lcg(1000 + i);
      const cx = -121.5 + (rand() - 0.5) * 1.2;
      const cy = 38.5 + (rand() - 0.5) * 0.9;
      const w = 0.4 + rand() * 1.2;
      const h = 0.3 + rand() * 0.9;
      grids.push(
        syntheticGrid(i * 7 + 1, { west: cx - w / 2, east: cx + w / 2, south: cy - h / 2, north: cy + h / 2 }, 64 + Math.floor(rand() * 300), 64 + Math.floor(rand() * 300)),
      );
    }

    // Every tile any grid touches.
    const tiles = new Set<string>();
    for (const g of grids) {
      const r = tileRectForBounds(g.bounds, z);
      for (let ty = r.ty0; ty < r.ty1; ty++) for (let tx = r.tx0; tx < r.tx1; tx++) tiles.add(`${tx}/${ty}`);
    }
    expect(tiles.size).toBeGreaterThan(20);

    // Plain accumulation in the hot loop — per-pixel expect() costs minutes.
    let comparedPx = 0;
    let alphaFlips = 0;
    const violations: string[] = [];
    for (const key of tiles) {
      const [tx, ty] = key.split("/").map(Number);

      const refMargin = compositeTileMargin(tx, ty, z, grids);
      const refRgba = refMargin
        ? colorizeMargin(refMargin, TILE_SIZE * TILE_SIZE)
        : new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);

      const tile = new Uint8Array(TILE_SIZE * TILE_SIZE);
      for (const g of grids) blendGridIntoTileQ8(tx, ty, z, g, tile);
      const newRgba = colorizeQ8(tile);

      for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
        comparedPx++;
        const refA = refRgba[i * 4 + 3];
        const newA = newRgba[i * 4 + 3];
        if ((refA === 0) !== (newA === 0)) {
          // Transparency may flip only when the reference margin is within the
          // rounding budget of the 0 dB visibility threshold.
          const m = refMargin ? refMargin[i] : Number.NaN;
          if (!Number.isNaN(m) && Math.abs(m) > 0.13 && violations.length < 5) {
            violations.push(`alpha flip at ${key}:${i} with ref margin ${m}`);
          }
          alphaFlips++;
          continue;
        }
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(refRgba[i * 4 + c] - newRgba[i * 4 + c]);
          if (d > MAX_CHANNEL_DELTA && violations.length < 5) {
            violations.push(`channel ${c} delta ${d} at ${key}:${i}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(comparedPx).toBeGreaterThan(1_000_000);
    // Flips only happen inside the ±0.13 dB band around 0 dB; for these
    // synthetic ±40 dB fields that band is ~0.3% of pixels at most.
    expect(alphaFlips / comparedPx).toBeLessThan(0.005);
    // 8 grids × full-raster parity sits right at vitest's 5s default on a
    // loaded 3-core box — give the compute room instead of flaking.
  }, 20_000);

  it("treats NaN-sentinel corners identically (holes stay holes)", () => {
    const z = 11;
    const bounds = { west: -121.6, east: -121.2, south: 38.4, north: 38.7 };
    const g = syntheticGrid(42, bounds, 128, 128);
    const r = tileRectForBounds(bounds, z);
    let mismatches = 0;
    for (let ty = r.ty0; ty < r.ty1; ty++) {
      for (let tx = r.tx0; tx < r.tx1; tx++) {
        const ref = compositeTileMargin(tx, ty, z, [g]);
        const tile = new Uint8Array(TILE_SIZE * TILE_SIZE);
        blendGridIntoTileQ8(tx, ty, z, g, tile);
        for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
          const refEmpty = !ref || Number.isNaN(ref[i]);
          // Empty-vs-filled must agree exactly: the NaN-corner rule is shared.
          if ((tile[i] === 0) !== refEmpty) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });
});
