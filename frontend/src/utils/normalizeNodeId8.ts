/** Normalize a node ID (int or hex string) to lowercase hex. */
export function normNodeId(raw: unknown): string {
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

/** Raw node id (decimal uint32 or hex, optional `!`/`0x`) → canonical 8-char
 *  lowercase hex, matching backend normalize_node_id and the getNodes cache key.
 *  undefined for null/<=0/empty. Broadcast 0xffffffff → "ffffffff"; callers
 *  needing to reject it must guard. */
export function normalizeNodeId8(raw: unknown): string | undefined {
  const hex = normNodeId(raw);
  if (!hex) return undefined;
  return hex.length >= 8 ? hex : hex.padStart(8, "0");
}
