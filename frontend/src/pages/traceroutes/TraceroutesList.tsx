import { Link } from "react-router-dom";
import { Virtuoso } from "react-virtuoso";

import { formatTimestamp } from "../../utils/formatTimestamp";
import {
  type NodesById,
  type TraceroutesListItem,
  routeIdsOf,
  routeHopsOf,
} from "./traceroutesUtils";

function stop(e: React.MouseEvent) {
  e.stopPropagation();
}

function NodeLink({
  id,
  label,
  className,
}: {
  id: string;
  label: string;
  className?: string;
}) {
  return (
    <Link
      to={`/nodes/${id}`}
      onClick={stop}
      className={
        className ??
        "text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
      }
    >
      {label}
    </Link>
  );
}

function RouteInline({
  nodes,
  routeIds,
}: {
  nodes: NodesById;
  routeIds: string[];
}) {
  if (!routeIds || routeIds.length === 0) {
    return <span className="text-xs text-gray-500">No route</span>;
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
      {routeIds.map((id, i) => {
        const n = nodes[id];
        const label = n?.shortname || "UNK";
        return (
          <span key={`${id}-${i}`} className="inline-flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
              <NodeLink id={id} label={label} />
            </span>
            {i < routeIds.length - 1 ? (
              <span className="text-gray-300 dark:text-gray-700">›</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function TraceroutesList({
  items,
  nodes,
  selectedKey,
  onSelect,
}: {
  items: TraceroutesListItem[];
  nodes: NodesById;
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <Virtuoso
      // Virtuoso MUST have a real height from parents (we keep flex-1 min-h-0 upstream)
      style={{ flex: 1, minHeight: 0, height: "100%" }}
      data={items}
      itemContent={(_, it) => {
        const isSelected = it.key === selectedKey;

        if (it.kind === "route") {
          const from = nodes[it.group.from]?.shortname || "UNK";
          const to = nodes[it.group.to]?.shortname || "UNK";

          return (
            <div className="px-3 py-2">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(it.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(it.key);
                }}
                className={`rounded-xl border p-3 shadow-sm transition cursor-pointer ${
                  isSelected
                    ? "border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-900/10"
                    : "border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                      {from} <span className="text-gray-400">→</span> {to}
                    </div>
                    <div className="mt-1">
                      <RouteInline nodes={nodes} routeIds={it.group.route_ids} />
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div className="text-xs text-gray-500">
                      Count:{" "}
                      <span className="font-semibold text-gray-700 dark:text-gray-200">
                        {it.group.count.toLocaleString()}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Last:{" "}
                      <span className="text-gray-700 dark:text-gray-200">
                        {it.group.lastTsMs ? formatTimestamp(it.group.lastTsMs) : "Unknown"}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Hops:{" "}
                      <span className="text-gray-700 dark:text-gray-200">
                        {it.group.route_ids.length}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        // event
        const e = it.event;
        const from = nodes[e.from]?.shortname || "UNK";
        const to = nodes[e.to]?.shortname || "UNK";
        const routeIds = routeIdsOf(e);

        return (
          <div className="px-3 py-2">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(it.key)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") onSelect(it.key);
              }}
              className={`rounded-xl border p-3 shadow-sm transition cursor-pointer ${
                isSelected
                  ? "border-indigo-500/40 bg-indigo-50/60 dark:bg-indigo-900/10"
                  : "border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 hover:bg-gray-50 dark:hover:bg-gray-900/30"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {from} <span className="text-gray-400">→</span> {to}
                  </div>

                  <div className="text-xs text-gray-500 mt-1">
                    {formatTimestamp(e.timestamp) || "Unknown"} •{" "}
                    <span className="text-gray-700 dark:text-gray-200">
                      {routeHopsOf(e)} hops
                    </span>
                    {typeof e.hops_away === "number" ? (
                      <>
                        {" "}
                        • <span className="text-gray-700 dark:text-gray-200">{e.hops_away}</span>{" "}
                        away
                      </>
                    ) : null}
                  </div>

                  <div className="mt-2">
                    <RouteInline nodes={nodes} routeIds={routeIds} />
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <div className="text-xs text-gray-500">
                    Route hops:{" "}
                    <span className="font-semibold text-gray-700 dark:text-gray-200">
                      {routeIds.length}
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
