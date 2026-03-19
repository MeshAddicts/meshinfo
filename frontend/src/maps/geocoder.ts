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

export async function reverseGeocode(lon: number, lat: number): Promise<string> {
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
