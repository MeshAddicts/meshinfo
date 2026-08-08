/**
 * The channel display model — the ONE place the pill/filter recipe lives.
 *
 * Every page that shows channel buckets (Chat tabs, Nodes/Log pills, the Map
 * dropdown) derives from this builder. Pages differ only in what they count
 * (messages, nodes, packets) and how they render; ordering, grouping, mode
 * filtering, the selected-channel exemption, labels, and `?ch=` alias
 * resolution are decided here, once. Fork this recipe into a page and it WILL
 * drift — that is exactly how the app ended up with three preset lists.
 *
 * Scope: the automatic modes ("presets" / "all"). Manual mode renders the
 * operator's hand-written views config, which is page-legacy territory and
 * stays with the page.
 */

import {
  ChannelMetaMap,
  ChannelMode,
  channelLabel,
  channelShort,
  classifyChannel,
  normalizeKey,
} from "./channelDisplay";

export interface ChannelModelEntry {
  id: string;
  label: string;
  short: string;
  group: "presets" | "custom";
  /** Wire name when known (drives classification and Log's topic filter). */
  wireName?: string;
  /** The caller's count for ordering and badges (messages, nodes, ...). */
  count: number;
  /** URL keys this entry answers to (its id always; label/short first-wins). */
  aliases: string[];
}

export interface ChannelModel {
  entries: ChannelModelEntry[];
  byId: Map<string, ChannelModelEntry>;
  /** Busiest visible entry — the default selection. */
  defaultId?: string;
  /** Resolve a raw `?ch=` value to an entry id ("all" is the caller's affair). */
  resolveKey(raw: string): string | undefined;
}

export interface BuildChannelModelArgs {
  /** Candidate bucket ids (typically: every id with data on this page). */
  ids: Iterable<string>;
  mode: ChannelMode;
  meta: ChannelMetaMap | undefined;
  /** id -> wire name (from /v1/channels via wireNamesFrom). */
  wireNames: Record<string, string>;
  /** id -> the page's count. Missing ids count 0. */
  counts: Record<string, number> | ((id: string) => number);
  /** Currently-selected id: always kept visible, even class-filtered. */
  selectedId?: string;
}

export function buildChannelModel(args: BuildChannelModelArgs): ChannelModel {
  const { mode, meta, wireNames, selectedId } = args;
  const countFor =
    typeof args.counts === "function"
      ? args.counts
      : (id: string) => (args.counts as Record<string, number>)[id] ?? 0;

  const candidates = Array.from(new Set(args.ids)).map((id) => ({
    id,
    group: classifyChannel(wireNames, id),
    count: countFor(id),
  }));

  const visible = candidates
    .filter(
      ({ id, group }) =>
        id === selectedId ||
        mode === "manual" ||
        mode === "all" ||
        group === "presets"
    )
    // Presets before custom, busiest first within a group, id as a stable
    // tiebreak so live count ties can't shuffle pills under the cursor.
    .sort((a, b) =>
      a.group !== b.group
        ? a.group === "presets"
          ? -1
          : 1
        : b.count - a.count || a.id.localeCompare(b.id, undefined, { numeric: true })
    );

  // Alias registration: every id is pre-claimed so a channel wire-NAMED "8"
  // can never steal ?ch=8 from bucket 8; label/short go first-wins in display
  // order, so the busier of two same-named channels owns the contested slug.
  // "all" is reserved for the pages' All pill.
  const taken = new Set<string>(["all", ...visible.map((v) => v.id)]);
  const entries: ChannelModelEntry[] = visible.map(({ id, group, count }) => {
    const label = channelLabel(meta, wireNames, id);
    const aliases = [id];
    for (const cand of [
      normalizeKey(label),
      normalizeKey(channelShort(meta, id)),
    ]) {
      if (cand && cand !== id && !taken.has(cand)) {
        taken.add(cand);
        aliases.push(cand);
      }
    }
    return {
      id,
      label,
      short: channelShort(meta, id),
      group,
      wireName: wireNames[id],
      count,
      aliases,
    };
  });

  const byId = new Map(entries.map((e) => [e.id, e]));
  const byAlias = new Map<string, string>();
  for (const e of entries) {
    for (const a of e.aliases) {
      if (!byAlias.has(a)) byAlias.set(a, e.id);
    }
  }

  return {
    entries,
    byId,
    defaultId: entries.length
      ? entries.reduce((best, e) => (e.count > best.count ? e : best), entries[0])
          .id
      : undefined,
    resolveKey(raw: string) {
      const k = normalizeKey(raw);
      if (!k || k === "all") return undefined;
      return byAlias.get(k);
    },
  };
}
