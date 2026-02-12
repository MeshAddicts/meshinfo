import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { formatTimestamp } from "../../utils/formatTimestamp";
import {
  type NodesById,
  type TracerouteEvent,
  type TraceroutesListItem,
  routeIdsOf,
  safeTsMs,
} from "./traceroutesUtils";

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

function NodeInline({
  id,
  label,
}: {
  id: string;
  label: string;
}) {
  return (
    <Link
      to={`/nodes/${id}`}
      className="text-indigo-700 hover:text-indigo-800 dark:text-indigo-300 dark:hover:text-indigo-200"
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
        const label = nodes[id]?.shortname || "UNK";
        return (
          <span key={`${id}-${i}`} className="inline-flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-gray-300/60 dark:border-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 bg-white/60 dark:bg-gray-950/40">
              <NodeInline id={id} label={label} />
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

function buildRouteText(nodes: NodesById, routeIds: string[]) {
  return routeIds.map((id) => nodes[id]?.shortname || "UNK").join(" > ");
}

export function TracerouteDetailsPanel({
  selected,
  nodes,
  relatedEvents,
  onClearSelection,
  onQuickSearch,
}: {
  selected: TraceroutesListItem | null;
  nodes: NodesById;
  relatedEvents: TracerouteEvent[];
  onClearSelection: () => void;
  onQuickSearch: (text: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string>("");

  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(""), 900);
    return () => clearTimeout(t);
  }, [copiedKey]);

  const content = useMemo(() => {
    if (!selected) return null;

    if (selected.kind === "route") {
      const g = selected.group;
      const fromLabel = nodes[g.from]?.shortname || "UNK";
      const toLabel = nodes[g.to]?.shortname || "UNK";
      const routeText = buildRouteText(nodes, g.route_ids);

      return {
        title: `${fromLabel} → ${toLabel}`,
        subtitle: `${g.count.toLocaleString()} occurrences • ${g.route_ids.length} hops`,
        meta: [
          { k: "From", v: fromLabel, id: g.from },
          { k: "To", v: toLabel, id: g.to },
          { k: "First", v: g.firstTsMs ? formatTimestamp(g.firstTsMs) : "Unknown" },
          { k: "Last", v: g.lastTsMs ? formatTimestamp(g.lastTsMs) : "Unknown" },
        ],
        routeIds: g.route_ids,
        routeText,
      };
    }

    const e = selected.event;
    const fromLabel = nodes[e.from]?.shortname || "UNK";
    const toLabel = nodes[e.to]?.shortname || "UNK";
    const routeIds = routeIdsOf(e);
    const routeText = buildRouteText(nodes, routeIds);

    return {
      title: `${fromLabel} → ${toLabel}`,
      subtitle: `${formatTimestamp(e.timestamp) || "Unknown"} • ${routeIds.length} hops`,
      meta: [
        { k: "From", v: fromLabel, id: e.from },
        { k: "To", v: toLabel, id: e.to },
        { k: "Hops away", v: String(e.hops_away ?? "") },
        { k: "Route hops", v: String(routeIds.length) },
      ],
      routeIds,
      routeText,
    };
  }, [selected, nodes]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-500">Details</div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
              {content ? content.title : "Traceroute details"}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              {content ? content.subtitle : "Select a traceroute (or route group) on the left."}
            </div>
          </div>

          {selected ? (
            <button
              type="button"
              onClick={onClearSelection}
              className="shrink-0 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {!content ? (
          <div className="text-sm text-gray-500">
            Pick a traceroute to see the full hop path, quick actions, and copy/export helpers.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Meta grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {content.meta.map((m) => (
                <div
                  key={m.k}
                  className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3"
                >
                  <div className="text-xs text-gray-500">{m.k}</div>
                  <div className="text-sm text-gray-900 dark:text-gray-100 mt-1 flex items-center gap-2">
                    {m.id ? <NodeInline id={m.id} label={m.v} /> : <span>{m.v}</span>}
                    {m.id ? (
                      <button
                        type="button"
                        onClick={() => onQuickSearch(m.v)}
                        className="ml-auto text-xs rounded-md px-2 py-1 border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                        title="Search for this node"
                      >
                        Search
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {/* Route */}
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Route
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyTextToClipboard(content.routeText);
                      if (ok) setCopiedKey("routeText");
                    }}
                    className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                    title="Copy route as text"
                  >
                    {copiedKey === "routeText" ? "Copied!" : "Copy route"}
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyTextToClipboard(content.routeIds.join(","));
                      if (ok) setCopiedKey("routeIds");
                    }}
                    className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                    title="Copy hop ids"
                  >
                    {copiedKey === "routeIds" ? "Copied!" : "Copy ids"}
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <RouteChips nodes={nodes} routeIds={content.routeIds} />
              </div>

              {content.routeIds.length > 0 ? (
                <div className="mt-3 text-xs text-gray-500 break-words">
                  {content.routeText || "—"}
                </div>
              ) : null}
            </div>

            {/* Related events (when a route group is selected) */}
            {selected?.kind === "route" ? (
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-950/20 p-3">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Recent occurrences
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Showing up to {Math.min(relatedEvents.length, 50)} runs for this exact hop sequence.
                </div>

                <div className="mt-3 flex flex-col gap-1">
                  {relatedEvents.slice(0, 12).map((e) => (
                    <div
                      key={`rel-${e.__idx}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="text-gray-700 dark:text-gray-200">
                        {formatTimestamp(e.timestamp) || "Unknown"}
                      </span>
                      <span className="text-gray-500">
                        ts={safeTsMs(e.timestamp) ? new Date(safeTsMs(e.timestamp)).toISOString() : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
