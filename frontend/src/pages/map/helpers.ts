import type { Map as MlMap } from "maplibre-gl";

import type { ITraceroutesResponse } from "../../types";
import { AGGRESSION_STOPS, DEFAULT_AGGRESSION_IDX } from "./coverageAnalysis";
import { normNodeId } from "./linkFeatures";
import type { IMapNode } from "./types";
import { calculateGeodesicDistance, DEFAULT_NODE_COLOR, OFFLINE_NODE_COLOR, ROLE_COLORS } from "./utils";

// 1×1 transparent PNG placeholder for the coverage-raster source
export const TRANSPARENT_1PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** `map.queryTerrainElevation` returns `dem_m × exaggeration` with no opt-out;
 *  divide it back out for real MSL (RF math, hover pill, anywhere needing physical metres). */
export function queryTerrainElevationMSL(map: MlMap, lnglat: [number, number]): number | null {
  const e = map.queryTerrainElevation(lnglat);
  if (typeof e !== "number" || !Number.isFinite(e)) return null;
  const ex = map.getTerrain()?.exaggeration;
  const exaggeration = typeof ex === "number" && ex > 0 ? ex : 1;
  return e / exaggeration;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function clampAggressionIdx(idx: number): number {
  if (!Number.isInteger(idx)) return DEFAULT_AGGRESSION_IDX;
  if (idx < 0) return 0;
  if (idx >= AGGRESSION_STOPS.length) return AGGRESSION_STOPS.length - 1;
  return idx;
}

/** SVG signal bars (1-4) colored by best SNR. */
export function signalBarsHtml(snr: number | null): string {
  let bars: number;
  let color: string;
  if (snr == null) { bars = 0; color = "#6b7280"; }
  else if (snr >= 10) { bars = 4; color = "#22c55e"; }
  else if (snr >= 5) { bars = 3; color = "#84cc16"; }
  else if (snr >= 0) { bars = 2; color = "#eab308"; }
  else { bars = 1; color = "#ef4444"; }

  const heights = [4, 7, 10, 13];
  const rects = heights.map((h, i) => {
    const fill = i < bars ? color : "#374151";
    return `<rect x="${i * 5}" y="${16 - h}" width="3.5" height="${h}" rx="0.5" fill="${fill}"/>`;
  }).join("");
  return `<svg width="20" height="16" viewBox="0 0 20 16" style="vertical-align:middle;margin-right:4px">${rects}</svg>`;
}

/** Best (max) SNR from a node's neighbors. */
export function bestSnr(nodeId: string, nodes: Record<string, IMapNode>): number | null {
  const node = nodes[nodeId];
  if (!node?.neighbors?.length) return null;
  let max = -Infinity;
  for (const n of node.neighbors) {
    if (typeof n.snr === "number" && Number.isFinite(n.snr) && n.snr > max) max = n.snr;
  }
  return max === -Infinity ? null : max;
}

export function geodesicCircleCoords(
  center: [number, number], // [lon, lat]
  radiusKm: number,
  points: number = 64,
): [number, number][] {
  const R = 6371;
  const lat1 = (center[1] * Math.PI) / 180;
  const lon1 = (center[0] * Math.PI) / 180;
  const d = radiusKm / R;

  const coords: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const brng = (2 * Math.PI * i) / points;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return coords;
}

/** Max observed range (km) across neighbors, heard-by, and traceroute peers. */
export function computeMaxRange(
  nodeId: string,
  nodePos: [number, number], // [lon, lat]
  liveNodes: Record<string, IMapNode>,
  heardBy: string[],
  traceroutes: ITraceroutesResponse[],
): number | null {
  const connectedIds = new Set<string>();

  const node = liveNodes[nodeId];
  for (const n of node?.neighbors ?? []) connectedIds.add(n.id);

  for (const id of heardBy) connectedIds.add(id);

  // Traceroute peers (adjacent hops)
  const normId = normNodeId(nodeId);
  for (const tr of traceroutes) {
    const from = normNodeId(tr?.from);
    const to = normNodeId(tr?.to);
    const route: string[] = (tr?.route_ids ?? tr?.route ?? [])
      .map(normNodeId)
      .filter(Boolean);
    const path = [from, ...route, to].filter(Boolean);
    const idx = path.indexOf(normId);
    if (idx === -1) continue;
    if (idx > 0 && path[idx - 1]) connectedIds.add(path[idx - 1]);
    if (idx < path.length - 1 && path[idx + 1]) connectedIds.add(path[idx + 1]);
  }

  let maxDist = 0;
  for (const id of connectedIds) {
    const other = liveNodes[id] ?? liveNodes[`!${id}`];
    if (!other?.map_position) continue;
    const dist = calculateGeodesicDistance(
      nodePos[1], nodePos[0],
      other.map_position[1], other.map_position[0],
    );
    if (dist > maxDist) maxDist = dist;
  }
  return maxDist > 0.05 ? maxDist : null; // skip <50 m
}

// Role-based node color (offline = gray)
export const mbRoleColorExpr = [
  "case",
  ["!", ["boolean", ["get", "online"], false]],
  OFFLINE_NODE_COLOR,
  ["match", ["get", "role"],
    ...Object.entries(ROLE_COLORS).flatMap(([k, v]) => [Number(k), v]),
    DEFAULT_NODE_COLOR,
  ],
] as any;
