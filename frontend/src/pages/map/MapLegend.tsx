import type { LinkMode } from "./types";

export function MapLegend({
  linkMode = "selected",
  myNodeLabel,
}: {
  linkMode?: LinkMode;
  myNodeLabel?: string;
}) {
  const linkHint =
    linkMode === "all"
      ? "Showing links for all nodes."
      : linkMode === "mynode"
        ? `Showing links for ${myNodeLabel || "My Node"}.`
        : "Links shown when a node is selected.";

  return (
    <div
      id="legend"
      role="group"
      aria-labelledby="legend-heading"
      className="bg-gray-900/80 backdrop-blur-xl rounded-xl shadow-2xl border border-white/10 p-3"
    >
      <div id="legend-heading" className="text-xs font-semibold text-gray-300 mb-2">
        Legend
      </div>
      <div className="space-y-1.5 text-[11px] text-gray-400">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full shadow-sm shrink-0" style={{ backgroundColor: "#32f032" }} />
          <span>Online node</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full shadow-sm shrink-0" style={{ backgroundColor: "#72798a" }} />
          <span>Offline node</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
            <div className="w-2.5 h-2.5 rounded-full ring-2 ring-orange-400 shadow-sm" style={{ backgroundColor: "#32f032" }} />
          </div>
          <span>Selected node</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0" aria-hidden="true">
            <circle cx="10" cy="10" r="7" fill="none" stroke="#72798a" strokeWidth="3" />
            <circle
              cx="10" cy="10" r="7"
              fill="none" stroke="#32f032" strokeWidth="3"
              strokeDasharray="30 100"
              transform="rotate(-90 10 10)"
            />
            <circle cx="10" cy="10" r="4" fill="#0f172a" />
          </svg>
          <span>Cluster (ring = online ratio)</span>
        </div>

        <div className="border-t border-white/10 my-1" />

        {/* Link color = SNR (quality). Kind is conveyed by line style below. */}
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="legend-snr-gradient" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#FF4444" />
                <stop offset="50%" stopColor="#FFDD00" />
                <stop offset="100%" stopColor="#44CC44" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="24" height="4" fill="url(#legend-snr-gradient)" />
          </svg>
          <span>Link quality (low → high SNR)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-gray-400 rounded-full shrink-0" />
          <span>SNR unknown</span>
        </div>

        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
            <line x1="0" y1="2" x2="24" y2="2" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <span>This node heard neighbor</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
            <line x1="0" y1="2" x2="24" y2="2" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="4 3" />
          </svg>
          <span>Neighbor heard this node</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 8" preserveAspectRatio="none" className="w-4 h-2 shrink-0" aria-hidden="true">
            <path d="M 1 6 Q 12 -2 23 6" stroke="#cbd5e1" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </svg>
          <span>Mutual link</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
            <line x1="0" y1="2" x2="24" y2="2" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 3" />
          </svg>
          <span>Traceroute (inferred)</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="legend-recency-fade" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1.0" />
                <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.2" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="24" height="4" fill="url(#legend-recency-fade)" />
          </svg>
          <span>Recency (recent → stale)</span>
        </div>

        <div className="border-t border-white/10 my-1" />
        <div className="text-[10px] text-gray-500 leading-tight">
          Online = seen in last 6 hours.
          <br />
          {linkHint}
        </div>
      </div>
    </div>
  );
}
