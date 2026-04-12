import { useMemo, useState } from "react";
import type { LoSResult } from "./losAnalysis";

const WIDTH = 900;
const HEIGHT = 130;
const MARGIN = { top: 8, right: 12, bottom: 20, left: 36 };

/**
 * Render a cross-sectional elevation profile of a radio link path.
 * Shows terrain, LoS chord, Fresnel zone, and any obstructions.
 */
export function ElevationProfile({
  result,
  fromLabel,
  toLabel,
  fromColor = "#22c55e",
  toColor = "#ef4444",
}: {
  result: LoSResult;
  fromLabel: string;
  toLabel: string;
  fromColor?: string;
  toColor?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // Compute scales from points + terrain + Fresnel extent
  const { xScale, yScale, yTicks } = useMemo(() => {
    const pts = result.points;
    if (pts.length === 0) {
      return {
        xScale: (_x: number) => 0,
        yScale: (_y: number) => 0,
        yTicks: [] as number[],
      };
    }

    // Y range: terrain min → max of (chord + fresnel radius)
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minY = Math.min(minY, p.ground);
      maxY = Math.max(maxY, p.chord + p.fresnelRadius, p.ground);
    }
    maxY = Math.max(maxY, result.fromHeightM, result.toHeightM);
    minY = Math.min(minY, result.fromHeightM, result.toHeightM);
    const range = maxY - minY;
    const pad = Math.max(10, range * 0.08);
    const paddedMin = minY - pad * 0.3;
    const paddedMax = maxY + pad;

    const xs = (x: number) => (x / result.totalDistanceKm) * plotW;
    const ys = (y: number) => plotH - ((y - paddedMin) / (paddedMax - paddedMin)) * plotH;

    const tickCount = 4;
    const step = (paddedMax - paddedMin) / tickCount;
    const ticks: number[] = [];
    for (let i = 0; i <= tickCount; i++) ticks.push(paddedMin + step * i);

    return { xScale: xs, yScale: ys, yTicks: ticks };
  }, [result, plotW, plotH]);

  if (result.points.length === 0) return null;

  // Terrain path — filled polygon from bottom of chart up to terrain
  const terrainPath =
    `M ${xScale(0)},${plotH} ` +
    result.points
      .map((p) => `L ${xScale(p.distanceKm)},${yScale(p.ground)}`)
      .join(" ") +
    ` L ${xScale(result.totalDistanceKm)},${plotH} Z`;

  // Fresnel zone — polygon around chord
  const fresnelUpper = result.points
    .map((p) => `${xScale(p.distanceKm)},${yScale(p.chord + p.fresnelRadius)}`)
    .join(" L ");
  const fresnelLower = [...result.points]
    .reverse()
    .map((p) => `${xScale(p.distanceKm)},${yScale(p.chord - p.fresnelRadius)}`)
    .join(" L ");
  const fresnelPath = `M ${fresnelUpper} L ${fresnelLower} Z`;

  // 60% Fresnel (the "usable" threshold)
  const fresnel60Upper = result.points
    .map((p) => `${xScale(p.distanceKm)},${yScale(p.chord + p.fresnelRadius * 0.6)}`)
    .join(" L ");
  const fresnel60Lower = [...result.points]
    .reverse()
    .map((p) => `${xScale(p.distanceKm)},${yScale(p.chord - p.fresnelRadius * 0.6)}`)
    .join(" L ");
  const fresnel60Path = `M ${fresnel60Upper} L ${fresnel60Lower} Z`;

  // Chord line
  const chordPath =
    `M ${xScale(0)},${yScale(result.fromHeightM)} ` +
    `L ${xScale(result.totalDistanceKm)},${yScale(result.toHeightM)}`;

  const losColor = result.losClear
    ? (result.fresnelClear ? "#22c55e" : "#eab308")
    : "#ef4444";

  const hoverPoint = hoverIdx != null ? result.points[hoverIdx] : null;

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - MARGIN.left;
    if (x < 0 || x > plotW) {
      setHoverIdx(null);
      return;
    }
    const distKm = (x / plotW) * result.totalDistanceKm;
    // Find nearest point
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < result.points.length; i++) {
      const diff = Math.abs(result.points[i].distanceKm - distKm);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    setHoverIdx(bestIdx);
  };

  return (
    <div className="relative">
      <svg
        width="100%"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="terrainGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#78716c" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#44403c" stopOpacity="1" />
          </linearGradient>
        </defs>

        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Y axis ticks */}
          {yTicks.map((tick, i) => (
            <g key={i} transform={`translate(0, ${yScale(tick)})`}>
              <line
                x1={0}
                x2={plotW}
                y1={0}
                y2={0}
                stroke="rgba(255,255,255,0.05)"
                strokeDasharray="2 3"
              />
              <text
                x={-4}
                y={3}
                textAnchor="end"
                fontSize={8}
                fill="rgba(156,163,175,0.8)"
                fontFamily="monospace"
              >
                {Math.round(tick)}m
              </text>
            </g>
          ))}

          {/* X axis ticks (distance) */}
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
            <text
              key={i}
              x={xScale(result.totalDistanceKm * t)}
              y={plotH + 12}
              textAnchor="middle"
              fontSize={8}
              fill="rgba(156,163,175,0.8)"
              fontFamily="monospace"
            >
              {(result.totalDistanceKm * t).toFixed(1)}km
            </text>
          ))}

          {/* Full Fresnel zone (translucent) */}
          <path d={fresnelPath} fill="rgba(250,204,21,0.08)" />

          {/* 60% Fresnel zone (more opaque — the "usable" threshold) */}
          <path
            d={fresnel60Path}
            fill={result.fresnelClear ? "rgba(34,197,94,0.12)" : "rgba(250,204,21,0.22)"}
            stroke={result.fresnelClear ? "rgba(34,197,94,0.35)" : "rgba(250,204,21,0.5)"}
            strokeWidth={0.5}
            strokeDasharray="2 2"
          />

          {/* Terrain fill */}
          <path d={terrainPath} fill="url(#terrainGradient)" />

          {/* LoS chord line */}
          <path
            d={chordPath}
            stroke={losColor}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />

          {/* Endpoints */}
          <circle
            cx={xScale(0)}
            cy={yScale(result.fromHeightM)}
            r={4}
            fill={fromColor}
            stroke="white"
            strokeWidth={1.5}
          />
          <text
            x={xScale(0) + 6}
            y={yScale(result.fromHeightM) - 6}
            fontSize={9}
            fill={fromColor}
            fontFamily="monospace"
            style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.7)", strokeWidth: 2 }}
          >
            {fromLabel.slice(0, 10)}
          </text>
          <circle
            cx={xScale(result.totalDistanceKm)}
            cy={yScale(result.toHeightM)}
            r={4}
            fill={toColor}
            stroke="white"
            strokeWidth={1.5}
          />
          <text
            x={xScale(result.totalDistanceKm) - 6}
            y={yScale(result.toHeightM) - 6}
            textAnchor="end"
            fontSize={9}
            fill={toColor}
            fontFamily="monospace"
            style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.7)", strokeWidth: 2 }}
          >
            {toLabel.slice(0, 10)}
          </text>

          {/* Worst obstruction marker */}
          {(!result.losClear || !result.fresnelClear) && result.worstObstructionDistKm > 0 && (
            <g transform={`translate(${xScale(result.worstObstructionDistKm)}, 0)`}>
              <line
                y1={0}
                y2={plotH}
                stroke={result.losClear ? "#eab308" : "#ef4444"}
                strokeWidth={1}
                strokeDasharray="3 2"
                strokeOpacity={0.6}
              />
            </g>
          )}

          {/* Hover indicator */}
          {hoverPoint && (
            <g transform={`translate(${xScale(hoverPoint.distanceKm)}, 0)`}>
              <line
                y1={0}
                y2={plotH}
                stroke="rgba(255,255,255,0.3)"
                strokeWidth={1}
              />
              <circle
                cy={yScale(hoverPoint.ground)}
                r={2.5}
                fill="#fbbf24"
                stroke="white"
                strokeWidth={1}
              />
              <circle
                cy={yScale(hoverPoint.chord)}
                r={2.5}
                fill={losColor}
                stroke="white"
                strokeWidth={1}
              />
            </g>
          )}
        </g>
      </svg>

      {/* Hover tooltip */}
      {hoverPoint && (
        <div
          className="absolute pointer-events-none bg-gray-900/95 backdrop-blur-xl border border-white/10 rounded-lg px-2 py-1.5 text-[10px] shadow-2xl"
          style={{
            left: Math.min(
              Math.max((hoverPoint.distanceKm / result.totalDistanceKm) * 100, 12),
              88,
            ) + "%",
            top: 4,
            transform: "translateX(-50%)",
            minWidth: 100,
          }}
        >
          <div className="text-gray-400 mb-0.5">{hoverPoint.distanceKm.toFixed(2)} km</div>
          <div className="flex justify-between gap-3">
            <span className="text-gray-500">Ground:</span>
            <span className="text-amber-300 font-mono">{Math.round(hoverPoint.ground)}m</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-gray-500">LoS:</span>
            <span className="text-gray-200 font-mono">{Math.round(hoverPoint.chord)}m</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-gray-500">Clearance:</span>
            <span
              className={`font-mono ${
                hoverPoint.blocked
                  ? "text-red-400"
                  : hoverPoint.fresnelIntruded
                  ? "text-yellow-400"
                  : "text-emerald-400"
              }`}
            >
              {hoverPoint.clearance >= 0 ? "+" : ""}
              {Math.round(hoverPoint.clearance)}m
            </span>
          </div>
          {hoverPoint.fresnelRadius > 0 && (
            <div className="flex justify-between gap-3">
              <span className="text-gray-500">Fresnel:</span>
              <span className="text-gray-400 font-mono">
                ±{Math.round(hoverPoint.fresnelRadius)}m
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

