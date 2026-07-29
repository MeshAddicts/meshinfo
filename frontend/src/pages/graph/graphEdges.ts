import { type GraphEdge,normNodeId } from "./graphUtils";

export function buildNeighborEdges(nodesById: Record<string, any>): GraphEdge[] {
  const wByKey = new Map<string, { w: number; snr: number }>();
  for (const rawId of Object.keys(nodesById)) {
    const id = normNodeId(rawId);
    const node = nodesById[rawId];
    if (!id) continue;
    const ni = node?.neighborinfo ?? node?.neighborInfo ?? node?.neighbor_info ?? null;
    if (!ni) continue;
    const neighbors: any[] = ni?.neighbors ?? ni?.neighborList ?? ni?.neighbor_list ?? [];
    if (!Array.isArray(neighbors)) continue;
    for (const nb of neighbors) {
      const nbId = normNodeId(nb?.node_id ?? nb?.nodeId ?? nb?.id);
      if (!nbId || nbId === id) continue;
      const a = id < nbId ? id : nbId, b = id < nbId ? nbId : id;
      const key = `${a}~${b}`;
      const existing = wByKey.get(key);
      const snr = typeof nb?.snr === "number" ? nb.snr : 0;
      if (existing) { existing.w += 1; if (snr > existing.snr) existing.snr = snr; }
      else wByKey.set(key, { w: 1, snr });
    }
  }
  const edges: GraphEdge[] = [];
  for (const [key, val] of wByKey.entries()) {
    const [a, b] = key.split("~");
    edges.push({ a, b, w: val.w, kind: "neighbor", snr: val.snr });
  }
  return edges;
}

export function buildTracerouteEdges(traceroutes: any[], validIds: Set<string>): GraphEdge[] {
  const wByKey = new Map<string, number>();
  for (const tr of traceroutes) {
    const from = normNodeId(tr?.from), to = normNodeId(tr?.to);
    // route_ids first: slim traceroute rows (?slim=1) drop the legacy route fields.
    const route: string[] = (tr?.route_ids ?? tr?.route ?? tr?.payload?.route ?? []).map(normNodeId).filter(Boolean);
    const path = [from, ...route, to].filter(Boolean);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (!a || !b || a === b) continue;
      const ka = a < b ? a : b, kb = a < b ? b : a;
      wByKey.set(`${ka}~${kb}`, (wByKey.get(`${ka}~${kb}`) ?? 0) + 1);
    }
  }
  const edges: GraphEdge[] = [];
  for (const [key, w] of wByKey.entries()) {
    const [a, b] = key.split("~");
    if (validIds.has(a) && validIds.has(b)) edges.push({ a, b, w, kind: "traceroute" });
  }
  return edges;
}

export function mergeEdges(neighborEdges: GraphEdge[], tracerouteEdges: GraphEdge[]): GraphEdge[] {
  const map = new Map<string, GraphEdge>();
  for (const e of neighborEdges) map.set(`${e.a}~${e.b}`, { ...e });
  for (const e of tracerouteEdges) {
    const key = `${e.a}~${e.b}`;
    const ex = map.get(key);
    if (ex) ex.w += e.w; else map.set(key, { ...e });
  }
  return Array.from(map.values());
}