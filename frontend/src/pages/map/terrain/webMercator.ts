/**
 * Web-Mercator (slippy / XYZ) projection math, shared by the terrain/clutter
 * tile builders and the coverage-worker. Longitudes may be "unwrapped" past
 * ±180 (antimeridian frames) — callers wrap tile indices at fetch/write time.
 */

/** Normalized mercator X in [0, 1) for lng in [-180, 180); linear. */
export function mercatorXNorm(lng: number): number {
  return (lng + 180) / 360;
}

/** Normalized mercator Y in [0, 1], 0 at the north edge (~85.05°). */
export function mercatorYNorm(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

export function lngFromMercatorXNorm(x: number): number {
  return x * 360 - 180;
}

export function latFromMercatorYNorm(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Fractional tile X at `zoom` (floor for the index). */
export function lng2tileX(lng: number, zoom: number): number {
  return mercatorXNorm(lng) * Math.pow(2, zoom);
}

/** Fractional tile Y at `zoom` (floor for the index). */
export function lat2tileY(lat: number, zoom: number): number {
  return mercatorYNorm(lat) * Math.pow(2, zoom);
}
