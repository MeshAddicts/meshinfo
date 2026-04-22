import { useMemo, useState } from "react";

import type { IMapNode } from "./types";

/** Mesh health: online count, avg SNR, mesh diameter (hops). */
function computeHealth(nodes: Record<string, IMapNode>) {
  const entries = Object.entries(nodes);
  const total = entries.length;
  let online = 0;
  let snrSum = 0;
  let snrCount = 0;

  const adj = new Map<string, Set<string>>();
  for (const [id, n] of entries) {
    if (n.online) online++;
    if (!adj.has(id)) adj.set(id, new Set());
    for (const neighbor of n.neighbors ?? []) {
      adj.get(id)!.add(neighbor.id);
      if (!adj.has(neighbor.id)) adj.set(neighbor.id, new Set());
      adj.get(neighbor.id)!.add(id);
      if (typeof neighbor.snr === "number" && Number.isFinite(neighbor.snr)) {
        snrSum += neighbor.snr;
        snrCount++;
      }
    }
  }

  // BFS diameter, sampled to first 100 nodes
  const nodeIds = [...adj.keys()].slice(0, 100);
  let diameter = 0;
  for (const start of nodeIds) {
    const dist = new Map<string, number>();
    dist.set(start, 0);
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = dist.get(cur)!;
      for (const next of adj.get(cur) ?? []) {
        if (!dist.has(next)) {
          dist.set(next, d + 1);
          queue.push(next);
          if (d + 1 > diameter) diameter = d + 1;
        }
      }
    }
  }

  return {
    total,
    online,
    offline: total - online,
    avgSnr: snrCount > 0 ? snrSum / snrCount : null,
    diameter,
    linkCount: [...adj.values()].reduce((sum, s) => sum + s.size, 0) / 2,
  };
}

export function MapHealthWidget({ nodes }: { nodes: Record<string, IMapNode> }) {
  const [expanded, setExpanded] = useState(false);
  const health = useMemo(() => computeHealth(nodes), [nodes]);

  return (
    <div className="fixed top-3 right-20 sm:right-40 z-30 flex flex-col items-end">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="px-2 sm:px-3 py-1.5 rounded-xl text-xs font-medium
          bg-gray-900/80 backdrop-blur-xl border border-white/10 shadow-2xl
          text-gray-300 hover:text-gray-100 hover:bg-gray-900/90 transition-colors
          flex items-center gap-1.5 sm:gap-2"
        title="Mesh health"
      >
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {health.online}
        </span>
        <span className="hidden sm:inline text-gray-500">/</span>
        <span className="hidden sm:inline text-gray-400">{health.total}</span>
      </button>

      {expanded && (
        <div className="mt-2 min-w-[220px] rounded-xl p-3
          bg-gray-900/90 backdrop-blur-xl border border-white/10 shadow-2xl
          space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Online</span>
            <span className="text-emerald-400 font-medium">{health.online}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Offline</span>
            <span className="text-gray-400">{health.offline}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Total</span>
            <span className="text-gray-300">{health.total}</span>
          </div>
          <div className="h-px bg-white/10" />
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Neighbor links</span>
            <span className="text-gray-300">{health.linkCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Avg SNR</span>
            <span className="text-gray-300">
              {health.avgSnr != null ? `${health.avgSnr.toFixed(1)} dB` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Mesh diameter</span>
            <span className="text-gray-300">{health.diameter} hops</span>
          </div>
        </div>
      )}
    </div>
  );
}
