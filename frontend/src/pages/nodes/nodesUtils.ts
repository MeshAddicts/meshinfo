import { INode } from "../../types";

export type RangeKey = "1h" | "24h" | "7d" | "all";
export type StatusKey = "all" | "online" | "offline";
export type SortByKey = "seen" | "name" | "dx" | "alt" | "batt";
export type SortDir = "asc" | "desc";

export function cleanNodeId(id: unknown) {
  const s = String(id ?? "").trim();
  if (!s) return "";
  return s.replace(/^!+/, "");
}

export function parseRangeKey(v: unknown): RangeKey {
  const s = String(v ?? "").trim();
  if (s === "1h" || s === "24h" || s === "7d" || s === "all") return s;
  return "24h";
}

export function parseStatusKey(v: unknown): StatusKey {
  const s = String(v ?? "").trim();
  if (s === "online" || s === "offline" || s === "all") return s;
  return "all";
}

export function parseSortByKey(v: unknown): SortByKey {
  const s = String(v ?? "").trim();
  if (s === "seen" || s === "name" || s === "dx" || s === "alt" || s === "batt") return s;
  return "seen";
}

export function parseSortDir(v: unknown): SortDir {
  const s = String(v ?? "").trim();
  if (s === "asc" || s === "desc") return s;
  return "desc";
}

export function safeLastSeenMs(lastSeen: unknown): number | null {
  if (!lastSeen) return null;
  const t = new Date(String(lastSeen)).getTime();
  return Number.isFinite(t) ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function getLatLon(node: INode): [number, number] | null {
  const n: any = node as any;

  // prefer map_position if present
  const mp = n?.map_position;
  if (Array.isArray(mp) && mp.length === 2) {
    const lng = num(mp[0]);
    const lat = num(mp[1]);
    if (lng != null && lat != null) return [lng, lat];
  }

  const p = n?.position;
  if (!p) return null;

  const lngF = num(p.longitude);
  const latF = num(p.latitude);
  if (lngF != null && latF != null) return [lngF, latF];

  const lngI = num(p.longitude_i);
  const latI = num(p.latitude_i);
  if (lngI != null && latI != null) return [lngI / 1e7, latI / 1e7];

  return null;
}

export function isNodeOnline(node: INode): boolean {
  const n: any = node as any;

  const lastSeen = n?.last_seen;
  if (lastSeen) {
    const t = new Date(lastSeen).getTime();
    if (!Number.isNaN(t)) {
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      return Date.now() - t < SIX_HOURS_MS;
    }
  }

  return Boolean(n?.active);
}

export function roleLabel(role: unknown) {
  const r = Number(role);
  if (!Number.isFinite(r)) return "Unknown";
  switch (r) {
    case 0:
      return "Client";
    case 1:
      return "Client Mute";
    case 2:
      return "Router";
    case 3:
      return "Router Client";
    case 4:
      return "Repeater";
    case 5:
      return "Tracker";
    case 6:
      return "Sensor";
    case 7:
      return "ATAK";
    case 8:
      return "Client Hidden";
    case 9:
      return "Lost and Found";
    case 10:
      return "ATAK Tracker";
    default:
      return "Unknown";
  }
}

export function getTelemetrySnapshot(node: INode): {
  batteryPct: number | null;
  voltage: number | null;
  airTx: number | null;
  chanUtil: number | null;
  tempC: number | null;
  humidity: number | null;
} {
  const t: any = (node as any)?.telemetry ?? {};

  const battery =
    typeof t.battery_level === "number"
      ? t.battery_level
      : typeof t.batteryPct === "number"
        ? t.batteryPct
        : null;

  const voltage =
    typeof t.voltage === "number" ? t.voltage : null;

  const airTx =
    typeof t.air_utilization_tx === "number"
      ? t.air_utilization_tx
      : typeof t.air_util_tx === "number"
        ? t.air_util_tx
        : null;

  const chanUtil =
    typeof t.channel_utilization === "number"
      ? t.channel_utilization
      : typeof t.chan_util === "number"
        ? t.chan_util
        : null;

  const tempC = typeof t.temperature === "number" ? t.temperature : null;
  const humidity = typeof t.humidity === "number" ? t.humidity : null;

  return {
    batteryPct: typeof battery === "number" ? battery : null,
    voltage,
    airTx,
    chanUtil,
    tempC,
    humidity,
  };
}
