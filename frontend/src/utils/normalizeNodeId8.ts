/** Normalize a node ID (int or hex string) to lowercase hex.
 *  Numeric ids (and >8-digit decimal strings, which can't be 8-hex ids) are
 *  zero-padded to 8 chars so they match backend normalize_node_id output and
 *  the getNodes cache keys; ≤8-char all-digit strings are treated as hex
 *  verbatim — backend ids are always 8-hex, and decimal ids only arrive as
 *  JSON numbers or longer-than-8-digit strings. Non-hex strings (longnames)
 *  pass through lowercased and unpadded — padding would fabricate an id. */
export function normNodeId(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    return (raw >>> 0).toString(16).toLowerCase().padStart(8, "0");
  }
  let s = String(raw).trim();
  if (/^\d+$/.test(s) && s.length > 8) {
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) {
      return (n >>> 0).toString(16).toLowerCase().padStart(8, "0");
    }
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
