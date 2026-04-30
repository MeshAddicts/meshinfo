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
