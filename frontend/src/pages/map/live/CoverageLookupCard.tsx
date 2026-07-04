/** Cursor tooltip listing the nodes covering the hovered point, strongest first. */
import type { IMapNode } from "../lib/types";
import type { CoverageLookupHover } from "./useCoverageLookup";

/** Mirrors the coverage gradient bands (see colorize/coverageRaster gradient). */
function marginColor(db: number): string {
  if (db < 5) return "#d946ef";
  if (db < 15) return "#f97316";
  return "#06b6d4";
}

export function CoverageLookupCard({
  hover,
  nodes,
}: {
  hover: CoverageLookupHover | null;
  nodes: Record<string, IMapNode>;
}) {
  if (!hover) return null;
  const more = hover.total - hover.entries.length;

  return (
    <div
      className="absolute z-40 pointer-events-none w-56 rounded-xl border border-white/10 bg-gray-900/85 backdrop-blur-xl shadow-2xl text-gray-200 overflow-hidden"
      style={{ left: hover.x + 14, top: hover.y + 14 }}
    >
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center justify-between">
        <span className="text-[11px] font-semibold">Coverage here</span>
        <span className="text-[10px] text-gray-500 tabular-nums">{hover.total} node{hover.total === 1 ? "" : "s"}</span>
      </div>
      <ul className="px-3 py-2 space-y-0.5">
        {hover.entries.map((e) => {
          const n = nodes[e.id];
          return (
            <li key={e.id} className="flex items-center gap-1.5 text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: marginColor(e.marginDb) }} />
              <span className="truncate flex-1">{n?.shortname || n?.longname || e.id}</span>
              <span className="text-gray-500 tabular-nums shrink-0">{e.marginDb.toFixed(1)} dB</span>
            </li>
          );
        })}
        {more > 0 && <li className="text-[10px] text-gray-500">+{more} more</li>}
      </ul>
    </div>
  );
}
