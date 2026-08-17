/**
 * Display-space cluster merging (#567).
 *
 * MapLibre's clustering (supercluster) guarantees nothing about the distance
 * between cluster *centroids*: greedy per-zoom merging lets two centroids end up
 * far closer than `clusterRadius`, and even well-spaced ones sit closer than
 * two large donuts (up to 52 px each) need. So the donuts/count labels/hit
 * circles are driven from this "display set": source clusters whose donuts
 * would overlap on screen at the current zoom are merged into one marker
 * (count-weighted centroid, summed counts, member ids kept for click/hover).
 * Zooming in separates them again — the merge is a pure function of the
 * viewport's cluster set and scale.
 */
// Matches the "clusters" circle hit-test layer radius curve. Spiderfy legs
// start at this edge; the donut shader sizes quads from it.
export function pixelRadiusForCount(count: number): number {
  const c = Math.max(count, 2);
  if (c <= 10)  return 16 + (22 - 16) * ((c - 2)   / (10 - 2));
  if (c <= 25)  return 22 + (30 - 22) * ((c - 10)  / (25 - 10));
  if (c <= 100) return 30 + (44 - 30) * ((c - 25)  / (100 - 25));
  if (c <= 200) return 44 + (52 - 44) * ((c - 100) / (200 - 100));
  return 52;
}

export interface SourceCluster {
  lng: number;
  lat: number;
  count: number;
  online: number;
  clusterId: number;
  /** Tile zoom the cluster came from; clusters from different zooms never merge
   *  (a parent and its own children would double-count). */
  z?: number;
}

export interface DisplayCluster {
  lng: number;
  lat: number;
  count: number;
  online: number;
  /** Donut radius (CSS px) for `count`. */
  r: number;
  /** Source cluster_ids folded into this marker (1 = plain, unmerged). */
  members: number[];
  /** Position key (rounded lng/lat) — matches the donut tween/dedupe key. */
  key: string;
  /** Merged only: zoom at which the members stop overlapping (≤ next integer zoom). */
  splitZoom?: number;
}

/** Derived GeoJSON source holding the display set (drives "clusters" + "clusters-count"). */
export const CLUSTER_DISPLAY_SOURCE = "clusters_display";
/** nodes_clustered `clusterMaxZoom` — at/after it clusters are stacked nodes (spiderfy territory). */
export const CLUSTER_MAX_ZOOM = 21;

/** Minimum gap between two rings after merging (CSS px). */
export const DISPLAY_MERGE_PAD_PX = 2;

const TILE = 512;

// Web Mercator (0..1 world) — same projection as supercluster's centroids.
function projX(lng: number): number { return lng / 360 + 0.5; }
function projY(lat: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}
function unprojX(x: number): number { return (x - 0.5) * 360; }
function unprojY(y: number): number {
  const y2 = ((180 - y * 360) * Math.PI) / 180;
  return (360 * Math.atan(Math.exp(y2))) / Math.PI - 90;
}

/**
 * querySourceFeatures can return the same area at two tile zooms (a parent
 * kept as a substitute while children load; variable-zoom LOD with 3D terrain
 * on). Merging those would fold a parent cluster into its own children, so
 * drop every feature from a lower-zoom tile wherever a higher-zoom tile is
 * present at that point — each region then comes from one zoom.
 */
export function dropDominatedByFinerTiles<T extends { z: number; x: number; y: number; lng: number; lat: number }>(items: readonly T[]): T[] {
  const present = new Set<string>();
  const zooms = new Set<number>();
  for (const it of items) {
    present.add(`${it.z}/${it.x}/${it.y}`);
    zooms.add(it.z);
  }
  if (zooms.size <= 1) return items.slice();
  const finer = [...zooms].sort((a, b) => a - b);
  return items.filter((it) => {
    const px = projX(it.lng), py = projY(it.lat);
    // Buffer copies (a tile also carries clusters just outside its bounds)
    // could smuggle a fine-zoom cluster into a region drawn from a coarser
    // tile and get merged with the parent covering the same nodes — with
    // mixed zooms, only trust features inside their own tile.
    const nOwn = Math.pow(2, it.z);
    if (Math.floor(px * nOwn) !== it.x || Math.floor(py * nOwn) !== it.y) return false;
    for (const z of finer) {
      if (z <= it.z) continue;
      const n = Math.pow(2, z);
      if (present.has(`${z}/${Math.floor(px * n)}/${Math.floor(py * n)}`)) return false;
    }
    return true;
  });
}

export function displayClusterKey(lng: number, lat: number): string {
  return `${Math.round(lng * 1e5)},${Math.round(lat * 1e5)}`;
}

/** Zoom delta needed so two markers `sepPx` apart (at the current zoom) clear each other. */
export function zoomDeltaToSeparate(sepPx: number, needPx: number): number {
  if (sepPx <= 0) return Infinity;
  return Math.max(0, Math.log2(needPx / sepPx));
}

/**
 * Merge clusters whose donuts overlap on screen at `zoom`. Deterministic:
 * bigger clusters absorb smaller ones; passes repeat until stable (a merged
 * marker grows and may newly overlap a neighbour).
 */
export function mergeOverlappingClusters(
  input: readonly SourceCluster[],
  zoom: number,
  opts: { radiusFor?: (count: number) => number; padPx?: number; merge?: boolean } = {},
): DisplayCluster[] {
  const radiusFor = opts.radiusFor ?? pixelRadiusForCount;
  const pad = opts.padPx ?? DISPLAY_MERGE_PAD_PX;
  const doMerge = opts.merge ?? true;
  const scale = TILE * Math.pow(2, zoom);
  // A merge that needs more than the next integer zoom is moot — the tile
  // zoom changes there and the source clusters are re-derived.
  const zoomCap = Math.floor(zoom) + 1;

  type Work = { x: number; y: number; count: number; online: number; r: number; members: number[]; splitZoom: number; z: number | undefined };
  const items: Work[] = input.map((c) => ({
    x: projX(c.lng) * scale,
    y: projY(c.lat) * scale,
    count: c.count,
    online: c.online,
    r: radiusFor(c.count),
    members: [c.clusterId],
    splitZoom: zoom,
    z: c.z,
  }));
  // Stable order: count desc, then position — the same input always merges the same way.
  items.sort((a, b) => b.count - a.count || a.x - b.x || a.y - b.y);

  let merged = doMerge;
  while (merged) {
    merged = false;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (a.z !== b.z) continue;
        const need = a.r + b.r + pad;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        const total = a.count + b.count;
        const split = zoom + zoomDeltaToSeparate(Math.sqrt(d2), need);
        a.splitZoom = Math.min(zoomCap, Math.max(a.splitZoom, b.splitZoom, split));
        a.x = (a.x * a.count + b.x * b.count) / total;
        a.y = (a.y * a.count + b.y * b.count) / total;
        a.count = total;
        a.online += b.online;
        a.r = radiusFor(total);
        a.members.push(...b.members);
        items.splice(j, 1);
        j--;
        merged = true;
      }
    }
  }

  return items.map((w) => {
    const lng = unprojX(w.x / scale);
    const lat = unprojY(w.y / scale);
    const out: DisplayCluster = { lng, lat, count: w.count, online: w.online, r: w.r, members: w.members, key: displayClusterKey(lng, lat) };
    if (w.members.length > 1) out.splitZoom = w.splitZoom;
    return out;
  });
}

/** Same abbreviation supercluster uses for `point_count_abbreviated`. */
export function abbreviateCount(count: number): string {
  return count >= 10000 ? `${Math.round(count / 1000)}k`
    : count >= 1000 ? `${Math.round(count / 100) / 10}k`
      : String(count);
}

/** Member source cluster_ids of a display feature (`members` JSON); [] when unmerged/absent. */
export function parseClusterMembers(properties: Record<string, unknown> | null | undefined): number[] {
  const raw = properties?.members;
  if (Array.isArray(raw)) return raw.filter((v): v is number => typeof v === "number");
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Display-set → GeoJSON for the "clusters" hit layer and "clusters-count"
 * labels. Unmerged markers keep their source `cluster_id`; merged ones get a
 * negative `cluster_id` (never collides with supercluster ids) plus `members`.
 * Feature `id` is set only for unmerged markers: ids travel through the tile
 * pbf as unsigned varints, so a negative one would not round-trip.
 */
export function displayFeatureCollection(display: readonly DisplayCluster[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: display.map((d) => {
      const merged = d.members.length > 1;
      const clusterId = merged ? -Math.min(...d.members) : d.members[0];
      return {
        type: "Feature",
        ...(merged ? {} : { id: clusterId }),
        geometry: { type: "Point", coordinates: [d.lng, d.lat] },
        properties: {
          cluster: true,
          cluster_id: clusterId,
          point_count: d.count,
          point_count_abbreviated: abbreviateCount(d.count),
          onlineCount: d.online,
          ...(merged ? { merged: true, members: JSON.stringify(d.members), split_zoom: d.splitZoom } : {}),
        },
      };
    }),
  };
}
