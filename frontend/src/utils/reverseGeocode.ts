import { useEffect, useState } from "react";

export const useReverseGeocode = (lon: string, lat: string) => {
  const [address, setAddress] = useState<{
    town?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
  } | undefined>(undefined);

  useEffect(() => {
    const fetchAddress = async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lon}&lat=${lat}`
        );
        const data = await response.json();
        setAddress(data.address);
      } catch (error) {
        console.error("Error fetching reverse geocode data:", error);
      }
    };

    fetchAddress();
  }, [lon, lat]);

  return { address };
};
