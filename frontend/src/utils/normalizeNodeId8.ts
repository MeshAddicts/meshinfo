import { normNodeId } from "../pages/map/linkFeatures";

/** Raw node id (decimal uint32 or hex, optional `!`/`0x`) → canonical 8-char
 *  lowercase hex, matching backend normalize_node_id and the getNodes cache key.
 *  undefined for null/<=0/empty. Broadcast 0xffffffff → "ffffffff"; callers
 *  needing to reject it must guard. */
export function normalizeNodeId8(raw: unknown): string | undefined {
  const hex = normNodeId(raw);
  if (!hex) return undefined;
  return hex.length >= 8 ? hex : hex.padStart(8, "0");
}
