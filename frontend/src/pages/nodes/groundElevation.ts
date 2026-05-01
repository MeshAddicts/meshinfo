import { env } from "../../env";
import { fetchElevationAt } from "../map/terrainRgb";

const cache = new Map<string, number | null>();
const inflight = new Map<string, Promise<number | null>>();

/** Cached Tilezen ground-elevation lookup keyed by node id. Reuses the LRU
 *  inside fetchElevationAt; same lat/lng tile across nodes is shared. */
export async function getGroundElevation(
  nodeId: string,
  lng: number,
  lat: number,
): Promise<number | null> {
  if (cache.has(nodeId)) return cache.get(nodeId) ?? null;
  const existing = inflight.get(nodeId);
  if (existing) return existing;

  const token = env.MAPBOX_TOKEN ?? "";
  const p = fetchElevationAt(lng, lat, token)
    .then((elev) => {
      cache.set(nodeId, elev);
      inflight.delete(nodeId);
      return elev;
    })
    .catch(() => {
      cache.set(nodeId, null);
      inflight.delete(nodeId);
      return null;
    });
  inflight.set(nodeId, p);
  return p;
}

export interface AltitudeSanity {
  reportedM: number | null;
  groundM: number | null;
  /** Human-readable explanation of the flag, or null when the reading looks fine. */
  suspectReason: string | null;
}

/** Threshold (m) for flagging a reported altitude as inconsistent with terrain.
 *  Tall masts and rooftop installs sit comfortably below 50 m AGL. */
const ALT_DELTA_M = 50;

export function classifyAltitude(
  reported: number | null | undefined,
  ground: number | null,
): AltitudeSanity {
  const r =
    typeof reported === "number" && Number.isFinite(reported) ? reported : null;
  if (r == null) {
    return { reportedM: null, groundM: ground, suspectReason: null };
  }

  // 65535 is the Meshtastic "no altitude" sentinel from a uint16 overflow.
  if (Math.round(r) === 65535) {
    return {
      reportedM: r,
      groundM: ground,
      suspectReason: "Reports 65535 m — firmware sentinel for missing altitude.",
    };
  }

  if (ground != null) {
    const delta = r - ground;
    if (Math.abs(delta) > ALT_DELTA_M) {
      return {
        reportedM: r,
        groundM: ground,
        suspectReason: `Reports ${r.toFixed(0)} m; terrain here is ${ground.toFixed(0)} m (${delta >= 0 ? "+" : ""}${delta.toFixed(0)} m).`,
      };
    }
  }

  return { reportedM: r, groundM: ground, suspectReason: null };
}
