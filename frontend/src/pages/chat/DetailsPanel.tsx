import { Link } from "react-router-dom";
import { formatTimestamp } from "../../utils/formatTimestamp";
import { buildRouteChain, isBroadcast, renderHighlightedText, routeLabel } from "./chatUtils";
import { NodeChip } from "./NodeChip";

export function DetailsPanel({
  urlMsg,
  selectedMessage,
  urlQ,
  nodes,
  applyFocus,
  setParam,
  clearFilters,
}: {
  urlMsg: string;
  selectedMessage: any | undefined;
  urlQ: string;
  nodes: any;
  applyFocus: (id: string) => void;
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
  clearFilters: () => void;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
          Message details
        </div>
        {urlMsg ? (
          <button
            type="button"
            className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
            onClick={() => setParam("msg", undefined, "push")}
          >
            close
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {!urlMsg ? (
          <div className="px-4 py-6 text-sm text-gray-600 dark:text-gray-400">
            <div className="font-medium text-gray-700 dark:text-gray-200">
              Click a message
            </div>
            <div className="mt-1">
              Select a message on the left to inspect route, hops, and nodes.
            </div>
            <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
              Pro tip: click the ⊙ next to a node to focus it.
            </div>
          </div>
        ) : !selectedMessage ? (
          <div className="px-4 py-6 text-sm text-gray-600 dark:text-gray-400">
            <div className="font-medium text-gray-700 dark:text-gray-200">
              Message not in current view
            </div>
            <div className="mt-1">
              It may be filtered out by range/type/hops/focus or advanced filters.
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 transition"
                onClick={() => setParam("msg", undefined, "push")}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          <div className="px-4 py-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                ID:{" "}
                <span className="font-mono text-gray-700 dark:text-gray-200">
                  {String(selectedMessage.id)}
                </span>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {formatTimestamp(selectedMessage.timestamp) ||
                  String(selectedMessage.timestamp)}
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                Text
              </div>
              <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-gray-200 dark:border-gray-800 p-3 bg-white dark:bg-gray-900/30 text-sm text-gray-900 dark:text-gray-100">
                {renderHighlightedText(String(selectedMessage.text ?? ""), urlQ)}
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
                Route
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <NodeChip
                  nodeId={String(selectedMessage.from ?? "")}
                  nodes={nodes}
                  fallback="UNK"
                  titlePrefix="From"
                  compact
                  stopPropagation
                  onFocus={(id) => applyFocus(id)}
                />

                <span className="text-gray-400">→</span>

                {Array.isArray(selectedMessage.sender) && selectedMessage.sender.length ? (
                  selectedMessage.sender.map((sid: any, idx: number) => (
                    <span
                      key={`route-via-${String(sid)}-${idx}`}
                      className="inline-flex items-center gap-2"
                    >
                      <NodeChip
                        nodeId={String(sid)}
                        nodes={nodes}
                        fallback="UNK"
                        titlePrefix="Via"
                        compact
                        stopPropagation
                        onFocus={(id) => applyFocus(id)}
                      />
                      <span className="text-gray-400">→</span>
                    </span>
                  ))
                ) : (
                  <>
                    <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                      via UNK
                    </span>
                    <span className="text-gray-400">→</span>
                  </>
                )}

                {isBroadcast(String(selectedMessage.to ?? "")) ? (
                  <span className="rounded-md px-2 py-0.5 text-[11px] font-medium bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
                    ALL
                  </span>
                ) : (
                  <NodeChip
                    nodeId={String(selectedMessage.to ?? "")}
                    nodes={nodes}
                    fallback="UNK"
                    titlePrefix="To"
                    compact
                    stopPropagation
                    onFocus={(id) => applyFocus(id)}
                  />
                )}

                <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                  hops {selectedMessage.hops_away ?? 0}
                </span>
              </div>

              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {routeLabel(nodes, String(selectedMessage.from ?? ""))} {"->"}{" "}
                {Array.isArray(selectedMessage.sender) && selectedMessage.sender.length
                  ? selectedMessage.sender
                      .map((x: any) => routeLabel(nodes, String(x)))
                      .join(" -> ")
                  : "UNK"}{" "}
                {"->"} {routeLabel(nodes, String(selectedMessage.to ?? ""))}
              </div>
            </div>

            <div className="pt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(String(selectedMessage.text ?? ""));
                  } catch {
                    // no-op
                  }
                }}
              >
                Copy text
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildRouteChain(nodes, selectedMessage));
                  } catch {
                    // ignore
                  }
                }}
                title="Copy route chain"
              >
                Copy route
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => applyFocus(String(selectedMessage.from))}
                title="Focus sender"
                disabled={
                  !String(selectedMessage.from ?? "").trim() ||
                  isBroadcast(String(selectedMessage.from))
                }
              >
                Focus from
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => applyFocus(String(selectedMessage.to))}
                title="Focus recipient"
                disabled={isBroadcast(String(selectedMessage.to))}
              >
                Focus to
              </button>

              {String(selectedMessage.from ?? "") ? (
                <Link
                  to={`/nodes/${String(selectedMessage.from)}`}
                  className="rounded-md px-3 py-2 text-sm border border-gray-300/70 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                >
                  Open from
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
