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

function pickProvider(): "nominatim" | "mapbox" {
  const configured = (import.meta.env.VITE_GEOCODER_PROVIDER ?? "auto").toLowerCase();
  if (configured === "nominatim" || configured === "mapbox") return configured;

  // auto: follow basemap provider 
  const mapProvider = (import.meta.env.VITE_MAP_PROVIDER ?? "osm").toLowerCase();
  return mapProvider === "mapbox" ? "mapbox" : "nominatim";
}

export async function reverseGeocode(lon: number, lat: number): Promise<string> {
  const provider = pickProvider();

  if (provider === "mapbox") {
    const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
    if (!token) return "";

    const country = import.meta.env.VITE_MAPBOX_GEOCODER_COUNTRY as string | undefined;
    const language = import.meta.env.VITE_MAPBOX_GEOCODER_LANGUAGE as string | undefined;

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
  const email = import.meta.env.VITE_NOMINATIM_EMAIL as string | undefined;
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
