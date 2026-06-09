/** Fetch the node set from meshinfo and reduce to coverage origins. */
import type { NodeRole } from "../src/types";
import { BBOX, MESHINFO_URL, reachKmForRole, RECENCY_HOURS } from "./config";
import { txDbmForRole } from "../src/pages/map/live/liveCoverageParams";

export interface CoverageOrigin {
  id: string;
  lng: number;
  lat: number;
  /** GPS MSL altitude (m) if reported + sane, else null. */
  altitudeM: number | null;
  role: NodeRole | undefined;
  txDbm: number;
  reachKm: number;
  lastSeenMs: number;
}

interface RawNode {
  role?: number;
  last_seen?: string | null;
  position?: { latitude_i?: number; longitude_i?: number; altitude?: number } | null;
}

function validLngLat(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng === 0 && lat === 0) return false;
  return lng >= -180 && lng <= 180 && lat >= -85 && lat <= 85;
}

/** GET /v1/nodes → positioned nodes heard within the recency window. All roles. */
export async function fetchCoverageOrigins(nowMs: number): Promise<CoverageOrigin[]> {
  const res = await fetch(`${MESHINFO_URL}/v1/nodes?days=1`);
  if (!res.ok) throw new Error(`/v1/nodes failed: HTTP ${res.status}`);
  const body = (await res.json()) as { nodes?: Record<string, RawNode> };
  const recencyMs = RECENCY_HOURS * 60 * 60 * 1000;
  const out: CoverageOrigin[] = [];
  for (const [id, n] of Object.entries(body.nodes ?? {})) {
    const pos = n.position;
    if (!pos || pos.latitude_i == null || pos.longitude_i == null) continue;
    const lng = pos.longitude_i / 1e7;
    const lat = pos.latitude_i / 1e7;
    if (!validLngLat(lng, lat)) continue;
    if (BBOX && (lng < BBOX[0] || lng > BBOX[2] || lat < BBOX[1] || lat > BBOX[3])) continue;
    if (!n.last_seen) continue;
    const seen = new Date(n.last_seen).getTime();
    if (!Number.isFinite(seen) || nowMs - seen > recencyMs) continue;
    const role = n.role as NodeRole | undefined;
    out.push({
      id,
      lng,
      lat,
      altitudeM: typeof pos.altitude === "number" && Number.isFinite(pos.altitude) ? pos.altitude : null,
      role,
      txDbm: txDbmForRole(role),
      reachKm: reachKmForRole(role),
      lastSeenMs: seen,
    });
  }
  return out;
}
