import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
  Point as GeoPoint,
} from "geojson";
import type { Map as MlMap } from "maplibre-gl";

import { removeSpiderfyLayers } from "./spiderfy";
import type { IMapNode } from "./types";

// Canonical palette lives in src/palette.ts; re-exported so the map's many
// `from "./utils"` call sites keep working unchanged.
export { DEFAULT_NODE_COLOR, OFFLINE_NODE_COLOR, ROLE_COLORS } from "../../palette";

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
  const R = 6371; // km
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

export function buildNodesGeoJSON(
  nodes: Record<string, IMapNode>,
  recentDays: number,
  filters?: { role?: number | null; channel?: string | null },
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  let recentNodeEntries = computeRecentNodes(nodes, recentDays);

  if (filters?.role != null) {
    recentNodeEntries = recentNodeEntries.filter(([, n]) => n.role === filters.role);
  }
  if (filters?.channel != null) {
    recentNodeEntries = recentNodeEntries.filter(([, n]) => n.last_channel === filters.channel);
  }

  const features: GeoFeature<GeoPoint, GeoJsonProperties>[] = [];

  for (const [id, node] of recentNodeEntries) {
    if (!node.map_position) continue;

    features.push({
      type: "Feature",
      id, // required for feature-state
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

export function applyClusterVisibility(map: MlMap, enabled: boolean): void {
  const set = (layerId: string, visible: boolean) => {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  };

  set("clusters", enabled);
  set("clusters-donuts", enabled);
  set("clusters-count", enabled);
  set("unclustered-pulse", enabled);
  set("unclustered-nodes", enabled);
  set("unclustered-labels", enabled);

  set("plain-pulse", !enabled);
  set("plain-nodes", !enabled);
  set("plain-labels", !enabled);

  // Either toggle direction invalidates the current fans (they belong to the
  // mode we're leaving); the matching auto-spiderfy pass re-creates them.
  removeSpiderfyLayers(map);
}
