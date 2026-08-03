/**
 * graphUtils.ts — Pure helpers, types, and ID normalization.
 */

import { ROLE_COLORS } from "../../palette";

// Re-exported so graph-internal importers keep resolving it from here.
export { normNodeId } from "../../utils/normalizeNodeId8";

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
  /** undefined = no reading (0 dB is a real value). */
  snr?: number;
  // Evidence flags survive merging so kind filters keep dual-source links.
  hasNeighbor?: boolean;
  hasTraceroute?: boolean;
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