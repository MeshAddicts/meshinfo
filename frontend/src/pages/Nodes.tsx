import {
  ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { HeardBy } from "../components/HeardBy";
import { useNodesSearchParams } from "../hooks/useNodesSearchParams";
import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import { csvEscape, downloadBlob } from "./chat/chatUtils";
import { ExportMenu } from "./chat/ExportMenu";
import { NodeDetailsPanel } from "./nodes/NodeDetailsPanel";
import { type NodeListItem,NodesList } from "./nodes/NodesList";
import { NodesOverviewPanel } from "./nodes/NodesOverviewPanel";
import {
  cleanNodeId,
  getLatLon,
  getTelemetrySnapshot,
  hardwareLabel,
  isNodeOnline,
  RangeKey,
  roleLabel,
  safeLastSeenMs,
} from "./nodes/nodesUtils";

type MobileSheetKey = "controls" | "details";

function MobileSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="rounded-t-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={onClose}
              >
                Close
              </button>
            </div>

            <div className="max-h-[82dvh] overflow-y-auto">
              <div className="p-4">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard && (window as any).isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const Nodes = () => {
  // Live toggle (auto-refresh / polling)
  const [liveEnabled, setLiveEnabled] = useState(true);

  const {
    data: nodesRaw,
    fulfilledTimeStamp: dataUpdatedAt,
    isFetching,
    refetch,
  } = useGetNodesQuery(
    undefined,
    {
      pollingInterval: liveEnabled ? 5000 : 0,
      skipPollingIfUnfocused: true,
      refetchOnReconnect: liveEnabled,
      refetchOnFocus: liveEnabled,
    },
  );

  const { data: config } = useGetConfigQuery();

  // URL state (shareable)
  const {
    searchParams,
    urlQ,
    urlRange,
    urlStatus,
    urlBy,
    urlDir,
    urlCh,
    urlNode,
    setParam,
    setParams,
  } = useNodesSearchParams();

  // local UI state
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);

  // keep search input in sync with back/forward
  useEffect(() => {
    setQInput(urlQ);
     
  }, [urlQ]);

  // update URL q (replace, don’t spam history)
  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred, "replace"); // hook will delete q when empty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  const nodes = useMemo(() => (nodesRaw ?? {}) as any, [nodesRaw]);

  // server node id (for distance / “DX”)
  const serverNodeId = useMemo(() => {
    const cfgId = (config as any)?.server?.node_id;
    if (typeof cfgId === "string" && cfgId.trim()) return cleanNodeId(cfgId);
    // fallback to your previous hard-coded key (keeps old behavior if config missing)
    return "4355f528";
  }, [config]);

  const serverNode = useMemo(() => {
    const direct = nodes?.[serverNodeId];
    if (direct) return direct;
    const bang = nodes?.[`!${serverNodeId}`];
    return bang ?? null;
  }, [nodes, serverNodeId]);

  // Channel views from config
  const channelViews = useMemo(() => {
    const vraw = (config as any)?.broker?.channels?.views;
    if (!Array.isArray(vraw) || vraw.length === 0) return [];
    const out: { key: string; label: string; channelId: string }[] = [];
    for (const v of vraw) {
      const chans = Array.isArray(v?.channels) ? v.channels.map(String) : [];
      if (chans.length !== 1) continue;
      const channelId = chans[0];
      const meta = (config as any)?.broker?.channels?.meta?.[channelId] ?? {};
      const label = String(v?.label ?? meta?.label ?? `Channel ${channelId}`);
      out.push({ key: channelId, label, channelId });
    }
    return out;
  }, [config]);

  // Resolve urlCh to a channel ID
  const selectedChannelId = useMemo(() => {
    if (!urlCh) return null;
    for (const v of channelViews) {
      if (urlCh === v.channelId || urlCh.toLowerCase() === v.label.toLowerCase()) return v.channelId;
    }
    return null;
  }, [urlCh, channelViews]);

  // Range threshold clock: update infrequently (range cutoffs don't need 1s precision)
  const [rangeNowMs, setRangeNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (urlRange === "all") return;

    const t = window.setInterval(() => setRangeNowMs(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, [urlRange]);

  // Range threshold (ms)
  const rangeThresholdMs = useMemo(() => {
    switch (urlRange) {
      case "1h":
        return rangeNowMs - 3600 * 1000;
      case "24h":
        return rangeNowMs - 86400 * 1000;
      case "7d":
        return rangeNowMs - 604800 * 1000;
      case "all":
      default:
        return undefined;
    }
  }, [rangeNowMs, urlRange]);

  // Build list items (computed fields)
  const allItems: NodeListItem[] = useMemo(() => {
    const out: NodeListItem[] = [];
    for (const [, n] of Object.entries(nodes as any)) {
      const rawId = String((n as any)?.id ?? "");
      const id = cleanNodeId(rawId);
      if (!id) continue;

      const online = isNodeOnline(n as any);
      const lastSeenMs = safeLastSeenMs((n as any)?.last_seen);

      const pos = getLatLon(n as any);
      const telem = getTelemetrySnapshot(n as any);

      // DX distance (km) if both have coords
      let dxKm: number | null = null;
      if (serverNode && pos) {
        const sPos = getLatLon(serverNode as any);
        if (sPos) {
          // cheap haversine (no dependency)
          const [lon1, lat1] = sPos;
          const [lon2, lat2] = pos;
          const R = 6371;
          const toRad = (d: number) => (d * Math.PI) / 180;
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) *
              Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          dxKm = Number.isFinite(R * c) ? R * c : null;
        }
      }

      out.push({
        id,
        rawId,
        node: n as any,
        online,
        lastSeenMs,
        hasPosition: !!pos,
        dxKm,
        batteryPct: telem.batteryPct,
        voltage: telem.voltage,
        airTx: telem.airTx,
        chanUtil: telem.chanUtil,
        role: (n as any)?.role ?? null,
        hardware: (n as any)?.hardware ?? null,
      });
    }
    return out;
  }, [nodes, serverNode]);

  // Filter (range/status/search)
  const filteredItems = useMemo(() => {
    let items = [...allItems];

    if (typeof rangeThresholdMs === "number") {
      items = items.filter(
        (x) => x.lastSeenMs != null && x.lastSeenMs >= rangeThresholdMs,
      );
    }

    if (urlStatus === "online") items = items.filter((x) => x.online);
    if (urlStatus === "offline") items = items.filter((x) => !x.online);

    if (selectedChannelId) {
      items = items.filter((x) => (x.node as any)?.last_channel === selectedChannelId);
    }

    const q = (urlQ ?? "").trim().toLowerCase();
    if (q) {
      items = items.filter((x) => {
        const n: any = x.node;
        const s =
          `${x.id} ${String(n?.shortname ?? "")} ${String(
            n?.longname ?? "",
          )}`.toLowerCase();
        return s.includes(q);
      });
    }

    // Sort
    const dirMul = urlDir === "asc" ? 1 : -1;

    items.sort((a, b) => {
      if (urlBy === "seen") {
        const av = a.lastSeenMs ?? -1;
        const bv = b.lastSeenMs ?? -1;
        return (av - bv) * dirMul;
      }
      if (urlBy === "name") {
        const an = String((a.node as any)?.shortname ?? "").toLowerCase();
        const bn = String((b.node as any)?.shortname ?? "").toLowerCase();
        return an.localeCompare(bn) * dirMul;
      }
      if (urlBy === "dx") {
        const av = a.dxKm ?? Number.POSITIVE_INFINITY;
        const bv = b.dxKm ?? Number.POSITIVE_INFINITY;
        return (av - bv) * dirMul;
      }
      if (urlBy === "alt") {
        const av = Number((a.node as any)?.position?.altitude ?? -1);
        const bv = Number((b.node as any)?.position?.altitude ?? -1);
        return (av - bv) * dirMul;
      }
      if (urlBy === "batt") {
        const av = a.batteryPct ?? -1;
        const bv = b.batteryPct ?? -1;
        return (av - bv) * dirMul;
      }
      return 0;
    });

    return items;
  }, [allItems, rangeThresholdMs, urlStatus, selectedChannelId, urlQ, urlBy, urlDir]);

  // Selection (urlNode)
  const selectedId = useMemo(() => cleanNodeId(urlNode ?? ""), [urlNode]);
  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    return (
      (nodes as any)?.[selectedId] ?? (nodes as any)?.[`!${selectedId}`] ?? null
    );
  }, [nodes, selectedId]);

  // Mobile: bottom sheets
  const [mobileSheet, setMobileSheet] = useState<MobileSheetKey | null>(null);
  const [isLgUp, setIsLgUp] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsLgUp(m.matches);

    onChange();

    if (typeof m.addEventListener === "function")
      m.addEventListener("change", onChange);
    else (m as any).addListener(onChange);

    return () => {
      if (typeof m.removeEventListener === "function")
        m.removeEventListener("change", onChange);
      else (m as any).removeListener(onChange);
    };
  }, []);

  // Auto-open Details on mobile when selection changes
  const prevSelRef = useRef<string>("");
  useEffect(() => {
    if (isLgUp) return;
    const prev = prevSelRef.current;
    prevSelRef.current = selectedId;

    if (selectedId && selectedId !== prev) setMobileSheet("details");
  }, [selectedId, isLgUp]);

  // Scroll-to + flash: only auto-scroll for deep links, not interactive clicks
  const [scrollToId, setScrollToId] = useState<string>("");
  const [flashNodeId, setFlashNodeId] = useState<string>("");
  const isInitialLoadRef = useRef(true);

  // On mount: if there's a selectedId from the URL, mark it for scroll
  useEffect(() => {
    if (isInitialLoadRef.current && selectedId) {
      setScrollToId(selectedId);
      setFlashNodeId(selectedId);
    }
    isInitialLoadRef.current = false;
  }, [selectedId]);

  // Clear scrollToId when selection is cleared (so freeze can release)
  useEffect(() => {
    if (!selectedId) setScrollToId("");
  }, [selectedId]);

  // Separate effect to clear flash — not affected by StrictMode double-invoke
  useEffect(() => {
    if (!flashNodeId) return;
    const t = setTimeout(() => setFlashNodeId(""), 2000);
    return () => clearTimeout(t);
  }, [flashNodeId]);

  // Track whether list is scrolled to top — pause polling when not
  const [listAtTop, setListAtTop] = useState(true);
  const onAtTopChange = useCallback((atTop: boolean) => {
    setListAtTop(atTop);
  }, []);

  // Export menu
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // click-outside for export menu (desktop)
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

  // Copy link
  const [copied, setCopied] = useState(false);
  const copyLink = useCallback(async () => {
    const url = window.location.href;
    const ok = await copyTextToClipboard(url);

    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      return;
    }

    window.prompt("Copy link:", url);
  }, []);

  // Manual refresh
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const doManualRefresh = useCallback(() => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    Promise.resolve(refetch()).finally(() => {
      window.setTimeout(() => setManualRefreshing(false), 250);
    });
  }, [refetch, manualRefreshing]);

  // Header live pill
  const liveUiMode = useMemo(() => {
    if (!liveEnabled) return "off" as const;
    if (selectedId) return "paused" as const;
    if (!listAtTop) return "paused" as const;
    return "live" as const;
  }, [liveEnabled, selectedId, listAtTop]);

  const livePillText = useMemo(() => {
    if (liveUiMode === "live") return "Live";
    if (liveUiMode === "paused") return "Paused";
    return "Live off";
  }, [liveUiMode]);

  const livePillTitle = useMemo(() => {
    if (!liveEnabled)
      return "Live mode is off. Auto-refresh is disabled (no polling / focus / reconnect). Click to enable.";
    if (selectedId)
      return "List paused while a node is selected. Clear selection to resume.";
    if (!listAtTop)
      return "Auto-refresh paused while scrolled. Scroll to top or click to resume.";
    return "Live mode is on. Auto-refresh polls every 5 seconds (paused when tab is unfocused). Click to disable.";
  }, [liveEnabled, selectedId, listAtTop]);

  // Export rows
  const exportRows = useMemo(() => {
    return filteredItems.map((x) => {
      const n: any = x.node;
      const telem = getTelemetrySnapshot(n);
      const ll = getLatLon(n);

      return {
        id: x.id,
        shortname: String(n?.shortname ?? ""),
        longname: String(n?.longname ?? ""),
        online: x.online ? "true" : "false",
        role: roleLabel(n?.role),
        hardware: hardwareLabel(n?.hardware),
        last_channel: String(n?.last_channel ?? ""),
        last_seen: n?.last_seen ? new Date(n.last_seen).toISOString() : "",
        altitude_m: n?.position?.altitude ?? "",
        latitude: ll ? ll[1] : "",
        longitude: ll ? ll[0] : "",
        neighbors_count: n?.neighborinfo?.neighbors_count ?? "",
        battery_pct: telem.batteryPct ?? "",
        voltage_v: telem.voltage ?? "",
        air_util_tx_pct: telem.airTx ?? "",
        chan_util_pct: telem.chanUtil ?? "",
        dx_km: x.dxKm != null ? x.dxKm.toFixed(2) : "",
      };
    });
  }, [filteredItems]);

  const exportFilenameBase = useMemo(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `nodes_${urlRange}_${urlStatus}_${ts}`;
  }, [urlRange, urlStatus]);

  const doExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
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
    const cols = Object.keys(exportRows[0] ?? { id: "" });
    const header = cols.join(",");
    const lines = exportRows.map((r: any) =>
      cols.map((c) => csvEscape(r[c])).join(","),
    );
    const csv = "\ufeff" + [header, ...lines].join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${exportFilenameBase}.csv`);
    setExportOpen(false);
  };

  // Active filter count
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (urlRange !== "all") n += 1;
    if (urlStatus !== "all") n += 1;
    if (selectedChannelId) n += 1;
    if ((urlQ ?? "").trim()) n += 1;
    if (urlBy !== "seen") n += 1;
    if (urlDir !== "desc") n += 1;
    return n;
  }, [urlRange, urlStatus, selectedChannelId, urlQ, urlBy, urlDir]);

  const hasFilters = activeFilterCount > 0;

  const clearFilters = useCallback(() => {
    // These are defaults — hook will delete them from URL.
    setParams(
      [
        { key: "r", value: "all" },
        { key: "st", value: "all" },
        { key: "ch", value: undefined },
        { key: "q", value: undefined },
        { key: "by", value: "seen" },
        { key: "dir", value: "desc" },
      ],
      "push",
    );
  }, [setParams]);

  const onSelect = useCallback(
    (id: string) => {
      setParams([{ key: "node", value: id }], "push");
    },
    [setParams],
  );

  const clearSelection = useCallback(() => {
    setParam("node", undefined, "push");
  }, [setParam]);

  // Click-outside: clear selection when clicking in the page background
  const listContainerRef = useRef<HTMLDivElement>(null);
  const detailsPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedId) return;
    if (!isLgUp) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (listContainerRef.current?.contains(t)) return;
      if (detailsPanelRef.current?.contains(t)) return;
      // Don't clear if clicking on header/toolbar controls
      const el = e.target as HTMLElement;
      if (el.closest?.("[data-no-clear-selection]")) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [selectedId, clearSelection, isLgUp]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTypingContext =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as any)?.isContentEditable;

      if (e.key === "Escape") {
        if (mobileSheet) {
          setMobileSheet(null);
          return;
        }
        if (selectedId) {
          clearSelection();
          return;
        }
        if (hasFilters) clearFilters();
      }

      if (!isTypingContext && e.key === "/") {
        e.preventDefault();
        const el = document.getElementById(
          "nodes-search",
        ) as HTMLInputElement | null;
        el?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSheet, selectedId, clearSelection, hasFilters, clearFilters]);

  if (!nodesRaw) {
    return <div className="p-4">Loading…</div>;
  }

  return (
    <div className="w-full h-dvh overflow-hidden flex flex-col">
      {/* Sticky header */}
      <div data-no-clear-selection className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Nodes
              </h1>

              {/* Desktop meta row (Chat-style) */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  Updated:{" "}
                  <span className="font-medium tabular-nums">
                    {dataUpdatedAt && dataUpdatedAt > 0
                      ? new Date(dataUpdatedAt).toLocaleString()
                      : new Date().toLocaleString()}
                  </span>
                </span>

                <span className="opacity-60">•</span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                  aria-busy={manualRefreshing || isFetching}
                  title={
                    manualRefreshing
                      ? "Refreshing…"
                      : isFetching
                        ? "Refreshing…"
                        : "Refresh now"
                  }
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
                        ? "bg-amber-500 text-white border-amber-500"
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

              {/* Mobile meta row (compact, Chat-style) */}
              <div className="mt-1 flex sm:hidden flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="font-medium tabular-nums">
                  {dataUpdatedAt && dataUpdatedAt > 0
                    ? new Date(dataUpdatedAt).toLocaleString()
                    : new Date().toLocaleString()}
                </span>

                <span className="opacity-60">•</span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                  aria-busy={manualRefreshing || isFetching}
                  title={
                    manualRefreshing
                      ? "Refreshing…"
                      : isFetching
                        ? "Refreshing…"
                        : "Refresh now"
                  }
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
                        ? "bg-amber-500 text-white border-amber-500"
                        : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                  ].join(" ")}
                  onClick={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                >
                  {livePillText}
                </button>
              </div>
            </div>

            <div className="hidden lg:flex items-center gap-2">
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
                title="Copy a shareable link (includes filters + selection)"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Channel preset pills */}
          {channelViews.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
              <button
                type="button"
                className={[
                  "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                  !selectedChannelId
                    ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                    : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                ].join(" ")}
                onClick={() => setParam("ch", undefined, "push")}
              >
                All
                <span
                  className={[
                    "ml-2 rounded-full px-2 py-0.5 text-xs",
                    !selectedChannelId
                      ? "bg-white/20 text-white"
                      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200",
                  ].join(" ")}
                >
                  {allItems.length}
                </span>
              </button>
              {channelViews.map((v) => {
                const active = selectedChannelId === v.channelId;
                const count = allItems.filter((x) => (x.node as any)?.last_channel === v.channelId).length;
                return (
                  <button
                    key={`ch-${v.key}`}
                    type="button"
                    className={[
                      "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                      active
                        ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                        : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => setParam("ch", v.channelId, "push")}
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
          )}

          {/* Toolbar */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-65">
              <input
                id="nodes-search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search nodes… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/60"
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
                    onClick={() => setParam("r", rk, "push")} // rk==="all" deletes param
                  >
                    {rk}
                  </button>
                ))}
              </div>

              <select
                value={urlStatus}
                onChange={(e) => setParam("st", e.target.value, "push")} // "all" deletes
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Status"
              >
                <option value="all">All</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>

              <select
                value={urlBy}
                onChange={(e) => setParam("by", e.target.value, "push")} // "seen" deletes
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Sort by"
              >
                <option value="seen">Last seen</option>
                <option value="name">Shortname</option>
                <option value="dx">DX (km)</option>
                <option value="alt">Altitude</option>
                <option value="batt">Battery</option>
              </select>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("dir", urlDir === "desc" ? "asc" : "desc", "push") // desc deletes
                }
                title="Toggle sort direction"
              >
                {urlDir === "desc" ? "Desc" : "Asc"}
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

          {/* Status chips: desktop only */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-7.5">
            <StatusChip
              label={`Range: ${urlRange}`}
              active={urlRange !== "all"}
              title="Click to reset range to all"
              onClick={() => setParam("r", "all", "push")} // deletes
            />
            <StatusChip
              label={`Status: ${urlStatus}`}
              active={urlStatus !== "all"}
              title="Click to reset status to All"
              onClick={() => setParam("st", "all", "push")} // deletes
            />
            {channelViews.length > 1 && (
              <StatusChip
                label={selectedChannelId ? `Channel: ${channelViews.find((v) => v.channelId === selectedChannelId)?.label ?? selectedChannelId}` : "Channel: all"}
                active={!!selectedChannelId}
                title="Click to show all channels"
                onClick={() => setParam("ch", undefined, "push")}
              />
            )}
            <StatusChip
              label={`Sort: ${urlBy}/${urlDir}`}
              active={urlBy !== "seen" || urlDir !== "desc"}
              title="Click to reset sort"
              onClick={() =>
                setParams(
                  [
                    { key: "by", value: "seen" }, // deletes
                    { key: "dir", value: "desc" }, // deletes
                  ],
                  "push",
                )
              }
            />
            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")} // deletes
            />
            <StatusChip
              label={selectedId ? `Selected: ${selectedId}` : "Selected: none"}
              active={!!selectedId}
              title="Click to clear selection"
              onClick={() => clearSelection()}
            />
          </div>
        </div>
      </div>

      {/* Main body */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* Left: list */}
            <div ref={listContainerRef} className="lg:col-span-2 min-h-0 flex flex-col h-full">
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <NodesList
                  items={filteredItems}
                  selectedId={selectedId}
                  flashId={flashNodeId}
                  scrollToId={scrollToId}
                  liveEnabled={liveEnabled}
                  onSelect={onSelect}
                  onClearSelection={clearSelection}
                  onAtTopChange={onAtTopChange}
                  totalSeen={Object.keys(nodes as any).length}
                />
              </div>
            </div>

            {/* Right: overview or details (desktop only) */}
            <div ref={detailsPanelRef} className="hidden lg:flex lg:col-span-1 flex-col min-h-0 h-full overflow-y-auto">
              <div className="min-h-0">
                {selectedNode ? (
                  <NodeDetailsPanel
                    node={selectedNode as any}
                    nodes={nodes as any}
                    serverNode={serverNode as any}
                    onClearSelection={clearSelection}
                    onSelectNode={onSelect}
                  />
                ) : (
                  <NodesOverviewPanel
                    items={filteredItems}
                    range={urlRange}
                    status={urlStatus}
                    serverNodeId={serverNodeId}
                    nodesTotal={Object.keys(nodes as any).length}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="mb-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm shadow-xs overflow-hidden">
            <div className="grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800">
              <button
                type="button"
                className={[
                  "py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  mobileSheet === "controls"
                    ? "bg-gray-100/60 dark:bg-gray-800/40"
                    : "",
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
                  mobileSheet === "details"
                    ? "bg-gray-100/60 dark:bg-gray-800/40"
                    : "",
                ].join(" ")}
                onClick={() =>
                  setMobileSheet((s) => (s === "details" ? null : "details"))
                }
              >
                Details
                {selectedId ? (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-indigo-600 text-white">
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
            Quick controls for range/status/sort + share/export.
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
                Status
              </div>
              <select
                value={urlStatus}
                onChange={(e) => setParam("st", e.target.value, "push")}
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value="all">All</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sort by
              </div>
              <select
                value={urlBy}
                onChange={(e) => setParam("by", e.target.value, "push")}
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value="seen">Last seen</option>
                <option value="name">Shortname</option>
                <option value="dx">DX (km)</option>
                <option value="alt">Altitude</option>
                <option value="batt">Battery</option>
              </select>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sort direction
              </div>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("dir", urlDir === "desc" ? "asc" : "desc", "push")
                }
              >
                {urlDir === "desc" ? "Descending" : "Ascending"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => doManualRefresh()}
            >
              Refresh now
            </button>

            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => setLiveEnabled((v) => !v)}
              title={livePillTitle}
            >
              {liveEnabled ? "Live: on" : "Live: off"}
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
              onClick={() => doExportCsv()}
            >
              Export CSV ({exportRows.length})
            </button>

            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => doExportJson()}
            >
              Export JSON ({exportRows.length})
            </button>

            {hasFilters ? (
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-red-300/70 dark:border-red-800/70 text-red-700 dark:text-red-200 hover:bg-red-50/60 dark:hover:bg-red-900/20 transition"
                onClick={() => clearFilters()}
              >
                Clear filters
              </button>
            ) : null}
          </div>

          <div className="text-xs text-gray-600 dark:text-gray-400">
            Updated:{" "}
            <span className="font-medium tabular-nums">
              {dataUpdatedAt && dataUpdatedAt > 0
                ? new Date(dataUpdatedAt).toLocaleString()
                : new Date().toLocaleString()}
            </span>
          </div>
        </div>
      </MobileSheet>

      <MobileSheet
        open={mobileSheet === "details"}
        title={selectedNode ? "Node details" : "Overview"}
        onClose={() => setMobileSheet(null)}
      >
        {selectedNode ? (
          <NodeDetailsPanel
            node={selectedNode as any}
            nodes={nodes as any}
            serverNode={serverNode as any}
            onClearSelection={() => {
              clearSelection();
              setMobileSheet(null);
            }}
            onSelectNode={onSelect}
          />
        ) : (
          <NodesOverviewPanel
            items={filteredItems}
            range={urlRange}
            status={urlStatus}
            serverNodeId={serverNodeId}
            nodesTotal={Object.keys(nodes as any).length}
          />
        )}
      </MobileSheet>
    </div>
  );
};
