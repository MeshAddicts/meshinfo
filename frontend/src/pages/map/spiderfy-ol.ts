/**
 * OpenLayers clustering + spiderfy module.
 *
 * Uses ol/source/Cluster to group overlapping nodes, then fans them out
 * in a circle/spiral when the user clicks a cluster that can't separate.
 */

import { Feature } from "ol";
import type { Map as OlMap } from "ol";
import type { Coordinate } from "ol/coordinate";
import { LineString, Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import { toLonLat } from "ol/proj";
import Cluster from "ol/source/Cluster";
import VectorSource from "ol/source/Vector";
import { Circle, Fill, Stroke, Style, Text } from "ol/style";

import type { IFeatureNode } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cluster distance in pixels */
const CLUSTER_DISTANCE = 50;

/** Animation duration in ms */
const ANIMATE_MS = 320;

/** Zoom level at which auto-spiderfy activates */
const AUTO_SPIDERFY_MIN_ZOOM = 14;

/** Golden angle in radians for Fermat spiral */
const GOLDEN_ANGLE = 2.399963229728653;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const onlineFill = new Fill({ color: "rgba(50, 240, 50, 1)" });
const offlineFill = new Fill({ color: "rgba(0, 0, 0, 0.50)" });
const whiteStroke = new Stroke({ color: "white", width: 2 });
const orangeStroke = new Stroke({ color: "orange", width: 2 });
const clusterFill = new Fill({ color: "rgba(59, 130, 246, 0.85)" });

/** Style for cluster circles with count label. */
function clusterStyle(size: number): Style {
  let radius = 14;
  if (size >= 50) radius = 30;
  else if (size >= 25) radius = 24;
  else if (size >= 10) radius = 18;

  return new Style({
    image: new Circle({
      radius,
      fill: clusterFill,
      stroke: new Stroke({ color: "white", width: 2 }),
    }),
    text: new Text({
      text: size >= 1000 ? `${Math.round(size / 100) / 10}k` : size.toString(),
      fill: new Fill({ color: "#ffffff" }),
      font: "12px sans-serif",
    }),
  });
}

/** Style for individual (unclustered) node. */
function nodeStyle(online: boolean, selected: boolean): Style {
  return new Style({
    image: new Circle({
      radius: selected ? 10 : 6,
      fill: online ? onlineFill : offlineFill,
      stroke: selected ? orangeStroke : whiteStroke,
    }),
  });
}

/** Style for spiderfied node (same as regular node but always shown). */
function spiderfiedNodeStyle(online: boolean, selected: boolean): Style {
  return new Style({
    image: new Circle({
      radius: selected ? 10 : 6,
      fill: online ? onlineFill : offlineFill,
      stroke: selected ? orangeStroke : whiteStroke,
    }),
    text: new Text({
      text: "", // will be set per-feature
      offsetY: 14,
      fill: new Fill({ color: "#ffffff" }),
      stroke: new Stroke({ color: "#000000", width: 3 }),
      font: "13px sans-serif",
    }),
  });
}

const legStyle = new Style({
  stroke: new Stroke({
    color: "rgba(255, 255, 255, 0.55)",
    width: 1.5,
    lineDash: [6, 8],
  }),
});

// ---------------------------------------------------------------------------
// Spiderfy state
// ---------------------------------------------------------------------------

interface OlSpiderfyState {
  clusterFeature: Feature;
  center: Coordinate; // EPSG:3857
  centerLonLat: [number, number]; // EPSG:4326
  childFeatures: Feature<Point>[];
  spiderLayer: VectorLayer<VectorSource<Feature>, Feature>;
  legLayer: VectorLayer<VectorSource<Feature>, Feature>;
  animationId: number | null;
}

let activeState: OlSpiderfyState | null = null;

// ---------------------------------------------------------------------------
// Position calculation (in EPSG:3857 meters)
// ---------------------------------------------------------------------------

/**
 * Convert pixel offset to meters in EPSG:3857 at a given resolution.
 * resolution = meters per pixel at current zoom.
 */
function pixelsToMeters(pixels: number, resolution: number): number {
  return pixels * resolution;
}

function circlePositions(
  center: Coordinate,
  count: number,
  resolution: number,
  radiusPx: number = 40,
): Coordinate[] {
  const radius = pixelsToMeters(radiusPx, resolution);
  const positions: Coordinate[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    positions.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
    ]);
  }

  return positions;
}

function spiralPositions(
  center: Coordinate,
  count: number,
  resolution: number,
  baseRadiusPx: number = 30,
): Coordinate[] {
  const positions: Coordinate[] = [];

  for (let i = 0; i < count; i++) {
    const angle = i * GOLDEN_ANGLE;
    const r = pixelsToMeters(baseRadiusPx * Math.sqrt(i + 1), resolution);
    positions.push([
      center[0] + r * Math.cos(angle),
      center[1] + r * Math.sin(angle),
    ]);
  }

  return positions;
}

function computeSpiderfiedPositions(
  center: Coordinate,
  count: number,
  resolution: number,
): Coordinate[] {
  if (count <= 8) {
    return circlePositions(center, count, resolution);
  }
  return spiralPositions(center, count, resolution);
}

/**
 * Compute the edge offset for spider legs (same logic as Mapbox version).
 */
function clusterRadiusPx(pointCount: number): number {
  let r = 14;
  if (pointCount >= 50) r = 30;
  else if (pointCount >= 25) r = 24;
  else if (pointCount >= 10) r = 18;
  return r + 2;
}

// ---------------------------------------------------------------------------
// Interpolation for animation
// ---------------------------------------------------------------------------

function interpolate(from: Coordinate, to: Coordinate, t: number): Coordinate {
  const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
  return [
    from[0] + (to[0] - from[0]) * eased,
    from[1] + (to[1] - from[1]) * eased,
  ];
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/** Check if spiderfy is currently active. */
export function isOlSpiderfied(): boolean {
  return activeState !== null;
}

/** Remove spiderfy layers from the map. */
export function removeOlSpiderfy(map: OlMap): void {
  if (!activeState) return;

  if (activeState.animationId != null) {
    cancelAnimationFrame(activeState.animationId);
  }

  map.removeLayer(activeState.legLayer);
  map.removeLayer(activeState.spiderLayer);
  activeState = null;
}

/**
 * Spiderfy a cluster feature — fan out its children with animation.
 */
export function olSpiderfy(
  map: OlMap,
  clusterFeature: Feature,
  animate: boolean = true,
): void {
  // Remove any prior spiderfy
  removeOlSpiderfy(map);

  const childFeatures = (clusterFeature.get("features") ?? []) as Feature<Point>[];
  if (childFeatures.length < 2) return;

  const clusterGeom = clusterFeature.getGeometry() as Point | undefined;
  if (!clusterGeom) return;

  const center = clusterGeom.getCoordinates();
  const centerLonLat = toLonLat(center) as [number, number];
  const resolution = map.getView().getResolution() ?? 1;

  const finalPositions = computeSpiderfiedPositions(center, childFeatures.length, resolution);

  // Create spider node features
  const spiderFeatures: Feature<Point>[] = childFeatures.map((child, i) => {
    const nodeData = child.get("node") as IFeatureNode | undefined;
    const f = new Feature<Point>({
      geometry: new Point(animate ? center.slice() : finalPositions[i]),
      node: nodeData,
      _spiderfied: true,
      _targetPosition: finalPositions[i],
    });

    const online = nodeData?.online ?? false;
    const style = spiderfiedNodeStyle(online, false);
    // Set the label text
    const textStyle = style.getText();
    if (textStyle && nodeData?.shortname) {
      textStyle.setText(nodeData.shortname);
    }
    f.setStyle(style);

    return f;
  });

  // Create leg features (lines from cluster edge to each spider node)
  const edgeOffset = pixelsToMeters(clusterRadiusPx(childFeatures.length), resolution);
  const legFeatures: Feature<LineString>[] = finalPositions.map((pos) => {
    const dx = pos[0] - center[0];
    const dy = pos[1] - center[1];
    const dist = Math.sqrt(dx * dx + dy * dy);

    const legStart: Coordinate = dist > 0
      ? [center[0] + (dx / dist) * edgeOffset, center[1] + (dy / dist) * edgeOffset]
      : center;

    const f = new Feature<LineString>({
      geometry: new LineString([legStart, animate ? center.slice() : pos]),
    });
    f.setStyle(legStyle);
    return f;
  });

  // Create layers
  const spiderSource = new VectorSource({ features: spiderFeatures as Feature[] });
  const spiderLayer = new VectorLayer({
    source: spiderSource,
    zIndex: 100,
  });

  const legSource = new VectorSource({ features: legFeatures as Feature[] });
  const legLayer = new VectorLayer({
    source: legSource,
    zIndex: 99,
  });

  map.addLayer(legLayer);
  map.addLayer(spiderLayer);

  activeState = {
    clusterFeature,
    center,
    centerLonLat,
    childFeatures,
    spiderLayer,
    legLayer,
    animationId: null,
  };

  if (!animate) return;

  // Animate fan-out
  const start = performance.now();

  function frame(now: number) {
    if (!activeState) return;

    const elapsed = now - start;
    const t = Math.min(elapsed / ANIMATE_MS, 1);

    for (let i = 0; i < spiderFeatures.length; i++) {
      const currentPos = interpolate(center, finalPositions[i], t);
      spiderFeatures[i].getGeometry()!.setCoordinates(currentPos);

      // Update leg endpoint
      const legGeom = legFeatures[i].getGeometry()!;
      const coords = legGeom.getCoordinates();
      legGeom.setCoordinates([coords[0], currentPos]);
    }

    if (t < 1) {
      activeState.animationId = requestAnimationFrame(frame);
    } else {
      if (activeState) activeState.animationId = null;
    }
  }

  activeState.animationId = requestAnimationFrame(frame);
}

/**
 * Animate collapse of spiderfied nodes back to center, then remove.
 */
export function olUnspiderfy(map: OlMap): void {
  if (!activeState) return;

  const { center, spiderLayer, legLayer, animationId } = activeState;

  if (animationId != null) {
    cancelAnimationFrame(animationId);
  }

  const spiderFeatures = spiderLayer.getSource()?.getFeatures() ?? [];
  const legFeatures = legLayer.getSource()?.getFeatures() ?? [];

  // Capture current positions
  const currentPositions: Coordinate[] = spiderFeatures.map((f) => {
    const geom = f.getGeometry() as Point;
    return geom.getCoordinates().slice();
  });

  // Clear activeState early to prevent re-spiderfy during collapse
  const stateRef = activeState;
  activeState = null;

  const start = performance.now();
  const collapseDuration = ANIMATE_MS * 0.7;

  function frame(now: number) {
    const elapsed = now - start;
    const t = Math.min(elapsed / collapseDuration, 1);

    for (let i = 0; i < spiderFeatures.length; i++) {
      const pos = interpolate(currentPositions[i], center, t);
      (spiderFeatures[i].getGeometry() as Point).setCoordinates(pos);

      if (i < legFeatures.length) {
        const legGeom = legFeatures[i].getGeometry() as LineString;
        const coords = legGeom.getCoordinates();
        legGeom.setCoordinates([coords[0], pos]);
      }
    }

    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      map.removeLayer(stateRef.legLayer);
      map.removeLayer(stateRef.spiderLayer);
    }
  }

  requestAnimationFrame(frame);
}

/**
 * Update spiderfy positions after zoom change.
 */
export function updateOlSpiderfyPositions(map: OlMap): void {
  if (!activeState) return;

  const zoom = map.getView().getZoom() ?? 0;

  // Collapse if zoomed out past threshold
  if (zoom < AUTO_SPIDERFY_MIN_ZOOM) {
    removeOlSpiderfy(map);
    return;
  }

  const { center, childFeatures, spiderLayer, legLayer } = activeState;
  const resolution = map.getView().getResolution() ?? 1;

  const positions = computeSpiderfiedPositions(center, childFeatures.length, resolution);
  const edgeOffset = pixelsToMeters(clusterRadiusPx(childFeatures.length), resolution);

  const spiderFeatures = spiderLayer.getSource()?.getFeatures() ?? [];
  const legFeatures = legLayer.getSource()?.getFeatures() ?? [];

  for (let i = 0; i < spiderFeatures.length && i < positions.length; i++) {
    (spiderFeatures[i].getGeometry() as Point).setCoordinates(positions[i]);

    if (i < legFeatures.length) {
      const dx = positions[i][0] - center[0];
      const dy = positions[i][1] - center[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const legStart: Coordinate = dist > 0
        ? [center[0] + (dx / dist) * edgeOffset, center[1] + (dy / dist) * edgeOffset]
        : center;
      (legFeatures[i].getGeometry() as LineString).setCoordinates([legStart, positions[i]]);
    }
  }
}

/**
 * Check if all children of a cluster are co-located (within ~5px of each other).
 * This means they can't separate further by zooming — same as Mapbox's
 * "expansion zoom >= max zoom" check.
 */
function areChildrenColocated(map: OlMap, children: Feature[]): boolean {
  if (children.length < 2) return false;

  const first = (children[0].getGeometry() as Point).getCoordinates();
  const resolution = map.getView().getResolution() ?? 1;
  // ~5 pixels — truly overlapping, not just nearby
  const threshold = 5 * resolution;

  return children.every((c) => {
    const pos = (c.getGeometry() as Point).getCoordinates();
    const dx = pos[0] - first[0];
    const dy = pos[1] - first[1];
    return Math.sqrt(dx * dx + dy * dy) < threshold;
  });
}

/**
 * Auto-spiderfy visible clusters that can't expand further.
 * For OL, we check if any cluster at high zoom still has > 1 child.
 */
export function autoOlSpiderfy(
  map: OlMap,
  clusterSource: Cluster,
): void {
  if (activeState) return;

  const zoom = map.getView().getZoom() ?? 0;
  if (zoom < AUTO_SPIDERFY_MIN_ZOOM) return;

  // Get all cluster features from the cluster source
  const clusterFeatures = clusterSource.getFeatures();

  for (const cf of clusterFeatures) {
    const children = (cf.get("features") ?? []) as Feature[];
    if (children.length < 2) continue;

    // Only auto-spiderfy truly co-located nodes (within ~5px of each other)
    // This matches the Mapbox behavior of only spiderfying when nodes can't separate
    if (areChildrenColocated(map, children)) {
      olSpiderfy(map, cf);
      return; // one at a time
    }
  }
}

// ---------------------------------------------------------------------------
// Create clustered source + layer (replaces the plain VectorSource/VectorLayer)
// ---------------------------------------------------------------------------

export interface OlClusterSetup {
  /** The raw feature source (add/remove node features here) */
  featureSource: VectorSource;
  /** The cluster source wrapping featureSource */
  clusterSource: Cluster;
  /** The cluster layer to add to the map */
  clusterLayer: VectorLayer<Cluster, Feature>;
}

/**
 * Create clustered OL source + layer.
 * The returned featureSource is where you add/remove node Features.
 */
export function createOlClusterLayer(features: Feature<Point>[]): OlClusterSetup {
  const featureSource = new VectorSource({ features: features as Feature[] });

  const clusterSource = new Cluster({
    distance: CLUSTER_DISTANCE,
    source: featureSource,
  });

  const styleCache: Record<string, Style> = {};

  const clusterLayer = new VectorLayer({
    source: clusterSource,
    style(feature) {
      const children = (feature.get("features") ?? []) as Feature[];
      const size = children.length;

      if (size === 1) {
        // Single node — use its own style
        const nodeData = children[0].get("node") as IFeatureNode | undefined;
        const online = nodeData?.online ?? false;
        return nodeStyle(online, false);
      }

      // Cluster
      const key = `cluster-${size}`;
      if (!styleCache[key]) {
        styleCache[key] = clusterStyle(size);
      }
      return styleCache[key];
    },
  });

  return { featureSource, clusterSource, clusterLayer };
}

/**
 * Handle a click on the OL map when clustering is enabled.
 * Returns the IFeatureNode if a single node was clicked, or null.
 * Handles spiderfy expansion for clusters.
 */
export function handleOlClusterClick(
  map: OlMap,
  _clusterSource: Cluster,
  pixel: number[],
): IFeatureNode | null {
  const feature = map.forEachFeatureAtPixel(pixel, (f) => f) as Feature | undefined;
  if (!feature) {
    olUnspiderfy(map);
    return null;
  }

  // Check if this is a spiderfied node
  if (feature.get("_spiderfied")) {
    return (feature.get("node") as IFeatureNode) ?? null;
  }

  const children = feature.get("features") as Feature[] | undefined;

  // Not a cluster feature (e.g. neighbor line) — ignore
  if (!children) {
    return null;
  }

  if (children.length === 1) {
    // Single node — return it for details panel
    olUnspiderfy(map);
    return (children[0].get("node") as IFeatureNode) ?? null;
  }

  // It's a cluster — check if nodes are co-located (can't separate) or just nearby
  const view = map.getView();
  const zoom = view.getZoom() ?? 0;

  if (areChildrenColocated(map, children)) {
    // Nodes are at the same position — spiderfy (zooming won't help)
    olSpiderfy(map, feature);
    return null;
  }

  // Nodes are nearby but separable — zoom in to split the cluster
  const geom = feature.getGeometry() as Point;
  const coords = geom.getCoordinates();
  view.animate({
    center: coords,
    zoom: Math.min(zoom + 2, view.getMaxZoom() ?? 22),
    duration: 300,
  });

  return null;
}
