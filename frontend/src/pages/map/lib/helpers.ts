import type { Map as MlMap } from "maplibre-gl";

import type { ITraceroutesResponse } from "../../../types";
import { isResolvedHop, orientTraceroute } from "../../../utils/traceroute";
import { AGGRESSION_STOPS, DEFAULT_AGGRESSION_IDX } from "../rf/coverageAnalysis";
import { normalizeLng } from "./geo";
import { normNodeId } from "./linkFeatures";
import type { IMapNode } from "./types";
import { calculateGeodesicDistance } from "./utils";
// Role-color expression now lives in the shared palette; re-export for existing importers.
export { mbRoleColorExpr } from "../../../palette";

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

/** Parse "lat, lng" → [lng, lat]. Accepts a trailing ° and N/S/E/W hemisphere
 *  (e.g. "37.5° N, 122.3° W"), comma- or whitespace-separated. Returns null if
 *  invalid or out of range. */
export function parseLatLng(input: string): [number, number] | null {
  const cleaned = input.trim().replace(/°/g, "");
  let latStr: string;
  let lngStr: string;
  if (cleaned.includes(",")) {
    const parts = cleaned.split(",");
    if (parts.length !== 2) return null;
    [latStr, lngStr] = parts;
  } else {
    const toks = cleaned.split(/\s+/).filter(Boolean);
    if (toks.length === 2) [latStr, lngStr] = toks;
    else if (toks.length === 4) { latStr = `${toks[0]} ${toks[1]}`; lngStr = `${toks[2]} ${toks[3]}`; }
    else return null;
  }
  const parse = (t: string): number | null => {
    const m = t.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
    if (!m) return null;
    let v = Number(m[1]);
    const h = m[2]?.toUpperCase();
    if (h === "S" || h === "W") v = -Math.abs(v);
    return Number.isFinite(v) ? v : null;
  };
  const lat = parse(latStr);
  const lng = parse(lngStr);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/** Format a [lng, lat] pair as "lat, lng" (Google-Maps order) at the given
 *  precision (default 5 dp ≈ 1 m). */
export function formatLatLng(lng: number, lat: number, precision = 5): string {
  return `${lat.toFixed(precision)}, ${lng.toFixed(precision)}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "Unknown";
  // Clamp: client clocks behind the server would render "-42s ago".
  const s = Math.max(0, Math.floor(ms / 1000));
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

/** Parse a draft, clamp to [min,max]; blank/non-finite → fallback. */
export function commitNumericDraft(draft: string, min: number, max: number, fallback: number): number {
  const trimmed = draft.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
    coords.push([normalizeLng((lon2 * 180) / Math.PI), (lat2 * 180) / Math.PI]);
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

  // Traceroute peers (adjacent hops, travel-ordered — a raw header walk
  // attributes both endpoint legs to the wrong nodes on reply rows)
  const normId = normNodeId(nodeId);
  for (const tr of traceroutes) {
    const o = orientTraceroute(tr);
    if (!o) continue;
    const path = o.orderedPath;
    const idx = path.indexOf(normId);
    if (idx === -1) continue;
    const prev = idx > 0 ? path[idx - 1] : null;
    // The final (…→target) leg of a mid-flight request was never observed.
    const nextIsProvisional = o.provisional && idx + 1 === path.length - 1;
    const next = idx < path.length - 1 && !nextIsProvisional ? path[idx + 1] : null;
    if (prev && isResolvedHop(prev) && !(o.provisional && idx === path.length - 1)) {
      connectedIds.add(prev);
    }
    if (next && isResolvedHop(next)) connectedIds.add(next);
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

