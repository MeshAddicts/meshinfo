/**
 * Cluster spiderfy: fans co-located cluster members out in a circle (≤8) or
 * Fermat spiral (>8) with animated leg lines.
 */

import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import type { GeoJSONSource as MlGeoJSONSource, Map as MlMap } from "maplibre-gl";

export const SPIDERFY_SOURCE_NODES = "spiderfy-nodes";
export const SPIDERFY_SOURCE_LEGS = "spiderfy-legs";
export const SPIDERFY_LAYER_NODES = "spiderfy-node-circles";
export const SPIDERFY_LAYER_LABELS = "spiderfy-node-labels";
export const SPIDERFY_LAYER_LEGS = "spiderfy-legs-line";
export const SPIDERFY_LAYER_LEGS_SHADOW = "spiderfy-legs-shadow";

const ANIMATE_MS = 320;
const GOLDEN_ANGLE = 2.399963229728653; // 137.508°
const AUTO_SPIDERFY_MIN_ZOOM = 14;

/** One fanned-out cluster of co-located nodes. */
interface SpiderfyGroup {
  center: [number, number];
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[];
}

interface SpiderfyState {
  groups: SpiderfyGroup[];
  lastZoom: number;
}

let activeState: SpiderfyState | null = null;

// Signature of a fan set the user explicitly dismissed (clustering-off). The
// auto pass refuses to re-fan exactly this set until it changes, so dismissing
// sticks instead of popping straight back open on the next pan.
let dismissedSignature: string | null = null;

/** Stable signature of a set of fanned node ids (order-independent). */
function groupsSignature(groups: SpiderfyGroup[]): string {
  return groups
    .flatMap((g) => g.leaves.map((l) => l.properties?.id as string | undefined))
    .filter(Boolean)
    .sort()
    .join(",");
}

function pixelsToDegrees(pixels: number, zoom: number): number {
  return (pixels / (256 * Math.pow(2, zoom))) * 360;
}

function circlePositions(
  center: [number, number],
  count: number,
  zoom: number,
  radiusPx = 40,
): [number, number][] {
  const r = pixelsToDegrees(radiusPx, zoom);
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count - Math.PI / 2;
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] as [number, number];
  });
}

function spiralPositions(
  center: [number, number],
  count: number,
  zoom: number,
  basePx = 30,
): [number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const a = i * GOLDEN_ANGLE;
    const r = pixelsToDegrees(basePx * Math.sqrt(i + 1), zoom);
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] as [number, number];
  });
}

function fanPositions(center: [number, number], count: number, zoom: number): [number, number][] {
  return count <= 8 ? circlePositions(center, count, zoom) : spiralPositions(center, count, zoom);
}

function interpolatePositions(
  center: [number, number],
  targets: [number, number][],
  t: number,
): [number, number][] {
  const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
  return targets.map(([lng, lat]) => [
    center[0] + (lng - center[0]) * e,
    center[1] + (lat - center[1]) * e,
  ]);
}

/** Combined node + leg GeoJSON for every active group at animation progress `t`
 *  (t≥1 = fully fanned). Groups render into one source pair so any number of
 *  stacks can be fanned at once. */
function composeData(
  groups: SpiderfyGroup[],
  zoom: number,
  t: number,
): {
  nodes: FeatureCollection<GeoPoint, GeoJsonProperties>;
  legs: FeatureCollection<GeoLineString, GeoJsonProperties>;
} {
  const nodeFeatures: GeoFeature<GeoPoint, GeoJsonProperties>[] = [];
  const legFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

  groups.forEach((group, gi) => {
    const targets = fanPositions(group.center, group.leaves.length, zoom);
    const positions = t >= 1 ? targets : interpolatePositions(group.center, targets, t);

    group.leaves.forEach((leaf, i) => {
      nodeFeatures.push({
        type: "Feature",
        id: leaf.properties?.id ?? `spider-${gi}-${i}`,
        properties: { ...leaf.properties, _spiderfied: true },
        geometry: { type: "Point", coordinates: positions[i] },
      });
      legFeatures.push({
        type: "Feature",
        properties: { index: i, centerLng: group.center[0], centerLat: group.center[1] },
        geometry: { type: "LineString", coordinates: [group.center, positions[i]] },
      });
    });
  });

  return {
    nodes: { type: "FeatureCollection", features: nodeFeatures },
    legs: { type: "FeatureCollection", features: legFeatures },
  };
}

/** Push composed data to the spiderfy sources; false if they've been removed. */
function applyData(
  map: MlMap,
  data: ReturnType<typeof composeData>,
): boolean {
  const nodeSrc = map.getSource(SPIDERFY_SOURCE_NODES) as MlGeoJSONSource | undefined;
  const legSrc = map.getSource(SPIDERFY_SOURCE_LEGS) as MlGeoJSONSource | undefined;
  if (!nodeSrc || !legSrc) return false;
  nodeSrc.setData(data.nodes);
  legSrc.setData(data.legs);
  return true;
}

/** getClusterLeaves with a timeout; returns [] if the cluster_id is stale or the callback never fires. */
function tryGetLeaves(
  source: MlGeoJSONSource,
  clusterId: number,
  timeoutMs = 500,
): Promise<GeoFeature<GeoPoint, GeoJsonProperties>[]> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve([]); }
    }, timeoutMs);

    try {
      source.getClusterLeaves(clusterId, Infinity, 0).then((features) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve((features ?? []) as GeoFeature<GeoPoint, GeoJsonProperties>[]);
      }).catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve([]);
      });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve([]); }
    }
  });
}

/** Fallback: find N nearest nodes to `center` from a caller-supplied raw node pool
 *  (needed because querySourceFeatures hides features inside clusters). */
function findLeavesNearCenter(
  pool: GeoFeature<GeoPoint, GeoJsonProperties>[] | undefined,
  center: [number, number],
  pointCount: number,
): GeoFeature<GeoPoint, GeoJsonProperties>[] {
  if (!pool || pool.length === 0) return [];
  const withDist = pool
    .map((f) => {
      const c = (f.geometry as GeoPoint).coordinates;
      const dx = c[0] - center[0];
      const dy = c[1] - center[1];
      return { f, d2: dx * dx + dy * dy };
    })
    .sort((a, b) => a.d2 - b.d2);
  const n = Math.max(1, Math.min(pointCount || withDist.length, withDist.length));
  // Cap at ~2km (degrees² at equator) so we don't grab distant nodes on an invalid cluster
  const maxD2 = 0.02 * 0.02;
  return withDist
    .slice(0, n)
    .filter((x) => x.d2 < maxD2)
    .map((x) => x.f);
}

export function isSpiderfied(map: MlMap): boolean {
  return !!map.getSource(SPIDERFY_SOURCE_NODES);
}

export function removeSpiderfyLayers(map: MlMap): void {
  activeState = null;
  dismissedSignature = null; // teardown clears any remembered dismissal...
  for (const id of [SPIDERFY_LAYER_LABELS, SPIDERFY_LAYER_NODES, SPIDERFY_LAYER_LEGS, SPIDERFY_LAYER_LEGS_SHADOW]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SPIDERFY_SOURCE_NODES, SPIDERFY_SOURCE_LEGS]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function addSpiderfyLayers(map: MlMap): void {
  map.addSource(SPIDERFY_SOURCE_LEGS, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addSource(SPIDERFY_SOURCE_NODES, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Shadow under the dashed line so legs stay visible on light satellite imagery
  map.addLayer({
    id: SPIDERFY_LAYER_LEGS_SHADOW,
    type: "line",
    source: SPIDERFY_SOURCE_LEGS,
    paint: {
      "line-width": 3.5,
      "line-color": "rgba(0, 0, 0, 0.55)",
      "line-blur": 0.5,
    },
  });

  map.addLayer({
    id: SPIDERFY_LAYER_LEGS,
    type: "line",
    source: SPIDERFY_SOURCE_LEGS,
    paint: {
      "line-width": 1.75,
      "line-color": "rgba(255, 255, 255, 0.9)",
      "line-dasharray": [2, 3],
    },
  });

  map.addLayer({
    id: SPIDERFY_LAYER_NODES,
    type: "circle",
    source: SPIDERFY_SOURCE_NODES,
    paint: {
      "circle-radius": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        12,
        8,
      ],
      "circle-color": [
        "case",
        ["boolean", ["get", "online"], false],
        "#32f032",
        "rgba(0,0,0,0.50)",
      ],
      "circle-stroke-width": 2.5,
      "circle-stroke-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "orange",
        "white",
      ],
    },
  });

  map.addLayer({
    id: SPIDERFY_LAYER_LABELS,
    type: "symbol",
    source: SPIDERFY_SOURCE_NODES,
    layout: {
      "text-field": ["get", "shortname"],
      "text-size": 13,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-halo-color": "#000000",
      "text-halo-width": 1.25,
      "text-color": "#ffffff",
    },
  });
}

/** Shared render core: fan every group out around its center. When the layers
 *  are already present (a reconcile/update) the data is just swapped — sources
 *  are kept so feature-state (selection) survives. `animate` only applies to a
 *  fresh fan; updates render instantly. Assumes `groups` is non-empty. */
function renderSpiderfy(
  map: MlMap,
  groups: SpiderfyGroup[],
  zoom: number,
  animate: boolean,
): Promise<void> {
  const fresh = !isSpiderfied(map);
  activeState = { groups, lastZoom: zoom };
  if (fresh) addSpiderfyLayers(map);

  if (!animate || !fresh) {
    applyData(map, composeData(groups, zoom, 1));
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const start = performance.now();
    function frame(now: number) {
      const t = Math.min((now - start) / ANIMATE_MS, 1);
      if (!applyData(map, composeData(groups, zoom, t))) {
        removeSpiderfyLayers(map);
        resolve();
        return;
      }
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

export async function spiderfy(
  map: MlMap,
  clusterId: number,
  center: [number, number],
  zoom: number,
  animate = true,
  /** Raw node features used as fallback when the cluster API fails. */
  fallbackPool?: GeoFeature<GeoPoint, GeoJsonProperties>[],
  /** Expected member count — sizes the fallback result. */
  pointCount?: number,
): Promise<void> {
  removeSpiderfyLayers(map);

  const source = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
  if (!source) return;

  let leaves = await tryGetLeaves(source, clusterId);

  if (leaves.length === 0) {
    leaves = findLeavesNearCenter(fallbackPool, center, pointCount ?? 0);
  }

  if (leaves.length === 0) return;

  return renderSpiderfy(map, [{ center, leaves }], zoom, animate);
}

/** Spiderfy an explicit set of co-located features. Used when clustering is OFF
 *  and the user clicks a spot where several plain nodes overlap — there is no
 *  cluster to query, so the caller supplies the stacked leaves directly. */
export async function spiderfyFeatures(
  map: MlMap,
  center: [number, number],
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[],
  zoom: number,
  animate = true,
): Promise<void> {
  removeSpiderfyLayers(map);
  if (leaves.length === 0) return;
  return renderSpiderfy(map, [{ center, leaves }], zoom, animate);
}

export async function unspiderfy(map: MlMap): Promise<void> {
  if (!isSpiderfied(map)) return;

  const state = activeState;
  if (!state || !map.getSource(SPIDERFY_SOURCE_NODES)) {
    removeSpiderfyLayers(map);
    return;
  }
  const groups = state.groups;
  const zoom = map.getZoom();
  activeState = null;

  return new Promise<void>((resolve) => {
    const start = performance.now();
    const duration = ANIMATE_MS * 0.7;
    function frame(now: number) {
      const t = Math.min((now - start) / duration, 1);
      if (!applyData(map, composeData(groups, zoom, 1 - t))) {
        removeSpiderfyLayers(map);
        resolve();
        return;
      }
      if (t < 1) requestAnimationFrame(frame);
      else { removeSpiderfyLayers(map); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

/** Dismiss the active fans and remember the set so the clustering-off auto pass
 *  won't immediately re-open exactly what the user just closed. */
export function dismissPlainSpiderfy(map: MlMap): void {
  const sig = activeState ? groupsSignature(activeState.groups) : null;
  removeSpiderfyLayers(map); // clears dismissedSignature...
  dismissedSignature = sig; // ...then record what was dismissed
}

export function updateSpiderfyPositions(map: MlMap): void {
  if (!activeState || !isSpiderfied(map)) return;

  const zoom = map.getZoom();
  if (zoom < AUTO_SPIDERFY_MIN_ZOOM) {
    removeSpiderfyLayers(map);
    return;
  }

  activeState.lastZoom = zoom;
  try {
    applyData(map, composeData(activeState.groups, zoom, 1));
  } catch { /* sources may have been removed */ }
}

export async function autoSpiderfyVisibleClusters(
  map: MlMap,
  fallbackPool?: GeoFeature<GeoPoint, GeoJsonProperties>[],
): Promise<void> {
  if (activeState) return;
  if (!map.getLayer("clusters")) return;

  const maxZoom = map.getMaxZoom();
  const currentZoom = map.getZoom();
  if (currentZoom < AUTO_SPIDERFY_MIN_ZOOM) return;

  const clusterFeatures = map.queryRenderedFeatures({ layers: ["clusters"] });
  if (clusterFeatures.length === 0) return;

  const source = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
  if (!source) return;

  for (const cluster of clusterFeatures) {
    const clusterId = cluster.properties?.cluster_id;
    if (clusterId == null) continue;

    // Timeout guards against stale cluster_ids after setData
    const expansionZoom = await new Promise<number | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 500);
      try {
        source.getClusterExpansionZoom(clusterId).then((zoom) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(zoom ?? null);
        }).catch(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        });
      } catch { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    });

    if (expansionZoom == null) continue;

    if (expansionZoom >= maxZoom) {
      const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
      const count = (cluster.properties?.point_count as number) ?? 0;
      await spiderfy(map, clusterId, [lng, lat], currentZoom, true, fallbackPool, count);
      return;
    }
  }
}

// Plain-node circle radius (px) — must match the "plain-nodes" layer paint.
const PLAIN_NODE_RADIUS_PX = 8;

/** Build a centered group from member feature indices into `pts`. */
function groupFromIndices(
  indices: number[],
  pts: { f: GeoFeature<GeoPoint, GeoJsonProperties> }[],
): SpiderfyGroup {
  const leaves = indices.map((k) => pts[k].f);
  let lng = 0, lat = 0;
  for (const lf of leaves) {
    const c = (lf.geometry as GeoPoint).coordinates;
    lng += c[0];
    lat += c[1];
  }
  return { center: [lng / leaves.length, lat / leaves.length], leaves };
}

/** Clustering-OFF analogue of autoSpiderfyVisibleClusters: there is no cluster
 *  source, so detect every group of plain nodes whose circles overlap at the
 *  current zoom (single-linkage by screen distance) and fan them ALL out.
 *  Reconciles on each call — new stacks fan in, separated ones collapse — and
 *  skips re-rendering when the set is unchanged or was just dismissed. */
export async function autoSpiderfyOverlappingPlainNodes(map: MlMap): Promise<void> {
  if (!map.getLayer("plain-nodes")) return;

  const currentZoom = map.getZoom();
  if (currentZoom < AUTO_SPIDERFY_MIN_ZOOM) {
    if (activeState) removeSpiderfyLayers(map);
    return;
  }

  const feats = map.queryRenderedFeatures({ layers: ["plain-nodes"] });

  // Dedupe by node id (tiling repeats features) and record screen position.
  const seen = new Set<string>();
  const pts: { f: GeoFeature<GeoPoint, GeoJsonProperties>; x: number; y: number }[] = [];
  for (const f of feats) {
    const id = f.properties?.id as string | undefined;
    if (!id || seen.has(id) || f.geometry?.type !== "Point") continue;
    seen.add(id);
    const c = (f.geometry as GeoPoint).coordinates;
    const p = map.project([c[0], c[1]]);
    pts.push({ f: f as GeoFeature<GeoPoint, GeoJsonProperties>, x: p.x, y: p.y });
  }

  // Single-linkage grouping by screen distance; keep every group of 2+.
  // Circles overlap when their centers are within one diameter.
  const t2 = (PLAIN_NODE_RADIUS_PX * 2) ** 2;
  const used = new Array(pts.length).fill(false);
  const groups: SpiderfyGroup[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    const member = [i];
    used[i] = true;
    for (let g = 0; g < member.length; g++) {
      const a = pts[member[g]];
      for (let j = 0; j < pts.length; j++) {
        if (used[j]) continue;
        const dx = a.x - pts[j].x;
        const dy = a.y - pts[j].y;
        if (dx * dx + dy * dy <= t2) { used[j] = true; member.push(j); }
      }
    }
    if (member.length >= 2) groups.push(groupFromIndices(member, pts));
  }

  const nextSig = groupsSignature(groups);
  const currentSig = activeState ? groupsSignature(activeState.groups) : "";
  if (nextSig === currentSig) return; // already showing exactly this set
  if (nextSig === dismissedSignature) return; // user just dismissed this set

  dismissedSignature = null; // the overlap set changed — old dismissal is stale
  if (groups.length === 0) {
    removeSpiderfyLayers(map);
    return;
  }
  // Animate only the first fan; later reconciles swap data in place so existing
  // fans don't re-expand and the selection highlight survives.
  await renderSpiderfy(map, groups, currentZoom, !activeState);
}
