/**
 * Spiderfy module for Mapbox GL JS
 *
 * When co-located nodes share coordinates and a cluster can't expand further,
 * this fans them out in a circle (≤8 nodes) or Fermat spiral (>8 nodes)
 * with animated "spider leg" lines connecting each to the true position.
 */

import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import type { GeoJSONSource as MbGeoJSONSource, Map as MbMap } from "mapbox-gl";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPIDERFY_SOURCE_NODES = "spiderfy-nodes";
export const SPIDERFY_SOURCE_LEGS = "spiderfy-legs";
export const SPIDERFY_LAYER_NODES = "spiderfy-node-circles";
export const SPIDERFY_LAYER_LABELS = "spiderfy-node-labels";
export const SPIDERFY_LAYER_LEGS = "spiderfy-legs-line";

/** Animation duration in ms */
const ANIMATE_MS = 320;

/** Golden angle in radians — produces optimal spacing in Fermat spirals */
const GOLDEN_ANGLE = 2.399963229728653; // 137.508°

// ---------------------------------------------------------------------------
// Active spiderfy state — tracks what's currently fanned out
// ---------------------------------------------------------------------------

interface SpiderfyState {
  clusterId: number;
  center: [number, number];
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[];
  lastZoom: number;
}

let activeState: SpiderfyState | null = null;

/** Get the currently active spiderfy state (for external inspection). */
export function getActiveSpiderfyState(): SpiderfyState | null {
  return activeState;
}

// ---------------------------------------------------------------------------
// Position calculation
// ---------------------------------------------------------------------------

/**
 * Convert a pixel offset to geographic degrees at a given zoom level.
 * At zoom z, one degree of longitude ≈ 256 * 2^z / 360 pixels.
 */
function pixelsToDegrees(pixels: number, zoom: number): number {
  const worldSize = 256 * Math.pow(2, zoom);
  return (pixels / worldSize) * 360;
}

/** Arrange `count` points evenly around a circle of `radiusPx` pixels. */
function circlePositions(
  center: [number, number],
  count: number,
  zoom: number,
  radiusPx: number = 40,
): [number, number][] {
  const radius = pixelsToDegrees(radiusPx, zoom);
  const positions: [number, number][] = [];

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2; // start at top
    positions.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
    ]);
  }

  return positions;
}

/** Arrange `count` points in a Fermat spiral of increasing radius. */
function spiralPositions(
  center: [number, number],
  count: number,
  zoom: number,
  baseRadiusPx: number = 30,
): [number, number][] {
  const positions: [number, number][] = [];

  for (let i = 0; i < count; i++) {
    const angle = i * GOLDEN_ANGLE;
    const r = pixelsToDegrees(baseRadiusPx * Math.sqrt(i + 1), zoom);
    positions.push([
      center[0] + r * Math.cos(angle),
      center[1] + r * Math.sin(angle),
    ]);
  }

  return positions;
}

/** Pick circle (≤8) or spiral (>8) layout. */
function computeSpiderfiedPositions(
  center: [number, number],
  count: number,
  zoom: number,
): [number, number][] {
  if (count <= 8) {
    return circlePositions(center, count, zoom);
  }
  return spiralPositions(center, count, zoom);
}

// ---------------------------------------------------------------------------
// GeoJSON builders
// ---------------------------------------------------------------------------

function buildSpiderfiedNodesGeoJSON(
  leaves: GeoFeature<GeoPoint, GeoJsonProperties>[],
  positions: [number, number][],
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  const features: GeoFeature<GeoPoint, GeoJsonProperties>[] = leaves.map((leaf, i) => ({
    type: "Feature",
    id: leaf.properties?.id ?? `spider-${i}`,
    properties: {
      ...leaf.properties,
      _spiderfied: true,
    },
    geometry: {
      type: "Point",
      coordinates: positions[i],
    },
  }));

  return { type: "FeatureCollection", features };
}

/**
 * Compute the cluster circle radius in pixels for a given point count.
 * Mirrors the Mapbox layer paint: step(point_count, 14, 10→18, 25→24, 50→30)
 * Plus 2px for the stroke width.
 */
function clusterRadiusPx(pointCount: number): number {
  let r = 14;
  if (pointCount >= 50) r = 30;
  else if (pointCount >= 25) r = 24;
  else if (pointCount >= 10) r = 18;
  return r + 2; // account for stroke
}

function buildSpiderLegsGeoJSON(
  center: [number, number],
  positions: [number, number][],
  zoom: number,
  pointCount: number,
): FeatureCollection<GeoLineString, GeoJsonProperties> {
  // Offset leg start from center to the edge of the cluster circle
  const edgeOffsetDeg = pixelsToDegrees(clusterRadiusPx(pointCount), zoom);

  const features: GeoFeature<GeoLineString, GeoJsonProperties>[] = positions.map((pos, i) => {
    // Direction from center to this node
    const dx = pos[0] - center[0];
    const dy = pos[1] - center[1];
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Start at the circle edge along the direction toward this node
    const legStart: [number, number] = dist > 0
      ? [center[0] + (dx / dist) * edgeOffsetDeg, center[1] + (dy / dist) * edgeOffsetDeg]
      : center;

    return {
      type: "Feature",
      properties: { index: i, centerLng: center[0], centerLat: center[1] },
      geometry: {
        type: "LineString",
        coordinates: [legStart, pos],
      },
    };
  });

  return { type: "FeatureCollection", features };
}

/** Interpolate positions between center and target for animation frames. */
function interpolatePositions(
  center: [number, number],
  targets: [number, number][],
  t: number,
): [number, number][] {
  // ease-out cubic for a snappy, decelerating feel
  const eased = 1 - Math.pow(1 - t, 3);
  return targets.map(([lng, lat]) => [
    center[0] + (lng - center[0]) * eased,
    center[1] + (lat - center[1]) * eased,
  ]);
}

// ---------------------------------------------------------------------------
// Layer management
// ---------------------------------------------------------------------------

/** Check whether spiderfy layers are currently on the map. */
export function isSpiderfied(map: MbMap): boolean {
  return !!map.getSource(SPIDERFY_SOURCE_NODES);
}

/** Remove all spiderfy layers and sources (safe to call when none exist). */
export function removeSpiderfyLayers(map: MbMap): void {
  activeState = null;
  for (const id of [SPIDERFY_LAYER_LABELS, SPIDERFY_LAYER_NODES, SPIDERFY_LAYER_LEGS]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SPIDERFY_SOURCE_NODES, SPIDERFY_SOURCE_LEGS]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/** Create spiderfy sources and layers (empty data initially). */
function addSpiderfyLayers(map: MbMap): void {
  // Sources
  map.addSource(SPIDERFY_SOURCE_LEGS, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addSource(SPIDERFY_SOURCE_NODES, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Spider legs — thin dashed lines from cluster center to fanned-out node
  map.addLayer({
    id: SPIDERFY_LAYER_LEGS,
    type: "line",
    source: SPIDERFY_SOURCE_LEGS,
    paint: {
      "line-width": 1.5,
      "line-color": "rgba(255, 255, 255, 0.55)",
      "line-dasharray": [2, 3],
    },
  });

  // Spiderfied node circles — mirrors unclustered-nodes styling
  map.addLayer({
    id: SPIDERFY_LAYER_NODES,
    type: "circle",
    source: SPIDERFY_SOURCE_NODES,
    paint: {
      "circle-radius": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        10,
        6,
      ],
      "circle-color": [
        "case",
        ["boolean", ["get", "online"], false],
        "#32f032",
        "rgba(0,0,0,0.50)",
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": [
        "case",
        ["boolean", ["feature-state", "selected"], false],
        "orange",
        "white",
      ],
    },
  });

  // Spiderfied node labels — mirrors unclustered-labels styling
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

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Fan out the leaves of a cluster in a circle/spiral with animated transition.
 *
 * Resolves once the final position is set (animation complete).
 */
export async function spiderfy(
  map: MbMap,
  clusterId: number,
  center: [number, number],
  zoom: number,
  animate: boolean = true,
): Promise<void> {
  // Remove any prior spiderfy state
  removeSpiderfyLayers(map);

  // Fetch cluster leaves
  const source = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
  if (!source) return;

  const leaves = await new Promise<GeoFeature<GeoPoint, GeoJsonProperties>[]>((resolve, reject) => {
    source.getClusterLeaves(clusterId, Infinity, 0, (err, features) => {
      if (err) return reject(err);
      resolve((features ?? []) as GeoFeature<GeoPoint, GeoJsonProperties>[]);
    });
  });

  if (leaves.length === 0) return;

  // Store active state so we can update positions on zoom
  activeState = { clusterId, center, leaves, lastZoom: zoom };

  // Compute final fanned-out positions
  const finalPositions = computeSpiderfiedPositions(center, leaves.length, zoom);

  // Create layers
  addSpiderfyLayers(map);

  const nodeSource = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource;
  const legSource = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource;

  if (!animate) {
    // Instant placement (used for zoom updates)
    nodeSource.setData(buildSpiderfiedNodesGeoJSON(leaves, finalPositions));
    legSource.setData(buildSpiderLegsGeoJSON(center, finalPositions, zoom, leaves.length));
    return;
  }

  // Animate the fan-out
  return new Promise<void>((resolve) => {
    const start = performance.now();

    function frame(now: number) {
      const elapsed = now - start;
      const t = Math.min(elapsed / ANIMATE_MS, 1);

      const currentPositions = interpolatePositions(center, finalPositions, t);

      nodeSource.setData(buildSpiderfiedNodesGeoJSON(leaves, currentPositions));
      legSource.setData(buildSpiderLegsGeoJSON(center, currentPositions, zoom, leaves.length));

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(frame);
  });
}

/**
 * Animate the collapse of spiderfied nodes back to center, then remove layers.
 */
export async function unspiderfy(map: MbMap): Promise<void> {
  if (!isSpiderfied(map)) return;

  const state = activeState;
  const nodeSource = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource | undefined;
  const legSource = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource | undefined;

  if (!nodeSource || !legSource) {
    removeSpiderfyLayers(map);
    return;
  }

  // Read current spiderfied feature positions to animate back
  const renderedNodes = map.queryRenderedFeatures(undefined as any, {
    layers: [SPIDERFY_LAYER_NODES],
  });

  if (renderedNodes.length === 0) {
    removeSpiderfyLayers(map);
    return;
  }

  // Get the true center from state or from leg properties
  let center: [number, number];
  if (state) {
    center = state.center;
  } else {
    const renderedLegs = map.queryRenderedFeatures(undefined as any, {
      layers: [SPIDERFY_LAYER_LEGS],
    });
    if (renderedLegs.length > 0 && renderedLegs[0].properties?.centerLng != null) {
      center = [renderedLegs[0].properties.centerLng, renderedLegs[0].properties.centerLat];
    } else {
      removeSpiderfyLayers(map);
      return;
    }
  }

  const currentPositions: [number, number][] = renderedNodes.map((f) => {
    const coords = (f.geometry as GeoPoint).coordinates;
    return [coords[0], coords[1]];
  });

  // Build leaf-like features for the collapse animation
  // Clear state immediately so idle handler doesn't re-spiderfy during collapse
  activeState = null;

  const collapseFeatures: GeoFeature<GeoPoint, GeoJsonProperties>[] = renderedNodes.map((f) => ({
    type: "Feature",
    id: f.properties?.id ?? f.id,
    properties: f.properties,
    geometry: f.geometry as GeoPoint,
  }));

  return new Promise<void>((resolve) => {
    const start = performance.now();
    const collapseDuration = ANIMATE_MS * 0.7; // slightly faster collapse

    function frame(now: number) {
      const elapsed = now - start;
      const t = Math.min(elapsed / collapseDuration, 1);

      // Reverse: interpolate from current positions toward center
      const positions = interpolatePositions(center, currentPositions, 1 - t);

      try {
        nodeSource!.setData(buildSpiderfiedNodesGeoJSON(collapseFeatures, positions));
        legSource!.setData(buildSpiderLegsGeoJSON(center, positions, map.getZoom(), collapseFeatures.length));
      } catch {
        // Source may have been removed during animation (e.g. style change)
        removeSpiderfyLayers(map);
        resolve();
        return;
      }

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        removeSpiderfyLayers(map);
        resolve();
      }
    }

    requestAnimationFrame(frame);
  });
}

// ---------------------------------------------------------------------------
// Update positions on zoom (no remove/re-add, just recompute coordinates)
// ---------------------------------------------------------------------------

/**
 * Recompute spiderfied node positions for the current zoom level.
 * Call on `zoomend` to keep the fan-out visually consistent.
 * Does nothing if no spiderfy is active.
 */
export function updateSpiderfyPositions(map: MbMap): void {
  if (!activeState) return;
  if (!isSpiderfied(map)) return;

  const zoom = map.getZoom();

  // Collapse if user zoomed out past the auto-spiderfy threshold
  if (zoom < AUTO_SPIDERFY_MIN_ZOOM) {
    removeSpiderfyLayers(map);
    return;
  }

  const { center, leaves } = activeState;
  activeState.lastZoom = zoom;

  const positions = computeSpiderfiedPositions(center, leaves.length, zoom);

  try {
    const nodeSource = map.getSource(SPIDERFY_SOURCE_NODES) as MbGeoJSONSource | undefined;
    const legSource = map.getSource(SPIDERFY_SOURCE_LEGS) as MbGeoJSONSource | undefined;
    if (!nodeSource || !legSource) return;

    nodeSource.setData(buildSpiderfiedNodesGeoJSON(leaves, positions));
    legSource.setData(buildSpiderLegsGeoJSON(center, positions, zoom, leaves.length));
  } catch {
    // Sources may have been removed
  }
}

// ---------------------------------------------------------------------------
// Auto-spiderfy
// ---------------------------------------------------------------------------

/**
 * Automatically spiderfy visible clusters that can't expand further.
 * Call on `idle`. Checks all visible clusters regardless of zoom level —
 * if a cluster's expansion zoom >= maxZoom, it gets spiderfied.
 */
/** Zoom level at which individual nodes would normally appear (pre-spiderfy). */
const AUTO_SPIDERFY_MIN_ZOOM = 14;

export async function autoSpiderfyVisibleClusters(map: MbMap): Promise<void> {
  // Don't re-spiderfy if already active (prevents idle → spiderfy → idle loop)
  if (activeState) return;
  if (!map.getLayer("clusters")) return;

  const maxZoom = map.getMaxZoom();
  const currentZoom = map.getZoom();

  // Only auto-spiderfy when zoomed in to street/neighborhood level
  if (currentZoom < AUTO_SPIDERFY_MIN_ZOOM) return;

  // Query visible cluster features
  const clusterFeatures = map.queryRenderedFeatures(undefined as any, {
    layers: ["clusters"],
  });

  if (clusterFeatures.length === 0) return;

  const source = map.getSource("nodes_clustered") as MbGeoJSONSource | undefined;
  if (!source) return;

  // Find clusters that can't expand and spiderfy them
  for (const cluster of clusterFeatures) {
    const clusterId = cluster.properties?.cluster_id;
    if (clusterId == null) continue;

    const expansionZoom = await new Promise<number | null>((resolve) => {
      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return resolve(null);
        resolve(zoom ?? null);
      });
    });

    if (expansionZoom == null) continue;

    if (expansionZoom >= maxZoom) {
      const [lng, lat] = (cluster.geometry as any).coordinates as [number, number];
      await spiderfy(map, clusterId, [lng, lat], map.getZoom());
      return; // one cluster at a time to avoid visual clutter
    }
  }
}
