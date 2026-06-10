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

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
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
  const days = Number.isFinite(recentDays) && recentDays > 0 ? recentDays : 1;
  const recentCutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return Object.entries(nodes).filter(([_, node]) => {
    if (node.online) return true;
    if (!node.last_seen) return false;

    const lastSeenMs = new Date(node.last_seen).getTime();
    if (Number.isNaN(lastSeenMs)) return false;

    return lastSeenMs > recentCutoff;
  });
}

/** Node brightness (→ circle-opacity) by last_seen age, quantized so a re-heard
 *  node only changes the source on a bucket crossing. */
export function dimForLastSeen(lastSeen: unknown, nowMs: number): number {
  if (!lastSeen) return 0.4;
  const t = new Date(lastSeen as string).getTime();
  if (!Number.isFinite(t)) return 0.4;
  const ageMin = (nowMs - t) / 60000;
  if (ageMin < 15) return 1; // incl. negative (clock skew)
  if (ageMin < 60) return 0.85;
  if (ageMin < 180) return 0.7;
  if (ageMin < 360) return 0.55; // 6h online cutoff
  if (ageMin < 1440) return 0.45;
  return 0.35;
}

export function buildNodesGeoJSON(
  nodes: Record<string, IMapNode>,
  recentDays: number,
  filters?: { role?: number | null; channel?: string | null },
): FeatureCollection<GeoPoint, GeoJsonProperties> {
  let recentNodeEntries = computeRecentNodes(nodes, recentDays);
  const nowMs = Date.now();

  if (filters?.role != null) {
    recentNodeEntries = recentNodeEntries.filter(([, n]) => n.role === filters.role);
  }
  if (filters?.channel != null) {
    recentNodeEntries = recentNodeEntries.filter(([, n]) => n.last_channel === filters.channel);
  }

  const features: GeoFeature<GeoPoint, GeoJsonProperties>[] = [];

  for (const [id, node] of recentNodeEntries) {
    if (!node.map_position) continue;
    const [lon, lat] = node.map_position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

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
        dim: dimForLastSeen(node.last_seen, nowMs),
      },
      geometry: {
        type: "Point",
        coordinates: [node.map_position[0], node.map_position[1]],
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/** FNV-1a over each node feature's identity + live state, so the setData effect
 *  can skip no-op re-uploads (and the donut rebuild each setData triggers). */
export function nodesDataSignature(
  fc: FeatureCollection<GeoPoint, GeoJsonProperties>,
): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    }
    h = Math.imul(h ^ 0x2c, 0x01000193); // separator
  };
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const c = (f.geometry as GeoPoint).coordinates;
    mix(
      `${f.id}|${p.last_seen ?? ""}|${p.online ? 1 : 0}|${p.role ?? ""}|${p.dim ?? ""}|` +
        `${Math.round((c[0] ?? 0) * 1e5)}|${Math.round((c[1] ?? 0) * 1e5)}`,
    );
  }
  return h >>> 0;
}

export function emptyLineFeatureCollection(): FeatureCollection<GeoLineString, GeoJsonProperties> {
  return { type: "FeatureCollection", features: [] };
}

export function applyClusterVisibility(map: MlMap, enabled: boolean, hideAll = false): void {
  const set = (layerId: string, visible: boolean) => {
    if (!map.getLayer(layerId)) return;
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  };

  set("clusters", enabled && !hideAll);
  set("clusters-donuts", enabled && !hideAll);
  set("clusters-count", enabled && !hideAll);
  set("unclustered-pulse", enabled && !hideAll);
  set("unclustered-nodes", enabled && !hideAll);
  set("unclustered-labels", enabled && !hideAll);

  set("plain-pulse", !enabled && !hideAll);
  set("plain-nodes", !enabled && !hideAll);
  set("plain-labels", !enabled && !hideAll);

  // Either toggle direction invalidates the current fans (they belong to the
  // mode we're leaving); the matching auto-spiderfy pass re-creates them.
  removeSpiderfyLayers(map);
}
