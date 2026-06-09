/** Web-mercator (slippy / XYZ) pixel + tile math. Pixel origin top-left, 256 px tiles. */
export const TILE_SIZE = 256;

export function worldSizePx(z: number): number {
  return TILE_SIZE * Math.pow(2, z);
}

export function lngToPx(lng: number, z: number): number {
  return ((lng + 180) / 360) * worldSizePx(z);
}

export function latToPx(lat: number, z: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  // y = 0.5(1 - atanh(sin)/π); atanh(sin) = 0.5·ln((1+sin)/(1-sin))
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return y * worldSizePx(z);
}

export function pxToLng(px: number, z: number): number {
  return (px / worldSizePx(z)) * 360 - 180;
}

export function pxToLat(py: number, z: number): number {
  const y = 0.5 - py / worldSizePx(z);
  return (Math.atan(Math.sinh(2 * Math.PI * y)) * 180) / Math.PI;
}
