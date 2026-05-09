import { useEffect, useRef, useState } from "react";

import { AggressionSlider, CanopyStatusChip, ClassLegend, ClutterStatusChip } from "./ClutterUI";
import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, type CoverageResult, MESHTASTIC_PRESETS, RELIABILITY_PRESETS } from "./coverageAnalysis";
import type { DemSource } from "./terrainRgb";
import { useBottomSheetGesture } from "./useBottomSheet";

/** Parse "lat, lng" (Google Maps format) → [lng, lat]. Returns null if invalid. */
function parseLatLng(input: string): [number, number] | null {
  const parts = input.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/** Coverage paint resolution. Standard=instant, Survey=2048² (1:1 with DEM, 4× Ultra cost). */
export type CoverageDetail = "standard" | "high" | "ultra" | "survey";

export const COVERAGE_DETAIL_SIZE: Record<CoverageDetail, number> = {
  standard: 512,
  high: 768,
  ultra: 1024,
  survey: 2048,
};

/** Per-Detail DEM tile cap. Higher = finer native zoom at smaller radii. Standard
 *  matches the Tilezen LRU size so default-tier repeats hit cache 100%. */
export const COVERAGE_DETAIL_MAX_TILES: Record<CoverageDetail, number> = {
  standard: 256,
  high: 512,
  ultra: 768,
  survey: 1024,
};

/** Info icon with hover tooltip. `align` picks the edge it anchors to. */
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
  isFetchingTerrain,
  progressCompleted,
  progressTotal,
  demSource,
  errorMessage,
  onRetry,
  onCancel,
  antennaIdx,
  onAntennaIdxChange,
  hardwareIdx,
  onHardwareIdxChange,
  rxHardwareIdx,
  onRxHardwareIdxChange,
  rxAntennaIdx,
  onRxAntennaIdxChange,
  rxHeightM,
  onRxHeightChange,
  customTxDbm,
  onCustomTxDbmChange,
  aggressionIdx,
  onAggressionIdxChange,
  clutterEnabled,
  onClutterEnabledChange,
  clutterStatus,
  canopyEnabled,
  onCanopyEnabledChange,
  canopyStatus,
  presetIdx,
  onPresetIdxChange,
  customSensitivityDbm,
  onCustomSensitivityChange,
  detail,
  onDetailChange,
  antennaHeightM,
  onAntennaHeightChange,
  reliability,
  onReliabilityChange,
  showContours,
  onShowContoursChange,
  showRays,
  onShowRaysChange,
  onExport,
  onOriginChange,
}: {
  result: CoverageResult | null;
  originLabel: string;
  terrainNeeded: boolean;
  onEnableTerrain?: () => void;
  onClose: () => void;
  isComputing: boolean;
  /** Terrain-fetch phase (before per-pixel compute). */
  isFetchingTerrain: boolean;
  /** Worker-pool slices completed; 0 when idle. */
  progressCompleted: number;
  /** Slices dispatched; 0 when idle. */
  progressTotal: number;
  /** DEM tile source (null until first compute). */
  demSource: DemSource | null;
  errorMessage: string | null;
  onRetry: () => void;
  onCancel: () => void;
  /** Index into COMMON_ANTENNAS. */
  antennaIdx: number;
  onAntennaIdxChange: (idx: number) => void;
  hardwareIdx: number;
  onHardwareIdxChange: (idx: number) => void;
  /** RX config (asymmetric); defaults match TX. */
  rxHardwareIdx: number;
  onRxHardwareIdxChange: (idx: number) => void;
  rxAntennaIdx: number;
  onRxAntennaIdxChange: (idx: number) => void;
  rxHeightM: number;
  onRxHeightChange: (m: number) => void;
  customTxDbm: number;
  onCustomTxDbmChange: (dbm: number) => void;
  /** Index into AGGRESSION_STOPS (0/1/2). Drives the per-pixel ITU clutter scaler. */
  aggressionIdx: number;
  onAggressionIdxChange: (idx: number) => void;
  /** Master on/off for the clutter model. Off → ITM-only path loss. */
  clutterEnabled: boolean;
  onClutterEnabledChange: (enabled: boolean) => void;
  /** Tile-availability telemetry from the most recent compute; null if none yet. */
  clutterStatus: { tilesPresent: number; tilesTotal: number } | null;
  /** Canopy-height tier on/off. Off → class-nominal heights (still under clutter aggression). */
  canopyEnabled: boolean;
  onCanopyEnabledChange: (enabled: boolean) => void;
  /** Canopy tile-availability telemetry; null if no compute yet. */
  canopyStatus: { tilesPresent: number; tilesTotal: number } | null;
  presetIdx: number;
  onPresetIdxChange: (idx: number) => void;
  customSensitivityDbm: number;
  onCustomSensitivityChange: (dbm: number) => void;
  detail: CoverageDetail;
  onDetailChange: (d: CoverageDetail) => void;
  /** Antenna AGL (m); overrides GPS altitude so the slider works for virtual + node origins. */
  antennaHeightM: number;
  onAntennaHeightChange: (m: number) => void;
  reliability: CoverageReliability;
  onReliabilityChange: (r: CoverageReliability) => void;
  showContours: boolean;
  onShowContoursChange: (show: boolean) => void;
  showRays: boolean;
  onShowRaysChange: (show: boolean) => void;
  onExport: (format: "geojson" | "kml") => void;
  /** Custom coord typed into the origin label. Caller detaches any anchor and moves the pin. */
  onOriginChange?: (lngLat: [number, number]) => void;
}) {
  const isCustomHardware = COMMON_HARDWARE[hardwareIdx]?.isCustom ?? false;
  const isCustomPreset = MESHTASTIC_PRESETS[presetIdx]?.isCustom ?? false;
  // Inline origin editor: Enter commits, Escape cancels, blur commits silently if valid
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [originDraft, setOriginDraft] = useState("");
  const [originDraftError, setOriginDraftError] = useState(false);

  // Text-based so field can be cleared while typing; commits on blur/Enter (blank → 2 m)
  const [heightInput, setHeightInput] = useState(String(antennaHeightM));
  useEffect(() => {
    setHeightInput(String(antennaHeightM));
  }, [antennaHeightM]);
  const commitHeight = () => {
    const trimmed = heightInput.trim();
    if (trimmed === "") {
      onAntennaHeightChange(2);
      setHeightInput("2");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      onAntennaHeightChange(2);
      setHeightInput("2");
      return;
    }
    const clamped = Math.max(0, Math.min(300, n));
    onAntennaHeightChange(clamped);
    setHeightInput(String(clamped));
  };

  const [rxHeightInput, setRxHeightInput] = useState(String(rxHeightM));
  useEffect(() => { setRxHeightInput(String(rxHeightM)); }, [rxHeightM]);
  const commitRxHeight = () => {
    const trimmed = rxHeightInput.trim();
    if (trimmed === "") {
      onRxHeightChange(2);
      setRxHeightInput("2");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      onRxHeightChange(2);
      setRxHeightInput("2");
      return;
    }
    const clamped = Math.max(0, Math.min(300, n));
    onRxHeightChange(clamped);
    setRxHeightInput(String(clamped));
  };

  // Lets the header "custom RX" pill open the advanced-settings <details>
  const gearRef = useRef<HTMLDetailsElement>(null);
  const sheet = useBottomSheetGesture(onClose);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const root = sheet.sheetRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      root.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => {
        d.removeAttribute("open");
      });
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [sheet.sheetRef]);

  if (terrainNeeded) {
    return (
      <div className="fixed z-1050 shadow-2xl border border-amber-500/30 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-4 pb-6 max-h-[75dvh] overflow-y-auto
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
        sm:rounded-xl sm:pb-4 sm:max-h-none sm:overflow-visible">
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

  // First-compute loading/error banner
  if (!result) {
    if (errorMessage) {
      return (
        <div className="fixed z-1050 shadow-2xl border border-red-500/40 bg-gray-900/90 backdrop-blur-xl
          inset-x-0 bottom-0 rounded-t-2xl p-3 pb-5
          sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
          sm:rounded-xl sm:pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-red-300 mb-1">
                Coverage failed
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">{errorMessage}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-[11px] px-2.5 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/25 transition-colors font-medium"
              >
                Retry
              </button>
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
    const progressPct = progressTotal > 0
      ? Math.round((progressCompleted / progressTotal) * 100)
      : 0;
    const stageLabel = isFetchingTerrain
      ? `Fetching terrain for ${originLabel}…`
      : progressTotal > 0
        ? `Computing coverage from ${originLabel} · ${progressCompleted}/${progressTotal} slices (${progressPct}%)`
        : `Computing coverage from ${originLabel}…`;
    return (
      <div className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-3 pb-5
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
        sm:rounded-xl sm:pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-400 min-w-0">
            <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="truncate">{stageLabel}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!isFetchingTerrain && (
              <button
                type="button"
                onClick={onCancel}
                className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/15 border border-red-500/40 text-red-200 hover:bg-red-500/25 transition-colors font-medium"
              >
                Cancel
              </button>
            )}
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
        {progressTotal > 0 && !isFetchingTerrain && (
          <div className="mt-1.5 h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full bg-cyan-400/80 transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>
    );
  }


  return (
    <div
      ref={sheet.sheetRef}
      className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl max-h-[78dvh] flex flex-col
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:bottom-3 sm:left-1/2 sm:-translate-x-1/2 sm:w-[min(640px,calc(100vw-2rem))]
        sm:rounded-xl sm:max-h-none sm:block"
      onClick={(e) => {
        // Close any open <details> popover when clicking elsewhere in the panel
        const target = e.target as Node;
        const openDetails = e.currentTarget.querySelectorAll<HTMLDetailsElement>("details[open]");
        openDetails.forEach((d) => {
          if (!d.contains(target)) d.removeAttribute("open");
        });
      }}
    >
      <div
        className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none shrink-0"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-white/20" />
      </div>

      {/* Status pill above the panel; splits terrain fetch vs compute. Error preempts. */}
      {errorMessage && !isComputing && (
        <div className="absolute -top-9 left-1/2 -translate-x-1/2 max-w-[calc(100%-1rem)] px-3 py-1.5 rounded-full
          bg-gray-900/95 backdrop-blur-xl border border-red-500/50 shadow-2xl
          text-[10px] text-red-200 flex items-center gap-2 whitespace-nowrap">
          <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.19 16a2 2 0 001.74 3z" />
          </svg>
          <span className="truncate">{errorMessage}</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 px-1.5 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-100 font-medium transition-colors"
          >
            Retry
          </button>
        </div>
      )}
      {isComputing && (() => {
        const pct = progressTotal > 0
          ? Math.round((progressCompleted / progressTotal) * 100)
          : 0;
        const label = isFetchingTerrain
          ? "Fetching terrain…"
          : progressTotal > 0
            ? `Recomputing · ${progressCompleted}/${progressTotal} slices (${pct}%)`
            : "Recomputing coverage…";
        return (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full
            bg-gray-900/95 backdrop-blur-xl border border-cyan-500/40 shadow-2xl
            text-[10px] text-cyan-200 flex items-center gap-2 whitespace-nowrap">
            <div className="w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
            <span>{label}</span>
            {!isFetchingTerrain && (
              <button
                type="button"
                onClick={onCancel}
                className="px-1.5 py-0 rounded bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-200 font-medium transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        );
      })()}

      <div
        className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 shrink-0 max-sm:touch-none"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" strokeWidth={2} strokeDasharray="3 3" />
              <circle cx="12" cy="12" r="1.5" strokeWidth={2} fill="currentColor" />
            </svg>
            Coverage
          </span>
          <div className="text-[11px] text-gray-300 flex items-center gap-1 min-w-0">
            <span className="text-gray-500 shrink-0">From:</span>
            {editingOrigin ? (
              <input
                type="text"
                autoFocus
                value={originDraft}
                placeholder="lat, lng"
                title="Enter coordinates as lat, lng (Google Maps format)"
                aria-invalid={originDraftError}
                onChange={(e) => {
                  setOriginDraft(e.target.value);
                  if (originDraftError) setOriginDraftError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const parsed = parseLatLng(originDraft);
                    if (!parsed) { setOriginDraftError(true); return; }
                    setEditingOrigin(false);
                    setOriginDraftError(false);
                    onOriginChange?.(parsed);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingOrigin(false);
                    setOriginDraftError(false);
                  }
                }}
                onBlur={() => {
                  // Commit silently if valid, otherwise just close. A
                  // bad value on blur is treated as a cancel so an
                  // accidental click-away doesn't blow up.
                  const parsed = parseLatLng(originDraft);
                  setEditingOrigin(false);
                  setOriginDraftError(false);
                  if (parsed) onOriginChange?.(parsed);
                }}
                className={`min-w-0 w-44 rounded-md bg-white/10 border px-1.5 py-0.5 text-[11px] font-mono text-gray-100
                  focus:outline-hidden focus:ring-1 ${
                    originDraftError
                      ? "border-red-500/60 focus:border-red-500/80 focus:ring-red-500/40"
                      : "border-cyan-500/40 focus:border-cyan-500/70 focus:ring-cyan-500/40"
                  }`}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  // Pre-fill with current pin coordinates (works whether the
                  // origin is a node anchor or a virtual placement).
                  const [lng, lat] = result.origin;
                  setOriginDraft(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
                  setEditingOrigin(true);
                }}
                title="Click to enter custom coordinates"
                className="font-medium text-gray-200 hover:text-cyan-300 hover:underline decoration-dotted underline-offset-2 transition-colors truncate min-w-0 cursor-pointer"
              >
                {originLabel}
              </button>
            )}
            <span className="text-gray-500 ml-1 shrink-0">·</span>
            <span className="text-gray-500 shrink-0">
              {Math.round(result.originHeightM)}m{result.originIsFallback ? "~" : ""}
            </span>
            {(() => {
              // Header pill surfaces asymmetric RX; click toggles the gear popover
              const rxMatchesTx =
                rxHardwareIdx === hardwareIdx &&
                rxAntennaIdx === antennaIdx &&
                rxHeightM === antennaHeightM;
              if (rxMatchesTx) return null;
              const hwLabel = COMMON_HARDWARE[rxHardwareIdx]?.label ?? "custom";
              const antDbi = COMMON_ANTENNAS[rxAntennaIdx]?.dbi ?? 3;
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    // stopPropagation so the panel's outside-click handler doesn't re-close
                    e.stopPropagation();
                    if (gearRef.current) {
                      gearRef.current.open = !gearRef.current.open;
                    }
                  }}
                  className="ml-1 shrink-0 px-1.5 py-0 rounded bg-cyan-500/15 border border-cyan-500/30 text-[9px] text-cyan-200 font-medium whitespace-nowrap hover:bg-cyan-500/25 hover:border-cyan-500/50 transition-colors cursor-pointer"
                  title={`Custom RX: ${hwLabel} with ${antDbi} dBi antenna at ${rxHeightM} m · click to edit`}
                >
                  RX {antDbi} dBi @ {rxHeightM}m
                </button>
              );
            })()}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Export dropdown; opens upward. */}
          <details className="text-[10px] text-gray-400 relative group">
            <summary
              className="cursor-pointer list-none p-1 rounded-md hover:text-gray-200 hover:bg-white/5 transition-colors flex items-center gap-1"
              aria-label="Export coverage"
              title="Export coverage"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
              </svg>
            </summary>
            <div className="absolute right-0 bottom-full mb-1 w-40 p-1 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl z-50 flex flex-col">
              <button
                type="button"
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  onExport("geojson");
                }}
                className="text-left px-2 py-1.5 rounded text-[11px] text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-200 transition-colors"
              >
                <div className="font-medium">GeoJSON</div>
                <div className="text-[9px] text-gray-500">QGIS · Leaflet · geojson.io</div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                  onExport("kml");
                }}
                className="text-left px-2 py-1.5 rounded text-[11px] text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-200 transition-colors"
              >
                <div className="font-medium">KML</div>
                <div className="text-[9px] text-gray-500">Google Earth · SPLAT!</div>
              </button>
            </div>
          </details>
          <details className="text-[10px] text-gray-500 relative">
            <summary className="cursor-pointer hover:text-gray-400 select-none list-none p-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </summary>
            <div className="fixed z-50 overflow-y-auto p-2.5 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed space-y-1
              inset-x-3 top-4 bottom-4 w-auto max-w-none
              sm:absolute sm:inset-auto sm:right-0 sm:bottom-full sm:top-auto sm:mb-1 sm:w-85 sm:max-w-[calc(100vw-1rem)] sm:max-h-none sm:overflow-visible">
              <div>Pixel color shows predicted <strong>link margin</strong> (RSSI minus sensitivity and fade margin). Cyan = very reliable, orange = marginal, magenta = at threshold. Unpainted terrain is below sensitivity.</div>
              <div className="pt-1 border-t border-white/5">
                <div className="text-gray-300 font-medium">Reliability</div>
                <div className="mt-0.5">
                  {RELIABILITY_PRESETS.find((p) => p.id === reliability)?.desc}
                </div>
              </div>
              <div className="pt-1 border-t border-white/5">
                <div className="text-gray-300 font-medium">Propagation model</div>
                <div className="font-mono text-[9px] text-gray-500 mt-0.5">
                  Longley-Rice v1.4 (ITS) via WASM
                </div>
                <div className="mt-1">
                  Per-pixel basic transmission loss from{" "}
                  <a
                    href="https://its.ntia.gov/software/itm"
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-300/80 hover:text-cyan-200 underline decoration-dotted"
                  >NTIA's Irregular Terrain Model</a>,
                  reference C++ ported to WebAssembly. Handles line-of-sight,
                  multi-edge diffraction, and troposcatter with 4/3 earth
                  refraction.
                </div>
              </div>

              <div className="pt-1 border-t border-white/5">
                <div className="text-gray-300 font-medium">Terrain data</div>
                <div className="font-mono text-[9px] text-gray-500 mt-0.5">
                  {demSource === "tilezen"
                    ? "Tilezen terrarium · USGS 3DEP (US) / SRTM (global)"
                    : demSource === "mapbox-terrain-rgb"
                      ? "Mapbox terrain-rgb v1 · global ~30 m"
                      : "awaiting first compute…"}
                </div>
                <div className="mt-1">
                  {demSource === "tilezen" ? (
                    <>
                      DEM fetched from{" "}
                      <a
                        href="https://registry.opendata.aws/terrain-tiles/"
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-300/80 hover:text-cyan-200 underline decoration-dotted"
                      >AWS Open Data Registry</a>{" "}
                      (Tilezen). In the US this is USGS 3DEP at ~10 m native
                      through z=15 — the same dataset RF tools
                      like SPLAT! and Radio Mobile use. Outside the US it
                      falls back to SRTM 30 m.
                    </>
                  ) : demSource === "mapbox-terrain-rgb" ? (
                    <>
                      DEM fetched from Mapbox's legacy{" "}
                      <code className="bg-white/10 px-1 rounded-sm">terrain-rgb</code>{" "}
                      tileset via the v4 Tiles API. Fallback path — the
                      preferred Tilezen source wasn't reachable for this
                      compute. Can under-read mountain peaks by 100-200 m
                      vs. 3DEP data.
                    </>
                  ) : (
                    <>
                      Once the first compute completes this will show which
                      tile source was used (Tilezen 3DEP preferred, Mapbox
                      terrain-rgb fallback).
                    </>
                  )}
                </div>
              </div>
              <div className="pt-1 border-t border-white/5">
                <div className="text-gray-300 font-medium">Link budget</div>
                <div className="mt-0.5">
                  {(() => {
                    const rp = RELIABILITY_PRESETS.find((p) => p.id === reliability) ?? RELIABILITY_PRESETS[1];
                    return (
                      <>
                        Climate: <strong>Continental Temperate</strong> ·
                        Reliability: <strong>{rp.time} / {rp.location} / {rp.situation} %</strong>{" "}
                        (time / location / situation) · Cable loss: <strong>0.5 dB</strong> ·
                        Fade margin: <strong>15 dB</strong> ·
                        TX antenna: <strong>{result.txAntennaDbi} dBi</strong> ·
                        RX antenna: <strong>{result.rxAntennaDbi} dBi</strong> @
                        <strong> {Math.round(result.rxAntennaHeightAboveGroundM)} m</strong> AGL ·
                        RX sensitivity: <strong>{result.rxSensitivityDbm} dBm</strong>{" "}
                        (real-world; SX1262 datasheet is ~3 dB more sensitive).
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="text-amber-300/80 pt-1 border-t border-white/5 mt-1">
                <strong>Caveats:</strong> RX sensitivity uses real-world typical
                values (~3 dB worse than datasheet) and adjusts down another
                ~2 dB for SX1276-based boards (Heltec v2). ITM does not model
                buildings or foliage; the <em>Environment</em> selector adds a
                flat clutter loss as a rough compensation. RX hardware,
                antenna, and height live in the gear popover (the TX side is
                configured in the main panel above); the default RX models a
                stock Heltec V3 with the rubber-duck antenna at 2 m, so
                out-of-box results show what a typical handheld would hear. Analysis area is capped at{" "}
                <strong>200 km radius</strong> so the DEM at the pin stays fine
                enough to capture actual peaks — use the LOS tool for specific
                longer-range point-to-point links.
              </div>
            </div>
          </details>

          {/* Advanced-settings gear popover (environment, reliability, detail, contours, RX). */}
          <details ref={gearRef} className="text-[10px] text-gray-400 relative">
            <summary
              className="cursor-pointer list-none p-1 rounded-md hover:text-gray-200 hover:bg-white/5 transition-colors"
              aria-label="Advanced settings"
              title="Advanced settings"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </summary>
            {/* xl+: fixed to right of panel so status pill isn't blocked; below xl: opens upward. */}
            <div className="fixed z-50 overflow-y-auto p-3 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl space-y-3
              inset-x-3 top-4 bottom-4 w-auto max-w-none
              sm:absolute sm:inset-auto sm:right-0 sm:bottom-full sm:top-auto sm:mb-1 sm:w-90 sm:max-w-[calc(100vw-1rem)] sm:max-h-none sm:overflow-visible
              xl:fixed xl:bottom-3 xl:top-auto xl:right-auto xl:mb-0 xl:w-96
              xl:left-[calc(50%+332px)] xl:overflow-visible">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                Advanced settings
              </div>

              {/* Receiver — asymmetric RX. Non-default values surface as a header pill. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                    <span>Receiver</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      // Heltec V3 + rubber duck @ 2 m
                      onRxHardwareIdxChange(4);
                      onRxAntennaIdxChange(0);
                      onRxHeightChange(2);
                    }}
                    className="text-[9px] text-cyan-400/70 hover:text-cyan-300 transition-colors"
                    title="Reset RX to stock handheld (Heltec V3, rubber duck, 2 m)"
                  >
                    Reset to handheld
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="coverage-rx-hw" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
                      <span>Hardware</span>
                      <InfoTip align="left">
                        RX hardware drives the chipset-aware sensitivity
                        correction (SX1276 boards get an additional ~2 dB
                        penalty over SX1262). TX power is unused on this
                        side — ITM treats RX as a passive receiver.
                      </InfoTip>
                    </label>
                    <select
                      id="coverage-rx-hw"
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
                    <label htmlFor="coverage-rx-ant" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Antenna
                    </label>
                    <select
                      id="coverage-rx-ant"
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
                <div>
                  <label htmlFor="coverage-rx-height" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
                    <span>Height above ground</span>
                    <InfoTip align="left">
                      RX antenna height over local terrain (m). 2 m =
                      handheld default. Use 6-10 m for a typical rooftop
                      station, 30 m+ for tower-mounted receivers.
                    </InfoTip>
                  </label>
                  <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-24">
                    <input
                      id="coverage-rx-height"
                      type="text"
                      inputMode="decimal"
                      value={rxHeightInput}
                      onChange={(e) => setRxHeightInput(e.target.value)}
                      onBlur={commitRxHeight}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                          setRxHeightInput(String(rxHeightM));
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      aria-label="RX antenna height above ground (meters)"
                      title="RX height above local terrain (m). Blank = 2 m default."
                      className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 text-center focus:outline-hidden"
                    />
                    <span className="text-[10px] text-gray-500 shrink-0">m</span>
                  </div>
                </div>
              </div>

              {/* Clutter (per-pixel ITU model + aggression scaler). */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                    <span>Clutter</span>
                    <InfoTip align="left">
                      Per-pixel building / vegetation loss from USGS NLCD land
                      cover, applied via ITU-R P.452-17 (endpoint clutter) and
                      P.833-9 (path-traversed vegetation). Toggle off for
                      ITM-only bare-earth predictions.
                    </InfoTip>
                  </label>
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-300 cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={clutterEnabled}
                      onChange={(e) => onClutterEnabledChange(e.target.checked)}
                      className="w-3 h-3 accent-cyan-500 cursor-pointer"
                    />
                    <span>Enabled</span>
                  </label>
                </div>
                <AggressionSlider aggressionIdx={aggressionIdx} onChange={onAggressionIdxChange} enabled={clutterEnabled} />
                <ClutterStatusChip status={clutterStatus} enabled={clutterEnabled} />
                <ClassLegend />
                <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/5">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                    <span>Canopy heights</span>
                    <InfoTip align="left">
                      Per-pixel measured canopy heights from ETH Global Canopy
                      Height 2020 (Lang et al. 2023, 10 m). Replaces class-nominal
                      heights in ITU-R P.833-9 vegetation loss for forest classes.
                      Toggle off to fall back to class-nominal heights everywhere.
                    </InfoTip>
                  </label>
                  <label className="flex items-center gap-1.5 text-[10px] text-gray-300 cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={canopyEnabled}
                      onChange={(e) => onCanopyEnabledChange(e.target.checked)}
                      className="w-3 h-3 accent-cyan-500 cursor-pointer"
                    />
                    <span>Enabled</span>
                  </label>
                </div>
                <CanopyStatusChip status={canopyStatus} enabled={canopyEnabled} />
              </div>

              {/* Reliability (ITM TLS preset) */}
              <div>
                <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
                  <span>Reliability</span>
                  <InfoTip align="left">
                    ITM's time / location / situation percentages. Higher =
                    "works most of the time" instead of "works half the time."
                    Typical (90/50/70) is the industry planning default.
                    Median matches Radio&nbsp;Mobile / SPLAT!; Conservative is
                    for mission-critical links.
                  </InfoTip>
                </label>
                <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[10px] font-medium">
                  {RELIABILITY_PRESETS.map((p) => {
                    const active = reliability === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onReliabilityChange(p.id)}
                        title={p.desc}
                        className={`flex-1 rounded-md px-1.5 py-1 transition-colors ${
                          active
                            ? "bg-cyan-500/20 text-cyan-200"
                            : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                        }`}
                      >
                        <div>{p.label}</div>
                        <div className="text-[9px] text-gray-500 font-normal">
                          {p.time}/{p.location}/{p.situation}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Detail (output raster resolution). */}
              <div>
                <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
                  <span>Detail</span>
                  <InfoTip align="left">
                    Output raster resolution (painted pixels). Higher detail
                    = crisper edges around terrain features when zoomed in,
                    but slower to compute. Standard feels instant; Ultra is
                    a one-off survey. Survey matches the 2048² DEM 1:1 — the
                    sharpest possible output, 4× the compute of Ultra.
                  </InfoTip>
                </label>
                <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[10px] font-medium">
                  {([
                    { key: "standard", label: "Std",    sub: "512 px" },
                    { key: "high",     label: "High",   sub: "768 px" },
                    { key: "ultra",    label: "Ultra",  sub: "1024 px" },
                    { key: "survey",   label: "Survey", sub: "2048 px" },
                  ] as const).map((opt) => {
                    const active = detail === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => onDetailChange(opt.key)}
                        className={`flex-1 rounded-md px-1.5 py-1 transition-colors ${
                          active
                            ? "bg-cyan-500/20 text-cyan-200"
                            : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                        }`}
                      >
                        <div>{opt.label}</div>
                        <div className="text-[9px] text-gray-500 font-normal">{opt.sub}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Overlay toggles (contours + rays); both extracted from margin grid, no recompute. */}
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showContours}
                    onChange={(e) => onShowContoursChange(e.target.checked)}
                    className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                  />
                  <span className="inline-flex items-center gap-1 min-w-0">
                    Iso-margin contours
                    <InfoTip align="left">
                      Overlay iso-margin lines at 0 dB (magenta — edge of
                      coverage), +10 dB (cyan — reliable), and +20 dB (deep
                      cyan — strong signal).
                    </InfoTip>
                  </span>
                </label>

                <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none shrink-0">
                  <input
                    type="checkbox"
                    checked={showRays}
                    onChange={(e) => onShowRaysChange(e.target.checked)}
                    className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
                  />
                  <span className="inline-flex items-center gap-1 min-w-0">
                    Visibility rays
                    <InfoTip align="left">
                      Draws a fan of per-azimuth sightlines from the origin
                      — the HeyWhatsThat-style view. Each ray shows where
                      the link budget stays above threshold along that
                      bearing. Useful for spotting specific paths that
                      punch through to distant ridges (which the smooth
                      coverage raster averages away).
                    </InfoTip>
                  </span>
                </label>
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

      <div className="p-3 pb-5 space-y-3 overflow-y-auto overscroll-contain min-h-0 flex-1 sm:pb-3 sm:overflow-visible">
        {/* Reachability summary + RSSI gradient legend */}
        {(() => {
          const reachablePx = result.clearCount + result.fresnelCount;
          const totalPx = reachablePx + result.blockedCount;
          const pct = totalPx > 0 ? (reachablePx / totalPx) * 100 : 0;
          // DEM bbox padded 5% each side → (2·r·1.05)²
          const scannedKm2 = (2 * result.radiusKm * 1.05) ** 2;
          const reachableKm2 = scannedKm2 * (totalPx > 0 ? reachablePx / totalPx : 0);
          const fmt = (n: number) => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);

          // Diagnostics: <5% terrain coverage → tile source issue; 0 reachable → link budget fails
          const terrainCoverage = result.scannedPixels > 0
            ? totalPx / result.scannedPixels
            : 0;
          const noTerrainData = terrainCoverage < 0.05;
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
                  background: "linear-gradient(to right, #d946ef 0%, #f97316 20%, #06b6d4 55%, #0891b2 100%)",
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
                        <strong>No terrain data</strong> delivered for the pin
                        area. Usually a transient network issue with the
                        terrain tile source — click Retry, or try a different
                        location.
                      </>
                    ) : (
                      <>
                        <strong>Link budget fails everywhere</strong> within range.
                        Try a slower modem preset (LongFast or LongSlow),
                        more TX power, a higher-gain antenna, or a smaller
                        analysis range.
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Primary controls (hardware, modem, antenna); advanced settings live in the gear popover */}
        <div className="grid grid-cols-2 gap-2">
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

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="coverage-antenna" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
              Antenna Gain
            </label>
            <select
              id="coverage-antenna"
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
          <div>
            <label htmlFor="coverage-antenna-height" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
              <span>Antenna Height</span>
              <InfoTip align="right">
                Height of the antenna above the pin location. For a
                node-anchored pin, height stacks on top of the node's GPS
                altitude. Defaults to 2 m (handheld).
              </InfoTip>
            </label>
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-20">
              <input
                id="coverage-antenna-height"
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
                aria-label="Antenna height above the pin (meters)"
                title="Antenna height above the pin (m). Blank = 2 m default."
                className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 text-center
                  focus:outline-hidden"
              />
              <span className="text-[10px] text-gray-500 shrink-0">m</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
