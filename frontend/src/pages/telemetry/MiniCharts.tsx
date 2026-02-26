import { useMemo } from "react";

type Point = { x: number; y: number | null };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function downsamplePoints(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  // ensure last
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

export function MiniLineChart({
  points,
  height = 96,
}: {
  points: Point[];
  height?: number;
}) {
  const { path, hasData } = useMemo(() => {
    const clean = points.filter((p) => p.y != null) as Array<{ x: number; y: number }>;
    if (clean.length < 2) return { path: "", hasData: clean.length > 0 };

    const xs = clean.map((p) => p.x);
    const ys = clean.map((p) => p.y);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const w = 300;
    const h = height;

    const xSpan = Math.max(1, maxX - minX);
    const ySpan = Math.max(1e-9, maxY - minY);

    const toX = (x: number) => ((x - minX) / xSpan) * w;
    const toY = (y: number) => h - ((y - minY) / ySpan) * h;

    const d = clean
      .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.x).toFixed(2)} ${toY(p.y).toFixed(2)}`)
      .join(" ");

    return { path: d, hasData: true };
  }, [points, height]);

  if (!hasData) {
    return (
      <div className="h-[96px] flex items-center justify-center text-xs text-gray-500">
        No data
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 300 ${height}`}
      preserveAspectRatio="none"
      className="w-full h-[96px]"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-indigo-600 dark:text-indigo-300"
      />
    </svg>
  );
}

export function MiniBarChart({
  values,
  height = 96,
}: {
  values: Array<{ x: number; v: number }>;
  height?: number;
}) {
  const maxV = Math.max(1, ...values.map((b) => b.v));
  const w = 300;
  const h = height;
  const gap = 2;
  const bw = values.length > 0 ? (w - gap * (values.length - 1)) / values.length : w;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="w-full h-[96px]"
    >
      {values.map((b, i) => {
        const barH = clamp((b.v / maxV) * h, 0, h);
        const x = i * (bw + gap);
        const y = h - barH;
        return (
          <rect
            key={`b-${b.x}-${i}`}
            x={x}
            y={y}
            width={bw}
            height={barH}
            className="fill-indigo-600/70 dark:fill-indigo-300/60"
          >
            <title>{b.v}</title>
          </rect>
        );
      })}
    </svg>
  );
}
