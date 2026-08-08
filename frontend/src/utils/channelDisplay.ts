/**
 * Shared channel-bucket display logic.
 *
 * A channel id is an 8-bit hash of (name, PSK) — not an index, not stable
 * across meshes, and meaningless to a human. Every page that shows one must
 * resolve it the same way, or the same bucket wears different names on
 * different screens. Chat, Nodes, Log, and the Map all route through here.
 *
 * Label priority: operator meta label > the name the gateway published on the
 * wire > "Channel <id>". Classification (stock preset vs custom channel) uses
 * the WIRE name only: meta labels are display text, and letting them reclass a
 * bucket would hide a busy preset behind a cosmetic rename.
 */

import { isFirmwarePreset } from "../meshtasticPresets";
import type { ChannelMeta } from "../types/config";

/** Names ingest synthesizes when no wire name is known. Never treat one as a
 *  real channel identity (postgres.py and the backfill share this shape). */
export const PLACEHOLDER_NAME_RE = /^(General|Channel \d+)$/;

export interface ChannelDisplayInfo {
  name?: string;
  totalMessages?: number;
  recentMessages?: number;
  newestTimestamp?: number | null;
}

export type ChannelMetaMap = Record<string, ChannelMeta | undefined>;

export type ChannelMode = "presets" | "all" | "manual";

/** broker.channels.mode with the fail-safe default. */
export function channelModeFrom(
  channels: { mode?: string } | undefined | null
): ChannelMode {
  const m = channels?.mode;
  return m === "all" || m === "manual" ? m : "presets";
}

/** id -> wire name, dropping placeholders so they never beat "Channel <id>". */
export function wireNamesFrom(
  channels: Record<string, ChannelDisplayInfo> | undefined | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, ch] of Object.entries(channels ?? {})) {
    const n = ch?.name;
    if (typeof n === "string" && n && !PLACEHOLDER_NAME_RE.test(n)) {
      out[id] = n;
    }
  }
  return out;
}

/** Display label for a bucket: meta.label > wire name > "Channel <id>". */
export function channelLabel(
  meta: ChannelMetaMap | undefined,
  wireNames: Record<string, string>,
  id: string
): string {
  const m = meta?.[id]?.label;
  if (m) return String(m);
  return wireNames[id] ?? `Channel ${id}`;
}

/** Short chip text: meta.short > the bare id. */
export function channelShort(
  meta: ChannelMetaMap | undefined,
  id: string
): string {
  const m = meta?.[id]?.short;
  return m ? String(m) : id;
}

/** Stock-preset vs custom, from the wire name alone. */
export function classifyChannel(
  wireNames: Record<string, string>,
  id: string
): "presets" | "custom" {
  return isFirmwarePreset(wireNames[id]) ? "presets" : "custom";
}

/** Whether a bucket passes the mode filter. Manual mode does not class-filter
 *  (its allowlist is the display/views config, applied by the caller). */
export function channelVisibleInMode(
  mode: ChannelMode,
  group: "presets" | "custom"
): boolean {
  return mode === "manual" || mode === "all" || group === "presets";
}

/** URL-key normalization shared by every page's `?ch=` handling: lowercase,
 *  alphanumerics only. Anything starting with "all" folds to the reserved
 *  "all" key (long-standing behavior — the All pill answers to any of its
 *  spellings, at the cost of a hypothetical channel named "Allstars"). */
export const normalizeKey = (s: string): string => {
  const raw = String(s ?? "").trim().toLowerCase();
  const k = raw.replace(/[^a-z0-9]+/g, "");
  if (!k) return "";
  if (k.startsWith("all")) return "all";
  return k;
};
