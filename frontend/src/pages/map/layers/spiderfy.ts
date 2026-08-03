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

import { mbNodeColorExpr } from "../../../palette";
import { prefersReducedMotion } from "../../../utils/reducedMotion";
import { pixelRadiusForCount } from "./clusterDonutLayer";

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
  /** Leg start offset (px) so legs begin at the edge of whatever marks the
   *  center — the cluster donut, or the stacked plain-node circle. */
  centerGapPx: number;
}

interface SpiderfyState {
  groups: SpiderfyGroup[];
  lastZoom: number;
  /** How the fan was opened. Auto fans obey the zoom floor and the reconcile
   *  pass; click fans are pinned until the user dismisses them (#514). */
  origin: "click" | "auto";
  /** Zoom at open time — click fans collapse only when zooming out below it. */
  openZoom: number;
}

let activeState: SpiderfyState | null = null;

// Signature of a fan set the user explicitly dismissed. The auto passes refuse
// to re-fan exactly this set until it changes, so dismissing sticks instead of
// popping straight back open on the next pan/idle.
let dismissedSignature: string | null = null;

// True while unspiderfy's collapse animation runs — auto passes must not
// re-fan (or tear down) mid-collapse.
let collapsing = false;

// Single-flight guard: the clustering-ON auto pass awaits per-cluster worker
// round-trips and must not overlap itself.
let clusterPassBusy = false;

/** Stable signature of a set of fanned node ids (order-independent). */
function groupsSignature(groups: SpiderfyGroup[]): string {
  return groups
    .flatMap((g) => g.leaves.map((l) => l.properties?.id as string | undefined))
    .filter(Boolean)
    .sort()
    .join(",");
}

// MapLibre GL's world is 512px at z0 (not 256 as in classic slippy-map math).
function pixelsToDegrees(pixels: number, zoom: number): number {
  return (pixels / (512 * Math.pow(2, zoom))) * 360;
}

/** Longitude degrees shrink by cos(lat) on screen; widen lng offsets so fans
 *  stay round away from the equator. */
function lngScaleAt(lat: number): number {
  return 1 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
}

function circlePositions(
  center: [number, number],
  count: number,
  zoom: number,
  radiusPx = 80,
): [number, number][] {
  const r = pixelsToDegrees(radiusPx, zoom);
  const kx = lngScaleAt(center[1]);
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count - Math.PI / 2;
    return [center[0] + r * Math.cos(a) * kx, center[1] + r * Math.sin(a)] as [number, number];
  });
}

function spiralPositions(
  center: [number, number],
  count: number,
  zoom: number,
  basePx = 60,
): [number, number][] {
  const kx = lngScaleAt(center[1]);
  return Array.from({ length: count }, (_, i) => {
    const a = i * GOLDEN_ANGLE;
    const r = pixelsToDegrees(basePx * Math.sqrt(i + 1), zoom);
    return [center[0] + r * Math.cos(a) * kx, center[1] + r * Math.sin(a)] as [number, number];
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
    const kx = lngScaleAt(group.center[1]);
    const gapDeg = pixelsToDegrees(group.centerGapPx, zoom);

    group.leaves.forEach((leaf, i) => {
      nodeFeatures.push({
        type: "Feature",
        id: leaf.properties?.id ?? `spider-${gi}-${i}`,
        properties: { ...leaf.properties, _spiderfied: true },
        geometry: { type: "Point", coordinates: positions[i] },
      });
      // Legs start at the edge of the center marker (donut/stack), not its
      // middle. Fan motion is radial, so the animated position gives the
      // direction; a dot still inside the gap gets no leg yet.
      const sx = (positions[i][0] - group.center[0]) / kx;
      const sy = positions[i][1] - group.center[1];
      const len = Math.hypot(sx, sy);
      if (len <= gapDeg) return;
      const start: [number, number] = [
        group.center[0] + (sx / len) * gapDeg * kx,
        group.center[1] + (sy / len) * gapDeg,
      ];
      legFeatures.push({
        type: "Feature",
        properties: { index: i, centerLng: group.center[0], centerLat: group.center[1] },
        geometry: { type: "LineString", coordinates: [start, positions[i]] },
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
// ~2km proximity cap (degrees², lng cos-corrected) for leaf plausibility.
const LEAF_MAX_D2 = 0.02 * 0.02;

function leafDist2(center: [number, number], f: GeoFeature<GeoPoint, GeoJsonProperties>): number {
  const c = (f.geometry as GeoPoint).coordinates;
  const dx = (c[0] - center[0]) * Math.cos((center[1] * Math.PI) / 180);
  const dy = c[1] - center[1];
  return dx * dx + dy * dy;
}

/** Drop leaves implausibly far from the cluster center — a stale cluster_id
 *  after setData can silently resolve to a different cluster's members. */
function leavesNear(
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[],
  center: [number, number],
): GeoFeature<GeoPoint, GeoJsonProperties>[] {
  return leaves.filter((f) => leafDist2(center, f) < LEAF_MAX_D2);
}

function findLeavesNearCenter(
  pool: GeoFeature<GeoPoint, GeoJsonProperties>[] | undefined,
  center: [number, number],
  pointCount: number,
): GeoFeature<GeoPoint, GeoJsonProperties>[] {
  if (!pool || pool.length === 0) return [];
  const withDist = pool
    .map((f) => ({ f, d2: leafDist2(center, f) }))
    .sort((a, b) => a.d2 - b.d2);
  const n = Math.max(1, Math.min(pointCount || withDist.length, withDist.length));
  return withDist
    .slice(0, n)
    .filter((x) => x.d2 < LEAF_MAX_D2)
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
      "circle-color": mbNodeColorExpr,
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
  origin: "click" | "auto",
): Promise<void> {
  const fresh = !isSpiderfied(map);
  const state: SpiderfyState = { groups, lastZoom: zoom, origin, openZoom: zoom };
  activeState = state;
  if (fresh) addSpiderfyLayers(map);

  if (!animate || !fresh || prefersReducedMotion()) {
    applyData(map, composeData(groups, zoom, 1));
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const start = performance.now();
    function frame(now: number) {
      // A newer render/teardown owns the sources now — stop writing stale frames.
      if (activeState !== state) {
        resolve();
        return;
      }
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
  animate = true,
  /** Raw node features used as fallback when the cluster API fails. */
  fallbackPool?: GeoFeature<GeoPoint, GeoJsonProperties>[],
  /** Expected member count — sizes the fallback result. */
  pointCount?: number,
  origin: "click" | "auto" = "click",
): Promise<void> {
  const source = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
  if (!source) return;

  // Resolve leaves BEFORE touching the existing fan, so a failed or stale
  // lookup never leaves the map fanless.
  let leaves = leavesNear(await tryGetLeaves(source, clusterId), center);

  if (leaves.length === 0) {
    leaves = findLeavesNearCenter(fallbackPool, center, pointCount ?? 0);
  }

  if (leaves.length === 0) return;

  const group: SpiderfyGroup = { center, leaves, centerGapPx: pixelRadiusForCount(leaves.length) + 2 };

  if (origin === "auto") {
    // A fan opened (or a dismissal started) during the async lookup wins.
    if (activeState || collapsing) return;
    // Don't re-fan the set the user just dismissed.
    if (groupsSignature([group]) === dismissedSignature) return;
  }

  removeSpiderfyLayers(map);
  return renderSpiderfy(map, [group], map.getZoom(), animate, origin);
}

/** Spiderfy an explicit set of co-located features. Used when clustering is OFF
 *  and the user clicks a spot where several plain nodes overlap — there is no
 *  cluster to query, so the caller supplies the stacked leaves directly. */
export async function spiderfyFeatures(
  map: MlMap,
  center: [number, number],
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[],
  animate = true,
): Promise<void> {
  if (leaves.length === 0) return;
  removeSpiderfyLayers(map);
  return renderSpiderfy(map, [{ center, leaves, centerGapPx: PLAIN_STACK_GAP_PX }], map.getZoom(), animate, "click");
}

export async function unspiderfy(map: MlMap): Promise<void> {
  if (!isSpiderfied(map)) {
    // Layers can vanish without us (style swap, map teardown) — don't let the
    // stale module state block every future auto pass.
    activeState = null;
    return;
  }

  const state = activeState;
  if (!state) {
    removeSpiderfyLayers(map);
    return;
  }
  const groups = state.groups;
  const zoom = map.getZoom();
  activeState = null;

  if (prefersReducedMotion()) { removeSpiderfyLayers(map); return; }

  collapsing = true;
  return new Promise<void>((resolve) => {
    const start = performance.now();
    const duration = ANIMATE_MS * 0.7;
    const finish = (removeLayers: boolean) => {
      collapsing = false;
      if (removeLayers) removeSpiderfyLayers(map);
      resolve();
    };
    function frame(now: number) {
      // A new fan took ownership mid-collapse — stop without destroying it.
      if (activeState !== null) {
        finish(false);
        return;
      }
      const t = Math.min((now - start) / duration, 1);
      if (!applyData(map, composeData(groups, zoom, 1 - t))) {
        finish(true);
        return;
      }
      if (t < 1) requestAnimationFrame(frame);
      else finish(true);
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

/** Clustering-ON analogue: animated collapse that also remembers the dismissed
 *  set, so the auto pass can't re-fan the cluster the user just closed. */
export function dismissClusterSpiderfy(map: MlMap): void {
  const sig = activeState ? groupsSignature(activeState.groups) : null;
  void unspiderfy(map).then(() => {
    // Only record if nothing new opened while the collapse animation ran.
    if (sig && !activeState) dismissedSignature = sig;
  });
}

export function updateSpiderfyPositions(map: MlMap): void {
  if (!activeState || !isSpiderfied(map)) return;

  const zoom = map.getZoom();
  // Auto fans obey the auto-pass zoom floor. Click fans survive until the user
  // zooms out below where they opened (cluster membership changes down there);
  // the 0.5 buffer absorbs pinch/trackpad jitter around the open zoom (#514).
  const floor =
    activeState.origin === "auto"
      ? AUTO_SPIDERFY_MIN_ZOOM
      : Math.min(activeState.openZoom - 0.5, AUTO_SPIDERFY_MIN_ZOOM);
  if (zoom < floor) {
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
  if (clusterPassBusy || collapsing || activeState) return;
  if (!map.getLayer("clusters")) return;

  const maxZoom = map.getMaxZoom();
  if (map.getZoom() < AUTO_SPIDERFY_MIN_ZOOM) return;

  const clusterFeatures = map.queryRenderedFeatures({ layers: ["clusters"] });
  if (clusterFeatures.length === 0) return;

  const source = map.getSource("nodes_clustered") as MlGeoJSONSource | undefined;
  if (!source) return;

  clusterPassBusy = true;
  try {
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

      // Revalidate after every await: a manual fan, a dismissal, or a zoom-out
      // during the worker round-trip means this pass is stale — never stomp it.
      if (activeState || collapsing) return;
      if (map.getZoom() < AUTO_SPIDERFY_MIN_ZOOM) return;

      if (expansionZoom == null) continue;

      if (expansionZoom >= maxZoom) {
        const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
        const count = (cluster.properties?.point_count as number) ?? 0;
        await spiderfy(map, clusterId, [lng, lat], true, fallbackPool, count, "auto");
        return;
      }
    }
  } finally {
    clusterPassBusy = false;
  }
}

// Plain-node circle radius (px) — must match the "plain-nodes" layer paint.
const PLAIN_NODE_RADIUS_PX = 8;
// Leg gap for plain-node fans: stacked-circle edge (radius + half the 2.5px
// stroke) plus breathing room.
const PLAIN_STACK_GAP_PX = PLAIN_NODE_RADIUS_PX + 4;

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
  return { center: [lng / leaves.length, lat / leaves.length], leaves, centerGapPx: PLAIN_STACK_GAP_PX };
}

/** Clustering-OFF analogue of autoSpiderfyVisibleClusters: there is no cluster
 *  source, so detect every group of plain nodes whose circles overlap at the
 *  current zoom (single-linkage by screen distance) and fan them ALL out.
 *  Reconciles on each call — new stacks fan in, separated ones collapse — and
 *  skips re-rendering when the set is unchanged or was just dismissed. */
export async function autoSpiderfyOverlappingPlainNodes(map: MlMap): Promise<void> {
  if (collapsing) return;
  // A click-opened fan is pinned: only the user (click-away, Escape, zoom-out)
  // closes it — never a reconcile pass triggered by hover repaints or SSE data
  // ticks (#514).
  if (activeState?.origin === "click") return;
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

  // A mid-load render (pan/setData retile) yields a partial snapshot; never
  // reshape or collapse a fan on one — the next idle pass sees the full set.
  if (!map.areTilesLoaded()) return;

  dismissedSignature = null; // the overlap set changed — old dismissal is stale
  if (groups.length === 0) {
    removeSpiderfyLayers(map);
    return;
  }
  // Animate only the first fan; later reconciles swap data in place so existing
  // fans don't re-expand and the selection highlight survives.
  await renderSpiderfy(map, groups, currentZoom, !activeState, "auto");
}

/** True when any of the given node ids is currently fanned out. */
export function anyIdsFanned(ids: string[]): boolean {
  if (!activeState) return false;
  const fanned = new Set(
    activeState.groups.flatMap((g) =>
      g.leaves.map((l) => l.properties?.id as string | undefined),
    ),
  );
  return ids.some((id) => id && fanned.has(id));
}

/** Centers of the currently fanned groups (empty when nothing is fanned). */
export function getActiveFanCenters(): [number, number][] {
  return activeState ? activeState.groups.map((g) => g.center) : [];
}
