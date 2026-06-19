/** Longitude / antimeridian helpers. */

/** Wrap a longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Shortest signed delta b-a, in (-180, 180]. */
export function shortestLngDelta(a: number, b: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/** Unwrap `toLng` so the from→to segment takes the short way; result may exceed
 *  ±180 (MapLibre wraps it for display). */
export function unwrapLngTo(fromLng: number, toLng: number): number {
  return fromLng + shortestLngDelta(fromLng, toLng);
}

/** Circular mean of longitudes, in [-180, 180). */
export function circularMeanLng(lngs: number[]): number {
  let x = 0;
  let y = 0;
  for (const L of lngs) {
    const r = (L * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  if (x === 0 && y === 0) return 0;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Interpolate from→to at fraction t, short way in longitude; lat stays linear. */
export function interpLngLatUnwrapped(
  from: [number, number],
  to: [number, number],
  t: number,
): [number, number] {
  return [
    normalizeLng(from[0] + shortestLngDelta(from[0], to[0]) * t),
    from[1] + (to[1] - from[1]) * t,
  ];
}
