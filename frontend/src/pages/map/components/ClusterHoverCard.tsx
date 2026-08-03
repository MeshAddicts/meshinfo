import { useEffect, useMemo, useReducer } from "react";

import { NodeRole, roleTitles } from "../../../types";
import { relativeTime } from "../lib/helpers";
import { DEFAULT_NODE_COLOR, dimForLastSeen, nodeColor, OFFLINE_NODE_COLOR } from "../lib/utils";

export type ClusterHover = {
  ids: string[]; // leaf node ids, captured at hover (empty while resolving)
  count: number;
  online: number;
  x: number; // cluster center, screen px
  y: number;
};

/** Per-node snapshot of exactly what the card renders. The parent builds this
 *  array once per hover (from the cluster's leaf ids) instead of handing the
 *  whole node cache down — so live node flushes don't re-render the card. */
export interface ClusterHoverLeaf {
  id: string;
  shortname?: string;
  longname?: string;
  online: boolean;
  role?: NodeRole;
  last_seen?: string;
}

const LEADERBOARD_MAX = 6;

/** Display-only card anchored beside a hovered cluster. Counts come from the
 *  cluster aggregate; the member breakdown/leaderboard render from the leaf
 *  snapshot captured at hover. */
export function ClusterHoverCard({
  hover,
  leaves,
}: {
  hover: ClusterHover | null;
  leaves: ClusterHoverLeaf[];
}) {
  // Keep relative times fresh even when the node cache is idle. Only the time
  // strings recompute per tick — the memos below key on `leaves` identity.
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (!hover) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [hover]);

  const roleBreakdown = useMemo(() => {
    const counts = new Map<number, number>();
    for (const n of leaves) counts.set(n.role ?? NodeRole.CLIENT, (counts.get(n.role ?? NodeRole.CLIENT) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [leaves]);

  const topHeard = useMemo(
    () =>
      [...leaves]
        .filter((n) => n.last_seen)
        .sort((a, b) => new Date(b.last_seen ?? 0).getTime() - new Date(a.last_seen ?? 0).getTime())
        .slice(0, LEADERBOARD_MAX),
    [leaves],
  );

  if (!hover) return null;

  const { count, online, x, y } = hover;
  const offline = Math.max(0, count - online);
  const ratioPct = count > 0 ? Math.round((online / count) * 100) : 0;

  return (
    <div
      className="absolute z-40 pointer-events-none w-64 -translate-y-1/2 rounded-xl border border-white/10 bg-gray-900/95 shadow-2xl text-gray-200 overflow-hidden"
      style={{ left: x + 22, top: y }}
    >
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <div className="text-sm font-semibold">{count} nodes</div>
        <div className="text-[11px] tabular-nums text-gray-400">{ratioPct}% online</div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div>
          <div className="h-1.5 rounded-full overflow-hidden bg-gray-700/60 flex">
            <div className="h-full" style={{ width: `${ratioPct}%`, background: DEFAULT_NODE_COLOR }} />
            <div className="h-full flex-1" style={{ background: OFFLINE_NODE_COLOR }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-400 tabular-nums">
            {online} online · {offline} offline
          </div>
        </div>

        {roleBreakdown.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {roleBreakdown.map(([role, n]) => (
              <span
                key={role}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] bg-white/5"
              >
                {n} {roleTitles[role as NodeRole]?.title ?? "Node"}
              </span>
            ))}
          </div>
        )}

        {topHeard.length > 0 && (
          <div className="pt-1 border-t border-white/10">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Last heard</div>
            <ul className="space-y-0.5">
              {topHeard.map((n) => (
                <li key={n.id} className="flex items-center gap-1.5 text-[11px]">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background: nodeColor(n.role, !!n.online),
                      // Brightness = recency, matching the map dots (dimForLastSeen
                      // is quantized, so the per-second ticks rarely change it).
                      opacity: dimForLastSeen(n.last_seen, Date.now()),
                    }}
                  />
                  <span className="truncate flex-1">{n.shortname || n.longname || n.id}</span>
                  <span className="text-gray-500 tabular-nums shrink-0">{relativeTime(n.last_seen)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {hover.ids.length === 0 && <div className="text-[11px] text-gray-500">Loading members…</div>}
      </div>
    </div>
  );
}
