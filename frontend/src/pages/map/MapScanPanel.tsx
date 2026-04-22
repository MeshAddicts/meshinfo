/** Scan-results panel: ranked LoS from origin to every node in view. */
import { useEffect, useMemo, useRef, useState } from "react";
import { COMMON_ANTENNAS, COMMON_HARDWARE, ENVIRONMENTS, MESHTASTIC_PRESETS } from "./coverageAnalysis";
import type { ScanSummary, ScanClass, ScanResult } from "./scanAnalysis";

const CLASS_STYLES: Record<ScanClass, { bg: string; text: string; border: string; label: string }> = {
  clear:      { bg: "bg-cyan-500/15",    text: "text-cyan-300",    border: "border-cyan-500/30",    label: "Clear" },
  fresnel:    { bg: "bg-orange-500/15",  text: "text-orange-300",  border: "border-orange-500/30",  label: "Fresnel" },
  diffracted: { bg: "bg-fuchsia-500/15", text: "text-fuchsia-300", border: "border-fuchsia-500/30", label: "Diffracted" },
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
  onReturnToOrigin,
  hiddenClasses,
  onToggleClassVisibility,
  antennaIdx,
  onAntennaIdxChange,
  hardwareIdx,
  onHardwareIdxChange,
  antennaHeightM,
  onAntennaHeightChange,
  rxHardwareIdx,
  onRxHardwareIdxChange,
  rxAntennaIdx,
  onRxAntennaIdxChange,
  customTxDbm,
  onCustomTxDbmChange,
  envIdx,
  onEnvIdxChange,
  presetIdx,
  onPresetIdxChange,
  customSensitivityDbm,
  onCustomSensitivityChange,
}: {
  summary: ScanSummary | null;
  originLabel: string;
  isScanning: boolean;
  terrainNeeded?: boolean;
  onEnableTerrain?: () => void;
  onClose: () => void;
  onSelectResult: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
  /** Restores the map view captured when scan started. */
  onReturnToOrigin: () => void;
  /** Classes hidden on the map (compute still runs). */
  hiddenClasses: Set<ScanClass>;
  onToggleClassVisibility: (cls: ScanClass) => void;
  antennaIdx: number;
  onAntennaIdxChange: (idx: number) => void;
  hardwareIdx: number;
  onHardwareIdxChange: (idx: number) => void;
  /** TX antenna height AGL (m). */
  antennaHeightM: number;
  onAntennaHeightChange: (m: number) => void;
  rxHardwareIdx: number;
  onRxHardwareIdxChange: (idx: number) => void;
  rxAntennaIdx: number;
  onRxAntennaIdxChange: (idx: number) => void;
  customTxDbm: number;
  onCustomTxDbmChange: (dbm: number) => void;
  envIdx: number;
  onEnvIdxChange: (idx: number) => void;
  presetIdx: number;
  onPresetIdxChange: (idx: number) => void;
  customSensitivityDbm: number;
  onCustomSensitivityChange: (dbm: number) => void;
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

  // null = show all; click active filter to toggle off
  const [filter, setFilter] = useState<ScanClass | null>(null);
  const toggleFilter = (cls: ScanClass) =>
    setFilter((prev) => (prev === cls ? null : cls));

  const gearRef = useRef<HTMLDetailsElement>(null);
  const isCustomHardware = COMMON_HARDWARE[hardwareIdx]?.isCustom ?? false;
  const isCustomPreset = MESHTASTIC_PRESETS[presetIdx]?.isCustom ?? false;

  // Close gear popover on outside click (panel's onClick handles inside clicks).
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const gear = gearRef.current;
      if (!gear || !gear.open) return;
      if (gear.contains(e.target as Node)) return;
      gear.removeAttribute("open");
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  // Text-mode input; commit on blur/Enter, blank → 2 m default.
  const [heightInput, setHeightInput] = useState(String(antennaHeightM));
  useEffect(() => { setHeightInput(String(antennaHeightM)); }, [antennaHeightM]);
  const commitHeight = () => {
    const trimmed = heightInput.trim();
    if (trimmed === "") { onAntennaHeightChange(2); setHeightInput("2"); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) { onAntennaHeightChange(2); setHeightInput("2"); return; }
    const clamped = Math.max(0, Math.min(300, n));
    onAntennaHeightChange(clamped);
    setHeightInput(String(clamped));
  };

  const total = summary ? summary.results.length : 0;
  const reachable = summary
    ? summary.clearCount + summary.fresnelCount + summary.diffractedCount
    : 0;

  const displayResults: ScanResult[] = useMemo(() => {
    if (!summary) return [];
    const filtered = filter
      ? summary.results.filter((r) => r.cls === filter)
      : summary.results;
    return [...filtered].sort((a, b) => b.marginDb - a.marginDb);
  }, [summary, filter]);

  return (
    <div
      className="fixed left-3 top-16 bottom-16 z-1050 w-85 max-w-[calc(100vw-1.5rem)]
        rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        animate-[slideInLeft_220ms_ease-out] flex flex-col"
      onClick={(e) => {
        const target = e.target as Node;
        const openDetails = e.currentTarget.querySelectorAll<HTMLDetailsElement>("details[open]");
        openDetails.forEach((d) => {
          if (!d.contains(target)) d.removeAttribute("open");
        });
      }}
    >

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
        <div className="flex items-center gap-1 shrink-0">
          <details ref={gearRef} className="text-[10px] text-gray-400 relative">
            <summary
              className="cursor-pointer list-none p-1 rounded-md hover:text-gray-200 hover:bg-white/5 transition-colors"
              aria-label="Scan settings"
              title="Scan settings"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </summary>
            {/* Fixed-position so it escapes the panel's overflow-hidden. */}
            <div className="fixed top-16 left-90 w-90 max-h-[calc(100vh-8rem)] overflow-y-auto p-3 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl z-1060 space-y-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                Scan settings
              </div>

              {/* TX block */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="scan-hardware" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                    TX Hardware
                  </label>
                  <div className="flex gap-1">
                    <select
                      id="scan-hardware"
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
                        min={10} max={35} step={1}
                        aria-label="Custom TX power (dBm)"
                        title="TX power in dBm"
                        className="w-12 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-xs text-gray-200 text-center
                          focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50"
                      />
                    )}
                  </div>
                </div>
                <div>
                  <label htmlFor="scan-antenna" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                    TX Antenna
                  </label>
                  <select
                    id="scan-antenna"
                    value={antennaIdx}
                    onChange={(e) => onAntennaIdxChange(Number(e.target.value))}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                      focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                      [&>option]:bg-gray-800 [&>option]:text-gray-200"
                  >
                    {COMMON_ANTENNAS.map((a, i) => (
                      <option key={i} value={i}>{a.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* TX antenna height AGL — overrides GPS altitude. */}
              <div>
                <label htmlFor="scan-tx-height" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                  TX Antenna Height
                </label>
                <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-20">
                  <input
                    id="scan-tx-height"
                    type="text"
                    inputMode="decimal"
                    value={heightInput}
                    onChange={(e) => setHeightInput(e.target.value)}
                    onBlur={commitHeight}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.currentTarget as HTMLInputElement).blur();
                      } else if (e.key === "Escape") {
                        setHeightInput(String(antennaHeightM));
                        (e.currentTarget as HTMLInputElement).blur();
                      }
                    }}
                    aria-label="TX antenna height above the origin (meters)"
                    title="TX antenna height above the origin terrain (m). Blank = 2 m default."
                    className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 text-center focus:outline-hidden"
                  />
                  <span className="text-[10px] text-gray-500 shrink-0">m</span>
                </div>
              </div>

              {/* Modem preset */}
              <div>
                <label htmlFor="scan-preset" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                  Modem Preset
                </label>
                <div className="flex gap-1">
                  <select
                    id="scan-preset"
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
                      min={-150} max={-100} step={1}
                      aria-label="Custom RX sensitivity (dBm)"
                      title="RX sensitivity in dBm"
                      className="w-14 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-xs text-gray-200 text-center
                        focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50"
                    />
                  )}
                </div>
              </div>

              {/* RX block */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                    <span>Receiver (modeled)</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onRxHardwareIdxChange(4); // Heltec V3
                      onRxAntennaIdxChange(0);  // rubber duck
                    }}
                    className="text-[9px] text-cyan-400/70 hover:text-cyan-300 transition-colors"
                    title="Reset RX to stock handheld (Heltec V3, rubber duck)"
                  >
                    Reset to handheld
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="scan-rx-hw" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Hardware
                    </label>
                    <select
                      id="scan-rx-hw"
                      value={rxHardwareIdx}
                      onChange={(e) => onRxHardwareIdxChange(Number(e.target.value))}
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                        focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                        [&>option]:bg-gray-800 [&>option]:text-gray-200"
                    >
                      {COMMON_HARDWARE.map((h, i) => (
                        <option key={i} value={i}>{h.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="scan-rx-ant" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Antenna
                    </label>
                    <select
                      id="scan-rx-ant"
                      value={rxAntennaIdx}
                      onChange={(e) => onRxAntennaIdxChange(Number(e.target.value))}
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                        focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                        [&>option]:bg-gray-800 [&>option]:text-gray-200"
                    >
                      {COMMON_ANTENNAS.map((a, i) => (
                        <option key={i} value={i}>{a.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Environment */}
              <div>
                <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                  Environment
                </label>
                <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[10px] font-medium">
                  {ENVIRONMENTS.map((env, i) => {
                    const active = envIdx === i;
                    const shortLabel =
                      env.id === "open" ? "Open"
                      : env.id === "mixed" ? "Light"
                      : env.id === "suburban" ? "Suburb"
                      : "Urban";
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onEnvIdxChange(i)}
                        title={env.description}
                        className={`flex-1 rounded-md px-1.5 py-1 transition-colors ${
                          active
                            ? "bg-cyan-500/20 text-cyan-200"
                            : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                        }`}
                      >
                        <div>{shortLabel}</div>
                        <div className="text-[9px] text-gray-500 font-normal">
                          {env.clutterLossDb === 0 ? "0 dB" : `+${env.clutterLossDb} dB`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </details>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label="Close scan"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

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
            No target nodes within 200 km of the origin. Try a different location.
          </div>
        )}

        {!isScanning && summary && summary.results.length > 0 && (
          <>
            {/* Left-click filters list; right-click hides class on map. */}
            <div className="grid grid-cols-4 gap-1.5 px-3 py-2 text-[10px] text-gray-400 border-b border-white/5">
              <StatPill label="Clear"      count={summary.clearCount}      cls="clear"      active={filter === "clear"}      hidden={hiddenClasses.has("clear")}      onClick={() => toggleFilter("clear")}      onContextMenu={() => onToggleClassVisibility("clear")} />
              <StatPill label="Fresnel"    count={summary.fresnelCount}    cls="fresnel"    active={filter === "fresnel"}    hidden={hiddenClasses.has("fresnel")}    onClick={() => toggleFilter("fresnel")}    onContextMenu={() => onToggleClassVisibility("fresnel")} />
              <StatPill label="Diffracted" count={summary.diffractedCount} cls="diffracted" active={filter === "diffracted"} hidden={hiddenClasses.has("diffracted")} onClick={() => toggleFilter("diffracted")} onContextMenu={() => onToggleClassVisibility("diffracted")} />
              <StatPill label="Blocked"    count={summary.blockedCount}    cls="blocked"    active={filter === "blocked"}    hidden={hiddenClasses.has("blocked")}    onClick={() => toggleFilter("blocked")}    onContextMenu={() => onToggleClassVisibility("blocked")} />
            </div>
            {hiddenClasses.size > 0 && (
              <div className="px-3 py-1 text-[9px] text-gray-500 border-b border-white/5">
                Right-click a class to toggle its map visibility.
              </div>
            )}

            {/* Pinned origin row — click returns to the scan's starting view. */}
            <button
              type="button"
              onClick={onReturnToOrigin}
              className="w-full px-3 py-1.5 flex items-center gap-2 min-w-0 border-b border-white/5
                bg-cyan-500/5 hover:bg-cyan-500/15 transition-colors cursor-pointer text-left"
              title="Return to the overview view"
            >
              <svg className="w-3.5 h-3.5 text-cyan-400 shrink-0" fill="#22d3ee" stroke="white" viewBox="0 0 24 24" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="7" />
              </svg>
              <span className="text-[11px] text-cyan-200 font-medium truncate flex-1">
                {originLabel}
              </span>
              <span className="shrink-0 text-[9px] text-gray-500 uppercase tracking-wider">
                origin · click to return
              </span>
            </button>

            <ul className="divide-y divide-white/5">
              {displayResults.map((r) => {
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
  active,
  hidden,
  onClick,
  onContextMenu,
}: {
  label: string;
  count: number;
  cls: ScanClass;
  active?: boolean;
  hidden?: boolean;
  onClick?: () => void;
  onContextMenu?: () => void;
}) {
  const s = CLASS_STYLES[cls];
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.();
      }}
      className={`rounded border px-1.5 py-0.5 text-center transition-all cursor-pointer ${
        hidden
          ? `${s.bg} ${s.text} ${s.border} opacity-40 hover:opacity-70 border-dashed`
          : active
            ? `${s.bg} ${s.text} ${s.border} ring-1 ring-offset-1 ring-offset-gray-900 ${s.border}`
            : `${s.bg} ${s.text} ${s.border} opacity-80 hover:opacity-100`
      }`}
      title={
        hidden
          ? `${label} hidden on map — right-click to show`
          : active
            ? `Showing ${label.toLowerCase()} only — click to show all · right-click to hide on map`
            : `Filter to ${label.toLowerCase()} · right-click to hide on map`
      }
    >
      <div className="text-[9px] opacity-80">{label}</div>
      <div className="text-[11px] font-semibold tabular-nums">{count}</div>
    </button>
  );
}
