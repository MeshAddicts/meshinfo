import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { Avatar } from "../../components/Avatar";
import { DateToSince } from "../../components/DateSince";
import { HardwareImg } from "../../components/HardwareImg";
import { TimeTickerProvider } from "../../components/TimeTickerContext";
import { HardwareModel, INode } from "../../types";
import { getTelemetrySnapshot, roleLabel } from "./nodesUtils";

export type NodeListItem = {
  id: string; // cleaned (no leading "!")
  rawId: string; // original (might include "!")
  node: INode;
  online: boolean;
  lastSeenMs: number | null;
  hasPosition: boolean;
  dxKm: number | null;
  batteryPct: number | null;
  voltage: number | null;
  airTx: number | null;
  chanUtil: number | null;
  role: any;
  hardware: any;
};

function pillClass(active: boolean) {
  return [
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border",
    active
      ? "bg-emerald-600 text-white border-emerald-600"
      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
  ].join(" ");
}

const EDGE_BUFFER = 2;

export function NodesList({
  items,
  selectedId,
  flashId,
  scrollToId,
  liveEnabled = true,
  onSelect,
  onClearSelection,
  onAtTopChange,
  totalSeen,
}: {
  items: NodeListItem[];
  selectedId: string;
  flashId?: string;
  /** When set, the list scrolls to this node id and clears via onScrollComplete */
  scrollToId?: string;
  liveEnabled?: boolean;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  onAtTopChange?: (atTop: boolean) => void;
  totalSeen: number;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // "Seen X sec" counters tick via TimeTickerProvider below; only the date span
  // (via context) re-renders, not the whole memoized row.

  // Track whether we're at the top of the list
  const [atTop, setAtTop] = useState(true);
  const onAtTopChangeRef = useRef(onAtTopChange);
  onAtTopChangeRef.current = onAtTopChange;

  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      const isTop = range.startIndex <= EDGE_BUFFER;
      setAtTop((prev) => {
        if (prev !== isTop) {
          onAtTopChangeRef.current?.(isTop);
        }
        return isTop;
      });
    },
    [],
  );

  // Freeze the item list when paused, scrolled away from top, OR a node is
  // selected, to keep live cache updates (now pushed via SSE) from re-sorting
  // and jumping the user's scroll position. When paused, freezing the view is
  // what makes "live off" actually hold the list still even though the shared
  // node cache keeps updating underneath.
  // Don't freeze until we have data (avoids freezing an empty list on deep links).
  const shouldFreeze = items.length > 0 && (!liveEnabled || !atTop || !!selectedId);
  const frozenRef = useRef<NodeListItem[] | null>(null);

  // Capture/release frozen snapshot after commit (not during render)
  useEffect(() => {
    if (shouldFreeze) {
      if (!frozenRef.current) frozenRef.current = items;
    } else {
      frozenRef.current = null;
    }
  }, [shouldFreeze, items]);

  const displayItems = useMemo(
    () => frozenRef.current ?? items,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-evaluate when freeze state or items change
    [shouldFreeze, items],
  );

  // Track new items arriving while paused
  const [newCount, setNewCount] = useState(0);

  useEffect(() => {
    if (!shouldFreeze) {
      setNewCount(0);
      return;
    }
    // While frozen, diff live items against frozen snapshot
    if (frozenRef.current) {
      const frozenIds = new Set(frozenRef.current.map((x) => x.id));
      const added = items.filter((x) => !frozenIds.has(x.id)).length;
      setNewCount(added);
    }
  }, [items, shouldFreeze]);

  // Scroll-to-node: track pending scroll and attempt on every render + timers
  const scrollDoneRef = useRef<string>("");
  const pendingScrollRef = useRef<string>("");

  // Update pending scroll target after commit
  useEffect(() => {
    if (scrollToId && scrollToId !== scrollDoneRef.current) {
      pendingScrollRef.current = scrollToId;
    } else if (!scrollToId) {
      pendingScrollRef.current = "";
      scrollDoneRef.current = "";
    }
  }, [scrollToId]);

  useEffect(() => {
    const target = pendingScrollRef.current;
    if (!target || scrollDoneRef.current === target) return;

    const idx = displayItems.findIndex((x) => x.id === target);
    if (idx < 0) return;

    scrollDoneRef.current = target;
    pendingScrollRef.current = "";

    // Use Virtuoso scrollToIndex to get the item rendered, then
    // fall back to native DOM scrollIntoView for reliability.
    const scrollViaDOM = () => {
      const el = document.querySelector(`[data-node-id="${target}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
      return false;
    };

    // First: tell Virtuoso to render the area around the target index
    virtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior: "auto" });

    // Then: use DOM scrollIntoView as the reliable fallback
    const timers = [100, 300, 600, 1200, 2500].map((delay) =>
      setTimeout(() => scrollViaDOM(), delay),
    );
    return () => timers.forEach(clearTimeout);
  }); // Run on every render — cheap because it short-circuits immediately when done

  // Jump to top (used by "Back to live" externally via ref isn't needed —
  // we expose it through a simpler pattern: parent sets scrollToId="" or
  // we just provide a jumpToTop callback)

  return (
    <div className="relative rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col min-h-0 flex-1">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm text-gray-800 dark:text-gray-200">
          <span className="font-semibold">{displayItems.length}</span> shown{" "}
          <span className="text-gray-500 dark:text-gray-400">
            (out of {totalSeen} seen)
          </span>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Tip: click a row to pin details
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden relative">
        {/* "Back to live" overlay */}
        {!atTop && (
          <div className="pointer-events-none absolute z-10 left-1/2 -translate-x-1/2 top-3">
            <button
              type="button"
              className="pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-xs border transition
                bg-gray-900 text-white border-gray-900 hover:bg-gray-800
                dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100 dark:hover:bg-gray-200"
              onClick={() => {
                onClearSelection?.();
                frozenRef.current = null;
                virtuosoRef.current?.scrollToIndex({
                  index: 0,
                  align: "start",
                  behavior: "smooth",
                });
              }}
            >
              Back to top{newCount > 0 && ` (${newCount} new)`} <span className="ml-1 opacity-80">&uarr;</span>
            </button>
          </div>
        )}

        <TimeTickerProvider>
          <Virtuoso
            ref={virtuosoRef}
            style={{ flex: 1, minHeight: 0, height: "100%" }}
            data={displayItems}
            computeItemKey={(_index, item) => item.id}
            overscan={600}
            rangeChanged={handleRangeChanged}
            itemContent={(_index, item) => (
              <NodeRow
                item={item}
                isSelected={!!selectedId && item.id === selectedId}
                isFlashing={!!flashId && item.id === flashId}
                onSelect={onSelect}
              />
            )}
          />
        </TimeTickerProvider>
      </div>
    </div>
  );
}

// Memoized so the 1 Hz tick only re-renders the DateToSince span, not the row.
const NodeRow = memo(function NodeRow({
  item,
  isSelected,
  isFlashing,
  onSelect,
}: {
  item: NodeListItem;
  isSelected: boolean;
  isFlashing: boolean;
  onSelect: (id: string) => void;
}) {
  const n: any = item.node as any;
  const telem = getTelemetrySnapshot(item.node);

  const short = String(n?.shortname ?? "UNK");
  const long = String(n?.longname ?? "");
  const role = n?.role;
  const hw = n?.hardware;

  return (
    <button
      type="button"
      data-node-id={item.id}
      onClick={() => onSelect(item.id)}
      className={[
        "w-full text-left px-4 py-3 border-b border-gray-200 dark:border-gray-800 transition",
        "hover:bg-gray-50/70 dark:hover:bg-gray-900/40",
        isFlashing
          ? "animate-pulse ring-2 ring-indigo-400/50 bg-indigo-50/60 dark:bg-indigo-900/20"
          : isSelected
            ? "bg-indigo-50/50 dark:bg-indigo-900/15"
            : "bg-transparent",
      ].join(" ")}
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <Avatar id={item.id} size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {short}
            </div>

            <span className={pillClass(item.online)}>
              {item.online ? "Online" : "Offline"}
            </span>

            {typeof role === "number" ? (
              <span className="hidden sm:inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200">
                {roleLabel(role)}
              </span>
            ) : null}

            <div className="ml-auto hidden sm:flex items-center gap-2">
              {typeof telem.batteryPct === "number" ? (
                <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                  🔋 {Math.round(telem.batteryPct)}%
                </span>
              ) : null}
              {typeof telem.voltage === "number" ? (
                <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                  ⚡ {telem.voltage.toFixed(2)}V
                </span>
              ) : null}
              {item.dxKm != null ? (
                <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                  📡 {item.dxKm.toFixed(1)} km
                </span>
              ) : null}
            </div>
          </div>

          <div className="mt-1 flex items-center gap-2 min-w-0">
            <div className="text-sm text-gray-600 dark:text-gray-400 truncate">
              {long || <span className="opacity-60">no longname</span>}
            </div>

            {hw != null && HardwareModel[hw] ? (
              <span className="ml-auto hidden md:inline-flex items-center">
                <HardwareImg model={hw} />
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
            <span className="tabular-nums">
              Seen <DateToSince date={(n as any)?.last_seen} />
            </span>

            {item.hasPosition ? (
              <span className="opacity-80">📍 has position</span>
            ) : (
              <span className="opacity-50">no position</span>
            )}

          </div>
        </div>
      </div>
    </button>
  );
});
