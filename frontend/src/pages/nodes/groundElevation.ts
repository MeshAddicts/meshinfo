import { env } from "../../env";
import type { GroundSample } from "../map/rf/altitudeAssessment";
import { fetchElevationAt } from "../map/terrain/terrainRgb";

const cache = new Map<string, GroundSample | null>();
const inflight = new Map<string, Promise<GroundSample | null>>();

/** Box half-width (m) sampled around the node. */
const NEIGHBORHOOD_M = 75;
const RING = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

async function sampleGround(
  lng: number,
  lat: number,
  token: string,
): Promise<GroundSample | null> {
  const dLat = NEIGHBORHOOD_M / 111_320;
  const dLng = NEIGHBORHOOD_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  const vals = await Promise.all(
    RING.map(([ox, oy]) => fetchElevationAt(lng + ox * dLng, lat + oy * dLat, token)),
  );
  const finite = vals.filter((v): v is number => v != null);
  if (finite.length === 0) return null;
  return { min: Math.min(...finite), max: Math.max(...finite), center: vals[0] ?? finite[0] };
}

/** Cached neighborhood ground-elevation lookup keyed by node id. The inner
 *  fetchElevationAt LRU shares tiles across the ring and across nodes. */
export async function getGroundElevation(
  nodeId: string,
  lng: number,
  lat: number,
): Promise<GroundSample | null> {
  if (cache.has(nodeId)) return cache.get(nodeId) ?? null;
  const existing = inflight.get(nodeId);
  if (existing) return existing;

  const token = env.MAPBOX_TOKEN ?? "";
  const p = sampleGround(lng, lat, token)
    .then((g) => {
      cache.set(nodeId, g);
      inflight.delete(nodeId);
      return g;
    })
    .catch(() => {
      cache.set(nodeId, null);
      inflight.delete(nodeId);
      return null;
    });
  inflight.set(nodeId, p);
  return p;
}
