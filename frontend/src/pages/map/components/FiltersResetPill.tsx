import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";

import { NodeRole, roleTitles } from "../../../types";
import type { LinkMode } from "../lib/types";

/**
 * Bottom-left indicator for applied filters. Collapsed it shows the count;
 * expanding lists each active filter as its own dismissible chip, plus a
 * bulk reset. Cluster state is excluded — it's a display mode, not a filter.
 */
export function FiltersResetPill({
  recentDays,
  setRecentDays,
  linkMode,
  setLinkMode,
  roleFilter,
  setRoleFilter,
  channelFilter,
  setChannelFilter,
  onOpenFilters,
  hidden = false,
}: {
  recentDays: number;
  setRecentDays: Dispatch<SetStateAction<number>>;
  linkMode: LinkMode;
  setLinkMode: Dispatch<SetStateAction<LinkMode>>;
  roleFilter: number | null;
  setRoleFilter: Dispatch<SetStateAction<number | null>>;
  channelFilter: string | null;
  setChannelFilter: Dispatch<SetStateAction<string | null>>;
  /** Called when the pill is clicked with no filters applied — opens the
   *  settings panel on the Filters section so the user can pick one. */
  onOpenFilters?: () => void;
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  type Chip = { key: string; label: string; clear: () => void };
  const chips: Chip[] = [];
  if (recentDays !== 30) {
    chips.push({
      key: "recentDays",
      label: `Last ${recentDays}d`,
      clear: () => setRecentDays(30),
    });
  }
  if (linkMode !== "selected") {
    chips.push({
      key: "linkMode",
      label: linkMode === "all" ? "All links" : "My Node links",
      clear: () => setLinkMode("selected"),
    });
  }
  if (roleFilter != null) {
    chips.push({
      key: "role",
      label: `Role: ${roleTitles[roleFilter as NodeRole]?.title ?? roleFilter}`,
      clear: () => setRoleFilter(null),
    });
  }
  if (channelFilter != null) {
    chips.push({
      key: "channel",
      label: `Ch ${channelFilter}`,
      clear: () => setChannelFilter(null),
    });
  }

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-close when the last chip clears out from underneath us.
  useEffect(() => {
    if (chips.length === 0 && open) setOpen(false);
  }, [chips.length, open]);

  const resetAll = () => {
    setRecentDays(30);
    setLinkMode("selected");
    setRoleFilter(null);
    setChannelFilter(null);
  };

  const hasFilters = chips.length > 0;

  return (
    <div
      ref={ref}
      // Below lg, --map-pad is 0 and the bottom-left corner belongs to the
      // Animations toggle (bottom-3 left-3) — stack above it instead of on it.
      // hidden hides through lg (not just sm): tool flows own this strip below
      // lg too (trace corridors panel reaches down to sm:bottom-16).
      className={`fixed bottom-14 left-3 lg:bottom-4 lg:left-[calc(var(--map-pad)+1rem)] z-1100 transition-[left] duration-200 ${hidden ? "max-lg:hidden" : ""}`}
    >
      {open && hasFilters && (
        <div id="active-filters-popover" className="mb-2 w-56 rounded-xl p-2 space-y-1
          bg-gray-900/95 backdrop-blur-xl border border-white/10 shadow-2xl">
          <div className="text-[9px] uppercase tracking-wider text-gray-500 font-medium px-1 pb-0.5">
            Active filters
          </div>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.clear}
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg
                bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 text-xs
                hover:bg-cyan-500/25 hover:border-cyan-500/50 transition-colors"
              title={`Clear — ${c.label}`}
              aria-label={`Remove filter: ${c.label}`}
            >
              <span className="truncate text-left">{c.label}</span>
              <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              onClick={resetAll}
              className="w-full mt-1 px-2 py-1 rounded-lg text-[11px] text-gray-400
                hover:bg-white/5 hover:text-gray-200 transition-colors"
            >
              Reset all
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (hasFilters) setOpen((v) => !v);
          else onOpenFilters?.();
        }}
        aria-expanded={hasFilters ? open : undefined}
        aria-controls={hasFilters ? "active-filters-popover" : undefined}
        title={
          hasFilters
            ? `${chips.length} ${chips.length === 1 ? "filter" : "filters"} applied — click to manage`
            : "No filters applied — click to configure"
        }
        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium shadow-2xl
          transition-colors flex items-center gap-1.5
          ${
            hasFilters
              ? "bg-cyan-950/95 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/95"
              : "bg-gray-900/95 border border-white/10 text-gray-400 hover:bg-gray-900 hover:text-gray-200"
          }`}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        <span>
          {hasFilters
            ? (chips.length === 1 ? chips[0].label : `${chips.length} filters`)
            : "No filters"}
        </span>
        {hasFilters && (
          <svg
            className={`w-3 h-3 text-cyan-300/70 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        )}
      </button>
    </div>
  );
}
