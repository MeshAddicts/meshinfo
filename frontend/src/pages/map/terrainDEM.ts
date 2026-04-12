/**
 * Digital Elevation Model (DEM) sampler for terrain-aware coverage.
 *
 * We pre-sample terrain over a bbox into a flat Float32Array grid on the main
 * thread (since `map.queryTerrainElevation` only exists on the Mapbox map),
 * then ship the DEM to a worker for viewshed + raster rendering.
 *
 * A 256×256 grid is ~256KB and is typically enough for ~30km-wide coverage
 * patches — each pixel represents ~120m on the ground, well below Mapbox's
 * terrain DEM source resolution.
 */

/** Any object with a Mapbox-compatible `queryTerrainElevation` method. */
export interface MapLike {
  queryTerrainElevation: (lngLat: [number, number] | { lng: number; lat: number }) => number | null | undefined;
}

/** West / south / east / north bounds in degrees. */
export interface DEMBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DEM {
  /** Row-major elevations (meters). Length = width × height. NaN = unavailable. */
  data: Float32Array;
  width: number;
  height: number;
  bounds: DEMBounds;
}

/**
 * Sample terrain on a regular lng/lat grid over `bounds`.
 * `width` × `height` cells, row 0 = north edge, col 0 = west edge.
 * Uses 2D array access pattern: data[y * width + x].
 */
export function sampleDEM(
  map: MapLike,
  bounds: DEMBounds,
  width: number,
  height: number,
): DEM {
  const data = new Float32Array(width * height);
  const lonStep = (bounds.east - bounds.west) / (width - 1);
  const latStep = (bounds.north - bounds.south) / (height - 1);

  for (let y = 0; y < height; y++) {
    // Row 0 = north. Latitude decreases as y increases.
    const lat = bounds.north - y * latStep;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const lng = bounds.west + x * lonStep;
      const elev = map.queryTerrainElevation([lng, lat]);
      data[rowOffset + x] = typeof elev === "number" && Number.isFinite(elev) ? elev : NaN;
    }
  }

  return { data, width, height, bounds };
}

/**
 * Bilinear elevation lookup at an arbitrary lng/lat.
 * Returns NaN if the point falls outside the DEM or any of the four
 * surrounding samples is missing.
 */
export function sampleDEMAt(dem: DEM, lng: number, lat: number): number {
  const { width, height, bounds, data } = dem;
  const { west, south, east, north } = bounds;

  // Normalize to pixel coordinates. x=0 at west, x=width-1 at east.
  const fx = ((lng - west) / (east - west)) * (width - 1);
  const fy = ((north - lat) / (north - south)) * (height - 1);

  if (fx < 0 || fx > width - 1 || fy < 0 || fy > height - 1) return NaN;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) return NaN;

  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Build a DEM bounding box centered on `origin` with half-width `radiusKm`
 * padded by `padFactor` (default 1.05 so we don't clip pixels at the edge).
 */
export function demBoundsAround(
  origin: [number, number],
  radiusKm: number,
  padFactor = 1.05,
): DEMBounds {
  const r = radiusKm * padFactor;
  const degLat = r / 111;
  const degLon = r / (111 * Math.max(0.05, Math.cos((origin[1] * Math.PI) / 180)));
  return {
    west: origin[0] - degLon,
    east: origin[0] + degLon,
    south: origin[1] - degLat,
    north: origin[1] + degLat,
  };
}

/** Lng/lat pixel center for DEM coordinates (x, y). */
export function demPixelToLngLat(dem: DEM, x: number, y: number): [number, number] {
  const { bounds, width, height } = dem;
  const lng = bounds.west + (x / (width - 1)) * (bounds.east - bounds.west);
  const lat = bounds.north - (y / (height - 1)) * (bounds.north - bounds.south);
  return [lng, lat];
}
