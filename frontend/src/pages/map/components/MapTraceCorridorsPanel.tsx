/** Traceroute corridors panel: the mesh's busiest observed links, ranked by
 *  how many runs traverse them. Hover spotlights the link; click opens the
 *  traceroute analysis for that pair. */
import { memo, useEffect, useState } from "react";

import { unwrapLngTo } from "../lib/geo";
import { relativeTime } from "../lib/helpers";
import { tsToMs } from "../lib/pathAnalysis";
import { Segmented } from "./Segmented";

export interface TraceCorridor {
  aId: string;
  bId: string;
  aLabel: string;
  bLabel: string;
  aPos: [number, number];
  bPos: [number, number];
  count: number;
  distanceKm: number;
  lastTimestamp: number;
}

export type CorridorSort = "busiest" | "longest";

function MapTraceCorridorsPanelInner({
  corridors,
  sortMode,
  onSortModeChange,
  inViewOnly,
  onToggleInView,
  activePair,
  hideOnMobile,
  onHover,
  onPick,
}: {
  corridors: TraceCorridor[];
  sortMode: CorridorSort;
  onSortModeChange: (v: CorridorSort) => void;
  inViewOnly: boolean;
  onToggleInView: (v: boolean) => void;
  /** Normalized [from, to] of the open analysis, for row highlighting. */
  activePair: [string, string] | null;
  /** The result bottom sheet owns small screens — yield to it there. */
  hideOnMobile: boolean;
  onHover: (coords: [number, number][] | null) => void;
  onPick: (aId: string, bId: string) => void;
}) {
  // Bars scale to the active metric's max (the list isn't count-sorted in
  // longest mode, so "first row" is not "biggest count").
  const maxCount = corridors.reduce((m, c) => Math.max(m, c.count), 0) || 1;
  const maxKm = corridors.reduce((m, c) => Math.max(m, c.distanceKm), 0) || 1;
  const activeKey = activePair
    ? [...activePair].sort().join("|")
    : null;
  const [collapsed, setCollapsed] = useState(false);

  // A row hidden or unmounted mid-hover never fires mouseleave — don't leave
  // its spotlight stuck on the map.
  useEffect(() => () => onHover(null), [onHover]);

  return (
    <div
      className={`fixed z-1040 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl flex flex-col
        inset-x-0 bottom-0 rounded-t-2xl max-h-[38dvh]
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:left-[calc(var(--map-pad)+1rem)] sm:top-16 sm:bottom-16 sm:w-72
        sm:rounded-xl sm:max-h-none
        sm:animate-[slideInLeft_220ms_ease-out]
        ${collapsed ? "sm:bottom-auto" : ""}
        ${hideOnMobile ? "max-lg:hidden" : ""}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
          Top Links
          {corridors.length > 0 && !collapsed && (
            <span className="normal-case tracking-normal text-gray-600 ml-1.5">top {corridors.length}</span>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={inViewOnly}
              onChange={(e) => onToggleInView(e.target.checked)}
              className="accent-cyan-500 w-3 h-3"
            />
            in view
          </label>
          <button
            type="button"
            onClick={() => {
              onHover(null); // a hovered row is about to disappear
              setCollapsed((v) => !v);
            }}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand top links" : "Collapse top links"}
            className="p-0.5 rounded text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${collapsed ? "" : "rotate-180"}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="px-1.5 pt-1.5 shrink-0">
          <Segmented
            ariaLabel="Rank links by"
            value={sortMode}
            onChange={onSortModeChange}
            options={[
              { value: "busiest", label: "Busiest", title: "Most traversed by observed runs" },
              { value: "longest", label: "Longest", title: "Greatest hop distance" },
            ]}
          />
        </div>
      )}

      {!collapsed && (
      <div className="p-1.5 overflow-y-auto overscroll-contain flex-1 min-h-0 space-y-0.5">
        {corridors.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-gray-500">
            No observed links {inViewOnly ? "in view — pan out or untick “in view”." : "yet."}
          </div>
        ) : (
          corridors.map((c) => {
            const isActive = activeKey === `${c.aId}|${c.bId}`;
            const coords: [number, number][] = [c.aPos, [unwrapLngTo(c.aPos[0], c.bPos[0]), c.bPos[1]]];
            return (
              <button
                key={`${c.aId}|${c.bId}`}
                type="button"
                onClick={() => onPick(c.aId, c.bId)}
                onMouseEnter={() => onHover(coords)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(coords)}
                onBlur={() => onHover(null)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors
                  focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 ${
                    isActive
                      ? "bg-cyan-500/15 border border-cyan-500/30"
                      : "border border-transparent hover:bg-white/10"
                  }`}
                title={`Analyze ${c.aLabel} ↔ ${c.bLabel}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-gray-200 truncate">
                    {c.aLabel}
                    <span className="text-gray-500 mx-1">↔</span>
                    {c.bLabel}
                  </div>
                  <div className="mt-1 h-1 rounded bg-white/10">
                    <div
                      className="h-1 rounded bg-cyan-500/70"
                      style={{
                        width: `${Math.max(6, Math.round((sortMode === "longest" ? c.distanceKm / maxKm : c.count / maxCount) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] tabular-nums">
                    <span className="text-cyan-300">{c.count}×</span>
                    <span className="text-gray-500"> · {c.distanceKm >= 10 ? c.distanceKm.toFixed(0) : c.distanceKm.toFixed(1)} km</span>
                  </div>
                  <div className="text-[9px] text-gray-500 tabular-nums">
                    {c.lastTimestamp ? relativeTime(new Date(tsToMs(c.lastTimestamp)).toISOString()) : ""}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
      )}
    </div>
  );
}

/** Memoized: the Map page re-renders far more often than these props change. */
export const MapTraceCorridorsPanel = memo(MapTraceCorridorsPanelInner);
