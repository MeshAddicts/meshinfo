/**
 * Margin grid → RGBA. `gradient()` mirrors coverageRaster.ts (keep in sync) so
 * server tiles match the tool's palette; margin < 0 / NaN → transparent.
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gradient(marginDb: number): [number, number, number, number] {
  // 0→5→15→25 dB: magenta #d946ef → orange #f97316 → cyan #06b6d4 → deep #0891b2
  let r: number, g: number, b: number;
  if (marginDb <= 0) {
    r = 217; g = 70; b = 239;
  } else if (marginDb < 5) {
    const t = marginDb / 5;
    r = lerp(217, 249, t); g = lerp(70, 115, t); b = lerp(239, 22, t);
  } else if (marginDb < 15) {
    const t = (marginDb - 5) / 10;
    r = lerp(249, 6, t); g = lerp(115, 182, t); b = lerp(22, 212, t);
  } else if (marginDb < 25) {
    const t = (marginDb - 15) / 10;
    r = lerp(6, 8, t); g = lerp(182, 145, t); b = lerp(212, 178, t);
  } else {
    r = 8; g = 145; b = 178;
  }
  const aT = Math.min(1, Math.max(0, marginDb / 25));
  const a = Math.round(255 * (0.35 + 0.35 * aT));
  return [Math.round(r), Math.round(g), Math.round(b), a];
}

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
