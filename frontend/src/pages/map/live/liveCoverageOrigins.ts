/**
 * Pure node-selection + dirty-signature for the live network-coverage layer.
 * No React, no map — easy to unit-test.
 */
import type { NodeRole } from "../../../types";
import type { IMapNode } from "../types";
import {
  LIVE_COVERAGE_MAX_ORIGINS,
  LIVE_COVERAGE_MAX_SPAN_KM,
  LIVE_COVERAGE_RECENCY_MS,
} from "./liveCoverageRoles";

/** A node resolved to the minimum it contributes to a coverage build. */
export interface LiveCoverageNode {
  id: string;
  /** [lng, lat]. */
  position: [number, number];
  /** GPS MSL altitude (m) if known/valid, else null. */
  altitudeM: number | null;
  role: NodeRole;
  lastSeenMs: number;
}

export interface LiveCoverageSelection {
  /** Capped, span-clustered origins used for the build. */
  selected: LiveCoverageNode[];
  /** Count of all role+recency+position-valid candidates (before the cap). */
  total: number;
}

const R_EARTH_KM = 6371;

function haversineKm(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

function lastSeenMs(node: IMapNode): number {
  if (!node.last_seen) return NaN;
  const t = new Date(node.last_seen as string).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function validCoord(pos: [number, number] | undefined): pos is [number, number] {
  if (!pos) return false;
  const [lng, lat] = pos;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng === 0 && lat === 0) return false; // null-island sentinel
  return lng >= -180 && lng <= 180 && lat >= -85 && lat <= 85;
}

/** Eligible nodes (role + recency + position), recency-sorted, capped, then
 *  span-clamped around the centroid so a stray position can't inflate the bbox. */
export function selectLiveCoverageNodes(
  nodes: Record<string, IMapNode>,
  roles: ReadonlySet<NodeRole>,
  nowMs: number,
  maxOrigins: number = LIVE_COVERAGE_MAX_ORIGINS,
): LiveCoverageSelection {
  const candidates: LiveCoverageNode[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const role = node.role;
    if (role == null || !roles.has(role)) continue;
    if (!validCoord(node.map_position)) continue;
    const seen = lastSeenMs(node);
    if (!Number.isFinite(seen) || nowMs - seen > LIVE_COVERAGE_RECENCY_MS) continue;
    const pos = node.map_position as [number, number];
    candidates.push({
      id: id.startsWith("!") ? id.slice(1) : id,
      position: [pos[0], pos[1]],
      altitudeM: node.position?.altitude ?? null,
      role,
      lastSeenMs: seen,
    });
  }

  const total = candidates.length;
  if (total === 0) return { selected: [], total };

  // Most-recently-heard first, then take the cap.
  candidates.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  const working = candidates.slice(0, maxOrigins);

  // Drop outliers beyond the span cap from the working-set centroid.
  let sx = 0;
  let sy = 0;
  for (const n of working) {
    sx += n.position[0];
    sy += n.position[1];
  }
  const centroid: [number, number] = [sx / working.length, sy / working.length];
  const selected = working.filter(
    (n) => haversineKm(n.position, centroid) <= LIVE_COVERAGE_MAX_SPAN_KM,
  );

  return { selected, total };
}

/** Dirty-key for the set. Excludes `last_seen` (re-heard churn ≠ rebuild); only
 *  membership / position / altitude / role changes it. 5 dp ignores GPS jitter. */
export function liveCoverageSignature(
  selected: readonly LiveCoverageNode[],
  roles: readonly NodeRole[],
): string {
  const rolePart = [...roles].sort((a, b) => a - b).join(",");
  const nodeParts = selected
    .map(
      (n) =>
        `${n.id}:${n.role}:${n.position[0].toFixed(5)}:${n.position[1].toFixed(5)}:${
          n.altitudeM == null ? "_" : Math.round(n.altitudeM)
        }`,
    )
    .sort();
  return `${rolePart}|${nodeParts.join("|")}`;
}
