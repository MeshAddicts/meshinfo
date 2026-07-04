import { useEffect, useRef, useState } from "react";

import { LS_KEYS, readJson, writeJson } from "../lib/storage";
import { COMMON_ANTENNAS, COMMON_HARDWARE, MESHTASTIC_PRESETS } from "../rf/coverageAnalysis";
import { resolveAntenna, resolveHardware } from "../rf/coveragePresets";
import type { LoSResult } from "../rf/losAnalysis";
import type { DemSource } from "../terrain/terrainRgb";

const DEFAULT_ANT_IDX = 3; // Rokland 5.8 dBi
const DEFAULT_PRESET_IDX = Math.max(0, MESHTASTIC_PRESETS.findIndex((p) => p.id === "LongFast"));

/** Semantic (label-based) persisted shape so catalog reordering can't corrupt saved choices. */
interface LosSavedSettings {
  freqMhz?: number;
  modemId?: string;
  from?: { hardware?: string; antenna?: string; dbi?: number; heightM?: number };
  to?: { hardware?: string; antenna?: string; dbi?: number; heightM?: number };
}

interface ResolvedLosSettings {
  freqMhz: number;
  presetIdx: number;
  fromHwIdx: number; fromAntIdx: number; fromHeightM: number;
  toHwIdx: number; toAntIdx: number; toHeightM: number;
}

function resolveEnd(e: LosSavedSettings["from"]): { hwIdx: number; antIdx: number; heightM: number } {
  const hwIdx = e?.hardware ? resolveHardware(e.hardware).idx : 0;
  const antIdx = e?.antenna ? resolveAntenna(e.antenna, e.dbi ?? 0) : DEFAULT_ANT_IDX;
  const heightM =
    typeof e?.heightM === "number" && Number.isFinite(e.heightM)
      ? Math.max(0, Math.min(300, e.heightM))
      : 2;
  return { hwIdx, antIdx, heightM };
}

function readSavedLosSettings(): ResolvedLosSettings | null {
  const s = readJson<LosSavedSettings | null>(LS_KEYS.losSettings, null);
  if (!s) return null;
  const presetIdx = MESHTASTIC_PRESETS.findIndex((p) => p.id === s.modemId);
  const from = resolveEnd(s.from);
  const to = resolveEnd(s.to);
  return {
    freqMhz: typeof s.freqMhz === "number" && s.freqMhz >= 100 && s.freqMhz <= 2500 ? s.freqMhz : 915,
    presetIdx: presetIdx >= 0 && !MESHTASTIC_PRESETS[presetIdx].isCustom ? presetIdx : DEFAULT_PRESET_IDX,
    fromHwIdx: from.hwIdx, fromAntIdx: from.antIdx, fromHeightM: from.heightM,
    toHwIdx: to.hwIdx, toAntIdx: to.antIdx, toHeightM: to.heightM,
  };
}

/** LoS endpoint hardware/antenna/height + result state. */
export function useLosState() {
  const [losResult, setLosResult] = useState<LoSResult | null>(null);
  /** DEM tile source used for the last LoS compute. */
  const [losDemSource, setLosDemSource] = useState<DemSource | null>(null);
  /** Last LoS compute error, or null. */
  const [losError, setLosError] = useState<string | null>(null);
  /** Non-fatal terrain-quality warning (failed tiles / missing samples), or null. */
  const [losTerrainWarning, setLosTerrainWarning] = useState<string | null>(null);
  /** True while a LoS compute (initial or config-recompute) is in flight. */
  const [isComputingLos, setIsComputingLos] = useState(false);
  // LOS virtual pins — endpoints can be arbitrary map points, not just nodes
  const [losVirtualFrom, setLosVirtualFrom] = useState<[number, number] | null>(null);
  const [losVirtualTo, setLosVirtualTo] = useState<[number, number] | null>(null);

  // Config restores from localStorage (read once per mount)
  const savedRef = useRef<ResolvedLosSettings | null | undefined>(undefined);
  if (savedRef.current === undefined) savedRef.current = readSavedLosSettings();
  const saved = savedRef.current;

  /** Link frequency (MHz); drives Fresnel geometry and ITM. */
  const [losFreqMhz, setLosFreqMhz] = useState(saved?.freqMhz ?? 915);
  /** Modem preset index into MESHTASTIC_PRESETS; drives the margin readout. */
  const [losPresetIdx, setLosPresetIdx] = useState(saved?.presetIdx ?? DEFAULT_PRESET_IDX);
  // Per-endpoint hardware/antenna/height for asymmetric LOS
  const [losFromHwIdx, setLosFromHwIdx] = useState(saved?.fromHwIdx ?? 0);
  const [losFromAntIdx, setLosFromAntIdx] = useState(saved?.fromAntIdx ?? DEFAULT_ANT_IDX);
  const [losFromHeightM, setLosFromHeightM] = useState(saved?.fromHeightM ?? 2);
  const [losToHwIdx, setLosToHwIdx] = useState(saved?.toHwIdx ?? 0);
  const [losToAntIdx, setLosToAntIdx] = useState(saved?.toAntIdx ?? DEFAULT_ANT_IDX);
  const [losToHeightM, setLosToHeightM] = useState(saved?.toHeightM ?? 2);

  // Heights/frequency applied from a shared URL must not overwrite the viewer's
  // saved defaults. While the current trio is exactly what the URL set, skip the
  // write; the first user-driven change resumes normal persistence.
  const urlAppliedRef = useRef<{ f: number; t: number; q: number } | null>(null);
  const markUrlAppliedSettings = (f: number, t: number, q: number) => {
    urlAppliedRef.current = { f, t, q };
  };

  // Write-through persistence (semantic labels, like coverageLastSettings)
  useEffect(() => {
    const u = urlAppliedRef.current;
    if (u && u.f === losFromHeightM && u.t === losToHeightM && u.q === losFreqMhz) return;
    urlAppliedRef.current = null;
    const payload: LosSavedSettings = {
      freqMhz: losFreqMhz,
      modemId: MESHTASTIC_PRESETS[losPresetIdx]?.id ?? "LongFast",
      from: {
        hardware: COMMON_HARDWARE[losFromHwIdx]?.label,
        antenna: COMMON_ANTENNAS[losFromAntIdx]?.label,
        dbi: COMMON_ANTENNAS[losFromAntIdx]?.dbi,
        heightM: losFromHeightM,
      },
      to: {
        hardware: COMMON_HARDWARE[losToHwIdx]?.label,
        antenna: COMMON_ANTENNAS[losToAntIdx]?.label,
        dbi: COMMON_ANTENNAS[losToAntIdx]?.dbi,
        heightM: losToHeightM,
      },
    };
    writeJson(LS_KEYS.losSettings, payload);
  }, [losFreqMhz, losPresetIdx, losFromHwIdx, losFromAntIdx, losFromHeightM, losToHwIdx, losToAntIdx, losToHeightM]);

  return {
    losResult, setLosResult,
    losDemSource, setLosDemSource,
    losError, setLosError,
    losTerrainWarning, setLosTerrainWarning,
    isComputingLos, setIsComputingLos,
    losVirtualFrom, setLosVirtualFrom,
    losVirtualTo, setLosVirtualTo,
    markUrlAppliedSettings,
    losFreqMhz, setLosFreqMhz,
    losPresetIdx, setLosPresetIdx,
    losFromHwIdx, setLosFromHwIdx,
    losFromAntIdx, setLosFromAntIdx,
    losFromHeightM, setLosFromHeightM,
    losToHwIdx, setLosToHwIdx,
    losToAntIdx, setLosToAntIdx,
    losToHeightM, setLosToHeightM,
  };
}

export type LosState = ReturnType<typeof useLosState>;
