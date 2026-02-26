import type {
  Feature as GeoFeature,
  FeatureCollection,
  GeoJsonProperties,
  LineString as GeoLineString,
} from "geojson";

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
  const nodeId = parseInt(node.id, 16);
  panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshview.armooo.net/packet_list/${nodeId}" target="_blank">Armooo's MeshView</a><br/>`;
  panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${encodeURIComponent(node.id)}" target="_blank">Bay Mesh Explorer</a><br/>`;
  panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${nodeId}" target="_blank">Liam's Map</a><br/>`;
  panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshmap.net/#${nodeId}" target="_blank">MeshMap</a><br/>`;

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
