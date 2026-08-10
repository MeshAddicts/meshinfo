import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useLiveEvent } from "../../../hooks/useLiveEvent";
import { useGetNodePacketsQuery } from "../../../slices/apiSlice";
import { HardwareModel, type NodeRole,roleTitles } from "../../../types";
import { convertNodeIdFromHexToInt } from "../../../utils/convertNodeId";
import { getElsewhereLinks, resolveElsewhereUrl } from "../../../utils/elsewhereLinks";
import { normalizeNodeId8 } from "../../../utils/normalizeNodeId8";
import { dedupeExchanges, isResolvedHop, orientTraceroute } from "../../../utils/traceroute";
import { useBottomSheetGesture } from "../hooks/useBottomSheet";
import { normNodeId } from "../lib/linkFeatures";
import type { IMapNode, NodeDetailsData } from "../lib/types";
import { DEFAULT_NODE_COLOR,ROLE_COLORS } from "../lib/utils";
import { calculateGeodesicDistance } from "../lib/utils";
import { Sparkline } from "./Sparkline";
import { TelemetrySection } from "./TelemetrySection";

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

function formatHardwareLabel(model: number | string | null | undefined): string | null {
  if (model == null || model === "") return null;
  // API returns hardware as a string ("31") for some nodes and a number for others.
  // TS numeric enums do support string-key lookups, but be explicit so non-numeric strings don't slip through.
  const n = typeof model === "string" ? Number(model) : model;
  if (!Number.isFinite(n)) return null;
  const name = HardwareModel[n as HardwareModel] as string | undefined;
  if (!name) return null;
  return name.replace(/_/g, " ").replace(/\bV(\d)/g, "v$1");
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


interface NeighborRow {
  id: string;
  snr: number | null;
  distanceKm?: number;
}

/** Attach the geodesic distance to each neighbor row — computed once per
 *  selection (inside a useMemo) rather than on every render. */
function withDistances(
  rows: { id: string; snr: number | null }[],
  nodePosition: [number, number],
  liveNodes: Record<string, IMapNode>,
): NeighborRow[] {
  return rows.map((row) => {
    const nnode = liveNodes[row.id];
    let distanceKm: number | undefined;
    if (nnode?.map_position) {
      distanceKm = calculateGeodesicDistance(
        nodePosition[1],
        nodePosition[0],
        nnode.map_position[1],
        nnode.map_position[0],
      );
    }
    return { id: row.id, snr: row.snr, distanceKm };
  });
}

function NeighborTable({
  rows,
  liveNodes,
  onNodeSelect,
  onHoverLink,
}: {
  rows: NeighborRow[];
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (nodeId: string) => void;
  onHoverLink?: (otherNodeId: string | null) => void;
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
              <span className="text-gray-400">{row.snr == null ? "—" : `${row.snr} dB`}</span>
            </div>
          );
        }

        return (
          <div
            key={row.id}
            className="flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
            onMouseEnter={() => onHoverLink?.(row.id)}
            onMouseLeave={() => onHoverLink?.(null)}
          >
            <NodeLink
              id={row.id}
              label={nnode.shortname ?? row.id}
              liveNodes={liveNodes}
              onNodeSelect={onNodeSelect}
            />
            <div className="flex items-center gap-3 text-gray-400">
              <span>{row.snr == null ? "—" : `${row.snr} dB`}</span>
              {row.distanceKm != null && <span className="text-gray-500">{row.distanceKm.toFixed(1)} km</span>}
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
  const contentId = `details-section-${title.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="border-t border-white/10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={contentId}
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
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div id={contentId} className="pb-2.5">{children}</div>}
    </div>
  );
}

const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;
const ACTIVITY_BINS = 30;

/** Epoch ms from a packet timestamp (number in s or ms, or an ISO string). */
function packetTimeMs(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Sparkline of packets involving this node over the last 15 min — seeded from
 *  recent history, then kept current from the SSE packet stream. */
function RecentActivitySparkline({ nodeId }: { nodeId: string }) {
  const { data } = useGetNodePacketsQuery({ nodeId, limit: 200 });
  const liveRef = useRef<number[]>([]);
  const [bins, setBins] = useState<number[]>(() => new Array(ACTIVITY_BINS).fill(0));

  useEffect(() => {
    liveRef.current = [];
  }, [nodeId]);

  useLiveEvent<{ from?: number | string; to?: number | string; timestamp?: number | string }>(
    "packet",
    (p) => {
      if (normalizeNodeId8(p.from) === nodeId || normalizeNodeId8(p.to) === nodeId) {
        liveRef.current.push(packetTimeMs(p.timestamp) ?? Date.now());
      }
    },
  );

  useEffect(() => {
    const recompute = () => {
      const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
      liveRef.current = liveRef.current.filter((t) => t >= cutoff);
      const stamps = [...liveRef.current];
      for (const pkt of data?.packets ?? []) {
        if (normalizeNodeId8(pkt.from) !== nodeId && normalizeNodeId8(pkt.to) !== nodeId) continue;
        const t = packetTimeMs(pkt.timestamp);
        if (t != null && t >= cutoff) stamps.push(t);
      }
      const b = new Array(ACTIVITY_BINS).fill(0);
      for (const t of stamps) {
        b[Math.min(ACTIVITY_BINS - 1, Math.floor(((t - cutoff) / ACTIVITY_WINDOW_MS) * ACTIVITY_BINS))] += 1;
      }
      setBins(b);
    };
    recompute();
    const id = setInterval(recompute, 1500);
    return () => clearInterval(id);
  }, [data, nodeId]);

  const total = bins.reduce((a, b) => a + b, 0);

  return (
    <div className="px-4 pb-3">
      <div className="text-gray-500 text-[10px] uppercase tracking-wider">Recent activity (15 min)</div>
      {total === 0 ? (
        <div className="text-gray-500 text-[11px]">No packets in the last 15 min</div>
      ) : (
        <div className="flex items-center gap-2">
          <Sparkline values={bins} width={150} height={26} color="#34d399" />
          <span className="text-gray-400 text-[11px] tabular-nums">{total} pkt</span>
        </div>
      )}
    </div>
  );
}

/** Memoized: the map re-renders ~2.5×/s on live node flushes, but this panel
 *  only needs to render when the selection (or a geocode resolve) swaps the
 *  `data` identity — the parent passes referentially stable callbacks. */
export const MapDetailsPanel = memo(function MapDetailsPanel({
  data,
  onClose,
  onNodeSelect,
  onHoverLink,
}: {
  data: NodeDetailsData | null;
  onClose: () => void;
  onNodeSelect: (nodeId: string) => void;
  onHoverLink?: (otherNodeId: string | null) => void;
}) {
  const { sheetRef, clearStyles, onTouchStart, onTouchMove, onTouchEnd } = useBottomSheetGesture(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus into the panel when it opens (or switches to a new node), but
  // not on the 5 s poll re-render of the same node.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedNodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data) { focusedNodeRef.current = null; return; }
    if (focusedNodeRef.current !== data.node.id) {
      focusedNodeRef.current = data.node.id;
      requestAnimationFrame(() => headingRef.current?.focus());
    }
  }, [data]);

  // Reset gesture when the selected node changes
  const prevNodeId = useRef<string | null>(null);
  if (data && data.node.id !== prevNodeId.current) {
    prevNodeId.current = data.node.id;
    clearStyles();
  }

  useEffect(() => {
    return () => { onHoverLink?.(null); };
  }, [onHoverLink]);

  // Heavy per-selection derivations. `data` identity only changes on node
  // selection or a geocode resolve, so these skip every other parent render.
  const sortedTracerouteLinks = useMemo(() => {
    if (!data) return [];
    const normId = normNodeId(data.node.id);
    const trLinkCounts = new Map<string, number>();
    // Travel-ordered walk (reply headers are swapped), request+reply of one
    // exchange counted once, speculative/unresolved legs excluded.
    for (const tr of dedupeExchanges(data.traceroutes ?? [])) {
      const o = orientTraceroute(tr);
      if (!o) continue;
      const path = o.orderedPath;
      const idx = path.indexOf(normId);
      if (idx === -1) continue;
      if (idx > 0 && !(o.provisional && idx === path.length - 1)) {
        const prev = path[idx - 1];
        if (isResolvedHop(prev)) trLinkCounts.set(prev, (trLinkCounts.get(prev) ?? 0) + 1);
      }
      if (idx < path.length - 1 && !(o.provisional && idx + 1 === path.length - 1)) {
        const next = path[idx + 1];
        if (isResolvedHop(next)) trLinkCounts.set(next, (trLinkCounts.get(next) ?? 0) + 1);
      }
    }
    return [...trLinkCounts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const neighborRows = useMemo(() => {
    if (!data) return [];
    const { node, liveNodes } = data;
    return withDistances(node.neighbors ?? [], [node.position[0], node.position[1]], liveNodes);
  }, [data]);

  const heardByRows = useMemo(() => {
    if (!data) return [];
    const { node, liveNodes } = data;
    const rows = data.heardBy.map((nid) => {
      const nnode = liveNodes[nid];
      const neighbor = nnode?.neighbors?.find((n) => n.id === node.id);
      return { id: nid, snr: neighbor?.snr ?? null };
    });
    return withDistances(rows, [node.position[0], node.position[1]], liveNodes);
  }, [data]);

  if (!data) return null;

  const { node, liveNodes, displayName, channelLabel } = data;

  const nodeIdInt = convertNodeIdFromHexToInt(node.id);
  const elsewhereLinks = getElsewhereLinks(data.elsewhereLinks);

  // node.id and liveNodes keys can disagree on the `!` prefix, and `hardware` may arrive as a string from the API
  const liveNode = liveNodes[node.id] ?? liveNodes[`!${node.id}`] ?? liveNodes[node.id.replace(/^!/, "")];
  const hardwareLabel = formatHardwareLabel(liveNode?.hardware);

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={node.longname || node.shortname || node.id}
      className="fixed z-1050 flex flex-col
        bg-gray-900/95 shadow-2xl
        bottom-0 left-0 right-0 max-h-[70vh] rounded-t-2xl border-t border-white/10
        animate-[slideInUp_200ms_ease-out]
        sm:bottom-auto sm:left-auto sm:top-0 sm:right-0 sm:max-h-full sm:h-full sm:w-85
        sm:rounded-t-none sm:border-t-0 sm:border-l sm:border-white/10
        sm:animate-[slideInRight_200ms_ease-out]"
    >
      {/* Mobile drag handle (swipe down to dismiss) */}
      <div
        className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-white/20" />
      </div>

      {/* Header (mobile-draggable) */}
      <div
        className="p-4 pb-3 sm:pt-4 pt-1 max-sm:touch-none"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-gray-100 truncate leading-tight focus:outline-none">
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

        <div className="flex items-center gap-2 mt-2">
          <span
            title={node.online ? "Seen within the last 6 hours" : "Last seen over 6 hours ago"}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
            node.online
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-gray-500/20 text-gray-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${node.online ? "bg-emerald-400" : "bg-gray-500"}`} aria-hidden="true" />
            {node.online ? "Online" : "Offline"}
          </span>
          {node.role != null && roleTitles[node.role as NodeRole] && (
            <span
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: `${ROLE_COLORS[node.role] ?? DEFAULT_NODE_COLOR}20`,
                color: ROLE_COLORS[node.role] ?? DEFAULT_NODE_COLOR,
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: ROLE_COLORS[node.role] ?? DEFAULT_NODE_COLOR }}
              />
              {roleTitles[node.role as NodeRole].title}
            </span>
          )}
          {channelLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-white/10 text-gray-400">
              {channelLabel}
            </span>
          )}
        </div>
      </div>

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
            {Math.abs(node.position[0]) < 1e-6 && Math.abs(node.position[1]) < 1e-6
              ? "No GPS fix"
              : `${node.position[1].toFixed(5)}, ${node.position[0].toFixed(5)}`}
          </div>
        </div>
        {hardwareLabel && (
          <div>
            <div className="text-gray-500 text-[10px] uppercase tracking-wider">Hardware</div>
            <div className="text-gray-300 truncate" title={hardwareLabel}>{hardwareLabel}</div>
          </div>
        )}
        {data.maxRangeKm != null && (
          <div>
            <div className="text-gray-500 text-[10px] uppercase tracking-wider">Max Range</div>
            <div className="text-gray-300">{data.maxRangeKm < 1 ? `${Math.round(data.maxRangeKm * 1000)}m` : `${data.maxRangeKm.toFixed(1)}km`}</div>
          </div>
        )}
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

      <RecentActivitySparkline nodeId={node.id} />

      <div className="flex-1 overflow-y-auto min-h-0 px-4">
        <CollapsibleSection
          title="Neighbors Heard"
          count={(node.neighbors ?? []).length}
          defaultOpen
        >
          <NeighborTable
            rows={neighborRows}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
            onHoverLink={onHoverLink}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Heard By"
          count={heardByRows.length}
          defaultOpen
        >
          <NeighborTable
            rows={heardByRows}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
            onHoverLink={onHoverLink}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Telemetry">
          <TelemetrySection nodeId={node.id} />
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
                  <div
                    key={linkedId}
                    className="flex items-center justify-between text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
                    onMouseEnter={() => onHoverLink?.(lookupId)}
                    onMouseLeave={() => onHoverLink?.(null)}
                  >
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
          {elsewhereLinks.length === 0 ? (
            <span className="text-gray-500 text-xs ml-2">None</span>
          ) : (
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
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
});
