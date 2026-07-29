type NominatimResponse = {
  display_name?: string;
  address?: {
    town?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
  };
};

type MapboxResponse = {
  features?: Array<{
    place_name?: string;
    text?: string;
  }>;
};

import { env } from "../env";

function pickProvider(): "nominatim" | "mapbox" {
  const configured = (env.GEOCODER_PROVIDER ?? "auto").toLowerCase();
  if (configured === "nominatim" || configured === "mapbox") return configured;

  // auto: follow basemap provider
  const mapProvider = (env.MAP_PROVIDER ?? "osm").toLowerCase();
  return mapProvider === "mapbox" ? "mapbox" : "nominatim";
}

// Node positions are stable, so the same coordinates get clicked repeatedly —
// cache results (and in-flight lookups, so a double-click fires one request).
const geocodeCache = new Map<string, Promise<string>>();
const GEOCODE_CACHE_MAX = 200;

export function reverseGeocode(lon: number, lat: number): Promise<string> {
  const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const lookup = reverseGeocodeUncached(lon, lat)
    .then((name) => {
      // Rate-limited/failed lookups resolve "" — return it but don't retain
      // it, so a later click can succeed once the limit clears.
      if (!name) geocodeCache.delete(key);
      return name;
    })
    .catch(() => {
      geocodeCache.delete(key);
      return "";
    });
  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest !== undefined) geocodeCache.delete(oldest);
  }
  geocodeCache.set(key, lookup);
  return lookup;
}

async function reverseGeocodeUncached(lon: number, lat: number): Promise<string> {
  const provider = pickProvider();

  if (provider === "mapbox") {
    const token = env.MAPBOX_TOKEN;
    if (!token) return "";

    const country = env.MAPBOX_GEOCODER_COUNTRY;
    const language = env.MAPBOX_GEOCODER_LANGUAGE;

    const params = new URLSearchParams({
      access_token: token,
      limit: "1",
    });
    if (country) params.set("country", country);
    if (language) params.set("language", language);

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) return "";

    const data = (await res.json()) as MapboxResponse;
    return data.features?.[0]?.place_name ?? "";
  }

  // nominatim
  const email = env.NOMINATIM_EMAIL;
  const params = new URLSearchParams({
    format: "json",
    addressdetails: "1",
    lon: String(lon),
    lat: String(lat),
  });
  if (email) params.set("email", email);

  const url = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return "";

  const data = (await res.json()) as NominatimResponse;

  // Prefer a shorter “Town/City, State, Country” if possible
  const a = data.address;
  const short = [a?.town, a?.city, a?.county, a?.state, a?.country].filter(Boolean).join(", ");
  return short || data.display_name || "";
}
