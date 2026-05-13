import { useCallback, useMemo, useState } from "react";

import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, DEFAULT_AGGRESSION_IDX, effectiveSensitivityDbm, MESHTASTIC_PRESETS } from "./coverageAnalysis";
import { clampAggressionIdx } from "./helpers";
import type { ScanClass, ScanSummary } from "./scanAnalysis";
import { LS_KEYS, readJson, writeJson } from "./storage";
import type { DemSource } from "./terrainRgb";

type ClutterStatus = { tilesPresent: number; tilesTotal: number } | null;

/** Scan tool link-budget config — independent from coverage. */
export function useScanState() {
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanHoverId, setScanHoverId] = useState<string | null>(null);
  /** DEM tile source used for the last scan. */
  const [scanDemSource, setScanDemSource] = useState<DemSource | null>(null);

  const [scanClutterStatus, setScanClutterStatus] = useState<ClutterStatus>(null);
  const [scanCanopyStatus, setScanCanopyStatus] = useState<ClutterStatus>(null);
  const [scanBuildingsStatus, setScanBuildingsStatus] = useState<ClutterStatus>(null);

  const [scanAntennaIdx, setScanAntennaIdx] = useState(3);
  const scanAntennaDbi = COMMON_ANTENNAS[scanAntennaIdx]?.dbi ?? 3;
  const [scanHardwareIdx, setScanHardwareIdx] = useState(0);
  const [scanAntennaHeightM, setScanAntennaHeightM] = useState(2);
  const [scanRxHardwareIdx, setScanRxHardwareIdx] = useState(4);
  const [scanRxAntennaIdx, setScanRxAntennaIdx] = useState(0);
  const scanRxAntennaDbi = COMMON_ANTENNAS[scanRxAntennaIdx]?.dbi ?? 3;
  const [scanCustomTxDbm, setScanCustomTxDbm] = useState(22);
  const scanTxDbm = COMMON_HARDWARE[scanHardwareIdx].isCustom
    ? scanCustomTxDbm
    : COMMON_HARDWARE[scanHardwareIdx].txDbm;
  const [scanAggressionIdx, setScanAggressionIdxRaw] = useState(() =>
    clampAggressionIdx(readJson<number>(LS_KEYS.scanAggressionIdx, DEFAULT_AGGRESSION_IDX)),
  );
  const setScanAggressionIdx = useCallback((idx: number) => {
    const clamped = clampAggressionIdx(idx);
    setScanAggressionIdxRaw(clamped);
    writeJson(LS_KEYS.scanAggressionIdx, clamped);
  }, []);
  const [scanClutterEnabled, setScanClutterEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.scanClutterEnabled, true),
  );
  const setScanClutterEnabled = useCallback((v: boolean) => {
    setScanClutterEnabledRaw(v);
    writeJson(LS_KEYS.scanClutterEnabled, v);
  }, []);
  const [scanCanopyEnabled, setScanCanopyEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.scanCanopyEnabled, true),
  );
  const setScanCanopyEnabled = useCallback((v: boolean) => {
    setScanCanopyEnabledRaw(v);
    writeJson(LS_KEYS.scanCanopyEnabled, v);
  }, []);
  const [scanBuildingsEnabled, setScanBuildingsEnabledRaw] = useState(() =>
    readJson<boolean>(LS_KEYS.scanBuildingsEnabled, true),
  );
  const setScanBuildingsEnabled = useCallback((v: boolean) => {
    setScanBuildingsEnabledRaw(v);
    writeJson(LS_KEYS.scanBuildingsEnabled, v);
  }, []);
  const [scanPresetIdx, setScanPresetIdx] = useState(0);
  const [scanCustomSensDbm, setScanCustomSensDbm] = useState(-133);
  const scanSensitivityDbm = MESHTASTIC_PRESETS[scanPresetIdx].isCustom
    ? scanCustomSensDbm
    : MESHTASTIC_PRESETS[scanPresetIdx].sensitivityDbm;
  const scanEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[scanRxHardwareIdx];
    return effectiveSensitivityDbm(scanSensitivityDbm, hw.chipset, hw.sensitivityOffsetDb ?? 0);
  }, [scanSensitivityDbm, scanRxHardwareIdx]);
  const [scanReliability, setScanReliability] = useState<CoverageReliability>("typical");
  // Blocked hidden by default — the count can dominate on dense meshes.
  const [hiddenScanClasses, setHiddenScanClasses] = useState<Set<ScanClass>>(() => new Set(["blocked"]));

  return {
    // Results
    scanSummary, setScanSummary,
    isScanning, setIsScanning,
    scanHoverId, setScanHoverId,
    scanDemSource, setScanDemSource,
    scanClutterStatus, setScanClutterStatus,
    scanCanopyStatus, setScanCanopyStatus,
    scanBuildingsStatus, setScanBuildingsStatus,
    // Settings
    scanAntennaIdx, setScanAntennaIdx,
    scanAntennaDbi,
    scanHardwareIdx, setScanHardwareIdx,
    scanAntennaHeightM, setScanAntennaHeightM,
    scanRxHardwareIdx, setScanRxHardwareIdx,
    scanRxAntennaIdx, setScanRxAntennaIdx,
    scanRxAntennaDbi,
    scanCustomTxDbm, setScanCustomTxDbm,
    scanTxDbm,
    scanAggressionIdx, setScanAggressionIdx,
    scanClutterEnabled, setScanClutterEnabled,
    scanCanopyEnabled, setScanCanopyEnabled,
    scanBuildingsEnabled, setScanBuildingsEnabled,
    scanPresetIdx, setScanPresetIdx,
    scanCustomSensDbm, setScanCustomSensDbm,
    scanSensitivityDbm,
    scanEffectiveSensitivityDbm,
    scanReliability, setScanReliability,
    hiddenScanClasses, setHiddenScanClasses,
  };
}

export type ScanState = ReturnType<typeof useScanState>;
