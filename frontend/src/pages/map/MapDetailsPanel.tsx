import { getElsewhereLinks, resolveElsewhereUrl } from "../../utils/elsewhereLinks";
import { calculateGeodesicDistance } from "./utils";
import { normNodeId } from "./linkFeatures";
import type { IMapNode, NodeDetailsData } from "./types";

function formatLastSeen(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function shortenLocation(full: string): string {
  const parts = full.split(",").map((s) => s.trim());
  if (parts.length >= 3) {
    const city = parts[parts.length - 3];
    const stateZip = parts[parts.length - 2];
    const state = stateZip.replace(/\s+\d{5}(-\d{4})?$/, "");
    return `${city}, ${state}`;
  }
  return full;
}

function NodeLink({
  id,
  label,
  liveNodes,
  onNodeSelect,
}: {
  id: string;
  label: string;
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (nodeId: string) => void;
}) {
  const target = liveNodes[id];
  if (target?.map_position) {
    return (
      <button
        type="button"
        className="text-indigo-400 hover:text-indigo-300 cursor-pointer"
        onClick={(e) => {
          e.preventDefault();
          onNodeSelect(id);
        }}
      >
        {label}
      </button>
    );
  }
  return <span>{label}</span>;
}

function NeighborTable({
  rows,
  nodePosition,
  liveNodes,
  onNodeSelect,
}: {
  rows: { id: string; snr: number }[];
  nodePosition: [number, number];
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (nodeId: string) => void;
}) {
  if (rows.length === 0) {
    return <span className="opacity-50 ml-1">&mdash; None</span>;
  }

  return (
    <table className="w-full border border-gray-300 dark:border-gray-600 mt-0.5 text-sm">
      <thead>
        <tr>
          <th className="font-semibold px-1 py-0.5 text-left">Node</th>
          <th className="font-semibold px-1 py-0.5 text-center">SNR</th>
          <th className="font-semibold px-1 py-0.5 text-right">Distance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const nnode = liveNodes[row.id];
          if (!nnode) {
            return (
              <tr key={row.id}>
                <td className="px-1 py-0.5 text-gray-500">UNK</td>
                <td className="px-1 py-0.5 text-center">{row.snr}</td>
                <td className="px-1 py-0.5 text-right" />
              </tr>
            );
          }

          let distance: number | undefined;
          if (nnode.map_position) {
            distance = calculateGeodesicDistance(
              nodePosition[1],
              nodePosition[0],
              nnode.map_position[1],
              nnode.map_position[0],
            );
          }

          return (
            <tr key={row.id}>
              <td className="px-1 py-0.5 text-left">
                <NodeLink
                  id={row.id}
                  label={nnode.shortname ?? row.id}
                  liveNodes={liveNodes}
                  onNodeSelect={onNodeSelect}
                />
              </td>
              <td className="px-1 py-0.5 text-center">{row.snr}</td>
              <td className="px-1 py-0.5 text-right">
                {distance != null ? `${distance.toFixed(2)} km` : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function MapDetailsPanel({
  data,
  onClose,
  onNodeSelect,
}: {
  data: NodeDetailsData | null;
  onClose: () => void;
  onNodeSelect: (nodeId: string) => void;
}) {
  if (!data) return null;

  const { node, liveNodes, displayName, traceroutes = [], channelLabel } = data;

  // --- Traceroute link counts ---
  const normId = normNodeId(node.id);
  const trLinkCounts = new Map<string, number>();
  for (const tr of traceroutes) {
    const from = normNodeId(tr.from);
    const to = normNodeId(tr.to);
    const hops = (tr.route_ids ?? tr.route ?? []).map((r: string) => normNodeId(r));
    const path = [from, ...hops, to].filter(Boolean);
    const idx = path.indexOf(normId);
    if (idx === -1) continue;
    if (idx > 0) {
      const prev = path[idx - 1];
      trLinkCounts.set(prev, (trLinkCounts.get(prev) ?? 0) + 1);
    }
    if (idx < path.length - 1) {
      const next = path[idx + 1];
      trLinkCounts.set(next, (trLinkCounts.get(next) ?? 0) + 1);
    }
  }
  const sortedTracerouteLinks = [...trLinkCounts.entries()].sort((a, b) => b[1] - a[1]);

  // --- Elsewhere links ---
  const nodeIdInt = parseInt(node.id, 16);
  const elsewhereLinks = getElsewhereLinks(data.elsewhereLinks);

  // --- Heard-by neighbor rows (need SNR from the reverse direction) ---
  const heardByRows = data.heardBy.map((nid) => {
    const nnode = liveNodes[nid];
    const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);
    return { id: nid, snr: neighbor?.snr ?? 0 };
  });

  return (
    <div
      className="fixed top-2 right-2 z-1050
        w-[92vw] sm:w-80 max-w-[calc(100vw-1rem)]
        bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700
        max-h-[60vh] sm:max-h-[calc(100vh-20rem)]
        overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex-1 min-w-0">
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
            {node.longname ?? ""}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 truncate">
            {node.shortname ?? ""} / {node.id}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-3 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          aria-label="Close details"
        >
          <svg
            className="w-4 h-4 text-gray-500 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-4 overflow-y-auto min-h-0 flex-1 text-sm text-gray-700 dark:text-gray-300">
        {/* Position / Location / Status / Last Seen */}
        <div className="mb-1.5">
          <b>Position</b>&nbsp;
          {node.position[1].toFixed(6)}, {node.position[0].toFixed(6)}
          <br />
          <b>Location</b>&nbsp;
          <span
            title={displayName}
            className="cursor-help border-b border-dotted border-current"
          >
            {shortenLocation(displayName)}
          </span>
          <br />
          <b>Status</b>&nbsp;{node.online ? "Online" : "Offline"}
          <br />
          <b>Last Seen</b>&nbsp;{formatLastSeen(node.last_seen)}
          {channelLabel && (
            <>
              <br />
              <b>Channel</b>&nbsp;{channelLabel}
            </>
          )}
        </div>

        {/* Gateway */}
        {node.gateway && (
          <div className="mb-1.5">
            <b>Gateway</b>&nbsp;
            <NodeLink
              id={node.gateway}
              label={
                liveNodes[node.gateway]?.shortname ??
                liveNodes[node.gateway]?.longname ??
                node.gateway
              }
              liveNodes={liveNodes}
              onNodeSelect={onNodeSelect}
            />
          </div>
        )}

        {/* Neighbors Heard */}
        <div className="mb-1.5">
          <b>Neighbors Heard</b>
          <NeighborTable
            rows={node.neighbors ?? []}
            nodePosition={[node.position[0], node.position[1]]}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
          />
        </div>

        {/* Heard By Neighbors */}
        <div className="mb-1.5">
          <b>Heard By Neighbors</b>
          <NeighborTable
            rows={heardByRows}
            nodePosition={[node.position[0], node.position[1]]}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
          />
        </div>

        {/* Traceroute Links */}
        <div className="mb-1.5">
          <b>Traceroute Links</b>
          {sortedTracerouteLinks.length === 0 ? (
            <span className="opacity-50 ml-1">&mdash; None</span>
          ) : (
            <table className="w-full border border-gray-300 dark:border-gray-600 mt-0.5 text-sm">
              <thead>
                <tr>
                  <th className="font-semibold px-1 py-0.5 text-left">Node</th>
                  <th className="font-semibold px-1 py-0.5 text-right">Routes</th>
                </tr>
              </thead>
              <tbody>
                {sortedTracerouteLinks.map(([linkedId, count]) => {
                  const lookupId = liveNodes[linkedId]
                    ? linkedId
                    : liveNodes[`!${linkedId}`]
                      ? `!${linkedId}`
                      : linkedId;
                  const linkedNode = liveNodes[lookupId];
                  const label = linkedNode?.shortname ?? linkedId;
                  return (
                    <tr key={linkedId}>
                      <td className="px-1 py-0.5 text-left">
                        <NodeLink
                          id={lookupId}
                          label={label}
                          liveNodes={liveNodes}
                          onNodeSelect={onNodeSelect}
                        />
                      </td>
                      <td className="px-1 py-0.5 text-right">{count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Elsewhere */}
        <div className="mb-1.5">
          <b>Elsewhere</b>
          <br />
          {elsewhereLinks.map((link) => {
            const url = resolveElsewhereUrl(link.url ?? "", node.id, nodeIdInt);
            return (
              <a
                key={url}
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {link.name ?? ""}
              </a>
            );
          }).reduce<React.ReactNode[]>((acc, el, i) => {
            if (i > 0) acc.push(<br key={`br-${i}`} />);
            acc.push(el);
            return acc;
          }, [])}
        </div>
      </div>
    </div>
  );
}
