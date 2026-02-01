import {
  useEffect,
  useMemo,
  useState,
  useDeferredValue,
  useRef,
  useCallback,
} from "react";
import { Link } from "react-router-dom";
import { VirtuosoHandle } from "react-virtuoso";

import { useChatSearchParams } from "../hooks/useChatSearchParams";

import { HeardBy } from "../components/HeardBy";
import {
  useGetChatsQuery,
  useGetConfigQuery,
  useGetNodesQuery,
} from "../slices/apiSlice";

import {
  DirKey,
  FocusMode,
  MsgType,
  RangeKey,
  SortKey,
  csvEscape,
  downloadBlob,
  isBroadcast,
} from "./chat/chatUtils";

import { FiltersDrawer } from "./chat/FiltersDrawer";
import { ExportMenu } from "./chat/ExportMenu";
import { MessageList } from "./chat/MessageList";
import { FocusPanel } from "./chat/FocusPanel";
import { DetailsPanel } from "./chat/DetailsPanel";

type ViewDef = {
  key: string; // canonical URL key: "mediumfast"
  label: string; // "MediumFast"
  short?: string; // "MF"
  channelId: string; // "0"
  aliases: string[]; // ["mf","0","MediumFast",...]
  tooltip?: string;
  isDefault?: boolean;
};

const normalizeKey = (s: string) => {
  const raw = String(s ?? "").trim().toLowerCase();
  const k = raw.replace(/[^a-z0-9]+/g, "");
  if (!k) return "";
  if (k.startsWith("all")) return "all";
  return k;
};

export const Chat = () => {
  const { data: chat, dataUpdatedAt, isFetching, refetch } = useGetChatsQuery();
  const { data: nodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  // ---- Channel metadata (from broker config)
  const channelMeta = (config?.broker?.channels as any)?.meta ?? {};
  const rawChannelLabel = (id: string) =>
    channelMeta?.[id]?.label ? String(channelMeta[id].label) : `Channel ${id}`;
  const rawChannelShort = (id: string) =>
    channelMeta?.[id]?.short ? String(channelMeta[id].short) : id;

  const rawChannelTooltip = (id: string) => {
    const meta = channelMeta?.[id] ?? {};
    const label = rawChannelLabel(id);
    const short = rawChannelShort(id);
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

  // ---- Available channels from data (still the source of messages)
  const channelEntries = useMemo(() => {
    const entries = Object.entries(chat?.channels ?? {});
    const allow = config?.broker?.channels?.display;
    if (Array.isArray(allow) && allow.length > 0) {
      return entries.filter(([id]) => allow.includes(id));
    }
    return entries;
  }, [chat?.channels, config?.broker?.channels?.display]);

  const availableChannelIds = useMemo(
    () => new Set(channelEntries.map(([id]) => String(id))),
    [channelEntries]
  );

  // ---- Build “views” from broker.channels.views (single-channel ones)
  const views: ViewDef[] = useMemo(() => {
    const vraw = (config?.broker?.channels as any)?.views;
    const out: ViewDef[] = [];

    if (Array.isArray(vraw) && vraw.length > 0) {
      for (const v of vraw) {
        const chans = Array.isArray(v?.channels) ? v.channels.map(String) : [];
        if (chans.length !== 1) continue;
        const channelId = chans[0];
        if (!availableChannelIds.has(channelId)) continue;

        const label = String(v?.label ?? v?.id ?? rawChannelLabel(channelId));
        const short = v?.short ? String(v.short) : rawChannelShort(channelId);

        const key =
          normalizeKey(label) || normalizeKey(String(v?.id ?? "")) || channelId;

        const aliases = [
          key,
          String(v?.id ?? ""),
          String(v?.short ?? ""),
          label,
          channelId,
          normalizeKey(String(v?.id ?? "")),
          normalizeKey(String(v?.short ?? "")),
          normalizeKey(label),
        ]
          .map((x) => String(x ?? "").trim())
          .filter(Boolean);

        out.push({
          key,
          label,
          short,
          channelId,
          aliases: Array.from(new Set(aliases)),
          tooltip: [
            `${label}${short ? ` • ${short}` : ""}`,
            `Channel: ${channelId}`,
            v?.description ? String(v.description) : "",
          ]
            .filter(Boolean)
            .join("\n"),
          isDefault: !!v?.default,
        });
      }
    }

    // Fallback: if no views config, present channels as-is (canonical key = channel id)
    if (out.length === 0) {
      for (const [id] of channelEntries) {
        const channelId = String(id);
        out.push({
          key: channelId,
          label: rawChannelLabel(channelId),
          short: rawChannelShort(channelId),
          channelId,
          aliases: [channelId],
          tooltip: rawChannelTooltip(channelId),
          isDefault: channelId === "0",
        });
      }
    }

    return out;
  }, [config, channelEntries, availableChannelIds]);

  const defaultViewKey =
    views.find((v) => v.isDefault)?.key ?? views[0]?.key ?? "";

  // ---- URL + canonicalization (ch becomes preset slug)
  const {
    searchParams,
    urlCh,
    urlQ,
    urlRange,
    urlType,
    urlSort,
    urlNode,
    urlFocus,
    urlDir,
    urlMsg,
    urlFrom,
    urlTo,
    urlVia,
    urlHopsMin,
    urlHopsMax,
    onlyUnknownEndpoints,
    requireVia,
    setParam,
    setParams,
    clearFilters,
  } = useChatSearchParams({
    views: views.map((v) => ({ key: v.key, aliases: v.aliases })),
    defaultCh: defaultViewKey,
  });

  // UI state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Live / auto-follow toggle
  const [liveEnabled, setLiveEnabled] = useState(true);

  // Follow state reported by MessageList so header can reflect "Paused" even when liveEnabled=true
  const [followState, setFollowState] = useState<{
    atEdge: boolean;
    selectionPinned: boolean;
    newCount: number;
  }>({ atEdge: true, selectionPinned: false, newCount: 0 });

  const onFollowStateChange = useCallback(
    (s: { atEdge: boolean; selectionPinned: boolean; newCount: number }) => {
      setFollowState(s);
    },
    []
  );

  // Export menu
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  // Search input
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Focus picker input
  const [focusPicker, setFocusPicker] = useState("");
  const focusPickerDeferred = useDeferredValue(focusPicker);

  // Keep local search input synced on back/forward
  useEffect(() => {
    setQInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  // Update URL q from deferred input (replace, don’t spam history)
  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  const selectedView = useMemo(() => {
    const v = views.find((x) => x.key === urlCh);
    return v ?? views.find((x) => x.key === defaultViewKey) ?? views[0];
  }, [views, urlCh, defaultViewKey]);

  const selectedChannel = selectedView?.channelId;

  const channelLabel = (id: string) => {
    const v = views.find((x) => x.channelId === id);
    return v?.label ?? rawChannelLabel(id);
  };

  const channelShort = (id: string) => {
    const v = views.find((x) => x.channelId === id);
    return v?.short ?? rawChannelShort(id);
  };

  const channelTooltip = (id: string) => {
    const v = views.find((x) => x.channelId === id);
    return v?.tooltip ?? rawChannelTooltip(id);
  };

  const selectedChannelObj = useMemo(() => {
    if (!selectedChannel) return undefined;
    return (chat?.channels as any)?.[selectedChannel];
  }, [chat?.channels, selectedChannel]);

  const totalMessages = selectedChannelObj?.totalMessages ?? 0;

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

  // Messages (filtered + sorted)
  const messages = useMemo(() => {
    if (!selectedChannel) return [];
    const channelObj = (chat?.channels as any)?.[selectedChannel];
    if (!channelObj?.messages) return [];

    let msgs = [...channelObj.messages];

    if (rangeThreshold) {
      msgs = msgs.filter((m: any) => (m.timestamp ?? 0) >= rangeThreshold);
    }

    if (urlType === "bc") msgs = msgs.filter((m: any) => isBroadcast(m.to));
    if (urlType === "dm") msgs = msgs.filter((m: any) => !isBroadcast(m.to));

    if (requireVia) {
      msgs = msgs.filter(
        (m: any) => Array.isArray(m.sender) && m.sender.length > 0
      );
    }

    if (typeof urlHopsMin === "number") {
      msgs = msgs.filter((m: any) => (m.hops_away ?? 0) >= urlHopsMin);
    }
    if (typeof urlHopsMax === "number") {
      msgs = msgs.filter((m: any) => (m.hops_away ?? 0) <= urlHopsMax);
    }

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

    if (onlyUnknownEndpoints) {
      msgs = msgs.filter((m: any) => {
        const from = String(m.from ?? "");
        const to = String(m.to ?? "");
        const fromKnown = from in (nodes as any);
        const toKnown = isBroadcast(to) ? true : to in (nodes as any);
        return !fromKnown || !toKnown;
      });
    }

    const q = (urlQ ?? "").trim().toLowerCase();
    if (q.length > 0) {
      msgs = msgs.filter((m: any) =>
        String(m.text ?? "").toLowerCase().includes(q)
      );
    }

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

  const selectedMessage = useMemo(() => {
    if (!urlMsg) return undefined;
    return messages.find((m: any) => String(m.id) === String(urlMsg));
  }, [messages, urlMsg]);

  // Active filter count
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

    if (urlSort !== "desc")
      chips.push({
        label: "Sort: oldest",
        clear: () => setParam("s", undefined, "push"),
      });

    return chips;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  ]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

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

  // Frequent nodes
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

  // Focus stats
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

  // Virtualized list ref
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  // Scroll selected message into view (Commit 8)
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!urlMsg) {
      pendingScrollRef.current = null;
      return;
    }

    const idx = (messages as any[]).findIndex(
      (m: any) => String(m.id) === String(urlMsg)
    );
    if (idx < 0) {
      pendingScrollRef.current = null;
      return;
    }

    pendingScrollRef.current = urlMsg;

    const attempts = [50, 150, 400, 800];
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const delay of attempts) {
      timers.push(
        setTimeout(() => {
          if (pendingScrollRef.current !== urlMsg) return;

          const currentIdx = (messages as any[]).findIndex(
            (m: any) => String(m.id) === String(urlMsg)
          );
          if (currentIdx < 0) return;

          virtuosoRef.current?.scrollToIndex({
            index: currentIdx,
            align: "center",
            behavior: "smooth",
          });
        }, delay)
      );
    }

    return () => {
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlMsg, messages, selectedChannel]);

  // Export menu click-outside
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

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTypingContext =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as any)?.isContentEditable;

      if (!isTypingContext && e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        if (filtersOpen) {
          setFiltersOpen(false);
          return;
        }
        if (exportOpen) {
          setExportOpen(false);
          return;
        }
        if (urlMsg) {
          setParam("msg", undefined, "push");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersOpen, exportOpen, urlMsg]);

  // ---- Export rows + handlers (Commit 6)
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
        to_short: isBroadcast(toId)
          ? "ALL"
          : (nodes as any)[toId]?.shortname ?? "UNK",
        hops: Number(m.hops_away ?? 0),
        via_ids: viaIds.join(","),
        via_short: viaIds
          .map((id) => (nodes as any)[id]?.shortname ?? "UNK")
          .join(","),
        text: String(m.text ?? ""),
      };
    });
  }, [messages, nodes, selectedChannel]);

  const exportFilenameBase = useMemo(() => {
    const base = selectedView?.key || (selectedChannel ?? "ch");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `chat_${base}_${ts}`;
  }, [selectedView, selectedChannel]);

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
      type: "application/json;charset=utf-8",
    });

    downloadBlob(blob, `${exportFilenameBase}.json`);
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

    const csv = "\ufeff" + [header, ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });

    downloadBlob(blob, `${exportFilenameBase}.csv`);
    setExportOpen(false);
  };

  // Live-edge depends on sort:
  // - asc (oldest→newest): live edge is bottom
  // - desc (newest→oldest): live edge is top
  const followEdge = urlSort === "asc" ? ("bottom" as const) : ("top" as const);

  // A signature so MessageList can reset "new messages" when filters/sort/channel changes
  const filtersSig = useMemo(() => {
    return JSON.stringify({
      ch: selectedChannel ?? "",
      q: urlQ ?? "",
      r: urlRange,
      t: urlType,
      s: urlSort,
      node: urlNode ?? "",
      focus: urlFocus,
      dir: urlDir,
      from: urlFrom ?? "",
      to: urlTo ?? "",
      via: urlVia ?? "",
      hmin: urlHopsMin ?? null,
      hmax: urlHopsMax ?? null,
      unk: onlyUnknownEndpoints ? 1 : 0,
      hv: requireVia ? 1 : 0,
    });
  }, [
    selectedChannel,
    urlQ,
    urlRange,
    urlType,
    urlSort,
    urlNode,
    urlFocus,
    urlDir,
    urlFrom,
    urlTo,
    urlVia,
    urlHopsMin,
    urlHopsMax,
    onlyUnknownEndpoints,
    requireVia,
  ]);

  // Derive what the header pill should say
  const liveUiMode = useMemo(() => {
    if (!liveEnabled) return "off" as const;
    if (followState.selectionPinned) return "pinned" as const;
    if (!followState.atEdge) return "paused" as const;
    return "live" as const;
  }, [liveEnabled, followState.atEdge, followState.selectionPinned]);

  const livePillText = useMemo(() => {
    if (liveUiMode === "live") return "Live";
    if (liveUiMode === "pinned") return "Pinned";
    if (liveUiMode === "paused") {
      return followState.newCount > 0
        ? `Paused (${followState.newCount})`
        : "Paused";
    }
    return "Live off";
  }, [liveUiMode, followState.newCount]);

  const livePillTitle = useMemo(() => {
    const edge =
      followEdge === "bottom"
        ? "bottom (oldest→newest)"
        : "top (newest→oldest)";
    if (!liveEnabled) return `Live mode is off. Enable to auto-follow at the ${edge}.`;
    if (followState.selectionPinned)
      return "A message is selected (msg=...). Auto-follow is suspended until selection is cleared or you jump back to live.";
    if (!followState.atEdge)
      return `You scrolled away from the live edge. Auto-follow will resume when you return to the ${edge}.`;
    return `Auto-follow is active at the ${edge}.`;
  }, [liveEnabled, followState.selectionPinned, followState.atEdge, followEdge]);

  return (
    <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
      <FiltersDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        clearFilters={clearFilters}
        onlyUnknownEndpoints={onlyUnknownEndpoints}
        requireVia={requireVia}
        urlFrom={urlFrom}
        urlTo={urlTo}
        urlVia={urlVia}
        urlHopsMin={urlHopsMin}
        urlHopsMax={urlHopsMax}
        nodes={nodes}
        setParam={setParam}
      />

      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-3">
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
                  {isFetching ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => refetch()}
                >
                  refresh
                </button>

                <span className="opacity-60">•</span>

                <button
                  type="button"
                  className={[
                    "rounded-full px-2 py-0.5 text-[11px] font-medium border transition",
                    liveUiMode === "live"
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : liveUiMode === "paused"
                        ? "bg-amber-600 text-white border-amber-600"
                        : liveUiMode === "pinned"
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                  ].join(" ")}
                  onClick={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                >
                  {livePillText}
                </button>

                <span className="opacity-60">•</span>

                <HeardBy />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ExportMenu
                open={exportOpen}
                setOpen={setExportOpen}
                exportRowsCount={exportRows.length}
                doExportCsv={doExportCsv}
                doExportJson={doExportJson}
                exportMenuRef={exportMenuRef}
              />

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

          {/* Preset pills (canonical ch=mediumfast/longfast) */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {views.map((v) => {
              const active = v.key === selectedView?.key;
              const chObj: any = (chat?.channels as any)?.[v.channelId];
              const count = chObj?.totalMessages ?? 0;

              return (
                <button
                  key={`preset-${v.key}`}
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
                        { key: "ch", value: v.key },
                        { key: "msg", value: undefined },
                      ],
                      "push"
                    );
                  }}
                  title={v.tooltip || channelTooltip(v.channelId)}
                >
                  {v.label}
                  <span
                    className={[
                      "ml-2 rounded-full px-2 py-0.5 text-xs",
                      active
                        ? "bg-white/20 text-white"
                        : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200",
                    ].join(" ")}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Toolbar row */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-[260px]">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search messages… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            <div className="flex flex-wrap gap-2 items-center">
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

              <select
                value={urlFocus}
                onChange={(e) => setParam("focus", e.target.value, "push")}
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Node focus mode"
              >
                <option value="endpoints">Focus: endpoints</option>
                <option value="any">Focus: include via</option>
              </select>

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

          {urlNode ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-indigo-300/50 dark:border-indigo-700/50 bg-indigo-50/50 dark:bg-indigo-900/20 px-3 py-2">
              <span className="text-sm text-indigo-900 dark:text-indigo-100 font-medium">
                Focus:
              </span>
              <span className="text-sm text-indigo-900 dark:text-indigo-100">
                {(nodes as any)?.[urlNode]
                  ? `${(nodes as any)[urlNode].shortname} — ${
                      (nodes as any)[urlNode].longname
                    }`
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

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pt-3 pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full min-h-0">
            <div className="lg:col-span-2 min-h-0 flex flex-col">
              <MessageList
                selectedChannel={selectedChannel}
                channelLabel={channelLabel}
                totalMessages={totalMessages}
                messages={messages}
                nodes={nodes}
                urlMsg={urlMsg}
                urlQ={urlQ}
                urlNode={urlNode}
                urlFocus={urlFocus as FocusMode}
                urlSort={urlSort as SortKey}
                setParam={setParam}
                applyFocus={applyFocus}
                clearFilters={clearFilters}
                setRangeAll={() => setParam("r", "all", "push")}
                virtuosoRef={virtuosoRef}
                liveEnabled={liveEnabled}
                setLiveEnabled={setLiveEnabled}
                followEdge={followEdge}
                filtersSig={filtersSig}
                onFollowStateChange={onFollowStateChange}
              />
            </div>

            <div className="lg:col-span-1 flex flex-col gap-4 min-h-0 h-full">
              <FocusPanel
                urlNode={urlNode}
                nodes={nodes}
                focusPicker={focusPicker}
                setFocusPicker={setFocusPicker}
                focusMatches={focusMatches}
                frequentNodes={frequentNodes}
                applyFocus={applyFocus}
                clearFocus={clearFocus}
                focusStats={focusStats}
              />

              <DetailsPanel
                urlMsg={urlMsg}
                selectedMessage={selectedMessage}
                urlQ={urlQ}
                nodes={nodes}
                applyFocus={applyFocus}
                setParam={setParam}
                clearFilters={clearFilters}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
