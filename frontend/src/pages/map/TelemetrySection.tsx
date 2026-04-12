import { useMemo } from "react";

import { useGetNodeTelemetryQuery } from "../../slices/apiSlice";
import { Sparkline } from "./Sparkline";

const METRICS: {
  key: string;
  label: string;
  unit: string;
  color: string;
  format: (v: number) => string;
}[] = [
  { key: "battery_level", label: "Battery", unit: "%", color: "#22c55e", format: (v) => `${Math.round(v)}%` },
  { key: "voltage", label: "Voltage", unit: "V", color: "#fbbf24", format: (v) => `${v.toFixed(2)}V` },
  { key: "channel_utilization", label: "Ch Util", unit: "%", color: "#60a5fa", format: (v) => `${v.toFixed(1)}%` },
  { key: "air_util_tx", label: "Air Util TX", unit: "%", color: "#a78bfa", format: (v) => `${v.toFixed(2)}%` },
  { key: "temperature", label: "Temp", unit: "°C", color: "#f97316", format: (v) => `${v.toFixed(1)}°C` },
  { key: "relative_humidity", label: "Humidity", unit: "%", color: "#06b6d4", format: (v) => `${v.toFixed(0)}%` },
  { key: "barometric_pressure", label: "Pressure", unit: "hPa", color: "#94a3b8", format: (v) => `${v.toFixed(0)} hPa` },
];

const MAX_POINTS = 50;

export function TelemetrySection({ nodeId }: { nodeId: string }) {
  const { data: telemetry, isLoading, error } = useGetNodeTelemetryQuery(nodeId);

  const seriesByMetric = useMemo(() => {
    if (!telemetry?.length) return {};
    // Sort ascending by timestamp, so sparklines read left→right chronologically
    const sorted = [...telemetry].sort((a, b) => a.timestamp - b.timestamp);

    const series: Record<string, { values: number[]; latest: number }> = {};
    for (const entry of sorted) {
      const payload = entry.payload ?? {};
      for (const metric of METRICS) {
        const v = payload[metric.key];
        if (typeof v === "number" && Number.isFinite(v)) {
          if (!series[metric.key]) series[metric.key] = { values: [], latest: v };
          series[metric.key].values.push(v);
          series[metric.key].latest = v;
        }
      }
    }
    // Cap each series to MAX_POINTS (most recent)
    for (const k of Object.keys(series)) {
      const s = series[k];
      if (s.values.length > MAX_POINTS) s.values = s.values.slice(-MAX_POINTS);
    }
    return series;
  }, [telemetry]);

  const availableMetrics = METRICS.filter((m) => seriesByMetric[m.key]?.values.length);

  if (isLoading) {
    return <div className="text-gray-500 text-xs ml-2 py-1">Loading…</div>;
  }
  if (error || availableMetrics.length === 0) {
    return <div className="text-gray-500 text-xs ml-2 py-1">No telemetry data</div>;
  }

  return (
    <div className="space-y-1">
      {availableMetrics.map((m) => {
        const s = seriesByMetric[m.key];
        return (
          <div key={m.key} className="flex items-center gap-2 px-2 py-1 rounded bg-white/5 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-gray-400 text-[10px] uppercase tracking-wider">{m.label}</div>
              <div className="text-gray-200 font-medium">{m.format(s.latest)}</div>
            </div>
            <Sparkline values={s.values} color={m.color} width={72} height={22} />
          </div>
        );
      })}
    </div>
  );
}
