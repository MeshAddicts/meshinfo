import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clampAggressionIdx } from "../lib/helpers";
import { LS_KEYS, readJson, writeJson } from "../lib/storage";
import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, type CoverageResult, DEFAULT_AGGRESSION_IDX, effectiveSensitivityDbm, MESHTASTIC_PRESETS } from "../rf/coverageAnalysis";
import type { CoverageDetail } from "../rf/coverageDetail";
import { type CoveragePanelSettings, resolvePreset, sanitizePreset, snapshotPreset } from "../rf/coveragePresets";
import type { DemSource } from "../terrain/terrainRgb";

type ClutterStatus = { tilesPresent: number; tilesTotal: number } | null;

/** Coverage RF settings state + derived helpers. Owns persistence for
 *  aggression/clutter/canopy/buildings toggles. */
export function useCoverageState() {
  const [coverageResult, setCoverageResult] = useState<CoverageResult | null>(null);
  const [isComputingCoverage, setIsComputingCoverage] = useState(false);
  const [isFetchingCoverageTerrain, setIsFetchingCoverageTerrain] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  // Retry button: forces a recompute and busts the raster fetch cache
  const [coverageRetryNonce, setCoverageRetryNonce] = useState(0);
  // Recalculate button (manual mode): forces a recompute, reuses cached rasters
  const [coverageRecalcNonce, setCoverageRecalcNonce] = useState(0);
  // Auto-recompute on setting changes (persisted); off = dirty flag + Recalculate
  const [coverageAutoRecalc, setCoverageAutoRecalcRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.coverageAutoRecalc, true),
  );
  const setCoverageAutoRecalc = useCallback((v: boolean) => {
    setCoverageAutoRecalcRaw(v);
    writeJson(LS_KEYS.coverageAutoRecalc, v);
  }, []);
  // Settings changed but the recompute is deferred (manual mode)
  const [coverageParamsDirty, setCoverageParamsDirty] = useState(false);
  // total === 0 means idle / drag preview / terrain fetch
  const [coverageProgress, setCoverageProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 });
  const [coverageDemSource, setCoverageDemSource] = useState<DemSource | null>(null);
  // Keeps the coverage paint up across the activeTool flip when the user
  // launches a Scan-from-here overlay from the coverage panel.
  const [keepCoveragePaint, setKeepCoveragePaint] = useState(false);
  // Drives the land-cover status chip in each panel.
  const [coverageClutterStatus, setCoverageClutterStatus] = useState<ClutterStatus>(null);
  // Drives the canopy-height status chip; null until first compute.
  const [coverageCanopyStatus, setCoverageCanopyStatus] = useState<ClutterStatus>(null);
  // Drives the building-height status chip; null until first compute.
  const [coverageBuildingsStatus, setCoverageBuildingsStatus] = useState<ClutterStatus>(null);

  // Last-used settings, restored via the semantic preset payload so indices
  // survive catalog reordering across versions. Env toggles keep their own
  // (authoritative) keys below; Detail stays session-scoped — the heavy tiers
  // are deliberately opt-in per session.
  const [restored] = useState<CoveragePanelSettings | null>(() => {
    const raw = readJson<unknown>(LS_KEYS.coverageLastSettings, null);
    if (!raw) return null;
    const clean = sanitizePreset(raw);
    return clean ? resolvePreset(clean) : null;
  });

  // Index into COMMON_ANTENNAS (value-based <select> can't distinguish same-dBi models)
  const [coverageAntennaIdx, setCoverageAntennaIdx] = useState(restored?.antennaIdx ?? 3);
  const coverageAntennaDbi = COMMON_ANTENNAS[coverageAntennaIdx]?.dbi ?? 3;
  const [coverageHardwareIdx, setCoverageHardwareIdx] = useState(restored?.hardwareIdx ?? 0);
  // Asymmetric RX defaults: Heltec V3 + rubber duck @ 2 m (stock portable)
  const [coverageRxHardwareIdx, setCoverageRxHardwareIdx] = useState(restored?.rxHardwareIdx ?? 4);
  const [coverageRxAntennaIdx, setCoverageRxAntennaIdx] = useState(restored?.rxAntennaIdx ?? 0);
  const coverageRxAntennaDbi = COMMON_ANTENNAS[coverageRxAntennaIdx]?.dbi ?? 3;
  const [coverageRxHeightM, setCoverageRxHeightM] = useState(restored?.rxHeightM ?? 2);
  const [coverageCustomTxDbm, setCoverageCustomTxDbm] = useState(restored?.customTxDbm ?? 22);
  const coverageTxDbm = COMMON_HARDWARE[coverageHardwareIdx]?.isCustom
    ? coverageCustomTxDbm
    : (COMMON_HARDWARE[coverageHardwareIdx]?.txDbm ?? 22);
  // Clamp on read so corrupted / out-of-range LS values can't leave the slider
  // with no active stop (which silently fell back to 1.0× via the AGGRESSION_STOPS
  // index lookup).
  const [coverageAggressionIdx, setCoverageAggressionIdxRaw] = useState(() =>
    clampAggressionIdx(readJson<number>(LS_KEYS.coverageAggressionIdx, DEFAULT_AGGRESSION_IDX)),
  );
  const setCoverageAggressionIdx = useCallback((idx: number) => {
    const clamped = clampAggressionIdx(idx);
    setCoverageAggressionIdxRaw(clamped);
    writeJson(LS_KEYS.coverageAggressionIdx, clamped);
  }, []);
  const [coverageClutterEnabled, setCoverageClutterEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.coverageClutterEnabled, true),
  );
  const setCoverageClutterEnabled = useCallback((v: boolean) => {
    setCoverageClutterEnabledRaw(v);
    writeJson(LS_KEYS.coverageClutterEnabled, v);
  }, []);
  const [coverageCanopyEnabled, setCoverageCanopyEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.coverageCanopyEnabled, true),
  );
  const setCoverageCanopyEnabled = useCallback((v: boolean) => {
    setCoverageCanopyEnabledRaw(v);
    writeJson(LS_KEYS.coverageCanopyEnabled, v);
  }, []);
  const [coverageBuildingsEnabled, setCoverageBuildingsEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.coverageBuildingsEnabled, true),
  );
  const setCoverageBuildingsEnabled = useCallback((v: boolean) => {
    setCoverageBuildingsEnabledRaw(v);
    writeJson(LS_KEYS.coverageBuildingsEnabled, v);
  }, []);
  const [coveragePresetIdx, setCoveragePresetIdx] = useState(restored?.presetIdx ?? 0); // MediumFast
  const [coverageCustomSensDbm, setCoverageCustomSensDbm] = useState(restored?.customSensitivityDbm ?? -133);
  const coverageSensitivityDbm = MESHTASTIC_PRESETS[coveragePresetIdx]?.isCustom
    ? coverageCustomSensDbm
    : (MESHTASTIC_PRESETS[coveragePresetIdx]?.sensitivityDbm ?? -130);
  // Session-scoped (not persisted)
  const [coverageDetail, setCoverageDetail] = useState<CoverageDetail>("standard");
  // Antenna AGL (m); overrides GPS altitude on node-anchored origins
  const [coverageAntennaHeightM, setCoverageAntennaHeightM] = useState(restored?.antennaHeightM ?? 2);
  const [coverageReliability, setCoverageReliability] = useState<CoverageReliability>(restored?.reliability ?? "typical");
  // Ref mirror so the drag-preview closure sees latest without re-binding
  const coverageAntennaHeightMRef = useRef(restored?.antennaHeightM ?? 2);
  useEffect(() => {
    coverageAntennaHeightMRef.current = coverageAntennaHeightM;
  }, [coverageAntennaHeightM]);
  // Chipset-corrected RX sensitivity, keyed on RX hardware (sensitivity lives on the receiver)
  const coverageEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[coverageRxHardwareIdx] ?? COMMON_HARDWARE[0];
    return effectiveSensitivityDbm(coverageSensitivityDbm, hw.chipset, hw.sensitivityOffsetDb ?? 0);
  }, [coverageSensitivityDbm, coverageRxHardwareIdx]);

  const [showCoverageContours, setShowCoverageContours] = useState(restored?.showContours ?? false);
  const [showCoverageRays, setShowCoverageRays] = useState(restored?.showRays ?? false);

  // Write-through of the full settings bag (debounced; slider drags coalesce).
  // A ref keeps the latest bag so unmount can flush a still-pending write.
  const lastSettingsBagRef = useRef<CoveragePanelSettings | null>(null);
  useEffect(() => {
    const bag: CoveragePanelSettings = {
      hardwareIdx: coverageHardwareIdx, customTxDbm: coverageCustomTxDbm,
      antennaIdx: coverageAntennaIdx, antennaHeightM: coverageAntennaHeightM,
      rxHardwareIdx: coverageRxHardwareIdx, rxAntennaIdx: coverageRxAntennaIdx, rxHeightM: coverageRxHeightM,
      presetIdx: coveragePresetIdx, customSensitivityDbm: coverageCustomSensDbm,
      aggressionIdx: coverageAggressionIdx, clutterEnabled: coverageClutterEnabled,
      canopyEnabled: coverageCanopyEnabled, buildingsEnabled: coverageBuildingsEnabled,
      detail: coverageDetail, reliability: coverageReliability,
      showContours: showCoverageContours, showRays: showCoverageRays,
    };
    lastSettingsBagRef.current = bag;
    const t = window.setTimeout(() => {
      writeJson(LS_KEYS.coverageLastSettings, snapshotPreset("__last", bag));
    }, 500);
    return () => window.clearTimeout(t);
  }, [coverageHardwareIdx, coverageCustomTxDbm, coverageAntennaIdx, coverageAntennaHeightM, coverageRxHardwareIdx, coverageRxAntennaIdx, coverageRxHeightM, coveragePresetIdx, coverageCustomSensDbm, coverageAggressionIdx, coverageClutterEnabled, coverageCanopyEnabled, coverageBuildingsEnabled, coverageDetail, coverageReliability, showCoverageContours, showCoverageRays]);
  useEffect(() => {
    return () => {
      // Unmount flush — changes made within the debounce window still persist
      if (lastSettingsBagRef.current) {
        writeJson(LS_KEYS.coverageLastSettings, snapshotPreset("__last", lastSettingsBagRef.current));
      }
    };
  }, []);

  return {
    // Results
    coverageResult, setCoverageResult,
    isComputingCoverage, setIsComputingCoverage,
    isFetchingCoverageTerrain, setIsFetchingCoverageTerrain,
    coverageError, setCoverageError,
    coverageRetryNonce, setCoverageRetryNonce,
    coverageRecalcNonce, setCoverageRecalcNonce,
    coverageAutoRecalc, setCoverageAutoRecalc,
    coverageParamsDirty, setCoverageParamsDirty,
    coverageProgress, setCoverageProgress,
    coverageDemSource, setCoverageDemSource,
    keepCoveragePaint, setKeepCoveragePaint,
    coverageClutterStatus, setCoverageClutterStatus,
    coverageCanopyStatus, setCoverageCanopyStatus,
    coverageBuildingsStatus, setCoverageBuildingsStatus,
    // Settings
    coverageAntennaIdx, setCoverageAntennaIdx,
    coverageAntennaDbi,
    coverageHardwareIdx, setCoverageHardwareIdx,
    coverageRxHardwareIdx, setCoverageRxHardwareIdx,
    coverageRxAntennaIdx, setCoverageRxAntennaIdx,
    coverageRxAntennaDbi,
    coverageRxHeightM, setCoverageRxHeightM,
    coverageCustomTxDbm, setCoverageCustomTxDbm,
    coverageTxDbm,
    coverageAggressionIdx, setCoverageAggressionIdx,
    coverageClutterEnabled, setCoverageClutterEnabled,
    coverageCanopyEnabled, setCoverageCanopyEnabled,
    coverageBuildingsEnabled, setCoverageBuildingsEnabled,
    coveragePresetIdx, setCoveragePresetIdx,
    coverageCustomSensDbm, setCoverageCustomSensDbm,
    coverageSensitivityDbm,
    coverageDetail, setCoverageDetail,
    coverageAntennaHeightM, setCoverageAntennaHeightM,
    coverageAntennaHeightMRef,
    coverageReliability, setCoverageReliability,
    coverageEffectiveSensitivityDbm,
    // Overlay toggles
    showCoverageContours, setShowCoverageContours,
    showCoverageRays, setShowCoverageRays,
  };
}

export type CoverageState = ReturnType<typeof useCoverageState>;
