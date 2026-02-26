export type NodesById = Record<
  string,
  { shortname?: string; longname?: string; id?: string }
>;

export type TracerouteEvent = {
  __idx: number; // stable key helper
  timestamp: any;
  from: string;
  to: string;
  hops_away: number;
  route_ids?: string[];
  route?: any;
};

export type TracerouteGroup = {
  key: string; // from|to|routeIdsCsv
  from: string;
  to: string;
  route_ids: string[];
  hops_away: number;
  count: number;
  firstTsMs: number;
  lastTsMs: number;
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

export function coerceEvent(raw: any, idx: number): TracerouteEvent {
  return {
    __idx: idx,
    timestamp: raw?.timestamp,
    from: raw?.from,
    to: raw?.to,
    hops_away: raw?.hops_away ?? 0,
    route_ids: raw?.route_ids ?? [],
    route: raw?.route ?? [],
  };
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
        hops_away: e.hops_away ?? 0,
        count: 1,
        firstTsMs: ts,
        lastTsMs: ts,
      });
    } else {
      existing.count += 1;
      existing.firstTsMs = Math.min(existing.firstTsMs, ts || existing.firstTsMs);
      existing.lastTsMs = Math.max(existing.lastTsMs, ts || existing.lastTsMs);
      // Keep a simple representative hops_away (it should be stable anyway)
      if (typeof e.hops_away === "number") existing.hops_away = e.hops_away;
    }
  }

  return Array.from(map.values());
}

// ---------- small export helpers ----------

export function csvEscape(v: any): string {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function downloadBlob(filename: string, mime: string, text: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
