/**
 * DEM sampler. Samples Mapbox's queryTerrainElevation into a Float32Array grid
 * on the main thread, then ships it to a worker.
 */

export interface MapLike {
  queryTerrainElevation: (lngLat: [number, number] | { lng: number; lat: number }) => number | null | undefined;
}

/** Bounds in degrees. */
export interface DEMBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DEM {
  /** Row-major elevations (m); NaN = unavailable. */
  data: Float32Array;
  width: number;
  height: number;
  bounds: DEMBounds;
}

/** Sample terrain on regular lng/lat grid. Row 0 = north, col 0 = west. data[y*width+x]. */
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

/** Bilinear elevation at lng/lat; NaN outside DEM or if any neighbor is NaN. */
export function sampleDEMAt(dem: DEM, lng: number, lat: number): number {
  const { width, height, bounds, data } = dem;
  const { west, south, east, north } = bounds;

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

/** DEM bbox centered on origin; half-width = radiusKm × padFactor (1.05 avoids edge clip). */
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

/** Lng/lat for DEM pixel (x, y). */
export function demPixelToLngLat(dem: DEM, x: number, y: number): [number, number] {
  const { bounds, width, height } = dem;
  const lng = bounds.west + (x / (width - 1)) * (bounds.east - bounds.west);
  const lat = bounds.north - (y / (height - 1)) * (bounds.north - bounds.south);
  return [lng, lat];
}

/** Block-average downsample; NaN pixels skipped, fully-missing block → NaN. */
export function downsampleDEM(src: DEM, targetWidth: number, targetHeight: number): DEM {
  const data = new Float32Array(targetWidth * targetHeight);
  const sxStep = src.width / targetWidth;
  const syStep = src.height / targetHeight;
  for (let j = 0; j < targetHeight; j++) {
    const y0 = Math.floor(j * syStep);
    const y1 = Math.max(y0 + 1, Math.floor((j + 1) * syStep));
    for (let i = 0; i < targetWidth; i++) {
      const x0 = Math.floor(i * sxStep);
      const x1 = Math.max(x0 + 1, Math.floor((i + 1) * sxStep));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < src.height; y++) {
        for (let x = x0; x < x1 && x < src.width; x++) {
          const v = src.data[y * src.width + x];
          if (!Number.isNaN(v)) {
            sum += v;
            count++;
          }
        }
      }
      data[j * targetWidth + i] = count > 0 ? sum / count : NaN;
    }
  }
  return { data, width: targetWidth, height: targetHeight, bounds: src.bounds };
}
