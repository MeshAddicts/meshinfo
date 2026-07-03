import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, DEFAULT_AGGRESSION_IDX, effectiveSensitivityDbm, MESHTASTIC_PRESETS, RELIABILITY_PRESETS } from "./coverageAnalysis";
import { resolveAntenna, resolveHardware } from "./coveragePresets";
import { clampAggressionIdx } from "./helpers";
import type { ScanClass, ScanSummary } from "./scanAnalysis";
import { LS_KEYS, readJson, writeJson } from "./storage";
import type { DemSource } from "./terrainRgb";

type ClutterStatus = { tilesPresent: number; tilesTotal: number } | null;

const DEFAULT_ANTENNA_IDX = 3; // Rokland 5.8 dBi
const DEFAULT_RX_HW_IDX = 4;   // Heltec V3
const DEFAULT_RX_ANT_IDX = 0;  // stock rubber duck

/** Settings copied in from the coverage panel's "Scan from here" button. */
export interface ScanMirrorSettings {
  hardwareIdx: number;
  antennaIdx: number;
  antennaHeightM: number;
  customTxDbm: number;
  rxHardwareIdx: number;
  rxAntennaIdx: number;
  rxHeightM: number;
  presetIdx: number;
  customSensDbm: number;
  aggressionIdx: number;
  clutterEnabled: boolean;
  canopyEnabled: boolean;
  buildingsEnabled: boolean;
  reliability: CoverageReliability;
}

/** Semantic (label-based) persisted shape so catalog reordering can't corrupt saved choices. */
interface ScanSavedSettings {
  freqMhz?: number;
  modemId?: string;
  customSensDbm?: number;
  tx?: { hardware?: string; antenna?: string; dbi?: number; heightM?: number; customTxDbm?: number };
  rx?: { hardware?: string; antenna?: string; dbi?: number; heightM?: number };
  env?: { clutterEnabled?: boolean; canopyEnabled?: boolean; buildingsEnabled?: boolean; aggressionIdx?: number };
  reliability?: string;
}

interface ResolvedScanSettings {
  freqMhz: number;
  presetIdx: number;
  customSensDbm: number;
  hardwareIdx: number; antennaIdx: number; antennaHeightM: number; customTxDbm: number;
  rxHardwareIdx: number; rxAntennaIdx: number; rxHeightM: number;
  aggressionIdx: number; clutterEnabled: boolean; canopyEnabled: boolean; buildingsEnabled: boolean;
  reliability: CoverageReliability;
}

const clampHeight = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(300, v)) : fallback;

function readSavedScanSettings(): ResolvedScanSettings | null {
  const s = readJson<ScanSavedSettings | null>(LS_KEYS.scanSettings, null);
  if (!s) return null;
  const presetIdx = MESHTASTIC_PRESETS.findIndex((p) => p.id === s.modemId);
  const tx = s.tx ?? {};
  const rx = s.rx ?? {};
  const env = s.env ?? {};
  return {
    freqMhz: typeof s.freqMhz === "number" && s.freqMhz >= 100 && s.freqMhz <= 2500 ? s.freqMhz : 915,
    presetIdx: presetIdx >= 0 && !MESHTASTIC_PRESETS[presetIdx].isCustom ? presetIdx : 1,
    customSensDbm: typeof s.customSensDbm === "number" ? Math.max(-150, Math.min(-100, s.customSensDbm)) : -133,
    hardwareIdx: tx.hardware ? resolveHardware(tx.hardware).idx : 0,
    antennaIdx: tx.antenna ? resolveAntenna(tx.antenna, tx.dbi ?? 0) : DEFAULT_ANTENNA_IDX,
    antennaHeightM: clampHeight(tx.heightM, 2),
    customTxDbm: typeof tx.customTxDbm === "number" ? Math.max(10, Math.min(35, tx.customTxDbm)) : 22,
    rxHardwareIdx: rx.hardware ? resolveHardware(rx.hardware).idx : DEFAULT_RX_HW_IDX,
    rxAntennaIdx: rx.antenna ? resolveAntenna(rx.antenna, rx.dbi ?? 0) : DEFAULT_RX_ANT_IDX,
    rxHeightM: clampHeight(rx.heightM, 2),
    aggressionIdx: clampAggressionIdx(env.aggressionIdx ?? DEFAULT_AGGRESSION_IDX),
    clutterEnabled: env.clutterEnabled ?? true,
    canopyEnabled: env.canopyEnabled ?? true,
    buildingsEnabled: env.buildingsEnabled ?? true,
    reliability: RELIABILITY_PRESETS.some((r) => r.id === s.reliability) ? (s.reliability as CoverageReliability) : "typical",
  };
}

/** Scan tool link-budget config — independent from coverage. */
export function useScanState() {
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  /** Last scan error, or null. */
  const [scanError, setScanError] = useState<string | null>(null);
  /** Non-fatal terrain-quality warning (failed tiles), or null. */
  const [scanTerrainWarning, setScanTerrainWarning] = useState<string | null>(null);
  const [scanHoverId, setScanHoverId] = useState<string | null>(null);
  /** DEM tile source used for the last scan. */
  const [scanDemSource, setScanDemSource] = useState<DemSource | null>(null);
  /** Bumped by the panel's Retry button to force a refetch after a failure. */
  const [scanRetryNonce, setScanRetryNonce] = useState(0);

  const [scanClutterStatus, setScanClutterStatus] = useState<ClutterStatus>(null);
  const [scanCanopyStatus, setScanCanopyStatus] = useState<ClutterStatus>(null);
  const [scanBuildingsStatus, setScanBuildingsStatus] = useState<ClutterStatus>(null);

  // Config restores from localStorage once per mount (like coverage/LOS).
  const savedRef = useRef<ResolvedScanSettings | null | undefined>(undefined);
  if (savedRef.current === undefined) savedRef.current = readSavedScanSettings();
  const saved = savedRef.current;

  const [scanFreqMhz, setScanFreqMhz] = useState(saved?.freqMhz ?? 915);
  const [scanAntennaIdx, setScanAntennaIdx] = useState(saved?.antennaIdx ?? DEFAULT_ANTENNA_IDX);
  const scanAntennaDbi = COMMON_ANTENNAS[scanAntennaIdx]?.dbi ?? 3;
  const [scanHardwareIdx, setScanHardwareIdx] = useState(saved?.hardwareIdx ?? 0);
  const [scanAntennaHeightM, setScanAntennaHeightM] = useState(saved?.antennaHeightM ?? 2);
  const [scanRxHeightM, setScanRxHeightM] = useState(saved?.rxHeightM ?? 2);
  const [scanRxHardwareIdx, setScanRxHardwareIdx] = useState(saved?.rxHardwareIdx ?? DEFAULT_RX_HW_IDX);
  const [scanRxAntennaIdx, setScanRxAntennaIdx] = useState(saved?.rxAntennaIdx ?? DEFAULT_RX_ANT_IDX);
  const scanRxAntennaDbi = COMMON_ANTENNAS[scanRxAntennaIdx]?.dbi ?? 3;
  const [scanCustomTxDbm, setScanCustomTxDbm] = useState(saved?.customTxDbm ?? 22);
  const scanTxDbm = COMMON_HARDWARE[scanHardwareIdx].isCustom
    ? scanCustomTxDbm
    : COMMON_HARDWARE[scanHardwareIdx].txDbm;
  const [scanAggressionIdx, setScanAggressionIdx] = useState(saved?.aggressionIdx ?? DEFAULT_AGGRESSION_IDX);
  const [scanClutterEnabled, setScanClutterEnabled] = useState(saved?.clutterEnabled ?? true);
  const [scanCanopyEnabled, setScanCanopyEnabled] = useState(saved?.canopyEnabled ?? true);
  const [scanBuildingsEnabled, setScanBuildingsEnabled] = useState(saved?.buildingsEnabled ?? true);
  const [scanPresetIdx, setScanPresetIdx] = useState(saved?.presetIdx ?? 1);
  const [scanCustomSensDbm, setScanCustomSensDbm] = useState(saved?.customSensDbm ?? -133);
  const scanSensitivityDbm = MESHTASTIC_PRESETS[scanPresetIdx].isCustom
    ? scanCustomSensDbm
    : MESHTASTIC_PRESETS[scanPresetIdx].sensitivityDbm;
  const scanEffectiveSensitivityDbm = useMemo(() => {
    const hw = COMMON_HARDWARE[scanRxHardwareIdx];
    return effectiveSensitivityDbm(scanSensitivityDbm, hw.chipset, hw.sensitivityOffsetDb ?? 0);
  }, [scanSensitivityDbm, scanRxHardwareIdx]);
  const [scanReliability, setScanReliability] = useState<CoverageReliability>(saved?.reliability ?? "typical");
  // Blocked hidden by default — the count can dominate on dense meshes. Session-only.
  const [hiddenScanClasses, setHiddenScanClasses] = useState<Set<ScanClass>>(() => new Set(["blocked"]));

  // Scan-from-here mirrors coverage's settings for the overlay session; those must
  // NOT be persisted over the user's own saved scan defaults. While the current
  // settings exactly match the last-applied mirror, skip the write-through; the
  // first user-driven change resumes persistence (same trick as LOS's URL-applied guard).
  const mirrorSigRef = useRef<string | null>(null);

  const settingsSig = [
    scanFreqMhz, MESHTASTIC_PRESETS[scanPresetIdx]?.id, scanCustomSensDbm,
    COMMON_HARDWARE[scanHardwareIdx]?.label, scanCustomTxDbm, COMMON_ANTENNAS[scanAntennaIdx]?.label, scanAntennaHeightM,
    COMMON_HARDWARE[scanRxHardwareIdx]?.label, COMMON_ANTENNAS[scanRxAntennaIdx]?.label, scanRxHeightM,
    scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled, scanReliability,
  ].join("|");

  useEffect(() => {
    if (mirrorSigRef.current !== null && mirrorSigRef.current === settingsSig) return;
    mirrorSigRef.current = null;
    const payload: ScanSavedSettings = {
      freqMhz: scanFreqMhz,
      modemId: MESHTASTIC_PRESETS[scanPresetIdx]?.id ?? "LongFast",
      customSensDbm: scanCustomSensDbm,
      tx: {
        hardware: COMMON_HARDWARE[scanHardwareIdx]?.label,
        antenna: COMMON_ANTENNAS[scanAntennaIdx]?.label,
        dbi: COMMON_ANTENNAS[scanAntennaIdx]?.dbi,
        heightM: scanAntennaHeightM,
        customTxDbm: scanCustomTxDbm,
      },
      rx: {
        hardware: COMMON_HARDWARE[scanRxHardwareIdx]?.label,
        antenna: COMMON_ANTENNAS[scanRxAntennaIdx]?.label,
        dbi: COMMON_ANTENNAS[scanRxAntennaIdx]?.dbi,
        heightM: scanRxHeightM,
      },
      env: {
        clutterEnabled: scanClutterEnabled,
        canopyEnabled: scanCanopyEnabled,
        buildingsEnabled: scanBuildingsEnabled,
        aggressionIdx: scanAggressionIdx,
      },
      reliability: scanReliability,
    };
    writeJson(LS_KEYS.scanSettings, payload);
  }, [settingsSig, scanFreqMhz, scanPresetIdx, scanCustomSensDbm, scanHardwareIdx, scanCustomTxDbm,
      scanAntennaIdx, scanAntennaHeightM, scanRxHardwareIdx, scanRxAntennaIdx, scanRxHeightM,
      scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled, scanReliability]);

  /** Apply coverage settings for a Scan-from-here overlay without persisting them. */
  const applyMirror = useCallback((m: ScanMirrorSettings) => {
    // Coverage runs at the North-American default 915 MHz; match it so budgets agree.
    setScanFreqMhz(915);
    setScanHardwareIdx(m.hardwareIdx);
    setScanAntennaIdx(m.antennaIdx);
    setScanAntennaHeightM(m.antennaHeightM);
    setScanCustomTxDbm(m.customTxDbm);
    setScanRxHardwareIdx(m.rxHardwareIdx);
    setScanRxAntennaIdx(m.rxAntennaIdx);
    setScanRxHeightM(m.rxHeightM);
    setScanPresetIdx(m.presetIdx);
    setScanCustomSensDbm(m.customSensDbm);
    setScanAggressionIdx(m.aggressionIdx);
    setScanClutterEnabled(m.clutterEnabled);
    setScanCanopyEnabled(m.canopyEnabled);
    setScanBuildingsEnabled(m.buildingsEnabled);
    setScanReliability(m.reliability);
    mirrorSigRef.current = [
      915, MESHTASTIC_PRESETS[m.presetIdx]?.id, m.customSensDbm,
      COMMON_HARDWARE[m.hardwareIdx]?.label, m.customTxDbm, COMMON_ANTENNAS[m.antennaIdx]?.label, m.antennaHeightM,
      COMMON_HARDWARE[m.rxHardwareIdx]?.label, COMMON_ANTENNAS[m.rxAntennaIdx]?.label, m.rxHeightM,
      m.aggressionIdx, m.clutterEnabled, m.canopyEnabled, m.buildingsEnabled, m.reliability,
    ].join("|");
  }, []);

  return {
    // Results
    scanSummary, setScanSummary,
    isScanning, setIsScanning,
    scanError, setScanError,
    scanTerrainWarning, setScanTerrainWarning,
    scanHoverId, setScanHoverId,
    scanDemSource, setScanDemSource,
    scanRetryNonce, setScanRetryNonce,
    scanClutterStatus, setScanClutterStatus,
    scanCanopyStatus, setScanCanopyStatus,
    scanBuildingsStatus, setScanBuildingsStatus,
    // Settings
    scanFreqMhz, setScanFreqMhz,
    scanAntennaIdx, setScanAntennaIdx,
    scanAntennaDbi,
    scanHardwareIdx, setScanHardwareIdx,
    scanAntennaHeightM, setScanAntennaHeightM,
    scanRxHeightM, setScanRxHeightM,
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
    applyMirror,
  };
}

export type ScanState = ReturnType<typeof useScanState>;
