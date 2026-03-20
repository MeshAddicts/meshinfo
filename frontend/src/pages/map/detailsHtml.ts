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
  traceroutes?: ITraceroutesResponse[];
}): { html: string; heardBy: string[] } {
  const { node, liveNodes } = opts;
  const displayName = opts.displayName || "Unknown";
  const tblClass = "border border-gray-300 dark:border-gray-600";
  const thStyle = "font-weight:600;padding:2px 4px;";
  const tdStyle = "padding:2px 4px;";

  let panel =
    `<b>${escapeHtml(node.longname ?? "")}</b><br/>` +
    `<span style="opacity:.7">${escapeHtml(node.shortname ?? "")} / ${escapeHtml(node.id)}</span><br/>` +
    `<div style="margin:6px 0">` +
    `<b>Position</b> &nbsp;${escapeHtml(node.position[1].toFixed(6))}, ${escapeHtml(node.position[0].toFixed(6))}<br/>` +
    `<b>Location</b> &nbsp;${escapeHtml(displayName)}<br/>` +
    `<b>Status</b> &nbsp;${node.online ? "Online" : "Offline"}<br/>` +
    `<b>Last Seen</b> &nbsp;${escapeHtml(node.last_seen ?? "")}` +
    `</div>`;

  // --- Neighbors Heard ---
  panel += "<b>Neighbors Heard</b>";
  if ((node.neighbors?.length ?? 0) === 0) {
    panel += " &mdash; <span style='opacity:.5'>None</span>";
  } else {
    panel += `<table border=0 cellpadding=0 cellspacing=0 width=100% class='${tblClass}' style='margin:2px 0 0'>`;
    panel += `<tr><th style="${thStyle}" align=left>Node</th><th style="${thStyle}" align=center>SNR</th><th style="${thStyle}" align=right>Distance</th></tr>`;

    panel += (node.neighbors ?? [])
      .map((neighbor) => {
        const nnode = liveNodes[neighbor.id];
        if (!nnode) {
          return `<tr><td style="${tdStyle}" class="text-gray-600">UNK</td><td style="${tdStyle}" align=center>${neighbor.snr}</td><td style="${tdStyle}"></td></tr>`;
        }

        let distance;
        if (nnode.map_position) {
          distance = calculateGeodesicDistance(
            node.position[1], node.position[0],
            nnode.map_position[1], nnode.map_position[0]
          );
        }

        return `<tr><td style="${tdStyle}" align=left>${escapeHtml(nnode.shortname ?? "")}</td><td style="${tdStyle}" align=center>${neighbor.snr}</td><td style="${tdStyle}" align=right>${
          distance ? distance.toFixed(2) + " km" : ""
        }</td></tr>`;
      })
      .join("");

    panel += "</table>";
  }

  panel += "<br/>";

  // --- Heard By Neighbors ---
  const heardBy = computeHeardByIds(liveNodes, node.id);
  panel += "<b>Heard By Neighbors</b>";

  if (heardBy.length === 0) {
    panel += " &mdash; <span style='opacity:.5'>None</span>";
  } else {
    panel += `<table border=0 cellpadding=0 cellspacing=0 width=100% class='${tblClass}' style='margin:2px 0 0'>`;
    panel += `<tr><th style="${thStyle}" align=left>Node</th><th style="${thStyle}" align=center>SNR</th><th style="${thStyle}" align=right>Distance</th></tr>`;

    panel += heardBy
      .map((nid) => {
        const nnode = liveNodes[nid];
        const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);

        if (!nnode) {
          return `<tr><td style="${tdStyle}" class="text-gray-600">UNK</td><td style="${tdStyle}" align=center>${neighbor?.snr}</td><td style="${tdStyle}"></td></tr>`;
        }

        let distance;
        if (nnode.map_position) {
          distance = calculateGeodesicDistance(
            node.position[1], node.position[0],
            nnode.map_position[1], nnode.map_position[0]
          );
        }

        return `<tr><td style="${tdStyle}" align=left>${escapeHtml(nnode.shortname ?? "")}</td><td style="${tdStyle}" align=center>${neighbor?.snr}</td><td style="${tdStyle}" align=right>${
          distance ? distance.toFixed(2) + " km" : ""
        }</td></tr>`;
      })
      .join("");

    panel += "</table>";
  }

  panel += "<br/>";

  // --- Traceroute Links ---
  const traceroutes = opts.traceroutes ?? [];
  const normId = normNodeId(node.id);
  // Find all nodes this node connects to via traceroute hops
  const trLinkCounts = new Map<string, number>();
  for (const tr of traceroutes) {
    const from = normNodeId(tr.from);
    const to = normNodeId(tr.to);
    const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
    const path = [from, ...hops, to].filter(Boolean);
    const idx = path.indexOf(normId);
    if (idx === -1) continue;
    // Adjacent nodes in the path are direct links
    if (idx > 0) {
      const prev = path[idx - 1];
      trLinkCounts.set(prev, (trLinkCounts.get(prev) ?? 0) + 1);
    }
    if (idx < path.length - 1) {
      const next = path[idx + 1];
      trLinkCounts.set(next, (trLinkCounts.get(next) ?? 0) + 1);
    }
  }

  panel += "<b>Traceroute Links</b>";

  if (trLinkCounts.size === 0) {
    panel += " &mdash; <span style='opacity:.5'>None</span>";
  } else {
    // Sort by count descending
    const sorted = [...trLinkCounts.entries()].sort((a, b) => b[1] - a[1]);
    panel += `<table border=0 cellpadding=0 cellspacing=0 width=100% class='${tblClass}' style='margin:2px 0 0'>`;
    panel += `<tr><th style="${thStyle}" align=left>Node</th><th style="${thStyle}" align=right>Routes</th></tr>`;

    for (const [linkedId, count] of sorted) {
      const linkedNode = liveNodes[linkedId];
      const label = linkedNode?.shortname ? escapeHtml(linkedNode.shortname) : escapeHtml(linkedId);
      panel += `<tr><td style="${tdStyle}" align=left>${label}</td><td style="${tdStyle}" align=right>${count}</td></tr>`;
    }

    panel += "</table>";
  }

  panel += "<br/>";

  // --- Elsewhere ---
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
