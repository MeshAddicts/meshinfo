/** Fetch the node set from meshinfo and reduce to coverage origins. */
import { txDbmForRole } from "../src/pages/map/live/liveCoverageParams";
import { fetchWithTimeout } from "../src/pages/map/terrain/fetchWithTimeout";
import type { NodeRole } from "../src/types";
import { BBOX, MESHINFO_URL, reachKmForRole, RECENCY_HOURS } from "./config";

export interface CoverageOrigin {
  id: string;
  lng: number;
  lat: number;
  /** GPS MSL altitude (m) if reported + sane, else null. */
  altitudeM: number | null;
  txDbm: number;
  reachKm: number;
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

/** GET /v1/nodes → positioned nodes heard within the recency window. All roles.
 *  Sorted by id: origins[0] anchors the bake's longitude frame (and the sticky
 *  bbox), so the order must not depend on API response ordering. */
export async function fetchCoverageOrigins(nowMs: number): Promise<CoverageOrigin[]> {
  // The API pre-filters by whole days; round up so RECENCY_HOURS > 24 works.
  const days = Math.max(1, Math.ceil(RECENCY_HOURS / 24));
  const res = await fetchWithTimeout(`${MESHINFO_URL}/v1/nodes?days=${days}`, { timeoutMs: 30_000 });
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
    // Quantize position (~100 m) / altitude (5 m) so GPS jitter doesn't read as movement.
    out.push({
      id,
      lng: Math.round(lng * 1000) / 1000,
      lat: Math.round(lat * 1000) / 1000,
      altitudeM:
        typeof pos.altitude === "number" && Number.isFinite(pos.altitude)
          ? Math.round(pos.altitude / 5) * 5
          : null,
      txDbm: txDbmForRole(role),
      reachKm: reachKmForRole(role),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
