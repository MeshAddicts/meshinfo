import {
  canonicalPairKey,
  exchangeKeepMask,
  isResolvedHop,
  orientTraceroute,
} from "../../utils/traceroute";

export type NodesById = Record<
  string,
  { shortname?: string; longname?: string; id?: string }
>;

/** A traceroute row normalized into TRAVEL orientation at the coercion
 *  boundary: `from` is always the initiator (requester), `to` the traced
 *  target, and `route_ids` the travel-ordered intermediate hops — regardless
 *  of whether the underlying packet was the request or the reply (whose
 *  header endpoints arrive swapped). Raw header values are preserved in
 *  header_from/header_to for exports. */
export type TracerouteEvent = {
  __idx: number; // stable key helper
  timestamp: any;
  /** Initiator (requester) — travel orientation, not the packet header. */
  from: string;
  /** Target (traced node) — travel orientation, not the packet header. */
  to: string;
  hops_away: number | null;
  /** Travel-ordered intermediate hops, normalized to 8-hex where resolvable;
   *  unresolvable entries kept as-is / `?<raw>` placeholders. */
  route_ids: string[];
  route?: any;
  id?: number | string;
  snr?: number | null;
  rssi?: number | null;
  /** RouteDiscovery payload (snr_towards etc.) as served by the API. */
  payload?: {
    route?: (string | number)[];
    snr_towards?: number[];
    route_back?: (string | number)[];
    snr_back?: number[];
  };
  /** Reply packet (complete route; snr_towards = route + 1). */
  isReply: boolean;
  /** Mid-flight request: the final leg is implied by the header, and the
   *  exchange's reply was not (yet) observed. */
  provisional: boolean;
  /** Undirected canonical pair key (sorted `${min}|${max}`). */
  pairKey: string;
  /** Raw packet-header endpoints as received (swapped on reply rows). */
  header_from: string;
  header_to: string;
};

export type TracerouteGroup = {
  key: string; // `${from}|${to}|${routeIdsCsv}` — travel-oriented values
  from: string;
  to: string;
  route_ids: string[];
  hops_away: number | null;
  count: number;
  firstTsMs: number;
  lastTsMs: number;
  /** True when every observation of this route was a mid-flight request. */
  provisional: boolean;
};

export type TraceroutesListItem =
  | { kind: "event"; key: string; event: TracerouteEvent }
  | { kind: "route"; key: string; group: TracerouteGroup };

export function safeTsMs(ts: any): number {
  if (ts == null) return 0;
  if (typeof ts === "number") {
    // Heuristic: seconds vs ms
    if (ts < 1_000_000_000_000) return ts * 1000;
    return ts;
  }
  const parsed = Date.parse(String(ts));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function routeIdsOf(e: Pick<TracerouteEvent, "route_ids" | "route">): string[] {
  if (Array.isArray(e.route_ids) && e.route_ids.length > 0) return e.route_ids;
  // If backend ever sends route as ids
  if (Array.isArray(e.route) && e.route.length > 0 && typeof e.route[0] === "string") {
    return e.route as string[];
  }
  return [];
}

export function routeHopsOf(e: Pick<TracerouteEvent, "route_ids" | "route">): number {
  const r = routeIdsOf(e);
  if (r.length > 0) return r.length;
  if (Array.isArray(e.route)) return e.route.length;
  return 0;
}

/** Display label for a hop chip; UNK only for resolvable-but-unnamed ids.
 *  Placeholders/longnames/the 0xffffffff sentinel get honest labels and must
 *  not be rendered as node links (guard with isHopLinkable). */
export function hopChipLabel(nodes: NodesById, id: string): string {
  const named = nodes[id]?.shortname;
  if (named) return named;
  if (id === "ffffffff") return "unknown";
  if (id.startsWith("?")) return "unknown";
  if (!isResolvedHop(id)) return id; // longname text is more honest than UNK
  return "UNK";
}

/** Only resolvable hop ids may render as /nodes/<id> links. */
export function isHopLinkable(id: string): boolean {
  return isResolvedHop(id);
}

export function coerceEvent(raw: any, idx: number): TracerouteEvent {
  const o = orientTraceroute(raw);
  const headerFrom = raw?.from ?? "";
  const headerTo = raw?.to ?? "";
  return {
    __idx: idx,
    timestamp: raw?.timestamp,
    from: o ? o.initiator : headerFrom,
    to: o ? o.target : headerTo,
    hops_away: raw?.hops_away ?? null,
    route_ids: o
      ? o.orderedPath.slice(1, -1)
      : ((raw?.route_ids ?? []) as any[]).map((r) => String(r)),
    route: raw?.route,
    id: raw?.id,
    snr: raw?.snr ?? null,
    rssi: raw?.rssi ?? null,
    payload: raw?.payload,
    isReply: o?.isReply ?? false,
    provisional: o?.provisional ?? true,
    pairKey: o ? o.pairKey : canonicalPairKey(headerFrom, headerTo),
    header_from: headerFrom,
    header_to: headerTo,
  };
}

/** Collapse request+reply rows of one exchange to the reply (events are
 *  already travel-oriented, so the ExchangeView is a direct projection). */
export function dedupeExchangeEvents(events: TracerouteEvent[]): TracerouteEvent[] {
  const mask = exchangeKeepMask(
    events.map((e) =>
      e.from && e.to
        ? {
            initiator: e.from,
            target: e.to,
            isReply: e.isReply,
            orderedPath: [e.from, ...e.route_ids, e.to],
            ms: safeTsMs(e.timestamp),
          }
        : null,
    ),
  );
  return events.filter((_, i) => mask[i]);
}

export function groupTracerouteEvents(events: TracerouteEvent[]): TracerouteGroup[] {
  const map = new Map<string, TracerouteGroup>();

  for (const e of events) {
    const rids = routeIdsOf(e);
    const key = `${e.from}|${e.to}|${rids.join(",")}`;
    const ts = safeTsMs(e.timestamp);

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        from: e.from,
        to: e.to,
        route_ids: rids,
        hops_away: e.hops_away ?? null,
        count: 1,
        firstTsMs: ts,
        lastTsMs: ts,
        provisional: e.provisional,
      });
    } else {
      existing.count += 1;
      existing.firstTsMs = Math.min(existing.firstTsMs, ts || existing.firstTsMs);
      existing.lastTsMs = Math.max(existing.lastTsMs, ts || existing.lastTsMs);
      // Any confirmed (reply) observation clears the provisional flag.
      existing.provisional = existing.provisional && e.provisional;
      // Keep a simple representative hops_away (it should be stable anyway)
      if (typeof e.hops_away === "number") existing.hops_away = e.hops_away;
    }
  }

  return Array.from(map.values());
}
