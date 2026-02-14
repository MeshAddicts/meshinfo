import React, { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useGetConfigQuery, useGetNodesQuery, useGetTraceroutesQuery } from "../slices/apiSlice";
import { useGraphData } from "./graph/useGraphData";
import { ROLE_COLORS, ROLE_LABELS, roleColor } from "./graph/graphUtils";
import { HubSpoke } from "./graph/HubSpoke";
import { ArcDiagram } from "./graph/ArcDiagram";
import { AdjacencyHeatmap } from "./graph/AdjacencyHeatmap";

type ViewMode = "hub" | "arc" | "matrix";

export const Graph = () => {
  const { data: config } = useGetConfigQuery();
  const { data: nodesData, isLoading: nodesLoading, isError } = useGetNodesQuery();
  const { data: tracerouteData, isLoading: trLoading } = useGetTraceroutesQuery();

  const isLoading = nodesLoading || trLoading;

  const [sp, setSp] = useSearchParams();
  const view = (sp.get("view") as ViewMode) || "hub";
  const edgeFilter = (sp.get("edges") ?? "all") as "all" | "neighbor" | "traceroute";
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const setParam = useCallback((k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v == null || v === "") next.delete(k); else next.set(k, v);
    setSp(next, { replace: true });
  }, [sp, setSp]);

  const { nodes, edges, nodeById } = useGraphData(nodesData, tracerouteData, { edgeFilter });

  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  // Stats
  const stats = useMemo(() => {
    const nbrEdges = edges.filter((e) => e.kind === "neighbor").length;
    const trEdges = edges.filter((e) => e.kind === "traceroute").length;
    const roles = new Set(nodes.map((n) => n.role));
    return { nodeCount: nodes.length, nbrEdges, trEdges, totalEdges: edges.length, roles: Array.from(roles).sort() };
  }, [nodes, edges]);

  // Edges for selected node
  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return edges.filter((e) => e.a === selectedId || e.b === selectedId);
  }, [selectedId, edges]);

  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);

  // Loading
  if (isError) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="rounded-xl border border-red-800 bg-red-950/40 p-6 max-w-md text-center">
          <div className="text-red-400 text-sm font-semibold">Failed to load data</div>
          <div className="mt-2 text-xs text-red-400/70">Check backend and refresh.</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-gray-600 border-t-indigo-500 animate-spin" />
          <span className="text-sm text-gray-400">Loading nodes &amp; traceroutes…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-gray-950">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-gray-800/80">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-gray-100">Graph</h1>
            <span className="text-xs text-gray-500">{config?.mesh?.shortname || config?.mesh?.name || ""}</span>
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="rounded border border-gray-700/70 px-1.5 py-0.5">{stats.nodeCount} nodes</span>
              <span className="rounded border border-gray-700/70 px-1.5 py-0.5">
                {stats.totalEdges} links
                {stats.nbrEdges > 0 && stats.trEdges > 0 && (
                  <span className="text-gray-500 ml-1">({stats.nbrEdges}n+{stats.trEdges}tr)</span>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View tabs */}
            <div className="flex rounded-lg border border-gray-700/70 overflow-hidden">
              {([["hub", "Hub & Spoke"], ["arc", "Arc"], ["matrix", "Matrix"]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setParam("view", k === "hub" ? null : k)}
                  className={`px-3 py-1.5 text-xs font-medium transition ${view === k
                    ? "bg-gray-700 text-gray-100"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"}`}
                >{label}</button>
              ))}
            </div>

            <select value={edgeFilter} onChange={(e) => setParam("edges", e.target.value === "all" ? null : e.target.value)}
              className="rounded-lg border border-gray-700/70 bg-transparent px-2 py-1.5 text-xs text-gray-300 outline-none">
              <option value="all">All edges</option>
              <option value="neighbor">Neighbor only</option>
              <option value="traceroute">Traceroute only</option>
            </select>

            <button type="button" onClick={() => setSelectedId(null)}
              className="rounded-lg border border-gray-700/70 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50">
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_320px]">
        {/* Visualization */}
        <div className="min-h-0 bg-gray-950">
          {nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-500">
              No connected nodes found. Try changing the edge filter or check that nodes have neighborinfo enabled.
            </div>
          ) : (
            <>
              {view === "hub" && <HubSpoke nodes={nodes} edges={edges} nodeById={nodeById} selectedId={selectedId} onSelect={onSelect} />}
              {view === "arc" && <ArcDiagram nodes={nodes} edges={edges} nodeById={nodeById} selectedId={selectedId} onSelect={onSelect} />}
              {view === "matrix" && <AdjacencyHeatmap nodes={nodes} edges={edges} nodeById={nodeById} selectedId={selectedId} onSelect={onSelect} />}
            </>
          )}
        </div>

        {/* Sidebar */}
        <div className="min-h-0 border-l border-gray-800/80 bg-gray-950/80">
          <div className="h-full flex flex-col">
            {/* Legend */}
            <div className="px-4 pt-3 pb-2 border-b border-gray-800/60">
              <div className="text-xs font-semibold text-gray-300 mb-2">Legend</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400">
                {stats.roles.map((r) => (
                  <span key={r} className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: roleColor(r) }} />
                    {ROLE_LABELS[r] ?? `Role ${r}`}
                  </span>
                ))}
              </div>
              <div className="flex gap-3 mt-1.5 text-[11px] text-gray-500">
                <span>Solid = RF neighbor</span>
                <span>Dashed = traceroute</span>
              </div>
            </div>

            {/* Top hubs */}
            <div className="px-4 pt-3 pb-2 border-b border-gray-800/60">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-gray-300">Top hubs</div>
                <div className="text-[11px] text-gray-500">click to select</div>
              </div>
              <div className="space-y-0.5 max-h-[200px] overflow-auto">
                {nodes.slice(0, 10).map((n) => (
                  <button key={n.id} type="button" onClick={() => setSelectedId(n.id)}
                    className={`w-full flex items-center justify-between px-2 py-1 rounded text-left transition ${
                      selectedId === n.id ? "bg-gray-800 text-gray-100" : "text-gray-300 hover:bg-gray-800/50"}`}>
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: roleColor(n.role) }} />
                      <span className="truncate text-xs">{n.label}</span>
                      {n.hasNeighborInfo && <span className="text-green-500 text-[9px]">{"\u25CF"}</span>}
                    </span>
                    <span className="text-[11px] text-gray-500 shrink-0 ml-2">{n.degree}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Selection detail */}
            <div className="flex-1 min-h-0 overflow-auto px-4 pt-3 pb-4">
              <div className="text-xs font-semibold text-gray-300 mb-2">Selection</div>
              {!selected ? (
                <div className="text-[11px] text-gray-500">Click a node in the graph or the hub list.</div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: roleColor(selected.role) }} />
                      <span className="text-sm font-semibold text-gray-100">{selected.label}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5 font-mono">{selected.id}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded border border-gray-800 p-2">
                      <div className="text-gray-500">Links</div>
                      <div className="text-gray-200 mt-0.5">{selected.degree}</div>
                    </div>
                    <div className="rounded border border-gray-800 p-2">
                      <div className="text-gray-500">Role</div>
                      <div className="text-gray-200 mt-0.5">{ROLE_LABELS[selected.role] ?? selected.role}</div>
                    </div>
                    <div className="rounded border border-gray-800 p-2">
                      <div className="text-gray-500">Neighborinfo</div>
                      <div className="text-gray-200 mt-0.5">{selected.hasNeighborInfo ? "Yes" : "No"}</div>
                    </div>
                    <div className="rounded border border-gray-800 p-2">
                      <div className="text-gray-500">GPS</div>
                      <div className="text-gray-200 mt-0.5">{selected.lat != null ? "Yes" : "No"}</div>
                    </div>
                  </div>

                  {selectedEdges.length > 0 && (
                    <div>
                      <div className="text-[11px] text-gray-500 mb-1">Connected to ({selectedEdges.length}):</div>
                      <div className="space-y-0.5 max-h-[180px] overflow-auto">
                        {selectedEdges.map((e, i) => {
                          const peerId = e.a === selected.id ? e.b : e.a;
                          const peer = nodeById.get(peerId);
                          return (
                            <button key={i} type="button" onClick={() => setSelectedId(peerId)}
                              className="w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11px] hover:bg-gray-800/50">
                              <span className="flex items-center gap-1.5 text-gray-300 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: roleColor(peer?.role) }} />
                                <span className="truncate">{peer?.label ?? peerId}</span>
                              </span>
                              <span className="text-gray-500 shrink-0 ml-1">
                                {e.kind === "neighbor" ? "RF" : "tr"}
                                {e.snr != null && e.snr !== 0 && ` ${e.snr}dB`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <button type="button" onClick={() => { navigator.clipboard.writeText(selected.id).catch(() => {}); }}
                    className="rounded border border-gray-700 px-2.5 py-1.5 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800/50">
                    Copy ID
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Graph;
