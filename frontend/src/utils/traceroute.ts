/** Shared traceroute-row semantics. snr_towards.length === route.length + 1 marks a
 *  reply: its header endpoints are swapped, so travel order is to → route → from.
 *  Always walk rows via orientTraceroute, never by hand. */
import { normNodeId } from "./normalizeNodeId8";

/** Structural row shape covering slim REST rows, full SSE events, and page-coerced events. */
export type TracerouteRowLike = {
  from?: string | number;
  to?: string | number;
  route_ids?: (string | number)[];
  route?: unknown;
  payload?: {
    route?: (string | number)[];
    snr_towards?: number[];
    route_back?: (string | number)[];
    snr_back?: number[];
  };
  timestamp?: number;
  id?: number | string;
  /** Reply rows: the REQUEST's packet id (backend Data.request_id); null/absent on requests. */
  packet_id?: number | string | null;
};

export interface OrientedTraceroute {
  /** Travel order [initiator, ...hops, target]; unresolvable hops kept as `?<raw>` placeholders. */
  orderedPath: string[];
  /** Requester (header `from` on request rows, header `to` on reply rows). */
  initiator: string;
  /** Traced node. */
  target: string;
  isReply: boolean;
  /** Mid-flight request: the final (…→target) leg is implied, not observed — skip it in aggregations. */
  provisional: boolean;
  /** Undirected canonical pair key: sorted `${min}|${max}`. */
  pairKey: string;
  /** Per-leg SNR in dB; legSnrDb[i] is the orderedPath[i]→orderedPath[i+1] leg,
   *  null = unknown, absent when the row has no usable snr_towards. */
  legSnrDb?: (number | null)[];
}

/** 0xFFFFFFFF: firmware's unknown-hop / broadcast sentinel. */
export const BROADCAST_ID = "ffffffff";

const SNR_UNKNOWN_SENTINEL = -128;

/** Decode a firmware ×4-scaled SNR value; -128 sentinel → null (unknown). */
export function decodeSnr(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw === SNR_UNKNOWN_SENTINEL) return null;
  return raw / 4;
}

/** Epoch that may be seconds or milliseconds → milliseconds. */
export function tsToMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

/** Exactly 8 lowercase hex chars and not the broadcast sentinel — longnames
 *  (even hex-lookalikes like "cafe") and `?<raw>` placeholders fail. */
export function isResolvedHop(hop: string): boolean {
  return /^[0-9a-f]{8}$/.test(hop) && hop !== BROADCAST_ID;
}

/** Undirected canonical pair key, independent of who initiated. */
export function canonicalPairKey(a: string | number, b: string | number): string {
  const na = normNodeId(a);
  const nb = normNodeId(b);
  return na < nb ? `${na}|${nb}` : `${nb}|${na}`;
}

const orientCache = new WeakMap<object, OrientedTraceroute | null>();

function rawRoute(tr: TracerouteRowLike): (string | number)[] {
  if (Array.isArray(tr.route_ids) && tr.route_ids.length > 0) return tr.route_ids;
  if (Array.isArray(tr.route) && tr.route.length > 0) return tr.route as (string | number)[];
  if (Array.isArray(tr.payload?.route)) return tr.payload.route;
  return [];
}

/** Orient a row into travel order; null when a header endpoint is missing. Cached per row object. */
export function orientTraceroute(tr: TracerouteRowLike | null | undefined): OrientedTraceroute | null {
  if (!tr || typeof tr !== "object") return null;
  const cached = orientCache.get(tr);
  if (cached !== undefined) return cached;

  const result = computeOriented(tr);
  orientCache.set(tr, result);
  return result;
}

function computeOriented(tr: TracerouteRowLike): OrientedTraceroute | null {
  const tFrom = normNodeId(tr.from);
  const tTo = normNodeId(tr.to);
  if (!tFrom || !tTo) return null;

  const raw = rawRoute(tr);
  // Keep unresolvable hops as placeholders — dropping them would shift per-leg SNR alignment.
  const route = raw.map((r) => normNodeId(r) || `?${String(r)}`);

  const snrTow = tr.payload?.snr_towards;
  const isReply = Array.isArray(snrTow) && snrTow.length === route.length + 1;

  // snr_towards[i] is the orderedPath[i]→orderedPath[i+1] leg in both cases.
  const orderedPath = isReply ? [tTo, ...route, tFrom] : [tFrom, ...route, tTo];
  const initiator = orderedPath[0];
  const target = orderedPath[orderedPath.length - 1];

  let legSnrDb: (number | null)[] | undefined;
  if (Array.isArray(snrTow)) {
    if (isReply) {
      legSnrDb = snrTow.map(decodeSnr);
    } else if (snrTow.length === route.length && route.length > 0) {
      // Mid-flight request: only the final (…→target) leg is unobserved; other lengths can't align.
      legSnrDb = [...snrTow.map(decodeSnr), null];
    }
  }

  return {
    orderedPath,
    initiator,
    target,
    isReply,
    provisional: !isReply,
    pairKey: initiator < target ? `${initiator}|${target}` : `${target}|${initiator}`,
    legSnrDb,
  };
}

/** Richer-wins metric (sum of RouteDiscovery array lengths) for competing copies of one
 *  packet. Slim rows under-count — never richness-compare a slim row against a full one. */
export function tracerouteRichness(tr: TracerouteRowLike): number {
  const p = tr.payload;
  const routeLen = Array.isArray(p?.route)
    ? p.route.length
    : Array.isArray(tr.route_ids)
      ? tr.route_ids.length
      : 0;
  return (
    routeLen +
    (Array.isArray(p?.snr_towards) ? p.snr_towards.length : 0) +
    (Array.isArray(p?.route_back) ? p.route_back.length : 0) +
    (Array.isArray(p?.snr_back) ? p.snr_back.length : 0)
  );
}

/** payload.route is the slim/full discriminator: slim REST rows always strip it.
 *  Rows lacking it are replaced by any full copy rather than richness-raced. */
export function hasFullTraceroutePayload(tr: TracerouteRowLike): boolean {
  return Array.isArray(tr.payload?.route);
}

/** Heuristic pairing window: one exchange writes up to two rows (mid-flight request + reply). */
export const EXCHANGE_WINDOW_MS = 60_000;

/** Minimal oriented view of a row for exchange matching. */
export interface ExchangeView {
  initiator: string;
  target: string;
  isReply: boolean;
  /** Travel order [initiator, ...hops, target]. */
  orderedPath: string[];
  /** Timestamp in milliseconds. */
  ms: number;
  /** The row's own packet id, when known. */
  id?: number | string | null;
  /** Reply rows: the request's packet id (exact pairing key), when known. */
  replyTo?: number | string | null;
}

/** Keep-mask over items (false = request half of a matched exchange). Replies with
 *  replyTo pair exactly by request id (no heuristic fallback); others use same
 *  endpoints + EXCHANGE_WINDOW_MS + observed-hops-prefix. null items are kept. */
export function exchangeKeepMask(items: (ExchangeView | null)[]): boolean[] {
  interface Entry {
    v: ExchangeView;
    matched: boolean;
  }
  const requests = new Map<string, Entry[]>(); // keyed initiator→target (directed)
  const requestsById = new Map<string, Entry>();
  const entries: (Entry | null)[] = items.map((v) => {
    if (!v) return null;
    const e: Entry = { v, matched: false };
    if (!v.isReply) {
      const key = `${v.initiator}>${v.target}`;
      const list = requests.get(key);
      if (list) list.push(e);
      else requests.set(key, [e]);
      if (v.id != null) requestsById.set(String(v.id), e);
    }
    return e;
  });

  for (const e of entries) {
    if (!e || !e.v.isReply) continue;

    if (e.v.replyTo != null) {
      const exact = requestsById.get(String(e.v.replyTo));
      if (
        exact &&
        !exact.matched &&
        exact.v.initiator === e.v.initiator &&
        exact.v.target === e.v.target
      ) {
        exact.matched = true;
      }
      continue; // exact-keyed replies never fall back to the heuristic
    }

    const candidates = requests.get(`${e.v.initiator}>${e.v.target}`);
    if (!candidates) continue;
    let best: Entry | null = null;
    for (const req of candidates) {
      if (req.matched) continue;
      const dt = e.v.ms - req.v.ms;
      if (dt < 0 || dt > EXCHANGE_WINDOW_MS) continue;
      const observed = req.v.orderedPath.slice(0, -1);
      if (observed.length >= e.v.orderedPath.length) continue;
      if (!observed.every((hop, i) => e.v.orderedPath[i] === hop)) continue;
      if (!best || req.v.ms > best.v.ms) best = req; // closest request before the reply
    }
    if (best) best.matched = true;
  }

  return entries.map((e) => e == null || !e.matched);
}

/** Collapse each matched request+reply to the reply row; unmatched requests are kept. */
export function dedupeExchanges<T extends TracerouteRowLike>(rows: T[]): T[] {
  const mask = exchangeKeepMask(
    rows.map((row) => {
      const o = orientTraceroute(row);
      if (!o) return null;
      return {
        initiator: o.initiator,
        target: o.target,
        isReply: o.isReply,
        orderedPath: o.orderedPath,
        ms: tsToMs(row.timestamp ?? 0),
        id: row.id,
        replyTo: row.packet_id,
      };
    }),
  );
  return rows.filter((_, i) => mask[i]);
}
