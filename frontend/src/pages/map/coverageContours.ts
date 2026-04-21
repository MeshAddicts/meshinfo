/**
 * Marching-squares contour extraction for the coverage margin grid.
 *
 * Given a 2D grid of link-margin values (with NaN for no-data pixels)
 * and a set of dB thresholds, produces a GeoJSON FeatureCollection of
 * polyline iso-contours. Used for:
 *   - Overlaying "edge of coverage" lines on the map (0 dB line = the
 *     outer extent of reachable link budget)
 *   - GeoJSON export so users can import into SPLAT!, Google Earth, etc.
 *
 * The algorithm walks every 2×2 cell of the margin grid, decides which
 * of its 16 cases it falls into based on which corners are above the
 * threshold, and emits line segments at linearly-interpolated
 * threshold crossings. Segments are then stitched end-to-end into
 * continuous polylines.
 *
 * NaN handling: a cell is skipped if any of its 4 corners is NaN —
 * avoids spurious contours through no-data regions.
 */
import type { DEMBounds } from "./terrainDEM";

export interface ContourFeature {
  type: "Feature";
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
  properties: {
    /** The dB threshold this line traces. */
    thresholdDb: number;
  };
}

export interface ContourFeatureCollection {
  type: "FeatureCollection";
  features: ContourFeature[];
}

/** Standard marching-squares lookup: for each of 16 corner-above-threshold
 *  cases, which edges are crossed. Corner bit layout:
 *    bit 0 = top-left, bit 1 = top-right,
 *    bit 2 = bottom-right, bit 3 = bottom-left.
 *  Edge numbering (clockwise from top):
 *    0 = top (TL-TR), 1 = right (TR-BR), 2 = bottom (BR-BL), 3 = left (BL-TL).
 *  Each case yields 0, 1, or 2 segments — each segment a pair of edges.
 */
const MARCHING_SQUARES_CASES: readonly (readonly [number, number][])[] = [
  [],              // 0000: nothing above
  [[3, 0]],        // 0001: TL above
  [[0, 1]],        // 0010: TR above
  [[3, 1]],        // 0011: TL+TR above
  [[1, 2]],        // 0100: BR above
  [[3, 0], [1, 2]], // 0101: TL+BR above (saddle — two segments)
  [[0, 2]],        // 0110: TR+BR above
  [[3, 2]],        // 0111: TL+TR+BR above
  [[2, 3]],        // 1000: BL above
  [[2, 0]],        // 1001: TL+BL above
  [[0, 1], [2, 3]], // 1010: TR+BL above (saddle)
  [[2, 1]],        // 1011: TL+TR+BL above
  [[1, 3]],        // 1100: BR+BL above
  [[1, 0]],        // 1101: TL+BR+BL above
  [[0, 3]],        // 1110: TR+BR+BL above
  [],              // 1111: all above — no contour
];

/**
 * Edge interpolation: given the two corner values and the threshold,
 * return t ∈ [0,1] where the threshold is crossed along that edge.
 */
function lerpT(a: number, b: number, threshold: number): number {
  if (a === b) return 0.5;
  return (threshold - a) / (b - a);
}

/**
 * Return the (x,y) grid-space coordinates of the threshold crossing on
 * the given edge of the 2×2 cell at (i, j). Edge indices match
 * MARCHING_SQUARES_CASES above.
 *   TL = (i,     j)
 *   TR = (i + 1, j)
 *   BR = (i + 1, j + 1)
 *   BL = (i,     j + 1)
 */
function edgePoint(
  edge: number,
  i: number,
  j: number,
  tl: number, tr: number, br: number, bl: number,
  threshold: number,
): [number, number] {
  switch (edge) {
    case 0: { // top: TL → TR
      const t = lerpT(tl, tr, threshold);
      return [i + t, j];
    }
    case 1: { // right: TR → BR
      const t = lerpT(tr, br, threshold);
      return [i + 1, j + t];
    }
    case 2: { // bottom: BR → BL (reversed x direction)
      const t = lerpT(br, bl, threshold);
      return [i + 1 - t, j + 1];
    }
    case 3: { // left: BL → TL (reversed y direction)
      const t = lerpT(bl, tl, threshold);
      return [i, j + 1 - t];
    }
    default:
      return [i, j];
  }
}

/**
 * Extract raw line segments at each threshold in a single pass over the
 * margin grid. Returns one segment list per threshold in the same order
 * as the input. Walking the grid once (instead of once-per-threshold)
 * saves most of the read + NaN-check cost at Survey detail (~2048²).
 */
function extractSegmentsMulti(
  margin: Float32Array,
  width: number,
  height: number,
  thresholds: readonly number[],
): Array<Array<[[number, number], [number, number]]>> {
  const buckets: Array<Array<[[number, number], [number, number]]>> =
    thresholds.map(() => []);
  for (let j = 0; j < height - 1; j++) {
    const row0 = j * width;
    const row1 = (j + 1) * width;
    for (let i = 0; i < width - 1; i++) {
      const tl = margin[row0 + i];
      const tr = margin[row0 + i + 1];
      const bl = margin[row1 + i];
      const br = margin[row1 + i + 1];
      // Skip cells touching any no-data corner.
      if (
        Number.isNaN(tl) || Number.isNaN(tr) ||
        Number.isNaN(bl) || Number.isNaN(br)
      ) continue;
      for (let ti = 0; ti < thresholds.length; ti++) {
        const threshold = thresholds[ti];
        const bits =
          (tl > threshold ? 1 : 0) |
          (tr > threshold ? 2 : 0) |
          (br > threshold ? 4 : 0) |
          (bl > threshold ? 8 : 0);
        const edges = MARCHING_SQUARES_CASES[bits];
        if (edges.length === 0) continue;
        const bucket = buckets[ti];
        for (const [a, b] of edges) {
          bucket.push([
            edgePoint(a, i, j, tl, tr, br, bl, threshold),
            edgePoint(b, i, j, tl, tr, br, bl, threshold),
          ]);
        }
      }
    }
  }
  return buckets;
}

/**
 * Stitch a bag of unordered segments into polylines by matching shared
 * endpoints. Endpoints are keyed to a small integer grid so
 * floating-point noise doesn't prevent joins.
 */
function stitchSegments(
  segs: Array<[[number, number], [number, number]]>,
): [number, number][][] {
  // Key endpoints by rounded grid coordinate (two decimal digits is
  // more than enough given the DEM is 1024² max).
  const key = (p: [number, number]): string => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

  // Index: endpoint key → list of segments with that endpoint.
  const byEndpoint = new Map<string, Array<{ idx: number; end: 0 | 1 }>>();
  segs.forEach((seg, idx) => {
    for (const end of [0, 1] as const) {
      const k = key(seg[end]);
      if (!byEndpoint.has(k)) byEndpoint.set(k, []);
      byEndpoint.get(k)!.push({ idx, end });
    }
  });

  const used = new Array(segs.length).fill(false);
  const lines: [number, number][][] = [];

  for (let startIdx = 0; startIdx < segs.length; startIdx++) {
    if (used[startIdx]) continue;
    used[startIdx] = true;

    const line: [number, number][] = [segs[startIdx][0], segs[startIdx][1]];

    // Walk forward from the tail.
    for (;;) {
      const tail = line[line.length - 1];
      const candidates = byEndpoint.get(key(tail)) ?? [];
      const next = candidates.find((c) => !used[c.idx]);
      if (!next) break;
      used[next.idx] = true;
      const otherEnd = next.end === 0 ? 1 : 0;
      line.push(segs[next.idx][otherEnd]);
    }

    // Walk backward from the head.
    for (;;) {
      const head = line[0];
      const candidates = byEndpoint.get(key(head)) ?? [];
      const next = candidates.find((c) => !used[c.idx]);
      if (!next) break;
      used[next.idx] = true;
      const otherEnd = next.end === 0 ? 1 : 0;
      line.unshift(segs[next.idx][otherEnd]);
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Convert grid-space (x, y) coordinates to lng/lat using the DEM bounds.
 * Row 0 = north, row (height−1) = south — matches the DEM layout.
 */
function gridToLngLat(
  x: number, y: number,
  width: number, height: number,
  bounds: DEMBounds,
): [number, number] {
  const lng = bounds.west + (x / (width - 1)) * (bounds.east - bounds.west);
  const lat = bounds.north - (y / (height - 1)) * (bounds.north - bounds.south);
  return [lng, lat];
}

/**
 * Extract iso-contour polylines at each threshold from the margin grid.
 * Returns a GeoJSON FeatureCollection suitable for a map layer or export.
 */
export function extractCoverageContours(opts: {
  margin: Float32Array;
  width: number;
  height: number;
  bounds: DEMBounds;
  thresholdsDb: number[];
  /** Drop polylines shorter than this many points (default 4). */
  minPolylinePoints?: number;
}): ContourFeatureCollection {
  const { margin, width, height, bounds, thresholdsDb, minPolylinePoints = 4 } = opts;
  const features: ContourFeature[] = [];
  const segsByThreshold = extractSegmentsMulti(margin, width, height, thresholdsDb);
  for (let ti = 0; ti < thresholdsDb.length; ti++) {
    const threshold = thresholdsDb[ti];
    const polylines = stitchSegments(segsByThreshold[ti]);
    for (const line of polylines) {
      if (line.length < minPolylinePoints) continue;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: line.map(([x, y]) => gridToLngLat(x, y, width, height, bounds)),
        },
        properties: { thresholdDb: threshold },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
