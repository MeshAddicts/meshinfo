/**
 * Marching-squares contours over the coverage margin grid.
 * Emits iso-line polyline FeatureCollection at the supplied dB thresholds.
 * Cells touching any NaN corner are skipped.
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

/** Marching-squares edge lookup. Corners: 0=TL, 1=TR, 2=BR, 3=BL. Edges CW from top: 0=top, 1=right, 2=bot, 3=left. */
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

/** t ∈ [0,1] where `threshold` falls between corner values a and b. */
function lerpT(a: number, b: number, threshold: number): number {
  if (a === b) return 0.5;
  return (threshold - a) / (b - a);
}

/** Grid-space (x,y) of the threshold crossing on edge `edge` of cell (i,j).
 *  TL=(i,j), TR=(i+1,j), BR=(i+1,j+1), BL=(i,j+1). */
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

/** Single-pass segment extraction for all thresholds; cheaper than per-threshold sweeps at 2048². */
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

/** Stitch segments into polylines; endpoints keyed by rounded coords to tolerate FP noise. */
function stitchSegments(
  segs: Array<[[number, number], [number, number]]>,
): [number, number][][] {
  const key = (p: [number, number]): string => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

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

    for (;;) {
      const tail = line[line.length - 1];
      const candidates = byEndpoint.get(key(tail)) ?? [];
      const next = candidates.find((c) => !used[c.idx]);
      if (!next) break;
      used[next.idx] = true;
      const otherEnd = next.end === 0 ? 1 : 0;
      line.push(segs[next.idx][otherEnd]);
    }

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

/** Grid (x,y) → lng/lat. Row 0 = north, row height-1 = south. */
function gridToLngLat(
  x: number, y: number,
  width: number, height: number,
  bounds: DEMBounds,
): [number, number] {
  const lng = bounds.west + (x / (width - 1)) * (bounds.east - bounds.west);
  const lat = bounds.north - (y / (height - 1)) * (bounds.north - bounds.south);
  return [lng, lat];
}

/** Extract iso-contour polylines at each threshold → GeoJSON FeatureCollection. */
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
