/**
 * Analyze traceroute data to find paths between two nodes.
 */
import type { ITraceroutesResponse } from "../../types";
import { normNodeId } from "./linkFeatures";

export interface AnalyzedPath {
  hops: string[]; // normalized node IDs [from, ...intermediates, to]
  hopCount: number;
  snr?: number;
  rssi?: number;
  timestamp: number;
}

/**
 * Find all unique traceroute paths between two nodes (either direction).
 * Returns paths sorted by hop count ascending (shortest first).
 */
export function findPathsBetween(
  fromId: string,
  toId: string,
  traceroutes: ITraceroutesResponse[],
): AnalyzedPath[] {
  const a = normNodeId(fromId);
  const b = normNodeId(toId);
  if (!a || !b || a === b) return [];

  const paths: AnalyzedPath[] = [];
  const seenSignatures = new Set<string>();

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

    // Extract the subpath between the two nodes
    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    const sub = fullPath.slice(lo, hi + 1);
    // Orient so it always goes a → b
    const hops = idxA < idxB ? sub : sub.slice().reverse();

    const sig = hops.join(">");
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    paths.push({
      hops,
      hopCount: hops.length - 1,
      snr: (tr as any).snr,
      rssi: (tr as any).rssi,
      timestamp: tr.timestamp ?? 0,
    });
  }

  paths.sort((x, y) => x.hopCount - y.hopCount || y.timestamp - x.timestamp);
  return paths;
}
