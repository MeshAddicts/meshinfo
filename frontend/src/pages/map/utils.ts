import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import type { Map as MbMap } from "mapbox-gl";
import type { Map as OlMap } from "ol";

import { removeSpiderfyLayers } from "./spiderfy";
import type { IMapNode } from "./types";

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function calculateGeodesicDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function computeRecentNodes(nodes: Record<string, IMapNode>, recentDays: number) {
  const recentCutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

  return Object.entries(nodes).filter(([_, node]) => {
    if (node.online) return true;
    if (!node.last_seen) return false;

    const lastSeenMs = new Date(node.last_seen).getTime();
    if (Number.isNaN(lastSeenMs)) return false;

    return lastSeenMs > recentCutoff;
  });
}

export function bumpOlRender(map: OlMap) {
  map.updateSize();
  map.renderSync();

  requestAnimationFrame(() => {
    map.updateSize();
    map.renderSync();
  });

  // One more delayed bump catches late layout/font/sidebar shifts.
  window.setTimeout(() => {
    map.updateSize();
    map.renderSync();
  }, 200);
}

export function buildNodesGeoJSON(
  nodes: Record<string, IMapNode>,
  recentDays: number
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  const recentNodeEntries = computeRecentNodes(nodes, recentDays);

  const features: GeoFeature<GeoPoint, GeoJsonProperties>[] = [];

  for (const [id, node] of recentNodeEntries) {
    if (!node.map_position) continue;

    features.push({
      type: "Feature",
      id, // important for feature-state selection
      properties: {
        id,
        shortname: node.shortname ?? "",
        longname: node.longname ?? "",
        last_seen: node.last_seen ?? "",
        online: Boolean(node.online),
        role: node.role ?? null,
      },
      geometry: {
        type: "Point",
        coordinates: [node.map_position[0], node.map_position[1]],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

export function emptyLineFeatureCollection(): FeatureCollection<GeoLineString, GeoJsonProperties> {
  return { type: "FeatureCollection", features: [] };
}

export function applyMapboxClusterVisibility(map: MbMap, enabled: boolean): void {
  const set = (layerId: string, visible: boolean) => {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  };

  // clustered set
  set("clusters", enabled);
  set("cluster-count", enabled);
  set("unclustered-pulse", enabled);
  set("unclustered-nodes", enabled);
  set("unclustered-labels", enabled);

  // plain set
  set("plain-pulse", !enabled);
  set("plain-nodes", !enabled);
  set("plain-labels", !enabled);

  // Clear spiderfy when switching away from clustered mode
  if (!enabled) {
    removeSpiderfyLayers(map);
  }
}
