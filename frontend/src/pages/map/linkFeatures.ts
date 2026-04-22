import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
} from "geojson";

import type { ITraceroutesResponse } from "../../types";
import type { IMapNode, NodeLike } from "./types";

/** Curved arc between two points; offsetFactor 0 = straight line. */
function arcCoordinates(
  from: [number, number],
  to: [number, number],
  segments: number = 16,
  offsetFactor: number = 0.15,
): [number, number][] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const nx = -dy * offsetFactor;
  const ny = dx * offsetFactor;

  const coords: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ct = 4 * t * (1 - t); // bezier peak at t=0.5
    coords.push([
      from[0] + dx * t + nx * ct,
      from[1] + dy * t + ny * ct,
    ]);
  }
  return coords;
}

export function computeHeardByIds(liveNodes: Record<string, IMapNode>, targetId: string): string[] {
  return Object.keys(liveNodes).filter((nid) =>
    liveNodes[nid].neighbors?.some((neighbor) => neighbor.id === targetId)
  );
}

export function buildMapboxLinkFeatureCollection(opts: {
  node: NodeLike;
  liveNodes: Record<string, IMapNode>;
  heardBy: string[];
}): FeatureCollection<GeoLineString, GeoJsonProperties> {
  const { node, liveNodes, heardBy } = opts;

  const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

  const neighborSet = new Set((node.neighbors ?? []).map((n) => n.id));
  const heardBySet = new Set(heardBy);
  const union = new Set<string>([...neighborSet, ...heardBySet]);

  union.forEach((otherId) => {
    const other = liveNodes[otherId];
    if (!other?.map_position) return;

    const isNeighbor = neighborSet.has(otherId);
    const isHeardBy = heardBySet.has(otherId);
    const kind = isNeighbor && isHeardBy ? "both" : isNeighbor ? "neighbor" : "heard_by";

    // Prefer this node's SNR; fall back to reverse
    const fwdSnr = (node.neighbors ?? []).find((n) => n.id === otherId)?.snr;
    const revSnr = (other.neighbors ?? []).find((n) => n.id === node.id)?.snr;
    const snr = fwdSnr ?? revSnr ?? null;

    const from: [number, number] = [node.position[0], node.position[1]];
    const to: [number, number] = [other.map_position[0], other.map_position[1]];

    linkFeatures.push({
      type: "Feature",
      properties: { kind, snr },
      geometry: {
        type: "LineString",
        coordinates: kind === "both" ? arcCoordinates(from, to) : [from, to],
      },
    });
  });

  return { type: "FeatureCollection", features: linkFeatures };
}

/** Link features for all nodes with neighbor data; dedupes A→B / B→A into one "both" line. */
export function buildAllLinksFeatureCollection(
  liveNodes: Record<string, IMapNode>,
): FeatureCollection<GeoLineString, GeoJsonProperties> {
  const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

  const seen = new Set<string>(); // sorted "idA|idB"

  for (const [nodeId, node] of Object.entries(liveNodes)) {
    if (!node.map_position || !node.neighbors?.length) continue;

    for (const neighbor of node.neighbors) {
      const other = liveNodes[neighbor.id];
      if (!other?.map_position) continue;

      const edgeKey = nodeId < neighbor.id
        ? `${nodeId}|${neighbor.id}`
        : `${neighbor.id}|${nodeId}`;

      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);

      const reverseNeighbors = other.neighbors ?? [];
      const isMutual = reverseNeighbors.some((n) => n.id === nodeId);

      const revEntry = reverseNeighbors.find((n) => n.id === nodeId);
      const snr = neighbor.snr ?? revEntry?.snr ?? null;

      const from: [number, number] = [node.map_position[0], node.map_position[1]];
      const to: [number, number] = [other.map_position[0], other.map_position[1]];
      const kind = isMutual ? "both" : "neighbor";

      linkFeatures.push({
        type: "Feature",
        properties: { kind, snr },
        geometry: {
          type: "LineString",
          coordinates: kind === "both" ? arcCoordinates(from, to) : [from, to],
        },
      });
    }
  }

  return { type: "FeatureCollection", features: linkFeatures };
}

/** Normalize a node ID (int or hex string) to lowercase hex. */
export function normNodeId(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return "";
    return (raw >>> 0).toString(16).toLowerCase();
  }
  let s = String(raw).trim();
  if (/^\d+$/.test(s) && s.length > 6) {
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n > 0) return (n >>> 0).toString(16).toLowerCase();
  }
  if (s.startsWith("!")) s = s.slice(1);
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  return s.toLowerCase();
}

/** Link features from consecutive traceroute hops; dedupes, only emits edges with both positions. */
export function buildTracerouteLinkFeatureCollection(
  traceroutes: ITraceroutesResponse[],
  liveNodes: Record<string, IMapNode>,
  neighborEdgeKeys?: Set<string>,
): FeatureCollection<GeoLineString, GeoJsonProperties> {
  const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];
  const seen = new Set<string>();

  for (const tr of traceroutes) {
    const from = normNodeId(tr?.from);
    const to = normNodeId(tr?.to);
    const route: string[] = (tr?.route_ids ?? tr?.route ?? tr?.payload?.route ?? [])
      .map(normNodeId)
      .filter(Boolean);
    const path = [from, ...route, to].filter(Boolean);

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (!a || !b || a === b) continue;

      const ka = a < b ? a : b;
      const kb = a < b ? b : a;
      const edgeKey = `${ka}|${kb}`;

      if (seen.has(edgeKey)) continue;
      if (neighborEdgeKeys?.has(edgeKey)) continue;
      seen.add(edgeKey);

      const nodeA = liveNodes[ka] ?? liveNodes[`!${ka}`];
      const nodeB = liveNodes[kb] ?? liveNodes[`!${kb}`];
      if (!nodeA?.map_position || !nodeB?.map_position) continue;

      linkFeatures.push({
        type: "Feature",
        properties: { kind: "traceroute", snr: null },
        geometry: {
          type: "LineString",
          coordinates: [
            [nodeA.map_position[0], nodeA.map_position[1]],
            [nodeB.map_position[0], nodeB.map_position[1]],
          ],
        },
      });
    }
  }

  return { type: "FeatureCollection", features: linkFeatures };
}
