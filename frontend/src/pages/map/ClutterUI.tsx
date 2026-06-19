/** Shared clutter-UI bits used by MapCoveragePanel and MapScanPanel. */
import { useState } from "react";

import { endpointClutterDb, NLCD_CLASSES } from "./clutterClasses";
import { AGGRESSION_STOPS } from "./coverageAnalysis";
import { Segmented } from "./Segmented";

const F_915 = 915;
const LEGEND_REF_AGL_M = 2;

// CONUS-relevant rows only (AK-only classes + lichen/moss skipped); static.
const LEGEND_ROWS = Object.values(NLCD_CLASSES)
  .sort((a, b) => a.id - b.id)
  .filter((c) => ![51, 72, 73, 74].includes(c.id))
  .map((cls) => ({ cls, ahDb: endpointClutterDb(cls, LEGEND_REF_AGL_M, F_915) }));

export function AggressionSlider({
  aggressionIdx,
  onChange,
  enabled = true,
}: {
  aggressionIdx: number;
  onChange: (idx: number) => void;
  /** When false, buttons render dimmed and non-interactive. */
  enabled?: boolean;
}) {
  return (
    <Segmented
      ariaLabel="Clutter prediction aggression"
      value={aggressionIdx}
      onChange={onChange}
      disabled={!enabled}
      options={AGGRESSION_STOPS.map((stop, i) => ({
        value: i,
        label: stop.short,
        sub: `×${stop.value.toFixed(1)}`,
        title: stop.description,
      }))}
    />
  );
}

export interface ClutterStatusChipProps {
  /** Null until first compute. */
  status: { tilesPresent: number; tilesTotal: number } | null;
  /** When false, the chip overrides any tile state with "Clutter model: off". */
  enabled?: boolean;
}

export interface BuildingStatusChipProps {
  /** Null until first compute. */
  status: { tilesPresent: number; tilesTotal: number } | null;
  /** When false, the chip overrides any tile state with "Building heights: off". */
  enabled?: boolean;
}

export function BuildingStatusChip({ status, enabled = true }: BuildingStatusChipProps) {
  if (!enabled) {
    return (
      <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
        <span className="mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-gray-500/60" aria-hidden />
        <span>Building heights: <span className="text-gray-400">off</span> — bare-earth DEM + class-nominal h_a.</span>
      </div>
    );
  }
  const fallback = status != null && status.tilesTotal > 0 && status.tilesPresent === 0;
  const partial =
    status != null && status.tilesPresent > 0 && status.tilesPresent < status.tilesTotal;
  return (
    <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
      <span
        className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          fallback ? "bg-amber-400/80" : "bg-emerald-400/70"
        }`}
        aria-hidden
      />
      <span>
        <span className="sr-only">{fallback ? "fallback" : partial ? "partial coverage" : "OK"} — </span>
        {fallback ? (
          <>
            <span className="text-amber-300/90">Class-nominal buildings</span>
            <span className="text-gray-500"> — no building tiles for this region. Run the bake (see scripts/README-buildings.md).</span>
          </>
        ) : (
          <>
            Buildings: <span className="text-gray-300">JRC GHS-BUILT-H 100 m</span>
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

export interface CanopyStatusChipProps {
  /** Null until first compute. */
  status: { tilesPresent: number; tilesTotal: number } | null;
  /** When false, the chip overrides any tile state with "Canopy heights: off". */
  enabled?: boolean;
}

export function CanopyStatusChip({ status, enabled = true }: CanopyStatusChipProps) {
  if (!enabled) {
    return (
      <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
        <span className="mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-gray-500/60" aria-hidden />
        <span>Canopy heights: <span className="text-gray-400">off</span> — class-nominal heights only.</span>
      </div>
    );
  }
  const fallback = status != null && status.tilesTotal > 0 && status.tilesPresent === 0;
  const partial =
    status != null && status.tilesPresent > 0 && status.tilesPresent < status.tilesTotal;
  return (
    <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
      <span
        className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          fallback ? "bg-amber-400/80" : "bg-emerald-400/70"
        }`}
        aria-hidden
      />
      <span>
        <span className="sr-only">{fallback ? "fallback" : partial ? "partial coverage" : "OK"} — </span>
        {fallback ? (
          <>
            <span className="text-amber-300/90">Class-nominal canopy</span>
            <span className="text-gray-500"> — no canopy tiles for this region. Run the bake (see scripts/README-canopy.md).</span>
          </>
        ) : (
          <>
            Canopy: <span className="text-gray-300">ETH 10 m</span>
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

export function ClutterStatusChip({ status, enabled = true }: ClutterStatusChipProps) {
  if (!enabled) {
    return (
      <div className="flex items-start gap-1.5 text-[10px] leading-snug text-gray-500">
        <span className="mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-gray-500/60" aria-hidden />
        <span>Clutter model: <span className="text-gray-400">off</span> — ITM-only path loss.</span>
      </div>
    );
  }

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
        <span className="sr-only">{fallback ? "fallback" : partial ? "partial coverage" : "OK"} — </span>
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

export function ClassLegend() {
  const [open, setOpen] = useState(false);

  return (
    <div className="text-[10px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="clutter-class-legend"
        className="w-full flex items-center justify-between gap-1 px-1 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
      >
        <span>Show class legend</span>
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div id="clutter-class-legend" className="mt-1 max-h-48 overflow-y-auto rounded border border-white/5 bg-white/2">
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
              {LEGEND_ROWS.map(({ cls, ahDb }) => {
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
            Forest classes use ETH measured canopy heights, and developed classes use JRC
            measured building heights, when the respective bakes are available
            (heights shown above are class-nominal fallbacks).
          </div>
        </div>
      )}
    </div>
  );
}
