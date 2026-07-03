/** Scan-results panel: ranked LoS from origin to every node within the scan radius. */
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { AggressionSlider, BuildingStatusChip, CanopyStatusChip, ClassLegend, ClutterStatusChip } from "./ClutterUI";
import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, MESHTASTIC_PRESETS, RELIABILITY_PRESETS } from "./coverageAnalysis";
import { commitNumericDraft } from "./helpers";
import { NumericDraftInput } from "./NumericDraftInput";
import { type ScanClass, type ScanResult, type ScanSummary } from "./scanAnalysis";
import { Segmented } from "./Segmented";
import type { DemSource } from "./terrainRgb";
import { useBottomSheetGesture } from "./useBottomSheet";

/** Distance cutoff shown in copy; must track SCAN_RADIUS_KM in useScanCompute. */
const SCAN_RADIUS_KM = 200;

/** Common LoRa region frequencies (distinct MHz values; several regions share one). */
const LORA_FREQS: { mhz: number; label: string }[] = [
  { mhz: 915, label: "915 · US/ANZ" },
  { mhz: 868, label: "868 · EU/RU" },
  { mhz: 433, label: "433 · EU433" },
  { mhz: 470, label: "470 · CN" },
  { mhz: 865, label: "865 · IN" },
  { mhz: 920, label: "920 · JP/KR/TH" },
  { mhz: 923, label: "923 · TW/MY/SG" },
];

/** Normalize −0 → 0 after rounding so sub-half-dB negatives don't show a bare "0". */
function roundSigned(v: number): number {
  return Math.round(v) || 0;
}

// Resolve the stock-handheld defaults by label so a catalog reorder can't point
// them at the wrong hardware (COMMON_HARDWARE is actively curated).
const HANDHELD_HW_IDX = Math.max(0, COMMON_HARDWARE.findIndex((h) => h.label === "Heltec V3"));
const HANDHELD_ANT_IDX = Math.max(0, COMMON_ANTENNAS.findIndex((a) => a.label.startsWith("Stock")));

/** Collapsible settings row: header summarizes current state, body holds inline editors. */
function SettingsRow({
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
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
        <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 shrink-0">{title}</span>
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

type SettingsRowKey = "tx" | "rx" | "env" | "acc";

const CLASS_STYLES: Record<ScanClass, { bg: string; text: string; border: string; label: string }> = {
  clear:      { bg: "bg-cyan-500/15",    text: "text-cyan-300",    border: "border-cyan-500/30",    label: "Clear" },
  fresnel:    { bg: "bg-orange-500/15",  text: "text-orange-300",  border: "border-orange-500/30",  label: "Fresnel" },
  diffracted: { bg: "bg-fuchsia-500/15", text: "text-fuchsia-300", border: "border-fuchsia-500/30", label: "Diffracted" },
  blocked:    { bg: "bg-red-500/15",     text: "text-red-300",     border: "border-red-500/30",     label: "Blocked" },
};

function MapScanPanelInner({
  summary,
  originLabel,
  isScanning,
  demSource,
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
  rxHeightM,
  onRxHeightChange,
  freqMhz,
  onFreqMhzChange,
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
  presetIdx,
  onPresetIdxChange,
  customSensitivityDbm,
  onCustomSensitivityChange,
  reliability,
  onReliabilityChange,
  scanError,
  terrainWarning,
  onRetry,
}: {
  summary: ScanSummary | null;
  originLabel: string;
  isScanning: boolean;
  /** Last scan error; shown as a banner (results, if any, stay visible). */
  scanError?: string | null;
  /** Non-fatal terrain-quality warning (failed tiles), or null. */
  terrainWarning?: string | null;
  /** Force a refetch + recompute after a failure. */
  onRetry?: () => void;
  /** null = scan hasn't run yet; otherwise the bulk DEM source actually used. */
  demSource: DemSource | null;
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
  /** RX antenna height AGL (m). */
  rxHeightM: number;
  onRxHeightChange: (m: number) => void;
  /** Link frequency (MHz) — drives Fresnel geometry and ITM. */
  freqMhz: number;
  onFreqMhzChange: (mhz: number) => void;
  customTxDbm: number;
  onCustomTxDbmChange: (dbm: number) => void;
  /** Index into AGGRESSION_STOPS (0/1/2) for the per-pixel ITU clutter model. */
  aggressionIdx: number;
  onAggressionIdxChange: (idx: number) => void;
  /** Master on/off for the clutter model. Off → ITM-only path loss. */
  clutterEnabled: boolean;
  onClutterEnabledChange: (enabled: boolean) => void;
  /** Tile-availability telemetry from the most recent scan; null until first run. */
  clutterStatus: { tilesPresent: number; tilesTotal: number } | null;
  /** Canopy-height tier on/off. Off → class-nominal heights. */
  canopyEnabled: boolean;
  onCanopyEnabledChange: (enabled: boolean) => void;
  /** Canopy tile-availability telemetry; null until first scan. */
  canopyStatus: { tilesPresent: number; tilesTotal: number } | null;
  /** Building-height tier on/off. Off → bare-earth + class-nominal endpoint h_a. */
  buildingsEnabled: boolean;
  onBuildingsEnabledChange: (enabled: boolean) => void;
  /** Building tile-availability telemetry; null until first scan. */
  buildingsStatus: { tilesPresent: number; tilesTotal: number } | null;
  presetIdx: number;
  onPresetIdxChange: (idx: number) => void;
  customSensitivityDbm: number;
  onCustomSensitivityChange: (dbm: number) => void;
  /** ITM reliability preset (time/location/situation %). Matches coverage's
   *  control so a scan from coverage's origin uses the same statistical
   *  threshold the painted prediction does. */
  reliability: CoverageReliability;
  onReliabilityChange: (r: CoverageReliability) => void;
}) {
  // null = show all; click active filter to toggle off
  const [filter, setFilter] = useState<ScanClass | null>(null);
  const [expandedSettingsRow, setExpandedSettingsRow] = useState<SettingsRowKey | null>(null);
  const [minimized, setMinimized] = useState(false);

  // Clear stale class filter when a new scan lands.
  useEffect(() => { setFilter(null); }, [summary]);

  // Peek when a scan first lands for a new origin; config re-runs keep expansion.
  const scanMinKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!summary) { scanMinKeyRef.current = null; return; }
    if (scanMinKeyRef.current !== originLabel) {
      scanMinKeyRef.current = originLabel;
      setMinimized(true);
    }
  }, [summary, originLabel]);

  // Without a snapshot, unchecking "Same as transmitter" would be a visual
  // no-op — rxMatchesTx is derived, so the values still match TX.
  const rxSnapshotRef = useRef<{ hw: number; ant: number } | null>(null);

  const sheet = useBottomSheetGesture({
    onClose,
    minimized,
    onMinimize: () => setMinimized(true),
    onExpand: () => setMinimized(false),
  });

  // Modal terrain prompt: focus its primary action on mount.
  const terrainBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (terrainNeeded && onEnableTerrain) requestAnimationFrame(() => terrainBtnRef.current?.focus());
  }, [terrainNeeded, onEnableTerrain]);

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
      // Let a field's own Escape (revert-and-blur) run first — don't slam the whole
      // popover shut on the first Escape while the user is editing a value.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
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

  // Text-mode inputs; commit on blur/Enter, blank/garbage → revert to current value.
  const [heightInput, setHeightInput] = useState(String(antennaHeightM));
  useEffect(() => { setHeightInput(String(antennaHeightM)); }, [antennaHeightM]);
  const [rxHeightInput, setRxHeightInput] = useState(String(rxHeightM));
  useEffect(() => { setRxHeightInput(String(rxHeightM)); }, [rxHeightM]);

  // summary.results is already ranked by scanSortKey (runScan sorts once); filter
  // preserves order, so no re-sort here.
  const displayResults: ScanResult[] = useMemo(() => {
    if (!summary) return [];
    return filter ? summary.results.filter((r) => r.cls === filter) : summary.results;
  }, [summary, filter]);

  // Clear a stale map highlight when the filter changes (a row may vanish under the
  // cursor). onHoverResult is intentionally excluded — Map passes an inline lambda,
  // so including it would refire on every parent render and cancel a live hover.
  const onHoverResultRef = useRef(onHoverResult);
  onHoverResultRef.current = onHoverResult;
  useEffect(() => { onHoverResultRef.current?.(null); }, [filter]);

  if (terrainNeeded && onEnableTerrain) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Scanning requires 3D terrain"
        className="fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
        inset-x-0 bottom-0 rounded-t-2xl p-4 pb-6 max-h-[75dvh] overflow-y-auto
        sm:inset-x-auto sm:left-[calc(var(--map-pad)+1rem)] sm:top-1/2 sm:-translate-y-1/2 sm:bottom-auto sm:w-85
        sm:rounded-xl sm:pb-4 sm:max-h-none sm:overflow-visible
        sm:animate-[slideInLeft_220ms_ease-out]">
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
            ref={terrainBtnRef}
            className="px-2.5 py-1 rounded-md text-[11px] bg-cyan-500/20 border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30"
            onClick={onEnableTerrain}
          >
            Enable 3D terrain
          </button>
        </div>
      </div>
    );
  }

  const toggleFilter = (cls: ScanClass) =>
    setFilter((prev) => (prev === cls ? null : cls));

  const toggleSettingsRow = (k: SettingsRowKey) =>
    setExpandedSettingsRow((cur) => (cur === k ? null : k));

  const isCustomHardware = COMMON_HARDWARE[hardwareIdx]?.isCustom ?? false;
  const isCustomPreset = MESHTASTIC_PRESETS[presetIdx]?.isCustom ?? false;

  const commitHeight = () => {
    // Blank/garbage (incl. a decimal comma) reverts to the current height — never
    // silently resets a rooftop analysis to the 2 m default (matches NumericDraftInput).
    const clamped = commitNumericDraft(heightInput.replace(",", "."), 0, 300, antennaHeightM);
    onAntennaHeightChange(clamped);
    setHeightInput(String(clamped));
  };
  const commitRxHeight = () => {
    const clamped = commitNumericDraft(rxHeightInput.replace(",", "."), 0, 300, rxHeightM);
    onRxHeightChange(clamped);
    setRxHeightInput(String(clamped));
  };

  const total = summary ? summary.results.length : 0;
  const reachable = summary
    ? summary.clearCount + summary.fresnelCount + summary.diffractedCount
    : 0;

  // Derived summaries for collapsed settings-row headers
  const txHardware = COMMON_HARDWARE[hardwareIdx]?.label ?? "Custom";
  const txAntDbi = COMMON_ANTENNAS[antennaIdx]?.dbi ?? 0;
  const txPreset = MESHTASTIC_PRESETS[presetIdx]?.label ?? "Custom";
  const rxMatchesTx = rxHardwareIdx === hardwareIdx && rxAntennaIdx === antennaIdx;
  const rxHardware = COMMON_HARDWARE[rxHardwareIdx]?.label ?? "Custom";
  const rxAntDbi = COMMON_ANTENNAS[rxAntennaIdx]?.dbi ?? 0;

  const txSummaryStr = `${txHardware} · ${txAntDbi} dBi · ${antennaHeightM}m · ${txPreset} · ${freqMhz} MHz`;
  const rxSummaryStr = rxMatchesTx ? `Same as TX · ${rxHeightM}m` : `${rxHardware} · ${rxAntDbi} dBi · ${rxHeightM}m`;
  const envParts: string[] = [];
  if (clutterEnabled) envParts.push("clutter");
  if (canopyEnabled) envParts.push("canopy");
  if (buildingsEnabled) envParts.push("buildings");
  const envSummaryStr = envParts.length === 0 ? "All off · bare earth" : envParts.join(" · ");

  const reliabilityLabel = RELIABILITY_PRESETS.find((p) => p.id === reliability)?.label ?? "Typical";
  const reliabilityPctStr = (() => {
    const r = RELIABILITY_PRESETS.find((p) => p.id === reliability);
    return r ? `${r.time}/${r.location}/${r.situation}` : "";
  })();
  const accSummaryStr = `${reliabilityLabel} · ${reliabilityPctStr}`;

  return (
    <div
      ref={sheet.sheetRef}
      role="dialog"
      aria-label={`Scan results from ${originLabel}`}
      className={`fixed z-1050 shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl flex flex-col
        inset-x-0 bottom-0 rounded-t-2xl max-h-[78dvh]
        animate-[slideInUp_200ms_ease-out]
        sm:inset-x-auto sm:left-[calc(var(--map-pad)+1rem)] sm:top-16 sm:w-85 sm:max-w-[calc(100vw-1.5rem)]
        sm:rounded-xl sm:max-h-none
        sm:animate-[slideInLeft_220ms_ease-out]
        ${minimized ? "sm:bottom-auto" : "sm:bottom-16"}`}
      onClick={(e) => {
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

      <div
        className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 shrink-0 max-sm:touch-none"
        onTouchStart={sheet.onTouchStart}
        onTouchMove={sheet.onTouchMove}
        onTouchEnd={sheet.onTouchEnd}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Scan
          </span>
          {/* Minimized: the body is hidden, so surface scan/error state in the header. */}
          {minimized && isScanning && (
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0" title="Scanning…" />
          )}
          {minimized && !isScanning && scanError && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" title={scanError} />
          )}
          <div
            className="text-[11px] text-gray-300 truncate"
            title={summary ? `From ${originLabel} · ${reachable} reachable / ${total}` : `From ${originLabel}`}
          >
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
          <button
            type="button"
            onClick={() => setMinimized((m) => !m)}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
            aria-label={minimized ? "Expand panel" : "Minimize panel"}
            aria-expanded={!minimized}
            title={minimized ? "Expand — scan tool is still running" : "Minimize — keep tool running, hide results"}
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
              className="cursor-pointer list-none p-1 rounded-md hover:text-gray-200 hover:bg-white/5 transition-colors"
              aria-label="Scan settings"
              title="Scan settings"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </summary>
            {/* Fixed so it escapes the side-panel's overflow. */}
            <div className="fixed z-1060 overflow-y-auto p-2 rounded-lg bg-gray-900/95 border border-white/10 shadow-2xl space-y-2
              inset-x-3 top-4 bottom-4 w-auto max-w-none
              sm:inset-auto sm:top-16 sm:left-[calc(var(--map-pad)+22.5rem)] sm:w-90 sm:max-w-[calc(100vw-var(--map-pad)-23.5rem)] sm:max-h-[calc(100vh-8rem)]">
              <div className="flex items-center justify-between px-0.5 pb-0.5">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Scan settings
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    const d = e.currentTarget.closest("details") as HTMLDetailsElement | null;
                    d?.removeAttribute("open");
                    d?.querySelector<HTMLElement>("summary")?.focus();
                  }}
                  className="p-0.5 rounded text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
                  aria-label="Close scan settings"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <SettingsRow
                title="Transmitter"
                summary={txSummaryStr}
                expanded={expandedSettingsRow === "tx"}
                onToggle={() => toggleSettingsRow("tx")}
              >
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="scan-hardware" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Hardware
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
                        <NumericDraftInput
                          value={customTxDbm}
                          onCommit={onCustomTxDbmChange}
                          min={10} max={35}
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
                        <NumericDraftInput
                          value={customSensitivityDbm}
                          onCommit={onCustomSensitivityChange}
                          min={-150} max={-100}
                          ariaLabel="Custom RX sensitivity (dBm)"
                          title="RX sensitivity in dBm"
                          className="w-14 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-xs text-gray-200 text-center
                            focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50"
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="scan-antenna" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Antenna
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
                  <div>
                    <label htmlFor="scan-tx-height" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                      Antenna Height
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
                </div>
                <div>
                  <label htmlFor="scan-freq" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                    Frequency (region)
                  </label>
                  <select
                    id="scan-freq"
                    value={freqMhz}
                    onChange={(e) => onFreqMhzChange(Number(e.target.value))}
                    aria-label="Link frequency (LoRa region)"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-gray-200
                      focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50
                      [&>option]:bg-gray-800 [&>option]:text-gray-200"
                  >
                    {!LORA_FREQS.some((f) => f.mhz === freqMhz) && (
                      <option value={freqMhz}>{freqMhz} MHz</option>
                    )}
                    {LORA_FREQS.map((f) => (
                      <option key={f.mhz} value={f.mhz}>{f.label}</option>
                    ))}
                  </select>
                </div>
              </SettingsRow>

              <SettingsRow
                title="Receiver"
                summary={rxMatchesTx ? rxSummaryStr : <span className="text-cyan-300">{rxSummaryStr}</span>}
                expanded={expandedSettingsRow === "rx"}
                onToggle={() => toggleSettingsRow("rx")}
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
                          rxSnapshotRef.current = { hw: rxHardwareIdx, ant: rxAntennaIdx };
                          onRxHardwareIdxChange(hardwareIdx);
                          onRxAntennaIdxChange(antennaIdx);
                        } else {
                          const snap = rxSnapshotRef.current;
                          if (snap) {
                            onRxHardwareIdxChange(snap.hw);
                            onRxAntennaIdxChange(snap.ant);
                          } else {
                            onRxHardwareIdxChange(HANDHELD_HW_IDX);
                            onRxAntennaIdxChange(HANDHELD_ANT_IDX);
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
                      onRxHardwareIdxChange(HANDHELD_HW_IDX);
                      onRxAntennaIdxChange(HANDHELD_ANT_IDX);
                    }}
                    className="text-[10px] text-cyan-400/70 hover:text-cyan-300 transition-colors"
                    title="Set RX to a stock handheld (Heltec V3, rubber duck) — typical 'who can hear me?' setup"
                  >
                    Use handheld
                  </button>
                </div>
                <div>
                  <label htmlFor="scan-rx-height" className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                    Antenna Height
                  </label>
                  <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 w-20">
                    <input
                      id="scan-rx-height"
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
                      aria-label="RX antenna height above ground at each target (meters)"
                      title="RX antenna height AGL at each target node (m). Blank = current value."
                      className="min-w-0 flex-1 bg-transparent text-xs text-gray-200 text-center focus:outline-hidden"
                    />
                    <span className="text-[10px] text-gray-500 shrink-0">m</span>
                  </div>
                </div>
                {!rxMatchesTx && (
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
                )}
              </SettingsRow>

              <SettingsRow
                title="Environment"
                summary={envSummaryStr}
                expanded={expandedSettingsRow === "env"}
                onToggle={() => toggleSettingsRow("env")}
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 block">
                      Clutter (NLCD)
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
                    <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 block">
                      Canopy heights (ETH)
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
                    <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 block">
                      Building heights (JRC)
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
              </SettingsRow>

              <SettingsRow
                title="Accuracy"
                summary={accSummaryStr}
                expanded={expandedSettingsRow === "acc"}
                onToggle={() => toggleSettingsRow("acc")}
              >
                <div>
                  <label className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1 block">
                    Reliability
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
                  <div className="text-[9px] text-gray-500 mt-1 leading-relaxed">
                    Higher = "works most of the time" instead of "works half the time."
                    Typical (90/50/70) matches the coverage panel default.
                  </div>
                </div>
              </SettingsRow>

              <div className="pt-1.5 px-0.5 text-[10px] text-gray-500 leading-relaxed">
                <span className="font-medium text-gray-400">Terrain data:</span>{" "}
                {demSource === "tilezen"
                  ? "Tilezen terrarium (USGS 3DEP / SRTM) via AWS Open Data"
                  : demSource === "mapbox-terrain-rgb"
                    ? "Mapbox terrain-rgb v1 (~30 m global, Tilezen fallback)"
                    : "awaiting first scan…"}
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

      <div className={`overflow-y-auto overscroll-contain flex-1 ${minimized ? "hidden" : ""}`}>
        {/* Recompute indicator — results stay visible underneath so a config tweak
            keeps the ranked list and scroll position instead of blanking to a spinner. */}
        {isScanning && summary && (
          <div role="status" className="px-3 py-1.5 flex items-center justify-center gap-2 text-[10px] text-cyan-300/80 border-b border-white/5 bg-cyan-500/5">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Recomputing…
          </div>
        )}

        {scanError && (
          <div role="alert" className="px-3 py-2 flex items-center gap-2 text-[11px] text-red-300 border-b border-red-500/20 bg-red-500/5">
            <span className="flex-1 min-w-0">
              {scanError}{summary && summary.results.length > 0 ? " Showing previous results." : ""}
            </span>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 px-2 py-0.5 rounded border border-red-400/40 text-red-200 hover:bg-red-500/15 transition-colors"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {terrainWarning && !scanError && (
          <div role="status" className="px-3 py-2 text-[10px] text-amber-300/90 border-b border-amber-500/20 bg-amber-500/5">
            {terrainWarning}
          </div>
        )}

        {isScanning && !summary && (
          <div role="status" className="px-3 py-6 text-center text-[11px] text-gray-400">
            <div className="inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              Scanning nodes within {SCAN_RADIUS_KM} km…
            </div>
          </div>
        )}

        {!isScanning && summary && summary.results.length === 0 && !scanError && (
          <div className="px-3 py-6 text-center text-[11px] text-gray-400">
            No nodes within {SCAN_RADIUS_KM} km of the origin. Try a different location.
          </div>
        )}

        {summary && summary.results.length > 0 && (
          <>
            {/* Left-click filters list; right-click hides class on map. */}
            <div className="grid grid-cols-4 gap-1.5 px-3 py-2 text-[10px] text-gray-400 border-b border-white/5">
              <StatPill label="Clear"      count={summary.clearCount}      cls="clear"      active={filter === "clear"}      hidden={hiddenClasses.has("clear")}      onClick={() => toggleFilter("clear")}      onContextMenu={() => onToggleClassVisibility("clear")} />
              <StatPill label="Fresnel"    count={summary.fresnelCount}    cls="fresnel"    active={filter === "fresnel"}    hidden={hiddenClasses.has("fresnel")}    onClick={() => toggleFilter("fresnel")}    onContextMenu={() => onToggleClassVisibility("fresnel")} />
              <StatPill label="Diffracted" count={summary.diffractedCount} cls="diffracted" active={filter === "diffracted"} hidden={hiddenClasses.has("diffracted")} onClick={() => toggleFilter("diffracted")} onContextMenu={() => onToggleClassVisibility("diffracted")} />
              <StatPill label="Blocked"    count={summary.blockedCount}    cls="blocked"    active={filter === "blocked"}    hidden={hiddenClasses.has("blocked")}    onClick={() => toggleFilter("blocked")}    onContextMenu={() => onToggleClassVisibility("blocked")} />
            </div>
            <div className="px-3 py-1 text-[9px] text-gray-500 border-b border-white/5">
              <span className="sm:hidden">Long-press a class to toggle its map visibility.</span>
              <span className="hidden sm:inline">Right-click a class to toggle its map visibility.</span>
            </div>

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

            {filter && displayResults.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-gray-500">
                No {filter} nodes in range.{" "}
                <button type="button" onClick={() => setFilter(null)} className="text-cyan-400 hover:text-cyan-300">
                  Show all
                </button>
              </div>
            )}
            <ul className="divide-y divide-white/5">
              {displayResults.map((r) => {
                const s = CLASS_STYLES[r.cls];
                const label = r.shortname ?? r.id.slice(0, 8);
                // roundSigned kills the −0 that Math.round yields for (−0.5,0); show one
                // decimal for a blocked node whose shortfall would otherwise read "0 dB".
                const m = roundSigned(r.marginDb);
                const marginStr = r.cls === "blocked"
                  ? (m === 0 ? `${r.marginDb.toFixed(1)} dB` : `${m} dB`)
                  : `+${m} dB`;
                return (
                  <li key={r.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`${label}, ${s.label}, ${r.distanceKm.toFixed(1)} km, margin ${marginStr}`}
                      className="px-3 py-1.5 hover:bg-white/5 focus:bg-white/10 focus:outline-none cursor-pointer transition-colors"
                      onClick={() => onSelectResult(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectResult(r.id); }
                      }}
                      onMouseEnter={() => onHoverResult?.(r.id)}
                      onMouseLeave={() => onHoverResult?.(null)}
                      onFocus={() => onHoverResult?.(r.id)}
                      onBlur={() => onHoverResult?.(null)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${s.bg} ${s.text} ${s.border}`}>
                          {s.label}
                        </span>
                        <span className="text-[11px] text-gray-100 font-medium truncate flex-1">
                          {label}
                        </span>
                        <span className="shrink-0 text-[10px] text-gray-400 tabular-nums">
                          {r.distanceKm.toFixed(1)} km
                        </span>
                        <span className={`shrink-0 text-[10px] tabular-nums ${r.cls === "blocked" ? "text-red-400" : "text-emerald-400"}`}>
                          {marginStr}
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
                    </div>
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

export const MapScanPanel = memo(MapScanPanelInner);

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
  // Long-press (touch) and "h" (keyboard) mirror the desktop right-click
  // hide-on-map action so it isn't pointer-and-desktop-only.
  const lpTimer = useRef<number | null>(null);
  const didLongPress = useRef(false);
  const startLongPress = (e: React.PointerEvent) => {
    // Only touch long-press arms the timer — a held LEFT mouse button must not hide
    // the class (that's the right-click / contextmenu path).
    if (e.pointerType !== "touch") return;
    didLongPress.current = false;
    lpTimer.current = window.setTimeout(() => {
      didLongPress.current = true; // swallow the synthetic click that follows a touch
      onContextMenu?.();
    }, 500);
  };
  const cancelLongPress = () => {
    if (lpTimer.current != null) { clearTimeout(lpTimer.current); lpTimer.current = null; }
  };
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={hidden ? `${label} — hidden on map` : label}
      onClick={() => {
        if (didLongPress.current) { didLongPress.current = false; return; }
        onClick?.();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Android also fires contextmenu on long-press; if our touch timer already
        // toggled, ignore this duplicate. Otherwise (desktop right-click, or an early
        // Android contextmenu) cancel the timer and toggle exactly once.
        if (didLongPress.current) return;
        cancelLongPress();
        onContextMenu?.();
      }}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onKeyDown={(e) => {
        if (e.key === "h" || e.key === "H") { e.preventDefault(); onContextMenu?.(); }
      }}
      className={`rounded border px-1.5 py-0.5 text-center transition-all cursor-pointer ${
        hidden
          ? `${s.bg} ${s.text} ${s.border} opacity-40 hover:opacity-70 border-dashed`
          : active
            ? `${s.bg} ${s.text} ${s.border} ring-1 ring-offset-1 ring-offset-gray-900`
            : `${s.bg} ${s.text} ${s.border} opacity-80 hover:opacity-100`
      }`}
      title={
        hidden
          ? `${label} hidden on map — click to show · long-press or "h" to toggle`
          : active
            ? `Showing ${label.toLowerCase()} only — click to show all · right-click, long-press, or "h" to hide on map`
            : `Filter to ${label.toLowerCase()} · right-click, long-press, or "h" to hide on map`
      }
    >
      <div className="text-[9px] opacity-80">{label}</div>
      <div className="text-[11px] font-semibold tabular-nums">{count}</div>
    </button>
  );
}
