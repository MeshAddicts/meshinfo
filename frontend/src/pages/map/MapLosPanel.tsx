import { useEffect, useRef, useState } from "react";

import {
  COMMON_ANTENNAS,
  COMMON_HARDWARE,
  effectiveSensitivityDbm,
  MESHTASTIC_PRESETS,
} from "./coverageAnalysis";
import { ElevationProfile } from "./ElevationProfile";
import type { LoSResult } from "./losAnalysis";
import type { DemSource } from "./terrainRgb";
import { useBottomSheetGesture } from "./useBottomSheet";

/** Modem preset assumed for link-budget readout in this panel.
 *  LongFast = Meshtastic default mesh setting; -130 dBm typical SX1262 sensitivity. */
const LOS_PRESET = MESHTASTIC_PRESETS.find((p) => p.id === "LongFast") ?? MESHTASTIC_PRESETS[1];

/** One-direction link budget. Returns null if hw/ant lookups fail. */
function dirLinkBudget(
  txHwIdx: number,
  txAntIdx: number,
  rxHwIdx: number,
  rxAntIdx: number,
  itmLossDb: number,
): { rssiDbm: number; marginDb: number; sensitivityDbm: number } | null {
  const txHw = COMMON_HARDWARE[txHwIdx];
  const txAnt = COMMON_ANTENNAS[txAntIdx];
  const rxHw = COMMON_HARDWARE[rxHwIdx];
  const rxAnt = COMMON_ANTENNAS[rxAntIdx];
  if (!txHw || !txAnt || !rxHw || !rxAnt) return null;
  const rssiDbm = txHw.txDbm + txAnt.dbi + rxAnt.dbi - itmLossDb;
  const sensitivityDbm = effectiveSensitivityDbm(
    LOS_PRESET.sensitivityDbm,
    rxHw.chipset,
    rxHw.sensitivityOffsetDb ?? 0,
  );
  return { rssiDbm, marginDb: rssiDbm - sensitivityDbm, sensitivityDbm };
}

/** Endpoint config column: hardware/antenna/height for one end of the LOS link. */
function EndpointConfig({
  label,
  color,
  hwIdx, onHwIdxChange,
  antIdx, onAntIdxChange,
  heightM, onHeightChange,
  usingGpsAltitude = false,
}: {
  label: string;
  color: string;
  hwIdx: number;
  onHwIdxChange: (idx: number) => void;
  antIdx: number;
  onAntIdxChange: (idx: number) => void;
  heightM: number;
  onHeightChange: (m: number) => void;
  /** Node reported a GPS altitude, so the Height field doesn't affect the result. */
  usingGpsAltitude?: boolean;
}) {
  const [heightInput, setHeightInput] = useState(String(heightM));
  useEffect(() => { setHeightInput(String(heightM)); }, [heightM]);
  const commitHeight = () => {
    const n = Number(heightInput.trim());
    if (!Number.isFinite(n) || heightInput.trim() === "") {
      onHeightChange(2);
      setHeightInput("2");
      return;
    }
    const clamped = Math.max(0, Math.min(300, n));
    onHeightChange(clamped);
    setHeightInput(String(clamped));
  };

  return (
    <div className="w-full sm:w-36 sm:shrink-0 p-2 space-y-1.5 text-[10px]">
      <div className="font-medium truncate" style={{ color }}>{label}</div>
      <div>
        <div className="text-gray-500 uppercase tracking-wider mb-0.5">Hardware</div>
        <select
          value={hwIdx}
          onChange={(e) => onHwIdxChange(Number(e.target.value))}
          className="w-full rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-gray-200
            focus:border-cyan-500/50 focus:outline-hidden [&>option]:bg-gray-800 [&>option]:text-gray-200"
        >
          {COMMON_HARDWARE.map((h, i) => (
            <option key={i} value={i}>{h.label} ({h.txDbm} dBm)</option>
          ))}
        </select>
      </div>
      <div>
        <div className="text-gray-500 uppercase tracking-wider mb-0.5">Antenna</div>
        <select
          value={antIdx}
          onChange={(e) => onAntIdxChange(Number(e.target.value))}
          className="w-full rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-gray-200
            focus:border-cyan-500/50 focus:outline-hidden [&>option]:bg-gray-800 [&>option]:text-gray-200"
        >
          {COMMON_ANTENNAS.map((a, i) => (
            <option key={i} value={i}>{a.label}</option>
          ))}
        </select>
      </div>
      <div>
        <div className="text-gray-500 uppercase tracking-wider mb-0.5">Height</div>
        <div className={`flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1 py-0.5 ${usingGpsAltitude ? "opacity-50" : ""}`}>
          <input
            type="text"
            inputMode="decimal"
            value={heightInput}
            disabled={usingGpsAltitude}
            onChange={(e) => setHeightInput(e.target.value)}
            onBlur={commitHeight}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              else if (e.key === "Escape") {
                setHeightInput(String(heightM));
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[10px] text-gray-200 text-center focus:outline-hidden disabled:cursor-not-allowed"
            aria-label={`${label} antenna height in meters`}
            title={usingGpsAltitude
              ? "Ignored — this node reports a GPS altitude, which is used instead."
              : "Antenna height above ground (m). Blank = 2 m."}
          />
          <span className="text-gray-500 shrink-0">m</span>
        </div>
        {usingGpsAltitude && (
          <div className="text-[9px] text-gray-500 mt-0.5 leading-snug">
            Using GPS altitude — height ignored.
          </div>
        )}
      </div>
    </div>
  );
}

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
  isRecomputing = false,
  error,
  terrainWarning,
  fromHwIdx, onFromHwIdxChange,
  fromAntIdx, onFromAntIdxChange,
  fromHeightM, onFromHeightChange,
  toHwIdx, onToHwIdxChange,
  toAntIdx, onToAntIdxChange,
  toHeightM, onToHeightChange,
  demSource,
  onProfileHover,
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
  /** A recompute is in flight while a result is already shown (height/config tweak). */
  isRecomputing?: boolean;
  /** Compute error; shows an error state instead of the spinner. */
  error?: string | null;
  /** Non-fatal terrain-quality warning (failed tiles / missing samples). */
  terrainWarning?: string | null;
  fromHwIdx: number; onFromHwIdxChange: (idx: number) => void;
  fromAntIdx: number; onFromAntIdxChange: (idx: number) => void;
  fromHeightM: number; onFromHeightChange: (m: number) => void;
  toHwIdx: number; onToHwIdxChange: (idx: number) => void;
  toAntIdx: number; onToAntIdxChange: (idx: number) => void;
  toHeightM: number; onToHeightChange: (m: number) => void;
  /** DEM tile source (null before first compute). */
  demSource: DemSource | null;
  /** Fires with 0-1 distance fraction on chart hover. */
  onProfileHover?: (fraction: number | null) => void;
}) {
  // Mobile peek after a result: summary + graph stay; configs reveal on drag-up.
  const [minimized, setMinimized] = useState(false);
  const sheet = useBottomSheetGesture({
    onClose,
    minimized,
    onMinimize: () => setMinimized(true),
    onExpand: () => setMinimized(false),
  });

  const losKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!result) { losKeyRef.current = null; return; }
    const key = `${fromLabel}->${toLabel}`;
    if (losKeyRef.current !== key) {
      losKeyRef.current = key;
      setMinimized(true);
    }
  }, [result, fromLabel, toLabel]);

  // Modal terrain prompt: focus its primary action on mount.
  const terrainBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (terrainNeeded) requestAnimationFrame(() => terrainBtnRef.current?.focus());
  }, [terrainNeeded]);

  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const root = sheet.sheetRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      root.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => {
        d.removeAttribute("open");
      });
    };
    // Capture phase so an open popover swallows Escape before the global
    // handler closes the whole tool; refocus the summary on close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const root = sheet.sheetRef.current;
      const open = root?.querySelectorAll<HTMLDetailsElement>("details[open]");
      if (!open || open.length === 0) return;
      e.stopPropagation();
      open.forEach((d) => {
        d.removeAttribute("open");
        d.querySelector<HTMLElement>("summary")?.focus();
      });
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sheet.sheetRef]);

  if (terrainNeeded) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="3D terrain required for line-of-sight analysis"
        className="fixed z-1050 shadow-2xl border border-amber-500/30 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-4 pb-6 max-h-[75dvh] overflow-y-auto
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(900px,calc(100vw-2rem))]
        sm:rounded-xl sm:pb-4 sm:max-h-none sm:overflow-visible">
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
                ref={terrainBtnRef}
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

  if (error && !result) {
    return (
      <div
        role="dialog"
        aria-label="Line-of-sight analysis error"
        className="fixed z-1050 shadow-2xl border border-red-500/30 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-3 pb-5
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(900px,calc(100vw-2rem))]
        sm:rounded-xl sm:pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-red-300" role="alert">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            {error}
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

  if (isComputing || !result) {
    return (
      <div className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-3 pb-5
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(900px,calc(100vw-2rem))]
        sm:rounded-xl sm:pb-3">
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
  // Status pill driven by ITM mode when available (authoritative); geometric info is secondary
  let statusLabel: string;
  let statusColor: "cyan" | "orange" | "fuchsia" | "red";
  if (los.itmMode === "troposcatter") {
    statusLabel = "Beyond radio horizon";
    statusColor = "red";
  } else if (los.itmMode === "diffraction") {
    statusLabel = "Diffraction path";
    statusColor = "fuchsia";
  } else if (los.itmMode === "line_of_sight") {
    statusLabel = los.fresnelClear ? "Clear Line of Sight" : "LoS · Fresnel Intrusion";
    statusColor = los.fresnelClear ? "cyan" : "orange";
  } else {
    statusLabel = los.losClear
      ? (los.fresnelClear ? "Clear Line of Sight" : "LoS · Fresnel Intrusion")
      : "Obstructed";
    statusColor = los.losClear ? (los.fresnelClear ? "cyan" : "orange") : "red";
  }
  const statusClasses = {
    cyan: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300",
    orange: "bg-orange-500/15 border-orange-500/30 text-orange-300",
    fuchsia: "bg-fuchsia-500/15 border-fuchsia-500/30 text-fuchsia-300",
    red: "bg-red-500/15 border-red-500/30 text-red-300",
  }[statusColor];
  const dotColor = {
    cyan: "bg-cyan-400",
    orange: "bg-orange-400",
    fuchsia: "bg-fuchsia-400",
    red: "bg-red-400",
  }[statusColor];

  // Link budget per direction (TX→RX = from→to and to→from). Both must work for a usable link.
  const fwd = los.itmLossDb != null
    ? dirLinkBudget(fromHwIdx, fromAntIdx, toHwIdx, toAntIdx, los.itmLossDb)
    : null;
  const rev = los.itmLossDb != null
    ? dirLinkBudget(toHwIdx, toAntIdx, fromHwIdx, fromAntIdx, los.itmLossDb)
    : null;
  const worstMargin = fwd && rev ? Math.min(fwd.marginDb, rev.marginDb) : null;
  const marginColor = worstMargin == null
    ? ""
    : worstMargin >= 10 ? "text-emerald-300"
    : worstMargin >= 0 ? "text-yellow-300"
    : "text-red-300";

  return (
    <div
      ref={sheet.sheetRef}
      role="dialog"
      aria-label={`Line-of-sight analysis: ${fromLabel} to ${toLabel}`}
      className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl max-h-[82dvh] flex flex-col
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(1200px,calc(100vw-2rem))]
        sm:rounded-xl sm:max-h-none sm:block"
    >
      <div
        className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none shrink-0"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-white/20" />
      </div>

      <div
        className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-white/5 shrink-0 max-sm:touch-none"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
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
            {los.itmLossDb != null && (
              <>
                <span className="text-gray-600 mx-1">·</span>
                <span
                  className="text-cyan-300 font-medium"
                  title={
                    los.itmFreeSpaceDb != null
                      ? `Longley-Rice path loss. Free-space at this distance: ${Math.round(los.itmFreeSpaceDb)} dB (excess: ${Math.round(los.itmLossDb - los.itmFreeSpaceDb)} dB)`
                      : "Longley-Rice basic transmission loss"
                  }
                >
                  {Math.round(los.itmLossDb)} dB
                  {los.itmMode && (
                    <span className="text-gray-500 ml-1">
                      ({los.itmMode.replace("_", " ")})
                    </span>
                  )}
                </span>
              </>
            )}
            {worstMargin != null && fwd && rev && (
              <>
                <span className="text-gray-600 mx-1">·</span>
                <span
                  className={`font-medium ${marginColor}`}
                  title={
                    `Link margin vs ${LOS_PRESET.label}.\n` +
                    `${fromLabel} → ${toLabel}: RSSI ${Math.round(fwd.rssiDbm)} dBm, sens ${Math.round(fwd.sensitivityDbm)} dBm → ${fwd.marginDb >= 0 ? "+" : ""}${Math.round(fwd.marginDb)} dB\n` +
                    `${toLabel} → ${fromLabel}: RSSI ${Math.round(rev.rssiDbm)} dBm, sens ${Math.round(rev.sensitivityDbm)} dBm → ${rev.marginDb >= 0 ? "+" : ""}${Math.round(rev.marginDb)} dB\n` +
                    `Worst direction shown — both must be positive for a usable link.`
                  }
                >
                  {worstMargin >= 0 ? "+" : ""}{Math.round(worstMargin)} dB
                  <span className="text-gray-500 ml-1">margin</span>
                </span>
              </>
            )}
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
          {isRecomputing && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-400" role="status">
              <span className="w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              <span className="hidden sm:inline">Updating…</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => setMinimized((m) => !m)}
            className="sm:hidden p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label={minimized ? "Show details" : "Collapse to summary"}
            aria-expanded={!minimized}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={minimized ? "M5 15l7-7 7 7" : "M5 9l7 7 7-7"} />
            </svg>
          </button>
          <details className="text-[10px] text-gray-500 relative">
            <summary className="cursor-pointer hover:text-gray-400 select-none list-none" aria-label="About this analysis">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </summary>
            <div className="absolute right-0 bottom-full mb-1 min-w-65 w-72 p-2 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed space-y-1">
              <div>
                <strong>Geometry:</strong> real terrain elevations with{" "}
                <strong>4/3 earth radius</strong> for atmospheric refraction.
                Fresnel zone needs ≥60% clearance for "clear."
              </div>
              {los.itmLossDb != null && (
                <div className="pt-1 border-t border-white/5">
                  <strong>Path loss:</strong> Longley-Rice v1.4 (ITS) via WASM.
                  Assumes continental temperate climate, vertical polarization,
                  50 % reliability.
                </div>
              )}
              {worstMargin != null && (
                <div className="pt-1 border-t border-white/5">
                  <strong>Link margin:</strong> RX − sensitivity vs <strong>{LOS_PRESET.label}</strong>{" "}
                  ({LOS_PRESET.sensitivityDbm} dBm). Worst direction shown.
                </div>
              )}
              <div className="pt-1 border-t border-white/5">
                <strong>Terrain data:</strong>{" "}
                {demSource === "tilezen"
                  ? "Tilezen terrarium (USGS 3DEP / SRTM) via AWS Open Data"
                  : demSource === "mapbox-terrain-rgb"
                    ? "Mapbox terrain-rgb v1 (~30 m global, Tilezen fallback)"
                    : "awaiting first compute…"}
              </div>
              <div className="pt-1 border-t border-white/5">
                Frequency: <strong>{(los.frequencyGHz * 1000).toFixed(0)} MHz</strong>.
                "~" means node had no GPS altitude (or reported below terrain) —
                assumed as <strong>terrain + 2m</strong>.
              </div>
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

      {terrainWarning && (
        <div
          role="alert"
          className="flex items-center gap-2 px-3 py-1 text-[10px] text-amber-300 bg-amber-500/10 border-b border-amber-500/20 shrink-0"
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          {terrainWarning}
        </div>
      )}

      {/* Body: 3-column row on desktop (From | Profile | To); mobile stacks vertically
          with the profile on top, then the two endpoint configs. */}
      <div className={`flex flex-col sm:flex-row overscroll-contain min-h-0 sm:overflow-visible sm:flex-initial ${minimized ? "" : "flex-1 overflow-y-auto"}`}>
        <div className={`order-2 sm:order-1 w-full sm:w-36 sm:shrink-0 border-t sm:border-t-0 border-white/5 ${minimized ? "max-sm:hidden" : ""}`}>
          <EndpointConfig
            label={fromLabel}
            color={fromColor}
            hwIdx={fromHwIdx} onHwIdxChange={onFromHwIdxChange}
            antIdx={fromAntIdx} onAntIdxChange={onFromAntIdxChange}
            heightM={fromHeightM} onHeightChange={onFromHeightChange}
            usingGpsAltitude={!los.fromIsFallback}
          />
        </div>
        <div className="order-1 sm:order-2 flex-1 min-w-0 px-2 py-1.5 sm:border-x border-white/5">
          <ElevationProfile
            result={los}
            fromLabel={fromLabel}
            toLabel={toLabel}
            fromColor={fromColor}
            toColor={toColor}
            onHoverFraction={onProfileHover}
          />
        </div>
        <div className={`order-3 w-full sm:w-36 sm:shrink-0 border-t sm:border-t-0 border-white/5 ${minimized ? "max-sm:hidden" : ""}`}>
          <EndpointConfig
            label={toLabel}
            color={toColor}
            hwIdx={toHwIdx} onHwIdxChange={onToHwIdxChange}
            antIdx={toAntIdx} onAntIdxChange={onToAntIdxChange}
            heightM={toHeightM} onHeightChange={onToHeightChange}
            usingGpsAltitude={!los.toIsFallback}
          />
        </div>
      </div>
    </div>
  );
}
