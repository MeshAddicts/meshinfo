/**
 * Shared channel-bucket display logic — Chat, Nodes, Log, and the Map all route here.
 * Label priority: operator meta label > wire name > "Channel <id>". Classification
 * (preset vs custom) uses the WIRE name only; meta labels are display text.
 */

import { isFirmwarePreset } from "../meshtasticPresets";
import type { ChannelMeta } from "../types/config";

/** Placeholder names ingest synthesizes (shape shared with postgres.py); never a real identity. */
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

/** Mode filter; manual mode does not class-filter (caller applies its allowlist). */
export function channelVisibleInMode(
  mode: ChannelMode,
  group: "presets" | "custom"
): boolean {
  return mode === "manual" || mode === "all" || group === "presets";
}

/** Shared `?ch=` normalization: lowercase alphanumerics only; anything starting
 *  with "all" folds to the reserved "all" key (long-standing All-pill behavior). */
export const normalizeKey = (s: string): string => {
  const raw = String(s ?? "").trim().toLowerCase();
  const k = raw.replace(/[^a-z0-9]+/g, "");
  if (!k) return "";
  if (k.startsWith("all")) return "all";
  return k;
};
