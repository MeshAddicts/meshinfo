import { useState } from "react";

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
        className="text-cyan-400 hover:text-cyan-300 cursor-pointer transition-colors"
        onClick={(e) => {
          e.preventDefault();
          onNodeSelect(id);
        }}
      >
        {label}
      </button>
    );
  }
  return <span className="text-gray-500">{label}</span>;
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
    return <span className="text-gray-500 text-xs ml-2">None</span>;
  }

  return (
    <div className="mt-1.5 space-y-0.5">
      {rows.map((row) => {
        const nnode = liveNodes[row.id];
        if (!nnode) {
          return (
            <div key={row.id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5">
              <span className="text-gray-500">UNK</span>
              <span className="text-gray-400">{row.snr} dB</span>
            </div>
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
          <div key={row.id} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors">
            <NodeLink
              id={row.id}
              label={nnode.shortname ?? row.id}
              liveNodes={liveNodes}
              onNodeSelect={onNodeSelect}
            />
            <div className="flex items-center gap-3 text-gray-400">
              <span>{row.snr} dB</span>
              {distance != null && <span className="text-gray-500">{distance.toFixed(1)} km</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-white/10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-2.5 px-1 text-xs font-medium text-gray-300 hover:text-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2">
          {title}
          {count != null && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-gray-400">
              {count}
            </span>
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-gray-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="pb-2.5">{children}</div>}
    </div>
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

  // --- Heard-by neighbor rows ---
  const heardByRows = data.heardBy.map((nid) => {
    const nnode = liveNodes[nid];
    const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);
    return { id: nid, snr: neighbor?.snr ?? 0 };
  });

  return (
    <div
      className="fixed top-0 right-0 z-1050
        w-[92vw] sm:w-85
        h-full
        bg-gray-900/80 backdrop-blur-xl border-l border-white/10 shadow-2xl
        flex flex-col
        animate-[slideInRight_200ms_ease-out]"
    >
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-gray-100 truncate leading-tight">
              {node.longname ?? ""}
            </h2>
            <div className="text-xs text-gray-500 mt-0.5 truncate">
              {node.shortname ?? ""} / {node.id}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-white/10 transition-colors shrink-0 mt-0.5"
            aria-label="Close details"
          >
            <svg
              className="w-4 h-4 text-gray-500"
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

        {/* Status pill */}
        <div className="flex items-center gap-2 mt-2">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
            node.online
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-gray-500/20 text-gray-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${node.online ? "bg-emerald-400" : "bg-gray-500"}`} />
            {node.online ? "Online" : "Offline"}
          </span>
          {channelLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-white/10 text-gray-400">
              {channelLabel}
            </span>
          )}
        </div>
      </div>

      {/* Info grid */}
      <div className="px-4 pb-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div>
          <div className="text-gray-500 text-[10px] uppercase tracking-wider">Location</div>
          <div
            className="text-gray-300 truncate cursor-help"
            title={displayName}
          >
            {shortenLocation(displayName)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px] uppercase tracking-wider">Last Seen</div>
          <div className="text-gray-300">{formatLastSeen(node.last_seen)}</div>
        </div>
        <div>
          <div className="text-gray-500 text-[10px] uppercase tracking-wider">Position</div>
          <div className="text-gray-400 font-mono text-[11px]">
            {node.position[1].toFixed(5)}, {node.position[0].toFixed(5)}
          </div>
        </div>
        {node.gateway && (
          <div>
            <div className="text-gray-500 text-[10px] uppercase tracking-wider">Gateway</div>
            <div className="text-gray-300">
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
          </div>
        )}
      </div>

      {/* Collapsible sections */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4">
        <CollapsibleSection
          title="Neighbors Heard"
          count={(node.neighbors ?? []).length}
          defaultOpen
        >
          <NeighborTable
            rows={node.neighbors ?? []}
            nodePosition={[node.position[0], node.position[1]]}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Heard By"
          count={heardByRows.length}
          defaultOpen
        >
          <NeighborTable
            rows={heardByRows}
            nodePosition={[node.position[0], node.position[1]]}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Traceroute Links"
          count={sortedTracerouteLinks.length}
        >
          {sortedTracerouteLinks.length === 0 ? (
            <span className="text-gray-500 text-xs ml-2">None</span>
          ) : (
            <div className="space-y-0.5">
              {sortedTracerouteLinks.map(([linkedId, count]) => {
                const lookupId = liveNodes[linkedId]
                  ? linkedId
                  : liveNodes[`!${linkedId}`]
                    ? `!${linkedId}`
                    : linkedId;
                const linkedNode = liveNodes[lookupId];
                const label = linkedNode?.shortname ?? linkedId;
                return (
                  <div key={linkedId} className="flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5">
                    <NodeLink
                      id={lookupId}
                      label={label}
                      liveNodes={liveNodes}
                      onNodeSelect={onNodeSelect}
                    />
                    <span className="text-gray-500">{count} routes</span>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection title="Elsewhere">
          <div className="space-y-1 px-2">
            {elsewhereLinks.map((link) => {
              const url = resolveElsewhereUrl(link.url ?? "", node.id, nodeIdInt);
              return (
                <a
                  key={url}
                  className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {link.name ?? ""}
                </a>
              );
            })}
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}
