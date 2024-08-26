import { INode } from "../types";
import { getDistanceBetweenTwoPoints } from "./getDistanceBetweenPoints";

export function calculateDistanceBetweenNodes(
  node1: INode,
  node2: INode
): number | null {
  if (!node1 || !node2) {
    return null;
  }
  if (!node1.position || !node2.position) {
    return null;
  }
  if (
    !("latitude_i" in node1.position) ||
    !("longitude_i" in node1.position) ||
    !("latitude_i" in node2.position) ||
    !("longitude_i" in node2.position) ||
    node1.position.latitude_i == null ||
    node1.position.longitude_i == null ||
    node2.position.latitude_i == null ||
    node2.position.longitude_i == null
  ) {
    return null;
  }

  return (
    Math.round(
      getDistanceBetweenTwoPoints(
        [
          node1.position.latitude_i / 10000000,
          node1.position.longitude_i / 10000000,
        ],
        [
          node2.position.latitude_i / 10000000,
          node2.position.longitude_i / 10000000,
        ]
      ) * 100
    ) / 100
  );
}
