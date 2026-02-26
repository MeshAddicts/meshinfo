import { Link } from "react-router-dom";

export function FocusPanel({
  urlNode,
  nodes,
  focusPicker,
  setFocusPicker,
  focusMatches,
  frequentNodes,
  applyFocus,
  clearFocus,
  focusStats,
}: {
  urlNode: string;
  nodes: any;
  focusPicker: string;
  setFocusPicker: (v: string) => void;
  focusMatches: Array<{ id: string; short: string; long: string }>;
  frequentNodes: Array<{ nodeId: string; count: number }>;
  applyFocus: (id: string) => void;
  clearFocus: () => void;
  focusStats: any;
}) {
  const focusNodeObj = urlNode ? nodes?.[urlNode] : null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col max-h-[40vh] min-h-0">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
          Node focus
        </div>
        {urlNode.trim() ? (
          <button
            type="button"
            className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
            onClick={clearFocus}
          >
            clear
          </button>
        ) : null}
      </div>

      <div className="p-4 flex-1 overflow-y-auto min-h-0">
        {!urlNode.trim() ? (
          <>
            <div className="text-sm text-gray-700 dark:text-gray-200 font-medium">
              Focus a node
            </div>

            <div className="mt-2">
              <input
                value={focusPicker}
                onChange={(e) => setFocusPicker(e.target.value)}
                placeholder="Type 2+ chars… (id, shortname, longname)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            {focusMatches.length > 0 ? (
              <div className="mt-2 rounded-md border border-gray-200 dark:border-gray-800 overflow-hidden">
                <ul className="divide-y divide-gray-200 dark:divide-gray-800 max-h-64 overflow-y-auto">
                  {focusMatches.map((m) => (
                    <li
                      key={`match-${m.id}`}
                      className="px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-900/30 cursor-pointer"
                      onClick={() => applyFocus(m.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-gray-900 dark:text-gray-100 font-medium">
                          {m.short || "UNK"}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {m.id}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {m.long || "Unknown"}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Tip: type “fr”, “nb99”, “7cf6e06c”, etc.
              </div>
            )}

            {frequentNodes.length > 0 ? (
              <div className="mt-4">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Frequent in current view
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {frequentNodes.map((x) => (
                    <button
                      key={`freq-${x.nodeId}`}
                      type="button"
                      className="rounded-md px-2 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      onClick={() => applyFocus(x.nodeId)}
                      title={`${x.nodeId} (${x.count})`}
                    >
                      {nodes?.[x.nodeId]?.shortname ?? "UNK"}{" "}
                      <span className="opacity-70">({x.count})</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {focusNodeObj?.shortname ?? "UNK"}{" "}
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
                    {focusNodeObj?.longname ?? urlNode}
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {urlNode}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Link
                  to={`/nodes/${urlNode}`}
                  className="text-xs underline hover:no-underline text-gray-700 dark:text-gray-200"
                >
                  open
                </Link>
                <button
                  type="button"
                  className="text-xs underline hover:no-underline text-gray-700 dark:text-gray-200"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(urlNode);
                    } catch {
                      // no-op
                    }
                  }}
                  title="Copy node id"
                >
                  copy id
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-md border border-gray-200 dark:border-gray-800 p-2">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Messages
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {focusStats?.total ?? 0}
                </div>
              </div>
              <div className="rounded-md border border-gray-200 dark:border-gray-800 p-2">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  In / Out
                </div>
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {(focusStats?.inbound ?? 0).toLocaleString()} /{" "}
                  {(focusStats?.outbound ?? 0).toLocaleString()}
                </div>
              </div>
            </div>

            {focusStats?.hopsChips?.length ? (
              <div className="mt-4">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Hops distribution
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {focusStats.hopsChips.map((h: any) => (
                    <span
                      key={`hop-${h.hops}`}
                      className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                      title={`${h.count} messages`}
                    >
                      {h.hops} hops: {h.count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
