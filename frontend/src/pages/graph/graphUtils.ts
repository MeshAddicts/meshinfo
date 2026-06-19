/**
 * graphUtils.ts — Pure helpers, types, and ID normalization.
 */

import { ROLE_COLORS } from "../../palette";

export function normNodeId(raw: any): string {
  if (raw == null) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    return (raw >>> 0).toString(16).toLowerCase();
  }
  let s = String(raw).trim();
  if (/^\d+$/.test(s) && s.length > 6) {
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) return (n >>> 0).toString(16).toLowerCase();
  }
  if (s.startsWith("!")) s = s.slice(1);
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  return s.toLowerCase();
}

export function getBestNodeLabel(n: any, idFallback: string) {
  const short = n?.shortname ?? n?.shortName ?? n?.short_name ?? n?.user?.shortName ?? n?.user?.short_name;
  const long = n?.longname ?? n?.longName ?? n?.long_name ?? n?.user?.longName ?? n?.user?.long_name;
  const name = (short || long || "").toString().trim();
  if (name) return name;
  const fallback = (n?.nodeId ?? n?.node_id ?? n?.id ?? idFallback) || idFallback;
  return String(fallback);
}

export function toNumberLoose(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function clamp(n: number, a: number, b: number) { return Math.max(a, Math.min(b, n)); }

export type EdgeKind = "neighbor" | "traceroute";

export type GraphNode = {
  id: string;
  label: string;
  degree: number;
  role: string;
  hasNeighborInfo: boolean;
  lat?: number | null;
  lon?: number | null;
};

export type GraphEdge = {
  a: string;
  b: string;
  w: number;
  kind: EdgeKind;
  snr?: number;
};

export const ROLE_LABELS: Record<string, string> = {
  "0": "Client", "1": "Client Mute", "2": "Router", "3": "Router Client",
  "4": "Repeater", "5": "Tracker", "6": "Sensor", "7": "TAK",
  "8": "Client Hidden", "9": "Lost & Found", "10": "TAK Tracker",
  "11": "Router Late", "12": "Client Base",
};

export function roleColor(role: string | null | undefined): string {
  return ROLE_COLORS[Number(role ?? 0)] ?? ROLE_COLORS[0];
}