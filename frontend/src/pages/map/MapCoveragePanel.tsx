import { COMMON_ANTENNAS, COMMON_HARDWARE, ENVIRONMENTS, MESHTASTIC_PRESETS, type CoverageResult } from "./coverageAnalysis";

/**
 * Tiny info icon with a styled hover tooltip. More discoverable than a
 * browser-native `title=` attribute (which requires a long hover delay and
 * renders in OS-styled gray). `align` controls whether the tooltip anchors
 * to the right edge of the icon (default) or left — use "left" when the icon
 * is far to the right of the panel to avoid spilling off-screen.
 */
function InfoTip({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <span className="relative inline-flex items-center group">
      <svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 transition-colors cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span
        className={`invisible group-hover:visible absolute bottom-full mb-1 w-60 p-2 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-[10px] text-gray-300 leading-relaxed z-50 normal-case tracking-normal font-normal ${
          align === "left" ? "left-0" : "right-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

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
  envIdx,
  onEnvIdxChange,
  presetIdx,
  onPresetIdxChange,
  customSensitivityDbm,
  onCustomSensitivityChange,
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
  envIdx: number;
  onEnvIdxChange: (idx: number) => void;
  presetIdx: number;
  onPresetIdxChange: (idx: number) => void;
  customSensitivityDbm: number;
  onCustomSensitivityChange: (dbm: number) => void;
}) {
  const isCustomHardware = COMMON_HARDWARE[hardwareIdx]?.isCustom ?? false;
  const isCustomPreset = MESHTASTIC_PRESETS[presetIdx]?.isCustom ?? false;
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
            <div className="absolute right-0 bottom-full mb-1 w-[340px] p-2.5 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed space-y-1">
              <div>Sector color shows predicted <strong>link margin</strong> (RSSI minus sensitivity and fade margin). Dark green = very reliable, yellow = marginal, orange = at threshold. Unpainted terrain is below sensitivity.</div>
              <div>Model: log-distance path loss (n=<strong>{result.envExponent}</strong>), 4/3 earth refraction, ITU-R P.526 single knife-edge diffraction, 15 dB fade margin, 2 dB cable loss, RX sensitivity <strong>{result.rxSensitivityDbm} dBm</strong>.</div>
              <div>Diffraction recovers signal over grazing obstructions — turns hard-blocked paths into usable ones when the obstacle is small.</div>
              <div className="text-amber-300/80 pt-1 border-t border-white/5 mt-1">
                <strong>Approximation:</strong> sensitivity figures come from Meshtastic docs for SX126x chips. Real-world values can be 1–3 dB worse due to board noise, temperature, and antenna system losses. SX1276-based boards (e.g. Heltec v2) are ~2–3 dB less sensitive. Foliage, buildings, and multipath beyond the environment exponent are not modeled.
              </div>
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
        {/* Reachability summary + RSSI gradient legend */}
        {(() => {
          const reachablePx = result.clearCount + result.fresnelCount;
          const totalPx = reachablePx + result.blockedCount;
          const pct = totalPx > 0 ? (reachablePx / totalPx) * 100 : 0;
          // DEM bbox is padded by 5% on each side, so total scanned area ≈ (2·r·1.05)².
          const scannedKm2 = (2 * result.radiusKm * 1.05) ** 2;
          const reachableKm2 = scannedKm2 * (totalPx > 0 ? reachablePx / totalPx : 0);
          const fmt = (n: number) => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);

          // Diagnostics for when the map paints nothing:
          //   - If virtually all pixels were NaN, the DEM didn't sample — tiles
          //     weren't loaded for the area. Tell the user to zoom/pan out.
          //   - If the DEM sampled but no pixels closed the budget, tell the
          //     user the link budget itself is failing (try more power / range).
          const TOTAL_PIXELS = 65536; // 256×256 grid
          const terrainCoverage = totalPx / TOTAL_PIXELS;
          const noTerrainData = terrainCoverage < 0.05; // <5% of grid had terrain
          const noLinkBudget = !noTerrainData && reachablePx === 0;
          return (
            <div className="flex items-center gap-3 px-2 py-1.5 rounded-lg bg-white/5">
              <div className="flex-1">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-gray-500 uppercase tracking-wider inline-flex items-center gap-1">
                    Reachable
                    <InfoTip align="left">
                      Estimated area where the link budget succeeds (RSSI above
                      sensitivity + fade margin). Computed from the
                      {" "}{reachablePx.toLocaleString()} of {totalPx.toLocaleString()}{" "}
                      grid cells that passed.
                    </InfoTip>
                  </span>
                  <span className="text-emerald-300 font-medium tabular-nums">
                    ~{fmt(reachableKm2)} km²
                  </span>
                  <span className="text-gray-500 tabular-nums">
                    ({Math.round(pct)}% of {fmt(scannedKm2)} km²)
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full overflow-hidden" style={{
                  background: "linear-gradient(to right, #f97316 0%, #eab308 20%, #22c55e 55%, #16a34a 100%)",
                }} />
                <div className="flex items-center justify-between text-[9px] text-gray-500 mt-0.5 font-mono">
                  <span>0 dB</span>
                  <span>+5</span>
                  <span>+15</span>
                  <span>+25 dB margin</span>
                </div>
                {(noTerrainData || noLinkBudget) && (
                  <div className="mt-1.5 px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-300 leading-snug">
                    {noTerrainData ? (
                      <>
                        <strong>No terrain data loaded</strong> for the pin area.
                        Try zooming / panning around so Mapbox fetches terrain
                        tiles first, then re-drop the pin.
                      </>
                    ) : (
                      <>
                        <strong>Link budget fails everywhere</strong> within range.
                        Try a lower-sensitivity preset, more TX power, higher-gain
                        antenna, or a smaller analysis range.
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Environment + Modem preset */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="coverage-env" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
              Environment
            </label>
            <select
              id="coverage-env"
              value={envIdx}
              onChange={(e) => onEnvIdxChange(Number(e.target.value))}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                [&>option]:bg-gray-800 [&>option]:text-gray-200"
              title={ENVIRONMENTS[envIdx].description}
            >
              {ENVIRONMENTS.map((env, i) => (
                <option key={i} value={i}>{env.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="coverage-preset" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
              Modem Preset
            </label>
            <div className="flex gap-1">
              <select
                id="coverage-preset"
                value={presetIdx}
                onChange={(e) => onPresetIdxChange(Number(e.target.value))}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                  focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                  [&>option]:bg-gray-800 [&>option]:text-gray-200"
              >
                {MESHTASTIC_PRESETS.map((p, i) => (
                  <option key={i} value={i}>
                    {p.label}{p.isCustom ? "" : ` · ${p.sensitivityDbm} dBm`}
                  </option>
                ))}
              </select>
              {isCustomPreset && (
                <input
                  type="number"
                  value={customSensitivityDbm}
                  onChange={(e) => onCustomSensitivityChange(Number(e.target.value))}
                  min={-150}
                  max={-100}
                  step={1}
                  aria-label="Custom RX sensitivity (dBm)"
                  title="RX sensitivity in dBm (e.g. −133)"
                  className="w-14 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-xs text-gray-200 text-center
                    focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50"
                />
              )}
            </div>
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
                <span className="inline-flex items-center gap-1">
                  Analysis range
                  <InfoTip align="left">
                    How far from the pin the tool computes coverage. Defaults to
                    the theoretical link-budget range for the chosen hardware,
                    capped at 500 km (beyond that the terrain grid gets too
                    coarse to be meaningful).
                  </InfoTip>
                </span>
              </label>
              <span className="text-[10px] text-gray-300 font-medium">{radiusKm} km</span>
            </div>
            <input
              id="coverage-radius"
              type="range"
              min={2}
              max={Math.max(30, Math.min(500, Math.ceil(result.linkBudgetMaxKm)))}
              step={1}
              value={radiusKm}
              onChange={(e) => onRadiusChange(Number(e.target.value))}
              className="w-full accent-cyan-500"
              aria-label="Analysis range (km)"
            />
            <div
              className="text-[9px] text-gray-500 mt-0.5 text-right"
              title={
                result.linkBudgetMaxKm > 500
                  ? "Slider capped at 500 km — beyond that, terrain sampling resolution is too coarse to be meaningful."
                  : undefined
              }
            >
              budget ~{Math.round(result.linkBudgetMaxKm)} km
              {result.linkBudgetMaxKm > 500 && <span className="text-amber-500/70"> · capped at 500</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
