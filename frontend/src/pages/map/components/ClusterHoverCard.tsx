import { useEffect, useMemo, useReducer } from "react";

import { NodeRole, roleTitles } from "../../../types";
import { relativeTime } from "../lib/helpers";
import type { IMapNode } from "../lib/types";
import { DEFAULT_NODE_COLOR, OFFLINE_NODE_COLOR, ROLE_COLORS } from "../lib/utils";

export type ClusterHover = {
  ids: string[]; // leaf node ids, captured at hover (empty while resolving)
  count: number;
  online: number;
  x: number; // cluster center, screen px
  y: number;
};

const LEADERBOARD_MAX = 6;

function roleColor(role: number | null | undefined, online: boolean): string {
  if (!online) return OFFLINE_NODE_COLOR;
  return (role != null && ROLE_COLORS[role]) || DEFAULT_NODE_COLOR;
}

/** Display-only card anchored beside a hovered cluster. Counts come from the
 *  cluster aggregate; the member breakdown/leaderboard hydrate from the live
 *  node cache, so it stays current while open. */
export function ClusterHoverCard({
  hover,
  nodes,
}: {
  hover: ClusterHover | null;
  nodes: Record<string, IMapNode>;
}) {
  // Keep relative times fresh even when the node cache is idle.
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (!hover) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [hover]);

  const leaves = useMemo(
    () => (hover ? hover.ids.map((id) => nodes[id]).filter((n): n is IMapNode => Boolean(n)) : []),
    [hover, nodes],
  );

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
      className="absolute z-40 pointer-events-none w-64 -translate-y-1/2 rounded-xl border border-white/10 bg-gray-900/85 backdrop-blur-xl shadow-2xl text-gray-200 overflow-hidden"
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
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: ROLE_COLORS[role] ?? DEFAULT_NODE_COLOR }} />
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
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: roleColor(n.role, !!n.online) }} />
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
