import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { HeardBy } from "../components/HeardBy";
import { useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";

import { ExportMenu } from "./chat/ExportMenu";

import {
  type NodesById,
  type TracerouteEvent,
  type TracerouteGroup,
  type TraceroutesListItem,
  coerceEvent,
  csvEscape,
  downloadBlob,
  groupTracerouteEvents,
  routeHopsOf,
  routeIdsOf,
  safeTsMs,
} from "./traceroutes/traceroutesUtils";

import { TraceroutesList } from "./traceroutes/TraceroutesList";
import { TracerouteDetailsPanel } from "./traceroutes/TracerouteDetailsPanel";

type ViewKey = "events" | "routes";
type RangeKey = "all" | "24h" | "7d" | "30d";
type SortKey =
  | "newest"
  | "oldest"
  | "hops_desc"
  | "hops_asc"
  | "count_desc"
  | "count_asc"
  | "last_desc"
  | "last_asc";

const RANGE_MS: Record<Exclude<RangeKey, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function clampSortForView(view: ViewKey, sort: SortKey): SortKey {
  if (view === "routes") {
    if (
      sort === "newest" ||
      sort === "oldest" ||
      sort === "hops_desc" ||
      sort === "hops_asc"
    ) {
      return "count_desc";
    }
    return sort;
  }
  // events
  if (
    sort === "count_desc" ||
    sort === "count_asc" ||
    sort === "last_desc" ||
    sort === "last_asc"
  ) {
    return "newest";
  }
  return sort;
}

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

export const Traceroutes = () => {
  const location = useLocation();
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
  const view = (searchParams.get("view") as ViewKey) || "events";
  const range = (searchParams.get("range") as RangeKey) || "all";
  const sel = searchParams.get("sel") || "";
  const urlQ = searchParams.get("q") || "";

  const sortParam =
    (searchParams.get("sort") as SortKey) ||
    (view === "routes" ? "count_desc" : "newest");
  const sort = clampSortForView(view, sortParam);

  // Live polling (simple: on/off)
  const [liveEnabled, setLiveEnabled] = useState(true);

  const {
    data: traceroutesRaw,
    dataUpdatedAt,
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

  // Search input (matches Chat pattern: local input + deferred URL replace)
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
        if (sel) {
          setParam("sel", undefined, "push");
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [exportOpen, sel, setParam]);

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

  // Manual refresh (quiet; doesn’t make header “flash”)
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

  // ---- Range filter threshold
  const nowMs = Date.now();
  const minTsMs = useMemo(() => {
    if (range === "all") return -Infinity;
    return nowMs - RANGE_MS[range];
  }, [range, nowMs]);

  // ---- Filter (q across endpoints + route ids + short/long names)
  const filteredEvents: TracerouteEvent[] = useMemo(() => {
    if (!nodes) return [];
    const q = (urlQ ?? "").trim().toLowerCase();

    return eventsAll.filter((e) => {
      const ts = safeTsMs(e.timestamp);
      if (ts < minTsMs) return false;

      if (!q) return true;

      const fromNode = nodes[e.from];
      const toNode = nodes[e.to];
      const rids = routeIdsOf(e);

      const hay = [
        e.from,
        e.to,
        fromNode?.shortname,
        fromNode?.longname,
        toNode?.shortname,
        toNode?.longname,
        String(e.hops_away ?? ""),
        ...rids,
        ...rids.map((id) => nodes[id]?.shortname || ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });
  }, [eventsAll, nodes, urlQ, minTsMs]);

  // ---- Sort events
  const filteredEventsSorted: TracerouteEvent[] = useMemo(() => {
    const arr = [...filteredEvents];

    const byTs = (a: TracerouteEvent, b: TracerouteEvent) =>
      safeTsMs(a.timestamp) - safeTsMs(b.timestamp);

    const byHops = (a: TracerouteEvent, b: TracerouteEvent) =>
      (routeHopsOf(a) || 0) - (routeHopsOf(b) || 0);

    switch (sort) {
      case "oldest":
        arr.sort((a, b) => byTs(a, b));
        return arr;
      case "hops_asc":
        arr.sort((a, b) => byHops(a, b) || byTs(a, b));
        return arr;
      case "hops_desc":
        arr.sort((a, b) => byHops(b, a) || byTs(b, a));
        return arr;
      case "newest":
      default:
        arr.sort((a, b) => byTs(b, a));
        return arr;
    }
  }, [filteredEvents, sort]);

  // ---- Group routes
  const routeGroups: TracerouteGroup[] = useMemo(() => {
    if (!nodes) return [];
    return groupTracerouteEvents(filteredEventsSorted);
  }, [filteredEventsSorted, nodes]);

  const routeGroupsSorted: TracerouteGroup[] = useMemo(() => {
    const arr = [...routeGroups];
    switch (sort) {
      case "count_asc":
        arr.sort((a, b) => a.count - b.count || b.lastTsMs - a.lastTsMs);
        return arr;
      case "count_desc":
        arr.sort((a, b) => b.count - a.count || b.lastTsMs - a.lastTsMs);
        return arr;
      case "last_asc":
        arr.sort((a, b) => a.lastTsMs - b.lastTsMs || b.count - a.count);
        return arr;
      case "last_desc":
      default:
        arr.sort((a, b) => b.lastTsMs - a.lastTsMs || b.count - a.count);
        return arr;
    }
  }, [routeGroups, sort]);

  // ---- List items for Virtuoso
  const listItems: TraceroutesListItem[] = useMemo(() => {
    if (view === "routes") {
      return routeGroupsSorted.map((g) => ({
        kind: "route",
        key: `route:${g.key}`,
        group: g,
      }));
    }
    return filteredEventsSorted.map((e) => ({
      kind: "event",
      key: `evt:${e.__idx}`,
      event: e,
    }));
  }, [view, routeGroupsSorted, filteredEventsSorted]);

  // ---- Selection
  const selected: TraceroutesListItem | null = useMemo(() => {
    if (!sel) return null;
    return listItems.find((it) => it.key === sel) || null;
  }, [sel, listItems]);

  // If selection disappears due to filtering, clear it.
  useEffect(() => {
    if (sel && !selected) {
      setParam("sel", undefined, "replace");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, selected]);

  const relatedEvents: TracerouteEvent[] = useMemo(() => {
    if (!selected || selected.kind !== "route") return [];
    const routeKey = selected.group.key;
    const match = filteredEventsSorted.filter((e) => {
      const k = `${e.from}|${e.to}|${routeIdsOf(e).join(",")}`;
      return k === routeKey;
    });
    return match.slice(0, 50);
  }, [selected, filteredEventsSorted]);

  // ---- Header derived values
  const totalEvents = filteredEventsSorted.length;
  const totalRoutes = routeGroupsSorted.length;
  const totalLabel =
    view === "routes"
      ? `${totalRoutes.toLocaleString()} route${totalRoutes === 1 ? "" : "s"}`
      : `${totalEvents.toLocaleString()} traceroute${
          totalEvents === 1 ? "" : "s"
        }`;

  const liveUiMode = liveEnabled ? ("live" as const) : ("off" as const);
  const livePillText = liveUiMode === "live" ? "Live" : "Live off";
  const livePillTitle = liveEnabled
    ? "Live mode is on. Auto-refresh polls every 5 seconds (paused when tab is unfocused). Click to disable."
    : "Live mode is off. Auto-refresh is disabled (no polling / focus / reconnect). Click to enable.";

  // ---- Status chips (desktop only)
  const activeChips = useMemo(() => {
    const chips: Array<{ label: string; clear: () => void }> = [];

    if (range !== "all") {
      chips.push({
        label: `Range: ${range}`,
        clear: () => setParam("range", "all", "push"),
      });
    }

    if (view !== "events") {
      chips.push({
        label: "View: routes",
        clear: () => setParam("view", "events", "push"),
      });
    }

    const defaultSort = view === "routes" ? "count_desc" : "newest";
    if (sort !== defaultSort) {
      chips.push({
        label: `Sort: ${sort.replaceAll("_", " ")}`,
        clear: () => setParam("sort", defaultSort, "push"),
      });
    }

    if (urlQ.trim()) {
      chips.push({
        label: `Search: "${urlQ.trim()}"`,
        clear: () => setParam("q", undefined, "push"),
      });
    }

    return chips;
  }, [range, view, sort, urlQ, setParam]);

  // ---- Actions
  const onSelect = useCallback(
    (key: string) => {
      setParam("sel", key, "push");
    },
    [setParam],
  );

  const clearSelection = useCallback(() => {
    setParam("sel", undefined, "push");
  }, [setParam]);

  const updateView = useCallback(
    (next: ViewKey) => {
      const nextSort = clampSortForView(next, sort);
      setSearchParams(
        (prev) => {
          let p = new URLSearchParams(prev);
          p = setParamValue(p, "view", next);
          p = setParamValue(p, "sort", nextSort);
          p = setParamValue(p, "sel", null);
          return p;
        },
        { replace: false },
      );
    },
    [setSearchParams, sort],
  );

  const updateRange = useCallback(
    (next: RangeKey) => {
      setParam("range", next, "push");
    },
    [setParam],
  );

  const updateSort = useCallback(
    (next: SortKey) => {
      setParam("sort", clampSortForView(view, next), "push");
    },
    [setParam, view],
  );

  // ---- Export (wired into ExportMenu)
  const exportRowsCount =
    view === "routes" ? routeGroupsSorted.length : filteredEventsSorted.length;

  const exportFilenameBase = useMemo(() => {
    const base = `traceroutes_${view}`;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `${base}_${ts}`;
  }, [view]);

  const doExportJson = () => {
    const payload =
      view === "routes"
        ? {
            exportedAt: new Date().toISOString(),
            view,
            params: Object.fromEntries(searchParams.entries()),
            count: routeGroupsSorted.length,
            rows: routeGroupsSorted,
          }
        : {
            exportedAt: new Date().toISOString(),
            view,
            params: Object.fromEntries(searchParams.entries()),
            count: filteredEventsSorted.length,
            rows: filteredEventsSorted.map((e) => {
              // strip internal idx
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { __idx, ...rest } = e;
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

    const lines: string[] = [];

    if (view === "routes") {
      const cols = [
        "count",
        "first_ts",
        "last_ts",
        "from_id",
        "from_short",
        "to_id",
        "to_short",
        "hops_away",
        "route_hops",
        "route_ids",
        "route_short",
      ] as const;

      lines.push(cols.join(","));

      for (const g of routeGroupsSorted) {
        const fromShort = nodes[g.from]?.shortname ?? "UNK";
        const toShort = nodes[g.to]?.shortname ?? "UNK";
        const routeShort = g.route_ids
          .map((id) => nodes[id]?.shortname ?? "UNK")
          .join(" > ");

        const row = {
          count: g.count,
          first_ts: g.firstTsMs ? new Date(g.firstTsMs).toISOString() : "",
          last_ts: g.lastTsMs ? new Date(g.lastTsMs).toISOString() : "",
          from_id: g.from,
          from_short: fromShort,
          to_id: g.to,
          to_short: toShort,
          hops_away: g.hops_away ?? "",
          route_hops: g.route_ids.length,
          route_ids: g.route_ids.join(" "),
          route_short: routeShort,
        };

        lines.push(cols.map((c) => csvEscape((row as any)[c])).join(","));
      }
    } else {
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

      lines.push(cols.join(","));

      for (const e of filteredEventsSorted) {
        const fromShort = nodes[e.from]?.shortname ?? "UNK";
        const toShort = nodes[e.to]?.shortname ?? "UNK";
        const rids = routeIdsOf(e);
        const routeShort = rids
          .map((id) => nodes[id]?.shortname ?? "UNK")
          .join(" > ");

        const row = {
          timestamp: e.timestamp
            ? new Date(safeTsMs(e.timestamp)).toISOString()
            : "",
          from_id: e.from,
          from_short: fromShort,
          to_id: e.to,
          to_short: toShort,
          hops_away: e.hops_away ?? "",
          route_hops: rids.length,
          route_ids: rids.join(" "),
          route_short: routeShort,
        };

        lines.push(cols.map((c) => csvEscape((row as any)[c])).join(","));
      }
    }

    const csv = "\ufeff" + lines.join("\r\n");
    downloadBlob(`${exportFilenameBase}.csv`, "text/csv;charset=utf-8", csv);
    setExportOpen(false);
  };

  if (!nodes || !traceroutesRaw) {
    return (
      <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
        <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
          <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
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
    <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
      {/* Sticky header (Chat-style) */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Traceroutes
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

          {/* View pills (Chat preset-pill vibe) */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
            {(["events", "routes"] as ViewKey[]).map((vk) => {
              const active = vk === view;
              const count = vk === "events" ? totalEvents : totalRoutes;

              return (
                <button
                  key={`view-${vk}`}
                  type="button"
                  className={[
                    "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                    active
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                      : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                  ].join(" ")}
                  onClick={() => updateView(vk)}
                  title={
                    vk === "events"
                      ? "Individual traceroute runs"
                      : "Grouped by identical hop sequence"
                  }
                >
                  {vk === "events" ? "Events" : "Routes"}
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
            <div className="flex-1 min-w-0 lg:min-w-[260px]">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search traceroutes… (press / to focus)"
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
                {view === "events" ? (
                  <>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="hops_desc">Hops (desc)</option>
                    <option value="hops_asc">Hops (asc)</option>
                  </>
                ) : (
                  <>
                    <option value="count_desc">Count (desc)</option>
                    <option value="count_asc">Count (asc)</option>
                    <option value="last_desc">Last seen (desc)</option>
                    <option value="last_asc">Last seen (asc)</option>
                  </>
                )}
              </select>

              {/* Clear selection */}
              <button
                type="button"
                className={[
                  "rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition",
                  sel ? "visible" : "invisible pointer-events-none",
                ].join(" ")}
                onClick={clearSelection}
                title="Clear selection"
                tabIndex={sel ? 0 : -1}
                aria-disabled={!sel}
              >
                Clear selection
              </button>
            </div>
          </div>

          {/* Status chips (desktop only) */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-[30px]">
            <StatusChip
              label={`Range: ${range}`}
              active={range !== "all"}
              title="Click to reset range to all"
              onClick={() => setParam("range", "all", "push")}
            />

            <StatusChip
              label={`View: ${view}`}
              active={view !== "events"}
              title="Click to reset view to events"
              onClick={() => updateView("events")}
            />

            <StatusChip
              label={`Sort: ${sort.replaceAll("_", " ")}`}
              active={sort !== (view === "routes" ? "count_desc" : "newest")}
              title="Click to reset sort"
              onClick={() =>
                setParam(
                  "sort",
                  view === "routes" ? "count_desc" : "newest",
                  "push",
                )
              }
            />

            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")}
            />

            {activeChips.length > 0 ? (
              <>
                <span className="opacity-60">•</span>
                <span className="text-xs text-gray-500">
                  {activeChips.length} active
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main body */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* List */}
            <div className="lg:col-span-2 min-h-0 flex flex-col h-full">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <TraceroutesList
                    items={listItems}
                    nodes={nodes}
                    selectedKey={sel}
                    onSelect={onSelect}
                  />
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="min-h-0 flex flex-col">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0">
                <TracerouteDetailsPanel
                  selected={selected}
                  nodes={nodes}
                  relatedEvents={relatedEvents}
                  onClearSelection={clearSelection}
                  onQuickSearch={(text) => {
                    setQInput(text);
                    setParam("q", text, "push");
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
