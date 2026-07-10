/** Margin grid → RGBA, using the tool raster's shared gradient so server tiles
 *  match the interactive palette exactly; margin < 0 / NaN → transparent. */
import { gradient } from "../src/pages/map/rf/coverageRaster";

/** Float path — production tiles use colorizeQ8; this feeds the parity test. */
export function colorizeMargin(margin: Float32Array, count: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const m = margin[i];
    if (Number.isNaN(m) || m < 0) {
      rgba[i * 4 + 3] = 0;
      continue;
    }
    const [r, g, b, a] = gradient(m);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}

/** q8 canvas tile → RGBA. q = 0 is the empty/NaN sentinel; margins below 0 dB
 *  (q < 81) stay transparent, matching colorizeMargin's float behavior. */
export function colorizeQ8(tile: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(tile.length * 4);
  for (let i = 0; i < tile.length; i++) {
    const q = tile[i];
    if (q === 0) continue; // alpha stays 0
    const m = (q - 1) / 4 - 20;
    if (m < 0) continue;
    const [r, g, b, a] = gradient(m);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}
