import { useMemo } from "react";
import { normNodeId, getBestNodeLabel, toNumberLoose, type GraphNode } from "./graphUtils";
import { buildNeighborEdges, buildTracerouteEdges, mergeEdges } from "./graphEdges";

/**
 * Process raw API data into graph nodes and edges.
 * Returns only connected nodes (degree > 0) by default.
 */
export function useGraphData(
  nodesData: any,
  tracerouteData: any,
  opts: { includeIsolates?: boolean; edgeFilter?: "all" | "neighbor" | "traceroute" } = {}
) {
  return useMemo(() => {
    if (!nodesData) return { nodes: [], edges: [], nodeById: new Map<string, GraphNode>() };

    // Normalize nodes
    const nodesById: Record<string, any> = {};
    if (typeof nodesData === "object" && !Array.isArray(nodesData)) {
      for (const k of Object.keys(nodesData)) {
        const normed = normNodeId(k);
        if (normed) nodesById[normed] = nodesData[k];
      }
    }

    const allIds = Object.keys(nodesById).filter(Boolean);
    const idSet = new Set(allIds);

    // Build edges
    const neighborEdges = buildNeighborEdges(nodesById);
    const tracerouteEdges = tracerouteData ? buildTracerouteEdges(tracerouteData as any[], idSet) : [];
    let allEdges = mergeEdges(neighborEdges, tracerouteEdges);

    if (opts.edgeFilter && opts.edgeFilter !== "all") {
      allEdges = allEdges.filter((e) => e.kind === opts.edgeFilter);
    }

    // Compute degrees
    const degreeById = new Map<string, number>();
    for (const id of allIds) degreeById.set(id, 0);
    for (const e of allEdges) {
      if (degreeById.has(e.a)) degreeById.set(e.a, (degreeById.get(e.a) ?? 0) + 1);
      if (degreeById.has(e.b)) degreeById.set(e.b, (degreeById.get(e.b) ?? 0) + 1);
    }

    // Build graph nodes
    const nodes: GraphNode[] = [];
    for (const id of allIds) {
      const n = nodesById[id];
      const deg = degreeById.get(id) ?? 0;
      if (!opts.includeIsolates && deg === 0) continue;

      nodes.push({
        id,
        label: getBestNodeLabel(n, id),
        degree: deg,
        role: n?.role != null ? String(n.role) : "0",
        hasNeighborInfo: !!(n?.neighborinfo?.neighbors?.length),
        lat: toNumberLoose(n?.position?.latitude ?? n?.latitude) ?? null,
        lon: toNumberLoose(n?.position?.longitude ?? n?.longitude) ?? null,
      });
    }

    // Sort by degree descending
    nodes.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));

    // Only keep edges where both nodes made it through
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const edges = allEdges.filter((e) => nodeIdSet.has(e.a) && nodeIdSet.has(e.b));

    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    return { nodes, edges, nodeById };
  }, [nodesData, tracerouteData, opts.includeIsolates, opts.edgeFilter]);
}