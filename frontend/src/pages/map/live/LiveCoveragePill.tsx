/** Top-right toggle pill (left of the mesh-health pill): show/hide + opacity + freshness. */
import { useEffect, useId, useRef, useState } from "react";

import type { CoverageMeta, ServerCoverageStatus } from "./useServerCoverageTiles";

export interface LiveCoveragePillProps {
  enabled: boolean;
  onToggle: () => void;
  status: ServerCoverageStatus;
  meta: CoverageMeta | null;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
}

function agoLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function LiveCoveragePill({
  enabled,
  onToggle,
  status,
  meta,
  opacity,
  onOpacityChange,
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
    ? "Live coverage not available (not baked yet)"
    : enabled
      ? "Live network coverage on — click to hide"
      : "Live network coverage — click to show";

  return (
    <div ref={wrapRef} className="fixed top-3 right-40 sm:right-64 z-30 flex flex-col items-end">
      <div className="flex items-center rounded-xl bg-gray-900/80 backdrop-blur-xl border border-white/10 shadow-2xl">
        <button
          type="button"
          onClick={onToggle}
          disabled={unavailable}
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
              Updated {agoLabel(meta.generatedAt)} · heard ≤ {meta.recencyHours} h
            </p>
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

          <p className="text-[10px] text-gray-600 leading-snug">
            Predicted reach of every positioned node heard recently (ITM model). Router-class TX
            33 dBm, others 22 dBm; assumed 6 m antenna. Estimate only.
          </p>
        </div>
      )}
    </div>
  );
}
