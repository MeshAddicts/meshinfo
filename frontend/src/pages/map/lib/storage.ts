import { toast } from "../../../components/toastStore";

export const LS_KEYS = {
  provider: "meshinfo.map.provider",
  mapboxStyle: "meshinfo.map.mapboxStyle",
  osmBasemap: "meshinfo.map.osmBasemap",
  recentDays: "meshinfo.map.recentDays",
  clusterEnabled: "meshinfo.map.clusterEnabled",
  /** Live packet-arc animation on/off (on by default, opt-out). */
  livePackets: "meshinfo.map.livePackets",
  settingsPanelOpen: "meshinfo.map.settingsPanelOpen",
  linkMode: "meshinfo.map.linkMode",
  myNodeId: "meshinfo.map.myNodeId",
  terrain3D: "meshinfo.map.terrain3D",
  /** Cosmetic 3D-buildings extrusion (OpenFreeMap vector tiles). RF-independent. */
  buildings3D: "meshinfo.map.buildings3D",
  /** AGGRESSION_STOPS index (0/1/2). Default 1 = calibrated baseline. */
  coverageAggressionIdx: "meshinfo.map.coverageAggressionIdx",
  /** Clutter model on/off. Off → aggression = 0, ITM-only path loss. */
  coverageClutterEnabled: "meshinfo.map.coverageClutterEnabled",
  /** Canopy-height tier on/off. Off → fall back to class-nominal heights. */
  coverageCanopyEnabled: "meshinfo.map.coverageCanopyEnabled",
  /** Building-height tier on/off. Off → bare-earth DEM + class-nominal endpoint h_a. */
  coverageBuildingsEnabled: "meshinfo.map.coverageBuildingsEnabled",
  /** Last-used scan settings (frequency, modem preset, TX/RX hw/antenna/height, env, reliability). */
  scanSettings: "meshinfo.map.scanSettings",
  /** Named coverage-settings presets (CoveragePreset[]). */
  coveragePresets: "meshinfo.map.coveragePresets",
  /** Coverage auto-recompute on setting changes (default true). */
  coverageAutoRecalc: "meshinfo.map.coverageAutoRecalc",
  /** Last-used coverage settings (semantic CoveragePreset payload). */
  coverageLastSettings: "meshinfo.map.coverageLastSettings",
  /** Last-used LOS settings (frequency, modem preset, per-endpoint hw/antenna/height). */
  losSettings: "meshinfo.map.losSettings",
  /** Live network-coverage layer shown/hidden (off by default). */
  liveCoverage: "meshinfo.map.liveCoverage",
  /** Live network-coverage raster opacity (0..1). */
  liveCoverageOpacity: "meshinfo.map.liveCoverageOpacity",
  /** Hide node markers/clusters while the live coverage layer is shown (on by default). */
  liveCoverageHideNodes: "meshinfo.map.liveCoverageHideNodes",
} as const;

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

let writeFailureToasted = false;
export function writeJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("Failed to persist map setting to localStorage", { key, error: err });
    if (!writeFailureToasted) {
      writeFailureToasted = true;
      toast("Couldn't save your map settings — browser storage may be full or blocked.", { kind: "error" });
    }
  }
}

export function toMapboxStyleUrl(stylePath: string): string {
  // Accepts "mapbox://styles/..." or "user/styleid"
  if (stylePath.startsWith("mapbox://")) return stylePath;
  return `mapbox://styles/${stylePath}`;
}
