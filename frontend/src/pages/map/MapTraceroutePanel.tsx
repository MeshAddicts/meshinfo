import { findPathsBetween } from "./pathAnalysis";
import { PathHopList } from "./PathHopList";
import type { IMapNode } from "./types";
import type { ITraceroutesResponse } from "../../types";

export function MapTraceroutePanel({
  fromId,
  toId,
  fromLabel,
  toLabel,
  fromColor = "#22c55e",
  toColor = "#06b6d4",
  traceroutes,
  liveNodes,
  onNodeSelect,
  onHoverLink,
  onClose,
}: {
  fromId: string;
  toId: string;
  fromLabel: string;
  toLabel: string;
  fromColor?: string;
  toColor?: string;
  traceroutes: ITraceroutesResponse[];
  liveNodes: Record<string, IMapNode>;
  onNodeSelect: (id: string) => void;
  onHoverLink?: (id: string | null) => void;
  onClose: () => void;
}) {
  const paths = findPathsBetween(fromId, toId, traceroutes);
  const shortest = paths[0];

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-1050 w-[min(520px,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto
      rounded-xl shadow-2xl border border-white/10 bg-gray-900/90 backdrop-blur-xl
      animate-[slideInUp_200ms_ease-out]">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 sticky top-0 bg-gray-900/90 backdrop-blur-xl">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border border-cyan-500/30 bg-cyan-500/15 text-cyan-300 shrink-0">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            Traceroute
          </span>
          <div className="text-[11px] text-gray-300 truncate">
            <span style={{ color: fromColor }} className="font-medium">{fromLabel}</span>
            <span className="text-gray-500 mx-1.5">→</span>
            <span style={{ color: toColor }} className="font-medium">{toLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors shrink-0"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="p-3">
        {paths.length === 0 ? (
          <div className="px-2 py-3 text-xs text-gray-500">
            No known traceroute path between these nodes.
          </div>
        ) : (
          <div className="space-y-1.5">
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
          </div>
        )}
      </div>
    </div>
  );
}
