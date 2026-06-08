import { normalizeNodeId8 } from "../../utils/normalizeNodeId8";

const BROADCAST = "ffffffff";

/** Raw `packet` SSE payload (clean_msg + mqtt_row_id). `from`/`to` are unnormalized. */
export type RawPacket = {
  id?: number | string; // mesh packet id (shared across gateway uplinks)
  from?: number | string;
  to?: number | string;
  sender?: string;
  type?: string;
  rssi?: number;
  snr?: number;
  timestamp?: number | string;
};

export type PacketArc = {
  fromId: string; // 8-char hex transmitter
  senderId: string; // 8-char hex gateway that heard it
  type?: string;
  rssi?: number;
  snr?: number;
  /** First sighting of this transmission → also spawn the origin pulse. */
  isNewTransmission: boolean;
};

/** Dedups per-gateway uplinks of one transmission (same mesh `id`) into a fan-in:
 *  one origin pulse + one arc per gateway. Pure; caller owns timing/positions. */
export class PacketCoalescer {
  private seen = new Map<string, { senders: Set<string>; exp: number }>();

  constructor(
    private ttlMs = 45_000,
    private maxKeys = 4_000,
  ) {}

  /** The arc to animate, or null for a duplicate / unusable packet. */
  ingest(p: RawPacket, nowMs: number): PacketArc | null {
    const fromId = normalizeNodeId8(p.from);
    const senderId = normalizeNodeId8(p.sender);
    if (!fromId || !senderId) return null;
    if (fromId === BROADCAST || senderId === BROADCAST) return null;

    const key = p.id != null ? `id:${p.id}` : `syn:${fromId}:${p.timestamp ?? ""}:${p.type ?? ""}`;
    const base = { fromId, senderId, type: p.type, rssi: num(p.rssi), snr: num(p.snr) };

    const entry = this.seen.get(key);
    if (!entry || entry.exp <= nowMs) {
      if (entry) this.seen.delete(key); // refresh insertion order for FIFO eviction
      this.seen.set(key, { senders: new Set([senderId]), exp: nowMs + this.ttlMs });
      this.evict();
      return { ...base, isNewTransmission: true };
    }
    if (entry.senders.has(senderId)) return null; // same gateway, same transmission
    entry.senders.add(senderId);
    entry.exp = nowMs + this.ttlMs;
    return { ...base, isNewTransmission: false };
  }

  private evict(): void {
    while (this.seen.size > this.maxKeys) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
