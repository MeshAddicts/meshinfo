/** Shared traceroute-row semantics: the single mandatory entry point for
 *  walking a traceroute's hop sequence.
 *
 *  Meshtastic RouteDiscovery accumulates hop-by-hop: `route` is the list of
 *  intermediate hops toward the destination, `snr_towards` the per-leg SNR
 *  (firmware-scaled ×4, -128 = unknown). The destination appends one extra
 *  SNR reading when building its REPLY, so a row with
 *  snr_towards.length === route.length + 1 is a reply packet: its header
 *  endpoints are swapped (from = traced node, to = requester) while the route
 *  stays request-ordered. The travel-ordered path is therefore
 *  to → route → from — a header swap, NOT a path reversal, so an ad-hoc
 *  [from, ...route, to] walk attributes both endpoint-adjacent legs to the
 *  wrong nodes on reply rows. Never walk rows by hand; use orientTraceroute.
 */
import { normNodeId } from "./normalizeNodeId8";

/** Structural row shape so slim REST rows, full SSE events, and page-coerced
 *  events all fit without casts. */
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
  /** Reply rows: the REQUEST's packet id (backend Data.request_id, stored in
   *  the packet_id column) — enables exact request/reply exchange pairing.
   *  Null/absent on request rows and rows written before it was captured. */
  packet_id?: number | string | null;
};

export interface OrientedTraceroute {
  /** Travel order [initiator, ...hops, target]; unresolvable hops kept as
   *  `?<raw>` placeholders so hop counts and per-leg SNR stay aligned. */
  orderedPath: string[];
  /** Requester (header `from` on request rows, header `to` on reply rows). */
  initiator: string;
  /** Traced node. */
  target: string;
  isReply: boolean;
  /** Request seen mid-flight: the final orderedPath leg (…→target) is implied
   *  by the header, not observed. Aggregations must skip that leg. */
  provisional: boolean;
  /** Undirected canonical pair key: sorted `${min}|${max}`. */
  pairKey: string;
  /** Decoded per-leg SNR in dB aligned to orderedPath legs (legSnrDb[i] is the
   *  orderedPath[i]→orderedPath[i+1] leg; null = unknown). Present on reply
   *  rows (all legs) and on requests carrying a partial snr_towards (all but
   *  the final leg); absent when the row has no usable snr_towards. */
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

/** Resolved node ids normalize to exactly 8 lowercase hex chars (numbers and
 *  long decimal strings are padded; backend ids are always 8-hex); longnames,
 *  `?<raw>` placeholders — and hex-lookalike longnames like "cafe", which a
 *  looser length would admit — don't. The broadcast sentinel is a real hex id
 *  but never a routable node. Edges touching any of these can't be
 *  positioned, clicked, or counted as observed links. */
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

/** Orient one traceroute row into travel order. Returns null when either
 *  header endpoint is missing/invalid. Cached per row object (rows are
 *  replaced wholesale on refetch, so identity keying is safe). */
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
  // Keep unresolvable hops as placeholders instead of dropping them — a drop
  // would shrink the hop count and shift per-leg SNR alignment.
  const route = raw.map((r) => normNodeId(r) || `?${String(r)}`);

  const snrTow = tr.payload?.snr_towards;
  const isReply = Array.isArray(snrTow) && snrTow.length === route.length + 1;

  // The towards journey is initiator → route → target in BOTH cases;
  // snr_towards[i] is the orderedPath[i]→orderedPath[i+1] leg either way.
  const orderedPath = isReply ? [tTo, ...route, tFrom] : [tFrom, ...route, tTo];
  const initiator = orderedPath[0];
  const target = orderedPath[orderedPath.length - 1];

  let legSnrDb: (number | null)[] | undefined;
  if (Array.isArray(snrTow)) {
    if (isReply) {
      legSnrDb = snrTow.map(decodeSnr);
    } else if (snrTow.length === route.length && route.length > 0) {
      // Mid-flight request: SNR was measured for every observed leg; only the
      // final (…→target) leg is unobserved. Anything else is a length
      // mismatch we can't align safely.
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

/** Accumulated-data metric for competing copies of ONE packet — mirrors the
 *  backend's richer-wins upsert (sum of the four RouteDiscovery array
 *  lengths), with a deviation: the route component falls back to route_ids
 *  when payload.route is absent (slim REST rows strip the payload down to
 *  snr_towards). The metric is EXACT only between two full-payload rows;
 *  a slim REPLY row still under-counts (its route_back/snr_back are
 *  stripped), so callers must not richness-compare a slim row against a full
 *  one — see hasFullTraceroutePayload. Only meaningful between rows sharing
 *  a packet identity (id + header endpoints). */
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

/** True when the row carries the full RouteDiscovery payload (SSE rows, non-
 *  slim REST rows). Current-backend slim rows strip only payload.route (the
 *  back arrays now survive), older-backend slim rows stripped the back arrays
 *  too — either way payload.route is the reliable discriminator, and held
 *  rows lacking it are replaced by any full copy rather than richness-raced. */
export function hasFullTraceroutePayload(tr: TracerouteRowLike): boolean {
  return Array.isArray(tr.payload?.route);
}

/** One traceroute exchange writes up to two rows: the request packet (caught
 *  mid-flight, truncated route) and the reply packet (complete route).
 *  Counting both inflates runs/edge stats ~2× on well-heard pairs. */
export const EXCHANGE_WINDOW_MS = 60_000;

/** Minimal oriented view of a row for exchange matching — lets callers that
 *  already hold oriented data (e.g. page-coerced events) reuse the pairing
 *  algorithm without re-orienting. */
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

/** Core exchange pairing: returns a keep-mask over `items` (false = this row
 *  is the request half of a matched exchange and should collapse into its
 *  reply). Pairs exactly ONE request with ONE reply.
 *
 *  EXACT pairing: a reply carrying `replyTo` (the request's packet id, from
 *  the backend's packet_id capture) matches only the request whose own id
 *  equals it — no window, no path comparison, and no heuristic fallback for
 *  that reply (its request either exists or was never heard).
 *
 *  HEURISTIC fallback (historical rows without replyTo): same
 *  initiator/target, request within EXCHANGE_WINDOW_MS before the reply, and
 *  the request's observed hops (its orderedPath minus the speculative final
 *  target hop) a prefix of the reply's orderedPath.
 *
 *  Never merges two same-role rows — two requests are two attempts. null
 *  items (unorientable rows) are always kept. */
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

/** Collapse request+reply of one exchange to the reply row (see
 *  exchangeKeepMask for the pairing rules). Unmatched requests are kept — the
 *  exchange's reply was lost to RF and the mid-flight capture is all we have. */
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
