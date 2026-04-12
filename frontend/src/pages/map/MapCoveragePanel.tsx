import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageResult } from "./coverageAnalysis";

export function MapCoveragePanel({
  result,
  originLabel,
  terrainNeeded,
  onEnableTerrain,
  onClose,
  isComputing,
  radiusKm,
  onRadiusChange,
  antennaDbi,
  onAntennaDbiChange,
  hardwareIdx,
  onHardwareIdxChange,
  customTxDbm,
  onCustomTxDbmChange,
}: {
  result: CoverageResult | null;
  originLabel: string;
  terrainNeeded: boolean;
  onEnableTerrain?: () => void;
  onClose: () => void;
  isComputing: boolean;
  radiusKm: number;
  onRadiusChange: (km: number) => void;
  antennaDbi: number;
  onAntennaDbiChange: (dbi: number) => void;
  hardwareIdx: number;
  onHardwareIdxChange: (idx: number) => void;
  customTxDbm: number;
  onCustomTxDbmChange: (dbm: number) => void;
}) {
  const isCustomHardware = COMMON_HARDWARE[hardwareIdx]?.isCustom ?? false;
  if (terrainNeeded) {
    return (
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(520px,calc(100vw-2rem))]
        rounded-xl shadow-2xl border border-amber-500/30 bg-gray-900/90 backdrop-blur-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="text-sm font-semibold text-amber-300 mb-1">
              3D Terrain required for coverage prediction
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Coverage prediction samples real terrain to determine where this node can reach.
              Enable 3D terrain to use this tool.
            </p>
            {onEnableTerrain && (
              <button
                type="button"
                onClick={onEnableTerrain}
                className="mt-2.5 text-xs px-3 py-1.5 rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-200 hover:bg-amber-500/30 transition-colors font-medium"
              >
                Enable 3D Terrain
              </button>
            )}
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
      </div>
    );
  }

  // No result yet (first compute) — show just a loading banner
  if (!result) {
    return (
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(520px,calc(100vw-2rem))]
        rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            Computing coverage from {originLabel} ({radiusKm}km radius)…
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  const total = result.clearCount + result.fresnelCount + result.blockedCount;
  const clearPct = total > 0 ? Math.round((result.clearCount / total) * 100) : 0;
  const fresnelPct = total > 0 ? Math.round((result.fresnelCount / total) * 100) : 0;
  const blockedPct = total > 0 ? Math.round((result.blockedCount / total) * 100) : 0;

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(640px,calc(100vw-2rem))]
      rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
      animate-[slideInUp_200ms_ease-out]">

      {/* Recomputing overlay — small pill above the panel, doesn't hide controls */}
      {isComputing && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full
          bg-gray-900/95 backdrop-blur-xl border border-cyan-500/40 shadow-2xl
          text-[10px] text-cyan-200 flex items-center gap-1.5 whitespace-nowrap">
          <div className="w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          Recomputing coverage…
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" strokeWidth={2} strokeDasharray="3 3" />
              <circle cx="12" cy="12" r="1.5" strokeWidth={2} fill="currentColor" />
            </svg>
            Coverage
          </span>
          <div className="text-[11px] text-gray-300 truncate">
            <span className="text-gray-500">From:</span>{" "}
            <span className="font-medium text-gray-200">{originLabel}</span>
            <span className="text-gray-500 ml-2">·</span>
            <span className="text-gray-500 ml-2">
              {Math.round(result.originHeightM)}m{result.originIsFallback ? "~" : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <details className="text-[10px] text-gray-500 relative">
            <summary className="cursor-pointer hover:text-gray-400 select-none list-none p-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </summary>
            <div className="absolute right-0 bottom-full mb-1 w-[320px] p-2.5 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed space-y-1">
              <div>Painted sectors show reachable area at <strong>{(result.frequencyGHz * 1000).toFixed(0)} MHz</strong>. Green = clear LoS, yellow = Fresnel intrusion.</div>
              <div>Unpainted terrain is either blocked by elevation or beyond the link budget.</div>
              <div>Model: free-space path loss, 4/3 earth refraction, 15 dB fade margin, 2 dB cable loss, −124 dBm RX sensitivity (LongFast SF11).</div>
            </div>
          </details>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stats + legend */}
      <div className="p-3 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-emerald-300 text-[10px] uppercase tracking-wider">Clear</span>
            </div>
            <div className="text-gray-100 font-medium mt-0.5">{result.clearCount} <span className="text-gray-500 text-[10px] font-normal">({clearPct}%)</span></div>
          </div>
          <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              <span className="text-yellow-300 text-[10px] uppercase tracking-wider">Fresnel</span>
            </div>
            <div className="text-gray-100 font-medium mt-0.5">{result.fresnelCount} <span className="text-gray-500 text-[10px] font-normal">({fresnelPct}%)</span></div>
          </div>
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-red-300 text-[10px] uppercase tracking-wider">Blocked</span>
            </div>
            <div className="text-gray-100 font-medium mt-0.5">{result.blockedCount} <span className="text-gray-500 text-[10px] font-normal">({blockedPct}%)</span></div>
          </div>
        </div>

        {/* Hardware / Antenna / Radius selectors */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label htmlFor="coverage-hardware" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
              Hardware
            </label>
            <div className="flex gap-1">
              <select
                id="coverage-hardware"
                value={hardwareIdx}
                onChange={(e) => onHardwareIdxChange(Number(e.target.value))}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                  focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                  [&>option]:bg-gray-800 [&>option]:text-gray-200"
              >
                {COMMON_HARDWARE.map((h, i) => (
                  <option key={i} value={i}>
                    {h.label}{h.isCustom ? "" : ` (${h.txDbm} dBm)`}
                  </option>
                ))}
              </select>
              {isCustomHardware && (
                <input
                  type="number"
                  value={customTxDbm}
                  onChange={(e) => onCustomTxDbmChange(Number(e.target.value))}
                  min={10}
                  max={35}
                  step={1}
                  aria-label="Custom TX power (dBm)"
                  title="TX power in dBm"
                  className="w-12 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-xs text-gray-200 text-center
                    focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50"
                />
              )}
            </div>
          </div>
          <div>
            <label htmlFor="coverage-antenna" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
              Antenna
            </label>
            <select
              id="coverage-antenna"
              value={antennaDbi}
              onChange={(e) => onAntennaDbiChange(Number(e.target.value))}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                [&>option]:bg-gray-800 [&>option]:text-gray-200"
            >
              {COMMON_ANTENNAS.map((a) => (
                <option key={a.dbi} value={a.dbi}>{a.label}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="coverage-radius" className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Scan radius
              </label>
              <span className="text-[10px] text-gray-300 font-medium">{radiusKm} km</span>
            </div>
            <input
              id="coverage-radius"
              type="range"
              min={2}
              max={Math.max(30, Math.min(300, Math.ceil(result.linkBudgetMaxKm)))}
              step={1}
              value={radiusKm}
              onChange={(e) => onRadiusChange(Number(e.target.value))}
              className="w-full accent-cyan-500"
              aria-label="Scan radius"
            />
            <div className="text-[9px] text-gray-500 mt-0.5 text-right">
              budget ~{Math.round(result.linkBudgetMaxKm)} km
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
