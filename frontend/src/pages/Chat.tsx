import {
  useEffect,
  useMemo,
  useState,
  useDeferredValue,
  useRef,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatTimestamp } from "../utils/formatTimestamp";

import { HeardBy } from "../components/HeardBy";
import {
  useGetChatsQuery,
  useGetConfigQuery,
  useGetNodesQuery,
} from "../slices/apiSlice";
import { calculateDistanceBetweenNodes } from "../utils/getDistanceBetweenTwoNodes";

type FocusMode = "endpoints" | "any";
type MsgType = "all" | "bc" | "dm";
type RangeKey = "1h" | "24h" | "7d" | "all";
type SortKey = "desc" | "asc";
type DirKey = "both" | "in" | "out";
type NavMode = "replace" | "push";

const isBroadcast = (to?: string) => !to || to === "ffffffff";

const clampInt = (v: string | null, min: number, max: number) => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return undefined;
  return Math.max(min, Math.min(max, n));
};

// Default URL param values (we will *remove* these from the URL for canonical links)
const DEFAULT_PARAM: Record<string, string> = {
  r: "24h",
  t: "all",
  s: "desc",
  focus: "endpoints",
  dir: "both",
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildHighlightTokens = (query: string) => {
  const raw = (query ?? "").trim();
  if (!raw) return [];
  // multi-word highlighting, avoid tiny tokens
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6); // cap tokens for perf
  // de-dupe
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
};

const renderHighlightedText = (text: string, query: string) => {
  const tokens = buildHighlightTokens(query);
  if (!tokens.length) return text;

  const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
  const re = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const parts = String(text ?? "").split(re);

  return parts.map((p, i) => {
    if (tokenSet.has(p.toLowerCase())) {
      return (
        <mark
          key={`hl-${i}`}
          className="rounded px-0.5 bg-yellow-200/70 dark:bg-yellow-400/20 text-gray-900 dark:text-yellow-100"
        >
          {p}
        </mark>
      );
    }
    return <span key={`hl-${i}`}>{p}</span>;
  });
};

// ---- Commit 6: Export helpers
const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const csvEscape = (v: any) => {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export const Chat = () => {
  const { data: chat, dataUpdatedAt, isFetching, refetch } = useGetChatsQuery();
  const { data: nodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const [searchParams, setSearchParams] = useSearchParams();

  // UI state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Commit 6: export menu
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  // Search input
  const urlQ = searchParams.get("q") ?? "";
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Focus picker input
  const [focusPicker, setFocusPicker] = useState("");
  const focusPickerDeferred = useDeferredValue(focusPicker);

  // Scroll-to-selected
  const listTopRef = useRef<HTMLDivElement | null>(null);

  // ---- Channel list (filtered by config display list if provided)
  const channels = useMemo(() => {
    const entries = Object.entries(chat?.channels ?? {});
    const allow = config?.broker?.channels?.display;
    if (Array.isArray(allow) && allow.length > 0) {
      return entries.filter(([id]) => allow.includes(id));
    }
    return entries;
  }, [chat?.channels, config?.broker?.channels?.display]);

  // ---- Channel metadata for pretty labels + tooltips
  const channelMeta = (config?.broker?.channels as any)?.meta ?? {};
  const channelLabel = (id: string) =>
    channelMeta?.[id]?.label ? String(channelMeta[id].label) : `Channel ${id}`;
  const channelShort = (id: string) =>
    channelMeta?.[id]?.short ? String(channelMeta[id].short) : id;

  const channelTooltip = (id: string) => {
    const meta = channelMeta?.[id] ?? {};
    const label = channelLabel(id);
    const short = channelShort(id);
    const desc =
      meta.description ??
      meta.desc ??
      meta.tooltip ??
      meta.notes ??
      meta.presetDescription ??
      "";
    const preset = meta.preset ?? meta.modemPreset ?? meta.profile ?? "";
    const parts = [
      `${label} (ch ${id}${short ? ` • ${short}` : ""})`,
      preset ? `Preset: ${preset}` : "",
      desc ? String(desc) : "",
    ].filter(Boolean);
    return parts.join("\n");
  };

  // ---- URL param-backed state
  const urlCh = searchParams.get("ch");
  const urlRange = (searchParams.get("r") as RangeKey) ?? "24h";
  const urlType = (searchParams.get("t") as MsgType) ?? "all";
  const urlSort = (searchParams.get("s") as SortKey) ?? "desc";
  const urlNode = searchParams.get("node") ?? "";
  const urlFocus = (searchParams.get("focus") as FocusMode) ?? "endpoints";
  const urlDir = (searchParams.get("dir") as DirKey) ?? "both";
  const urlMsg = searchParams.get("msg") ?? "";

  // Advanced filters (Commit 5)
  const urlFrom = searchParams.get("from") ?? "";
  const urlTo = searchParams.get("to") ?? "";
  const urlVia = searchParams.get("via") ?? "";
  const urlHopsMin = clampInt(searchParams.get("hmin"), 0, 10);
  const urlHopsMax = clampInt(searchParams.get("hmax"), 0, 10);
  const onlyUnknownEndpoints = searchParams.get("unk") === "1";
  const requireVia = searchParams.get("hv") === "1";

  // Keep local input synced if user navigates via back/forward
  useEffect(() => {
    setQInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  // ---- Param helpers (canonical + history semantics)
  const setParam = (key: string, value?: string, mode: NavMode = "replace") => {
    const next = new URLSearchParams(searchParams);

    const v = value?.trim();
    const defaultForKey = DEFAULT_PARAM[key];

    if (!v) {
      next.delete(key);
    } else if (defaultForKey && v === defaultForKey) {
      next.delete(key);
    } else {
      next.set(key, v);
    }

    setSearchParams(next, { replace: mode === "replace" });
  };

  const setParams = (
    updates: Array<{ key: string; value?: string }>,
    mode: NavMode = "replace"
  ) => {
    const next = new URLSearchParams(searchParams);

    for (const u of updates) {
      const v = u.value?.trim();
      const defaultForKey = DEFAULT_PARAM[u.key];

      if (!v) next.delete(u.key);
      else if (defaultForKey && v === defaultForKey) next.delete(u.key);
      else next.set(u.key, v);
    }

    setSearchParams(next, { replace: mode === "replace" });
  };

  // Ensure ch is present and valid (canonical safety)
  useEffect(() => {
    if (channels.length === 0) return;
    const valid = urlCh && channels.some(([id]) => id === urlCh);
    if (!valid) {
      const firstId = channels[0][0];
      setParams([{ key: "ch", value: firstId }], "replace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length, urlCh]);

  // If node is not set, don’t keep focus/dir around in URL (clean canonical links)
  useEffect(() => {
    if (urlNode?.trim()) return;
    const hasFocus = searchParams.has("focus");
    const hasDir = searchParams.has("dir");
    if (hasFocus || hasDir) {
      setParams(
        [
          { key: "focus", value: undefined },
          { key: "dir", value: undefined },
        ],
        "replace"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlNode]);

  // Update URL q from deferred input (replace, don’t spam history)
  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  const selectedChannel = useMemo(() => {
    if (!urlCh) return undefined;
    return channels.find(([id]) => id === urlCh)?.[0];
  }, [channels, urlCh]);

  const selectedChannelObj = useMemo(() => {
    if (!selectedChannel) return undefined;
    return (chat?.channels as any)?.[selectedChannel];
  }, [chat?.channels, selectedChannel]);

  // Range threshold
  const nowSec = Math.floor(Date.now() / 1000);
  const rangeThreshold = useMemo(() => {
    switch (urlRange) {
      case "1h":
        return nowSec - 3600;
      case "24h":
        return nowSec - 86400;
      case "7d":
        return nowSec - 604800;
      case "all":
      default:
        return undefined;
    }
  }, [nowSec, urlRange]);

  // Messages (filtered + sorted in memo)
  const messages = useMemo(() => {
    if (!selectedChannel) return [];
    const channelObj = (chat?.channels as any)?.[selectedChannel];
    if (!channelObj?.messages) return [];

    let msgs = [...channelObj.messages];

    // Range
    if (rangeThreshold) {
      msgs = msgs.filter((m: any) => (m.timestamp ?? 0) >= rangeThreshold);
    }

    // Type
    if (urlType === "bc") msgs = msgs.filter((m: any) => isBroadcast(m.to));
    if (urlType === "dm") msgs = msgs.filter((m: any) => !isBroadcast(m.to));

    // Require via
    if (requireVia) {
      msgs = msgs.filter(
        (m: any) => Array.isArray(m.sender) && m.sender.length > 0
      );
    }

    // Hops min/max
    if (typeof urlHopsMin === "number") {
      msgs = msgs.filter((m: any) => (m.hops_away ?? 0) >= urlHopsMin);
    }
    if (typeof urlHopsMax === "number") {
      msgs = msgs.filter((m: any) => (m.hops_away ?? 0) <= urlHopsMax);
    }

    // Endpoint filters
    if (urlFrom.trim()) {
      msgs = msgs.filter((m: any) => String(m.from ?? "") === urlFrom.trim());
    }
    if (urlTo.trim()) {
      msgs = msgs.filter((m: any) => String(m.to ?? "") === urlTo.trim());
    }
    if (urlVia.trim()) {
      const viaId = urlVia.trim();
      msgs = msgs.filter((m: any) =>
        Array.isArray(m.sender) ? m.sender.map(String).includes(viaId) : false
      );
    }

    // Unknown endpoints toggle
    if (onlyUnknownEndpoints) {
      msgs = msgs.filter((m: any) => {
        const from = String(m.from ?? "");
        const to = String(m.to ?? "");
        const fromKnown = from in (nodes as any);
        const toKnown = isBroadcast(to) ? true : to in (nodes as any);
        return !fromKnown || !toKnown;
      });
    }

    // Search text
    const q = (urlQ ?? "").trim().toLowerCase();
    if (q.length > 0) {
      msgs = msgs.filter((m: any) =>
        String(m.text ?? "").toLowerCase().includes(q)
      );
    }

    // Node focus + direction
    const focusNode = urlNode.trim();
    if (focusNode.length > 0) {
      msgs = msgs.filter((m: any) => {
        const from = String(m.from ?? "");
        const to = String(m.to ?? "");
        const via = Array.isArray(m.sender) ? m.sender.map(String) : [];

        const endpointMatch = from === focusNode || to === focusNode;
        const viaMatch = via.includes(focusNode);

        const endpointDirMatch =
          urlDir === "both"
            ? endpointMatch
            : urlDir === "in"
            ? to === focusNode
            : from === focusNode;

        if (urlFocus === "any") {
          if (urlDir === "both") return endpointMatch || viaMatch;
          return endpointDirMatch;
        }

        return endpointDirMatch;
      });
    }

    // Sort
    msgs.sort((a: any, b: any) => {
      const at = a.timestamp ?? 0;
      const bt = b.timestamp ?? 0;
      return urlSort === "asc" ? at - bt : bt - at;
    });

    return msgs;
  }, [
    chat?.channels,
    selectedChannel,
    rangeThreshold,
    urlType,
    urlQ,
    urlNode,
    urlFocus,
    urlDir,
    urlSort,
    nodes,
    urlFrom,
    urlTo,
    urlVia,
    urlHopsMin,
    urlHopsMax,
    onlyUnknownEndpoints,
    requireVia,
  ]);

  // Selected message (details pane)
  const selectedMessage = useMemo(() => {
    if (!urlMsg) return undefined;
    return messages.find((m: any) => String(m.id) === String(urlMsg));
  }, [messages, urlMsg]);

  const focusNodeObj = urlNode ? (nodes as any)[urlNode] : null;

  const totalMessages = selectedChannelObj?.totalMessages ?? 0;

  // Active filter count + chips
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (urlQ.trim()) n += 1;
    if (urlRange !== "24h") n += 1;
    if (urlType !== "all") n += 1;
    if (typeof urlHopsMin === "number") n += 1;
    if (typeof urlHopsMax === "number") n += 1;
    if (urlFrom.trim()) n += 1;
    if (urlTo.trim()) n += 1;
    if (urlVia.trim()) n += 1;
    if (onlyUnknownEndpoints) n += 1;
    if (requireVia) n += 1;
    if (urlNode.trim()) n += 1;
    if (urlFocus !== "endpoints" && urlNode.trim()) n += 1;
    if (urlDir !== "both" && urlNode.trim()) n += 1;
    if (urlSort !== "desc") n += 1;
    return n;
  }, [
    urlQ,
    urlRange,
    urlType,
    urlHopsMin,
    urlHopsMax,
    urlFrom,
    urlTo,
    urlVia,
    onlyUnknownEndpoints,
    requireVia,
    urlNode,
    urlFocus,
    urlDir,
    urlSort,
  ]);

  const activeChips = useMemo(() => {
    const chips: Array<{ label: string; clear: () => void }> = [];

    if (urlRange !== "24h")
      chips.push({
        label: `Range: ${urlRange}`,
        clear: () => setParam("r", undefined, "push"),
      });

    if (urlType !== "all")
      chips.push({
        label: `Type: ${urlType === "bc" ? "BC" : "DM"}`,
        clear: () => setParam("t", undefined, "push"),
      });

    if (typeof urlHopsMin === "number")
      chips.push({
        label: `Hops ≥ ${urlHopsMin}`,
        clear: () => setParam("hmin", undefined, "push"),
      });

    if (typeof urlHopsMax === "number")
      chips.push({
        label: `Hops ≤ ${urlHopsMax}`,
        clear: () => setParam("hmax", undefined, "push"),
      });

    if (urlFrom.trim())
      chips.push({
        label: `From: ${(nodes as any)[urlFrom]?.shortname ?? urlFrom}`,
        clear: () => setParam("from", undefined, "push"),
      });

    if (urlTo.trim())
      chips.push({
        label: `To: ${
          isBroadcast(urlTo)
            ? "ALL"
            : (nodes as any)[urlTo]?.shortname ?? urlTo
        }`,
        clear: () => setParam("to", undefined, "push"),
      });

    if (urlVia.trim())
      chips.push({
        label: `Via: ${(nodes as any)[urlVia]?.shortname ?? urlVia}`,
        clear: () => setParam("via", undefined, "push"),
      });

    if (onlyUnknownEndpoints)
      chips.push({
        label: "Unknown endpoints",
        clear: () => setParam("unk", undefined, "push"),
      });

    if (requireVia)
      chips.push({
        label: "Require via",
        clear: () => setParam("hv", undefined, "push"),
      });

    if (urlQ.trim())
      chips.push({
        label: `Search: "${urlQ.trim()}"`,
        clear: () => setParam("q", undefined, "push"),
      });

    // focus is already shown as a bar; keep chips list clean by not duplicating it

    if (urlSort !== "desc")
      chips.push({
        label: "Sort: oldest",
        clear: () => setParam("s", undefined, "push"),
      });

    return chips;
  }, [
    urlRange,
    urlType,
    urlHopsMin,
    urlHopsMax,
    urlFrom,
    urlTo,
    urlVia,
    onlyUnknownEndpoints,
    requireVia,
    urlQ,
    urlSort,
    nodes,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setParam,
  ]);

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    // keep ch
    next.delete("q");
    next.delete("node");
    next.delete("focus");
    next.delete("dir");
    next.delete("t");
    next.delete("r");
    next.delete("s");
    next.delete("msg");

    // commit 5 filters
    next.delete("from");
    next.delete("to");
    next.delete("via");
    next.delete("hmin");
    next.delete("hmax");
    next.delete("unk");
    next.delete("hv");

    setSearchParams(next, { replace: false });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  // Node chip
  const applyFocus = (nodeId: string) => {
    if (!nodeId || nodeId === "ffffffff") return;
    setParams(
      [
        { key: "node", value: nodeId },
        { key: "msg", value: undefined },
      ],
      "push"
    );
    setFocusPicker("");
  };

  const clearFocus = () => {
    setParams(
      [
        { key: "node", value: undefined },
        { key: "focus", value: undefined },
        { key: "dir", value: undefined },
        { key: "msg", value: undefined },
      ],
      "push"
    );
  };

  const NodeChip = ({
    nodeId,
    fallback,
    onFocus,
    titlePrefix,
    compact,
    stopPropagation,
  }: {
    nodeId: string;
    fallback?: string;
    onFocus?: (id: string) => void;
    titlePrefix?: string;
    compact?: boolean;
    stopPropagation?: boolean;
  }) => {
    const n = (nodes as any)[nodeId];
    const short = n?.shortname ?? fallback ?? "UNK";
    const long = n?.longname ?? "Unknown";
    const title = `${titlePrefix ? `${titlePrefix}: ` : ""}${nodeId} / ${long}`;
    const base =
      "inline-flex items-center rounded-md font-medium border border-transparent hover:border-gray-300/40 dark:hover:border-gray-600/40 transition";
    const pad = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
    const bg =
      "bg-gray-200/60 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700";

    return (
      <span className="inline-flex items-center gap-1">
        {nodeId && nodeId !== "ffffffff" ? (
          <Link
            to={`/nodes/${nodeId}`}
            className={`${base} ${pad} ${bg}`}
            title={title}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
            }}
          >
            {short}
          </Link>
        ) : (
          <span
            className={`${base} ${pad} bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300`}
            title={title}
          >
            {short}
          </span>
        )}

        {onFocus && nodeId && nodeId !== "ffffffff" ? (
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-[11px] font-semibold border border-gray-300/60 dark:border-gray-600/60 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            onClick={(e) => {
              e.stopPropagation();
              onFocus(nodeId);
            }}
            title="Focus this node"
          >
            ⊙
          </button>
        ) : null}
      </span>
    );
  };

  // Frequent node suggestions when not focused
  const frequentNodes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages as any[]) {
      const from = String(m.from ?? "");
      const to = String(m.to ?? "");
      if (from && from !== "ffffffff")
        counts.set(from, (counts.get(from) ?? 0) + 1);
      if (to && to !== "ffffffff")
        counts.set(to, (counts.get(to) ?? 0) + 1);
      const via = Array.isArray(m.sender) ? m.sender.map(String) : [];
      for (const v of via) {
        if (v && v !== "ffffffff")
          counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nodeId, count]) => ({ nodeId, count }));
  }, [messages]);

  // Focus picker matches
  const focusMatches = useMemo(() => {
    const q = focusPickerDeferred.trim().toLowerCase();
    if (q.length < 2) return [];
    const all = Object.entries(nodes as any).map(([id, n]: any) => ({
      id: String(id),
      short: String(n?.shortname ?? ""),
      long: String(n?.longname ?? ""),
    }));
    return all
      .filter((x) =>
        (`${x.id} ${x.short} ${x.long}`).toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [nodes, focusPickerDeferred]);

  // ---- Focus analytics (computed from *current displayed message set*)
  const focusStats = useMemo(() => {
    if (!urlNode.trim()) return null;

    const focusId = urlNode.trim();
    let total = 0;
    let inbound = 0;
    let outbound = 0;
    let broadcast = 0;
    let direct = 0;
    let viaOnly = 0;

    const hopsCounts = new Map<number, number>();
    const peerCounts = new Map<string, number>();

    for (const m of messages as any[]) {
      const from = String(m.from ?? "");
      const to = String(m.to ?? "");
      const isBc = isBroadcast(to);
      const via = Array.isArray(m.sender) ? m.sender.map(String) : [];
      const endpointMatch = from === focusId || to === focusId;
      const viaMatch = via.includes(focusId);

      total += 1;
      if (isBc) broadcast += 1;
      else direct += 1;

      const hops = Number(m.hops_away ?? 0);
      hopsCounts.set(hops, (hopsCounts.get(hops) ?? 0) + 1);

      if (!endpointMatch && viaMatch) {
        viaOnly += 1;
        continue;
      }

      if (to === focusId) inbound += 1;
      if (from === focusId) outbound += 1;

      let peer = "";
      if (from === focusId) peer = to || "ffffffff";
      else if (to === focusId) peer = from || "";
      if (peer) peerCounts.set(peer, (peerCounts.get(peer) ?? 0) + 1);
    }

    const topPeers = [...peerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([peerId, count]) => ({ peerId, count }));

    const hopsChips = [...hopsCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([h, c]) => ({ hops: h, count: c }));

    return {
      total,
      inbound,
      outbound,
      broadcast,
      direct,
      viaOnly,
      topPeers,
      hopsChips,
    };
  }, [messages, urlNode]);

  // ---- Scroll selected message into view (shared links)
  useEffect(() => {
    if (!urlMsg) return;
    const id = `msg-${String(urlMsg)}`;
    const el = document.getElementById(id);
    if (!el) {
      const t = window.setTimeout(() => {
        const el2 = document.getElementById(id);
        if (el2) el2.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 50);
      return () => window.clearTimeout(t);
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [urlMsg, messages.length, selectedChannel]);

  // ---- Commit 6: export menu click-outside
  useEffect(() => {
    if (!exportOpen) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (exportMenuRef.current && !exportMenuRef.current.contains(t)) {
        setExportOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  // ---- Keyboard shortcuts (Commit 5 + Commit 6)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTypingContext =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as any)?.isContentEditable;

      // / focuses search (but not while typing)
      if (!isTypingContext && e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        // close filters first
        if (filtersOpen) {
          setFiltersOpen(false);
          return;
        }
        // then export menu
        if (exportOpen) {
          setExportOpen(false);
          return;
        }
        // then message details
        if (urlMsg) {
          setParam("msg", undefined, "push");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersOpen, exportOpen, urlMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Advanced filter helper: node search for drawer
  const DrawerNodeSearch = ({
    label,
    paramKey,
    currentValue,
    placeholder,
    allowAll,
  }: {
    label: string;
    paramKey: string;
    currentValue: string;
    placeholder: string;
    allowAll?: boolean;
  }) => {
    const [q, setQ] = useState("");
    const qDef = useDeferredValue(q);

    const matches = useMemo(() => {
      const s = qDef.trim().toLowerCase();
      if (s.length < 2) return [];
      const all = Object.entries(nodes as any).map(([id, n]: any) => ({
        id: String(id),
        short: String(n?.shortname ?? ""),
        long: String(n?.longname ?? ""),
      }));
      return all
        .filter((x) => (`${x.id} ${x.short} ${x.long}`).toLowerCase().includes(s))
        .slice(0, 10);
    }, [nodes, qDef]);

    const setValue = (v?: string) => {
      setParam(paramKey, v, "push");
      setQ("");
    };

    return (
      <div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
        <div className="mt-1 flex items-center gap-2">
          {currentValue ? (
            <span className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-800 px-2 py-1 text-sm">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {allowAll && isBroadcast(currentValue)
                  ? "ALL"
                  : (nodes as any)[currentValue]?.shortname ?? "UNK"}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {currentValue}
              </span>
              <button
                type="button"
                className="text-xs underline hover:no-underline"
                onClick={() => setValue(undefined)}
              >
                clear
              </button>
            </span>
          ) : (
            <span className="text-xs text-gray-500 dark:text-gray-400">none</span>
          )}
        </div>

        <div className="mt-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
        </div>

        {allowAll ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => setValue("ffffffff")}
            >
              Set to ALL
            </button>
          </div>
        ) : null}

        {matches.length > 0 ? (
          <div className="mt-2 rounded-md border border-gray-200 dark:border-gray-800 overflow-hidden">
            <ul className="divide-y divide-gray-200 dark:divide-gray-800 max-h-56 overflow-y-auto">
              {matches.map((m) => (
                <li
                  key={`drawer-${paramKey}-${m.id}`}
                  className="px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-900/30 cursor-pointer"
                  onClick={() => setValue(m.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-gray-900 dark:text-gray-100 font-medium">
                      {m.short || "UNK"}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                      {m.id}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {m.long || "Unknown"}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  };

  // ---- Commit 6: Export rows + handlers (exports current view)
  const exportRows = useMemo(() => {
    const ch = selectedChannel ?? "";
    return (messages as any[]).map((m) => {
      const fromId = String(m.from ?? "");
      const toId = String(m.to ?? "");
      const viaIds = Array.isArray(m.sender) ? m.sender.map(String) : [];

      return {
        channel: ch,
        message_id: String(m.id ?? ""),
        timestamp_unix: Number(m.timestamp ?? 0),
        timestamp: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : "",
        from: fromId,
        from_short: (nodes as any)[fromId]?.shortname ?? "UNK",
        to: toId,
        to_short: isBroadcast(toId) ? "ALL" : ((nodes as any)[toId]?.shortname ?? "UNK"),
        hops: Number(m.hops_away ?? 0),
        via_ids: viaIds.join(","),
        via_short: viaIds.map((id) => (nodes as any)[id]?.shortname ?? "UNK").join(","),
        text: String(m.text ?? ""),
      };
    });
  }, [messages, nodes, selectedChannel]);

  const doExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      channel: selectedChannel ?? "",
      channelLabel: selectedChannel ? channelLabel(selectedChannel) : "",
      params: Object.fromEntries(searchParams.entries()),
      count: exportRows.length,
      rows: exportRows,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `chat_export_${selectedChannel ?? "ch"}_${Date.now()}.json`);
    setExportOpen(false);
  };

  const doExportCsv = () => {
    const cols = [
      "channel",
      "message_id",
      "timestamp_unix",
      "timestamp",
      "from",
      "from_short",
      "to",
      "to_short",
      "hops",
      "via_ids",
      "via_short",
      "text",
    ] as const;

    const header = cols.join(",");
    const lines = exportRows.map((r) =>
      cols.map((c) => csvEscape((r as any)[c])).join(",")
    );

    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    downloadBlob(blob, `chat_export_${selectedChannel ?? "ch"}_${Date.now()}.csv`);
    setExportOpen(false);
  };

  // ---- Commit 6: Route helpers (details pane)
  const routeLabel = (id: string) => {
    if (!id || id === "ffffffff") return "ALL";
    return (nodes as any)[id]?.shortname ?? id;
  };

  const copyRoute = async (m: any) => {
    const from = routeLabel(String(m.from ?? ""));
    const to = routeLabel(String(m.to ?? ""));
    const via = Array.isArray(m.sender)
      ? m.sender.map((x: any) => routeLabel(String(x)))
      : [];
    const chain = [from, ...via, to].join(" -> ");
    try {
      await navigator.clipboard.writeText(chain);
    } catch {
      // ignore
    }
  };

  return (
    <div className="w-full h-[calc(100vh-0px)] overflow-hidden flex flex-col">
      {/* Filters Drawer (Commit 5) */}
      {filtersOpen ? (
        <div className="fixed inset-0 z-40">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setFiltersOpen(false)}
            aria-label="Close filters"
          />
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 shadow-xl">
            <div className="h-full flex flex-col">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Advanced filters
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
                    onClick={clearFilters}
                  >
                    clear all
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                    onClick={() => setFiltersOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="p-4 overflow-y-auto space-y-5">
                <div className="space-y-4">
                  <DrawerNodeSearch
                    label="From"
                    paramKey="from"
                    currentValue={urlFrom}
                    placeholder="Type 2+ chars to filter sender…"
                  />
                  <DrawerNodeSearch
                    label="To"
                    paramKey="to"
                    currentValue={urlTo}
                    placeholder="Type 2+ chars to filter recipient…"
                    allowAll
                  />
                  <DrawerNodeSearch
                    label="Via contains"
                    paramKey="via"
                    currentValue={urlVia}
                    placeholder="Type 2+ chars to require a specific via…"
                  />
                </div>

                <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Hops range
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Min
                      </div>
                      <select
                        value={
                          typeof urlHopsMin === "number" ? String(urlHopsMin) : ""
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setParam("hmin", v || undefined, "push");
                        }}
                        className="mt-1 w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                      >
                        <option value="">any</option>
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={`hmin-${n}`} value={String(n)}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Max
                      </div>
                      <select
                        value={
                          typeof urlHopsMax === "number" ? String(urlHopsMax) : ""
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setParam("hmax", v || undefined, "push");
                        }}
                        className="mt-1 w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                      >
                        <option value="">any</option>
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={`hmax-${n}`} value={String(n)}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Tip: set both min & max for an exact hop count.
                  </div>
                </div>

                <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    Flags
                  </div>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-gray-800 dark:text-gray-200">
                      Only unknown endpoints
                    </span>
                    <input
                      type="checkbox"
                      checked={onlyUnknownEndpoints}
                      onChange={(e) =>
                        setParam("unk", e.target.checked ? "1" : undefined, "push")
                      }
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-gray-800 dark:text-gray-200">
                      Require via (sender list present)
                    </span>
                    <input
                      type="checkbox"
                      checked={requireVia}
                      onChange={(e) =>
                        setParam("hv", e.target.checked ? "1" : undefined, "push")
                      }
                    />
                  </label>
                </div>

                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Keyboard: <b>/</b> focus search, <b>Esc</b> close
                  filters/details/export.
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Sticky top area */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-3">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Chat
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  Updated:{" "}
                  <span className="font-medium">
                    {dataUpdatedAt && dataUpdatedAt > 0
                      ? new Date(dataUpdatedAt).toLocaleString()
                      : new Date().toLocaleString()}
                  </span>
                </span>
                <span className="opacity-60">•</span>
                <span className={isFetching ? "animate-pulse" : ""}>
                  {isFetching ? "Refreshing…" : "Live"}
                </span>
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => refetch()}
                >
                  refresh
                </button>
                <span className="opacity-60">•</span>
                <HeardBy />
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Commit 6: Export dropdown */}
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  onClick={() => setExportOpen((v) => !v)}
                  title="Export the current view (filters applied)"
                >
                  Export
                </button>

                {exportOpen ? (
                  <div className="absolute right-0 mt-2 w-48 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-30">
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/40"
                      onClick={doExportCsv}
                    >
                      Download CSV
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/40"
                      onClick={doExportJson}
                    >
                      Download JSON
                    </button>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyLink}
                title="Copy a shareable link (includes filters/focus/selection)"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Preset pills */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {channels.map(([id, chObj]: any) => {
              const active = id === selectedChannel;
              return (
                <button
                  key={`preset-${id}`}
                  type="button"
                  className={[
                    "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                    active
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                      : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                  ].join(" ")}
                  onClick={() => {
                    setParams(
                      [
                        { key: "ch", value: id },
                        { key: "msg", value: undefined },
                      ],
                      "push"
                    );
                  }}
                  title={channelTooltip(id)}
                >
                  {channelLabel(id)}
                  <span
                    className={[
                      "ml-2 rounded-full px-2 py-0.5 text-xs",
                      active
                        ? "bg-white/20 text-white"
                        : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200",
                    ].join(" ")}
                  >
                    {chObj?.totalMessages ?? 0}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Toolbar row */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            {/* Search */}
            <div className="flex-1 min-w-[260px]">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search messages… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            {/* Controls */}
            <div className="flex flex-wrap gap-2 items-center">
              {/* Range */}
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {(["1h", "24h", "7d", "all"] as RangeKey[]).map((rk) => (
                  <button
                    key={`range-${rk}`}
                    type="button"
                    className={[
                      "px-3 py-2 text-sm transition",
                      urlRange === rk
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => setParam("r", rk, "push")}
                  >
                    {rk}
                  </button>
                ))}
              </div>

              {/* Type */}
              <select
                value={urlType}
                onChange={(e) => setParam("t", e.target.value, "push")}
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Message type"
              >
                <option value="all">All</option>
                <option value="bc">Broadcast</option>
                <option value="dm">Direct</option>
              </select>

              {/* Focus mode */}
              <select
                value={urlFocus}
                onChange={(e) => setParam("focus", e.target.value, "push")}
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Node focus mode"
              >
                <option value="endpoints">Focus: endpoints</option>
                <option value="any">Focus: include via</option>
              </select>

              {/* Focus direction (disabled unless focused) */}
              <div
                className={[
                  "inline-flex rounded-md border overflow-hidden",
                  urlNode.trim()
                    ? "border-gray-300/60 dark:border-gray-700"
                    : "border-gray-300/30 dark:border-gray-700/30 opacity-60",
                ].join(" ")}
                title={
                  urlNode.trim()
                    ? "Focus direction"
                    : "Set a focused node to enable direction"
                }
              >
                {(["both", "in", "out"] as DirKey[]).map((d) => (
                  <button
                    key={`dir-${d}`}
                    type="button"
                    disabled={!urlNode.trim()}
                    className={[
                      "px-3 py-2 text-sm transition",
                      urlDir === d
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => setParam("dir", d, "push")}
                  >
                    {d === "both" ? "Both" : d === "in" ? "In" : "Out"}
                  </button>
                ))}
              </div>

              {/* Sort toggle */}
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("s", urlSort === "desc" ? "asc" : "desc", "push")
                }
                title="Toggle sort"
              >
                {urlSort === "desc" ? "Newest" : "Oldest"}
              </button>

              {/* Filters drawer */}
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => setFiltersOpen(true)}
                title="Advanced filters"
              >
                Filters
                {activeFilterCount > 0 ? (
                  <span className="ml-2 rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>

              {/* Active filters summary */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {activeFilterCount > 0
                    ? `${activeFilterCount} filter${
                        activeFilterCount > 1 ? "s" : ""
                      }`
                    : "no filters"}
                </span>
                {activeFilterCount > 0 ? (
                  <button
                    type="button"
                    className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
                    onClick={clearFilters}
                    title="Clear all filters"
                  >
                    clear
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Quick-clear chips */}
          {activeChips.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {activeChips.map((c, i) => (
                <button
                  key={`chip-${i}`}
                  type="button"
                  onClick={c.clear}
                  className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Click to clear"
                >
                  {c.label}
                  <span className="opacity-70">×</span>
                </button>
              ))}
            </div>
          ) : null}

          {/* Focus bar */}
          {urlNode ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-indigo-300/50 dark:border-indigo-700/50 bg-indigo-50/50 dark:bg-indigo-900/20 px-3 py-2">
              <span className="text-sm text-indigo-900 dark:text-indigo-100 font-medium">
                Focus:
              </span>
              <span className="text-sm text-indigo-900 dark:text-indigo-100">
                {focusNodeObj
                  ? `${focusNodeObj.shortname} — ${focusNodeObj.longname}`
                  : urlNode}
              </span>
              <span className="text-xs text-indigo-800/70 dark:text-indigo-200/70">
                ({urlFocus === "any" ? "including via" : "endpoints only"},{" "}
                {urlDir})
              </span>

              <div className="flex items-center gap-2 ml-auto">
                <Link
                  to={`/nodes/${urlNode}`}
                  className="text-sm underline hover:no-underline text-indigo-900 dark:text-indigo-100"
                >
                  open node
                </Link>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-sm border border-indigo-400/50 dark:border-indigo-600/50 text-indigo-900 dark:text-indigo-100 hover:bg-indigo-100/60 dark:hover:bg-indigo-900/30 transition"
                  onClick={clearFocus}
                >
                  clear
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Main explorer body (scroll fix: internal panes scroll, not whole page) */}
      <div className="flex-1 overflow-hidden">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-4 h-full">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full min-h-0">
            {/* Message list pane */}
            <div className="lg:col-span-2 min-h-0 flex flex-col">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
                  <div className="text-sm text-gray-800 dark:text-gray-200">
                    {selectedChannel ? (
                      <>
                        <span className="font-semibold">
                          {channelLabel(selectedChannel)}
                        </span>{" "}
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          (Channel {selectedChannel})
                        </span>
                        <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
                          total {totalMessages.toLocaleString()}
                        </span>
                      </>
                    ) : (
                      "No channel selected"
                    )}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    showing{" "}
                    <span className="font-medium">
                      {messages.length.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div
                  ref={listTopRef}
                  className="flex-1 overflow-y-auto min-h-0"
                >
                  <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                    {messages.map((m: any, idx: number) => {
                      const fromId = String(m.from ?? "");
                      const toId = String(m.to ?? "");
                      const msgId = String(m.id ?? `${idx}`);
                      const isSelected = urlMsg && msgId === String(urlMsg);

                      const fromNode = (nodes as any)[fromId] || null;
                      const viaNodes = Array.isArray(m.sender)
                        ? m.sender
                            .map((sid: string) => (nodes as any)[sid])
                            .filter(Boolean)
                        : [];

                      const distanceFromSender =
                        fromNode && viaNodes.length
                          ? viaNodes
                              .filter((s: any) => s.position)
                              .map((s: any) =>
                                calculateDistanceBetweenNodes(fromNode, s)
                              )
                              .filter(Boolean)
                          : [];

                      const dxStr = distanceFromSender?.length
                        ? distanceFromSender
                            .map((d: any) => `${d} km`)
                            .join(", ")
                        : "";

                      const focusId = urlNode.trim();
                      const viaIds = Array.isArray(m.sender)
                        ? m.sender.map(String)
                        : [];
                      const thisInFocus =
                        focusId &&
                        (fromId === focusId ||
                          toId === focusId ||
                          (urlFocus === "any" && viaIds.includes(focusId)));

                      return (
                        <li
                          id={`msg-${msgId}`}
                          key={`msg-${msgId}-${idx}`}
                          className={[
                            "px-4 py-3 cursor-pointer transition outline-none",
                            isSelected
                              ? "bg-indigo-50/70 dark:bg-indigo-900/20 ring-1 ring-indigo-400/30"
                              : "hover:bg-gray-50 dark:hover:bg-gray-900/30",
                            thisInFocus ? "ring-1 ring-indigo-400/15" : "",
                          ].join(" ")}
                          onClick={() => setParam("msg", msgId, "push")}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <NodeChip
                                nodeId={fromId}
                                fallback="UNK"
                                titlePrefix="From"
                                compact
                                stopPropagation
                                onFocus={(id) => applyFocus(id)}
                              />
                              <span className="text-gray-400">→</span>
                              {isBroadcast(toId) ? (
                                <span className="rounded-md px-2 py-0.5 text-[11px] font-medium bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
                                  ALL
                                </span>
                              ) : (
                                <NodeChip
                                  nodeId={toId}
                                  fallback="UNK"
                                  titlePrefix="To"
                                  compact
                                  stopPropagation
                                  onFocus={(id) => applyFocus(id)}
                                />
                              )}

                              <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                                hops {m.hops_away ?? 0}
                              </span>

                              {!isBroadcast(toId) ? (
                                <span className="rounded-full px-2 py-0.5 text-[11px] bg-indigo-100/70 dark:bg-indigo-800/30 text-indigo-900 dark:text-indigo-100">
                                  DM
                                </span>
                              ) : (
                                <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                                  BC
                                </span>
                              )}

                              {dxStr ? (
                                <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                                  dx {dxStr}
                                </span>
                              ) : null}
                            </div>

                            <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                              {formatTimestamp(m.timestamp) || "Unknown"}
                            </div>
                          </div>

                          <div className="mt-2 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
                            {renderHighlightedText(String(m.text ?? ""), urlQ)}
                          </div>

                          <div className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                            via:{" "}
                            {viaNodes.length ? (
                              viaNodes.map((s: any, i: number) => (
                                <span key={`via-${msgId}-${s.id}-${i}`}>
                                  <Link
                                    to={`/nodes/${s.id}`}
                                    className="underline hover:no-underline"
                                    title={`${s.id} / ${s.longname}`}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {s.shortname ?? "UNK"}
                                  </Link>
                                  {i < viaNodes.length - 1 ? ", " : ""}
                                </span>
                              ))
                            ) : (
                              <span className="text-gray-500">UNK</span>
                            )}
                          </div>
                        </li>
                      );
                    })}

                    {messages.length === 0 ? (
                      <li className="px-4 py-8">
                        <div className="text-sm text-gray-700 dark:text-gray-200 font-medium">
                          No messages match your current filters.
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-md px-3 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 transition"
                            onClick={clearFilters}
                          >
                            Clear filters
                          </button>
                          <button
                            type="button"
                            className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                            onClick={() => setParam("r", "all", "push")}
                          >
                            Set range: all
                          </button>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Tip: open Filters for from/to/via/hops flags.
                          </div>
                        </div>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </div>
            </div>

            {/* Right column: Focus panel + Details panel */}
            <div className="lg:col-span-1 flex flex-col gap-4 min-h-0 h-full">
              {/* Focus panel */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col max-h-[40vh] min-h-0">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    Node focus
                  </div>
                  {urlNode.trim() ? (
                    <button
                      type="button"
                      className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
                      onClick={clearFocus}
                    >
                      clear
                    </button>
                  ) : null}
                </div>

                <div className="p-4 flex-1 overflow-y-auto min-h-0">
                  {!urlNode.trim() ? (
                    <>
                      <div className="text-sm text-gray-700 dark:text-gray-200 font-medium">
                        Focus a node
                      </div>
                      <div className="mt-2">
                        <input
                          value={focusPicker}
                          onChange={(e) => setFocusPicker(e.target.value)}
                          placeholder="Type 2+ chars… (id, shortname, longname)"
                          className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
                        />
                      </div>

                      {focusMatches.length > 0 ? (
                        <div className="mt-2 rounded-md border border-gray-200 dark:border-gray-800 overflow-hidden">
                          <ul className="divide-y divide-gray-200 dark:divide-gray-800 max-h-64 overflow-y-auto">
                            {focusMatches.map((m) => (
                              <li
                                key={`match-${m.id}`}
                                className="px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-900/30 cursor-pointer"
                                onClick={() => applyFocus(m.id)}
                                role="button"
                                tabIndex={0}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-gray-900 dark:text-gray-100 font-medium">
                                    {m.short || "UNK"}
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                    {m.id}
                                  </div>
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                  {m.long || "Unknown"}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          Tip: type “fr”, “nb99”, “7cf6e06c”, etc.
                        </div>
                      )}

                      {frequentNodes.length > 0 ? (
                        <div className="mt-4">
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Frequent in current view
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {frequentNodes.map((x) => (
                              <button
                                key={`freq-${x.nodeId}`}
                                type="button"
                                className="rounded-md px-2 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                                onClick={() => applyFocus(x.nodeId)}
                                title={`${x.nodeId} (${x.count})`}
                              >
                                {(nodes as any)[x.nodeId]?.shortname ?? "UNK"}{" "}
                                <span className="opacity-70">({x.count})</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {focusNodeObj?.shortname ?? "UNK"}{" "}
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                              {focusNodeObj?.longname ?? urlNode}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono">
                            {urlNode}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/nodes/${urlNode}`}
                            className="text-xs underline hover:no-underline text-gray-700 dark:text-gray-200"
                          >
                            open
                          </Link>
                          <button
                            type="button"
                            className="text-xs underline hover:no-underline text-gray-700 dark:text-gray-200"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(urlNode);
                              } catch {
                                // no-op
                              }
                            }}
                            title="Copy node id"
                          >
                            copy id
                          </button>
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Messages
                          </div>
                          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {focusStats?.total ?? 0}
                          </div>
                        </div>
                        <div className="rounded-md border border-gray-200 dark:border-gray-800 p-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            In / Out
                          </div>
                          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {(focusStats?.inbound ?? 0).toLocaleString()} /{" "}
                            {(focusStats?.outbound ?? 0).toLocaleString()}
                          </div>
                        </div>
                      </div>

                      {focusStats?.hopsChips?.length ? (
                        <div className="mt-4">
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Hops distribution
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {focusStats.hopsChips.map((h) => (
                              <span
                                key={`hop-${h.hops}`}
                                className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                                title={`${h.count} messages`}
                              >
                                {h.hops} hops: {h.count}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {/* Details pane */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex-1 min-h-0 flex flex-col">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    Message details
                  </div>
                  {urlMsg ? (
                    <button
                      type="button"
                      className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
                      onClick={() => setParam("msg", undefined, "push")}
                    >
                      close
                    </button>
                  ) : null}
                </div>

                <div className="flex-1 overflow-y-auto min-h-0">
                  {!urlMsg ? (
                    <div className="px-4 py-6 text-sm text-gray-600 dark:text-gray-400">
                      <div className="font-medium text-gray-700 dark:text-gray-200">
                        Click a message
                      </div>
                      <div className="mt-1">
                        Select a message on the left to inspect route, hops, and nodes.
                      </div>
                      <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                        Pro tip: click the ⊙ next to a node to focus it.
                      </div>
                    </div>
                  ) : !selectedMessage ? (
                    <div className="px-4 py-6 text-sm text-gray-600 dark:text-gray-400">
                      <div className="font-medium text-gray-700 dark:text-gray-200">
                        Message not in current view
                      </div>
                      <div className="mt-1">
                        It may be filtered out by range/type/hops/focus or advanced filters.
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 transition"
                          onClick={() => setParam("msg", undefined, "push")}
                        >
                          Clear selection
                        </button>
                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          onClick={clearFilters}
                        >
                          Clear filters
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          ID:{" "}
                          <span className="font-mono text-gray-700 dark:text-gray-200">
                            {String(selectedMessage.id)}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {formatTimestamp(selectedMessage.timestamp) ||
                            String(selectedMessage.timestamp)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          Text
                        </div>
                        <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-gray-200 dark:border-gray-800 p-3 bg-white dark:bg-gray-900/30 text-sm text-gray-900 dark:text-gray-100">
                          {renderHighlightedText(
                            String(selectedMessage.text ?? ""),
                            urlQ
                          )}
                        </div>
                      </div>

                      {/* Commit 6: Route visualization */}
                      <div>
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          Route
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <NodeChip
                            nodeId={String(selectedMessage.from ?? "")}
                            fallback="UNK"
                            titlePrefix="From"
                            compact
                            stopPropagation
                            onFocus={(id) => applyFocus(id)}
                          />

                          <span className="text-gray-400">→</span>

                          {Array.isArray(selectedMessage.sender) &&
                          selectedMessage.sender.length ? (
                            selectedMessage.sender.map((sid: any, idx: number) => (
                              <span
                                key={`route-via-${String(sid)}-${idx}`}
                                className="inline-flex items-center gap-2"
                              >
                                <NodeChip
                                  nodeId={String(sid)}
                                  fallback="UNK"
                                  titlePrefix="Via"
                                  compact
                                  stopPropagation
                                  onFocus={(id) => applyFocus(id)}
                                />
                                <span className="text-gray-400">→</span>
                              </span>
                            ))
                          ) : (
                            <>
                              <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                                via UNK
                              </span>
                              <span className="text-gray-400">→</span>
                            </>
                          )}

                          {isBroadcast(String(selectedMessage.to ?? "")) ? (
                            <span className="rounded-md px-2 py-0.5 text-[11px] font-medium bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
                              ALL
                            </span>
                          ) : (
                            <NodeChip
                              nodeId={String(selectedMessage.to ?? "")}
                              fallback="UNK"
                              titlePrefix="To"
                              compact
                              stopPropagation
                              onFocus={(id) => applyFocus(id)}
                            />
                          )}

                          <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                            hops {selectedMessage.hops_away ?? 0}
                          </span>
                        </div>

                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          {routeLabel(String(selectedMessage.from ?? ""))}{" "}
                          {"->"}{" "}
                          {Array.isArray(selectedMessage.sender) &&
                          selectedMessage.sender.length
                            ? selectedMessage.sender
                                .map((x: any) => routeLabel(String(x)))
                                .join(" -> ")
                            : "UNK"}{" "}
                          {"->"}{" "}
                          {routeLabel(String(selectedMessage.to ?? ""))}
                        </div>
                      </div>

                      <div className="pt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                String(selectedMessage.text ?? "")
                              );
                            } catch {
                              // no-op
                            }
                          }}
                        >
                          Copy text
                        </button>

                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          onClick={() => copyRoute(selectedMessage)}
                          title="Copy route chain"
                        >
                          Copy route
                        </button>

                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          onClick={() => applyFocus(String(selectedMessage.from))}
                          title="Focus sender"
                          disabled={!String(selectedMessage.from ?? "").trim() || isBroadcast(String(selectedMessage.from))}
                        >
                          Focus from
                        </button>

                        <button
                          type="button"
                          className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          onClick={() => applyFocus(String(selectedMessage.to))}
                          title="Focus recipient"
                          disabled={isBroadcast(String(selectedMessage.to))}
                        >
                          Focus to
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Commit 6 complete: export + route viz + scroll fix */}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
