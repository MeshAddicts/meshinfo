/**
 * Shared UI bits for the per-pixel ITU clutter model — used by both
 * MapCoveragePanel and MapScanPanel:
 *
 *   - <AggressionSlider/>   3-stop conservative / calibrated / aggressive picker
 *   - <ClutterStatusChip/>  "Land cover: USGS NLCD 2021" or fallback indicator
 *   - <ClassLegend/>        collapsible 16-row NLCD legend with per-class dB hints
 *
 * Kept compact and self-contained so it can drop into either panel's settings block.
 */
import { useState } from "react";

import { endpointClutterDb, NLCD_CLASSES } from "./clutterClasses";
import { AGGRESSION_STOPS } from "./coverageAnalysis";

const F_915 = 915;
/** Reference antenna height (m) used to populate the legend's "@ 2 m" column. */
const LEGEND_REF_AGL_M = 2;

export function AggressionSlider({
  aggressionIdx,
  onChange,
}: {
  aggressionIdx: number;
  onChange: (idx: number) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[10px] font-medium">
      {AGGRESSION_STOPS.map((stop, i) => {
        const active = aggressionIdx === i;
        return (
          <button
            key={stop.id}
            type="button"
            onClick={() => onChange(i)}
            title={stop.description}
            className={`flex-1 rounded-md px-1.5 py-1 transition-colors ${
              active
                ? "bg-cyan-500/20 text-cyan-200"
                : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
            }`}
          >
            <div>{stop.short}</div>
            <div className="text-[9px] text-gray-500 font-normal">×{stop.value.toFixed(1)}</div>
          </button>
        );
      })}
    </div>
  );
}

export interface ClutterStatusChipProps {
  /** Most recent compute's tile-availability snapshot. Null until first compute. */
  status: { tilesPresent: number; tilesTotal: number } | null;
}

export function ClutterStatusChip({ status }: ClutterStatusChipProps) {
  // Three states:
  //   - status === null: first compute hasn't completed; assume the bake is healthy
  //   - tilesPresent === 0 && tilesTotal > 0: fully out of the baked region or the
  //     API has no tile mount → fall back to default class everywhere
  //   - otherwise: at least some tiles came back; show the source name
  const fallback = status != null && status.tilesTotal > 0 && status.tilesPresent === 0;
  const partial =
    status != null &&
    status.tilesPresent > 0 &&
    status.tilesPresent < status.tilesTotal;

  return (
    <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
      <span
        className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          fallback ? "bg-amber-400/80" : "bg-emerald-400/70"
        }`}
        aria-hidden
      />
      <span>
        {fallback ? (
          <>
            <span className="text-amber-300/90">Mixed Forest fallback</span>
            <span className="text-gray-500"> — no land-cover tiles for this region. Run the bake (see scripts/README-landcover.md).</span>
          </>
        ) : (
          <>
            Land cover: <span className="text-gray-300">USGS NLCD</span>
            {partial && (
              <span className="text-amber-400/80">
                {" "}
                · partial coverage ({status?.tilesPresent}/{status?.tilesTotal} tiles)
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/** Collapsible table summarizing the 16 NLCD CONUS classes the model uses. */
export function ClassLegend() {
  const [open, setOpen] = useState(false);

  // Order classes by ID for predictable legend ordering.
  const rows = Object.values(NLCD_CLASSES)
    .sort((a, b) => a.id - b.id)
    // Skip AK-only and lichen/moss rows in the default view — keeps the legend
    // focused on the classes a CONUS operator actually sees.
    .filter((c) => ![51, 72, 73, 74].includes(c.id));

  return (
    <div className="text-[10px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-1 px-1 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
      >
        <span>Show class legend</span>
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border border-white/5 bg-white/2">
          <table className="w-full text-[9px]">
            <thead className="text-gray-500 border-b border-white/5">
              <tr>
                <th className="text-left px-1.5 py-1 font-medium">ID</th>
                <th className="text-left px-1.5 py-1 font-medium">Class</th>
                <th className="text-right px-1.5 py-1 font-medium" title="ITU-R P.452-17 endpoint clutter at 2 m AGL, 915 MHz">@ 2 m</th>
                <th className="text-right px-1.5 py-1 font-medium" title="Path-traversed vegetation can attenuate signals through this class">Pen.</th>
              </tr>
            </thead>
            <tbody className="text-gray-400">
              {rows.map((cls) => {
                const ahDb = endpointClutterDb(cls, LEGEND_REF_AGL_M, F_915);
                return (
                  <tr key={cls.id} className="border-b border-white/5 last:border-b-0">
                    <td className="px-1.5 py-0.5 font-mono">{cls.id}</td>
                    <td className="px-1.5 py-0.5">{cls.label}</td>
                    <td className="px-1.5 py-0.5 text-right font-mono tabular-nums">
                      {ahDb >= 1 ? `${ahDb.toFixed(0)} dB` : "—"}
                    </td>
                    <td className="px-1.5 py-0.5 text-right">{cls.penetrable ? "yes" : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-1.5 py-1 text-[9px] text-gray-500 border-t border-white/5 leading-snug">
            <span className="text-gray-400">@ 2 m</span> = ITU-R P.452-17 endpoint clutter at 2 m AGL, 915 MHz.
            Penetrable classes also accumulate ITU-R P.833-9 vegetation loss along the path.
          </div>
        </div>
      )}
    </div>
  );
}
