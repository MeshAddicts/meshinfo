import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { formatTimestamp } from "../../utils/formatTimestamp";
import {
  type NodesById,
  type RangeKey,
  type TelemetryEvent,
  type TelemetryNodeSummary,
  formatMetricValue,
  getNodeLabel,
  safeTsMs,
  toNumberLoose,
} from "./telemetryUtils";

import { MiniBarChart, downsamplePoints } from "./MiniCharts";

// ---------------------- clipboard helper ----------------------

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard && (window as any).isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  } catch {
    return false;
  }
}

// ---------------------- small UI bits ----------------------

function Card({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </div>
          {subtitle ? (
            <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function MetricChip({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="inline-flex items-center justify-between gap-2 rounded-md border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/30 px-2.5 py-1 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 tabular-nums">{value}</span>
    </div>
  );
}

function NodeInline({ id, label }: { id: string; label: string }) {
  return (
    <Link
      to={`/nodes/${id}`}
      className="text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
      title="Open node page"
    >
      {label}
    </Link>
  );
}

function Details({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-950/10 p-3"
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none select-none">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </div>
            {subtitle ? (
              <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>
            ) : null}
          </div>
          <div className="text-xs text-gray-500">toggle</div>
        </div>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

// ---------------------- metrics model ----------------------

type MetricKey =
  | "battery_level"
  | "voltage"
  | "channel_utilization"
  | "air_util_tx"
  | "temperature"
  | "relative_humidity"
  | "barometric_pressure"
  | "gas_resistance"
  | "uptime_seconds"
  | "rssi"
  | "snr";

type MetricDef = {
  key: MetricKey;
  label: string;
  hint?: string;
};

const METRICS: MetricDef[] = [
  { key: "battery_level", label: "Battery", hint: "battery_level" },
  { key: "voltage", label: "Voltage", hint: "voltage" },
  { key: "temperature", label: "Temperature", hint: "temperature" },
  { key: "relative_humidity", label: "Humidity", hint: "relative_humidity" },
  { key: "channel_utilization", label: "Channel util", hint: "channel_utilization" },
  { key: "air_util_tx", label: "Air util TX", hint: "air_util_tx" },
  { key: "barometric_pressure", label: "Pressure", hint: "barometric_pressure" },
  { key: "gas_resistance", label: "Gas resistance", hint: "gas_resistance" },
  { key: "uptime_seconds", label: "Uptime", hint: "uptime_seconds" },
  { key: "rssi", label: "RSSI", hint: "rssi" },
  { key: "snr", label: "SNR", hint: "snr" },
];

function metricLabel(key: MetricKey) {
  return METRICS.find((m) => m.key === key)?.label ?? key;
}

// Format via your existing helper when possible, otherwise fallback
function formatAnyMetricValue(key: MetricKey, v: any): string {
  if (v == null) return "—";

  // formatMetricValue is typed to a narrower union; cast is safe because we only call for known keys.
  const useFmt = (k: any) => formatMetricValue(k, v);

  switch (key) {
    case "battery_level":
    case "voltage":
    case "channel_utilization":
    case "air_util_tx":
    case "temperature":
    case "relative_humidity":
    case "barometric_pressure":
    case "gas_resistance":
    case "uptime_seconds":
    case "rssi":
    case "snr":
      return useFmt(key as any);
    default:
      return String(v);
  }
}

// ---------------------- data helpers ----------------------

type Point = { t: number; v: number };

function extractMetric(e: TelemetryEvent, key: MetricKey): number | null {
  if (key === "rssi") return toNumberLoose(e.rssi);
  if (key === "snr") return toNumberLoose(e.snr);
  return toNumberLoose((e.payload as any)?.[key]);
}

function buildPoints(events: TelemetryEvent[], key: MetricKey): Point[] {
  const pts: Point[] = [];
  for (const e of events) {
    const t = safeTsMs(e.timestamp);
    if (!t) continue;
    const v = extractMetric(e, key);
    if (v == null || !Number.isFinite(v)) continue;
    pts.push({ t, v });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

function bucketAverage(points: Point[], maxBuckets: number): Point[] {
  if (points.length <= maxBuckets) return points;
  const minT = points[0]?.t ?? 0;
  const maxT = points[points.length - 1]?.t ?? 0;
  if (!minT || !maxT || maxT <= minT) {
    const out: Point[] = [];
    const step = Math.ceil(points.length / maxBuckets);
    for (let i = 0; i < points.length; i += step) {
      const chunk = points.slice(i, i + step);
      const vt = chunk.reduce((a, p) => a + p.t, 0) / chunk.length;
      const vv = chunk.reduce((a, p) => a + p.v, 0) / chunk.length;
      out.push({ t: vt, v: vv });
    }
    return out;
  }

  const width = (maxT - minT) / maxBuckets;
  const buckets: Array<{ tSum: number; vSum: number; n: number }> = Array.from(
    { length: maxBuckets },
    () => ({ tSum: 0, vSum: 0, n: 0 }),
  );

  for (const p of points) {
    let i = Math.floor((p.t - minT) / width);
    if (i < 0) i = 0;
    if (i >= maxBuckets) i = maxBuckets - 1;
    buckets[i].tSum += p.t;
    buckets[i].vSum += p.v;
    buckets[i].n += 1;
  }

  const out: Point[] = [];
  for (const b of buckets) {
    if (b.n <= 0) continue;
    out.push({ t: b.tSum / b.n, v: b.vSum / b.n });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function stats(points: Point[]) {
  if (!points.length) return null;
  let min = points[0].v;
  let max = points[0].v;
  let sum = 0;
  for (const p of points) {
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
    sum += p.v;
  }
  return { min, max, avg: sum / points.length, last: points[points.length - 1].v };
}

function Sparkline({ points }: { points: Point[] }) {
  const w = 120;
  const h = 28;

  const path = useMemo(() => {
    if (!points.length) return "";
    const xs = points.map((p) => p.t);
    const ys = points.map((p) => p.v);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = Math.max(1, maxX - minX);
    const dy = Math.max(1e-9, maxY - minY);

    return points
      .map((p, i) => {
        const x = ((p.t - minX) / dx) * (w - 2) + 1;
        const y = h - (((p.v - minY) / dy) * (h - 2) + 1);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }, [points]);

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="text-indigo-600 dark:text-indigo-300"
      aria-hidden
    >
      <path
        d={path || ""}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={points.length ? 0.95 : 0.2}
      />
    </svg>
  );
}

function LineChart({
  points,
  unitLabel,
}: {
  points: Point[];
  unitLabel: string;
}) {
  const [hover, setHover] = useState<{ idx: number } | null>(null);

  const w = 820;
  const h = 260;
  const pad = 18;

  const { path, minY, maxY } = useMemo(() => {
    if (!points.length) return { path: "", minY: 0, maxY: 0 };

    const xs = points.map((p) => p.t);
    const ys = points.map((p) => p.v);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = Math.max(1, maxX - minX);
    const dy = Math.max(1e-9, maxY - minY);

    const toX = (t: number) => pad + ((t - minX) / dx) * (w - pad * 2);
    const toY = (v: number) => h - pad - ((v - minY) / dy) * (h - pad * 2);

    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.t).toFixed(2)} ${toY(p.v).toFixed(2)}`)
      .join(" ");

    return { path, minY, maxY };
  }, [points]);

  const hoverPoint = hover ? points[hover.idx] : null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-gray-500">{unitLabel}</div>
        {hoverPoint ? (
          <div className="text-xs text-gray-600 dark:text-gray-300 tabular-nums">
            {new Date(hoverPoint.t).toLocaleString()} • {hoverPoint.v.toFixed(3)}
          </div>
        ) : (
          <div className="text-xs text-gray-400 tabular-nums">
            {points.length ? `${minY.toFixed(2)} → ${maxY.toFixed(2)}` : "—"}
          </div>
        )}
      </div>

      <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 overflow-hidden">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="w-full h-[220px] sm:h-[260px]"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            if (!points.length) return;
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * w;

            // nearest-by-x (ok for <= ~120 points)
            let best = 0;
            let bestDx = Infinity;

            const minXT = points[0].t;
            const maxXT = points[points.length - 1].t;
            const dxT = Math.max(1, maxXT - minXT);

            for (let i = 0; i < points.length; i++) {
              const t = points[i].t;
              const px = pad + ((t - minXT) / dxT) * (w - pad * 2);
              const dx = Math.abs(px - x);
              if (dx < bestDx) {
                bestDx = dx;
                best = i;
              }
            }
            setHover({ idx: best });
          }}
        >
          {/* baseline */}
          <line
            x1={pad}
            y1={h - pad}
            x2={w - pad}
            y2={h - pad}
            stroke="currentColor"
            opacity="0.08"
          />

          {/* series */}
          <path
            d={path || ""}
            fill="none"
            stroke="currentColor"
            className="text-indigo-600 dark:text-indigo-300"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={points.length ? 0.95 : 0.2}
          />

          {hoverPoint ? (
            (() => {
              const minXT = points[0].t;
              const maxXT = points[points.length - 1].t;
              const minYV = Math.min(...points.map((p) => p.v));
              const maxYV = Math.max(...points.map((p) => p.v));
              const dx = Math.max(1, maxXT - minXT);
              const dy = Math.max(1e-9, maxYV - minYV);

              const hx = pad + ((hoverPoint.t - minXT) / dx) * (w - pad * 2);
              const hy = h - pad - ((hoverPoint.v - minYV) / dy) * (h - pad * 2);

              return (
                <>
                  <line x1={hx} y1={pad} x2={hx} y2={h - pad} stroke="currentColor" opacity="0.08" />
                  <circle
                    cx={hx}
                    cy={hy}
                    r={4.5}
                    fill="currentColor"
                    className="text-indigo-600 dark:text-indigo-300"
                  />
                </>
              );
            })()
          ) : null}

          {!points.length ? (
            <text x={w / 2} y={h / 2} textAnchor="middle" fill="currentColor" opacity="0.4">
              No data in this scope
            </text>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

function Histogram({ values, label }: { values: number[]; label: string }) {
  const bins = 10;

  const { min, max, counts } = useMemo(() => {
    if (!values.length) return { min: 0, max: 0, counts: Array(bins).fill(0) as number[] };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const counts = Array(bins).fill(0) as number[];

    if (max <= min) {
      counts[bins - 1] = values.length;
      return { min, max, counts };
    }

    for (const v of values) {
      let i = Math.floor(((v - min) / (max - min)) * bins);
      if (i < 0) i = 0;
      if (i >= bins) i = bins - 1;
      counts[i] += 1;
    }

    return { min, max, counts };
  }, [values]);

  const maxCount = Math.max(1, ...counts);

  return (
    <div className="w-full">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
        {!values.length ? (
          <div className="text-sm text-gray-500">No values to chart.</div>
        ) : (
          <>
            <div className="flex items-end gap-1 h-24">
              {counts.map((c, i) => (
                <div
                  key={`bin-${i}`}
                  className="flex-1 rounded-sm bg-indigo-600/70 dark:bg-indigo-400/40"
                  style={{ height: `${(c / maxCount) * 100}%` }}
                  title={`bin ${i + 1}: ${c}`}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-gray-500 tabular-nums">
              <span>{min.toFixed(2)}</span>
              <span>{max.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  title,
  subtitle,
  value,
  sparkPoints,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  value: string;
  sparkPoints: Point[];
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "text-left rounded-lg border p-3 transition w-full",
        "border-gray-200 dark:border-gray-800",
        active
          ? "bg-indigo-50/70 dark:bg-indigo-900/10 border-indigo-500/40"
          : "bg-white/60 dark:bg-gray-950/20 hover:bg-gray-50 dark:hover:bg-gray-900/30",
      ].join(" ")}
      title="Click to set as primary trend metric"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-500">{title}</div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
            {value}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">{subtitle}</div>
        </div>
        <div className="shrink-0 pt-1">
          <Sparkline points={sparkPoints} />
        </div>
      </div>
    </button>
  );
}

function bucketCounts(events: TelemetryEvent[], bucketMs: number) {
  const buckets = new Map<number, number>();
  for (const e of events) {
    const ts = safeTsMs(e.timestamp);
    if (!ts) continue;
    const b = Math.floor(ts / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  return keys.map((k) => ({ x: k, v: buckets.get(k) ?? 0 }));
}

// ---------------------- component ----------------------

export function TelemetryDetailsPanel({
  nodes,
  selectedKey,
  selectedNodeId,
  eventsAll,
  eventsSelected,
  nodeSummaries,
  range,
  onClearSelection,
  onQuickSearch,
}: {
  nodes: NodesById;
  selectedKey: string;
  selectedNodeId: string | null;
  eventsAll: TelemetryEvent[];
  eventsSelected: TelemetryEvent[];
  nodeSummaries: Record<string, TelemetryNodeSummary>;
  range: RangeKey;
  onClearSelection: () => void;
  onQuickSearch: (text: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string>("");
  const [metricKey, setMetricKey] = useState<MetricKey>("battery_level");

  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(""), 900);
    return () => clearTimeout(t);
  }, [copiedKey]);

  // Scope events = overview vs node
  const scopeEvents = selectedNodeId ? eventsSelected : eventsAll;

  const header = useMemo(() => {
    if (!selectedNodeId) {
      const last = eventsAll.length
        ? Math.max(...eventsAll.map((e) => safeTsMs(e.timestamp)))
        : 0;
      return {
        title: "Telemetry overview",
        subtitle: `Range: ${range} • ${eventsAll.length.toLocaleString()} samples`,
        right: null,
        lastTsMs: last,
      };
    }

    const label = getNodeLabel(nodes, selectedNodeId);
    const s = nodeSummaries[selectedNodeId];
    const last = s?.lastTsMs ?? 0;

    return {
      title: label,
      subtitle: `${selectedNodeId} • Range: ${range} • ${eventsSelected.length.toLocaleString()} samples`,
      right: (
        <button
          type="button"
          onClick={onClearSelection}
          className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
        >
          Overview
        </button>
      ),
      lastTsMs: last,
    };
  }, [selectedNodeId, nodes, nodeSummaries, eventsSelected.length, eventsAll, range, onClearSelection]);

  // Overview: activity buckets
  const activity = useMemo(() => {
    const bucketMs =
      range === "24h"
        ? 30 * 60 * 1000
        : range === "7d"
          ? 2 * 60 * 60 * 1000
          : 6 * 60 * 60 * 1000;
    return bucketCounts(eventsAll, bucketMs);
  }, [eventsAll, range]);

  // Latest event in scope
  const lastEvent = useMemo(() => {
    if (!scopeEvents.length) return null;
    let best = scopeEvents[0];
    let bestTs = safeTsMs(best.timestamp);
    for (const e of scopeEvents) {
      const ts = safeTsMs(e.timestamp);
      if (ts >= bestTs) {
        best = e;
        bestTs = ts;
      }
    }
    return best;
  }, [scopeEvents]);

  // Node view: current snapshot
  const nodeCurrent = useMemo(() => {
    if (!selectedNodeId) return null;
    return (nodes[selectedNodeId] as any)?.telemetry ?? null;
  }, [nodes, selectedNodeId]);

  // Snapshot-per-node values (overview) for a metric:
  // prefer node_telemetry_current; fallback to latest packet payload from nodeSummaries
  const snapshotValuesForMetric = useMemo(() => {
    if (selectedNodeId) {
      // node-only distribution isn’t useful; return empty
      return [] as number[];
    }

    const vals: number[] = [];
    for (const [id, n] of Object.entries(nodes)) {
      const cur = (n as any)?.telemetry ?? null;

      let v: number | null = null;

      if (metricKey === "rssi") {
        v = toNumberLoose(nodeSummaries[id]?.latest?.rssi);
      } else if (metricKey === "snr") {
        v = toNumberLoose(nodeSummaries[id]?.latest?.snr);
      } else {
        v =
          toNumberLoose(cur?.[metricKey]) ??
          toNumberLoose(nodeSummaries[id]?.latest?.payload?.[metricKey]);
      }

      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    return vals;
  }, [nodes, nodeSummaries, metricKey, selectedNodeId]);

  // Health counts (keep your current battery snapshot summary)
  const batterySnapshot = useMemo(() => {
    const rows: Array<{ nodeId: string; label: string; battery: number }> = [];

    for (const [id, n] of Object.entries(nodes)) {
      const cur = (n as any)?.telemetry ?? null;
      const b =
        toNumberLoose(cur?.battery_level) ??
        toNumberLoose(nodeSummaries[id]?.latest?.payload?.battery_level);
      if (b == null) continue;
      rows.push({ nodeId: id, label: getNodeLabel(nodes, id), battery: b });
    }

    rows.sort((a, b) => a.battery - b.battery);
    return rows;
  }, [nodes, nodeSummaries]);

  const healthCounts = useMemo(() => {
    const total = Object.keys(nodes).length;
    const withBattery = batterySnapshot.length;
    const low = batterySnapshot.filter((r) => r.battery < 20).length;
    const mid = batterySnapshot.filter((r) => r.battery >= 20 && r.battery < 50).length;
    const good = batterySnapshot.filter((r) => r.battery >= 50).length;
    return { total, withBattery, low, mid, good };
  }, [nodes, batterySnapshot]);

  // Summary cards (clickable metric switch)
  const summaryMetricKeys = useMemo(
    () =>
      [
        "battery_level",
        "voltage",
        "temperature",
        "relative_humidity",
        "channel_utilization",
        "air_util_tx",
      ] as MetricKey[],
    [],
  );

  const summaryCards = useMemo(() => {
    const cards = summaryMetricKeys.map((k) => {
      const ptsRaw = buildPoints(scopeEvents, k);
      const pts = bucketAverage(ptsRaw, 60);

      // value shown:
      // - node selected: current snapshot OR lastEvent value
      // - overview: average of snapshot-per-node values (based on node_telemetry_current + fallback)
      let shown = "—";
      let subtitle = "No data";

      if (selectedNodeId) {
        const cur = nodeCurrent ?? {};
        const v =
          k === "rssi"
            ? toNumberLoose(lastEvent?.rssi)
            : k === "snr"
              ? toNumberLoose(lastEvent?.snr)
              : toNumberLoose((cur as any)?.[k]) ??
                toNumberLoose((lastEvent?.payload as any)?.[k]);

        shown = formatAnyMetricValue(k, v);
        subtitle = v == null ? "No data in scope" : "Latest value";
      } else {
        // overview: snapshot avg
        const vals: number[] = [];
        for (const [id, n] of Object.entries(nodes)) {
          const cur = (n as any)?.telemetry ?? null;

          let v: number | null = null;
          if (k === "rssi") v = toNumberLoose(nodeSummaries[id]?.latest?.rssi);
          else if (k === "snr") v = toNumberLoose(nodeSummaries[id]?.latest?.snr);
          else
            v =
              toNumberLoose(cur?.[k]) ??
              toNumberLoose(nodeSummaries[id]?.latest?.payload?.[k]);

          if (v != null && Number.isFinite(v)) vals.push(v);
        }

        if (vals.length) {
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          shown = formatAnyMetricValue(k, avg);
          subtitle = `${vals.length} nodes snapshot (avg)`;
        }
      }

      return {
        key: k,
        title: metricLabel(k),
        subtitle,
        value: shown,
        spark: pts,
      };
    });

    return cards;
  }, [
    summaryMetricKeys,
    scopeEvents,
    selectedNodeId,
    nodeCurrent,
    lastEvent,
    nodes,
    nodeSummaries,
  ]);

  // Primary metric trend
  const primaryPointsRaw = useMemo(() => buildPoints(scopeEvents, metricKey), [scopeEvents, metricKey]);
  const primaryPoints = useMemo(() => bucketAverage(primaryPointsRaw, 120), [primaryPointsRaw]);
  const primaryStats = useMemo(() => stats(primaryPointsRaw), [primaryPointsRaw]);

  // Node payload keys / channel breakdown (from most recent event)
  const payloadKeys = useMemo(() => {
    if (!lastEvent) return [];
    return Object.keys(lastEvent.payload ?? {}).sort();
  }, [lastEvent]);

  const channelBreakdown = useMemo(() => {
    if (!lastEvent) return null;
    const p = lastEvent.payload ?? {};

    const voltageCh = ["voltage_ch1", "voltage_ch2", "voltage_ch3"]
      .map((k) => ({ k, v: toNumberLoose((p as any)[k]) }))
      .filter((x) => typeof x.v === "number");

    const currentCh = ["current_ch1", "current_ch2", "current_ch3"]
      .map((k) => ({ k, v: toNumberLoose((p as any)[k]) }))
      .filter((x) => typeof x.v === "number");

    if (!voltageCh.length && !currentCh.length) return null;
    return { voltageCh, currentCh };
  }, [lastEvent]);

  // Recent samples (keep, but we’ll tuck it under a collapse)
  const recentSamples = useMemo(() => {
    const arr = [...(selectedNodeId ? eventsSelected : scopeEvents)];
    arr.sort((a, b) => safeTsMs(b.timestamp) - safeTsMs(a.timestamp));
    return arr.slice(0, selectedNodeId ? 25 : 12);
  }, [eventsSelected, scopeEvents, selectedNodeId]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-500">Details</div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {header.title}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              {header.subtitle}
            </div>

            {lastEvent ? (
              <div className="text-[11px] text-gray-500 mt-1 tabular-nums">
                Latest: {formatTimestamp(lastEvent.timestamp) || "Unknown"} •{" "}
                {safeTsMs(lastEvent.timestamp)
                  ? new Date(safeTsMs(lastEvent.timestamp)).toISOString()
                  : "—"}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {selectedNodeId ? (
              <>
                <button
                  type="button"
                  onClick={() => onQuickSearch(getNodeLabel(nodes, selectedNodeId))}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Search for this node"
                >
                  Search
                </button>

                <Link
                  to={`/nodes/${(nodes[selectedNodeId]?.id as any) ?? selectedNodeId}`}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Open node page"
                >
                  Open node
                </Link>
              </>
            ) : null}

            {header.right}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!scopeEvents.length ? (
          <div className="text-sm text-gray-500">
            No telemetry samples in this scope. Try widening the range or clearing search filters.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Overview-only: Activity + Health + Lowest batteries */}
            {!selectedNodeId ? (
              <>
                <Card
                  title="Activity"
                  subtitle={`Packets over time • last sample: ${
                    header.lastTsMs ? formatTimestamp(header.lastTsMs) : "—"
                  }`}
                  right={
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await copyTextToClipboard(
                          JSON.stringify({ range, count: eventsAll.length }, null, 2),
                        );
                        if (ok) setCopiedKey("overview");
                      }}
                      className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      title="Copy a tiny overview JSON"
                    >
                      {copiedKey === "overview" ? "Copied!" : "Copy"}
                    </button>
                  }
                >
                  <MiniBarChart values={activity} />
                  <div className="mt-2 text-xs text-gray-500">
                    Buckets adapt to range (denser buckets for 24h).
                  </div>
                </Card>

                <Card
                  title="Health snapshot"
                  subtitle="Current battery levels (from node_telemetry_current where available)"
                >
                  <div className="flex flex-wrap gap-2">
                    <MetricChip label="Nodes" value={healthCounts.total.toLocaleString()} />
                    <MetricChip label="Battery reported" value={healthCounts.withBattery.toLocaleString()} />
                    <MetricChip label="Low (<20%)" value={healthCounts.low.toLocaleString()} />
                    <MetricChip label="Mid (20–50%)" value={healthCounts.mid.toLocaleString()} />
                    <MetricChip label="Good (≥50%)" value={healthCounts.good.toLocaleString()} />
                  </div>

                  <div className="mt-3 text-xs text-gray-500">
                    Tip: click a metric card below to set the primary trend/histogram metric.
                  </div>
                </Card>
              </>
            ) : null}

            {/* Summary cards (both modes) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {summaryCards.map((c) => (
                <MetricCard
                  key={c.key}
                  title={c.title}
                  subtitle={c.subtitle}
                  value={c.value}
                  sparkPoints={c.spark}
                  active={metricKey === c.key}
                  onClick={() => setMetricKey(c.key)}
                />
              ))}
            </div>

            {/* Primary Trend (both modes) */}
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Trend
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {selectedNodeId
                      ? "Node-only time series"
                      : "Scope time series (based on samples in range/search)"}{" "}
                    • Primary metric drives the histogram (overview) and stats.
                  </div>
                </div>

                <select
                  value={metricKey}
                  onChange={(e) => setMetricKey(e.target.value as MetricKey)}
                  className="rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                  title="Primary chart metric"
                >
                  {METRICS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-3">
                <LineChart points={primaryPoints} unitLabel={metricLabel(metricKey)} />
              </div>

              {primaryStats ? (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-2">
                    <div className="text-gray-500">Last</div>
                    <div className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums">
                      {formatAnyMetricValue(metricKey, primaryStats.last)}
                    </div>
                  </div>
                  <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-2">
                    <div className="text-gray-500">Avg</div>
                    <div className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums">
                      {formatAnyMetricValue(metricKey, primaryStats.avg)}
                    </div>
                  </div>
                  <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-2">
                    <div className="text-gray-500">Min</div>
                    <div className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums">
                      {formatAnyMetricValue(metricKey, primaryStats.min)}
                    </div>
                  </div>
                  <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-2">
                    <div className="text-gray-500">Max</div>
                    <div className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums">
                      {formatAnyMetricValue(metricKey, primaryStats.max)}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Overview-only: Lowest batteries (moved below Trend) */}
            {!selectedNodeId ? (
              <Card
                title="Lowest batteries"
                subtitle="Quick triage list (current snapshot → latest event fallback)"
              >
                <div className="flex flex-col gap-2">
                  {batterySnapshot.slice(0, 18).map((r) => (
                    <div
                      key={`bat-${r.nodeId}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 truncate">
                        <NodeInline id={r.nodeId} label={r.label} />{" "}
                        <span className="text-[11px] text-gray-400">{r.nodeId}</span>
                      </div>
                      <div className="tabular-nums text-gray-900 dark:text-gray-100">
                        {formatMetricValue("battery_level" as any, r.battery)}
                      </div>
                    </div>
                  ))}
                  {batterySnapshot.length === 0 ? (
                    <div className="text-sm text-gray-500">No battery telemetry found.</div>
                  ) : null}
                </div>
              </Card>
            ) : null}

            {/* Overview-only: Distribution */}
            {!selectedNodeId ? (
              <Histogram
                values={snapshotValuesForMetric}
                label={`Distribution (latest-per-node snapshot) • ${snapshotValuesForMetric.length} nodes with values • metric: ${metricLabel(metricKey)}`}
              />
            ) : null}

            {/* Node-only: Current snapshot (keep your nice chips, plus copy/link actions) */}
            {selectedNodeId ? (
              <Card
                title="Current snapshot"
                subtitle="From node_telemetry_current (falls back to latest packet if missing)"
                right={
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const payload = nodeCurrent ?? lastEvent?.payload ?? {};
                        const ok = await copyTextToClipboard(JSON.stringify(payload, null, 2));
                        if (ok) setCopiedKey("snapshot");
                      }}
                      className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      title="Copy snapshot JSON"
                    >
                      {copiedKey === "snapshot" ? "Copied!" : "Copy JSON"}
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        const url = window.location.href;
                        const ok = await copyTextToClipboard(url);
                        if (ok) setCopiedKey("link");
                        else window.prompt("Copy link:", url);
                      }}
                      className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      title="Copy shareable URL"
                    >
                      {copiedKey === "link" ? "Copied!" : "Copy link"}
                    </button>
                  </div>
                }
              >
                <div className="flex flex-wrap gap-2">
                  <MetricChip
                    label="Battery"
                    value={formatAnyMetricValue(
                      "battery_level",
                      toNumberLoose(nodeCurrent?.battery_level) ??
                        toNumberLoose((lastEvent?.payload as any)?.battery_level),
                    )}
                  />
                  <MetricChip
                    label="Voltage"
                    value={formatAnyMetricValue(
                      "voltage",
                      toNumberLoose(nodeCurrent?.voltage) ??
                        toNumberLoose((lastEvent?.payload as any)?.voltage),
                    )}
                  />
                  <MetricChip
                    label="Channel util"
                    value={formatAnyMetricValue(
                      "channel_utilization",
                      toNumberLoose(nodeCurrent?.channel_utilization) ??
                        toNumberLoose((lastEvent?.payload as any)?.channel_utilization),
                    )}
                  />
                  <MetricChip
                    label="Air util TX"
                    value={formatAnyMetricValue(
                      "air_util_tx",
                      toNumberLoose(nodeCurrent?.air_util_tx) ??
                        toNumberLoose((lastEvent?.payload as any)?.air_util_tx),
                    )}
                  />
                  <MetricChip
                    label="Temp"
                    value={formatAnyMetricValue(
                      "temperature",
                      toNumberLoose(nodeCurrent?.temperature) ??
                        toNumberLoose((lastEvent?.payload as any)?.temperature),
                    )}
                  />
                  <MetricChip
                    label="Humidity"
                    value={formatAnyMetricValue(
                      "relative_humidity",
                      toNumberLoose(nodeCurrent?.relative_humidity) ??
                        toNumberLoose((lastEvent?.payload as any)?.relative_humidity),
                    )}
                  />
                  <MetricChip label="RSSI" value={formatAnyMetricValue("rssi", lastEvent?.rssi)} />
                  <MetricChip label="SNR" value={formatAnyMetricValue("snr", lastEvent?.snr)} />
                </div>
              </Card>
            ) : null}

            {/* Advanced: payload + channels (node), plus extra charts + recent samples (both, but tuned) */}
            <Details
              title="Debug & details"
              subtitle={selectedNodeId ? "Payload fields, channel breakdown, and a compact sample list." : "Compact sample list + copy helpers."}
              defaultOpen={false}
            >
              <div className="flex flex-col gap-4">
                {selectedNodeId ? (
                  <Card
                    title="Latest payload"
                    subtitle={`Fields: ${payloadKeys.length} • from most recent sample in scope`}
                    right={
                      lastEvent ? (
                        <button
                          type="button"
                          onClick={async () => {
                            const text = JSON.stringify(lastEvent.payload ?? {}, null, 2);
                            const ok = await copyTextToClipboard(text);
                            if (ok) setCopiedKey("payload");
                          }}
                          className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                          title="Copy latest payload JSON"
                        >
                          {copiedKey === "payload" ? "Copied!" : "Copy payload"}
                        </button>
                      ) : null
                    }
                  >
                    {lastEvent ? (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          {[
                            "battery_level",
                            "voltage",
                            "temperature",
                            "relative_humidity",
                            "barometric_pressure",
                            "channel_utilization",
                            "air_util_tx",
                            "gas_resistance",
                            "uptime_seconds",
                          ]
                            .filter((k) => (lastEvent.payload ?? {})[k] != null)
                            .slice(0, 10)
                            .map((k) => (
                              <div
                                key={`kv-${k}`}
                                className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-2 flex items-center justify-between gap-2"
                              >
                                <span className="text-gray-500">{k}</span>
                                <span className="text-gray-900 dark:text-gray-100 tabular-nums">
                                  {String((lastEvent.payload ?? {})[k])}
                                </span>
                              </div>
                            ))}
                        </div>

                        {channelBreakdown ? (
                          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {channelBreakdown.voltageCh.length ? (
                              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
                                <div className="text-xs text-gray-500">Voltage channels</div>
                                <div className="mt-2 flex flex-col gap-1 text-sm tabular-nums">
                                  {channelBreakdown.voltageCh.map((x) => (
                                    <div key={x.k} className="flex items-center justify-between">
                                      <span className="text-gray-500">{x.k}</span>
                                      <span className="text-gray-900 dark:text-gray-100">
                                        {x.v!.toFixed(2)} V
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {channelBreakdown.currentCh.length ? (
                              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
                                <div className="text-xs text-gray-500">Current channels</div>
                                <div className="mt-2 flex flex-col gap-1 text-sm tabular-nums">
                                  {channelBreakdown.currentCh.map((x) => (
                                    <div key={x.k} className="flex items-center justify-between">
                                      <span className="text-gray-500">{x.k}</span>
                                      <span className="text-gray-900 dark:text-gray-100">
                                        {x.v!.toFixed(2)} mA
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="mt-3 text-xs text-gray-500">
                            No channel breakdown fields detected (voltage_ch1/current_ch1, etc).
                          </div>
                        )}

                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs text-gray-500">
                            Show full payload JSON
                          </summary>
                          <pre className="mt-2 text-xs rounded-md border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3 overflow-auto whitespace-pre-wrap">
                            {JSON.stringify(lastEvent.payload ?? {}, null, 2)}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <div className="text-sm text-gray-500">No payload available.</div>
                    )}
                  </Card>
                ) : null}

                <Card
                  title="Recent samples"
                  subtitle={selectedNodeId ? "Newest first (node)" : "Newest first (scope)"}
                  right={
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await copyTextToClipboard(JSON.stringify(recentSamples, null, 2));
                        if (ok) setCopiedKey("recent");
                      }}
                      className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      title="Copy recent samples JSON"
                    >
                      {copiedKey === "recent" ? "Copied!" : "Copy"}
                    </button>
                  }
                >
                  <div className="flex flex-col gap-2">
                    {recentSamples.map((e) => {
                      const ts = safeTsMs(e.timestamp);
                      const b = (e.payload as any)?.battery_level;
                      const v = (e.payload as any)?.voltage;
                      const cu = (e.payload as any)?.channel_utilization;

                      return (
                        <div
                          key={`s-${(e as any).__idx ?? ts}`}
                          className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-900/10 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-xs text-gray-700 dark:text-gray-200">
                              {ts ? formatTimestamp(ts) : "Unknown"}
                            </div>
                            <div className="text-[11px] text-gray-500 tabular-nums">
                              rssi={e.rssi ?? "—"} snr={e.snr ?? "—"}
                            </div>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <span className="text-gray-500">Battery:</span>
                            <span className="text-gray-900 dark:text-gray-100 tabular-nums">
                              {formatAnyMetricValue("battery_level", b)}
                            </span>
                            <span className="text-gray-300 dark:text-gray-700">•</span>
                            <span className="text-gray-500">Voltage:</span>
                            <span className="text-gray-900 dark:text-gray-100 tabular-nums">
                              {formatAnyMetricValue("voltage", v)}
                            </span>
                            <span className="text-gray-300 dark:text-gray-700">•</span>
                            <span className="text-gray-500">Ch util:</span>
                            <span className="text-gray-900 dark:text-gray-100 tabular-nums">
                              {formatAnyMetricValue("channel_utilization", cu)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {recentSamples.length === 0 ? (
                      <div className="text-sm text-gray-500">No samples in scope.</div>
                    ) : null}
                  </div>
                </Card>
              </div>
            </Details>
          </div>
        )}
      </div>
    </div>
  );
}
