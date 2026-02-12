import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";

import { HeardBy } from "../components/HeardBy";
import { useGetNodesQuery, useGetTelemetryQuery } from "../slices/apiSlice";

import { ExportMenu } from "./chat/ExportMenu";

import {
  type NodesById,
  type TelemetryEvent,
  type TelemetryListItem,
  type TelemetryNodeSummary,
  RANGE_MS,
  clampSort,
  coerceTelemetryEvent,
  csvEscape,
  downloadBlob,
  getNodeLabel,
  safeTsMs,
  toNumberLoose,
} from "./telemetry/telemetryUtils";

import { TelemetryList } from "./telemetry/TelemetryList";
import { TelemetryDetailsPanel } from "./telemetry/TelemetryDetailsPanel";

type RangeKey = "all" | "24h" | "7d" | "30d";
type SortKey =
  | "last_desc"
  | "name_asc"
  | "samples_desc"
  | "battery_asc"
  | "voltage_asc"
  | "chanutil_desc"
  | "airutil_desc"
  | "temp_desc";

function setParamValue(
  params: URLSearchParams,
  key: string,
  value?: string | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!value) next.delete(key);
  else next.set(key, value);
  return next;
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

export const Telemetry = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const setParam = useCallback(
    (key: string, value?: string, mode: "push" | "replace" = "push") => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value == null || value === "") next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: mode === "replace" },
      );
    },
    [setSearchParams],
  );

  // Track lg breakpoint (1024px) (for ExportMenu click-outside)
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
    if (typeof m.addEventListener === "function")
      m.addEventListener("change", onChange);
    else (m as any).addListener(onChange);

    return () => {
      if (typeof m.removeEventListener === "function")
        m.removeEventListener("change", onChange);
      else (m as any).removeListener(onChange);
    };
  }, []);

  // URL state
  const range = (searchParams.get("range") as RangeKey) || "24h";
  const urlQ = searchParams.get("q") || "";
  const sel = searchParams.get("sel") || "all";

  const sortParam = (searchParams.get("sort") as SortKey) || "last_desc";
  const sort = clampSort(sortParam);

  // Live polling (simple: on/off)
  const [liveEnabled, setLiveEnabled] = useState(true);

  const {
    data: telemetryRaw,
    dataUpdatedAt,
    isFetching,
    refetch,
  } = useGetTelemetryQuery(undefined as any, {
    pollingInterval: liveEnabled ? 5000 : 0,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  } as any);

  const { data: nodesRaw } = useGetNodesQuery(undefined as any, {
    pollingInterval: liveEnabled ? 15000 : 0,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  } as any);

  const nodes = nodesRaw as unknown as NodesById | undefined;

  // Export menu (desktop)
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

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

  // Search input (Chat pattern: local input + deferred URL replace)
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setQInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

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
        if (exportOpen) {
          setExportOpen(false);
          return;
        }
        if (sel && sel !== "all") {
          setParam("sel", "all", "push");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, sel, setParam]);

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

  // Normalize telemetry list
  const eventsAll: TelemetryEvent[] = useMemo(() => {
    const arr = Array.isArray(telemetryRaw)
      ? telemetryRaw
      : (telemetryRaw as any)?.telemetry ?? [];
    return (arr as any[]).map((t, idx) => coerceTelemetryEvent(t, idx));
  }, [telemetryRaw]);

  // Range filter
  const nowMs = Date.now();
  const minTsMs = useMemo(() => {
    if (range === "all") return -Infinity;
    return nowMs - RANGE_MS[range];
  }, [range, nowMs]);

  // Search node-id allowlist (so overview charts can reflect search)
  const allowedNodeIds: Set<string> = useMemo(() => {
    const q = urlQ.trim().toLowerCase();
    const set = new Set<string>();
    if (!nodes) return set;
    if (!q) {
      // empty set means "no filtering"
      return set;
    }

    for (const [id, n] of Object.entries(nodes)) {
      const hay = [
        id,
        n?.shortname,
        n?.longname,
        (n as any)?.id,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (hay.includes(q)) set.add(id);
    }
    return set;
  }, [nodes, urlQ]);

  const filteredEventsAll: TelemetryEvent[] = useMemo(() => {
    const q = urlQ.trim().toLowerCase();
    const restrict = q.length > 0 && allowedNodeIds.size > 0;

    return eventsAll.filter((e) => {
      const ts = safeTsMs(e.timestamp);
      if (ts < minTsMs) return false;
      if (!restrict) return true;
      return allowedNodeIds.has(e.from);
    });
  }, [eventsAll, minTsMs, urlQ, allowedNodeIds]);

  // Per-node summaries (within filteredEventsAll)
  const nodeSummaries: Record<string, TelemetryNodeSummary> = useMemo(() => {
    const map: Record<string, TelemetryNodeSummary> = {};
    for (const e of filteredEventsAll) {
      const id = e.from;
      const ts = safeTsMs(e.timestamp);

      if (!map[id]) {
        map[id] = {
          nodeId: id,
          count: 1,
          firstTsMs: ts,
          lastTsMs: ts,
          latest: e,
        };
      } else {
        map[id].count += 1;
        map[id].firstTsMs = Math.min(map[id].firstTsMs || ts, ts || map[id].firstTsMs);
        if (ts >= (map[id].lastTsMs || 0)) {
          map[id].lastTsMs = ts;
          map[id].latest = e;
        } else {
          map[id].lastTsMs = Math.max(map[id].lastTsMs || ts, ts || map[id].lastTsMs);
        }
      }
    }
    return map;
  }, [filteredEventsAll]);

  const listItems: TelemetryListItem[] = useMemo(() => {
    if (!nodes) return [];

    const summaries = Object.values(nodeSummaries);

    // Compute an “all nodes” top item
    let maxLast = 0;
    for (const s of summaries) maxLast = Math.max(maxLast, s.lastTsMs || 0);

    // Sort node ids according to sort
    const sorted = [...summaries].sort((a, b) => {
      const aNode = nodes[a.nodeId];
      const bNode = nodes[b.nodeId];

      const aName = getNodeLabel(nodes, a.nodeId).toLowerCase();
      const bName = getNodeLabel(nodes, b.nodeId).toLowerCase();

      const aT = (aNode as any)?.telemetry ?? null;
      const bT = (bNode as any)?.telemetry ?? null;

      const aBattery =
        toNumberLoose(aT?.battery_level) ??
        toNumberLoose(a.latest?.payload?.battery_level) ??
        Infinity;
      const bBattery =
        toNumberLoose(bT?.battery_level) ??
        toNumberLoose(b.latest?.payload?.battery_level) ??
        Infinity;

      const aVolt =
        toNumberLoose(aT?.voltage) ??
        toNumberLoose(a.latest?.payload?.voltage) ??
        Infinity;
      const bVolt =
        toNumberLoose(bT?.voltage) ??
        toNumberLoose(b.latest?.payload?.voltage) ??
        Infinity;

      const aChan =
        toNumberLoose(aT?.channel_utilization) ??
        toNumberLoose(a.latest?.payload?.channel_utilization) ??
        -Infinity;
      const bChan =
        toNumberLoose(bT?.channel_utilization) ??
        toNumberLoose(b.latest?.payload?.channel_utilization) ??
        -Infinity;

      const aAir =
        toNumberLoose(aT?.air_util_tx) ??
        toNumberLoose(a.latest?.payload?.air_util_tx) ??
        -Infinity;
      const bAir =
        toNumberLoose(bT?.air_util_tx) ??
        toNumberLoose(b.latest?.payload?.air_util_tx) ??
        -Infinity;

      const aTemp =
        toNumberLoose(aT?.temperature) ??
        toNumberLoose(a.latest?.payload?.temperature) ??
        -Infinity;
      const bTemp =
        toNumberLoose(bT?.temperature) ??
        toNumberLoose(b.latest?.payload?.temperature) ??
        -Infinity;

      switch (sort) {
        case "name_asc":
          return aName.localeCompare(bName);
        case "samples_desc":
          return b.count - a.count || (b.lastTsMs - a.lastTsMs);
        case "battery_asc":
          return aBattery - bBattery || (b.lastTsMs - a.lastTsMs);
        case "voltage_asc":
          return aVolt - bVolt || (b.lastTsMs - a.lastTsMs);
        case "chanutil_desc":
          return bChan - aChan || (b.lastTsMs - a.lastTsMs);
        case "airutil_desc":
          return bAir - aAir || (b.lastTsMs - a.lastTsMs);
        case "temp_desc":
          return bTemp - aTemp || (b.lastTsMs - a.lastTsMs);
        case "last_desc":
        default:
          return (b.lastTsMs - a.lastTsMs) || b.count - a.count;
      }
    });

    const items: TelemetryListItem[] = [
      {
        kind: "all",
        key: "all",
        totalNodes: sorted.length,
        totalSamples: filteredEventsAll.length,
        lastTsMs: maxLast,
      },
      ...sorted.map((s) => ({
        kind: "node",
        key: `node:${s.nodeId}`,
        nodeId: s.nodeId,
        summary: s,
      })),
    ];

    return items;
  }, [nodes, nodeSummaries, filteredEventsAll.length, sort]);

  // Selection handling
  const selectedKey = sel || "all";
  const selectedItem = useMemo(() => {
    return listItems.find((it) => it.key === selectedKey) || null;
  }, [listItems, selectedKey]);

  useEffect(() => {
    if (selectedKey && !selectedItem) {
      setParam("sel", "all", "replace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedItem]);

  const selectedNodeId =
    selectedItem?.kind === "node" ? selectedItem.nodeId : null;

  const selectedEvents: TelemetryEvent[] = useMemo(() => {
    if (!selectedNodeId) return filteredEventsAll;
    return filteredEventsAll.filter((e) => e.from === selectedNodeId);
  }, [filteredEventsAll, selectedNodeId]);

  // Header derived values
  const totalNodes = listItems.length > 0 ? listItems.length - 1 : 0;
  const totalSamples = filteredEventsAll.length;
  const totalLabel = `${totalNodes.toLocaleString()} node${
    totalNodes === 1 ? "" : "s"
  } • ${totalSamples.toLocaleString()} sample${
    totalSamples === 1 ? "" : "s"
  }`;

  const liveUiMode = liveEnabled ? ("live" as const) : ("off" as const);
  const livePillText = liveUiMode === "live" ? "Live" : "Live off";
  const livePillTitle = liveEnabled
    ? "Live polling is on."
    : "Live polling is off. Enable to auto-refresh.";

  // Actions
  const onSelect = useCallback(
    (key: string) => {
      setParam("sel", key, "push");
    },
    [setParam],
  );

  const clearSelection = useCallback(() => {
    setParam("sel", "all", "push");
  }, [setParam]);

  const updateRange = useCallback(
    (next: RangeKey) => setParam("range", next, "push"),
    [setParam],
  );

  const updateSort = useCallback(
    (next: SortKey) => setParam("sort", clampSort(next), "push"),
    [setParam],
  );

  // Export
  const exportRowsCount = selectedEvents.length;

  const exportFilenameBase = useMemo(() => {
    const base = selectedNodeId
      ? `telemetry_${selectedNodeId}`
      : "telemetry_all";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `${base}_${ts}`;
  }, [selectedNodeId]);

  const doExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      selection: selectedNodeId ? { nodeId: selectedNodeId } : { all: true },
      params: Object.fromEntries(searchParams.entries()),
      count: selectedEvents.length,
      rows: selectedEvents.map((e) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { __idx, ...rest } = e as any;
        return rest;
      }),
    };

    downloadBlob(
      `${exportFilenameBase}.json`,
      "application/json;charset=utf-8",
      JSON.stringify(payload, null, 2),
    );
    setExportOpen(false);
  };

  const doExportCsv = () => {
    if (!nodes) return;

    const cols = [
      "timestamp",
      "from_id",
      "from_short",
      "battery_level",
      "voltage",
      "channel_utilization",
      "air_util_tx",
      "temperature",
      "relative_humidity",
      "barometric_pressure",
      "gas_resistance",
      "rssi",
      "snr",
      "uptime_seconds",
    ] as const;

    const lines: string[] = [];
    lines.push(cols.join(","));

    for (const e of selectedEvents) {
      const fromShort = getNodeLabel(nodes, e.from);
      const row: Record<string, any> = {
        timestamp: e.timestamp ? new Date(safeTsMs(e.timestamp)).toISOString() : "",
        from_id: e.from,
        from_short: fromShort,
        battery_level: e.payload?.battery_level ?? "",
        voltage: e.payload?.voltage ?? "",
        channel_utilization: e.payload?.channel_utilization ?? "",
        air_util_tx: e.payload?.air_util_tx ?? "",
        temperature: e.payload?.temperature ?? "",
        relative_humidity: e.payload?.relative_humidity ?? "",
        barometric_pressure: e.payload?.barometric_pressure ?? "",
        gas_resistance: e.payload?.gas_resistance ?? "",
        rssi: e.rssi ?? "",
        snr: e.snr ?? "",
        uptime_seconds: e.payload?.uptime_seconds ?? "",
      };

      lines.push(cols.map((c) => csvEscape(row[c])).join(","));
    }

    const csv = "\ufeff" + lines.join("\r\n");
    downloadBlob(`${exportFilenameBase}.csv`, "text/csv;charset=utf-8", csv);
    setExportOpen(false);
  };

  if (!nodes || !telemetryRaw) {
    return (
      <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
        <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
          <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Telemetry
            </h1>
            <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              Loading…
            </div>
          </div>
        </div>
        <div className="p-4 text-sm text-gray-500">Loading telemetry…</div>
      </div>
    );
  }

  return (
    <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
      {/* Sticky header (Chat-style) */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Telemetry
              </h1>

              {/* Desktop meta row */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  Updated:{" "}
                  <span className="font-medium">
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
                      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                  ].join(" ")}
                  onClick={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                >
                  {livePillText}
                </button>

                <span className="opacity-60">•</span>

                <HeardBy />

                <span className="opacity-60">•</span>

                <span className="tabular-nums">{totalLabel}</span>
              </div>

              {/* Mobile meta row (compact) */}
              <div className="mt-1 flex sm:hidden items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
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
                      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                  ].join(" ")}
                  onClick={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                >
                  {livePillText}
                </button>
              </div>
            </div>

            {/* Desktop actions */}
            <div className="hidden lg:flex items-center gap-2">
              <ExportMenu
                open={exportOpen}
                setOpen={setExportOpen}
                exportRowsCount={exportRowsCount}
                doExportCsv={doExportCsv}
                doExportJson={doExportJson}
                exportMenuRef={exportMenuRef}
              />

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyLink}
                title="Copy a shareable link (includes filters/selection)"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Toolbar row */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-[260px]">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search nodes… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            <div className="hidden lg:flex flex-wrap gap-2 items-center">
              {/* Range segmented */}
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {(["24h", "7d", "30d", "all"] as RangeKey[]).map((rk) => (
                  <button
                    key={`range-${rk}`}
                    type="button"
                    className={[
                      "px-3 py-2 text-sm transition",
                      range === rk
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => updateRange(rk)}
                  >
                    {rk}
                  </button>
                ))}
              </div>

              {/* Sort */}
              <select
                value={sort}
                onChange={(e) => updateSort(e.target.value as SortKey)}
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Sort"
              >
                <option value="last_desc">Last seen</option>
                <option value="name_asc">Name (A→Z)</option>
                <option value="samples_desc">Samples (desc)</option>
                <option value="battery_asc">Battery (low first)</option>
                <option value="voltage_asc">Voltage (low first)</option>
                <option value="chanutil_desc">Channel util (high first)</option>
                <option value="airutil_desc">Air util TX (high first)</option>
                <option value="temp_desc">Temperature (high first)</option>
              </select>

              {/* Clear selection */}
              <button
                type="button"
                className={[
                  "rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  selectedNodeId ? "visible" : "invisible pointer-events-none",
                ].join(" ")}
                onClick={clearSelection}
                title="Back to overview"
                tabIndex={selectedNodeId ? 0 : -1}
                aria-disabled={!selectedNodeId}
              >
                Overview
              </button>
            </div>
          </div>

          {/* Status chips (desktop only) */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-[30px]">
            <StatusChip
              label={`Range: ${range}`}
              active={range !== "24h"}
              title="Click to reset range to 24h"
              onClick={() => setParam("range", "24h", "push")}
            />

            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")}
            />

            <StatusChip
              label={`Sort: ${sort.replaceAll("_", " ")}`}
              active={sort !== "last_desc"}
              title="Click to reset sort"
              onClick={() => setParam("sort", "last_desc", "push")}
            />

            <StatusChip
              label={selectedNodeId ? `Node: ${getNodeLabel(nodes, selectedNodeId)}` : "Overview"}
              active={!!selectedNodeId}
              title="Click to return to overview"
              onClick={clearSelection}
            />
          </div>
        </div>
      </div>

      {/* Main body */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* List */}
            <div className="min-h-0 flex flex-col h-full">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <TelemetryList
                    items={listItems}
                    nodes={nodes}
                    selectedKey={selectedKey}
                    onSelect={onSelect}
                  />
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="lg:col-span-2 min-h-0 flex flex-col">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0">
                <TelemetryDetailsPanel
                  nodes={nodes}
                  selectedKey={selectedKey}
                  selectedNodeId={selectedNodeId}
                  eventsAll={filteredEventsAll}
                  eventsSelected={selectedEvents}
                  nodeSummaries={nodeSummaries}
                  range={range}
                  onClearSelection={clearSelection}
                  onQuickSearch={(text) => {
                    setQInput(text);
                    setParam("q", text, "push");
                  }}
                />
              </div>
            </div>
          </div>

          {/* Tiny footer hint (mobile) */}
          <div className="mt-3 lg:hidden text-xs text-gray-500">
            Tip: press <span className="font-mono">/</span> to search. Tap a node to switch the charts.
          </div>
        </div>
      </div>
    </div>
  );
};
