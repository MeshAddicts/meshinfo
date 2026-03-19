interface RuntimeEnv {
  VITE_API_BASE_URL?: string;
  VITE_MAP_PROVIDER?: string;
  VITE_MAPBOX_TOKEN?: string;
  VITE_MAPBOX_STYLE?: string;
  VITE_GEOCODER_PROVIDER?: string;
  VITE_MAPBOX_GEOCODER_COUNTRY?: string;
  VITE_MAPBOX_GEOCODER_LANGUAGE?: string;
  VITE_NOMINATIM_EMAIL?: string;
}

declare global {
  interface Window {
    __env__?: RuntimeEnv;
  }
}

function get(key: keyof RuntimeEnv): string | undefined {
  const runtime = window.__env__?.[key];
  if (runtime) return runtime;
  const buildTime = import.meta.env[key];
  return buildTime || undefined;
}

export const env = {
  get API_BASE_URL() { return get("VITE_API_BASE_URL"); },
  get MAP_PROVIDER() { return get("VITE_MAP_PROVIDER"); },
  get MAPBOX_TOKEN() { return get("VITE_MAPBOX_TOKEN"); },
  get MAPBOX_STYLE() { return get("VITE_MAPBOX_STYLE"); },
  get GEOCODER_PROVIDER() { return get("VITE_GEOCODER_PROVIDER"); },
  get MAPBOX_GEOCODER_COUNTRY() { return get("VITE_MAPBOX_GEOCODER_COUNTRY"); },
  get MAPBOX_GEOCODER_LANGUAGE() { return get("VITE_MAPBOX_GEOCODER_LANGUAGE"); },
  get NOMINATIM_EMAIL() { return get("VITE_NOMINATIM_EMAIL"); },
};
