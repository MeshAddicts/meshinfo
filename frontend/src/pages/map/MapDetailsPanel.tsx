import { useCallback, useEffect, useRef, useState } from "react";

import { roleTitles, type NodeRole } from "../../types";
import { getElsewhereLinks, resolveElsewhereUrl } from "../../utils/elsewhereLinks";
import { ROLE_COLORS, DEFAULT_NODE_COLOR } from "./utils";
import { calculateGeodesicDistance } from "./utils";
import { normNodeId } from "./linkFeatures";
import { findPathsBetween } from "./pathAnalysis";
import { TelemetrySection } from "./TelemetrySection";
import type { IMapNode, NodeDetailsData, PathAnalysisProps } from "./types";

// ---------------------------------------------------------------------------
// Bottom sheet gesture hook — swipe down to dismiss, swipe up to expand
// All visual changes are imperative (refs + DOM) to avoid fighting React renders.
// ---------------------------------------------------------------------------
function useBottomSheetGesture(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const dragging = useRef(false);
  const expandedRef = useRef(false);

  const clearStyles = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.classList.remove("bottom-sheet-expanded", "bottom-sheet-collapsing");
    expandedRef.current = false;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragging.current = true;
    startY.current = e.touches[0].clientY;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "none";
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    const dy = e.touches[0].clientY - startY.current;
    // Downward: free drag. Upward: resistance feel.
    const visualDy = dy < 0 ? dy * 0.4 : dy;
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${visualDy}px)`;
    }
  }, []);

  // Compute delta directly from touchend event — more reliable than tracking via ref
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const sheet = sheetRef.current;
    if (!sheet) return;

    const dy = e.changedTouches[0].clientY - startY.current;
    const threshold = sheet.offsetHeight * 0.25;

    if (dy > threshold) {
      if (expandedRef.current) {
        // Collapse back to default height
        expandedRef.current = false;
        sheet.style.transform = "translateY(0)";
        sheet.classList.remove("bottom-sheet-expanded");
        sheet.classList.add("bottom-sheet-collapsing");
        sheet.addEventListener("transitionend", () => {
          sheet.classList.remove("bottom-sheet-collapsing");
        }, { once: true });
      } else {
        // Dismiss: animate off-screen then call onClose
        sheet.style.transition = "transform 200ms ease-in";
        sheet.style.transform = "translateY(100%)";
        sheet.addEventListener("transitionend", () => onClose(), { once: true });
      }
    } else if (dy < -40 && !expandedRef.current) {
      // Swiped up — expand to full height
      expandedRef.current = true;
      sheet.style.transform = "translateY(0)";
      sheet.classList.add("bottom-sheet-expanded");
    } else {
      // Snap back
      sheet.style.transition = "transform 200ms ease-out";
      sheet.style.transform = "translateY(0)";
    }
  }, [onClose]);

  return { sheetRef, clearStyles, onTouchStart, onTouchMove, onTouchEnd };
}

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

function PathAnalysisSection({
  fromNode,
  traceroutes,
  liveNodes,
  pathAnalysis,
  onNodeSelect,
  onHoverLink,
}: {
  fromNode: { id: string; shortname?: string };
  traceroutes: import("../../types").ITraceroutesResponse[];
  liveNodes: Record<string, IMapNode>;
  pathAnalysis: PathAnalysisProps;
  onNodeSelect: (id: string) => void;
  onHoverLink?: (id: string | null) => void;
}) {
  const paths = pathAnalysis.targetId
    ? findPathsBetween(fromNode.id, pathAnalysis.targetId, traceroutes)
    : [];

  const target = pathAnalysis.targetId
    ? liveNodes[pathAnalysis.targetId] ?? liveNodes[`!${pathAnalysis.targetId}`]
    : null;

  if (!pathAnalysis.targetId) {
    return (
      <div className="px-2 py-1">
        <button
          type="button"
          onClick={pathAnalysis.onEnterPickMode}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
            pathAnalysis.pickMode
              ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300"
              : "bg-white/5 border-white/10 text-gray-300 hover:bg-white/10"
          }`}
        >
          {pathAnalysis.pickMode ? "Click a second node… (Esc to cancel)" : "Compare path to another node"}
        </button>
      </div>
    );
  }

  const shortest = paths[0];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-2 py-1">
        <div className="text-xs text-gray-300">
          <span className="text-gray-500">To:</span>{" "}
          <button
            type="button"
            onClick={() => onNodeSelect(pathAnalysis.targetId!)}
            className="text-cyan-400 hover:text-cyan-300"
          >
            {target?.shortname ?? pathAnalysis.targetId}
          </button>
        </div>
        <button
          type="button"
          onClick={pathAnalysis.onClearPath}
          className="text-[10px] text-gray-500 hover:text-gray-300"
        >
          Clear
        </button>
      </div>

      {paths.length === 0 ? (
        <div className="px-2 text-xs text-gray-500">No known traceroute path between these nodes.</div>
      ) : (
        <>
          {shortest && (
            <div className="px-2 py-1.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-xs">
              <div className="text-cyan-400 text-[10px] uppercase tracking-wider mb-0.5">Shortest Path</div>
              <div className="text-gray-200">
                {shortest.hopCount} {shortest.hopCount === 1 ? "hop" : "hops"}
                {shortest.snr != null && <span className="text-gray-500 ml-2">SNR {shortest.snr} dB</span>}
              </div>
              <PathHopList hops={shortest.hops} liveNodes={liveNodes} onNodeSelect={onNodeSelect} onHoverLink={onHoverLink} />
            </div>
          )}

          {paths.length > 1 && (
            <div className="px-2 pt-1">
              <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">
                Alternative Paths ({paths.length - 1})
              </div>
              <div className="space-y-1">
                {paths.slice(1, 6).map((p, i) => (
                  <div key={i} className="text-xs px-2 py-1 rounded bg-white/5">
                    <div className="text-gray-300">
                      {p.hopCount} {p.hopCount === 1 ? "hop" : "hops"}
                      {p.snr != null && <span className="text-gray-500 ml-2">SNR {p.snr} dB</span>}
                    </div>
                    <PathHopList hops={p.hops} liveNodes={liveNodes} onNodeSelect={onNodeSelect} onHoverLink={onHoverLink} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PathHopList({
  hops,
  liveNodes,
  onNodeSelect,
  onHoverLink,
}: {
  hops: string[];
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (id: string) => void;
  onHoverLink?: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {hops.map((hop, i) => {
        const lookup = liveNodes[hop] ?? liveNodes[`!${hop}`];
        const label = lookup?.shortname ?? hop.slice(0, 8);
        return (
          <span key={`${hop}-${i}`} className="flex items-center gap-1">
            {lookup ? (
              <button
                type="button"
                onClick={() => onNodeSelect(hop)}
                onMouseEnter={() => onHoverLink?.(hop)}
                onMouseLeave={() => onHoverLink?.(null)}
                className="text-cyan-400 hover:text-cyan-300 text-[11px]"
              >
                {label}
              </button>
            ) : (
              <span className="text-gray-500 text-[11px]">{label}</span>
            )}
            {i < hops.length - 1 && (
              <svg className="w-2.5 h-2.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </span>
        );
      })}
    </div>
  );
}

function NeighborTable({
  rows,
  nodePosition,
  liveNodes,
  onNodeSelect,
  onHoverLink,
}: {
  rows: { id: string; snr: number }[];
  nodePosition: [number, number];
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
  onHoverLink,
  pathAnalysis,
}: {
  data: NodeDetailsData | null;
  onClose: () => void;
  onNodeSelect: (nodeId: string) => void;
  onHoverLink?: (otherNodeId: string | null) => void;
  pathAnalysis?: PathAnalysisProps;
}) {
  const { sheetRef, clearStyles, onTouchStart, onTouchMove, onTouchEnd } = useBottomSheetGesture(onClose);

  // Reset gesture state when a different node is selected
  const prevNodeId = useRef<string | null>(null);
  if (data && data.node.id !== prevNodeId.current) {
    prevNodeId.current = data.node.id;
    clearStyles();
  }

  // Clear highlight on unmount
  useEffect(() => {
    return () => { onHoverLink?.(null); };
  }, [onHoverLink]);

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
      ref={sheetRef}
      className="fixed z-1050 flex flex-col
        bg-gray-900/80 backdrop-blur-xl shadow-2xl
        bottom-0 left-0 right-0 max-h-[70vh] rounded-t-2xl border-t border-white/10
        animate-[slideInUp_200ms_ease-out]
        sm:bottom-auto sm:left-auto sm:top-0 sm:right-0 sm:max-h-full sm:h-full sm:w-85
        sm:rounded-t-none sm:border-t-0 sm:border-l sm:border-white/10
        sm:animate-[slideInRight_200ms_ease-out]"
    >
      {/* Drag handle (mobile only) — swipe down to dismiss */}
      <div
        className="sm:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing touch-none"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="w-10 h-1 rounded-full bg-white/20" />
      </div>

      {/* Header — also draggable on mobile */}
      <div
        className="p-4 pb-3 sm:pt-4 pt-1 max-sm:touch-none"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
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
            nodePosition={[node.position[0], node.position[1]]}
            liveNodes={liveNodes}
            onNodeSelect={onNodeSelect}
            onHoverLink={onHoverLink}
          />
        </CollapsibleSection>

        {pathAnalysis && (
          <CollapsibleSection title="Path Analysis" defaultOpen={!!pathAnalysis.targetId}>
            <PathAnalysisSection
              fromNode={node}
              traceroutes={traceroutes}
              liveNodes={liveNodes}
              pathAnalysis={pathAnalysis}
              onNodeSelect={onNodeSelect}
              onHoverLink={onHoverLink}
            />
          </CollapsibleSection>
        )}

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
