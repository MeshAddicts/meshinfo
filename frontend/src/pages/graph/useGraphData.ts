import { useMemo, useRef } from "react";

import { buildNeighborEdges, buildTracerouteEdges, mergeEdges } from "./graphEdges";
import { getBestNodeLabel, type GraphEdge,type GraphNode, normNodeId, toNumberLoose } from "./graphUtils";

type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; nodeById: Map<string, GraphNode> };

/**
 * Process raw API data into graph nodes and edges.
 * Returns only connected nodes (degree > 0) by default.
 */
export function useGraphData(
  nodesData: any,
  tracerouteData: any,
  opts: { includeIsolates?: boolean; edgeFilter?: "all" | "neighbor" | "traceroute" } = {}
) {
  // Latest payload, read inside the heavy memo without keying it on identity
  // (SSE flushes churn nodesData ~2.5 Hz; only graph-relevant VALUE changes rebuild).
  const nodesDataRef = useRef(nodesData);
  nodesDataRef.current = nodesData;

  // Cheap value signature over graph-relevant fields only (id, role, label,
  // GPS presence, neighbor ids + snr); recomputed per identity flush.
  const nodesSig = useMemo(() => {
    if (!nodesData || typeof nodesData !== "object" || Array.isArray(nodesData)) return "";
    let sig = "";
    for (const rawId in nodesData) {
      const n = nodesData[rawId];
      const gps = toNumberLoose(n?.position?.latitude ?? n?.latitude) != null ? "g" : "";
      sig += `${rawId}:${n?.role ?? ""}:${getBestNodeLabel(n, rawId)}:${gps}`;
      const ni = n?.neighborinfo ?? n?.neighborInfo ?? n?.neighbor_info;
      const neighbors = ni?.neighbors ?? ni?.neighborList ?? ni?.neighbor_list;
      if (Array.isArray(neighbors)) {
        for (const nb of neighbors) sig += `|${nb?.node_id ?? nb?.nodeId ?? nb?.id}:${nb?.snr}`;
      }
      sig += ";";
    }
    return sig;
  }, [nodesData]);

  // Previous build, returned by reference while the signature + inputs match so
  // downstream canvas views skip re-layout/repaint on identity-only churn.
  const prevRef = useRef<{ sig: string; tr: any; iso: boolean; filter: string; value: GraphData } | null>(null);

  return useMemo<GraphData>(() => {
    const iso = !!opts.includeIsolates;
    // `||`, not `??`: an empty ?edges= URL param must mean "all", not filter-to-nothing
    const filter = opts.edgeFilter || "all";
    const prev = prevRef.current;
    if (prev && prev.sig === nodesSig && prev.tr === tracerouteData && prev.iso === iso && prev.filter === filter) {
      return prev.value;
    }

    const raw = nodesDataRef.current;
    if (!raw) {
      const empty: GraphData = { nodes: [], edges: [], nodeById: new Map<string, GraphNode>() };
      prevRef.current = { sig: nodesSig, tr: tracerouteData, iso, filter, value: empty };
      return empty;
    }

    // Normalize nodes
    const nodesById: Record<string, any> = {};
    if (typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of Object.keys(raw)) {
        const normed = normNodeId(k);
        if (normed) nodesById[normed] = raw[k];
      }
    }

    const allIds = Object.keys(nodesById).filter(Boolean);
    const idSet = new Set(allIds);

    // Build edges
    const neighborEdges = buildNeighborEdges(nodesById);
    const tracerouteEdges = tracerouteData ? buildTracerouteEdges(tracerouteData as any[], idSet) : [];
    let allEdges = mergeEdges(neighborEdges, tracerouteEdges);

    if (filter !== "all") {
      allEdges = allEdges.filter((e) => e.kind === filter);
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
      if (!iso && deg === 0) continue;

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

    const value: GraphData = { nodes, edges, nodeById };
    prevRef.current = { sig: nodesSig, tr: tracerouteData, iso, filter, value };
    return value;
  }, [nodesSig, tracerouteData, opts.includeIsolates, opts.edgeFilter]);
}
