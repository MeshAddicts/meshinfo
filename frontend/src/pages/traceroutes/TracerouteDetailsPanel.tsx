import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { copyTextToClipboard } from "../../utils/clipboard";
import { formatTimestamp } from "../../utils/formatTimestamp";
import {
  type RangeKey,
  type TraceroutesListItem,
} from "./traceroutesTypes";
import {
  groupTracerouteEvents,
  hopChipLabel,
  isHopLinkable,
  type NodesById,
  returnRouteIdsOf,
  routeIdsOf,
  safeTsMs,
  type TracerouteEvent,
  type TracerouteGroup,
} from "./traceroutesUtils";

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

function NodeInline({ id, label }: { id: string; label: string }) {
  return (
    <Link
      to={`/nodes/${id}`}
      className="text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
      title={id}
    >
      {label}
    </Link>
  );
}

function RouteChips({
  nodes,
  routeIds,
}: {
  nodes: NodesById;
  routeIds: string[];
}) {
  if (!routeIds || routeIds.length === 0) {
    return <div className="text-sm text-gray-500">No route</div>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {routeIds.map((id, i) => {
        const label = hopChipLabel(nodes, id);
        return (
          <span key={`${id}-${i}`} className="inline-flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
              {isHopLinkable(id) ? (
                <NodeInline id={id} label={label} />
              ) : (
                <span className="text-gray-500 italic" title={id}>
                  {label}
                </span>
              )}
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

// Replies land within seconds; past this age the exchange is settled.
const REPLY_PENDING_MS = 5 * 60_000;

function ProvisionalBadge({ tsMs }: { tsMs?: number }) {
  const pending = tsMs != null && Date.now() - tsMs < REPLY_PENDING_MS;
  if (pending) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-amber-400/50 bg-amber-50/60 dark:bg-amber-900/20 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
        title="Request seen mid-flight — the reply may still arrive"
      >
        awaiting reply
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border border-gray-400/40 bg-gray-100/50 dark:bg-gray-800/40 px-2 py-0.5 text-[10px] text-gray-500 dark:text-gray-400"
      title="The target never answered this traceroute — only the request was observed"
    >
      no reply
    </span>
  );
}

function buildRouteText(nodes: NodesById, routeIds: string[]) {
  return routeIds.map((id) => hopChipLabel(nodes, id)).join(" > ");
}

function pairLabel(nodes: NodesById, from: string, to: string) {
  const f = nodes[from]?.shortname || "UNK";
  const t = nodes[to]?.shortname || "UNK";
  return `${f} → ${t}`;
}

function sortGroupsForUI(groups: TracerouteGroup[]) {
  const arr = [...groups];
  arr.sort((a, b) => b.count - a.count || b.lastTsMs - a.lastTsMs);
  return arr;
}

export function TracerouteDetailsPanel({
  selectedItem,
  nodes,
  range,
  eventsAll,
  eventsSelected,
  pairItems,
  uniqueRoutesTotal,
  onClearSelection,
  onQuickSearch,
}: {
  selectedItem: TraceroutesListItem;
  nodes: NodesById;
  range: RangeKey;
  eventsAll: TracerouteEvent[];
  eventsSelected: TracerouteEvent[];
  pairItems: TraceroutesListItem[]; // pair-only
  uniqueRoutesTotal: number;
  onClearSelection: () => void;
  onQuickSearch: (text: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string>("");

  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(""), 900);
    return () => clearTimeout(t);
  }, [copiedKey]);

  const isPair = selectedItem.kind === "pair";
  const scopeEvents = isPair ? eventsSelected : eventsAll;

  const header = useMemo(() => {
    if (selectedItem.kind === "all") {
      const last = scopeEvents.length
        ? Math.max(...scopeEvents.map((e) => safeTsMs(e.timestamp)))
        : 0;

      const packetsNote =
        selectedItem.totalPackets > selectedItem.totalEvents
          ? ` (${selectedItem.totalPackets.toLocaleString()} packets)`
          : "";
      return {
        title: "Traceroutes overview",
        subtitle: `Range: ${range} • ${selectedItem.totalEvents.toLocaleString()} runs${packetsNote} • ${pairItems.length.toLocaleString()} pairs • ${uniqueRoutesTotal.toLocaleString()} unique routes`,
        lastTsMs: last,
        from: null as string | null,
        to: null as string | null,
      };
    }

    const from = selectedItem.from;
    const to = selectedItem.to;
    const title = pairLabel(nodes, from, to);
    const s = selectedItem.summary;
    const pairPacketsNote =
      s.packetCount > s.count ? ` (${s.packetCount.toLocaleString()} packets)` : "";
    const subtitle = `${s.count.toLocaleString()} runs${pairPacketsNote} • ${s.uniqueRoutes.toLocaleString()} unique routes • Range: ${range}`;

    return {
      title,
      subtitle,
      lastTsMs: selectedItem.summary.lastTsMs,
      from,
      to,
    };
  }, [selectedItem, nodes, range, pairItems.length, uniqueRoutesTotal, scopeEvents]);

  const lastEvent = useMemo(() => {
    if (!scopeEvents.length) return null;
    return scopeEvents[0]; // already newest-first in parent
  }, [scopeEvents]);

  const routeGroupsInScope = useMemo(() => {
    const gs = groupTracerouteEvents(scopeEvents);
    return sortGroupsForUI(gs);
  }, [scopeEvents]);

  const recentRuns = useMemo(() => {
    return scopeEvents.slice(0, isPair ? 18 : 14);
  }, [scopeEvents, isPair]);

  const topPairsByCount = useMemo(() => {
    const pairs = pairItems.filter((x) => x.kind === "pair") as Extract<
      TraceroutesListItem,
      { kind: "pair" }
    >[];
    const arr = [...pairs].sort((a, b) => b.summary.count - a.summary.count || b.summary.lastTsMs - a.summary.lastTsMs);
    return arr.slice(0, 12);
  }, [pairItems]);

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
                Latest: {formatTimestamp(lastEvent.timestamp) || "Unknown"}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {selectedItem.kind === "pair" ? (
              <>
                <button
                  type="button"
                  onClick={() => onQuickSearch(selectedItem.from)}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Search for FROM node"
                >
                  Search from
                </button>
                <button
                  type="button"
                  onClick={() => onQuickSearch(selectedItem.to)}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Search for TO node"
                >
                  Search to
                </button>

                <Link
                  to={`/nodes/${selectedItem.from}`}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Open FROM node"
                >
                  Open from
                </Link>
                <Link
                  to={`/nodes/${selectedItem.to}`}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Open TO node"
                >
                  Open to
                </Link>

                <button
                  type="button"
                  onClick={onClearSelection}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Back to overview"
                >
                  Overview
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!scopeEvents.length ? (
          <div className="text-sm text-gray-500">
            No traceroutes in this scope. Try widening the range or clearing search filters.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* OVERVIEW MODE */}
            {selectedItem.kind === "all" ? (
              <>
                <Card
                  title="Top pairs"
                  subtitle="Most active endpoint pairs (by run count) in the current scope"
                >
                  <div className="flex flex-col gap-2">
                    {topPairsByCount.map((p) => {
                      const fromLabel = nodes[p.from]?.shortname || "UNK";
                      const toLabel = nodes[p.to]?.shortname || "UNK";
                      return (
                        <div
                          key={p.key}
                          className="flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0 truncate">
                            <NodeInline id={p.from} label={fromLabel} />{" "}
                            <span className="text-gray-400">→</span>{" "}
                            <NodeInline id={p.to} label={toLabel} />{" "}
                            <span className="text-[11px] text-gray-400">
                              ({p.from}→{p.to})
                            </span>
                          </div>
                          <div className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                            {p.summary.count.toLocaleString()}
                          </div>
                        </div>
                      );
                    })}
                    {topPairsByCount.length === 0 ? (
                      <div className="text-sm text-gray-500">No pairs found.</div>
                    ) : null}
                  </div>
                </Card>

                <Card
                  title="Most common routes"
                  subtitle="Hop sequences grouped by identical path (across all pairs)"
                >
                  <div className="flex flex-col gap-3">
                    {routeGroupsInScope.slice(0, 8).map((g) => {
                      const title = pairLabel(nodes, g.from, g.to);
                      const routeText = buildRouteText(nodes, g.route_ids);
                      return (
                        <details
                          key={`g-${g.key}`}
                          className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-900/10 p-3"
                        >
                          <summary className="cursor-pointer list-none select-none">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                                  {title}
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                  {g.count.toLocaleString()}× • {g.route_ids.length} hops • last{" "}
                                  {g.lastTsMs ? formatTimestamp(g.lastTsMs) : "—"}
                                </div>
                              </div>
                              <div className="shrink-0 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const ok = await copyTextToClipboard(routeText);
                                    if (ok) setCopiedKey(`rt:${g.key}`);
                                  }}
                                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                                  title="Copy route as text"
                                >
                                  {copiedKey === `rt:${g.key}` ? "Copied!" : "Copy route"}
                                </button>
                              </div>
                            </div>
                          </summary>

                          <div className="mt-3">
                            <RouteChips nodes={nodes} routeIds={g.route_ids} />
                            <div className="mt-2 text-xs text-gray-500 wrap-break-word">
                              {routeText || "—"}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </Card>
              </>
            ) : null}

            {/* PAIR MODE: ROUTE BREAKDOWN */}
            {selectedItem.kind === "pair" ? (
              <Card
                title="Routes under this pair"
                subtitle="Grouped by identical hop sequence (expand to see occurrences)"
              >
                <div className="flex flex-col gap-3">
                  {routeGroupsInScope.slice(0, 14).map((g, idx) => {
                    const routeText = buildRouteText(nodes, g.route_ids);
                    const occurrences = scopeEvents
                      .filter((e) => {
                        const k = `${e.from}|${e.to}|${routeIdsOf(e).join(",")}`;
                        return k === g.key;
                      })
                      .slice(0, 16);

                    return (
                      <details
                        key={`rg-${g.key}`}
                        className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-900/10 p-3"
                        open={idx === 0}
                      >
                        <summary className="cursor-pointer list-none select-none">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                                {g.count.toLocaleString()}× • {g.route_ids.length} hops{" "}
                                {g.provisional ? <ProvisionalBadge tsMs={g.lastTsMs} /> : null}
                              </div>
                              <div className="text-xs text-gray-500 mt-1">
                                Last: {g.lastTsMs ? formatTimestamp(g.lastTsMs) : "—"}
                              </div>
                            </div>

                            <div className="shrink-0 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const ok = await copyTextToClipboard(routeText);
                                  if (ok) setCopiedKey(`routeText:${g.key}`);
                                }}
                                className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                                title="Copy route as text"
                              >
                                {copiedKey === `routeText:${g.key}` ? "Copied!" : "Copy route"}
                              </button>

                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const ok = await copyTextToClipboard(g.route_ids.join(","));
                                  if (ok) setCopiedKey(`routeIds:${g.key}`);
                                }}
                                className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                                title="Copy hop ids"
                              >
                                {copiedKey === `routeIds:${g.key}` ? "Copied!" : "Copy ids"}
                              </button>
                            </div>
                          </div>
                        </summary>

                        <div className="mt-3">
                          <RouteChips nodes={nodes} routeIds={g.route_ids} />
                          <div className="mt-2 text-xs text-gray-500 wrap-break-word">
                            {routeText || "—"}
                          </div>

                          <div className="mt-3 text-xs text-gray-500">
                            Recent occurrences (up to {occurrences.length})
                          </div>
                          <div className="mt-2 flex flex-col gap-1">
                            {occurrences.map((e) => (
                              <div
                                key={`occ-${e.__idx}`}
                                className="text-xs text-gray-700 dark:text-gray-200"
                              >
                                {formatTimestamp(e.timestamp) || "Unknown"}
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                    );
                  })}
                  {routeGroupsInScope.length === 0 ? (
                    <div className="text-sm text-gray-500">No grouped routes found.</div>
                  ) : null}
                </div>
              </Card>
            ) : null}

            {/* RECENT RUNS */}
            <Card
              title="Recent runs"
              subtitle={selectedItem.kind === "pair" ? "Newest first (pair)" : "Newest first (scope)"}
              right={
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyTextToClipboard(JSON.stringify(recentRuns, null, 2));
                    if (ok) setCopiedKey("recent");
                  }}
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Copy recent runs JSON"
                >
                  {copiedKey === "recent" ? "Copied!" : "Copy"}
                </button>
              }
            >
              <div className="flex flex-col gap-2">
                {recentRuns.map((e) => {
                  const ts = safeTsMs(e.timestamp);
                  const rids = routeIdsOf(e);
                  const fromLabel = nodes[e.from]?.shortname || "UNK";
                  const toLabel = nodes[e.to]?.shortname || "UNK";

                  return (
                    <div
                      key={`run-${e.__idx}`}
                      className="rounded-md border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-900/10 px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-xs text-gray-700 dark:text-gray-200">
                          {selectedItem.kind === "pair" ? (
                            <>
                              {ts ? formatTimestamp(ts) : "Unknown"}
                            </>
                          ) : (
                            <>
                              <span className="font-medium">{fromLabel}</span>{" "}
                              <span className="text-gray-400">→</span>{" "}
                              <span className="font-medium">{toLabel}</span>{" "}
                              <span className="text-gray-400">•</span>{" "}
                              {ts ? formatTimestamp(ts) : "Unknown"}
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {e.provisional ? <ProvisionalBadge tsMs={safeTsMs(e.timestamp)} /> : null}
                          <div className="text-[11px] text-gray-500 tabular-nums">
                            hops={rids.length}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2">
                        <RouteChips nodes={nodes} routeIds={rids} />
                      </div>

                      {(() => {
                        // Return leg travels target → … → initiator.
                        const back = returnRouteIdsOf(e);
                        if (!back.length) return null;
                        return (
                          <div className="mt-2">
                            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                              Return path ({(nodes[e.to]?.shortname || "UNK") + " → " + (nodes[e.from]?.shortname || "UNK")})
                            </div>
                            <RouteChips nodes={nodes} routeIds={back} />
                          </div>
                        );
                      })()}

                      {selectedItem.kind !== "pair" ? (
                        <div className="mt-2 text-[11px] text-gray-500 tabular-nums">
                          {e.from} → {e.to}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
