import React from "react";
import { Link } from "react-router";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { formatTimestamp } from "../../utils/formatTimestamp";
import {
  formatMetricValue,
  getNodeLabel,
  type NodesById,
  safeTsMs,
  type TelemetryListItem,
  toNumberLoose,
} from "./telemetryUtils";

function stop(e: React.MouseEvent) {
  e.stopPropagation();
}

function NodeLink({
  id,
  label,
}: {
  id: string;
  label: string;
}) {
  return (
    <Link
      to={`/nodes/${id}`}
      onClick={stop}
      className="text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
    >
      {label}
    </Link>
  );
}

export function TelemetryList({
  items,
  nodes,
  selectedKey,
  onSelect,
  listRef,
  onAtTopChange,
}: {
  items: TelemetryListItem[];
  nodes: NodesById;
  selectedKey: string;
  onSelect: (key: string) => void;
  listRef?: React.RefObject<VirtuosoHandle | null>;
  onAtTopChange?: (atTop: boolean) => void;
}) {
  return (
    <Virtuoso
      ref={listRef}
      atTopThreshold={48}
      atTopStateChange={onAtTopChange}
      style={{ flex: 1, minHeight: 0, height: "100%" }}
      data={items}
      itemContent={(_, it) => {
        const isSelected = it.key === selectedKey;

        if (it.kind === "all") {
          return (
            <div className="px-3 py-2">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(it.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(it.key);
                }}
                className={`rounded-xl border p-3 shadow-xs transition cursor-pointer ${
                  isSelected
                    ? "border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-900/10"
                    : "border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                      All nodes
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {it.totalNodes.toLocaleString()} nodes •{" "}
                      {it.totalSamples.toLocaleString()} samples
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-xs text-gray-500">
                      Last sample
                    </div>
                    <div className="text-xs text-gray-700 dark:text-gray-200">
                      {it.lastTsMs ? formatTimestamp(it.lastTsMs) : "—"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        // node item
        const node = nodes[it.nodeId];
        const label = getNodeLabel(nodes, it.nodeId);
        const cur = (node as any)?.telemetry ?? null;

        const battery =
          toNumberLoose(cur?.battery_level) ??
          toNumberLoose(it.summary.latest?.payload?.battery_level);
        const voltage =
          toNumberLoose(cur?.voltage) ??
          toNumberLoose(it.summary.latest?.payload?.voltage);
        const chanutil =
          toNumberLoose(cur?.channel_utilization) ??
          toNumberLoose(it.summary.latest?.payload?.channel_utilization);

        const last = it.summary.lastTsMs || safeTsMs(it.summary.latest.timestamp);

        return (
          <div className="px-3 py-2">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(it.key)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") onSelect(it.key);
              }}
              className={`rounded-xl border p-3 shadow-xs transition cursor-pointer ${
                isSelected
                  ? "border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-900/10"
                  : "border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 hover:bg-gray-50 dark:hover:bg-gray-900/30"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    <NodeLink id={it.nodeId} label={label} />
                    <span className="ml-2 text-[11px] text-gray-400">{it.nodeId}</span>
                  </div>

                  <div className="text-xs text-gray-500 mt-1">
                    Last:{" "}
                    <span className="text-gray-700 dark:text-gray-200">
                      {last ? formatTimestamp(last) : "—"}
                    </span>
                    {" • "}
                    Samples:{" "}
                    <span className="text-gray-700 dark:text-gray-200">
                      {it.summary.count.toLocaleString()}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-2 py-0.5 text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
                      Battery: {battery == null ? "—" : formatMetricValue("battery_level", battery)}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-2 py-0.5 text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
                      Voltage: {voltage == null ? "—" : formatMetricValue("voltage", voltage)}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-2 py-0.5 text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
                      Ch util: {chanutil == null ? "—" : formatMetricValue("channel_utilization", chanutil)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    />
  );
}
