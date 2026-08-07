export type NodesById = Record<
  string,
  {
    id?: string;
    shortname?: string;
    longname?: string;
    telemetry?: any; // current snapshot from node_telemetry_current
  }
>;

export type TelemetryEvent = {
  __idx: number; // stable key helper
  timestamp: any;
  from: string;
  to?: string;
  sender?: string;
  id?: string;
  channel?: any;
  packet_id?: any;
  hops_away?: number;
  rssi?: number;
  snr?: number;
  payload: Record<string, any>;
};

export type TelemetryNodeSummary = {
  nodeId: string;
  count: number;
  firstTsMs: number;
  lastTsMs: number;
  latest: TelemetryEvent;
};

export type TelemetryListItem =
  | {
      kind: "all";
      key: "all";
      totalNodes: number;
      totalSamples: number;
      lastTsMs: number;
    }
  | {
      kind: "node";
      key: string; // node:<id>
      nodeId: string;
      summary: TelemetryNodeSummary;
    };

export type RangeKey = "all" | "1h" | "24h" | "7d";

export const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export type SortKey =
  | "last_desc"
  | "name_asc"
  | "samples_desc"
  | "battery_asc"
  | "voltage_asc"
  | "chanutil_desc"
  | "airutil_desc"
  | "temp_desc";

export function clampSort(s: any): SortKey {
  const allowed: SortKey[] = [
    "last_desc",
    "name_asc",
    "samples_desc",
    "battery_asc",
    "voltage_asc",
    "chanutil_desc",
    "airutil_desc",
    "temp_desc",
  ];
  return allowed.includes(s) ? s : "last_desc";
}

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

export function coerceTelemetryEvent(raw: any, idx: number): TelemetryEvent {
  return {
    __idx: idx,
    timestamp: raw?.timestamp ?? raw?.created_at ?? raw?.createdAt,
    from: raw?.from ?? raw?.from_node_id ?? raw?.fromNodeId ?? raw?.from_id,
    to: raw?.to ?? raw?.to_node_id ?? raw?.toNodeId ?? raw?.to_id,
    sender: raw?.sender ?? raw?.sender_node_id ?? raw?.senderNodeId,
    id: raw?.id ?? raw?.message_id ?? raw?.messageId,
    channel: raw?.channel,
    packet_id: raw?.packet_id ?? raw?.packetId,
    hops_away: raw?.hops_away ?? raw?.hopsAway,
    rssi: raw?.rssi,
    snr: raw?.snr,
    payload: (raw?.payload ?? {}) as Record<string, any>,
  };
}

export function getNodeLabel(nodes: NodesById, id: string): string {
  const n = nodes[id];
  return n?.shortname || n?.longname || id || "UNK";
}

export function toNumberLoose(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // strip common units and symbols
    const cleaned = s
      .replaceAll("%", "")
      .replaceAll("V", "")
      .replaceAll("v", "")
      .replaceAll("mA", "")
      .replaceAll("A", "")
      .replaceAll("°C", "")
      .replaceAll("C", "")
      .replaceAll("hPa", "")
      .replaceAll("Ω", "")
      .replaceAll("ohm", "")
      .trim();
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatMetricValue(
  key:
    | "battery_level"
    | "voltage"
    | "channel_utilization"
    | "air_util_tx"
    | "temperature"
    | "relative_humidity"
    | "barometric_pressure"
    | "gas_resistance"
    | "rssi"
    | "snr"
    | "uptime_seconds",
  v: any,
): string {
  const n = toNumberLoose(v);
  if (n == null) return "—";

  switch (key) {
    case "battery_level":
      return `${n.toFixed(0)}%`;
    case "voltage":
      return `${n.toFixed(2)} V`;
    case "channel_utilization":
      return `${n.toFixed(1)}%`;
    case "air_util_tx":
      return `${n.toFixed(2)}%`;
    case "temperature":
      return `${n.toFixed(1)} °C`;
    case "relative_humidity":
      return `${n.toFixed(1)}%`;
    case "barometric_pressure":
      return `${n.toFixed(1)} hPa`;
    case "gas_resistance":
      return `${n.toFixed(0)} Ω`;
    case "rssi":
      return `${n.toFixed(0)} dBm`;
    case "snr":
      return `${n.toFixed(1)} dB`;
    case "uptime_seconds":
      // show hours if large
      if (n >= 3600) return `${(n / 3600).toFixed(1)} h`;
      return `${Math.round(n)} s`;
    default:
      return String(v);
  }
}
