import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";

import { HeardBy } from "../components/HeardBy";
import { LivePill } from "../components/LivePill";
import { useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { ExportMenu } from "./chat/ExportMenu";
import { TracerouteDetailsPanel } from "./traceroutes/TracerouteDetailsPanel";
import { TraceroutesList } from "./traceroutes/TraceroutesList";
import {
  type TraceroutePairSummary,
  type TraceroutesListItem,
} from "./traceroutes/traceroutesTypes";
import {
  coerceEvent,
  csvEscape,
  downloadBlob,
  groupTracerouteEvents,
  type NodesById,
  routeHopsOf,
  routeIdsOf,
  safeTsMs,
  type TracerouteEvent,
} from "./traceroutes/traceroutesUtils";

export type RangeKey = "all" | "1h" | "24h" | "7d";
type SortKey =
  | "last_desc"
  | "last_asc"
  | "count_desc"
  | "count_asc"
  | "routes_desc"
  | "routes_asc";

const DEFAULT_RANGE: RangeKey = "all";
const DEFAULT_SEL = "all";
const DEFAULT_SORT: SortKey = "last_desc";

const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function clampRange(v: any): RangeKey {
  // legacy share links: traceroutes used to allow 30d
  if (v === "30d") return "7d";
  return (["all", "1h", "24h", "7d"] as const).includes(v)
    ? (v as RangeKey)
    : DEFAULT_RANGE;
}

function clampSort(v: any): SortKey {
  return ([
    "last_desc",
    "last_asc",
    "count_desc",
    "count_asc",
    "routes_desc",
    "routes_asc",
  ] as const).includes(v)
    ? (v as SortKey)
    : DEFAULT_SORT;
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

function sanitizeFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140);
}

export const Traceroutes = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Clean up legacy params (old view + old sorts + old selection keys)
  useEffect(() => {
    const legacyView = searchParams.get("view");
    const legacySort = searchParams.get("sort") ?? "";
    const legacySel = searchParams.get("sel") ?? "";
    const legacyRange = searchParams.get("range") ?? "";

    const needsCleanup =
      !!legacyView ||
      legacyRange === "30d" ||
      [
        "newest",
        "oldest",
        "hops_desc",
        "hops_asc",
        "count_desc",
        "count_asc",
        "last_desc",
        "last_asc",
      ].includes(legacySort) ||
      (legacySel && legacySel !== "all" && !legacySel.startsWith("pair:"));

    if (!needsCleanup) return;

    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete("view");

        // legacy: 30d => 7d so UI + behavior match
        if (p.get("range") === "30d") p.set("range", "7d");

        // old page used different sort values; drop to our default
        if (
          [
            "newest",
            "oldest",
            "hops_desc",
            "hops_asc",
            "count_desc",
            "count_asc",
            "last_desc",
            "last_asc",
          ].includes(p.get("sort") ?? "")
        ) {
          p.delete("sort");
        }

        // old selection keys (evt:/route:) won’t exist anymore
        const s = p.get("sel") ?? "";
        if (s && s !== "all" && !s.startsWith("pair:")) p.delete("sel");

        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setParam = useCallback(
    (key: string, value?: string, mode: "push" | "replace" = "push") => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);

          // always remove legacy view param if present
          next.delete("view");

          const v = value == null ? "" : String(value);

          const isDefault =
            (key === "range" && v === DEFAULT_RANGE) ||
            (key === "sel" && v === DEFAULT_SEL) ||
            (key === "sort" && (v as SortKey) === DEFAULT_SORT) ||
            (key === "q" && v.trim() === "");

          if (!v || isDefault) next.delete(key);
          else next.set(key, v);

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
  const range = clampRange(searchParams.get("range"));
  const urlQ = searchParams.get("q") || "";
  const selectedKey = searchParams.get("sel") || DEFAULT_SEL;
  const sort = clampSort(searchParams.get("sort") || DEFAULT_SORT);

  // Live polling (simple: on/off)
  const [liveEnabled, setLiveEnabled] = useState(true);

  const {
    data: traceroutesRaw,
    isFetching,
    refetch,
  } = useGetTraceroutesQuery(undefined as any, {
    pollingInterval: liveEnabled ? 5000 : 0,
    skipPollingIfUnfocused: true,
    refetchOnFocus: liveEnabled,
    refetchOnReconnect: liveEnabled,
  } as any);

  const { data: nodesRaw } = useGetNodesQuery(undefined as any, {
    pollingInterval: liveEnabled ? 15000 : 0,
    skipPollingIfUnfocused: true,
    refetchOnFocus: liveEnabled,
    refetchOnReconnect: liveEnabled,
  } as any);

  const nodes = nodesRaw as unknown as NodesById | undefined;

  // Export menu (desktop)
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

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
        if (selectedKey && selectedKey !== DEFAULT_SEL) {
          setParam("sel", DEFAULT_SEL, "push");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, selectedKey, setParam]);

  // Copy link (Chat-style)
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

  // ---- Normalize events once
  const eventsAll: TracerouteEvent[] = useMemo(() => {
    if (!traceroutesRaw) return [];
    return (traceroutesRaw as any[]).map((t, idx) => coerceEvent(t, idx));
  }, [traceroutesRaw]);

  // ---- Range filter threshold (30s-quantized clock so the memo chain doesn't rebuild every render)
  const nowQuantMs = Math.floor(Date.now() / 30_000) * 30_000;
  const minTsMs = useMemo(() => {
    if (range === "all") return -Infinity;
    return nowQuantMs - RANGE_MS[range];
  }, [range, nowQuantMs]);

  // ---- Filter (q across endpoints + hop ids + short/long names)
  // Node names only matter while searching; null gate keeps 400ms nodes-cache flushes out of the memo chain
  const hasNodes = !!nodes;
  const nodesForSearch = urlQ.trim() ? nodes : null;

  const filteredEvents: TracerouteEvent[] = useMemo(() => {
    if (!hasNodes) return [];
    const q = (urlQ ?? "").trim().toLowerCase();

    return eventsAll.filter((e) => {
      const ts = safeTsMs(e.timestamp);
      if (ts < minTsMs) return false;

      if (!q || !nodesForSearch) return true;

      const fromNode = nodesForSearch[e.from];
      const toNode = nodesForSearch[e.to];
      const rids = routeIdsOf(e);

      const hay = [
        e.from,
        e.to,
        fromNode?.shortname,
        fromNode?.longname,
        toNode?.shortname,
        toNode?.longname,
        String(e.hops_away ?? ""),
        String(routeHopsOf(e) ?? ""),
        ...rids,
        ...rids.map((id) => nodesForSearch[id]?.shortname || ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });
  }, [eventsAll, hasNodes, nodesForSearch, urlQ, minTsMs]);

  // Keep events newest-first (details + summaries feel best this way)
  const filteredEventsSorted: TracerouteEvent[] = useMemo(() => {
    const arr = [...filteredEvents];
    arr.sort((a, b) => safeTsMs(b.timestamp) - safeTsMs(a.timestamp));
    return arr;
  }, [filteredEvents]);

  // Unique route sequences across all filtered events (for overview)
  const uniqueRoutesTotal = useMemo(() => {
    return groupTracerouteEvents(filteredEventsSorted).length;
  }, [filteredEventsSorted]);

  // ---- Build pair summaries + events-by-pair
  const { pairItems, eventsByPairKey, listItems } = useMemo(() => {
    const byPair = new Map<
      string,
      {
        from: string;
        to: string;
        count: number;
        firstTsMs: number;
        lastTsMs: number;
        uniqueRouteKeys: Set<string>;
        routeCounts: Map<
          string,
          { routeIds: string[]; count: number; lastTsMs: number }
        >;
      }
    >();

    const eventsMap = new Map<string, TracerouteEvent[]>();

    for (const e of filteredEventsSorted) {
      const pairKey = `${e.from}|${e.to}`;
      const ts = safeTsMs(e.timestamp);
      if (!eventsMap.has(pairKey)) eventsMap.set(pairKey, []);
      eventsMap.get(pairKey)!.push(e);

      if (!byPair.has(pairKey)) {
        byPair.set(pairKey, {
          from: e.from,
          to: e.to,
          count: 1,
          firstTsMs: ts,
          lastTsMs: ts,
          uniqueRouteKeys: new Set<string>(),
          routeCounts: new Map(),
        });
      } else {
        const s = byPair.get(pairKey)!;
        s.count += 1;
        s.firstTsMs = Math.min(s.firstTsMs || ts, ts || s.firstTsMs);
        s.lastTsMs = Math.max(s.lastTsMs || ts, ts || s.lastTsMs);
      }

      const s = byPair.get(pairKey)!;
      const rids = routeIdsOf(e);
      const rk = rids.join(",");
      s.uniqueRouteKeys.add(rk);

      const cur = s.routeCounts.get(rk);
      if (!cur) {
        s.routeCounts.set(rk, { routeIds: rids, count: 1, lastTsMs: ts });
      } else {
        cur.count += 1;
        cur.lastTsMs = Math.max(cur.lastTsMs || ts, ts || cur.lastTsMs);
      }
    }

    const pairs: TraceroutesListItem[] = Array.from(byPair.entries()).map(
      ([pairKey, s]) => {
        // compute a "top route" for the list preview
        let best: { routeIds: string[]; count: number; lastTsMs: number } | null =
          null;

        for (const v of s.routeCounts.values()) {
          if (
            !best ||
            v.count > best.count ||
            (v.count === best.count && v.lastTsMs > best.lastTsMs)
          ) {
            best = v;
          }
        }

        const summary: TraceroutePairSummary = {
          pairKey,
          from: s.from,
          to: s.to,
          count: s.count,
          firstTsMs: s.firstTsMs,
          lastTsMs: s.lastTsMs,
          uniqueRoutes: s.uniqueRouteKeys.size,
          topRouteIds: best?.routeIds ?? [],
          topRouteCount: best?.count ?? 0,
        };

        return {
          kind: "pair",
          key: `pair:${pairKey}`,
          pairKey,
          from: s.from,
          to: s.to,
          summary,
        };
      },
    );

    const sortedPairs = [...pairs].sort((a, b) => {
      const A = a.kind === "pair" ? a.summary : null;
      const B = b.kind === "pair" ? b.summary : null;
      if (!A || !B) return 0;

      switch (sort) {
        case "count_asc":
          return A.count - B.count || B.lastTsMs - A.lastTsMs;
        case "count_desc":
          return B.count - A.count || B.lastTsMs - A.lastTsMs;
        case "routes_asc":
          return A.uniqueRoutes - B.uniqueRoutes || B.lastTsMs - A.lastTsMs;
        case "routes_desc":
          return B.uniqueRoutes - A.uniqueRoutes || B.lastTsMs - A.lastTsMs;
        case "last_asc":
          return A.lastTsMs - B.lastTsMs || B.count - A.count;
        case "last_desc":
        default:
          return B.lastTsMs - A.lastTsMs || B.count - A.count;
      }
    });

    let maxLast = 0;
    for (const it of sortedPairs) {
      if (it.kind === "pair") maxLast = Math.max(maxLast, it.summary.lastTsMs);
    }

    const allItem: TraceroutesListItem = {
      kind: "all",
      key: "all",
      totalPairs: sortedPairs.length,
      totalEvents: filteredEventsSorted.length,
      lastTsMs: maxLast,
      uniqueRoutes: uniqueRoutesTotal,
    };

    const items: TraceroutesListItem[] = [allItem, ...sortedPairs];

    return {
      pairItems: sortedPairs,
      eventsByPairKey: eventsMap,
      listItems: items,
    };
  }, [filteredEventsSorted, sort, uniqueRoutesTotal]);

  // ---- Selection
  const selectedItem = useMemo(() => {
    return listItems.find((it) => it.key === selectedKey) || listItems[0] || null;
  }, [listItems, selectedKey]);

  useEffect(() => {
    if (!selectedItem) return;
    if (selectedKey && !listItems.find((it) => it.key === selectedKey)) {
      setParam("sel", DEFAULT_SEL, "replace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, listItems.length]);

  const selectedPairKey =
    selectedItem && selectedItem.kind === "pair" ? selectedItem.pairKey : null;

  const eventsSelected: TracerouteEvent[] = useMemo(() => {
    if (!selectedPairKey) return filteredEventsSorted;
    return eventsByPairKey.get(selectedPairKey) ?? [];
  }, [selectedPairKey, filteredEventsSorted, eventsByPairKey]);

  // ---- Header derived values
  const totalPairs =
    listItems.length > 0 && listItems[0].kind === "all"
      ? listItems[0].totalPairs
      : Math.max(0, listItems.length - 1);

  const totalEvents = filteredEventsSorted.length;

  const totalLabel = `${totalPairs.toLocaleString()} pair${
    totalPairs === 1 ? "" : "s"
  } • ${totalEvents.toLocaleString()} traceroute${
    totalEvents === 1 ? "" : "s"
  }`;

  const liveUiMode = liveEnabled ? ("live" as const) : ("off" as const);
  const livePillTitle = liveEnabled
    ? "Live mode is on. Auto-refresh polls every 5 seconds (paused when tab is unfocused). Click to disable."
    : "Live mode is off. Auto-refresh is disabled. Click to enable.";

  // ---- Actions
  const onSelect = useCallback(
    (key: string) => {
      setParam("sel", key, "push"); // key==="all" => deleted
    },
    [setParam],
  );

  const clearSelection = useCallback(() => {
    setParam("sel", DEFAULT_SEL, "push");
  }, [setParam]);

  const updateRange = useCallback(
    (next: RangeKey) => setParam("range", next, "push"),
    [setParam],
  );

  const updateSort = useCallback(
    (next: SortKey) => setParam("sort", clampSort(next), "push"),
    [setParam],
  );

  // ---- Export (scope = selected pair or all)
  const exportRowsCount = eventsSelected.length;

  const exportFilenameBase = useMemo(() => {
    if (selectedPairKey) {
      const [from, to] = selectedPairKey.split("|");
      const base = sanitizeFilename(`traceroutes_${from}_${to}`);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      return `${base}_${ts}`;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `traceroutes_all_${ts}`;
  }, [selectedPairKey]);

  const doExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      selection: selectedPairKey ? { pair: selectedPairKey } : { all: true },
      params: Object.fromEntries(searchParams.entries()),
      count: eventsSelected.length,
      rows: eventsSelected.map((e) => {
         
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
      "to_id",
      "to_short",
      "hops_away",
      "route_hops",
      "route_ids",
      "route_short",
    ] as const;

    const lines: string[] = [];
    lines.push(cols.join(","));

    for (const e of eventsSelected) {
      const fromShort = nodes[e.from]?.shortname ?? "UNK";
      const toShort = nodes[e.to]?.shortname ?? "UNK";
      const rids = routeIdsOf(e);
      const routeShort = rids
        .map((id) => nodes[id]?.shortname ?? "UNK")
        .join(" > ");

      const row: Record<string, any> = {
        timestamp: e.timestamp ? new Date(safeTsMs(e.timestamp)).toISOString() : "",
        from_id: e.from,
        from_short: fromShort,
        to_id: e.to,
        to_short: toShort,
        hops_away: e.hops_away ?? "",
        route_hops: rids.length,
        route_ids: rids.join(" "),
        route_short: routeShort,
      };

      lines.push(cols.map((c) => csvEscape(row[c])).join(","));
    }

    const csv = "\ufeff" + lines.join("\r\n");
    downloadBlob(`${exportFilenameBase}.csv`, "text/csv;charset=utf-8", csv);
    setExportOpen(false);
  };

  if (!nodes || !traceroutesRaw) {
    return (
      <div className="w-full h-dvh overflow-hidden flex flex-col">
        <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
          <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Traceroutes
            </h1>
            <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              Loading…
            </div>
          </div>
        </div>
        <div className="p-4 text-sm text-gray-500">Loading traceroutes…</div>
      </div>
    );
  }

  return (
    <div className="w-full h-dvh overflow-hidden flex flex-col">
      {/* Sticky header (Chat-style) */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Traceroutes
              </h1>

              {/* Desktop meta row */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching || manualRefreshing ? "animate-pulse" : ""}>
                  {isFetching || manualRefreshing ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                >
                  refresh
                </button>

                <LivePill
                  mode={liveUiMode}
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />

                <span className="opacity-60">•</span>

                <HeardBy />

                <span className="opacity-60">•</span>

                <span className="tabular-nums">{totalLabel}</span>
              </div>

              {/* Mobile meta row */}
              <div className="mt-1 flex sm:hidden flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching || manualRefreshing ? "animate-pulse" : ""}>
                  {isFetching || manualRefreshing ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                >
                  refresh
                </button>

                <LivePill
                  mode={liveUiMode}
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />
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
            <div className="flex-1 min-w-0 lg:min-w-65">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search traceroutes… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            <div className="hidden lg:flex flex-wrap gap-2 items-center">
              {/* Range segmented */}
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {(["1h", "24h", "7d", "all"] as RangeKey[]).map((rk) => (
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
                title="Sort pairs list"
              >
                <option value="last_desc">Last seen (desc)</option>
                <option value="last_asc">Last seen (asc)</option>
                <option value="count_desc">Count (desc)</option>
                <option value="count_asc">Count (asc)</option>
                <option value="routes_desc">Unique routes (desc)</option>
                <option value="routes_asc">Unique routes (asc)</option>
              </select>

              {/* Clear selection */}
              <button
                type="button"
                className={[
                  "rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  selectedPairKey ? "visible" : "invisible pointer-events-none",
                ].join(" ")}
                onClick={clearSelection}
                title="Back to overview"
                tabIndex={selectedPairKey ? 0 : -1}
                aria-disabled={!selectedPairKey}
              >
                Overview
              </button>
            </div>
          </div>

          {/* Status chips (desktop only) */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-7.5">
            <StatusChip
              label={`Range: ${range}`}
              active={range !== DEFAULT_RANGE}
              title="Click to reset range to all"
              onClick={() => setParam("range", DEFAULT_RANGE, "push")}
            />

            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")}
            />

            <StatusChip
              label={`Sort: ${sort.split("_").join(" ")}`}
              active={sort !== DEFAULT_SORT}
              title="Click to reset sort"
              onClick={() => setParam("sort", DEFAULT_SORT, "push")}
            />

            <StatusChip
              label={selectedPairKey ? "Pair: selected" : "Overview"}
              active={!!selectedPairKey}
              title="Click to return to overview"
              onClick={clearSelection}
            />
          </div>
        </div>
      </div>

      {/* Main body */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-400 px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          {/* Telemetry-style layout: list 1 col, details 2 col */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* List */}
            <div className="min-h-0 flex flex-col h-full">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col min-h-0 flex-1">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <TraceroutesList
                    items={listItems}
                    nodes={nodes}
                    selectedKey={selectedItem?.key ?? "all"}
                    onSelect={onSelect}
                  />
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="lg:col-span-2 min-h-0 flex flex-col">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col min-h-0">
                <TracerouteDetailsPanel
                  selectedItem={selectedItem ?? listItems[0]}
                  nodes={nodes}
                  range={range}
                  eventsAll={filteredEventsSorted}
                  eventsSelected={eventsSelected}
                  pairItems={pairItems}
                  uniqueRoutesTotal={uniqueRoutesTotal}
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
            Tip: press <span className="font-mono">/</span> to search. Tap a pair
            to see route breakdown + recent runs.
          </div>
        </div>
      </div>
    </div>
  );
};
