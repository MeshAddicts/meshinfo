import { memo, useCallback, useRef } from "react";
import { Link } from "react-router";
import { Virtuoso } from "react-virtuoso";

import { formatTimestamp } from "../../utils/formatTimestamp";
import { type TraceroutesListItem } from "./traceroutesTypes";
import { type NodesById } from "./traceroutesUtils";

type GetNode = (id: string) => NodesById[string] | undefined;

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
      title={id}
    >
      {label}
    </Link>
  );
}

function RouteInline({
  getNode,
  routeIds,
}: {
  getNode: GetNode;
  routeIds: string[];
}) {
  if (!routeIds || routeIds.length === 0) {
    return <span className="text-xs text-gray-500">No route</span>;
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
      {routeIds.map((id, i) => {
        const n = getNode(id);
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

// Memoized so nodes-cache flushes and selection changes only re-render affected rows
const TracerouteRow = memo(function TracerouteRow({
  item,
  isSelected,
  getNode,
  onSelect,
}: {
  item: TraceroutesListItem;
  isSelected: boolean;
  getNode: GetNode;
  onSelect: (key: string) => void;
}) {
  if (item.kind === "all") {
    return (
      <div className="px-3 py-2">
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(item.key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(item.key);
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
                Overview
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {item.totalPairs.toLocaleString()} pairs •{" "}
                {item.totalEvents.toLocaleString()} runs •{" "}
                {item.uniqueRoutes.toLocaleString()} unique routes
              </div>
            </div>

            <div className="shrink-0 text-right">
              <div className="text-xs text-gray-500">Last run</div>
              <div className="text-xs text-gray-700 dark:text-gray-200">
                {item.lastTsMs ? formatTimestamp(item.lastTsMs) : "—"}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // pair item
  const fromLabel = getNode(item.from)?.shortname || "UNK";
  const toLabel = getNode(item.to)?.shortname || "UNK";

  return (
    <div className="px-3 py-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(item.key)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") onSelect(item.key);
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
              <NodeLink id={item.from} label={fromLabel} />
              <span className="mx-2 text-gray-400">→</span>
              <NodeLink id={item.to} label={toLabel} />
            </div>

            <div className="text-xs text-gray-500 mt-1">
              Last:{" "}
              <span className="text-gray-700 dark:text-gray-200">
                {item.summary.lastTsMs ? formatTimestamp(item.summary.lastTsMs) : "—"}
              </span>
              {" • "}
              Runs:{" "}
              <span className="text-gray-700 dark:text-gray-200">
                {item.summary.count.toLocaleString()}
              </span>
              {" • "}
              Unique routes:{" "}
              <span className="text-gray-700 dark:text-gray-200">
                {item.summary.uniqueRoutes.toLocaleString()}
              </span>
            </div>

            <div className="mt-2">
              {item.summary.topRouteIds.length ? (
                <>
                  <div className="text-[11px] text-gray-500 mb-1">
                    Most common route ({item.summary.topRouteCount.toLocaleString()}×)
                  </div>
                  <RouteInline getNode={getNode} routeIds={item.summary.topRouteIds} />
                </>
              ) : (
                <div className="text-xs text-gray-500">No route data.</div>
              )}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="text-xs text-gray-500">
              Pair
            </div>
            <div className="text-[11px] text-gray-400 tabular-nums mt-1">
              {item.from} → {item.to}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export const TraceroutesList = memo(function TraceroutesList({
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
  // Ref-read lookup keeps row props stable while the nodes cache identity churns
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const getNode = useCallback((id: string) => nodesRef.current[id], []);

  const itemContent = useCallback(
    (_index: number, it: TraceroutesListItem) => (
      <TracerouteRow
        item={it}
        isSelected={it.key === selectedKey}
        getNode={getNode}
        onSelect={onSelect}
      />
    ),
    [selectedKey, getNode, onSelect],
  );

  return (
    <Virtuoso
      style={{ flex: 1, minHeight: 0, height: "100%" }}
      data={items}
      computeItemKey={(_index, it) => it.key}
      itemContent={itemContent}
    />
  );
});
