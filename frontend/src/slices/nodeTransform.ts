import { INode } from "../types";

/**
 * Normalize a raw node from the API into the shape the UI expects: derive the
 * decimal `latitude`/`longitude` from the integer `*_i` fields. Shared by the
 * `getNodes` REST transform and the SSE live-update path so both produce
 * byte-identical objects.
 *
 * The two sources disagree on position-less nodes — `/v1/nodes` sends
 * `position: null`, but a live `node` event can carry an empty `position: {}`
 * (the backend seeds it in `update_node`). Guarding on numeric coordinates
 * collapses both (and a partially-written position) to `undefined`, so a node
 * without a real fix never lands at NaN/(0,0).
 */
export function transformNode(node: INode): INode {
  const pos = node.position;
  const hasCoords =
    pos != null &&
    typeof pos.latitude_i === "number" &&
    typeof pos.longitude_i === "number";
  return {
    ...node,
    position: hasCoords
      ? {
          ...pos,
          latitude: pos.latitude_i / 1e7,
          longitude: pos.longitude_i / 1e7,
        }
      : undefined,
  };
}
