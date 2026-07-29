import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
} from "geojson";

import type { ITraceroutesResponse } from "../../../types";
import { normNodeId } from "../../../utils/normalizeNodeId8";
import { unwrapLngTo } from "./geo";
import type { IMapNeighbor, IMapNode, NodeLike } from "./types";

// Re-exported so map-internal importers keep resolving it from here.
export { normNodeId };

/** Straight link coords, destination unwrapped so a seam-crossing link draws short. */
function straightCoords(from: [number, number], to: [number, number]): [number, number][] {
  return [from, [unwrapLngTo(from[0], to[0]), to[1]]];
}

/** Time-since-heard → opacity multiplier. Stale links taper to 0.3 (still
 *  visible). Quantized to 0.1 steps (like dimForLastSeen) so an edge only
 *  changes its feature — and forces a source re-upload — on a bucket crossing,
 *  not on every SSE last_seen bump. */
export function recencyOpacityFromAgeMs(ageMs: number | null): number {
  if (ageMs == null || !Number.isFinite(ageMs)) return 0.6;
  const m = ageMs / 60_000;
  if (m <= 15) return 1.0;
  const raw =
    m <= 60 ? 1.0 - ((m - 15) / 45) * 0.4                // 1.0 → 0.6
    : m <= 360 ? 0.6 - ((m - 60) / 300) * 0.3            // 0.6 → 0.3
    : 0.3;
  return Math.round(raw * 10) / 10;
}

/** Minute-floor for the lastHeardMs feature property: hover cards show relative
 *  time, so sub-minute precision only defeats feature-identity stability. */
function quantizeLastHeardMs(ms: number | null): number | null {
  return ms == null ? null : Math.floor(ms / 60_000) * 60_000;
}

// Traceroute rows are immutable once fetched; normalizing hop ids costs a regex
// per hop, so cache the normalized path per row across the many passes that
// need it (link building, candidate rings, per-node filters).
const normalizedPathCache = new WeakMap<ITraceroutesResponse, string[]>();

/** Full normalized hop path [from, ...route, to] for a traceroute row, cached. */
export function normalizedTraceroutePath(tr: ITraceroutesResponse): string[] {
  const cached = normalizedPathCache.get(tr);
  if (cached) return cached;
  const from = normNodeId(tr?.from);
  const to = normNodeId(tr?.to);
  const route: string[] = ((tr?.route_ids ?? tr?.route ?? tr?.payload?.route ?? []) as (string | number)[])
    .map(normNodeId)
    .filter(Boolean);
  const path = [from, ...route, to].filter(Boolean);
  normalizedPathCache.set(tr, path);
  return path;
}

/** Most recent edge activity (ms). Prefers per-direction `lastRxTime`; falls
 *  back to the older of the two endpoints' `last_seen` when neither side has
 *  rx-time data (typical for traceroute-inferred edges). */
function edgeLastHeardMs(
  forwardNeighbor: IMapNeighbor | undefined,
  reverseNeighbor: IMapNeighbor | undefined,
  fwdLastSeen: string | undefined,
  revLastSeen: string | undefined,
): number | null {
  const fwdRx = forwardNeighbor?.lastRxTime;
  const revRx = reverseNeighbor?.lastRxTime;
  const rxMs: number[] = [];
  if (typeof fwdRx === "number" && fwdRx > 0) rxMs.push(fwdRx * 1000);
  if (typeof revRx === "number" && revRx > 0) rxMs.push(revRx * 1000);
  if (rxMs.length > 0) return Math.max(...rxMs);

  const seenMs: number[] = [];
  if (fwdLastSeen) {
    const t = new Date(fwdLastSeen).getTime();
    if (Number.isFinite(t)) seenMs.push(t);
  }
  if (revLastSeen) {
    const t = new Date(revLastSeen).getTime();
    if (Number.isFinite(t)) seenMs.push(t);
  }
  if (seenMs.length > 0) return Math.min(...seenMs);
  return null;
}

/** Curved arc between two points; offsetFactor 0 = straight line. */
function arcCoordinates(
  from: [number, number],
  to: [number, number],
  segments: number = 16,
  offsetFactor: number = 0.15,
): [number, number][] {
  const toLng = unwrapLngTo(from[0], to[0]);
  const dx = toLng - from[0];
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

  const nowMs = Date.now();

  union.forEach((otherId) => {
    const other = liveNodes[otherId];
    if (!other?.map_position) return;

    const isNeighbor = neighborSet.has(otherId);
    const isHeardBy = heardBySet.has(otherId);
    const kind = isNeighbor && isHeardBy ? "both" : isNeighbor ? "neighbor" : "heard_by";

    // Prefer this node's SNR; fall back to reverse
    const fwdEntry = (node.neighbors ?? []).find((n) => n.id === otherId);
    const revEntry = (other.neighbors ?? []).find((n) => n.id === node.id);
    const snr = fwdEntry?.snr ?? revEntry?.snr ?? null;
    const lastHeardMs = edgeLastHeardMs(fwdEntry, revEntry, node.last_seen, other.last_seen);
    const recencyOpacity = recencyOpacityFromAgeMs(lastHeardMs == null ? null : nowMs - lastHeardMs);

    const from: [number, number] = [node.position[0], node.position[1]];
    const to: [number, number] = [other.map_position[0], other.map_position[1]];

    linkFeatures.push({
      type: "Feature",
      properties: {
        kind,
        snr,
        aId: node.id,
        bId: otherId,
        lastHeardMs: quantizeLastHeardMs(lastHeardMs),
        recencyOpacity,
      },
      geometry: {
        type: "LineString",
        coordinates: kind === "both" ? arcCoordinates(from, to) : straightCoords(from, to),
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
  const nowMs = Date.now();

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
      const lastHeardMs = edgeLastHeardMs(neighbor, revEntry, node.last_seen, other.last_seen);
      const recencyOpacity = recencyOpacityFromAgeMs(lastHeardMs == null ? null : nowMs - lastHeardMs);

      const from: [number, number] = [node.map_position[0], node.map_position[1]];
      const to: [number, number] = [other.map_position[0], other.map_position[1]];
      const kind = isMutual ? "both" : "neighbor";

      linkFeatures.push({
        type: "Feature",
        properties: {
          kind,
          snr,
          aId: nodeId,
          bId: neighbor.id,
          lastHeardMs: quantizeLastHeardMs(lastHeardMs),
          recencyOpacity,
        },
        geometry: {
          type: "LineString",
          coordinates: kind === "both" ? arcCoordinates(from, to) : straightCoords(from, to),
        },
      });
    }
  }

  return { type: "FeatureCollection", features: linkFeatures };
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
    const path = normalizedTraceroutePath(tr);

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

      // Traceroute lines have no per-link rx_time; fall back to whichever endpoint
      // we last saw alive — gives recency fade something to bite on.
      const lastHeardMs = edgeLastHeardMs(undefined, undefined, nodeA.last_seen, nodeB.last_seen);
      const nowMs = Date.now();
      const recencyOpacity = recencyOpacityFromAgeMs(lastHeardMs == null ? null : nowMs - lastHeardMs);

      linkFeatures.push({
        type: "Feature",
        properties: {
          kind: "traceroute",
          snr: null,
          aId: ka,
          bId: kb,
          lastHeardMs: quantizeLastHeardMs(lastHeardMs),
          recencyOpacity,
        },
        geometry: {
          type: "LineString",
          coordinates: straightCoords(
            [nodeA.map_position[0], nodeA.map_position[1]],
            [nodeB.map_position[0], nodeB.map_position[1]],
          ),
        },
      });
    }
  }

  return { type: "FeatureCollection", features: linkFeatures };
}
