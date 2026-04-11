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
      className="bg-gray-900/80 backdrop-blur-xl rounded-xl shadow-2xl border border-white/10 p-3"
    >
      <div className="text-xs font-semibold text-gray-300 mb-2">
        Legend
      </div>
      <div className="space-y-1.5 text-[11px] text-gray-400">
        {/* Node symbols */}
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-sm shrink-0" />
          <span>Online Node</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-gray-600 border border-gray-500 shrink-0" />
          <span>Offline Node</span>
        </div>

        {/* Divider */}
        <div className="border-t border-white/10 my-1" />

        {/* Line symbols */}
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#66FF66] rounded-full shrink-0" />
          <span>Heard A Neighbor</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#6666FF] rounded-full shrink-0" />
          <span>Heard By Neighbor</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#FF66FF] rounded-full shrink-0" />
          <span>Mutual Connection</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#F59E0B] rounded-full shrink-0" />
          <span>Traceroute Link</span>
        </div>

        {/* Info */}
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
