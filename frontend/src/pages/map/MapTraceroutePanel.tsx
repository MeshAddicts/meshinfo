import { useEffect, useMemo, useState } from "react";

import { unwrapLngTo } from "./geo";
import { relativeTime } from "./helpers";
import { type AnalyzedPath, tsToMs } from "./pathAnalysis";
import { PathHopList } from "./PathHopList";
import type { IMapNode } from "./types";
import { useBottomSheetGesture } from "./useBottomSheet";
import type { TraceAnalysis, TraceLegVerdict } from "./useTraceCompute";

const VERDICT_STYLE: Record<TraceLegVerdict, string> = {
  clear: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  fresnel: "border-orange-500/30 bg-orange-500/15 text-orange-300",
  blocked: "border-red-500/30 bg-red-500/15 text-red-300",
  gap: "border-white/10 bg-white/5 text-gray-400",
};
const VERDICT_LABEL: Record<TraceLegVerdict, string> = {
  clear: "Clear",
  fresnel: "Fresnel",
  blocked: "Blocked",
  gap: "Not graded",
};

function VerdictBadge({ v }: { v: TraceLegVerdict }) {
  return (
    <span className={`px-1.5 py-px rounded text-[9px] font-medium border shrink-0 ${VERDICT_STYLE[v]}`}>
      {VERDICT_LABEL[v]}
    </span>
  );
}

function snrTint(db: number): string {
  if (db >= 0) return "text-emerald-300";
  if (db >= -10) return "text-amber-300";
  return "text-red-300";
}

export function MapTraceroutePanel({
  fromLabel,
  toLabel,
  fromColor = "#22c55e",
  toColor = "#06b6d4",
  paths,
  selectedSig,
  onSelectPath,
  analysis,
  isComputing,
  analysisError,
  analysisWarning,
  terrain3D,
  onEnableTerrain,
  showDirect,
  onToggleDirect,
  loading,
  liveNodes,
  onNodeSelect,
  onHighlight,
  onClose,
}: {
  fromId?: string;
  toId?: string;
  fromLabel: string;
  toLabel: string;
  fromColor?: string;
  toColor?: string;
  paths: AnalyzedPath[];
  selectedSig: string | null;
  onSelectPath: (sig: string) => void;
  analysis: TraceAnalysis | null;
  isComputing: boolean;
  analysisError: string | null;
  analysisWarning: string | null;
  terrain3D: boolean;
  onEnableTerrain?: () => void;
  showDirect: boolean;
  onToggleDirect: (v: boolean) => void;
  loading?: boolean;
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (id: string) => void;
  /** Spotlight the given path segment on the map (null clears). */
  onHighlight?: (coords: [number, number][] | null) => void;
  onClose: () => void;
}) {
  const selected = useMemo(
    () => paths.find((p) => p.hops.join(">") === selectedSig) ?? paths[0] ?? null,
    [paths, selectedSig],
  );
  const alternates = useMemo(() => {
    const sig = selected ? selected.hops.join(">") : null;
    return paths.filter((p) => p.hops.join(">") !== sig).slice(0, 5);
  }, [paths, selected]);
  const isLatest = selected != null && selected === paths[0];
  // Dossier rows only apply to the path they were computed for
  const legRows = analysis && selected && analysis.sig === selected.hops.join(">") ? analysis.legs : null;

  const [minimized, setMinimized] = useState(false);
  const sheet = useBottomSheetGesture({
    onClose,
    minimized,
    onMinimize: () => setMinimized(true),
    onExpand: () => setMinimized(false),
  });

  // Don't leave a stale spotlight behind when the sheet closes.
  useEffect(() => () => onHighlight?.(null), [onHighlight]);

  const posOf = (id: string): [number, number] | null => {
    const n = liveNodes[id] ?? liveNodes[`!${id}`];
    return n?.map_position ? [n.map_position[0], n.map_position[1]] : null;
  };
  const labelOf = (id: string): string =>
    (liveNodes[id] ?? liveNodes[`!${id}`])?.shortname ?? id.slice(0, 8);
  /** Known-position coords, chain-unwrapped so seam-crossing legs draw short. */
  const toCoords = (ids: string[]): [number, number][] => {
    const out: [number, number][] = [];
    for (const id of ids) {
      const pos = posOf(id);
      if (!pos) continue;
      const prev = out[out.length - 1];
      out.push(prev ? [unwrapLngTo(prev[0], pos[0]), pos[1]] : pos);
    }
    return out;
  };
  const highlightPath = (p: AnalyzedPath) => onHighlight?.(toCoords(p.hops));
  // Chip leave falls back to the whole path (the cursor is still in the card).
  const highlightHop = (p: AnalyzedPath, i: number | null) =>
    i == null ? highlightPath(p) : onHighlight?.(toCoords(p.hops.slice(Math.max(0, i - 1), i + 2)));
  const highlightLeg = (p: AnalyzedPath, i: number | null) =>
    i == null ? highlightPath(p) : onHighlight?.(toCoords(p.hops.slice(i, i + 2)));

  const observedAgo = (ts: number): string | null =>
    ts ? relativeTime(new Date(tsToMs(ts)).toISOString()) : null;

  const totalKm = legRows
    ? legRows.reduce((s, l) => s + (l.distanceKm ?? 0), 0)
    : null;
  const weakest: TraceLegVerdict | null = legRows
    ? legRows.some((l) => l.verdict === "blocked")
      ? "blocked"
      : legRows.some((l) => l.verdict === "fresnel")
        ? "fresnel"
        : legRows.some((l) => l.verdict === "clear")
          ? "clear"
          : "gap"
    : null;

  return (
    <div
      ref={sheet.sheetRef}
      role="dialog"
      aria-label={`Traceroute: ${fromLabel} to ${toLabel}`}
      className="fixed z-1050 flex flex-col shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl max-h-[70dvh]
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(560px,calc(100vw-2rem))]
        sm:rounded-xl sm:max-h-[64vh]">

      <div
        className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none shrink-0"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-white/20" />
      </div>

      <div
        className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 shrink-0 max-sm:touch-none"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            Traceroute
          </span>
          <div className="text-[11px] text-gray-300 truncate">
            <span style={{ color: fromColor }} className="font-medium">{fromLabel}</span>
            <span className="text-gray-500 mx-1.5">→</span>
            <span style={{ color: toColor }} className="font-medium">{toLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors shrink-0"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className={`p-3 overflow-y-auto overscroll-contain flex-1 min-h-0 ${minimized ? "max-sm:hidden" : ""}`}>
        {loading && paths.length === 0 ? (
          <div className="px-2 py-3 text-xs text-gray-500">
            Loading traceroutes…
          </div>
        ) : paths.length === 0 ? (
          <div className="px-2 py-3 text-xs text-gray-500">
            No traceroute has been observed between these nodes yet.
            <div className="mt-1 text-[10px] text-gray-600">
              Routes appear when a traceroute crossing both nodes is heard on the mesh.
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {selected && (
              <div
                className="px-2 py-1.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-xs"
                onMouseEnter={() => highlightPath(selected)}
                onMouseLeave={() => onHighlight?.(null)}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-2">
                    <div className="text-cyan-400 text-[10px] uppercase tracking-wider">
                      {isLatest ? "Latest Route" : "Selected Route"}
                    </div>
                    {weakest && weakest !== "gap" && (
                      <span className="text-[9px] text-gray-500">weakest link:</span>
                    )}
                    {weakest && weakest !== "gap" && <VerdictBadge v={weakest} />}
                  </div>
                  {observedAgo(selected.timestamp) && (
                    <div className="text-[10px] text-gray-500 tabular-nums shrink-0">observed {observedAgo(selected.timestamp)}</div>
                  )}
                </div>
                <div className="text-gray-200">
                  {selected.hopCount} {selected.hopCount === 1 ? "hop" : "hops"}
                  {totalKm != null && totalKm > 0 && <span className="text-gray-500 ml-2">{totalKm.toFixed(1)} km</span>}
                  {selected.count > 1 && <span className="text-gray-500 ml-2">seen {selected.count}×</span>}
                  {selected.snr != null && <span className="text-gray-500 ml-2">rx SNR {selected.snr.toFixed(1)} dB</span>}
                </div>
                <PathHopList
                  hops={selected.hops}
                  liveNodes={liveNodes}
                  onNodeSelect={onNodeSelect}
                  onHoverHop={(i) => highlightHop(selected, i)}
                />

                {!terrain3D && (
                  <div className="mt-1.5 px-2 py-1.5 rounded bg-white/5 text-[10px] text-gray-400 flex items-center justify-between gap-2">
                    <span>Enable 3D terrain to grade each hop against real terrain.</span>
                    {onEnableTerrain && (
                      <button
                        type="button"
                        onClick={onEnableTerrain}
                        className="px-1.5 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors shrink-0"
                      >
                        Set up
                      </button>
                    )}
                  </div>
                )}
                {terrain3D && isComputing && !legRows && (
                  <div className="mt-1.5 text-[10px] text-cyan-300/80 animate-pulse">
                    Grading route against terrain…
                  </div>
                )}
                {analysisError && (
                  <div className="mt-1.5 text-[10px] text-red-400">{analysisError}</div>
                )}

                {legRows && (
                  <div className="mt-1.5 space-y-0.5">
                    {legRows.map((leg) => {
                      const snr = selected.legSnrDb?.[leg.index] ?? null;
                      return (
                        <div
                          key={leg.index}
                          className="flex items-center gap-2 px-1.5 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors text-[10px]"
                          onMouseEnter={() => highlightLeg(selected, leg.index)}
                          onMouseLeave={() => highlightPath(selected)}
                        >
                          <span className="text-gray-400 truncate min-w-0">
                            {labelOf(leg.fromId)}
                            <span className="text-gray-600 mx-0.5">›</span>
                            {labelOf(leg.toId)}
                          </span>
                          <span className="flex items-center gap-1.5 ml-auto shrink-0 tabular-nums">
                            {leg.distanceKm != null && (
                              <span className="text-gray-400">{leg.distanceKm.toFixed(1)} km</span>
                            )}
                            <VerdictBadge v={leg.verdict} />
                            {leg.verdict === "blocked" && leg.worstObstructionM > 0 && (
                              <span className="text-red-300/90">+{Math.round(leg.worstObstructionM)} m</span>
                            )}
                            {leg.verdict !== "gap" && leg.minClearanceRatio != null && leg.verdict !== "blocked" && (
                              <span className="text-gray-500">F₁ {Math.round(Math.max(0, Math.min(9.99, leg.minClearanceRatio)) * 100)}%</span>
                            )}
                            {leg.diffractionLossDb > 0.5 && (
                              <span className="text-orange-300/90">−{leg.diffractionLossDb.toFixed(0)} dB</span>
                            )}
                            {leg.itmLossDb != null && (
                              <span className="text-gray-500">ITM {leg.itmLossDb.toFixed(0)} dB</span>
                            )}
                            {snr != null && (
                              <span className={snrTint(snr)}>
                                {selected.legSnrReversed ? "←" : "→"} {snr.toFixed(1)} dB
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {analysisWarning && (
                  <div className="mt-1.5 text-[10px] text-amber-300/90">{analysisWarning}</div>
                )}
              </div>
            )}

            {analysis?.direct && analysis.sig === (selected?.hops.join(">") ?? "") && (
              <div className="px-2 py-1.5 rounded bg-white/5 border border-white/10 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-400 text-[10px] uppercase tracking-wider shrink-0">Direct Path</span>
                    <VerdictBadge v={analysis.direct.verdict} />
                    <span className="text-gray-400 text-[10px] tabular-nums">
                      {analysis.direct.distanceKm.toFixed(1)} km
                      {analysis.direct.verdict === "blocked" && analysis.direct.worstObstructionM > 0 && (
                        <> · terrain +{Math.round(analysis.direct.worstObstructionM)} m at {analysis.direct.worstObstructionDistKm.toFixed(1)} km</>
                      )}
                      {analysis.direct.itmLossDb != null && <> · ITM {analysis.direct.itmLossDb.toFixed(0)} dB</>}
                    </span>
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={showDirect}
                      onChange={(e) => onToggleDirect(e.target.checked)}
                      className="accent-cyan-500 w-3 h-3"
                    />
                    Show on map
                  </label>
                </div>
                {analysis.direct.verdict === "blocked" && (
                  <div className="mt-0.5 text-[10px] text-gray-500">
                    The direct line is blocked — the mesh routed around it in {selected?.hopCount ?? "?"} hops.
                  </div>
                )}
              </div>
            )}

            {alternates.length > 0 && (
              <div className="px-2 pt-1">
                <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">
                  Other Observed Paths ({paths.length - 1 > 5 ? `showing 5 of ${paths.length - 1}` : paths.length - 1})
                  <span className="normal-case tracking-normal text-gray-600 ml-1.5">click to analyze</span>
                </div>
                <div className="space-y-1">
                  {alternates.map((p) => (
                    <div
                      key={p.hops.join(">")}
                      role="button"
                      tabIndex={0}
                      className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors cursor-pointer
                        focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400"
                      onClick={() => onSelectPath(p.hops.join(">"))}
                      onKeyDown={(e) => {
                        // Hop-chip buttons handle their own Enter/Space — a bubbled
                        // keydown must not hijack node-select into path-select
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectPath(p.hops.join(">"));
                        }
                      }}
                      onMouseEnter={() => highlightPath(p)}
                      onMouseLeave={() => onHighlight?.(null)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-gray-300">
                          {p.hopCount} {p.hopCount === 1 ? "hop" : "hops"}
                          {p.count > 1 && <span className="text-gray-500 ml-2">seen {p.count}×</span>}
                          {p.snr != null && <span className="text-gray-500 ml-2">rx SNR {p.snr.toFixed(1)} dB</span>}
                        </div>
                        {observedAgo(p.timestamp) && (
                          <div className="text-[10px] text-gray-500 tabular-nums shrink-0">{observedAgo(p.timestamp)}</div>
                        )}
                      </div>
                      {/* Hop-chip clicks open node details — don't let them bubble into path selection */}
                      <div onClick={(e) => e.stopPropagation()}>
                        <PathHopList
                          hops={p.hops}
                          liveNodes={liveNodes}
                          onNodeSelect={onNodeSelect}
                          onHoverHop={(i) => highlightHop(p, i)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
