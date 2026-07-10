/** Web-mercator pixel math (top-left origin, 256 px tiles), thin wrappers over
 *  the shared projection in src/pages/map/terrain/webMercator.ts. */
import {
  latFromMercatorYNorm,
  lngFromMercatorXNorm,
  mercatorXNorm,
  mercatorYNorm,
} from "../src/pages/map/terrain/webMercator";

export const TILE_SIZE = 256;

export function worldSizePx(z: number): number {
  return TILE_SIZE * Math.pow(2, z);
}

export function lngToPx(lng: number, z: number): number {
  return mercatorXNorm(lng) * worldSizePx(z);
}

export function latToPx(lat: number, z: number): number {
  return mercatorYNorm(lat) * worldSizePx(z);
}

export function pxToLng(px: number, z: number): number {
  return lngFromMercatorXNorm(px / worldSizePx(z));
}

export function pxToLat(py: number, z: number): number {
  return latFromMercatorYNorm(py / worldSizePx(z));
}
