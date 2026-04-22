/**
 * Spiderfy for Mapbox GL JS: fans co-located cluster members out in a circle
 * (≤8) or Fermat spiral (>8) with animated leg lines.
 */

import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import type { GeoJSONSource as MbGeoJSONSource, Map as MbMap } from "mapbox-gl";

export const SPIDERFY_SOURCE_NODES = "spiderfy-nodes";
export const SPIDERFY_SOURCE_LEGS = "spiderfy-legs";
export const SPIDERFY_LAYER_NODES = "spiderfy-node-circles";
export const SPIDERFY_LAYER_LABELS = "spiderfy-node-labels";
export const SPIDERFY_LAYER_LEGS = "spiderfy-legs-line";
export const SPIDERFY_LAYER_LEGS_SHADOW = "spiderfy-legs-shadow";

const ANIMATE_MS = 320;
const GOLDEN_ANGLE = 2.399963229728653; // 137.508°
const AUTO_SPIDERFY_MIN_ZOOM = 14;

interface SpiderfyState {
  center: [number, number];
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[];
  lastZoom: number;
}

let activeState: SpiderfyState | null = null;

export function getActiveSpiderfyState(): SpiderfyState | null {
  return activeState;
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

function nodesGeoJSON(
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[],
  positions: [number, number][],
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  return {
    type: "FeatureCollection",
    features: leaves.map((leaf, i) => ({
      type: "Feature" as const,
      id: leaf.properties?.id ?? `spider-${i}`,
      properties: { ...leaf.properties, _spiderfied: true },
      geometry: { type: "Point" as const, coordinates: positions[i] },
    })),
  };
}

function legsGeoJSON(
  center: [number, number],
  positions: [number, number][],
): FeatureCollection<GeoLineString, GeoJsonProperties> {
  return {
    type: "FeatureCollection",
    features: positions.map((pos, i) => ({
      type: "Feature" as const,
      properties: { index: i, centerLng: center[0], centerLat: center[1] },
      geometry: { type: "LineString" as const, coordinates: [center, pos] },
    })),
  };
}

/** getClusterLeaves with a timeout; returns [] if the cluster_id is stale or the callback never fires. */
function tryGetLeaves(
  source: MbGeoJSONSource,
  clusterId: number,
  timeoutMs = 500,
): Promise<GeoFeature<GeoPoint, GeoJsonProperties>[]> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve([]); }
    }, timeoutMs);

    try {
      source.getClusterLeaves(clusterId, Infinity, 0, (err, features) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err || !features) return resolve([]);
        resolve(features as GeoFeature<GeoPoint, GeoJsonProperties>[]);
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

export function isSpiderfied(map: MbMap): boolean {
  return !!map.getSource(SPIDERFY_SOURCE_NODES);
}

export function removeSpiderfyLayers(map: MbMap): void {
  activeState = null;
  for (const id of [SPIDERFY_LAYER_LABELS, SPIDERFY_LAYER_NODES, SPIDERFY_LAYER_LEGS, SPIDERFY_LAYER_LEGS_SHADOW]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SPIDERFY_SOURCE_NODES, SPIDERFY_SOURCE_LEGS]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function addSpiderfyLayers(map: MbMap): void {
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

export async function spiderfy(
  map: MbMap,
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

  const source = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
  if (!source) return;

  let leaves = await tryGetLeaves(source, clusterId);
  let source_used = "getClusterLeaves";

  if (leaves.length === 0) {
    leaves = findLeavesNearCenter(fallbackPool, center, pointCount ?? 0);
    source_used = "proximity fallback";
  }

  if (leaves.length === 0) return;

  activeState = { center, leaves, lastZoom: zoom };
  const finalPositions = fanPositions(center, leaves.length, zoom);

  addSpiderfyLayers(map);

  const nodeSrc = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource;
  const legSrc = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource;

  if (!animate) {
    nodeSrc.setData(nodesGeoJSON(leaves, finalPositions));
    legSrc.setData(legsGeoJSON(center, finalPositions));
    return;
  }

  return new Promise<void>((resolve) => {
    const start = performance.now();
    function frame(now: number) {
      const t = Math.min((now - start) / ANIMATE_MS, 1);
      const pos = interpolatePositions(center, finalPositions, t);
      try {
        nodeSrc.setData(nodesGeoJSON(leaves, pos));
        legSrc.setData(legsGeoJSON(center, pos));
      } catch {
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

export async function unspiderfy(map: MbMap): Promise<void> {
  if (!isSpiderfied(map)) return;

  const state = activeState;
  const nodeSrc = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource | undefined;
  const legSrc = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource | undefined;

  if (!nodeSrc || !legSrc || !state) {
    removeSpiderfyLayers(map);
    return;
  }

  const positions = fanPositions(state.center, state.leaves.length, map.getZoom());
  activeState = null;

  return new Promise<void>((resolve) => {
    const start = performance.now();
    const duration = ANIMATE_MS * 0.7;
    function frame(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const pos = interpolatePositions(state.center, positions, 1 - t);
      try {
        nodeSrc!.setData(nodesGeoJSON(state.leaves, pos));
        legSrc!.setData(legsGeoJSON(state.center, pos));
      } catch {
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

export function updateSpiderfyPositions(map: MbMap): void {
  if (!activeState || !isSpiderfied(map)) return;

  const zoom = map.getZoom();
  if (zoom < AUTO_SPIDERFY_MIN_ZOOM) {
    removeSpiderfyLayers(map);
    return;
  }

  const { center, leaves } = activeState;
  activeState.lastZoom = zoom;
  const positions = fanPositions(center, leaves.length, zoom);

  try {
    const nodeSrc = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource | undefined;
    const legSrc = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource | undefined;
    if (!nodeSrc || !legSrc) return;
    nodeSrc.setData(nodesGeoJSON(leaves, positions));
    legSrc.setData(legsGeoJSON(center, positions));
  } catch { /* sources may have been removed */ }
}

export async function autoSpiderfyVisibleClusters(
  map: MbMap,
  fallbackPool?: GeoFeature<GeoPoint, GeoJsonProperties>[],
): Promise<void> {
  if (activeState) return;
  if (!map.getLayer("clusters")) return;

  const maxZoom = map.getMaxZoom();
  const currentZoom = map.getZoom();
  if (currentZoom < AUTO_SPIDERFY_MIN_ZOOM) return;

  const clusterFeatures = map.queryRenderedFeatures({ layers: ["clusters"] });
  if (clusterFeatures.length === 0) return;

  const source = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
  if (!source) return;

  for (const cluster of clusterFeatures) {
    const clusterId = cluster.properties?.cluster_id;
    if (clusterId == null) continue;

    // Timeout guards against stale cluster_ids after setData
    const expansionZoom = await new Promise<number | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 500);
      try {
        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(err ? null : zoom ?? null);
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
