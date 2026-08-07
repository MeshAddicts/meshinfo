import type { IMapNode } from "../lib/types";

/** Inline node-hop list with arrows; used in traceroute results. */
export function PathHopList({
  hops,
  liveNodes,
  onNodeSelect,
  onHoverHop,
}: {
  hops: string[];
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (id: string) => void;
  /** Reports the hovered hop's index (null on leave) so the parent can
   *  highlight that hop's actual path legs on the map. */
  onHoverHop?: (index: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-1 mt-1 overflow-x-auto">
      {hops.map((hop, i) => {
        const lookup = liveNodes[hop] ?? liveNodes[`!${hop}`];
        const label = lookup?.shortname ?? hop.slice(0, 8);
        return (
          <span key={`${hop}-${i}`} className="flex items-center gap-1">
            {lookup ? (
              <button
                type="button"
                onClick={() => onNodeSelect(hop)}
                onMouseEnter={() => onHoverHop?.(i)}
                onMouseLeave={() => onHoverHop?.(null)}
                aria-label={`Node ${label}`}
                className="text-cyan-400 hover:text-cyan-300 text-[11px] rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400"
              >
                {label}
              </button>
            ) : (
              <span
                className="text-gray-500 text-[11px]"
                onMouseEnter={() => onHoverHop?.(i)}
                onMouseLeave={() => onHoverHop?.(null)}
              >
                {label}
              </span>
            )}
            {i < hops.length - 1 && (
              <svg className="w-2.5 h-2.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </span>
        );
      })}
    </div>
  );
}
