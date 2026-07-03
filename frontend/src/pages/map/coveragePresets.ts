/**
 * Named coverage-settings presets: snapshot/apply, localStorage library,
 * JSON export/import. Serialization is semantic (labels/ids + numeric values)
 * so presets survive catalog reordering; unresolvable entries fall back to
 * the Custom slot or closest-gain antenna.
 */
import { AGGRESSION_STOPS, COMMON_ANTENNAS, COMMON_HARDWARE, type CoverageReliability, DEFAULT_AGGRESSION_IDX, MESHTASTIC_PRESETS, RELIABILITY_PRESETS } from "./coverageAnalysis";
import { COVERAGE_DETAIL_SIZE, type CoverageDetail } from "./coverageDetail";
import { LS_KEYS, readJson, writeJson } from "./storage";

/** Panel-native settings bag (catalog indices + numbers). */
export interface CoveragePanelSettings {
  hardwareIdx: number;
  customTxDbm: number;
  antennaIdx: number;
  antennaHeightM: number;
  rxHardwareIdx: number;
  rxAntennaIdx: number;
  rxHeightM: number;
  presetIdx: number;
  customSensitivityDbm: number;
  aggressionIdx: number;
  clutterEnabled: boolean;
  canopyEnabled: boolean;
  buildingsEnabled: boolean;
  detail: CoverageDetail;
  reliability: CoverageReliability;
  showContours: boolean;
  showRays: boolean;
}

/** Version-stable preset payload. `customTxDbm`/`customSensitivityDbm` carry
 *  the Custom-slot scratch values even when a catalog entry is selected, so a
 *  restore doesn't clobber them with the selection's effective value. */
export interface CoveragePreset {
  v: 1;
  name: string;
  savedAt: string;
  tx: { hardware: string; txDbm: number; antenna: string; antennaDbi: number; antennaHeightM: number; customTxDbm?: number };
  rx: { hardware: string; antenna: string; antennaDbi: number; heightM: number };
  modem: { id: string; sensitivityDbm: number; customSensitivityDbm?: number };
  env: { clutterEnabled: boolean; aggression: string; canopyEnabled: boolean; buildingsEnabled: boolean };
  accuracy: { reliability: string; detail: string };
  overlays: { contours: boolean; rays: boolean };
}

export const MAX_PRESETS = 30;
export const MAX_PRESET_NAME_LEN = 60;

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export function snapshotPreset(name: string, s: CoveragePanelSettings): CoveragePreset {
  const hw = COMMON_HARDWARE[s.hardwareIdx] ?? COMMON_HARDWARE[0];
  const rxHw = COMMON_HARDWARE[s.rxHardwareIdx] ?? COMMON_HARDWARE[0];
  const ant = COMMON_ANTENNAS[s.antennaIdx] ?? COMMON_ANTENNAS[0];
  const rxAnt = COMMON_ANTENNAS[s.rxAntennaIdx] ?? COMMON_ANTENNAS[0];
  const modem = MESHTASTIC_PRESETS[s.presetIdx] ?? MESHTASTIC_PRESETS[0];
  return {
    v: 1,
    name: name.trim().slice(0, MAX_PRESET_NAME_LEN),
    savedAt: new Date().toISOString(),
    tx: {
      hardware: hw.label,
      txDbm: hw.isCustom ? s.customTxDbm : hw.txDbm,
      antenna: ant.label,
      antennaDbi: ant.dbi,
      antennaHeightM: s.antennaHeightM,
      customTxDbm: s.customTxDbm,
    },
    rx: { hardware: rxHw.label, antenna: rxAnt.label, antennaDbi: rxAnt.dbi, heightM: s.rxHeightM },
    modem: {
      id: modem.id,
      sensitivityDbm: modem.isCustom ? s.customSensitivityDbm : modem.sensitivityDbm,
      customSensitivityDbm: s.customSensitivityDbm,
    },
    env: {
      clutterEnabled: s.clutterEnabled,
      aggression: AGGRESSION_STOPS[s.aggressionIdx]?.id ?? AGGRESSION_STOPS[DEFAULT_AGGRESSION_IDX].id,
      canopyEnabled: s.canopyEnabled,
      buildingsEnabled: s.buildingsEnabled,
    },
    accuracy: { reliability: s.reliability, detail: s.detail },
    overlays: { contours: s.showContours, rays: s.showRays },
  };
}

/** Hardware label → index; unknown labels land on the Custom slot so txDbm is honored. */
export function resolveHardware(label: string): { idx: number; isCustom: boolean } {
  const i = COMMON_HARDWARE.findIndex((h) => h.label === label);
  if (i >= 0) return { idx: i, isCustom: COMMON_HARDWARE[i].isCustom ?? false };
  const custom = COMMON_HARDWARE.findIndex((h) => h.isCustom);
  return { idx: custom >= 0 ? custom : 0, isCustom: true };
}

/** Antenna label → index; unknown labels resolve to the closest gain. */
export function resolveAntenna(label: string, dbi: number): number {
  const i = COMMON_ANTENNAS.findIndex((a) => a.label === label);
  if (i >= 0) return i;
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  COMMON_ANTENNAS.forEach((a, idx) => {
    const d = Math.abs(a.dbi - dbi);
    if (d < bestDelta) { bestDelta = d; best = idx; }
  });
  return best;
}

export function resolvePreset(p: CoveragePreset): CoveragePanelSettings {
  const hw = resolveHardware(p.tx.hardware);
  const rxHw = resolveHardware(p.rx.hardware);
  const modemIdx = MESHTASTIC_PRESETS.findIndex((m) => m.id === p.modem.id);
  const customModemIdx = MESHTASTIC_PRESETS.findIndex((m) => m.isCustom);
  const modemIsCustom = modemIdx < 0 || (MESHTASTIC_PRESETS[modemIdx]?.isCustom ?? false);
  const aggressionIdx = AGGRESSION_STOPS.findIndex((a) => a.id === p.env.aggression);
  const detail = (Object.keys(COVERAGE_DETAIL_SIZE) as CoverageDetail[]).includes(p.accuracy.detail as CoverageDetail)
    ? (p.accuracy.detail as CoverageDetail)
    : "standard";
  const reliability = RELIABILITY_PRESETS.some((r) => r.id === p.accuracy.reliability)
    ? (p.accuracy.reliability as CoverageReliability)
    : "typical";
  // Scratch values: prefer the explicit fields; older payloads fall back to
  // the effective value only when the selection actually IS the Custom slot.
  const scratchTxDbm = p.tx.customTxDbm ?? (hw.isCustom ? p.tx.txDbm : 22);
  const scratchSensDbm = p.modem.customSensitivityDbm ?? (modemIsCustom ? p.modem.sensitivityDbm : -133);
  return {
    hardwareIdx: hw.idx,
    customTxDbm: clampNum(scratchTxDbm, 10, 35, 22),
    antennaIdx: resolveAntenna(p.tx.antenna, p.tx.antennaDbi),
    antennaHeightM: clampNum(p.tx.antennaHeightM, 0, 300, 2),
    rxHardwareIdx: rxHw.idx,
    rxAntennaIdx: resolveAntenna(p.rx.antenna, p.rx.antennaDbi),
    rxHeightM: clampNum(p.rx.heightM, 0, 300, 2),
    presetIdx: modemIdx >= 0 ? modemIdx : (customModemIdx >= 0 ? customModemIdx : 0),
    customSensitivityDbm: clampNum(scratchSensDbm, -150, -100, -133),
    aggressionIdx: aggressionIdx >= 0 ? aggressionIdx : DEFAULT_AGGRESSION_IDX,
    clutterEnabled: !!p.env.clutterEnabled,
    canopyEnabled: !!p.env.canopyEnabled,
    buildingsEnabled: !!p.env.buildingsEnabled,
    detail,
    reliability,
    showContours: !!p.overlays.contours,
    showRays: !!p.overlays.rays,
  };
}

/** Shape-check one candidate (import or LS read); returns a sanitized copy or null. */
export function sanitizePreset(raw: unknown): CoveragePreset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || typeof p.name !== "string" || p.name.trim() === "") return null;
  const tx = p.tx as Record<string, unknown> | undefined;
  const rx = p.rx as Record<string, unknown> | undefined;
  const modem = p.modem as Record<string, unknown> | undefined;
  const env = p.env as Record<string, unknown> | undefined;
  const accuracy = p.accuracy as Record<string, unknown> | undefined;
  const overlays = p.overlays as Record<string, unknown> | undefined;
  if (!tx || !rx || !modem || !env || !accuracy || !overlays) return null;
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    v: 1,
    name: p.name.trim().slice(0, MAX_PRESET_NAME_LEN),
    savedAt: str(p.savedAt, new Date().toISOString()),
    tx: {
      hardware: str(tx.hardware, ""),
      txDbm: clampNum(tx.txDbm, 10, 35, 22),
      antenna: str(tx.antenna, ""),
      antennaDbi: clampNum(tx.antennaDbi, -5, 20, 3),
      antennaHeightM: clampNum(tx.antennaHeightM, 0, 300, 2),
      customTxDbm: typeof tx.customTxDbm === "number" ? clampNum(tx.customTxDbm, 10, 35, 22) : undefined,
    },
    rx: {
      hardware: str(rx.hardware, ""),
      antenna: str(rx.antenna, ""),
      antennaDbi: clampNum(rx.antennaDbi, -5, 20, 3),
      heightM: clampNum(rx.heightM, 0, 300, 2),
    },
    modem: {
      id: str(modem.id, "LongFast"),
      sensitivityDbm: clampNum(modem.sensitivityDbm, -150, -100, -130),
      customSensitivityDbm: typeof modem.customSensitivityDbm === "number" ? clampNum(modem.customSensitivityDbm, -150, -100, -133) : undefined,
    },
    env: {
      clutterEnabled: !!env.clutterEnabled,
      aggression: str(env.aggression, AGGRESSION_STOPS[DEFAULT_AGGRESSION_IDX].id),
      canopyEnabled: !!env.canopyEnabled,
      buildingsEnabled: !!env.buildingsEnabled,
    },
    accuracy: { reliability: str(accuracy.reliability, "typical"), detail: str(accuracy.detail, "standard") },
    overlays: { contours: !!overlays.contours, rays: !!overlays.rays },
  };
}

export function readPresetLibrary(): CoveragePreset[] {
  const raw = readJson<unknown>(LS_KEYS.coveragePresets, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizePreset).filter((p): p is CoveragePreset => p !== null).slice(0, MAX_PRESETS);
}

export function writePresetLibrary(presets: CoveragePreset[]): void {
  writeJson(LS_KEYS.coveragePresets, presets.slice(0, MAX_PRESETS));
}

/** Serialize the library for file export. */
export function presetsToFile(presets: CoveragePreset[]): string {
  return JSON.stringify({ v: 1, kind: "meshinfo-coverage-presets", presets }, null, 2);
}

/** Parse an imported file: accepts a library file or a bare single preset. */
export function parsePresetsFile(text: string): CoveragePreset[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const candidates: unknown[] = Array.isArray(obj.presets) ? obj.presets : [obj];
  const parsed = candidates.map(sanitizePreset).filter((p): p is CoveragePreset => p !== null);
  return parsed.length > 0 ? parsed : null;
}

/** Trigger a JSON download of the library. */
export function downloadPresets(presets: CoveragePreset[]): void {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const blob = new Blob([presetsToFile(presets)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meshinfo-coverage-presets-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
