import "highlight.js/styles/github-dark-dimmed.css";

import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { LivePill } from "../components/LivePill";
import { ChannelPillGroups } from "../components/ChannelPillGroups";
import { MobileSheet } from "../components/MobileSheet";
import { useLiveEvent } from "../hooks/useLiveEvent";
import {
  REMEMBERED_CH_KEYS,
  useRememberedChannel,
} from "../hooks/useRememberedChannel";
import {
  REMEMBERED_RANGE_KEYS,
  useRememberedRange,
} from "../hooks/useRememberedRange";
import { canonicalPresetName, isFirmwarePreset } from "../meshtasticPresets";
import {
  IPacketMessage,
  IPacketsArg,
  useGetChannelsQuery,
  useGetConfigQuery,
  useGetPacketQuery,
  useGetPacketsInfiniteQuery,
} from "../slices/apiSlice";
import {
  channelLabel,
  channelModeFrom,
  normalizeKey,
  wireNamesFrom,
} from "../utils/channelDisplay";
import { buildChannelModel } from "../utils/channelModel";
import { copyTextToClipboard } from "../utils/clipboard";
import { csvEscape, downloadBlob } from "../utils/export";
import { formatTimestamp } from "../utils/formatTimestamp";

// Quick rolling-range presets. Absolute start/end (the date pickers) override
// these — the two are mutually exclusive in the UI.
type RangeKey = "1h" | "24h" | "7d" | "all";
const DEFAULT_RANGE: RangeKey = "all";
const PAGE_SIZE = 200;
// Live packet feed (SSE) tuning.
const LIVE_CAP = 2000; // max buffered live packets before the oldest fall off
const LIVE_FLUSH_MS = 350; // coalesce a burst of packets into one state update
const AT_TOP_THRESHOLD_PX = 60; // freeze as soon as the user scrolls down this far

hljs.registerLanguage("json", json);

const toUnixSeconds = (ts: unknown): number => {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
};

// epoch seconds <-> the value format an <input type="datetime-local"> expects.
const toLocalInput = (epoch?: number): string => {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (val: string): number | undefined => {
  if (!val) return undefined;
  const ms = new Date(val).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function JsonBlock({ code, className }: { code: string; className?: string }) {
  // Render escaped plain text on mount; highlight later off the render path
  // so row mounts don't jank flick-scroll.
  const [html, setHtml] = useState(() => escapeHtml(code));

  useEffect(() => {
    setHtml(escapeHtml(code));
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      try {
        const value = hljs.highlight(code, { language: "json" }).value;
        if (!cancelled) setHtml(value);
      } catch {
        // keep the escaped plain text
      }
    };
    let idleId: number | null = null;
    let timerId: number | null = null;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(run);
    } else {
      timerId = window.setTimeout(run, 0);
    }
    return () => {
      cancelled = true;
      if (idleId != null) window.cancelIdleCallback(idleId);
      if (timerId != null) window.clearTimeout(timerId);
    };
  }, [code]);

  return (
    <pre
      className={
        className ??
        "mt-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-950/40 p-3 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto"
      }
    >
      <code
        className="hljs"
        style={{ background: "transparent" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

type PacketRowProps = {
  m: IPacketMessage;
  /** Resolved channel chip text; absent when the row carries no channel info. */
  channel?: string;
  highlighted?: boolean;
  selected?: boolean;
  copiedJson: boolean;
  copiedLink: boolean;
  onSelect: (id: number) => void;
  onCopyJson: (id: number, pretty: string) => void;
  onCopyLink: (id: number) => void;
};

const PacketRow = React.memo(function PacketRow({
  m,
  channel,
  highlighted,
  selected,
  copiedJson,
  copiedLink,
  onSelect,
  onCopyJson,
  onCopyLink,
}: PacketRowProps) {
  const id = Number(m.mqtt_row_id);
  const tsLabel = m.timestamp
    ? formatTimestamp(toUnixSeconds(m.timestamp)) || "Unknown"
    : "Unknown";
  const topic = String(m.topic ?? "");
  const type = m.type ? String(m.type) : "";
  // Uplink copies recorded for this packet (#526); absent on legacy rows.
  const heard = Number(m.reception_count);
  const pretty = useMemo(() => JSON.stringify(m, null, 2), [m]);

  return (
    <div
      onClick={() => Number.isFinite(id) && onSelect(id)}
      title={selected ? "Selected — stream paused. Click to deselect." : "Click to select (pauses the live stream)"}
      className={[
        "px-3 sm:px-4 py-3 border-b border-gray-200/70 dark:border-gray-800 cursor-pointer transition",
        selected
          ? "bg-indigo-100/70 dark:bg-indigo-950/50 ring-2 ring-inset ring-indigo-500/60"
          : highlighted
            ? "bg-indigo-50/70 dark:bg-indigo-950/30 ring-1 ring-inset ring-indigo-400/50"
            : "hover:bg-gray-50/70 dark:hover:bg-gray-900/30",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {tsLabel}
            {type ? (
              <span className="ml-2 rounded-full px-2 py-0.5 border border-gray-300/60 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">
                {type}
              </span>
            ) : null}
            {channel ? (
              <span
                className="ml-2 rounded-full px-2 py-0.5 border border-sky-400/50 dark:border-sky-800 text-[11px] text-sky-700 dark:text-sky-300"
                title="Channel"
              >
                {channel}
              </span>
            ) : null}
            {Number.isFinite(id) ? (
              <span className="ml-2 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                #{id}
              </span>
            ) : null}
            {Number.isFinite(heard) && heard > 0 ? (
              <span
                className="ml-2 rounded-full px-2 py-0.5 border border-emerald-400/50 dark:border-emerald-700 text-[11px] text-emerald-700 dark:text-emerald-300 tabular-nums"
                title={`Uplinked by ${heard} gateway ${heard === 1 ? "copy" : "copies"} (deduplicated)`}
              >
                heard {heard}×
              </span>
            ) : null}
            {selected ? (
              <span className="ml-2 rounded-full px-2 py-0.5 text-[11px] bg-indigo-600 text-white">
                selected · paused
              </span>
            ) : null}
          </div>
          {topic ? (
            <div className="mt-1 text-xs font-mono text-gray-700 dark:text-gray-200 break-all">
              {topic}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md px-2.5 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            onClick={(e) => {
              e.stopPropagation();
              onCopyJson(id, pretty);
            }}
            title="Copy this packet's JSON"
          >
            {copiedJson ? "Copied!" : "Copy JSON"}
          </button>
          <button
            type="button"
            disabled={!Number.isFinite(id)}
            className="rounded-md px-2.5 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition disabled:opacity-40"
            onClick={(e) => {
              e.stopPropagation();
              onCopyLink(id);
            }}
            title="Copy a permalink to this packet"
          >
            {copiedLink ? "Link copied!" : "Link"}
          </button>
        </div>
      </div>

      <JsonBlock code={pretty} />
    </div>
  );
});

export const Log = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: config } = useGetConfigQuery();

  // ---- URL state -----------------------------------------------------------
  const urlRange = (searchParams.get("r") as RangeKey) || DEFAULT_RANGE;
  const urlQ = searchParams.get("q") ?? "";
  const urlCh = normalizeKey(searchParams.get("ch") ?? "");
  const urlPacket = searchParams.get("packet") ?? "";
  // Chat's "View in logs": mesh packet id + sender (chat rows lack the row id).
  const urlPkt = searchParams.get("pkt") ?? "";
  const urlPFrom = searchParams.get("pfrom") ?? "";

  const parseEpochParam = (key: string): number | undefined => {
    const raw = searchParams.get(key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const urlStart = parseEpochParam("start");
  const urlEnd = parseEpochParam("end");
  const useAbsolute = urlStart != null || urlEnd != null;

  const isDefaultParam = useCallback((key: string, value: string) => {
    if (key === "r") return (value as RangeKey) === DEFAULT_RANGE;
    if (key === "ch") return !value || value === "all";
    if (key === "q") return value.trim() === "";
    return false;
  }, []);

  const setParams = useCallback(
    (
      pairs: Array<{ key: string; value: string | undefined }>,
      mode: "push" | "replace" = "push",
    ) => {
      const sp = new URLSearchParams(searchParams);
      for (const p of pairs) {
        const v = p.value == null ? "" : String(p.value);
        if (!v || isDefaultParam(p.key, v)) sp.delete(p.key);
        else sp.set(p.key, v);
      }
      setSearchParams(sp, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams, isDefaultParam],
  );
  const setParam = useCallback(
    (key: string, value: string | undefined, mode: "push" | "replace" = "push") =>
      setParams([{ key, value }], mode),
    [setParams],
  );

  // ---- channel pills -------------------------------------------------------
  // Topics carry the channel NAME, never the bucket hash; pills filter by
  // substring pinned to "/2/e/<name>/" so node-id hex/region can't match.
  const { data: channelsData } = useGetChannelsQuery({ range: "all" });
  const channelMeta = config?.broker?.channels?.meta;
  const channelMode = channelModeFrom(config?.broker?.channels);
  const wireNames = useMemo(
    () => wireNamesFrom(channelsData?.channels),
    [channelsData],
  );

  // Topic name for a bucket: wire name > validated preset > preset-named
  // label; undefined = no pill (an unfilterable pill is worse than none).
  const topicNameFor = useCallback(
    (id: string, wire: string | undefined): string | undefined => {
      if (wire) return wire;
      const m = channelMeta?.[id];
      const preset = m?.preset;
      if (preset && isFirmwarePreset(canonicalPresetName(preset))) {
        // "LongModerate" airs as "LongMod"; other presets air as-is.
        return preset === "LongModerate" ? "LongMod" : preset;
      }
      if (isFirmwarePreset(m?.label)) return m?.label;
      return undefined;
    },
    [channelMeta],
  );

  // Shared model drives auto-mode pills. No selectedId: ?ch= resolves against
  // Log's own pill set, so a resolved selection is visible by construction.
  const channelModel = useMemo(() => {
    const channels = channelsData?.channels ?? {};
    return buildChannelModel({
      ids: Object.keys(channels),
      mode: channelMode,
      meta: channelMeta,
      wireNames,
      counts: (id) =>
        Number(channels[id]?.recentMessages ?? channels[id]?.totalMessages ?? 0),
    });
  }, [channelsData, channelMode, channelMeta, wireNames]);

  const views = useMemo(() => {
    const out: Array<{
      key: string;
      label: string;
      topicMatch: string;
      /** Model entry id (auto modes only); what resolveKey returns. */
      id?: string;
      group?: "presets" | "custom";
    }> = [{ key: "all", label: "All", topicMatch: "" }];
    const matchFor = (name: string) => `/2/e/${name}/`;

    if (channelMode === "manual") {
      // Manual mode: operator-curated views; unresolvable buckets get no pill.
      const seen = new Set(["all"]);
      for (const v of config?.broker?.channels?.views ?? []) {
        const chans = Array.isArray(v?.channels) ? v.channels.map(String) : [];
        if (chans.length !== 1) continue;
        const name = topicNameFor(chans[0], wireNames[chans[0]]);
        if (!name) continue;
        const label = String(v?.label ?? v?.id ?? "");
        const key = normalizeKey(label) || normalizeKey(String(v?.id ?? ""));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, label: label || key, topicMatch: matchFor(name) });
      }
      return out;
    }

    // Auto modes: model entries verbatim, minus buckets with no topic name.
    for (const e of channelModel.entries) {
      const name = topicNameFor(e.id, e.wireName);
      if (!name) continue;
      // Label slug as key keeps old bookmarks; denied slugs fall back to id.
      const labelSlug = normalizeKey(e.label);
      const key = e.aliases.includes(labelSlug) ? labelSlug : e.id;
      out.push({
        key, label: e.label, topicMatch: matchFor(name), id: e.id, group: e.group,
      });
    }
    return out;
  }, [channelMode, config, channelModel, wireNames, topicNameFor]);

  // Auto modes resolve ?ch= via the model's aliases; a resolved bucket with
  // no pill falls back to All. Manual keeps legacy key matching.
  const selectedView = useMemo(() => {
    if (channelMode === "manual") {
      return views.find((v) => v.key === urlCh) ?? views[0];
    }
    const id = urlCh ? channelModel.resolveKey(urlCh) : undefined;
    return (id ? views.find((v) => v.id === id) : undefined) ?? views[0];
  }, [channelMode, views, urlCh, channelModel]);

  // Land returning visitors on the channel pill they last had selected.
  // `urlHasCh` requires the raw ?ch to resolve to a rendered pill — adopting
  // an unresolved link's All fallback would wipe the remembered selection.
  const rawChParam = (searchParams.get("ch") ?? "").trim();
  const rawChResolves =
    !!rawChParam &&
    (channelMode === "manual"
      ? views.some((v) => v.key === urlCh && v.key !== "all")
      : channelModel.resolveKey(rawChParam) !== undefined &&
        selectedView.key !== "all");
  // Remember the time range the same way (default "all"; URL wins).
  useRememberedRange({
    storageKey: REMEMBERED_RANGE_KEYS.logs,
    value: urlRange,
    urlHasR: !!searchParams.get("r")?.trim(),
    suppressRestore: [...searchParams.keys()].some((k) => k !== "r"),
    apply: (stored) => setParam("r", stored, "replace"),
  });

  useRememberedChannel({
    storageKey: REMEMBERED_CH_KEYS.logs,
    value: selectedView.key === "all" ? "" : selectedView.key,
    urlHasCh: rawChResolves,
    suppressRestore: [...searchParams.keys()].some((k) => k !== "ch"),
    // Gate on config: mode defaults to "presets" pre-config, and a restore
    // under the wrong mode can removeStored a valid key.
    ready: !!config && views.length > 1,
    isValid: (stored) => views.some((v) => v.key === stored),
    apply: (stored) => setParam("ch", stored, "replace"),
  });

  // ---- packet query --------------------------------------------------------
  const packetsArg: IPacketsArg = useMemo(() => {
    const a: IPacketsArg = { limit: PAGE_SIZE };
    if (urlQ.trim()) a.q = urlQ.trim();
    if (selectedView.topicMatch) a.topic = selectedView.topicMatch;
    if (useAbsolute) {
      if (urlStart != null) a.start = urlStart;
      if (urlEnd != null) a.end = urlEnd;
    } else if (urlRange !== "all") {
      a.range = urlRange;
    }
    return a;
  }, [urlQ, selectedView.topicMatch, useAbsolute, urlStart, urlEnd, urlRange]);

  const {
    data: pageData,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isLoading,
    isError,
    refetch,
  } = useGetPacketsInfiniteQuery(packetsArg);

  const rows = useMemo(
    () => (pageData?.pages ?? []).flatMap((p) => p.messages),
    [pageData],
  );

  // ---- live packet feed (SSE) ---------------------------------------------
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [live, setLive] = useState<IPacketMessage[]>([]);
  const [atTop, setAtTop] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const frozenRef = useRef<IPacketMessage[] | null>(null);

  // A selected packet pins the stream (pauses follow) so it can be inspected.
  const selectionPinned = selectedId != null;
  const onSelectPacket = useCallback(
    (id: number) => setSelectedId((prev) => (prev === id ? null : id)),
    [],
  );

  // Show a live packet only if it matches the filters (absolute end = historical).
  const matchesFilters = useCallback(
    (p: IPacketMessage) => {
      if (urlEnd != null) return false;
      const tm = selectedView.topicMatch;
      if (tm && !String(p.topic ?? "").includes(tm)) return false;
      const q = urlQ.trim().toLowerCase();
      if (q) {
        const hay = `${String(p.topic ?? "")} ${JSON.stringify(p)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [urlEnd, selectedView.topicMatch, urlQ],
  );

  // Refs so the SSE handler (fired outside React render) reads current values.
  const liveEnabledRef = useRef(liveEnabled);
  liveEnabledRef.current = liveEnabled;
  const matchesFiltersRef = useRef(matchesFilters);
  matchesFiltersRef.current = matchesFilters;
  // Row ids already on screen (live buffer + fetched archive) for O(1) dedup.
  const liveIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    liveIdsRef.current = new Set(live.map((p) => Number(p.mqtt_row_id)));
  }, [live]);
  const rowIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    rowIdsRef.current = new Set(rows.map((p) => Number(p.mqtt_row_id)));
  }, [rows]);

  // Coalesce a burst of packets into one state update on `live`.
  const incomingRef = useRef<IPacketMessage[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const flushIncoming = useCallback(() => {
    flushTimerRef.current = null;
    const batch = incomingRef.current;
    incomingRef.current = [];
    if (batch.length === 0) return;
    const seen = new Set<number>([...liveIdsRef.current, ...rowIdsRef.current]);
    const fresh: IPacketMessage[] = [];
    for (const p of batch) {
      const id = Number(p.mqtt_row_id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      fresh.push(p);
    }
    if (fresh.length === 0) return;
    fresh.reverse(); // arrival order -> newest first
    setLive((prev) => [...fresh, ...prev].slice(0, LIVE_CAP));
  }, []);

  useLiveEvent<IPacketMessage>("packet", (p) => {
    if (!liveEnabledRef.current) return;
    if (p?.mqtt_row_id == null) return;
    if (!matchesFiltersRef.current(p)) return;
    incomingRef.current.push(p);
    if (flushTimerRef.current == null) {
      flushTimerRef.current = window.setTimeout(flushIncoming, LIVE_FLUSH_MS);
    }
  });

  const resetLive = useCallback(() => {
    setLive([]);
    setUnseen(0);
    frozenRef.current = null;
    incomingRef.current = [];
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Drop buffered packets when the filters change or on a manual refresh.
  useEffect(() => {
    resetLive();
  }, [packetsArg, resetLive]);
  const doRefresh = useCallback(() => {
    resetLive();
    refetch();
  }, [resetLive, refetch]);

  // Live packets merged ahead of the archive, de-duplicated by row id.
  const liveRows = useMemo(() => {
    if (live.length === 0) return rows;
    const ids = new Set(rows.map((r) => Number(r.mqtt_row_id)));
    const liveOnly = live.filter((p) => !ids.has(Number(p.mqtt_row_id)));
    return [...liveOnly, ...rows];
  }, [live, rows]);

  // Freeze the rendered list while scrolled away or while a packet is selected,
  // so the position never jumps; the live list keeps rolling underneath and
  // `unseen` counts what arrived.
  const shouldFreeze = (!atTop || selectionPinned) && liveRows.length > 0;
  useEffect(() => {
    if (shouldFreeze) {
      if (!frozenRef.current) frozenRef.current = liveRows;
    } else {
      frozenRef.current = null;
    }
  }, [shouldFreeze, liveRows]);
  useEffect(() => {
    if (!shouldFreeze || !frozenRef.current) {
      setUnseen(0);
      return;
    }
    const frozenIds = new Set(frozenRef.current.map((x) => Number(x.mqtt_row_id)));
    setUnseen(
      liveRows.filter((x) => !frozenIds.has(Number(x.mqtt_row_id))).length,
    );
  }, [liveRows, shouldFreeze]);

  const displayRows = useMemo(
    () => frozenRef.current ?? liveRows,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shouldFreeze, liveRows],
  );

  // Follow the top edge: while at top + live and nothing pinned, pin to the
  // newest as it arrives.
  const edgeId = liveRows.length ? Number(liveRows[0].mqtt_row_id) : null;
  const lastFollowIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!liveEnabled || !atTop || selectionPinned || edgeId == null) return;
    if (lastFollowIdRef.current === edgeId) return;
    lastFollowIdRef.current = edgeId;
    virtuosoRef.current?.scrollToIndex({ index: 0, align: "start" });
  }, [liveEnabled, atTop, selectionPinned, edgeId]);

  const jumpToLive = useCallback(() => {
    setSelectedId(null);
    frozenRef.current = null;
    setUnseen(0);
    virtuosoRef.current?.scrollToIndex({ index: 0, align: "start", behavior: "smooth" });
  }, []);

  // Chip text: newer rows carry the gateway-published name; older rows only a
  // numeric channel, which the shared label chain resolves.
  const channelChipFor = useCallback(
    (m: IPacketMessage): string | undefined => {
      const name = m["channel_name"];
      if (typeof name === "string" && name.trim()) return name;
      const id = m["channel"];
      if (typeof id === "number" && Number.isFinite(id)) {
        return channelLabel(channelMeta, wireNames, String(id));
      }
      return undefined;
    },
    [channelMeta, wireNames],
  );

  // ---- deeplinked packet ---------------------------------------------------
  const byPacket = !urlPacket && !!urlPkt && !!urlPFrom;
  const packetId = Number(urlPacket || urlPkt);
  const hasPacketLink = Number.isFinite(packetId) && (!!urlPacket || byPacket);
  const { data: linkedData, isFetching: linkedFetching } = useGetPacketQuery(
    byPacket ? { pkt: packetId, from: urlPFrom } : packetId,
    { skip: !hasPacketLink },
  );
  const linkedPacket = linkedData?.packet;
  const linkedChannel = linkedPacket ? channelChipFor(linkedPacket) : undefined;

  // ---- search input (deferred -> URL) -------------------------------------
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);
  useEffect(() => {
    setQInput(urlQ);
  }, [urlQ]);
  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred || undefined, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  // ---- copy state ----------------------------------------------------------
  const [copiedLink, setCopiedLink] = useState(false);
  const copyShareLink = useCallback(async () => {
    const url = window.location.href;
    if (await copyTextToClipboard(url)) {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1200);
    } else {
      window.prompt("Copy link:", url);
    }
  }, []);

  const [copiedRow, setCopiedRow] = useState<{ id: number; kind: "json" | "link" } | null>(
    null,
  );
  const flashRow = useCallback((id: number, kind: "json" | "link") => {
    setCopiedRow({ id, kind });
    window.setTimeout(
      () => setCopiedRow((c) => (c && c.id === id && c.kind === kind ? null : c)),
      1200,
    );
  }, []);
  const onCopyJson = useCallback(
    async (id: number, pretty: string) => {
      const ok = await copyTextToClipboard(pretty);
      if (ok) flashRow(id, "json");
      else window.prompt("Copy JSON:", pretty);
    },
    [flashRow],
  );
  const onCopyLink = useCallback(
    async (id: number) => {
      const url = `${window.location.origin}/logs?packet=${id}`;
      const ok = await copyTextToClipboard(url);
      if (ok) flashRow(id, "link");
      else window.prompt("Copy packet link:", url);
    },
    [flashRow],
  );

  // ---- export (currently-loaded rows) -------------------------------------
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && exportMenuRef.current && !exportMenuRef.current.contains(t)) {
        setExportOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  const exportFilenameBase = useMemo(
    () => `packets_${new Date().toISOString().replace(/[:.]/g, "-")}`,
    [],
  );
  const doExportJson = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      params: Object.fromEntries(searchParams.entries()),
      count: rows.length,
      note: "Currently-loaded packets only — scroll to load more before exporting.",
      packets: rows,
    };
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
      `${exportFilenameBase}.json`,
    );
    setExportOpen(false);
  }, [rows, searchParams, exportFilenameBase]);
  const doExportCsv = useCallback(() => {
    const cols = ["mqtt_row_id", "timestamp_unix", "timestamp_iso", "type", "topic", "from"];
    const lines = rows.map((m) => {
      const ts = toUnixSeconds(m.timestamp);
      const row: Record<string, unknown> = {
        mqtt_row_id: m.mqtt_row_id ?? "",
        timestamp_unix: ts || "",
        timestamp_iso: ts ? new Date(ts * 1000).toISOString() : "",
        type: m.type ?? "",
        topic: m.topic ?? "",
        from: m.from ?? "",
      };
      return cols.map((c) => csvEscape(row[c])).join(",");
    });
    const csv = "﻿" + [cols.join(","), ...lines].join("\r\n");
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `${exportFilenameBase}.csv`,
    );
    setExportOpen(false);
  }, [rows, exportFilenameBase]);

  // ---- keyboard ------------------------------------------------------------
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const typing =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as HTMLElement | null)?.isContentEditable;
      if (!typing && e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (controlsOpen) setControlsOpen(false);
        else if (exportOpen) setExportOpen(false);
        else if (selectedId != null) setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controlsOpen, exportOpen, selectedId]);

  // ---- filter helpers ------------------------------------------------------
  const activeFilterCount = useMemo(() => {
    let n = 0;
    // A ?ch= that fell back to All must not count as an active filter.
    if (urlCh && urlCh !== "all" && selectedView.key !== "all") n += 1;
    if (useAbsolute) n += 1;
    else if (urlRange !== DEFAULT_RANGE) n += 1;
    if (urlQ.trim()) n += 1;
    return n;
  }, [urlCh, selectedView.key, useAbsolute, urlRange, urlQ]);
  const hasFilters = activeFilterCount > 0;

  const clearFilters = useCallback(() => {
    setParams([
      { key: "ch", value: undefined },
      { key: "r", value: undefined },
      { key: "q", value: undefined },
      { key: "start", value: undefined },
      { key: "end", value: undefined },
    ]);
  }, [setParams]);

  // Quick range and absolute range are mutually exclusive.
  const pickRange = useCallback(
    (rk: RangeKey) => {
      setParams([
        { key: "r", value: rk },
        { key: "start", value: undefined },
        { key: "end", value: undefined },
      ]);
    },
    [setParams],
  );
  const pickDate = useCallback(
    (which: "start" | "end", localValue: string) => {
      const epoch = fromLocalInput(localValue);
      setParams([
        { key: which, value: epoch ? String(epoch) : undefined },
        { key: "r", value: undefined },
      ]);
    },
    [setParams],
  );

  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetching) fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);

  const rangeButtons: RangeKey[] = ["all", "1h", "24h", "7d"];

  return (
    <div className="w-full h-dvh overflow-hidden flex flex-col">
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Logs
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching ? "animate-pulse" : ""}>
                  {isLoading ? "Loading…" : isFetching ? "Refreshing…" : "Ready"}
                </span>
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doRefresh}
                >
                  refresh
                </button>
                <LivePill
                  mode={!liveEnabled ? "off" : shouldFreeze ? "paused" : "live"}
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={
                    !liveEnabled
                      ? "Live off. Click to resume the packet feed."
                      : shouldFreeze
                        ? "Paused — scrolled away or a packet is selected. Resume from the list."
                        : "Live: new packets stream in at the top. Click to turn off."
                  }
                />
                <span className="opacity-60">•</span>
                <span>raw MQTT packet archive</span>
              </div>
            </div>

            <div className="hidden lg:flex items-center gap-2">
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  onClick={() => setExportOpen((v) => !v)}
                  title="Export loaded packets"
                >
                  Export
                </button>
                {exportOpen ? (
                  <div className="absolute right-0 mt-2 w-60 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-30">
                    <div className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                      Export {rows.length} loaded packet{rows.length === 1 ? "" : "s"}
                    </div>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      onClick={doExportCsv}
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      onClick={doExportJson}
                    >
                      Export JSON
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyShareLink}
                title="Copy a shareable link (includes filters)"
              >
                {copiedLink ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Channel pills: grouped rows in auto mode, one row in manual. */}
          {views.length > 1 ? (
            <ChannelPillGroups
              leading={{
                key: "all",
                label: "All",
                active: selectedView.key === "all",
                onClick: () => setParam("ch", undefined),
              }}
              pills={views
                .filter((v) => v.key !== "all")
                .map((v) => ({
                  key: v.key,
                  label: v.label,
                  active: v.key === selectedView.key,
                  group: v.group,
                  onClick: () => setParam("ch", v.key),
                }))}
            />
          ) : null}

          {/* Search + range controls */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-65">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search topic + payload… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            <div className="hidden lg:flex flex-wrap gap-2 items-center">
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {rangeButtons.map((rk) => (
                  <button
                    key={`range-${rk}`}
                    type="button"
                    className={[
                      "px-3 py-2 text-sm transition",
                      !useAbsolute && urlRange === rk
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => pickRange(rk)}
                  >
                    {rk}
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                From
                <input
                  type="datetime-local"
                  value={toLocalInput(urlStart)}
                  onChange={(e) => pickDate("start", e.target.value)}
                  className="rounded-md border border-gray-300/60 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                To
                <input
                  type="datetime-local"
                  value={toLocalInput(urlEnd)}
                  onChange={(e) => pickDate("end", e.target.value)}
                  className="rounded-md border border-gray-300/60 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100"
                />
              </label>

              <span className="min-w-22 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {hasFilters
                  ? `${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""}`
                  : "no filters"}
              </span>
              <button
                type="button"
                className={[
                  "text-xs underline hover:no-underline text-gray-600 dark:text-gray-300",
                  hasFilters ? "visible" : "invisible pointer-events-none",
                ].join(" ")}
                onClick={clearFilters}
              >
                clear
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          {/* Deeplinked packet */}
          {hasPacketLink ? (
            <div className="mb-3 shrink-0 rounded-xl border border-indigo-300/70 dark:border-indigo-800/70 bg-indigo-50/50 dark:bg-indigo-950/20 overflow-hidden">
              <div className="px-4 py-2 flex items-center justify-between border-b border-indigo-200/70 dark:border-indigo-900/60">
                <div className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">
                  Linked packet #{packetId}
                  {linkedChannel ? (
                    <span
                      className="ml-2 rounded-full px-2 py-0.5 border border-sky-400/50 dark:border-sky-800 text-[11px] font-normal text-sky-700 dark:text-sky-300"
                      title="Channel"
                    >
                      {linkedChannel}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="text-xs underline hover:no-underline text-indigo-700 dark:text-indigo-300"
                  onClick={() => {
                    setParam("packet", undefined);
                    setParam("pkt", undefined);
                    setParam("pfrom", undefined);
                  }}
                >
                  clear
                </button>
              </div>
              {linkedFetching && !linkedPacket ? (
                <div className="p-3 text-xs text-gray-600 dark:text-gray-400">
                  Loading packet…
                </div>
              ) : linkedPacket ? (
                <JsonBlock
                  code={JSON.stringify(linkedPacket, null, 2)}
                  className="m-0 p-3 text-xs font-mono text-gray-800 dark:text-gray-200 bg-white/70 dark:bg-gray-950/40 max-h-[45vh] overflow-auto"
                />
              ) : (
                <div className="p-3 text-xs text-gray-600 dark:text-gray-400">
                  Packet #{packetId} not found.
                </div>
              )}
            </div>
          ) : null}

          <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col min-h-0 flex-1">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
              <div className="text-sm text-gray-800 dark:text-gray-200">
                <span className="font-semibold">{selectedView.label}</span>{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  • {rows.length} loaded
                  {hasNextPage ? "+" : ""}
                  {live.length > 0 ? ` · ${live.length} live` : ""}
                </span>
              </div>
            </div>

            <div className="relative flex-1 min-h-0">
              {/* Paused (scrolled away or a packet selected) — resume + jump to top */}
              {unseen > 0 || selectionPinned ? (
                <div className="pointer-events-none absolute z-10 left-1/2 -translate-x-1/2 top-3">
                  <button
                    type="button"
                    onClick={jumpToLive}
                    className="pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-xs border transition bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-500"
                  >
                    {unseen > 0
                      ? `↑ ${unseen} new packet${unseen === 1 ? "" : "s"}`
                      : "Resume live"}
                  </button>
                </div>
              ) : null}

              {isError ? (
                <div className="p-6 text-sm text-red-600 dark:text-red-400">
                  Failed to load packets.{" "}
                  <button
                    type="button"
                    className="underline hover:no-underline"
                    onClick={doRefresh}
                  >
                    Retry
                  </button>
                </div>
              ) : isLoading ? (
                <div className="p-6 text-sm text-gray-600 dark:text-gray-400">
                  Loading packets…
                </div>
              ) : displayRows.length === 0 ? (
                <div className="p-6 text-sm text-gray-600 dark:text-gray-400">
                  No packets match your current filters.
                </div>
              ) : (
                <Virtuoso
                  ref={virtuosoRef}
                  data={displayRows}
                  atTopThreshold={AT_TOP_THRESHOLD_PX}
                  atTopStateChange={setAtTop}
                  style={{ height: "100%" }}
                  endReached={onEndReached}
                  computeItemKey={(index, item) =>
                    item?.mqtt_row_id != null ? `p${item.mqtt_row_id}` : `i${index}`
                  }
                  itemContent={(_index, m) => {
                    const id = Number(m.mqtt_row_id);
                    return (
                      <PacketRow
                        m={m}
                        channel={channelChipFor(m)}
                        highlighted={hasPacketLink && id === packetId}
                        selected={id === selectedId}
                        copiedJson={
                          copiedRow?.id === id && copiedRow.kind === "json"
                        }
                        copiedLink={
                          copiedRow?.id === id && copiedRow.kind === "link"
                        }
                        onSelect={onSelectPacket}
                        onCopyJson={onCopyJson}
                        onCopyLink={onCopyLink}
                      />
                    );
                  }}
                  components={{
                    Footer: () => (
                      <div className="px-4 py-4 text-center text-xs text-gray-500 dark:text-gray-400">
                        {isFetching
                          ? "Loading more…"
                          : hasNextPage
                            ? "Scroll for more"
                            : "End of results"}
                      </div>
                    ),
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile controls */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="mb-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm shadow-xs overflow-hidden">
            <button
              type="button"
              className="w-full py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => setControlsOpen((v) => !v)}
            >
              Controls
              {hasFilters ? (
                <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>
        </div>
      </div>

      <MobileSheet
        open={controlsOpen}
        title="Controls"
        onClose={() => setControlsOpen(false)}
      >
        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Quick range
            </div>
            <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
              {rangeButtons.map((rk) => (
                <button
                  key={`m-range-${rk}`}
                  type="button"
                  className={[
                    "px-3 py-2 text-sm transition",
                    !useAbsolute && urlRange === rk
                      ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                      : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                  ].join(" ")}
                  onClick={() => pickRange(rk)}
                >
                  {rk}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              From
              <input
                type="datetime-local"
                value={toLocalInput(urlStart)}
                onChange={(e) => pickDate("start", e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300/60 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-2 text-sm text-gray-900 dark:text-gray-100"
              />
            </label>
            <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              To
              <input
                type="datetime-local"
                value={toLocalInput(urlEnd)}
                onChange={(e) => pickDate("end", e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300/60 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-2 text-sm text-gray-900 dark:text-gray-100"
              />
            </label>
          </div>

          <div className="pt-4 border-t border-gray-200 dark:border-gray-800 grid grid-cols-1 gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => refetch()}
            >
              Refresh now
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={copyShareLink}
            >
              {copiedLink ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => {
                doExportCsv();
                setControlsOpen(false);
              }}
            >
              Export CSV ({rows.length})
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => {
                doExportJson();
                setControlsOpen(false);
              }}
            >
              Export JSON ({rows.length})
            </button>
            {hasFilters ? (
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-red-300/70 dark:border-red-800/70 text-red-700 dark:text-red-200 hover:bg-red-50/60 dark:hover:bg-red-900/20 transition"
                onClick={() => {
                  clearFilters();
                  setControlsOpen(false);
                }}
              >
                Clear all filters
              </button>
            ) : null}
          </div>
        </div>
      </MobileSheet>
    </div>
  );
};
