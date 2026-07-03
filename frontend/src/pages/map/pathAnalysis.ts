import type { ITraceroutesResponse } from "../../types";
import { normNodeId } from "./linkFeatures";

export interface AnalyzedPath {
  /** Normalized IDs: [from, ...intermediates, to]. */
  hops: string[];
  hopCount: number;
  snr?: number;
  rssi?: number;
  /** Newest observation of this exact hop sequence (epoch, s or ms as stored). */
  timestamp: number;
  /** Observations of this exact hop sequence in the fetched window. */
  count: number;
}

/** Unique traceroute paths between two nodes (either direction), newest first.
 *  Freshness outranks hop count: a stale one-hop fluke must not beat the route
 *  the mesh is actually using now. */
export function findPathsBetween(
  fromId: string,
  toId: string,
  traceroutes: ITraceroutesResponse[],
): AnalyzedPath[] {
  const a = normNodeId(fromId);
  const b = normNodeId(toId);
  if (!a || !b || a === b) return [];

  const bySig = new Map<string, AnalyzedPath>();

  for (const tr of traceroutes) {
    const tFrom = normNodeId(tr?.from);
    const tTo = normNodeId(tr?.to);
    const route: string[] = (tr?.route_ids ?? tr?.route ?? [])
      .map(normNodeId)
      .filter(Boolean);
    const fullPath = [tFrom, ...route, tTo].filter(Boolean);

    const idxA = fullPath.indexOf(a);
    const idxB = fullPath.indexOf(b);
    if (idxA === -1 || idxB === -1) continue;

    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    const sub = fullPath.slice(lo, hi + 1);
    // Orient a → b
    const hops = idxA < idxB ? sub : sub.slice().reverse();

    const sig = hops.join(">");
    const ts = tr.timestamp ?? 0;
    const existing = bySig.get(sig);
    if (existing) {
      existing.count += 1;
      if (ts > existing.timestamp) {
        existing.timestamp = ts;
        existing.snr = tr.snr;
        existing.rssi = tr.rssi;
      }
      continue;
    }
    bySig.set(sig, {
      hops,
      hopCount: hops.length - 1,
      snr: tr.snr,
      rssi: tr.rssi,
      timestamp: ts,
      count: 1,
    });
  }

  const paths = [...bySig.values()];
  paths.sort((x, y) => y.timestamp - x.timestamp || x.hopCount - y.hopCount);
  return paths;
}

/** Epoch that may be seconds or milliseconds → milliseconds. */
export function tsToMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}
