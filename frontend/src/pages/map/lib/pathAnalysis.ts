import type { ITraceroutesResponse } from "../../../types";
import {
  dedupeExchanges,
  isResolvedHop,
  orientTraceroute,
} from "../../../utils/traceroute";
import { normNodeId } from "./linkFeatures";

// Re-exported from utils/traceroute so existing map imports keep working.
export { decodeSnr, tsToMs } from "../../../utils/traceroute";

export interface AnalyzedPath {
  /** Normalized IDs: [from, ...intermediates, to]. Unresolvable hops are kept
   *  as `?<raw>` placeholders so hop counts and per-leg SNR stay aligned. */
  hops: string[];
  hopCount: number;
  snr?: number;
  rssi?: number;
  /** Newest observation of this exact hop sequence (epoch, s or ms as stored). */
  timestamp: number;
  /** Observations of this exact hop sequence in the fetched window. */
  count: number;
  /** Per-leg SNR in dB (decoded ÷4; null = unknown), aligned so legSnrDb[i] is
   *  the hops[i]→hops[i+1] leg. Taken from the newest observation carrying it. */
  legSnrDb?: (number | null)[];
  /** True when the SNR was measured opposite to the displayed a→b orientation. */
  legSnrReversed?: boolean;
  /** Only request packets observed this sequence; the final (…→target) leg
   *  is implied by the header, not observed. */
  provisional: boolean;
  /** Displayed index of the unobserved leg (leg i = hops[i]→hops[i+1]), or
   *  null. NOT always last: a reversed a→b extraction puts it at index 0. */
  provisionalLegIndex: number | null;
}

/** One observed traceroute run between the pair, oriented a → b. */
export interface TraceRun {
  sig: string;
  hops: string[];
  hopCount: number;
  timestamp: number;
  /** Request-only observation — awaiting reply (exchange status). */
  provisional: boolean;
  /** See AnalyzedPath.provisionalLegIndex. */
  provisionalLegIndex: number | null;
}

interface ExtractedPath {
  hops: string[];
  sig: string;
  timestamp: number;
  snr?: number;
  rssi?: number;
  legSnrDb?: (number | null)[];
  forward: boolean;
  provisional: boolean;
  provisionalLegIndex: number | null;
}

/** Extract the a→b sub-path of one traceroute row, or null if it doesn't
 *  contain both nodes. Hop ordering and reply detection come from
 *  orientTraceroute — the mandatory entry point for walking a row's hops. */
function extractPathFromRow(a: string, b: string, tr: ITraceroutesResponse): ExtractedPath | null {
  const o = orientTraceroute(tr);
  if (!o) return null;
  const fullPath = o.orderedPath;

  const idxA = fullPath.indexOf(a);
  const idxB = fullPath.indexOf(b);
  if (idxA === -1 || idxB === -1 || idxA === idxB) return null;

  const forward = idxA < idxB;
  const [lo, hi] = forward ? [idxA, idxB] : [idxB, idxA];
  const sub = fullPath.slice(lo, hi + 1);
  // Orient a → b
  const hops = forward ? sub : sub.slice().reverse();

  // legSnrDb[i] covers the fullPath[i]→fullPath[i+1] leg; slice the legs
  // covering [lo, hi] and flip them when we flipped the hops.
  let legSnrDb: (number | null)[] | undefined;
  if (o.legSnrDb) {
    const legs = o.legSnrDb.slice(lo, hi);
    legSnrDb = forward ? legs : legs.slice().reverse();
  }

  // The unobserved leg is fullPath's last; it lands in this sub-path only when
  // the slice reaches the target — last leg when forward, leg 0 when reversed.
  let provisionalLegIndex: number | null = null;
  if (o.provisional && hi === fullPath.length - 1) {
    provisionalLegIndex = forward ? hops.length - 2 : 0;
  }

  return {
    hops,
    sig: hops.join(">"),
    timestamp: tr.timestamp ?? 0,
    snr: tr.snr ?? undefined,
    rssi: tr.rssi ?? undefined,
    legSnrDb,
    forward,
    provisional: o.provisional,
    provisionalLegIndex,
  };
}

/** Unique traceroute paths between two nodes (either direction), newest first.
 *  Freshness outranks hop count; request+reply rows of one exchange collapse
 *  to the reply before analysis. */
export function findPathsBetween(
  fromId: string,
  toId: string,
  traceroutes: ITraceroutesResponse[],
): AnalyzedPath[] {
  const a = normNodeId(fromId);
  const b = normNodeId(toId);
  if (!a || !b || a === b) return [];

  const bySig = new Map<string, AnalyzedPath>();

  for (const tr of dedupeExchanges(traceroutes)) {
    const ex = extractPathFromRow(a, b, tr);
    if (!ex) continue;

    const existing = bySig.get(ex.sig);
    if (existing) {
      existing.count += 1;
      // Any confirmed (reply) observation clears the provisional flag.
      existing.provisional = existing.provisional && ex.provisional;
      if (!existing.provisional) existing.provisionalLegIndex = null;
      if (ex.timestamp > existing.timestamp) {
        existing.timestamp = ex.timestamp;
        existing.snr = ex.snr;
        existing.rssi = ex.rssi;
        if (ex.legSnrDb) {
          existing.legSnrDb = ex.legSnrDb;
          existing.legSnrReversed = !ex.forward;
        }
      } else if (ex.legSnrDb && !existing.legSnrDb) {
        // An older observation is better than none for per-leg SNR
        existing.legSnrDb = ex.legSnrDb;
        existing.legSnrReversed = !ex.forward;
      }
      continue;
    }
    bySig.set(ex.sig, {
      hops: ex.hops,
      hopCount: ex.hops.length - 1,
      snr: ex.snr,
      rssi: ex.rssi,
      timestamp: ex.timestamp,
      count: 1,
      legSnrDb: ex.legSnrDb,
      legSnrReversed: ex.legSnrDb ? !ex.forward : undefined,
      provisional: ex.provisional,
      provisionalLegIndex: ex.provisionalLegIndex,
    });
  }

  const paths = [...bySig.values()];
  paths.sort((x, y) => y.timestamp - x.timestamp || x.hopCount - y.hopCount);
  return paths;
}

/** Every observed run between the pair, oldest first — the time-machine view.
 *  No dedup of repeated signatures, but request+reply packets of one exchange
 *  collapse to the reply so a single traceroute never counts as two runs. */
export function findRunsBetween(
  fromId: string,
  toId: string,
  traceroutes: ITraceroutesResponse[],
): TraceRun[] {
  const a = normNodeId(fromId);
  const b = normNodeId(toId);
  if (!a || !b || a === b) return [];

  const runs: TraceRun[] = [];
  for (const tr of dedupeExchanges(traceroutes)) {
    const ex = extractPathFromRow(a, b, tr);
    if (!ex) continue;
    runs.push({
      sig: ex.sig,
      hops: ex.hops,
      hopCount: ex.hops.length - 1,
      timestamp: ex.timestamp,
      provisional: ex.provisional,
      provisionalLegIndex: ex.provisionalLegIndex,
    });
  }
  runs.sort((x, y) => x.timestamp - y.timestamp);
  return runs;
}

/** Undirected hop-edge traversal stats across all observed traceroutes. */
export interface TraceEdgeStat {
  /** Sorted pair (aId < bId). */
  aId: string;
  bId: string;
  /** Observed runs traversing this edge (an edge counts once per run). */
  count: number;
  lastTimestamp: number;
}

/** Count how often each adjacent hop pair appears across runs — the mesh's
 *  busiest links. Skips unresolved/sentinel hops and a mid-flight request's
 *  speculative final leg; request+reply exchanges collapse to one run. */
export function computeTraceEdgeStats(traceroutes: ITraceroutesResponse[]): TraceEdgeStat[] {
  const byKey = new Map<string, TraceEdgeStat>();
  for (const tr of dedupeExchanges(traceroutes)) {
    const o = orientTraceroute(tr);
    if (!o) continue;
    const fullPath = o.orderedPath;
    const ts = tr.timestamp ?? 0;
    const lastLegIdx = fullPath.length - 2;
    const seenInRun = new Set<string>();
    for (let i = 0; i + 1 < fullPath.length; i++) {
      if (o.provisional && i === lastLegIdx) continue;
      const a = fullPath[i];
      const b = fullPath[i + 1];
      if (a === b || !isResolvedHop(a) || !isResolvedHop(b)) continue;
      const [ka, kb] = a < b ? [a, b] : [b, a];
      const key = `${ka}|${kb}`;
      if (seenInRun.has(key)) continue;
      seenInRun.add(key);
      const e = byKey.get(key);
      if (e) {
        e.count += 1;
        if (ts > e.lastTimestamp) e.lastTimestamp = ts;
      } else {
        byKey.set(key, { aId: ka, bId: kb, count: 1, lastTimestamp: ts });
      }
    }
  }
  return [...byKey.values()];
}
