/** Margin grid → RGBA, using the tool raster's shared gradient so server tiles
 *  match the interactive palette exactly; margin < 0 / NaN → transparent. */
import { gradient } from "../src/pages/map/rf/coverageRaster";

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
