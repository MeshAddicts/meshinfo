export const LS_KEYS = {
  provider: "meshinfo.map.provider",
  mapboxStyle: "meshinfo.map.mapboxStyle",
  osmBasemap: "meshinfo.map.osmBasemap",
  recentDays: "meshinfo.map.recentDays",
  clusterEnabled: "meshinfo.map.clusterEnabled",
  settingsPanelOpen: "meshinfo.map.settingsPanelOpen",
  linkMode: "meshinfo.map.linkMode",
  myNodeId: "meshinfo.map.myNodeId",
  terrain3D: "meshinfo.map.terrain3D",
  /** AGGRESSION_STOPS index (0/1/2). Default 1 = calibrated baseline. */
  coverageAggressionIdx: "meshinfo.map.coverageAggressionIdx",
  scanAggressionIdx: "meshinfo.map.scanAggressionIdx",
  /** Clutter model on/off. Off → aggression = 0, ITM-only path loss. */
  coverageClutterEnabled: "meshinfo.map.coverageClutterEnabled",
  scanClutterEnabled: "meshinfo.map.scanClutterEnabled",
  /** Canopy-height tier on/off. Off → fall back to class-nominal heights. */
  coverageCanopyEnabled: "meshinfo.map.coverageCanopyEnabled",
  scanCanopyEnabled: "meshinfo.map.scanCanopyEnabled",
  /** Building-height tier on/off. Off → bare-earth DEM + class-nominal endpoint h_a. */
  coverageBuildingsEnabled: "meshinfo.map.coverageBuildingsEnabled",
  scanBuildingsEnabled: "meshinfo.map.scanBuildingsEnabled",
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

export function writeJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn("Failed to persist map setting to localStorage", { key, error: err });
  }
}

export function toMapboxStyleUrl(stylePath: string): string {
  // Accepts "mapbox://styles/..." or "user/styleid"
  if (stylePath.startsWith("mapbox://")) return stylePath;
  return `mapbox://styles/${stylePath}`;
}
