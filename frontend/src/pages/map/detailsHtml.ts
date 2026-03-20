import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
} from "geojson";

import type { ElsewhereLink } from "../../types/config";
import { getElsewhereLinks, resolveElsewhereUrl } from "../../utils/elsewhereLinks";
import type { ITraceroutesResponse } from "../../types";
import type { IMapNode, NodeLike } from "./types";
import { calculateGeodesicDistance, escapeHtml } from "./utils";

export function computeHeardByIds(liveNodes: Record<string, IMapNode>, targetId: string): string[] {
  return Object.keys(liveNodes).filter((nid) =>
    liveNodes[nid].neighbors?.some((neighbor) => neighbor.id === targetId)
  );
}

export function buildNodeDetailsHtml(opts: {
  node: NodeLike;
  liveNodes: Record<string, IMapNode>;
  displayName: string | null | undefined;
  elsewhereLinks?: ElsewhereLink[];
}): { html: string; heardBy: string[] } {
  const { node, liveNodes } = opts;
  const displayName = opts.displayName || "Unknown";

  let panel =
    `<b>${escapeHtml(node.longname ?? "")}</b><br/>${escapeHtml(node.shortname ?? "")} / ${escapeHtml(node.id)}<br/><br/>` +
    `<b>Position</b><br/>LAT: ${escapeHtml(node.position[1].toString())}<br/>LON: ${escapeHtml(node.position[0].toString())}<br/><br/>` +
    `<b>Location</b><br/>${escapeHtml(displayName)}<br/><br/>` +
    `<b>Status</b><br/>${node.online ? "Online" : "Offline"}<br/><br/>` +
    `<b>Last Seen</b><br/>${escapeHtml(node.last_seen ?? "")}<br/><br/>`;

  panel += "<b>Neighbors Heard</b><br/>";
  if ((node.neighbors?.length ?? 0) === 0) {
    panel += "None";
  } else {
    panel += "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
    panel += "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

    panel += (node.neighbors ?? [])
      .map((neighbor) => {
        const nnode = liveNodes[neighbor.id];
        if (!nnode) {
          return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor.snr}</td><td></td></tr>`;
        }

        let distance;
        if (nnode.map_position) {
          distance = calculateGeodesicDistance(
            node.position[1],
            node.position[0],
            nnode.map_position[1],
            nnode.map_position[0]
          );
        }

        return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor.snr}</td><td align=right>${
          distance ? distance.toFixed(2) : "unk"
        } km</td></tr>`;
      })
      .join("");

    panel += "</table>";
  }

  panel += "<br/><br/>";

  panel += "<b>Heard By Neighbors</b><br/>";
  const heardBy = computeHeardByIds(liveNodes, node.id);

  if (heardBy.length === 0) {
    panel += "None<br/>";
  } else {
    panel += "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
    panel += "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";

    panel += heardBy
      .map((nid) => {
        const nnode = liveNodes[nid];
        const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);

        if (!nnode) {
          return `<tr><td class="text-gray-600">UNK</td><td align=center>${neighbor?.snr}</td><td></td></tr>`;
        }

        let distance;
        if (nnode.map_position) {
          distance = calculateGeodesicDistance(
            node.position[1],
            node.position[0],
            nnode.map_position[1],
            nnode.map_position[0]
          );
        }

        return `<tr><td align=left>${escapeHtml(nnode.shortname ?? "")}</td><td align=center>${neighbor?.snr}</td><td align=right>${
          distance ? distance.toFixed(2) : "unk"
        } km</td></tr>`;
      })
      .join("");

    panel += "</table>";
  }

  panel += "<br/><br/>";

  panel += "<b>Elsewhere</b><br/>";
  const nodeIdInt = parseInt(node.id, 16);
  const links = getElsewhereLinks(opts.elsewhereLinks);
  for (const link of links) {
    const url = resolveElsewhereUrl(link.url ?? "", node.id, nodeIdInt);
    panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="${escapeHtml(url)}" target="_blank">${escapeHtml(link.name ?? "")}</a><br/>`;
  }

  return { html: panel, heardBy };
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

    linkFeatures.push({
      type: "Feature",
      properties: { kind },
      geometry: {
        type: "LineString",
        coordinates: [
          [node.position[0], node.position[1]],
          [other.map_position[0], other.map_position[1]],
        ],
      },
    });
  });

  return { type: "FeatureCollection", features: linkFeatures };
}

/**
 * Build link features for ALL nodes that have neighbor data.
 * Deduplicates edges so A→B and B→A become a single "both" line.
 */
export function buildAllLinksFeatureCollection(
  liveNodes: Record<string, IMapNode>,
): FeatureCollection<GeoLineString, GeoJsonProperties> {
  const linkFeatures: GeoFeature<GeoLineString, GeoJsonProperties>[] = [];

  // Track edges we've already emitted (sorted key "idA|idB")
  const seen = new Set<string>();

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

      // Check if the reverse link also exists (mutual)
      const reverseNeighbors = other.neighbors ?? [];
      const isMutual = reverseNeighbors.some((n) => n.id === nodeId);

      linkFeatures.push({
        type: "Feature",
        properties: { kind: isMutual ? "both" : "neighbor" },
        geometry: {
          type: "LineString",
          coordinates: [
            [node.map_position[0], node.map_position[1]],
            [other.map_position[0], other.map_position[1]],
          ],
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

/**
 * Build link features inferred from traceroute hops.
 * Each consecutive pair in a traceroute path (from → hop1 → hop2 → to)
 * is treated as a link. Deduplicates and only includes edges where both
 * nodes have map positions.
 */
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
    const route: string[] = (tr?.route ?? tr?.payload?.route ?? [])
      .map(normNodeId)
      .filter(Boolean);
    const path = [from, ...route, to].filter(Boolean);

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (!a || !b || a === b) continue;

      const ka = a < b ? a : b;
      const kb = a < b ? b : a;
      const edgeKey = `${ka}|${kb}`;

      // Skip if we already emitted this edge or if a neighbor edge covers it
      if (seen.has(edgeKey)) continue;
      if (neighborEdgeKeys?.has(edgeKey)) continue;
      seen.add(edgeKey);

      const nodeA = liveNodes[ka] ?? liveNodes[`!${ka}`];
      const nodeB = liveNodes[kb] ?? liveNodes[`!${kb}`];
      if (!nodeA?.map_position || !nodeB?.map_position) continue;

      linkFeatures.push({
        type: "Feature",
        properties: { kind: "traceroute" },
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
