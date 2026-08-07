import { useEffect, useMemo, useRef, useState } from "react";

import type { IMapNode } from "../lib/types";

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
      if (!nodes[neighbor.id]) continue; // skip edges to nodes we've never seen
      adj.get(id)!.add(neighbor.id);
      if (!adj.has(neighbor.id)) adj.set(neighbor.id, new Set());
      adj.get(neighbor.id)!.add(id);
      if (typeof neighbor.snr === "number" && Number.isFinite(neighbor.snr)) {
        snrSum += neighbor.snr;
        snrCount++;
      }
    }
  }

  // BFS diameter, sampled to first 100 nodes (perf cap)
  const adjKeys = [...adj.keys()];
  const nodeIds = adjKeys.slice(0, 100);
  const diameterSampled = adjKeys.length > 100;
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
    diameterSampled,
    linkCount: Math.round([...adj.values()].reduce((sum, s) => sum + s.size, 0) / 2),
  };
}

type MeshHealth = ReturnType<typeof computeHealth>;

/** Refresh cadence for the expensive expanded-card stats (BFS diameter, link
 *  counts, avg SNR). They track slow-moving topology, so 10 s is plenty. */
const HEALTH_REFRESH_MS = 10_000;

export function MapHealthWidget({
  nodes,
  hidden = false,
}: {
  nodes: Record<string, IMapNode>;
  /** Hide below lg while a tool is armed — the tool-pick prompt shares the
   * top-14 row and reaches this pill's row-2 span up to ~920px viewports. */
  hidden?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape or pointerdown outside. Capture + stopPropagation so the
  // press that closes the panel doesn't also run the map's global Esc chain
  // (tool cancel / selection clear); editable fields keep their own Esc.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.stopPropagation();
      setExpanded(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [expanded]);
  // Cheap online/total for the always-visible pill — stays reactive per flush.
  const basic = useMemo(() => {
    const vals = Object.values(nodes);
    let online = 0;
    for (const n of vals) if (n.online) online++;
    return { online, total: vals.length };
  }, [nodes]);

  // The expanded-card stats cost ~5-20ms (adjacency build + up to 100 BFS
  // traversals), and `nodes` identity changes on every ~400ms live flush.
  // Recompute on expand and then at most every 10 s, reading the latest
  // nodes through a ref so flushes alone never trigger the work.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [health, setHealth] = useState<MeshHealth | null>(null);
  useEffect(() => {
    if (!expanded) {
      setHealth(null);
      return;
    }
    const recompute = () => setHealth(computeHealth(nodesRef.current));
    recompute();
    const id = setInterval(recompute, HEALTH_REFRESH_MS);
    return () => clearInterval(id);
  }, [expanded]);

  return (
    <div
      ref={wrapRef}
      // Below xl the top row can't hold it: left-anchored tools collide at
      // <366px and 640-684px, and the lg-only coordinate pill (z-40) covers the
      // right-40 spot until ~1100px. It sits in the coverage pill's second row
      // (left of it) instead, returning to the top row at xl alongside it.
      className={`fixed top-14 right-34 xl:top-3 xl:right-40 z-30 flex flex-col items-end ${hidden ? "max-lg:hidden" : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="mesh-health-panel"
        aria-label={`Mesh health: ${basic.online} of ${basic.total} nodes online`}
        className="px-2 sm:px-3 py-1.5 rounded-xl text-xs font-medium
          bg-gray-900/95 border border-white/10 shadow-2xl
          text-gray-300 hover:text-gray-100 hover:bg-gray-900 transition-colors
          flex items-center gap-1.5 sm:gap-2"
        title="Mesh health"
      >
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          {basic.online}
        </span>
        <span className="hidden sm:inline text-gray-500" aria-hidden="true">/</span>
        <span className="hidden sm:inline text-gray-400">{basic.total}</span>
      </button>

      {expanded && health && (
        <div id="mesh-health-panel" className="mt-2 min-w-55 rounded-xl p-3
          max-sm:fixed max-sm:top-24 max-sm:right-3 max-sm:mt-0
          bg-gray-900/95 border border-white/10 shadow-2xl
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
            <span
              className="text-gray-300"
              title={health.diameterSampled ? "Approximate — BFS sampled to the first 100 nodes" : undefined}
            >
              {health.diameterSampled ? "~" : ""}{health.diameter} hops
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
