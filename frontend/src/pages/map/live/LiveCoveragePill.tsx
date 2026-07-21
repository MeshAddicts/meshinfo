/** Live-coverage toggle pill: show/hide + opacity + freshness. Top-right on lg+
 * (left of the mesh-health pill); below lg it drops to a second row below the
 * hamburger — the top row is too crowded and it collided with search/tools (#537).
 * The top row only has room once the lg nav rail applies (clear from ~822px). */
import { useEffect, useId, useRef, useState } from "react";

import { relativeTime } from "../lib/helpers";
import { presetShortLabel } from "./liveCoveragePresets";
import type { CoverageMeta, ServerCoverageStatus } from "./useServerCoverageTiles";

export interface LiveCoveragePillProps {
  enabled: boolean;
  onToggle: () => void;
  status: ServerCoverageStatus;
  meta: CoverageMeta | null;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  hideNodes: boolean;
  onHideNodesChange: (hide: boolean) => void;
  /** Selected pyramid: "all" or a modem-preset id. */
  group: string;
  onGroupChange: (group: string) => void;
  /** Hide on mobile (like MapSettingsPanel/FiltersResetPill) — the tool-pick
   * prompt occupies the same top-14 row there. */
  hidden?: boolean;
}

export function LiveCoveragePill({
  enabled,
  onToggle,
  status,
  meta,
  opacity,
  onOpacityChange,
  hideNodes,
  onHideNodesChange,
  group,
  onGroupChange,
  hidden = false,
}: LiveCoveragePillProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const unavailable = status === "unavailable";
  const loading = status === "loading" && !meta;
  const dot = unavailable
    ? "bg-gray-600"
    : !enabled
      ? "bg-gray-500"
      : loading
        ? "bg-cyan-400"
        : "bg-emerald-400 animate-pulse";
  const title = unavailable
    ? enabled
      ? "Live coverage unavailable (worker offline?) — click to switch off"
      : "Live coverage not available (not baked yet)"
    : enabled
      ? "Live network coverage on — click to hide"
      : "Live network coverage — click to show";

  return (
    <div
      ref={wrapRef}
      className={`fixed top-14 right-3 lg:top-3 lg:right-72 z-30 flex flex-col items-end ${hidden ? "max-sm:hidden" : ""}`}
    >
      <div className="flex items-center rounded-xl bg-gray-900/80 backdrop-blur-xl border border-white/10 shadow-2xl">
        <button
          type="button"
          onClick={onToggle}
          disabled={unavailable && !enabled}
          aria-pressed={enabled}
          title={title}
          className="flex items-center gap-2 px-2 sm:px-3 py-1.5 text-xs font-medium text-gray-200
            hover:text-gray-100 transition-colors disabled:opacity-60 disabled:cursor-default"
        >
          {loading ? (
            <span className="h-2.5 w-2.5 rounded-full border border-white/30 border-t-cyan-300 animate-spin" aria-hidden="true" />
          ) : (
            <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
          )}
          <span>Coverage</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label="Live coverage options"
          title="Live coverage options"
          className="px-1.5 py-1.5 text-gray-400 hover:text-gray-200 border-l border-white/10 transition-colors"
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Live coverage options"
          className="mt-2 w-60 rounded-xl p-3 bg-gray-900/90 backdrop-blur-xl border border-white/10 shadow-2xl space-y-3 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="text-gray-300 font-medium">Live coverage</span>
            {meta ? (
              <span className="text-gray-500 tabular-nums">{meta.nodeCount} nodes</span>
            ) : (
              <span className="text-gray-600">{unavailable ? "not baked" : "loading…"}</span>
            )}
          </div>
          {meta && (
            <p className="text-[11px] text-gray-500 -mt-1">
              Updated {relativeTime(meta.generatedAt)} · heard ≤ {meta.recencyHours} h
            </p>
          )}

          {/* Modem-preset pyramids — shown once there's more than one mesh to pick. */}
          {meta && meta.groups.length > 2 && (
            <div className="space-y-1">
              <span className="uppercase tracking-wider text-[10px] text-gray-500">Modem preset</span>
              <div className="flex flex-wrap gap-1">
                {meta.groups.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => onGroupChange(g)}
                    aria-pressed={group === g}
                    title={g === "all" ? "Every mesh combined" : `${g} mesh only`}
                    className={`px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
                      group === g
                        ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200"
                        : "bg-white/5 border-white/10 text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {g === "all" ? "All" : presetShortLabel(g)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between text-gray-500">
              <span className="uppercase tracking-wider text-[10px]">Opacity</span>
              <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
              className="w-full accent-cyan-500"
              aria-label="Live coverage opacity"
            />
          </div>

          <label className="flex items-center justify-between gap-2 cursor-pointer text-gray-400">
            <span>Hide node markers</span>
            <input
              type="checkbox"
              checked={hideNodes}
              onChange={(e) => onHideNodesChange(e.target.checked)}
              className="w-3 h-3 accent-cyan-500 cursor-pointer"
            />
          </label>

          <p className="text-[10px] text-gray-600 leading-snug">
            Coverage assumes a stock handheld at chest height. 
            Every positioned node heard recently contributes (ITM model). Router-class TX
            33 dBm, others 22 dBm; antenna height from reported altitude (min 6 m). Estimate only. 
            Inclusion requires position data. Does not include shipping and handling. 
            No CODs. Offer not valid in all states. No purchase necessary. Terms and conditions may apply. 
            Objects in mirror are closer than they appear. Please mesh responsibly. 
          </p>
        </div>
      )}
    </div>
  );
}
