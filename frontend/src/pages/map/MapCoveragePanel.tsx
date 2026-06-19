import { useEffect, useMemo, useRef, useState } from "react";

import { AggressionSlider, BuildingStatusChip, CanopyStatusChip, ClassLegend, ClutterStatusChip } from "./ClutterUI";
import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, type CoverageResult, type MergeOrigin, MESHTASTIC_PRESETS, RELIABILITY_PRESETS } from "./coverageAnalysis";
import { COVERAGE_DETAIL_SIZE,type CoverageDetail } from "./coverageDetail";
import { NumericDraftInput } from "./NumericDraftInput";
import { Segmented } from "./Segmented";
import type { DemSource } from "./terrainRgb";
import { useBottomSheetGesture } from "./useBottomSheet";

interface MergeNodeOption {
  id: string;
  shortname?: string;
  longname?: string;
}

/** Parse "lat, lng" → [lng, lat]. Accepts a trailing ° and N/S/E/W hemisphere
 *  (e.g. "37.5° N, 122.3° W"). Returns null if invalid. */
function parseLatLng(input: string): [number, number] | null {
  const cleaned = input.trim().replace(/°/g, "");
  let latStr: string;
  let lngStr: string;
  if (cleaned.includes(",")) {
    const parts = cleaned.split(",");
    if (parts.length !== 2) return null;
    [latStr, lngStr] = parts;
  } else {
    const toks = cleaned.split(/\s+/).filter(Boolean);
    if (toks.length === 2) [latStr, lngStr] = toks;
    else if (toks.length === 4) { latStr = `${toks[0]} ${toks[1]}`; lngStr = `${toks[2]} ${toks[3]}`; }
    else return null;
  }
  const parse = (t: string): number | null => {
    const m = t.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
    if (!m) return null;
    let v = Number(m[1]);
    const h = m[2]?.toUpperCase();
    if (h === "S" || h === "W") v = -Math.abs(v);
    return Number.isFinite(v) ? v : null;
  };
  const lat = parse(latStr);
  const lng = parse(lngStr);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/** Info icon with hover/focus tooltip. `align` picks the edge it anchors to. */
function InfoTip({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <span className="relative inline-flex items-center group">
      <button
        type="button"
        aria-label="More information"
        className="inline-flex items-center text-gray-600 group-hover:text-gray-400 transition-colors rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      <span
        className={`invisible group-hover:visible group-focus-within:visible absolute bottom-full mb-1 w-60 max-w-[calc(100vw-1rem)] p-2 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-[10px] text-gray-300 leading-relaxed z-50 normal-case tracking-normal font-normal ${
          align === "left" ? "left-0" : "right-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/** Collapsible row: header summarizes current state, body holds inline editors. */
function Row({
  icon,
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  summary: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-white/5 border border-white/5 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/3 transition-colors text-left"
      >
        <span className="text-gray-400 shrink-0 w-4 h-4 inline-flex items-center justify-center">{icon}</span>
        <span className="text-[11px] font-medium text-gray-200 shrink-0">{title}</span>
        <span className="text-[10px] text-gray-500 truncate flex-1 min-w-0 text-right">{summary}</span>
        <svg
          className={`w-3.5 h-3.5 text-gray-500 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 pt-2 border-t border-white/5 space-y-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

type RowKey = "tx" | "rx" | "env" | "acc" | "ov";

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
  buildingsEnabled,
  onBuildingsEnabledChange,
  buildingsStatus,
  mergeOrigins,
  onAddMergeOriginById,
  onRemoveMergeOrigin,
  onClearMergeOrigins,
  mergeNodeOptions,
  pickingMergeOrigin,
  onStartPickMergeOrigin,
  onCancelPickMergeOrigin,
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
  onScanFromHere,
  overlayMode = false,
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
  /** Building-height tier on/off. Off → bare-earth DEM + class-nominal endpoint h_a. */
  buildingsEnabled: boolean;
  onBuildingsEnabledChange: (enabled: boolean) => void;
  /** Building tile-availability telemetry; null if no compute yet. */
  buildingsStatus: { tilesPresent: number; tilesTotal: number } | null;
  /** Additional origins layered on top of the primary; per-pixel max margin. */
  mergeOrigins: MergeOrigin[];
  onAddMergeOriginById: (nodeId: string) => void;
  onRemoveMergeOrigin: (id: string) => void;
  onClearMergeOrigins: () => void;
  /** Searchable list of nodes available to add as merge origins. */
  mergeNodeOptions: MergeNodeOption[];
  /** True while the next map click will drop a virtual merge pin. */
  pickingMergeOrigin: boolean;
  onStartPickMergeOrigin: () => void;
  onCancelPickMergeOrigin: () => void;
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
  /** Desktop-only: open the Scan tool against the same origin + settings,
   *  leaving the coverage paint visible underneath. */
  onScanFromHere?: () => void;
  /** True while a Scan-from-here overlay is active. Forces the panel to
   *  stay minimized so the map stays clear. */
  overlayMode?: boolean;
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

  // The parent already excludes the primary from `mergeNodeOptions`; we just
  // filter out IDs already in the merge set on top of that.
  const [mergeOriginSearch, setMergeOriginSearch] = useState("");
  const [mergeHighlight, setMergeHighlight] = useState(0);
  const mergeOriginCandidates = useMemo(() => {
    const q = mergeOriginSearch.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set(mergeOrigins.map((o) => o.id));
    return mergeNodeOptions
      .filter((n) => !taken.has(n.id))
      .filter((n) =>
        (n.shortname?.toLowerCase().includes(q) ?? false) ||
        (n.longname?.toLowerCase().includes(q) ?? false) ||
        n.id.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [mergeOriginSearch, mergeOrigins, mergeNodeOptions]);
  useEffect(() => setMergeHighlight(0), [mergeOriginSearch]);

  const selectMergeOrigin = (id: string) => {
    onAddMergeOriginById(id);
    setMergeOriginSearch("");
  };
  const onMergeSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMergeHighlight((i) => Math.min(i + 1, mergeOriginCandidates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMergeHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && mergeOriginCandidates[mergeHighlight]) {
      e.preventDefault();
      selectMergeOrigin(mergeOriginCandidates[mergeHighlight].id);
    } else if (e.key === "Escape") {
      setMergeOriginSearch("");
    }
  };

  const [expandedRow, setExpandedRow] = useState<RowKey | null>(null);
  const toggleRow = (k: RowKey) => setExpandedRow((cur) => (cur === k ? null : k));

  const [minimized, setMinimized] = useState(false);

  // Auto-minimize on the first result for each new origin so the painted
  // coverage is visible on the map. Recomputes for the same origin leave
  // the panel state alone so the user keeps seeing what they're tweaking.
  const lastAutoMinKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!result) return;
    const key = `${result.origin[0]},${result.origin[1]}`;
    if (lastAutoMinKeyRef.current !== key) {
      lastAutoMinKeyRef.current = key;
      setMinimized(true);
    }
  }, [result]);

  // Force-minimize on entering Scan-from-here overlay so the map stays clear.
  const prevOverlayRef = useRef(overlayMode);
  useEffect(() => {
    if (overlayMode && !prevOverlayRef.current) setMinimized(true);
    prevOverlayRef.current = overlayMode;
  }, [overlayMode]);

  // Without a snapshot, unchecking "Same as transmitter" would be a visual
  // no-op — rxMatchesTx is derived, so the values still match TX.
  const rxSnapshotRef = useRef<{ hw: number; ant: number; height: number } | null>(null);

  const sheet = useBottomSheetGesture({
    onClose,
    minimized,
    onMinimize: () => setMinimized(true),
    onExpand: () => setMinimized(false),
  });

  // Close any open <details> popovers (the ⋯ menu, stats info) on outside-click
  // or Escape; pointerdown covers touch.
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

  // Modal terrain prompt: focus its primary action on mount.
  const terrainBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (terrainNeeded && onEnableTerrain) requestAnimationFrame(() => terrainBtnRef.current?.focus());
  }, [terrainNeeded, onEnableTerrain]);

  if (terrainNeeded) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="3D terrain required for coverage prediction"
        className="fixed z-1050 shadow-2xl border border-amber-500/30 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-4 pb-6 max-h-[75dvh] overflow-y-auto
        sm:inset-x-auto sm:bottom-3 sm:left-[calc(50%+var(--map-pad)/2)] sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
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
          sm:inset-x-auto sm:bottom-3 sm:left-[calc(50%+var(--map-pad)/2)] sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
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
        sm:inset-x-auto sm:bottom-3 sm:left-[calc(50%+var(--map-pad)/2)] sm:-translate-x-1/2 sm:w-[min(520px,calc(100vw-2rem))]
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

  // Derived summaries for collapsed row headers
  const txHardware = COMMON_HARDWARE[hardwareIdx]?.label ?? "Custom";
  const txAntDbi = COMMON_ANTENNAS[antennaIdx]?.dbi ?? 0;
  const txPreset = MESHTASTIC_PRESETS[presetIdx]?.label ?? "Custom";
  const rxMatchesTx =
    rxHardwareIdx === hardwareIdx &&
    rxAntennaIdx === antennaIdx &&
    rxHeightM === antennaHeightM;
  const rxHardware = COMMON_HARDWARE[rxHardwareIdx]?.label ?? "Custom";
  const rxAntDbi = COMMON_ANTENNAS[rxAntennaIdx]?.dbi ?? 0;
  const reliabilityLabel = RELIABILITY_PRESETS.find((p) => p.id === reliability)?.label ?? "Typical";

  const txSummary = (
    <>
      {txHardware} · {txAntDbi} dBi · {antennaHeightM}m · {txPreset}
      {mergeOrigins.length > 0 && (
        <span className="text-cyan-300 ml-1">+{mergeOrigins.length}</span>
      )}
    </>
  );

  const rxSummary = rxMatchesTx
    ? <span>Same as TX</span>
    : <span className="text-cyan-300">{rxHardware} · {rxAntDbi} dBi · {rxHeightM}m</span>;

  const envParts: string[] = [];
  if (clutterEnabled) envParts.push("clutter");
  if (canopyEnabled) envParts.push("canopy");
  if (buildingsEnabled) envParts.push("buildings");
  const envSummary = envParts.length === 0 ? "All off · bare earth" : envParts.join(" · ");

  const accSummary = `${reliabilityLabel} · ${COVERAGE_DETAIL_SIZE[detail]} px`;

  const ovParts: string[] = [];
  if (showContours) ovParts.push("contours");
  if (showRays) ovParts.push("rays");
  const ovSummary = ovParts.length === 0 ? "None" : ovParts.join(" · ");

  return (
    <div
      ref={sheet.sheetRef}
      role="dialog"
      aria-label={`Coverage prediction from ${originLabel}`}
      className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl max-h-[78dvh] flex flex-col
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:bottom-3 sm:left-[calc(50%+var(--map-pad)/2)] sm:-translate-x-1/2 sm:w-[min(560px,calc(100vw-2rem))]
        sm:rounded-xl sm:max-h-[calc(100dvh-2rem)] sm:flex sm:flex-col"
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
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] px-3 py-1 rounded-full
            bg-gray-900/95 backdrop-blur-xl border border-cyan-500/40 shadow-2xl
            text-[10px] text-cyan-200 flex items-center gap-2 whitespace-nowrap">
            <div className="w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="truncate min-w-0">{label}</span>
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
                  // Treat a bad value on blur as a cancel so a click-away
                  // doesn't reset the pin to nonsense.
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
            <span
              className="text-gray-500 shrink-0"
              title={result.originIsFallback ? "Elevation sampled from terrain (no GPS altitude for this origin)" : undefined}
            >
              {Math.round(result.originHeightM)}m{result.originIsFallback ? "~" : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setMinimized((m) => !m)}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label={minimized ? "Expand panel" : "Minimize panel"}
            aria-expanded={!minimized}
            title={minimized ? "Expand — coverage tool is still running" : "Minimize — keep tool running, hide controls"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {minimized ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 9l7 7 7-7" />
              )}
            </svg>
          </button>
          <details className="text-[10px] text-gray-400 relative">
            <summary
              className="cursor-pointer list-none p-1 rounded-md hover:text-gray-200 hover:bg-white/5 transition-colors flex items-center"
              aria-label="More options"
              title="More options"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </summary>
            <div className="absolute right-0 top-full mt-1 w-44 p-1 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl z-50 flex flex-col">
              <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-gray-500 font-medium">
                Export
              </div>
              <button
                type="button"
                disabled={!result}
                onClick={(e) => {
                  const d = e.currentTarget.closest("details") as HTMLDetailsElement | null;
                  d?.removeAttribute("open");
                  d?.querySelector<HTMLElement>("summary")?.focus();
                  onExport("geojson");
                }}
                className="text-left px-2 py-1.5 rounded text-[11px] text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-200 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-200 disabled:cursor-not-allowed"
              >
                <div className="font-medium">GeoJSON</div>
                <div className="text-[9px] text-gray-500">QGIS · Leaflet · geojson.io</div>
              </button>
              <button
                type="button"
                disabled={!result}
                onClick={(e) => {
                  const d = e.currentTarget.closest("details") as HTMLDetailsElement | null;
                  d?.removeAttribute("open");
                  d?.querySelector<HTMLElement>("summary")?.focus();
                  onExport("kml");
                }}
                className="text-left px-2 py-1.5 rounded text-[11px] text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-200 transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-200 disabled:cursor-not-allowed"
              >
                <div className="font-medium">KML</div>
                <div className="text-[9px] text-gray-500">Google Earth · SPLAT!</div>
              </button>
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

      <div className="px-3 pt-2 pb-1 shrink-0">
        {(() => {
          const reachablePx = result.clearCount + result.fresnelCount;
          const totalPx = reachablePx + result.blockedCount;
          const pct = totalPx > 0 ? (reachablePx / totalPx) * 100 : 0;
          const scannedKm2 = (2 * result.radiusKm * 1.05) ** 2;
          const reachableKm2 = scannedKm2 * (totalPx > 0 ? reachablePx / totalPx : 0);
          const fmt = (n: number) => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);

          const terrainCoverage = result.scannedPixels > 0
            ? totalPx / result.scannedPixels
            : 0;
          const noTerrainData = terrainCoverage < 0.05;
          const noLinkBudget = !noTerrainData && reachablePx === 0;
          return (
            <div className={`px-2.5 py-2 rounded-lg bg-white/5 transition-shadow ${isComputing ? "shadow-[inset_0_0_0_1px_rgba(34,211,238,0.45)]" : ""}`}>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-gray-500 uppercase tracking-wider">Reachable</span>
                <span className={`text-emerald-300 font-medium tabular-nums transition-opacity ${isComputing ? "opacity-50" : ""}`}>
                  {reachablePx > 0 && reachableKm2 < 0.1 ? "<0.1" : `~${fmt(reachableKm2)}`} km²
                </span>
                <span className={`text-gray-500 tabular-nums transition-opacity ${isComputing ? "opacity-50" : ""}`}>
                  ({pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of {fmt(scannedKm2)} km²)
                </span>
                {isComputing && (
                  <span className="inline-flex items-center gap-1 text-cyan-300 font-medium">
                    <span className="w-2 h-2 border border-cyan-400 border-t-transparent rounded-full animate-spin" />
                    Updating…
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1.5">
                  {onScanFromHere && (
                    <button
                      type="button"
                      onClick={onScanFromHere}
                      className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-medium text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-500/50 transition-colors"
                      title="Run a Line-of-Sight scan against every node in range from this same origin — coverage paint stays visible underneath"
                    >
                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
                      </svg>
                      Scan nodes
                    </button>
                  )}
                  <details className="text-[10px] text-gray-500 relative">
                    <summary className="cursor-pointer hover:text-gray-300 select-none list-none inline-flex items-center" title="What does this mean?" aria-label="What does this mean?">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </summary>
                    <div className="fixed z-50 overflow-y-auto p-2.5 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl text-gray-400 leading-relaxed space-y-1 text-[10px]
                      inset-x-3 top-4 bottom-4 w-auto max-w-none
                      sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:mt-1 sm:bottom-auto sm:w-85 sm:max-w-[calc(100vw-1rem)] sm:max-h-[60dvh]">
                      <button
                        type="button"
                        onClick={(e) => {
                          const d = e.currentTarget.closest("details") as HTMLDetailsElement | null;
                          d?.removeAttribute("open");
                          d?.querySelector<HTMLElement>("summary")?.focus();
                        }}
                        className="sm:hidden absolute top-1.5 right-1.5 p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-white/10"
                        aria-label="Close"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
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
                        buildings or foliage; the <em>Environment</em> row adds a
                        flat clutter loss as a rough compensation. Analysis area is
                        capped at <strong>200 km radius</strong> so the DEM at the
                        pin stays fine enough to capture actual peaks — use the
                        LOS tool for specific longer-range point-to-point links.
                      </div>
                    </div>
                  </details>
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
          );
        })()}
      </div>

      <div className={`px-3 pb-5 space-y-2 overflow-y-auto overscroll-contain min-h-0 flex-1 sm:pb-3 ${minimized ? "hidden" : ""}`}>
        <Row
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M5 12a7 7 0 0114 0M2 12a10 10 0 0120 0M9 12a3 3 0 116 0M12 12v9" />
            </svg>
          }
          title="Transmitter"
          summary={txSummary}
          expanded={expandedRow === "tx"}
          onToggle={() => toggleRow("tx")}
        >
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
                  <NumericDraftInput
                    value={customTxDbm}
                    onCommit={onCustomTxDbmChange}
                    min={10}
                    max={35}
                    inputMode="numeric"
                    ariaLabel="Custom TX power (dBm)"
                    title="TX power in dBm (10–35)"
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
                  <NumericDraftInput
                    value={customSensitivityDbm}
                    onCommit={onCustomSensitivityChange}
                    min={-150}
                    max={-100}
                    ariaLabel="Custom RX sensitivity (dBm)"
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
              <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-24">
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
                  className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 text-center focus:outline-hidden"
                />
                <span className="text-[10px] text-gray-500 shrink-0">m</span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5 pt-1 border-t border-white/5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                <span>Additional origins{mergeOrigins.length > 0 && ` (${mergeOrigins.length})`}</span>
                <InfoTip align="left">
                  Add other nodes to layer on top of the primary origin —
                  the painted coverage takes the per-pixel best signal
                  across all origins. Useful for asking "where can my mesh
                  reach if any of these nodes works?" without picking
                  one as primary. Session-only — not persisted.
                </InfoTip>
              </label>
              {mergeOrigins.length > 0 && (
                <button
                  type="button"
                  onClick={onClearMergeOrigins}
                  className="text-[10px] text-gray-500 hover:text-red-300"
                >
                  Clear
                </button>
              )}
            </div>
            {mergeOrigins.length > 0 && (
              <div className="flex flex-col gap-1">
                {mergeOrigins.map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 text-[10px] text-gray-300"
                  >
                    <span className="truncate min-w-0 flex-1">{o.label}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveMergeOrigin(o.id)}
                      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded leading-none text-gray-500 hover:text-red-300 hover:bg-white/10 transition-colors"
                      aria-label={`Remove ${o.label} from merged origins`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={mergeOriginSearch}
                onChange={(e) => setMergeOriginSearch(e.target.value)}
                onKeyDown={onMergeSearchKey}
                placeholder="Search nodes to add…"
                aria-label="Search nodes to add as a merged origin"
                role="combobox"
                aria-expanded={mergeOriginSearch.trim() !== "" && mergeOriginCandidates.length > 0}
                aria-controls="merge-origin-listbox"
                aria-autocomplete="list"
                aria-activedescendant={
                  mergeOriginSearch.trim() !== "" && mergeOriginCandidates[mergeHighlight]
                    ? `merge-origin-opt-${mergeOriginCandidates[mergeHighlight].id}`
                    : undefined
                }
                className="flex-1 min-w-0 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-cyan-500/50"
              />
              <button
                type="button"
                onClick={pickingMergeOrigin ? onCancelPickMergeOrigin : onStartPickMergeOrigin}
                title={pickingMergeOrigin ? "Cancel pick (or press Esc)" : "Click on the map to drop a pin"}
                className={`px-2 py-1 rounded-md border text-[10px] whitespace-nowrap shrink-0 transition-colors ${
                  pickingMergeOrigin
                    ? "bg-amber-500/20 border-amber-500/40 text-amber-200"
                    : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10"
                }`}
              >
                {pickingMergeOrigin ? "Click map…" : "+ Pin"}
              </button>
            </div>
            {mergeOriginSearch.trim() !== "" && (
              <div
                id="merge-origin-listbox"
                role="listbox"
                aria-label="Nodes to add as merged origins"
                className="max-h-32 overflow-y-auto rounded-md bg-black/20 border border-white/5 divide-y divide-white/5"
              >
                {mergeOriginCandidates.length === 0 ? (
                  <div className="text-[10px] text-gray-500 px-2 py-1.5" role="status">No matches.</div>
                ) : (
                  mergeOriginCandidates.map((n, i) => (
                    <button
                      key={n.id}
                      id={`merge-origin-opt-${n.id}`}
                      type="button"
                      role="option"
                      aria-selected={i === mergeHighlight}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectMergeOrigin(n.id)}
                      className={`w-full text-left px-2 py-1 text-[10px] truncate ${
                        i === mergeHighlight ? "bg-white/10 text-gray-100" : "text-gray-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="text-cyan-300/80 mr-1" aria-hidden="true">+</span>
                      {n.shortname ?? n.longname ?? n.id}
                      {n.shortname && n.longname && (
                        <span className="text-gray-500 ml-1.5">{n.longname}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </Row>

        <Row
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="7" y="2" width="10" height="20" rx="2" strokeWidth={1.7} />
              <line x1="11" y1="18" x2="13" y2="18" strokeWidth={1.7} strokeLinecap="round" />
            </svg>
          }
          title="Receiver"
          summary={rxSummary}
          expanded={expandedRow === "rx"}
          onToggle={() => toggleRow("rx")}
        >
          <div className="flex items-center justify-between gap-2">
            {/* px/-mx pair gives the active-flash some real estate without
                changing the rendered layout. */}
            <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded transition-colors active:bg-cyan-500/20">
              <input
                type="checkbox"
                checked={rxMatchesTx}
                onChange={(e) => {
                  if (e.target.checked) {
                    rxSnapshotRef.current = {
                      hw: rxHardwareIdx,
                      ant: rxAntennaIdx,
                      height: rxHeightM,
                    };
                    onRxHardwareIdxChange(hardwareIdx);
                    onRxAntennaIdxChange(antennaIdx);
                    onRxHeightChange(antennaHeightM);
                  } else {
                    const snap = rxSnapshotRef.current;
                    if (snap) {
                      onRxHardwareIdxChange(snap.hw);
                      onRxAntennaIdxChange(snap.ant);
                      onRxHeightChange(snap.height);
                    } else {
                      // No snapshot = RX already matched TX when the panel
                      // opened. Fall back to handheld so the toggle isn't a
                      // no-op.
                      onRxHardwareIdxChange(4); // Heltec V3
                      onRxAntennaIdxChange(0);  // rubber duck
                      onRxHeightChange(2);
                    }
                  }
                }}
                className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
              />
              <span>Same as transmitter</span>
            </label>
            <button
              type="button"
              onClick={() => {
                // Heltec V3 + rubber duck @ 2 m
                onRxHardwareIdxChange(4);
                onRxAntennaIdxChange(0);
                onRxHeightChange(2);
              }}
              className="text-[10px] text-cyan-400/70 hover:text-cyan-300 transition-colors"
              title="Set RX to a stock handheld (Heltec V3, rubber duck, 2 m) — typical 'who can hear me?' setup"
            >
              Use handheld
            </button>
          </div>

          {!rxMatchesTx && (
            <>
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
                <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-28">
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
            </>
          )}
        </Row>

        <Row
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 3l4 6h-2.5L17 15h-3l3 5H7l3-5H7l3-6H7.5L12 3z" />
            </svg>
          }
          title="Environment"
          summary={envSummary}
          expanded={expandedRow === "env"}
          onToggle={() => toggleRow("env")}
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                <span>Clutter (NLCD)</span>
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
          </div>
          <div className="space-y-1.5 pt-1.5 border-t border-white/5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                <span>Canopy heights (ETH)</span>
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
          <div className="space-y-1.5 pt-1.5 border-t border-white/5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 flex items-center gap-1">
                <span>Building heights (JRC)</span>
                <InfoTip align="left">
                  Per-pixel measured building heights from JRC GHS-BUILT-H
                  ANBH (100 m global). Adds rooftops as DSM obstacles for
                  ITM diffraction along the propagation path, and replaces
                  class-nominal h_a in the ITU-R P.452 endpoint formula for
                  developed-class pixels. Toggle off for bare-earth DEM and
                  class-nominal heights.
                </InfoTip>
              </label>
              <label className="flex items-center gap-1.5 text-[10px] text-gray-300 cursor-pointer select-none shrink-0">
                <input
                  type="checkbox"
                  checked={buildingsEnabled}
                  onChange={(e) => onBuildingsEnabledChange(e.target.checked)}
                  className="w-3 h-3 accent-cyan-500 cursor-pointer"
                />
                <span>Enabled</span>
              </label>
            </div>
            <BuildingStatusChip status={buildingsStatus} enabled={buildingsEnabled} />
          </div>
        </Row>

        <Row
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" strokeWidth={1.7} />
              <circle cx="12" cy="12" r="5" strokeWidth={1.7} />
              <circle cx="12" cy="12" r="1.5" strokeWidth={1.7} fill="currentColor" />
            </svg>
          }
          title="Accuracy"
          summary={accSummary}
          expanded={expandedRow === "acc"}
          onToggle={() => toggleRow("acc")}
        >
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
            <Segmented
              ariaLabel="Reliability"
              value={reliability}
              onChange={onReliabilityChange}
              options={RELIABILITY_PRESETS.map((p) => ({
                value: p.id,
                label: p.label,
                sub: `${p.time}/${p.location}/${p.situation}`,
                title: p.desc,
              }))}
            />
          </div>
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
            <Segmented
              ariaLabel="Detail"
              value={detail}
              onChange={onDetailChange}
              options={[
                { value: "standard", label: "Std",    sub: "512 px" },
                { value: "high",     label: "High",   sub: "768 px" },
                { value: "ultra",    label: "Ultra",  sub: "1024 px" },
                { value: "survey",   label: "Survey", sub: "2048 px" },
              ]}
            />
          </div>
        </Row>

        <Row
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5" />
            </svg>
          }
          title="Overlays"
          summary={ovSummary}
          expanded={expandedRow === "ov"}
          onToggle={() => toggleRow("ov")}
        >
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
          <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none">
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
        </Row>
      </div>
    </div>
  );
}
