import { useMemo } from "react";

import { NodeListItem } from "./NodesList";
import { getTelemetrySnapshot, RangeKey, roleLabel,StatusKey } from "./nodesUtils";

function BarRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
        <span className="truncate">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-200/70 dark:bg-gray-800 overflow-hidden">
        <div
          className="h-full bg-indigo-600/80"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-sm">
      <div className="text-xs text-gray-600 dark:text-gray-400">{title}</div>
      <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
        {value}
      </div>
      {sub ? (
        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function NodesOverviewPanel({
  items,
  range,
  status,
  serverNodeId,
  nodesTotal,
}: {
  items: NodeListItem[];
  range: RangeKey;
  status: StatusKey;
  serverNodeId: string;
  nodesTotal: number;
}) {
  const summary = useMemo(() => {
    const total = items.length;
    const online = items.filter((x) => x.online).length;
    const withPos = items.filter((x) => x.hasPosition).length;

    const telemItems = items.filter((x) => {
      const t = getTelemetrySnapshot(x.node);
      return (
        typeof t.batteryPct === "number" ||
        typeof t.voltage === "number" ||
        typeof t.airTx === "number" ||
        typeof t.chanUtil === "number"
      );
    });

    const withTelem = telemItems.length;

    const batteries = telemItems
      .map((x) => getTelemetrySnapshot(x.node).batteryPct)
      .filter((v): v is number => typeof v === "number");

    const voltages = telemItems
      .map((x) => getTelemetrySnapshot(x.node).voltage)
      .filter((v): v is number => typeof v === "number");

    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const min = (arr: number[]) => (arr.length ? Math.min(...arr) : null);
    const max = (arr: number[]) => (arr.length ? Math.max(...arr) : null);

    const lowBatt = batteries.filter((b) => b <= 20).length;

    const roleCounts = new Map<string, number>();
    for (const x of items) {
      const r = roleLabel((x.node as any)?.role);
      roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1);
    }

    const roleTop = [...roleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    // last-seen buckets (based on “time since now”)
    const now = Date.now();
    const buckets: Array<[string, number]> = [
      ["< 1 min", 0],
      ["< 10 min", 0],
      ["< 1 hr", 0],
      ["< 6 hr", 0],
      ["< 24 hr", 0],
      ["> 24 hr", 0],
    ];

    for (const x of items) {
      const ls = (x.node as any)?.last_seen;
      const t = ls ? new Date(ls).getTime() : NaN;
      if (!Number.isFinite(t)) continue;
      const d = now - t;

      if (d < 60_000) buckets[0][1] += 1;
      else if (d < 10 * 60_000) buckets[1][1] += 1;
      else if (d < 60 * 60_000) buckets[2][1] += 1;
      else if (d < 6 * 60 * 60_000) buckets[3][1] += 1;
      else if (d < 24 * 60 * 60_000) buckets[4][1] += 1;
      else buckets[5][1] += 1;
    }

    return {
      total,
      online,
      withPos,
      withTelem,
      avgBatt: avg(batteries),
      minBatt: min(batteries),
      maxBatt: max(batteries),
      lowBatt,
      avgVolt: avg(voltages),
      minVolt: min(voltages),
      maxVolt: max(voltages),
      roleTop,
      buckets,
    };
  }, [items]);

  return (
    <div className="flex flex-col gap-4 min-h-0">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Overview
          </div>
          <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            Based on filters: range <span className="font-medium">{range}</span>, status{" "}
            <span className="font-medium">{status}</span>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              title="Shown"
              value={`${summary.total}`}
              sub={`Seen total: ${nodesTotal}`}
            />
            <StatCard title="Online" value={`${summary.online}`} sub="6h window / active" />
            <StatCard title="With position" value={`${summary.withPos}`} />
            <StatCard title="With telemetry" value={`${summary.withTelem}`} />
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-sm">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Telemetry snapshot
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">Battery</div>
                  <div className="mt-1 text-sm text-gray-900 dark:text-gray-100 tabular-nums">
                    {summary.avgBatt != null ? `${summary.avgBatt.toFixed(0)}% avg` : "—"}
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                    {summary.minBatt != null && summary.maxBatt != null
                      ? `${summary.minBatt.toFixed(0)}% – ${summary.maxBatt.toFixed(0)}%`
                      : ""}
                  </div>
                  <div className="mt-1 text-xs text-amber-700 dark:text-amber-300 tabular-nums">
                    {summary.lowBatt > 0 ? `${summary.lowBatt} low (≤20%)` : ""}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">Voltage</div>
                  <div className="mt-1 text-sm text-gray-900 dark:text-gray-100 tabular-nums">
                    {summary.avgVolt != null ? `${summary.avgVolt.toFixed(2)}V avg` : "—"}
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                    {summary.minVolt != null && summary.maxVolt != null
                      ? `${summary.minVolt.toFixed(2)}V – ${summary.maxVolt.toFixed(2)}V`
                      : ""}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-sm">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Last seen distribution
              </div>
              <div className="mt-3 space-y-2">
                {summary.buckets.map(([label, value]) => (
                  <BarRow
                    key={label}
                    label={label}
                    value={value}
                    total={summary.total}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-sm">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Top roles
              </div>
              <div className="mt-3 space-y-2">
                {summary.roleTop.map(([label, value]) => (
                  <BarRow
                    key={label}
                    label={label}
                    value={value}
                    total={summary.total}
                  />
                ))}
              </div>

              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Server node: <span className="font-mono">{serverNodeId}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-4 shadow-sm">
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Pro tips
        </div>
        <ul className="mt-2 text-xs text-gray-600 dark:text-gray-400 list-disc pl-5 space-y-1">
          <li>Click a node row to pin details.</li>
          <li>Use <span className="font-mono">/</span> to jump to search.</li>
          <li>Sort by DX to quickly spot your farthest heard nodes.</li>
        </ul>
      </div>
    </div>
  );
}
