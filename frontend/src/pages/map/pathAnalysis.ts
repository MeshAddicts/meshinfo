import type { ITraceroutesResponse } from "../../types";
import { normNodeId } from "./linkFeatures";

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
}

/** One observed traceroute run between the pair, oriented a → b. */
export interface TraceRun {
  sig: string;
  hops: string[];
  hopCount: number;
  timestamp: number;
}

const SNR_UNKNOWN_SENTINEL = -128;

/** Decode a firmware ×4-scaled SNR value; -128 sentinel → null (unknown). */
export function decodeSnr(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw === SNR_UNKNOWN_SENTINEL) return null;
  return raw / 4;
}

interface ExtractedPath {
  hops: string[];
  sig: string;
  timestamp: number;
  snr?: number;
  rssi?: number;
  legSnrDb?: (number | null)[];
  forward: boolean;
}

/** Travel-ordered full path for one row. Reply rows (the only ones carrying
 *  the full per-leg SNR: the destination appends its own reading, so
 *  snr_towards = route + 1) keep the REQUEST's route order but swap the header
 *  endpoints — the towards path is to → route → from, matching the official
 *  client. EVERY consumer of a row's hop sequence must route through here: a
 *  header swap is NOT a path reversal, so an ad-hoc [from,...route,to] walk
 *  attributes endpoint-adjacent legs to the wrong nodes on reply rows. */
function orientRow(
  tr: ITraceroutesResponse,
  tFrom: string,
  tTo: string,
  route: string[],
): { fullPath: string[]; isReply: boolean } {
  const snrTow = tr?.payload?.snr_towards;
  const isReply = Array.isArray(snrTow) && snrTow.length === route.length + 1;
  return { fullPath: isReply ? [tTo, ...route, tFrom] : [tFrom, ...route, tTo], isReply };
}

/** Extract the a→b sub-path of one traceroute row, or null if it doesn't
 *  contain both nodes. Shared by the dedup (paths) and chronological (runs)
 *  views so orientation semantics can never drift apart. */
function extractPathFromRow(a: string, b: string, tr: ITraceroutesResponse): ExtractedPath | null {
  const tFrom = normNodeId(tr?.from);
  const tTo = normNodeId(tr?.to);
  if (!tFrom || !tTo) return null;
  // Keep unresolvable hops as placeholders instead of dropping them — a drop
  // would shrink the hop count and shift per-leg SNR alignment.
  const route: string[] = ((tr?.route_ids ?? tr?.route ?? []) as (string | number)[])
    .map((r) => normNodeId(r) || `?${String(r)}`);

  const snrTow = tr?.payload?.snr_towards;
  const { fullPath, isReply } = orientRow(tr, tFrom, tTo, route);

  const idxA = fullPath.indexOf(a);
  const idxB = fullPath.indexOf(b);
  if (idxA === -1 || idxB === -1 || idxA === idxB) return null;

  const forward = idxA < idxB;
  const [lo, hi] = forward ? [idxA, idxB] : [idxB, idxA];
  const sub = fullPath.slice(lo, hi + 1);
  // Orient a → b
  const hops = forward ? sub : sub.slice().reverse();

  // snr_towards has one entry per leg of the request-oriented full path;
  // slice the legs covering [lo, hi] and flip them when we flipped the hops.
  let legSnrDb: (number | null)[] | undefined;
  if (isReply && Array.isArray(snrTow)) {
    const legs = snrTow.slice(lo, hi).map(decodeSnr);
    legSnrDb = forward ? legs : legs.slice().reverse();
  }

  return {
    hops,
    sig: hops.join(">"),
    timestamp: tr.timestamp ?? 0,
    snr: tr.snr,
    rssi: tr.rssi,
    legSnrDb,
    forward,
  };
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
    const ex = extractPathFromRow(a, b, tr);
    if (!ex) continue;

    const existing = bySig.get(ex.sig);
    if (existing) {
      existing.count += 1;
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
    });
  }

  const paths = [...bySig.values()];
  paths.sort((x, y) => y.timestamp - x.timestamp || x.hopCount - y.hopCount);
  return paths;
}

/** Every observed run between the pair, oldest first — the time-machine view.
 *  No dedup: repeated signatures are the point (stability over time). */
export function findRunsBetween(
  fromId: string,
  toId: string,
  traceroutes: ITraceroutesResponse[],
): TraceRun[] {
  const a = normNodeId(fromId);
  const b = normNodeId(toId);
  if (!a || !b || a === b) return [];

  const runs: TraceRun[] = [];
  for (const tr of traceroutes) {
    const ex = extractPathFromRow(a, b, tr);
    if (!ex) continue;
    runs.push({
      sig: ex.sig,
      hops: ex.hops,
      hopCount: ex.hops.length - 1,
      timestamp: ex.timestamp,
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

/** Resolved node ids normalize to bare lowercase hex; longnames and `?<raw>`
 *  placeholders don't, and their edges can't be positioned or clicked. */
const RESOLVED_ID = /^[0-9a-f]{1,8}$/;

/** Count how often each adjacent hop pair appears across runs — the mesh's
 *  busiest links. Edges touching an unresolved hop are skipped, and reply
 *  rows are travel-ordered via orientRow (endpoint-adjacent edges would
 *  otherwise be attributed to the wrong nodes). */
export function computeTraceEdgeStats(traceroutes: ITraceroutesResponse[]): TraceEdgeStat[] {
  const byKey = new Map<string, TraceEdgeStat>();
  for (const tr of traceroutes) {
    const tFrom = normNodeId(tr?.from);
    const tTo = normNodeId(tr?.to);
    if (!tFrom || !tTo) continue;
    const route = ((tr?.route_ids ?? tr?.route ?? []) as (string | number)[])
      .map((r) => normNodeId(r) || `?${String(r)}`);
    const { fullPath } = orientRow(tr, tFrom, tTo, route);
    const ts = tr.timestamp ?? 0;
    const seenInRun = new Set<string>();
    for (let i = 0; i + 1 < fullPath.length; i++) {
      const a = fullPath[i];
      const b = fullPath[i + 1];
      if (a === b || !RESOLVED_ID.test(a) || !RESOLVED_ID.test(b)) continue;
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

/** Epoch that may be seconds or milliseconds → milliseconds. */
export function tsToMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}
