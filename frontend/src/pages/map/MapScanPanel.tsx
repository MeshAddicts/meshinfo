/**
 * Scan-results panel — ranked LoS from a chosen origin to every node in
 * view, with per-result class pills and a quick "fly to" action.
 */
import type { ScanSummary, ScanClass } from "./scanAnalysis";

const CLASS_STYLES: Record<ScanClass, { bg: string; text: string; border: string; label: string }> = {
  clear:      { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/30", label: "Clear" },
  fresnel:    { bg: "bg-amber-500/15",   text: "text-amber-300",   border: "border-amber-500/30",   label: "Fresnel" },
  diffracted: { bg: "bg-orange-500/15",  text: "text-orange-300",  border: "border-orange-500/30",  label: "Diffracted" },
  blocked:    { bg: "bg-red-500/15",     text: "text-red-300",     border: "border-red-500/30",     label: "Blocked" },
};

export function MapScanPanel({
  summary,
  originLabel,
  isScanning,
  terrainNeeded,
  onEnableTerrain,
  onClose,
  onSelectResult,
  onHoverResult,
}: {
  summary: ScanSummary | null;
  originLabel: string;
  isScanning: boolean;
  terrainNeeded?: boolean;
  onEnableTerrain?: () => void;
  onClose: () => void;
  onSelectResult: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
}) {
  if (terrainNeeded && onEnableTerrain) {
    return (
      <div className="fixed left-3 top-1/2 -translate-y-1/2 z-1050 w-85 max-w-[calc(100vw-1.5rem)]
        rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl p-4
        animate-[slideInLeft_220ms_ease-out]">
        <div className="text-xs text-gray-200 mb-3">
          Scanning requires 3D terrain so the tool can evaluate obstructions along each path.
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            className="px-2.5 py-1 rounded-md text-[11px] text-gray-300 hover:text-gray-100 hover:bg-white/5"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-2.5 py-1 rounded-md text-[11px] bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30"
            onClick={onEnableTerrain}
          >
            Enable 3D terrain
          </button>
        </div>
      </div>
    );
  }

  const total = summary ? summary.results.length : 0;
  const reachable = summary
    ? summary.clearCount + summary.fresnelCount + summary.diffractedCount
    : 0;

  return (
    <div className="fixed left-3 top-1/2 -translate-y-1/2 z-1050 w-85 max-w-[calc(100vw-1.5rem)]
      max-h-[calc(100vh-8rem)] overflow-hidden
      rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
      animate-[slideInLeft_220ms_ease-out] flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Scan
          </span>
          <div className="text-[11px] text-gray-300 truncate">
            From <span className="font-medium text-gray-100">{originLabel}</span>
            {summary && (
              <>
                <span className="text-gray-500 mx-1.5">·</span>
                <span className="text-emerald-400">{reachable} reachable</span>
                <span className="text-gray-500 mx-1">/</span>
                <span className="text-gray-400">{total}</span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors shrink-0"
          aria-label="Close scan"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="overflow-y-auto flex-1">
        {isScanning && (
          <div className="px-3 py-6 text-center text-[11px] text-gray-400">
            <div className="inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              Scanning targets in view…
            </div>
          </div>
        )}

        {!isScanning && summary && summary.results.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-gray-400">
            No target nodes in the current view. Zoom or pan to include more nodes, then re-open the tool.
          </div>
        )}

        {!isScanning && summary && summary.results.length > 0 && (
          <>
            {/* Summary counts */}
            <div className="grid grid-cols-4 gap-1.5 px-3 py-2 text-[10px] text-gray-400 border-b border-white/5">
              <StatPill label="Clear" count={summary.clearCount} cls="clear" />
              <StatPill label="Fresnel" count={summary.fresnelCount} cls="fresnel" />
              <StatPill label="Diffracted" count={summary.diffractedCount} cls="diffracted" />
              <StatPill label="Blocked" count={summary.blockedCount} cls="blocked" />
            </div>

            {/* Results list */}
            <ul className="divide-y divide-white/5">
              {summary.results.map((r) => {
                const s = CLASS_STYLES[r.cls];
                return (
                  <li
                    key={r.id}
                    className="px-3 py-1.5 hover:bg-white/5 cursor-pointer transition-colors"
                    onClick={() => onSelectResult(r.id)}
                    onMouseEnter={() => onHoverResult?.(r.id)}
                    onMouseLeave={() => onHoverResult?.(null)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${s.bg} ${s.text} ${s.border}`}>
                        {s.label}
                      </span>
                      <span className="text-[11px] text-gray-100 font-medium truncate flex-1">
                        {r.shortname ?? r.id.slice(0, 8)}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                        {r.distanceKm.toFixed(1)} km
                      </span>
                      <span className={`shrink-0 text-[10px] tabular-nums ${r.cls === "blocked" ? "text-red-400" : "text-emerald-400"}`}>
                        {r.cls === "blocked"
                          ? `${Math.round(r.marginDb)} dB`
                          : `+${Math.round(r.marginDb)} dB`}
                      </span>
                    </div>
                    {r.cls !== "clear" && (
                      <div className="pl-[3.1rem] text-[9px] text-gray-500 mt-0.5">
                        {r.losBlocked && `LoS blocked · `}
                        {r.fresnelIntruded && !r.losBlocked && `Fresnel intrusion · `}
                        {r.diffractionLossDb > 0.5 &&
                          `diffraction ${r.diffractionLossDb.toFixed(1)} dB · `}
                        RSSI {Math.round(r.rssiDbm)} dBm
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function StatPill({
  label,
  count,
  cls,
}: {
  label: string;
  count: number;
  cls: ScanClass;
}) {
  const s = CLASS_STYLES[cls];
  return (
    <div className={`rounded border ${s.bg} ${s.text} ${s.border} px-1.5 py-0.5 text-center`}>
      <div className="text-[9px] opacity-80">{label}</div>
      <div className="text-[11px] font-semibold tabular-nums">{count}</div>
    </div>
  );
}
