import { Coordinate } from "ol/coordinate";

export const getDistanceBetweenTwoPoints = (
  coord1: Coordinate,
  coord2: Coordinate
) => {
  console.log(coord1, coord2);
  const R = 6371; // Radius of the earth in km
  const dLat = ((coord1[1] - coord2[1]) * Math.PI) / 180;
  const dLon = ((coord1[0] - coord2[1]) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((coord2[1] * Math.PI) / 180) *
      Math.cos((coord1[1] * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 100) / 100;
};
