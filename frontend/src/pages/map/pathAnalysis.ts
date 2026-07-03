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

  // Reply rows (the only ones carrying the full per-leg SNR: the destination
  // appends its own reading, so snr_towards = route + 1) keep the REQUEST's
  // route order but swap the header endpoints — the towards path is
  // to → route → from, matching the official client's rendering.
  const snrTow = tr?.payload?.snr_towards;
  const isReply = Array.isArray(snrTow) && snrTow.length === route.length + 1;
  const fullPath = isReply ? [tTo, ...route, tFrom] : [tFrom, ...route, tTo];

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
  if (isReply) {
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

/** Epoch that may be seconds or milliseconds → milliseconds. */
export function tsToMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}
