import { ElevationProfile } from "./ElevationProfile";
import type { LoSResult } from "./losAnalysis";

export function MapLosPanel({
  result,
  fromLabel,
  toLabel,
  fromColor = "#22c55e",
  toColor = "#06b6d4",
  terrainNeeded,
  onEnableTerrain,
  onClose,
  isComputing,
}: {
  result: LoSResult | null;
  fromLabel: string;
  toLabel: string;
  fromColor?: string;
  toColor?: string;
  terrainNeeded: boolean;
  onEnableTerrain?: () => void;
  onClose: () => void;
  isComputing: boolean;
}) {
  // Terrain-needed banner
  if (terrainNeeded) {
    return (
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(900px,calc(100vw-2rem))]
        rounded-xl shadow-2xl border border-amber-500/30 bg-gray-900/90 backdrop-blur-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="text-sm font-semibold text-amber-300 mb-1">
              3D Terrain required for line-of-sight analysis
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              LoS analysis samples real terrain elevations to determine if obstacles block the radio path.
              Enable 3D terrain to use this feature.
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
            aria-label="Close LoS analysis"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  if (isComputing || !result) {
    return (
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(900px,calc(100vw-2rem))]
        rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            Sampling terrain between {fromLabel} and {toLabel}…
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

  const los = result;
  const statusLabel = los.losClear
    ? (los.fresnelClear ? "Clear Line of Sight" : "LoS Clear · Fresnel Intrusion")
    : "Obstructed";
  const statusColor = los.losClear
    ? (los.fresnelClear ? "emerald" : "yellow")
    : "red";
  const statusClasses = {
    emerald: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300",
    yellow: "bg-yellow-500/15 border-yellow-500/30 text-yellow-300",
    red: "bg-red-500/15 border-red-500/30 text-red-300",
  }[statusColor];
  const dotColor = {
    emerald: "bg-emerald-400",
    yellow: "bg-yellow-400",
    red: "bg-red-400",
  }[statusColor];

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(960px,calc(100vw-2rem))]
      rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
      animate-[slideInUp_200ms_ease-out]">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 ${statusClasses}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            {statusLabel}
          </span>
          <div className="text-[11px] text-gray-300 truncate">
            <span style={{ color: fromColor }} className="font-medium">{fromLabel}</span>
            <span className="text-gray-500 mx-1.5">→</span>
            <span style={{ color: toColor }} className="font-medium">{toLabel}</span>
          </div>
          <span className="text-gray-500 text-[10px]">·</span>
          <span className="text-[11px] text-gray-300">
            <span className="text-gray-500">{los.totalDistanceKm.toFixed(2)}km</span>
            <span className="text-gray-600 mx-1">·</span>
            <span className="text-gray-500">
              Δ{los.elevationDiffM >= 0 ? "+" : ""}{Math.round(los.elevationDiffM)}m
            </span>
            <span className="text-gray-600 mx-1">·</span>
            <span className="text-gray-500">
              {Math.round(los.fromHeightM)}{los.fromIsFallback && "~"}m → {Math.round(los.toHeightM)}{los.toIsFallback && "~"}m
            </span>
          </span>
          {!los.losClear && (
            <span className="text-[10px] text-red-300">
              · obstructed by {Math.round(los.worstObstructionM)}m @ {los.worstObstructionDistKm.toFixed(1)}km
            </span>
          )}
          {los.losClear && !los.fresnelClear && (
            <span className="text-[10px] text-yellow-300">
              · Fresnel intrusion {Math.round(los.worstFresnelIntrusion * 100)}% @ {los.worstObstructionDistKm.toFixed(1)}km
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <details className="text-[10px] text-gray-500 relative">
            <summary className="cursor-pointer hover:text-gray-400 select-none list-none">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </summary>
            <div className="absolute right-0 bottom-full mb-1 min-w-[260px] p-2 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed">
              <div>Uses real terrain elevations and <strong>4/3 earth radius</strong> for atmospheric refraction.</div>
              <div>Frequency: <strong>{(los.frequencyGHz * 1000).toFixed(0)} MHz</strong>. Fresnel zone needs ≥60% clearance.</div>
              <div>&quot;~&quot; means node had no GPS altitude (or reported below terrain) — assumed as <strong>terrain + 2m</strong>.</div>
            </div>
          </details>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label="Close LoS analysis"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="px-2 py-1.5">
        <ElevationProfile
          result={los}
          fromLabel={fromLabel}
          toLabel={toLabel}
          fromColor={fromColor}
          toColor={toColor}
        />
      </div>
    </div>
  );
}
