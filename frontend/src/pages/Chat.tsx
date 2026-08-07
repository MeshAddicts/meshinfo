import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router";
import { VirtuosoHandle } from "react-virtuoso";

import { ExportMenu } from "../components/ExportMenu";
import { HeardBy } from "../components/HeardBy";
import { LivePill } from "../components/LivePill";
import { MobileSheet } from "../components/MobileSheet";
import { useAppSelector } from "../hooks/redux";
import {
  REMEMBERED_CH_KEYS,
  useRememberedChannel,
} from "../hooks/useRememberedChannel";
import {
  useGetChatsQuery,
  useGetConfigQuery,
  useGetNodesQuery,
} from "../slices/apiSlice";
import { copyTextToClipboard } from "../utils/clipboard";
import { csvEscape, downloadBlob } from "../utils/export";
import {
  DirKey,
  FocusMode,
  isBroadcast,
  RangeKey,
  SortKey,
} from "./chat/chatUtils";
import { DetailsPanel } from "./chat/DetailsPanel";
import { FiltersDrawer } from "./chat/FiltersDrawer";
import { FocusPanel } from "./chat/FocusPanel";
import { MessageList } from "./chat/MessageList";
import { useChatSearchParams } from "./chat/useChatSearchParams";

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

type MobileSheetKey = "controls" | "focus" | "details";

function StatusChip({
  label,
  active,
  title,
  onClick,
}: {
  label: string;
  active?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick && !!active;

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      title={title}
      className={[
        "rounded-full px-3 py-1 text-xs border transition whitespace-nowrap",
        "border-gray-300/60 dark:border-gray-700",
        clickable
          ? "text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40"
          : "text-gray-500 dark:text-gray-500 opacity-70 cursor-default",
        active ? "bg-white/5 dark:bg-gray-800/30 opacity-100" : "bg-transparent",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

// Owns keystroke state so typing doesn't re-render the whole Chat tree
function ChatSearchInput({
  urlQ,
  setParam,
  inputRef,
}: {
  urlQ: string;
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);

  // Keep local search input synced on back/forward
  useEffect(() => {
    setQInput(urlQ);
  }, [urlQ]);

  // Update URL q from deferred input (replace)
  useEffect(() => {
    if (urlQ === qDeferred) return;
    setParam("q", qDeferred, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  return (
    <input
      ref={inputRef}
      value={qInput}
      onChange={(e) => setQInput(e.target.value)}
      placeholder="Search messages… (press / to focus)"
      className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/60"
    />
  );
}

export const Chat = () => {
  // ── 1. Non-chat data queries ──
  const { data: nodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  // ── 2. Raw URL params for early channel resolution ──
  // We need channel + range BEFORE the full views pipeline runs,
  // so we read them directly from the URL here to break the
  // circular dependency (channelEntries → views → selectedChannel
  // → chat query → channelEntries).
  const [searchParamsRaw] = useSearchParams();
  const rawCh = normalizeKey(searchParamsRaw.get("ch") || "");
  const rawRange = (searchParamsRaw.get("r") || "24h") as string;

  // ── 3. Channel metadata helpers (from broker config) ──
  const channelMeta = useMemo(
    () => (config?.broker?.channels as any)?.meta ?? {},
    [config]
  );
  const rawChannelLabel = useCallback(
    (id: string) =>
      channelMeta?.[id]?.label ? String(channelMeta[id].label) : `Channel ${id}`,
    [channelMeta]
  );
  const rawChannelShort = useCallback(
    (id: string) =>
      channelMeta?.[id]?.short ? String(channelMeta[id].short) : id,
    [channelMeta]
  );
  const rawChannelTooltip = useCallback(
    (id: string) => {
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
    },
    [channelMeta, rawChannelLabel, rawChannelShort]
  );

  // ── 4. Resolve channel ID from config + raw URL ──
  // This lets the chat query fire immediately using only config
  // data, without waiting for chat data to build the full views.
  const resolvedChannelId = useMemo(() => {
    const viewsConfig = (config?.broker?.channels as any)?.views;
    if (!Array.isArray(viewsConfig) || viewsConfig.length === 0) {
      // No views config — fall back to the raw URL channel if it looks
      // like a numeric channel id, otherwise default to "0".
      if (rawCh && /^[0-9]+$/.test(rawCh)) return rawCh;
      return "0";
    }

    // Try matching the raw URL ch param against config views
    if (rawCh) {
      for (const v of viewsConfig) {
        const chans = Array.isArray(v?.channels)
          ? v.channels.map(String)
          : [];
        if (chans.length !== 1) continue;

        const key = normalizeKey(String(v?.label ?? v?.id ?? ""));
        const id = normalizeKey(String(v?.id ?? ""));
        const short = normalizeKey(String(v?.short ?? ""));
        const channelId = chans[0];

        if (
          rawCh === key ||
          rawCh === id ||
          rawCh === short ||
          rawCh === channelId
        ) {
          return channelId;
        }
      }
    }

    // Fall back to the default view's channel
    const def =
      viewsConfig.find((v: any) => v.default) ?? viewsConfig[0];
    if (def?.channels?.[0]) return String(def.channels[0]);
    // Views exist but no channel resolved — still scope the query
    if (rawCh && /^[0-9]+$/.test(rawCh)) return rawCh;
    return "0";
  }, [config, rawCh]);

  // Live / auto-follow toggle (declared before query so polling can reference it)
  const [liveEnabled, setLiveEnabled] = useState(true);

  // ── 5. Chat query (fires with resolved channel + range) ──
  const chatQueryParams = useMemo(() => {
    const params: { channel?: string; range?: string } = {};
    if (resolvedChannelId) params.channel = resolvedChannelId;
    params.range = rawRange;
    return params;
  }, [resolvedChannelId, rawRange]);

  const {
    data: chat,
    isFetching,
    refetch,
  } = useGetChatsQuery(chatQueryParams, {
    // SSE (useLiveEvents) pushes new chats via the chatPing below; this is just
    // the slow safety-net poll for a dropped, non-reconnecting stream.
    pollingInterval: liveEnabled ? 60000 : 0,
    skipPollingIfUnfocused: true,
    refetchOnReconnect: liveEnabled,
    refetchOnFocus: liveEnabled,
  });

  // Live chat push: useLiveEvents bumps app.chatPing on each `chat` SSE event.
  // Refetch on a bump only while live (a ref keeps the effect from firing when
  // the toggle flips), so a pushed chat respects the explicit "Live off" pause
  // and reuses getChats' dedup/sort transform.
  const chatPing = useAppSelector((s) => s.app.chatPing);
  const liveRef = useRef(liveEnabled);
  liveRef.current = liveEnabled;
  const sawFirstPing = useRef(false);
  useEffect(() => {
    if (!sawFirstPing.current) {
      sawFirstPing.current = true;
      return;
    }
    if (liveRef.current) refetch();
  }, [chatPing, refetch]);

  // ── 6. Stable chat ref (prevents skeleton flash on filter change) ──
  const prevChatRef = useRef(chat);
  if (chat) prevChatRef.current = chat;
  const effectiveChat = chat ?? prevChatRef.current;

  // ── 7. Channel entries from chat data (now below query) ──
  const channelEntries = useMemo(() => {
    const entries = Object.entries(effectiveChat?.channels ?? {});
    const allow = config?.broker?.channels?.display;
    if (Array.isArray(allow) && allow.length > 0) {
      return entries.filter(([id]) => allow.includes(id));
    }
    return entries;
  }, [effectiveChat?.channels, config?.broker?.channels?.display]);

  // null = chat hasn't loaded yet, allow all views through
  const availableChannelIds = useMemo(
    () =>
      channelEntries.length > 0
        ? new Set(channelEntries.map(([id]) => String(id)))
        : null,
    [channelEntries]
  );

  // ── 8. Build "views" from broker.channels.views (single-channel ones) ──
  const views: ViewDef[] = useMemo(() => {
    const vraw = (config?.broker?.channels as any)?.views;
    const out: ViewDef[] = [];

    if (Array.isArray(vraw) && vraw.length > 0) {
      for (const v of vraw) {
        const chans = Array.isArray(v?.channels) ? v.channels.map(String) : [];
        if (chans.length !== 1) continue;
        const channelId = chans[0];
        if (availableChannelIds && !availableChannelIds.has(channelId)) continue;

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
  }, [config, channelEntries, availableChannelIds, rawChannelLabel, rawChannelShort, rawChannelTooltip]);

  const defaultViewKey =
    views.find((v) => v.isDefault)?.key ?? views[0]?.key ?? "";

  // Stable identity: a fresh array here would defeat useChatSearchParams'
  // internal memos on every render.
  const viewParams = useMemo(
    () => views.map((v) => ({ key: v.key, aliases: v.aliases })),
    [views]
  );

  // ── 9. URL + canonicalization (ch becomes preset slug) ──
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
    views: viewParams,
    defaultCh: defaultViewKey,
  });

  // Land returning visitors on the channel they last had selected.
  useRememberedChannel({
    storageKey: REMEMBERED_CH_KEYS.chat,
    value: urlCh === defaultViewKey ? "" : urlCh,
    urlHasCh: !!searchParams.get("ch")?.trim(),
    suppressRestore: [...searchParams.keys()].some((k) => k !== "ch"),
    ready: views.length > 0,
    isValid: (stored) => views.some((v) => v.key === stored),
    apply: (stored) => setParam("ch", stored, "replace"),
  });

  // ── 10. Selected view (for display / pills) ──
  const selectedView = useMemo(() => {
    const v = views.find((x) => x.key === urlCh);
    return v ?? views.find((x) => x.key === defaultViewKey) ?? views[0];
  }, [views, urlCh, defaultViewKey]);

  const selectedChannel = selectedView?.channelId;

  // ── View-based label helpers ──
  const channelLabel = (id: string) => {
    const v = views.find((x) => x.channelId === id);
    return v?.label ?? rawChannelLabel(id);
  };

  const channelTooltip = (id: string) => {
    const v = views.find((x) => x.channelId === id);
    return v?.tooltip ?? rawChannelTooltip(id);
  };

  // ── 11. Derived state from chat data ──
  const selectedChannelObj = useMemo(() => {
    if (!selectedChannel) return undefined;
    return (effectiveChat?.channels as any)?.[selectedChannel];
  }, [effectiveChat?.channels, selectedChannel]);

  const totalMessages = selectedChannelObj?.totalMessages ?? 0;

  // ── UI state ──
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Mobile sheets
  const [mobileSheet, setMobileSheet] = useState<MobileSheetKey | null>(null);

  // Track lg breakpoint (1024px) to gate mobile/desktop behaviors
  const [isLgUp, setIsLgUp] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const m = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsLgUp(m.matches);

    onChange();

    // Safari fallback
    if (typeof m.addEventListener === "function") m.addEventListener("change", onChange);
    else (m as any).addListener(onChange);

    return () => {
      if (typeof m.removeEventListener === "function") m.removeEventListener("change", onChange);
      else (m as any).removeListener(onChange);
    };
  }, []);

  // Mobile UX: when selection changes, auto-open Details sheet
  const prevUrlMsgRef = useRef<string>("");

  useEffect(() => {
    if (isLgUp) return;

    const prev = prevUrlMsgRef.current;
    prevUrlMsgRef.current = urlMsg;

    // If a message becomes selected or selection changes, jump to Details
    if (urlMsg && urlMsg !== prev) {
      setMobileSheet("details");
    }
  }, [urlMsg, isLgUp]);

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
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Click outside sidebar panels to clear message selection
  useEffect(() => {
    if (!urlMsg) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      // Ignore clicks inside the sidebar (details/focus panels)
      if (sidebarRef.current?.contains(t)) return;
      // Ignore clicks inside mobile sheets
      const sheet = (t as HTMLElement).closest?.("[data-mobile-sheet]");
      if (sheet) return;
      // Ignore clicks on interactive elements in the header/toolbar area
      const interactive = (t as HTMLElement).closest?.(
        "button, a, input, select, [role='button']"
      );
      if (interactive) return;

      setParam("msg", undefined, "push");
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [urlMsg, setParam]);

  // Search input state lives in ChatSearchInput; only the ref stays here for the '/' shortcut
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Range threshold
  const rangeThreshold = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    switch (urlRange) {
      case "1h":  return now - 3600;
      case "24h": return now - 86400;
      case "7d":  return now - 604800;
      case "all":
      default:    return undefined;
    }
  }, [urlRange]);

  // Messages stage 1 (filters + sort, no `nodes` dep so live node churn can't rebuild the list)
  const baseMessages = useMemo(() => {
    if (!selectedChannel) return [];
    const channelObj = (effectiveChat?.channels as any)?.[selectedChannel];
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
    effectiveChat?.channels,
    selectedChannel,
    rangeThreshold,
    urlType,
    urlQ,
    urlNode,
    urlFocus,
    urlDir,
    urlSort,
    urlFrom,
    urlTo,
    urlVia,
    urlHopsMin,
    urlHopsMax,
    requireVia,
  ]);

  // Known-node ids, only materialized for the off-by-default unknown-endpoints filter
  const knownNodeIds = useMemo(
    () => (onlyUnknownEndpoints ? new Set(Object.keys(nodes as any)) : null),
    [onlyUnknownEndpoints, nodes]
  );

  // Messages stage 2: unknown-endpoints filter; keeps stage-1 identity when the flag is off
  const messages = useMemo(() => {
    if (!knownNodeIds) return baseMessages;
    return (baseMessages as any[]).filter((m: any) => {
      const from = String(m.from ?? "");
      const to = String(m.to ?? "");
      const fromKnown = knownNodeIds.has(from);
      const toKnown = isBroadcast(to) ? true : knownNodeIds.has(to);
      return !fromKnown || !toKnown;
    });
  }, [baseMessages, knownNodeIds]);

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

  const hasFilters = activeFilterCount > 0;

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
    const url = window.location.href;
    const ok = await copyTextToClipboard(url);

    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      return;
    }

    // Last-resort: let the user manually copy
    window.prompt("Copy link:", url);
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
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Scroll selected message into view: once per urlMsg+channel; msgFound flips when a
  // late-arriving deep-linked message shows up, so the ladder can still run then.
  const pendingScrollRef = useRef<string | null>(null);
  const lastScrolledKeyRef = useRef<string>("");
  const msgFound = !!selectedMessage;
  useEffect(() => {
    if (!urlMsg) {
      pendingScrollRef.current = null;
      lastScrolledKeyRef.current = "";
      return;
    }

    if (!msgFound) {
      // Not in the list — clear the key so a later reveal (filter/range change) re-scrolls
      pendingScrollRef.current = null;
      lastScrolledKeyRef.current = "";
      return;
    }

    const key = `${selectedChannel ?? ""}|${urlMsg}`;
    if (lastScrolledKeyRef.current === key) return;
    pendingScrollRef.current = urlMsg;

    const attempts = [50, 150, 400, 800];
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const delay of attempts) {
      timers.push(
        setTimeout(() => {
          if (pendingScrollRef.current !== urlMsg) return;

          const currentIdx = (messagesRef.current as any[]).findIndex(
            (m: any) => String(m.id) === String(urlMsg)
          );
          if (currentIdx < 0) return;

          // Recorded at fire time (not schedule time): a StrictMode remount
          // clears the timers before they fire and must not swallow the scroll
          lastScrolledKeyRef.current = key;
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
  }, [urlMsg, selectedChannel, msgFound]);

  // Export menu click-outside (desktop only)
  useEffect(() => {
    if (!exportOpen) return;
    if (!isLgUp) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (exportMenuRef.current && !exportMenuRef.current.contains(t)) {
        setExportOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen, isLgUp]);

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
        if (mobileSheet) {
          setMobileSheet(null);
          return;
        }
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
  }, [filtersOpen, exportOpen, urlMsg, mobileSheet]);

  // ---- Export rows + handlers (rows built at click time; render only needs counts) ----
  const buildExportRows = () => {
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
          .map((id: string) => (nodes as any)[id]?.shortname ?? "UNK")
          .join(","),
        text: String(m.text ?? ""),
      };
    });
  };

  const exportFilenameBase = useMemo(() => {
    const base = selectedView?.key || (selectedChannel ?? "ch");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `chat_${base}_${ts}`;
  }, [selectedView, selectedChannel]);

  const doExportJson = () => {
    const rows = buildExportRows();
    const payload = {
      exportedAt: new Date().toISOString(),
      channel: selectedChannel ?? "",
      channelLabel: selectedChannel ? channelLabel(selectedChannel) : "",
      params: Object.fromEntries(searchParams.entries()),
      count: rows.length,
      rows,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });

    downloadBlob(blob, `${exportFilenameBase}.json`);
    setExportOpen(false);
  };

  const doExportCsv = () => {
    const rows = buildExportRows();
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
    const lines = rows.map((r) =>
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

  const advancedCount = useMemo(() => {
    let n = 0;
    if (typeof urlHopsMin === "number") n += 1;
    if (typeof urlHopsMax === "number") n += 1;
    if (urlFrom.trim()) n += 1;
    if (urlTo.trim()) n += 1;
    if (urlVia.trim()) n += 1;
    if (onlyUnknownEndpoints) n += 1;
    if (requireVia) n += 1;
    return n;
  }, [
    urlHopsMin,
    urlHopsMax,
    urlFrom,
    urlTo,
    urlVia,
    onlyUnknownEndpoints,
    requireVia,
  ]);

  // ── Loading skeleton ──
  const isFirstLoad = !effectiveChat;

  if (isFirstLoad) {
    return (
      <div className="w-full h-dvh overflow-hidden flex flex-col">
        <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
          <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Chat
                </h1>
                <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span className="animate-pulse">Loading chat data…</span>
                </div>
              </div>
            </div>

            {/* Skeleton channel pills */}
            <div className="mt-3 flex gap-2">
              {[120, 140].map((w, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-full border border-gray-300/40 dark:border-gray-700/40 bg-gray-200/50 dark:bg-gray-800/50"
                  style={{ width: w, height: 34 }}
                />
              ))}
            </div>

            {/* Skeleton search bar */}
            <div className="mt-3">
              <div className="animate-pulse rounded-md border border-gray-300/40 dark:border-gray-700/40 bg-gray-200/30 dark:bg-gray-800/30 h-9.5 w-full" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="mx-auto max-w-400 px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full min-h-0">
              {/* Skeleton message list */}
              <div className="lg:col-span-2 min-h-0 flex flex-col">
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col flex-1">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                    <div className="animate-pulse h-4 w-48 rounded-sm bg-gray-200/60 dark:bg-gray-800/60" />
                  </div>
                  <div className="flex-1 p-4 space-y-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="animate-pulse space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="h-5 w-12 rounded-full bg-gray-200/60 dark:bg-gray-800/60" />
                          <div className="h-3 w-6 rounded-sm bg-gray-200/40 dark:bg-gray-800/40" />
                          <div className="h-5 w-10 rounded-full bg-gray-200/60 dark:bg-gray-800/60" />
                          <div className="h-5 w-16 rounded-full bg-gray-200/50 dark:bg-gray-800/50" />
                          <div className="ml-auto h-3 w-28 rounded-sm bg-gray-200/40 dark:bg-gray-800/40" />
                        </div>
                        <div className="h-4 rounded-sm bg-gray-200/40 dark:bg-gray-800/40" style={{ width: `${55 + (i * 7) % 35}%` }} />
                        <div className="h-3 w-16 rounded-sm bg-gray-200/30 dark:bg-gray-800/30" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Skeleton sidebar */}
              <div className="hidden lg:flex lg:col-span-1 flex-col gap-4">
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
                  <div className="animate-pulse h-4 w-24 rounded-sm bg-gray-200/60 dark:bg-gray-800/60" />
                  <div className="animate-pulse h-9 w-full rounded-md border border-gray-300/40 dark:border-gray-700/40 bg-gray-200/30 dark:bg-gray-800/30" />
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
                  <div className="animate-pulse h-4 w-32 rounded-sm bg-gray-200/60 dark:bg-gray-800/60" />
                  <div className="animate-pulse h-3 w-48 rounded-sm bg-gray-200/40 dark:bg-gray-800/40" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-dvh overflow-hidden flex flex-col">
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

      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Chat
              </h1>

              {/* Desktop meta row */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching ? "animate-pulse" : ""}>
                  {isFetching ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline disabled:opacity-60 disabled:cursor-wait"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  refresh
                </button>

                <LivePill
                  mode={
                    liveUiMode === "live"
                      ? "live"
                      : liveUiMode === "off"
                        ? "off"
                        : "paused"
                  }
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />

                <span className="opacity-60">•</span>

                <HeardBy />
              </div>

              {/* Mobile meta row (compact) */}
              <div className="mt-1 flex sm:hidden flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching ? "animate-pulse" : ""}>
                  {isFetching ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline disabled:opacity-60 disabled:cursor-wait"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  refresh
                </button>

                <LivePill
                  mode={
                    liveUiMode === "live"
                      ? "live"
                      : liveUiMode === "off"
                        ? "off"
                        : "paused"
                  }
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />
              </div>
            </div>

            <div className="hidden lg:flex items-center gap-2">
              <ExportMenu
                open={exportOpen}
                setOpen={setExportOpen}
                exportRowsCount={messages.length}
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
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
            {views.map((v) => {
              const active = v.key === selectedView?.key;
              const chObj: any = (effectiveChat?.channels as any)?.[v.channelId];
              const count = chObj?.totalMessages ?? 0;

              return (
                <button
                  key={`preset-${v.key}`}
                  type="button"
                  className={[
                    "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                    active
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
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

          {/* Toolbar row: mobile keeps ONLY search; desktop keeps full controls */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-65">
              <ChatSearchInput
                urlQ={urlQ}
                setParam={setParam}
                inputRef={searchInputRef}
              />
            </div>

            <div className="hidden lg:flex flex-wrap gap-2 items-center">
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
                <span
                  className={[
                    "ml-2 rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60",
                    hasFilters ? "visible" : "invisible",
                  ].join(" ")}
                  aria-hidden={!hasFilters}
                >
                  {activeFilterCount}
                </span>
              </button>

              <div className="flex items-center gap-2">
                <span className="min-w-22 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  {hasFilters
                    ? `${activeFilterCount} filter${
                        activeFilterCount > 1 ? "s" : ""
                      }`
                    : "no filters"}
                </span>

                <button
                  type="button"
                  className={[
                    "text-xs underline hover:no-underline text-gray-600 dark:text-gray-300",
                    hasFilters ? "visible" : "invisible pointer-events-none",
                  ].join(" ")}
                  onClick={clearFilters}
                  title="Clear all filters"
                  tabIndex={hasFilters ? 0 : -1}
                  aria-disabled={!hasFilters}
                >
                  clear
                </button>
              </div>
            </div>
          </div>

          {/* Status chips: desktop only, always rendered (mobile uses Controls Badge) */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-7.5">
            <StatusChip
              label={`Range: ${urlRange}`}
              active={urlRange !== "24h"}
              title="Click to reset range to 24h"
              onClick={() => setParam("r", undefined, "push")}
            />

            <StatusChip
              label={`Type: ${
                urlType === "all" ? "All" : urlType === "bc" ? "BC" : "DM"
              }`}
              active={urlType !== "all"}
              title="Click to reset type to All"
              onClick={() => setParam("t", undefined, "push")}
            />

            <StatusChip
              label={`Sort: ${urlSort === "desc" ? "newest" : "oldest"}`}
              active={urlSort !== "desc"}
              title="Click to reset sort to newest"
              onClick={() => setParam("s", undefined, "push")}
            />

            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")}
            />

            <StatusChip
              label={`Advanced: ${advancedCount > 0 ? advancedCount : "none"}`}
              active={advancedCount > 0}
              title={
                advancedCount > 0
                  ? "Click to open advanced filters"
                  : "No advanced filters"
              }
              onClick={() => setFiltersOpen(true)}
            />

            <StatusChip
              label={`Focus: ${
                urlNode.trim()
                  ? (nodes as any)?.[urlNode]?.shortname ?? urlNode.trim()
                  : "none"
              }`}
              active={urlNode.trim().length > 0}
              title="Click to clear focus"
              onClick={() => clearFocus()}
            />

            <StatusChip
              label={urlMsg ? `Selected: ${urlMsg}` : "Selected: none"}
              active={!!urlMsg}
              title="Click to clear selection"
              onClick={() => setParam("msg", undefined, "push")}
            />
          </div>

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

              <div className="flex items-center gap-2 sm:ml-auto">
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
        <div className="mx-auto max-w-400 px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
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

            {/* Desktop sidebar only */}
            <div ref={sidebarRef} className="hidden lg:flex lg:col-span-1 flex-col gap-4 min-h-0 h-full">
              <FocusPanel
                urlNode={urlNode}
                nodes={nodes}
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

      {/* Mobile bottom nav */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="mb-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm shadow-xs overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-gray-200 dark:divide-gray-800">
              <button
                type="button"
                className={[
                  "py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  mobileSheet === "controls" ? "bg-gray-100/60 dark:bg-gray-800/40" : "",
                ].join(" ")}
                onClick={() =>
                  setMobileSheet((s) => (s === "controls" ? null : "controls"))
                }
              >
                Controls
                {hasFilters ? (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>

              <button
                type="button"
                className={[
                  "py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  mobileSheet === "focus" ? "bg-gray-100/60 dark:bg-gray-800/40" : "",
                ].join(" ")}
                onClick={() =>
                  setMobileSheet((s) => (s === "focus" ? null : "focus"))
                }
              >
                Focus
                {urlNode.trim() ? (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-indigo-600 text-white">
                    on
                  </span>
                ) : null}
              </button>

              <button
                type="button"
                className={[
                  "py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  mobileSheet === "details" ? "bg-gray-100/60 dark:bg-gray-800/40" : "",
                ].join(" ")}
                onClick={() =>
                  setMobileSheet((s) => (s === "details" ? null : "details"))
                }
              >
                Details
                {urlMsg ? (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200">
                    1
                  </span>
                ) : null}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile sheets */}
      <MobileSheet
        open={mobileSheet === "controls"}
        title="Controls"
        onClose={() => setMobileSheet(null)}
      >
        <div className="space-y-4">
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Quick controls for range/type/sort/focus + access to advanced filters.
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Range
            </div>
            <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
              {(["1h", "24h", "7d", "all"] as RangeKey[]).map((rk) => (
                <button
                  key={`m-range-${rk}`}
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
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Message type
              </div>
              <select
                value={urlType}
                onChange={(e) => setParam("t", e.target.value, "push")}
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value="all">All</option>
                <option value="bc">Broadcast</option>
                <option value="dm">Direct</option>
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sort
              </div>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("s", urlSort === "desc" ? "asc" : "desc", "push")
                }
              >
                {urlSort === "desc" ? "Newest → Oldest" : "Oldest → Newest"}
              </button>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Focus mode
              </div>
              <select
                value={urlFocus}
                onChange={(e) => setParam("focus", e.target.value, "push")}
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value="endpoints">Endpoints only</option>
                <option value="any">Include via</option>
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Focus direction
              </div>
              <div
                className={[
                  "inline-flex w-full rounded-md border overflow-hidden",
                  urlNode.trim()
                    ? "border-gray-300/60 dark:border-gray-700"
                    : "border-gray-300/30 dark:border-gray-700/30 opacity-60",
                ].join(" ")}
              >
                {(["both", "in", "out"] as DirKey[]).map((d) => (
                  <button
                    key={`m-dir-${d}`}
                    type="button"
                    disabled={!urlNode.trim()}
                    className={[
                      "flex-1 px-3 py-2 text-sm transition",
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

              {!urlNode.trim() ? (
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Pick a focused node to enable direction controls.
                </div>
              ) : null}
            </div>
          </div>

          {activeChips.length > 0 ? (
            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Active filters
              </div>
              <div className="flex flex-wrap gap-2">
                {activeChips.map((c, i) => (
                  <button
                    key={`m-chip-${i}`}
                    type="button"
                    onClick={c.clear}
                    className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                    title="Tap to clear"
                  >
                    {c.label}
                    <span className="opacity-70">×</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => {
                setMobileSheet(null);
                setFiltersOpen(true);
              }}
            >
              Advanced filters…
            </button>

            {hasFilters ? (
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-red-300/70 dark:border-red-800/70 text-red-700 dark:text-red-200 hover:bg-red-50/60 dark:hover:bg-red-900/20 transition"
                onClick={() => {
                  clearFilters();
                  setMobileSheet(null);
                }}
              >
                Clear all filters
              </button>
            ) : null}

            {urlNode.trim() ? (
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-indigo-300/70 dark:border-indigo-800/70 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-50/60 dark:hover:bg-indigo-900/20 transition"
                onClick={() => {
                  clearFocus();
                  setMobileSheet(null);
                }}
              >
                Clear focus
              </button>
            ) : null}
          </div>

          {/* Actions (mobile replacement for header Export/Copy + avoids popover off-screen) */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="grid grid-cols-1 gap-2">
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
                onClick={copyLink}
              >
                {copied ? "Copied!" : "Copy link"}
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => {
                  doExportCsv();
                  setMobileSheet(null);
                }}
              >
                Export CSV ({messages.length})
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => {
                  doExportJson();
                  setMobileSheet(null);
                }}
              >
                Export JSON ({messages.length})
              </button>
            </div>
          </div>
        </div>
      </MobileSheet>

      <MobileSheet
        open={mobileSheet === "focus"}
        title="Node focus"
        onClose={() => setMobileSheet(null)}
      >
        <FocusPanel
          urlNode={urlNode}
          nodes={nodes}
          frequentNodes={frequentNodes}
          applyFocus={applyFocus}
          clearFocus={clearFocus}
          focusStats={focusStats}
        />
      </MobileSheet>

      {/* Mobile details sheet */}
      <MobileSheet
        open={mobileSheet === "details"}
        title="Message details"
        onClose={() => {
          setParam("msg", undefined, "push");
          setMobileSheet(null);
        }}
      >
        <DetailsPanel
          urlMsg={urlMsg}
          selectedMessage={selectedMessage}
          urlQ={urlQ}
          nodes={nodes}
          applyFocus={applyFocus}
          setParam={setParam}
          clearFilters={clearFilters}
          closeDetails={() => {
            setParam("msg", undefined, "push");
            setMobileSheet(null);
          }}
        />
      </MobileSheet>
    </div>
  );
};
