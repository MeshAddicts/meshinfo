import {
  ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { Avatar } from "../components/Avatar";
import { DateToSince } from "../components/DateSince";
import { HeardBy } from "../components/HeardBy";
import { useGetNodesQuery } from "../slices/apiSlice";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { calculateDistanceBetweenNodes } from "../utils/getDistanceBetweenTwoNodes";
import { csvEscape, downloadBlob } from "./chat/chatUtils";
import { ExportMenu } from "./chat/ExportMenu";
import {
  cleanNodeId,
  isNodeOnline,
  safeLastSeenMs,
} from "./nodes/nodesUtils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NeighborEntry {
  node_id: number;
  snr: number;
  distance?: number;
}

/** One row in the virtualized list */
export interface NeighborListItem {
  id: string;
  rawId: string;
  node: any;
  online: boolean;
  lastSeenMs: number | null;
  neighborsHeard: { id: string; shortname: string; snr: number; distanceKm: number | null }[];
  heardBy: { id: string; shortname: string; snr: number; distanceKm: number | null }[];
  broadcastIntervalSecs: number | null;
}

/* ------------------------------------------------------------------ */
/*  Sort keys                                                          */
/* ------------------------------------------------------------------ */

type SortByKey = "seen" | "name" | "heard" | "heardBy";
type SortDir = "asc" | "desc";

/* ------------------------------------------------------------------ */
/*  Reusable sub-components                                            */
/* ------------------------------------------------------------------ */

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
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
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
        active
          ? "bg-white/5 dark:bg-gray-800/30 opacity-100"
          : "bg-transparent",
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

/* ------------------------------------------------------------------ */
/*  Neighbor Detail Panel (right side / mobile sheet)                   */
/* ------------------------------------------------------------------ */

function NeighborDetailPanel({
  item,
  nodes: _nodes,
  onClearSelection,
}: {
  item: NeighborListItem;
  nodes: any;
  onClearSelection: () => void;
}) {
  const n = item.node;
  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setCurrentDate(new Date()), 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar id={item.id} size={32} className="shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {n?.longname ?? item.id}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {n?.shortname ?? "UNK"} &middot; {item.id}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
          onClick={onClearSelection}
        >
          Clear
        </button>
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-2 text-sm">
        <span
          className={[
            "inline-block w-2 h-2 rounded-full",
            item.online ? "bg-emerald-500" : "bg-gray-400",
          ].join(" ")}
        />
        <span className="text-gray-700 dark:text-gray-300">
          {item.online ? "Online" : "Offline"}
        </span>
        {item.lastSeenMs != null && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            &middot; seen{" "}
            <DateToSince
              date={new Date(item.lastSeenMs).toISOString()}
              currentDate={currentDate}
            />
          </span>
        )}
      </div>

      {/* Broadcast interval */}
      {item.broadcastIntervalSecs != null && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Broadcast interval: {item.broadcastIntervalSecs}s
        </div>
      )}

      {/* View node link */}
      <Link
        to={`/nodes/${item.id}`}
        className="inline-block text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        View full node details &rarr;
      </Link>

      {/* Neighbors heard */}
      <div>
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Neighbors heard ({item.neighborsHeard.length})
        </div>
        {item.neighborsHeard.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            No neighbors heard.
          </div>
        ) : (
          <div className="space-y-1">
            {item.neighborsHeard.map((nb) => (
              <Link
                key={`detail-heard-${item.id}-${nb.id}`}
                to={`/nodes/${nb.id}`}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm
                  bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-gray-900 dark:text-gray-100 truncate">
                  {nb.shortname || nb.id}
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  SNR: {nb.snr}
                  {nb.distanceKm != null && (
                    <span className="ml-2">{nb.distanceKm.toFixed(2)} km</span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Heard by */}
      <div>
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Heard by ({item.heardBy.length})
        </div>
        {item.heardBy.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Not heard by any neighbor.
          </div>
        ) : (
          <div className="space-y-1">
            {item.heardBy.map((nb) => (
              <Link
                key={`detail-by-${item.id}-${nb.id}`}
                to={`/nodes/${nb.id}`}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm
                  bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-gray-900 dark:text-gray-100 truncate">
                  {nb.shortname || nb.id}
                </span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  SNR: {nb.snr}
                  {nb.distanceKm != null && (
                    <span className="ml-2">{nb.distanceKm.toFixed(2)} km</span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview Panel (when no node is selected)                          */
/* ------------------------------------------------------------------ */

function NeighborsOverviewPanel({
  items,
  nodesTotal,
}: {
  items: NeighborListItem[];
  nodesTotal: number;
}) {
  const totalHeardLinks = useMemo(
    () => items.reduce((sum, i) => sum + i.neighborsHeard.length, 0),
    [items],
  );

  const totalHeardByLinks = useMemo(
    () => items.reduce((sum, i) => sum + i.heardBy.length, 0),
    [items],
  );

  const avgHeard = items.length > 0 ? (totalHeardLinks / items.length).toFixed(1) : "0";
  const avgHeardBy = items.length > 0 ? (totalHeardByLinks / items.length).toFixed(1) : "0";

  // Top heard nodes
  const topHeard = useMemo(
    () =>
      [...items]
        .sort((a, b) => b.neighborsHeard.length - a.neighborsHeard.length)
        .slice(0, 5),
    [items],
  );

  // Top heard-by nodes
  const topHeardBy = useMemo(
    () =>
      [...items]
        .sort((a, b) => b.heardBy.length - a.heardBy.length)
        .slice(0, 5),
    [items],
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Neighbors Overview
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Select a node from the list to see its neighbor details.
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {items.length}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Nodes w/ neighbors
          </div>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {nodesTotal}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Total nodes seen
          </div>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {avgHeard}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Avg heard
          </div>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-2">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {avgHeardBy}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Avg heard by
          </div>
        </div>
      </div>

      {/* Top heard */}
      <div>
        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Most neighbors heard
        </div>
        <div className="space-y-1">
          {topHeard.map((item) => (
            <Link
              key={`top-heard-${item.id}`}
              to={`/nodes/${item.id}`}
              className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm
                bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              <span className="text-gray-900 dark:text-gray-100 truncate">
                {item.node?.shortname ?? item.id}
              </span>
              <span className="shrink-0 text-xs font-medium text-gray-600 dark:text-gray-400 tabular-nums">
                {item.neighborsHeard.length}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Top heard by */}
      <div>
        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Most heard by others
        </div>
        <div className="space-y-1">
          {topHeardBy.map((item) => (
            <Link
              key={`top-by-${item.id}`}
              to={`/nodes/${item.id}`}
              className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm
                bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              <span className="text-gray-900 dark:text-gray-100 truncate">
                {item.node?.shortname ?? item.id}
              </span>
              <span className="shrink-0 text-xs font-medium text-gray-600 dark:text-gray-400 tabular-nums">
                {item.heardBy.length}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Row component for the Virtuoso list                                */
/* ------------------------------------------------------------------ */

function NeighborRow({
  item,
  selected,
  onSelect,
}: {
  item: NeighborListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const n = item.node;
  const isUnk = (n?.shortname ?? "UNK") === "UNK";

  return (
    <button
      type="button"
      className={[
        "w-full text-left px-3 sm:px-4 py-3 border-b border-gray-100 dark:border-gray-800/60 transition",
        selected
          ? "bg-indigo-50/70 dark:bg-indigo-950/30 border-l-2 border-l-indigo-500"
          : "hover:bg-gray-50/80 dark:hover:bg-gray-800/30 border-l-2 border-l-transparent",
      ].join(" ")}
      onClick={() => onSelect(item.id)}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <Avatar id={item.id} size={20} className="shrink-0 mt-0.5" />

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Top row: name + status */}
          <div className="flex items-center gap-2">
            <span
              className={[
                "font-medium text-sm truncate",
                isUnk
                  ? "text-gray-400 dark:text-gray-500"
                  : "text-gray-900 dark:text-gray-100",
              ].join(" ")}
            >
              {n?.shortname ?? "UNK"}
            </span>
            <span
              className={[
                "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                item.online ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600",
              ].join(" ")}
            />
            {n?.longname && n.longname !== n?.shortname && (
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {n.longname}
              </span>
            )}
          </div>

          {/* Neighbor counts */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <span className="tabular-nums">
              Heard: <span className="font-medium text-gray-700 dark:text-gray-300">{item.neighborsHeard.length}</span>
            </span>
            <span className="tabular-nums">
              Heard by: <span className="font-medium text-gray-700 dark:text-gray-300">{item.heardBy.length}</span>
            </span>
            {item.broadcastIntervalSecs != null && (
              <span className="tabular-nums">
                Interval: {item.broadcastIntervalSecs}s
              </span>
            )}
          </div>

          {/* Inline neighbor previews (first 3) */}
          {item.neighborsHeard.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {item.neighborsHeard.slice(0, 4).map((nb) => (
                <span
                  key={`preview-${item.id}-${nb.id}`}
                  className="inline-flex items-center gap-1 rounded-md bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-400"
                >
                  {nb.shortname || "UNK"}
                  <span className="text-gray-400 dark:text-gray-500 tabular-nums">
                    {nb.snr}
                  </span>
                </span>
              ))}
              {item.neighborsHeard.length > 4 && (
                <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  +{item.neighborsHeard.length - 4}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: last seen */}
        <div className="shrink-0 text-right">
          {item.lastSeenMs != null && (
            <div className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums whitespace-nowrap">
              {new Date(item.lastSeenMs).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Neighbors page                                                */
/* ------------------------------------------------------------------ */

export const Neighbors = () => {
  // Live toggle
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

  const nodes = useMemo(() => (nodesRaw ?? {}) as any, [nodesRaw]);

  // UI state
  const [qInput, setQInput] = useState("");
  const qDeferred = useDeferredValue(qInput);

  const [sortBy, setSortBy] = useState<SortByKey>("seen");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [selectedId, setSelectedId] = useState<string>("");

  // Build list items
  const allItems: NeighborListItem[] = useMemo(() => {
    const out: NeighborListItem[] = [];
    const entries = Object.entries(nodes as any);

    for (const [, n] of entries) {
      const raw = n as any;
      if (!raw?.active) continue;
      if (!raw?.neighborinfo || !raw.neighborinfo.neighbors) continue;

      const rawId = String(raw.id ?? "");
      const id = cleanNodeId(rawId);
      if (!id) continue;

      const online = isNodeOnline(raw);
      const lastSeenMs = safeLastSeenMs(raw.last_seen);

      // Build "neighbors heard" from this node's neighborinfo
      const neighborsHeard: NeighborListItem["neighborsHeard"] = (
        raw.neighborinfo.neighbors ?? []
      ).map((nb: NeighborEntry) => {
        const nbHex = convertNodeIdFromIntToHex(nb.node_id);
        const nbNode = nodes[nbHex];
        return {
          id: nbHex,
          shortname: nbNode?.shortname ?? "UNK",
          snr: nb.snr,
          distanceKm: nb.distance ?? null,
        };
      });

      // Build "heard by" — other nodes whose neighborinfo includes this node
      const heardBy: NeighborListItem["heardBy"] = [];
      for (const [, otherNode] of entries) {
        const other = otherNode as any;
        if (!other?.neighborinfo?.neighbors) continue;
        for (const nb of other.neighborinfo.neighbors) {
          if (convertNodeIdFromIntToHex(nb.node_id) === id) {
            const othClean = cleanNodeId(String(other.id ?? ""));
            const dist = calculateDistanceBetweenNodes(
              nodes[othClean],
              nodes[id],
            );
            heardBy.push({
              id: othClean,
              shortname: other.shortname ?? "UNK",
              snr: nb.snr,
              distanceKm: dist ?? null,
            });
          }
        }
      }

      out.push({
        id,
        rawId,
        node: raw,
        online,
        lastSeenMs,
        neighborsHeard,
        heardBy,
        broadcastIntervalSecs:
          raw.neighborinfo.node_broadcast_interval_secs ?? null,
      });
    }
    return out;
  }, [nodes]);

  // Filter + sort
  const filteredItems = useMemo(() => {
    let items = [...allItems];

    // Search
    const q = qDeferred.trim().toLowerCase();
    if (q) {
      items = items.filter((x) => {
        const n: any = x.node;
        const s = `${x.id} ${String(n?.shortname ?? "")} ${String(
          n?.longname ?? "",
        )}`.toLowerCase();
        return s.includes(q);
      });
    }

    // Sort
    const dirMul = sortDir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      if (sortBy === "seen") {
        return ((a.lastSeenMs ?? -1) - (b.lastSeenMs ?? -1)) * dirMul;
      }
      if (sortBy === "name") {
        const an = String((a.node as any)?.shortname ?? "").toLowerCase();
        const bn = String((b.node as any)?.shortname ?? "").toLowerCase();
        return an.localeCompare(bn) * dirMul;
      }
      if (sortBy === "heard") {
        return (a.neighborsHeard.length - b.neighborsHeard.length) * dirMul;
      }
      if (sortBy === "heardBy") {
        return (a.heardBy.length - b.heardBy.length) * dirMul;
      }
      return 0;
    });

    return items;
  }, [allItems, qDeferred, sortBy, sortDir]);

  // Selection
  const selectedItem = useMemo(
    () => (selectedId ? filteredItems.find((x) => x.id === selectedId) ?? null : null),
    [filteredItems, selectedId],
  );

  const onSelect = useCallback((id: string) => setSelectedId(id), []);
  const clearSelection = useCallback(() => setSelectedId(""), []);

  // Mobile sheets
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

  // Auto-open details on mobile when selection changes
  const prevSelRef = useRef<string>("");
  useEffect(() => {
    if (isLgUp) return;
    const prev = prevSelRef.current;
    prevSelRef.current = selectedId;
    if (selectedId && selectedId !== prev) setMobileSheet("details");
  }, [selectedId, isLgUp]);

  // Virtuoso ref
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  // Export
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen || !isLgUp) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (exportMenuRef.current && !exportMenuRef.current.contains(t))
        setExportOpen(false);
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

  // Live pill
  const livePillText = liveEnabled ? "Live" : "Live off";
  const livePillTitle = liveEnabled
    ? "Live mode is on. Auto-refresh polls every 5 seconds (paused when tab is unfocused). Click to disable."
    : "Live mode is off. Auto-refresh is disabled. Click to enable.";

  // Export rows
  const exportRows = useMemo(() => {
    return filteredItems.map((x) => ({
      id: x.id,
      shortname: String(x.node?.shortname ?? ""),
      longname: String(x.node?.longname ?? ""),
      online: x.online ? "true" : "false",
      last_seen: x.node?.last_seen
        ? new Date(x.node.last_seen).toISOString()
        : "",
      neighbors_heard: x.neighborsHeard.length,
      heard_by: x.heardBy.length,
      broadcast_interval_secs: x.broadcastIntervalSecs ?? "",
      neighbors_heard_list: x.neighborsHeard
        .map((nb) => `${nb.shortname}(${nb.snr})`)
        .join("; "),
      heard_by_list: x.heardBy
        .map((nb) => `${nb.shortname}(${nb.snr})`)
        .join("; "),
    }));
  }, [filteredItems]);

  const exportFilenameBase = useMemo(() => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `neighbors_${ts}`;
  }, []);

  const doExportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
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

  // Filter status
  const hasFilters = qDeferred.trim().length > 0 || sortBy !== "seen" || sortDir !== "desc";

  const clearFilters = useCallback(() => {
    setQInput("");
    setSortBy("seen");
    setSortDir("desc");
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTyping =
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

      if (!isTyping && e.key === "/") {
        e.preventDefault();
        const el = document.getElementById(
          "neighbors-search",
        ) as HTMLInputElement | null;
        el?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileSheet, selectedId, clearSelection, hasFilters, clearFilters]);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (!nodesRaw) {
    return <div className="p-4">Loading…</div>;
  }

  return (
    <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
      {/* Sticky header */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Neighbors
              </h1>

              {/* Desktop meta row */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  Updated:{" "}
                  <span className="font-medium tabular-nums">
                    {dataUpdatedAt && dataUpdatedAt > 0
                      ? new Date(dataUpdatedAt).toLocaleString()
                      : new Date().toLocaleString()}
                  </span>
                </span>
                <span className="opacity-60">&bull;</span>
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                  aria-busy={manualRefreshing || isFetching}
                  title={
                    manualRefreshing || isFetching
                      ? "Refreshing…"
                      : "Refresh now"
                  }
                >
                  refresh
                </button>
                <span className="opacity-60">&bull;</span>
                <button
                  type="button"
                  className={[
                    "rounded-full px-2 py-0.5 text-[11px] font-medium border transition",
                    liveEnabled
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                  ].join(" ")}
                  onClick={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                >
                  {livePillText}
                </button>
                <span className="opacity-60">&bull;</span>
                <HeardBy />
              </div>

              {/* Mobile meta row */}
              <div className="mt-1 flex sm:hidden flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="font-medium tabular-nums">
                  {dataUpdatedAt && dataUpdatedAt > 0
                    ? new Date(dataUpdatedAt).toLocaleString()
                    : new Date().toLocaleString()}
                </span>
                <span className="opacity-60">&bull;</span>
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                  aria-busy={manualRefreshing || isFetching}
                >
                  refresh
                </button>
                <span className="opacity-60">&bull;</span>
                <button
                  type="button"
                  className={[
                    "rounded-full px-2 py-0.5 text-[11px] font-medium border transition",
                    liveEnabled
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
                exportRowsCount={exportRows.length}
                doExportCsv={doExportCsv}
                doExportJson={doExportJson}
                exportMenuRef={exportMenuRef}
              />
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyLink}
                title="Copy a shareable link"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-[260px]">
              <input
                id="neighbors-search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search neighbors… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            {/* Desktop filters */}
            <div className="hidden lg:flex flex-wrap gap-2 items-center">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortByKey)}
                className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                title="Sort by"
              >
                <option value="seen">Last seen</option>
                <option value="name">Shortname</option>
                <option value="heard">Neighbors heard</option>
                <option value="heardBy">Heard by</option>
              </select>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                }
                title="Toggle sort direction"
              >
                {sortDir === "desc" ? "Desc" : "Asc"}
              </button>

              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {hasFilters ? "filtered" : "no filters"}
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

          {/* Status chips: desktop */}
          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-[30px]">
            <StatusChip
              label={`Sort: ${sortBy}/${sortDir}`}
              active={sortBy !== "seen" || sortDir !== "desc"}
              title="Click to reset sort"
              onClick={() => {
                setSortBy("seen");
                setSortDir("desc");
              }}
            />
            <StatusChip
              label={
                qDeferred.trim()
                  ? `Search: ${qDeferred.trim()}`
                  : "Search"
              }
              active={qDeferred.trim().length > 0}
              title="Click to clear search"
              onClick={() => setQInput("")}
            />
            <StatusChip
              label={
                selectedId
                  ? `Selected: ${selectedId}`
                  : "Selected: none"
              }
              active={!!selectedId}
              title="Click to clear selection"
              onClick={clearSelection}
            />
          </div>
        </div>
      </div>

      {/* Main body */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* Left: list */}
            <div className="lg:col-span-2 min-h-0 flex flex-col h-full">
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Card wrapper */}
                <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
                  {/* List header */}
                  <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50">
                    <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                      {filteredItems.length} shown (out of{" "}
                      {Object.keys(nodes as any).length} seen)
                    </span>
                  </div>

                  {/* Virtuoso list */}
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <Virtuoso
                      ref={(r) => {
                        (virtuosoRef as any).current = r;
                      }}
                      style={{ flex: 1, minHeight: 0, height: "100%" }}
                      data={filteredItems}
                      overscan={600}
                      itemContent={(_index, item) => (
                        <NeighborRow
                          item={item}
                          selected={item.id === selectedId}
                          onSelect={onSelect}
                        />
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Right: overview or details (desktop) */}
            <div className="hidden lg:flex lg:col-span-1 flex-col min-h-0 h-full overflow-y-auto">
              <div className="min-h-0">
                {selectedItem ? (
                  <NeighborDetailPanel
                    item={selectedItem}
                    nodes={nodes}
                    onClearSelection={clearSelection}
                  />
                ) : (
                  <NeighborsOverviewPanel
                    items={filteredItems}
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
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="mb-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/85 backdrop-blur shadow-sm overflow-hidden">
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
                  setMobileSheet((s) =>
                    s === "controls" ? null : "controls",
                  )
                }
              >
                Controls
                {hasFilters && (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200">
                    !
                  </span>
                )}
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
                  setMobileSheet((s) =>
                    s === "details" ? null : "details",
                  )
                }
              >
                Details
                {selectedId && (
                  <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-indigo-600 text-white">
                    1
                  </span>
                )}
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
            Sort, search, and export neighbor data.
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sort by
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortByKey)}
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
              >
                <option value="seen">Last seen</option>
                <option value="name">Shortname</option>
                <option value="heard">Neighbors heard</option>
                <option value="heardBy">Heard by</option>
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
                  setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                }
              >
                {sortDir === "desc" ? "Descending" : "Ascending"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={doManualRefresh}
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
              onClick={doExportCsv}
            >
              Export CSV ({exportRows.length})
            </button>

            <button
              type="button"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={doExportJson}
            >
              Export JSON ({exportRows.length})
            </button>

            {hasFilters && (
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-red-300/70 dark:border-red-800/70 text-red-700 dark:text-red-200 hover:bg-red-50/60 dark:hover:bg-red-900/20 transition"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
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
        title={selectedItem ? "Neighbor details" : "Overview"}
        onClose={() => setMobileSheet(null)}
      >
        {selectedItem ? (
          <NeighborDetailPanel
            item={selectedItem}
            nodes={nodes}
            onClearSelection={() => {
              clearSelection();
              setMobileSheet(null);
            }}
          />
        ) : (
          <NeighborsOverviewPanel
            items={filteredItems}
            nodesTotal={Object.keys(nodes as any).length}
          />
        )}
      </MobileSheet>
    </div>
  );
};
