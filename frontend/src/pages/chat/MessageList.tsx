import { Link } from "react-router-dom";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { formatTimestamp } from "../../utils/formatTimestamp";
import { calculateDistanceBetweenNodes } from "../../utils/getDistanceBetweenTwoNodes";
import { isBroadcast, renderHighlightedText } from "./chatUtils";
import { NodeChip } from "./NodeChip";

export function MessageList({
  selectedChannel,
  channelLabel,
  totalMessages,
  messages,
  nodes,
  urlMsg,
  urlQ,
  urlNode,
  urlFocus,
  setParam,
  applyFocus,
  clearFilters,
  setRangeAll,
  virtuosoRef,
}: {
  selectedChannel: string | undefined;
  channelLabel: (id: string) => string;
  totalMessages: number;
  messages: any[];
  nodes: any;
  urlMsg: string;
  urlQ: string;
  urlNode: string;
  urlFocus: "endpoints" | "any";
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
  applyFocus: (nodeId: string) => void;
  clearFilters: () => void;
  setRangeAll: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle>;
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm text-gray-800 dark:text-gray-200">
          {selectedChannel ? (
            <>
              <span className="font-semibold">{channelLabel(selectedChannel)}</span>{" "}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                (Channel {selectedChannel})
              </span>
              <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
                total {totalMessages.toLocaleString()}
              </span>
            </>
          ) : (
            "No channel selected"
          )}
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          showing{" "}
          <span className="font-medium">{messages.length.toLocaleString()}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {messages.length === 0 ? (
          <div className="px-4 py-8">
            <div className="text-sm text-gray-700 dark:text-gray-200 font-medium">
              No messages match your current filters.
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 transition"
                onClick={clearFilters}
              >
                Clear filters
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={setRangeAll}
              >
                Set range: all
              </button>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Tip: open Filters for from/to/via/hops flags.
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 flex flex-col overflow-hidden">
            <Virtuoso
              key={selectedChannel ?? "ch"}
              ref={virtuosoRef}
              style={{ flex: 1, minHeight: 0, height: "100%" }}
              totalCount={messages.length}
              computeItemKey={(index) => {
                const m: any = (messages as any[])[index];
                return `${selectedChannel ?? "ch"}-${String(m?.id ?? index)}`;
              }}
              itemContent={(index) => {
                const m: any = (messages as any[])[index];

                const fromId = String(m.from ?? "");
                const toId = String(m.to ?? "");
                const msgId = String(m.id ?? `${index}`);
                const isSelected = urlMsg && msgId === String(urlMsg);

                const fromNode = nodes?.[fromId] || null;

                const viaIds = Array.isArray(m.sender)
                  ? m.sender.map((x: any) => String(x))
                  : [];
                const viaNodes = viaIds.map((sid) => nodes?.[sid]).filter(Boolean);

                const distanceFromSender =
                  fromNode?.position && viaNodes.length
                    ? viaNodes
                        .filter((s: any) => s?.position)
                        .map((s: any) => calculateDistanceBetweenNodes(fromNode, s))
                        .filter(Boolean)
                    : [];

                const dxStr = distanceFromSender?.length
                  ? distanceFromSender.map((d: any) => `${d} km`).join(", ")
                  : "";

                const focusId = urlNode.trim();
                const thisInFocus =
                  focusId &&
                  (fromId === focusId ||
                    toId === focusId ||
                    (urlFocus === "any" && viaIds.includes(focusId)));

                return (
                  <div
                    id={`msg-${msgId}`}
                    className={[
                      "px-4 py-3 cursor-pointer transition outline-none border-b border-gray-200 dark:border-gray-800",
                      isSelected
                        ? "bg-indigo-50/70 dark:bg-indigo-900/20 ring-1 ring-indigo-400/30"
                        : "hover:bg-gray-50 dark:hover:bg-gray-900/30",
                      thisInFocus ? "ring-1 ring-indigo-400/15" : "",
                    ].join(" ")}
                    onClick={() => setParam("msg", msgId, "push")}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <NodeChip
                          nodeId={fromId}
                          nodes={nodes}
                          fallback="UNK"
                          titlePrefix="From"
                          compact
                          stopPropagation
                          onFocus={(id) => applyFocus(id)}
                        />
                        <span className="text-gray-400">→</span>

                        {isBroadcast(toId) ? (
                          <span className="rounded-md px-2 py-0.5 text-[11px] font-medium bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
                            ALL
                          </span>
                        ) : (
                          <NodeChip
                            nodeId={toId}
                            nodes={nodes}
                            fallback="UNK"
                            titlePrefix="To"
                            compact
                            stopPropagation
                            onFocus={(id) => applyFocus(id)}
                          />
                        )}

                        <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                          hops {m.hops_away ?? 0}
                        </span>

                        {!isBroadcast(toId) ? (
                          <span className="rounded-full px-2 py-0.5 text-[11px] bg-indigo-100/70 dark:bg-indigo-800/30 text-indigo-900 dark:text-indigo-100">
                            DM
                          </span>
                        ) : (
                          <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                            BC
                          </span>
                        )}

                        {dxStr ? (
                          <span className="rounded-full px-2 py-0.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200">
                            dx {dxStr}
                          </span>
                        ) : null}
                      </div>

                      <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatTimestamp(m.timestamp) || "Unknown"}
                      </div>
                    </div>

                    <div className="mt-2 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words">
                      {renderHighlightedText(String(m.text ?? ""), urlQ)}
                    </div>

                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                      via:{" "}
                      {viaNodes.length ? (
                        viaNodes.map((s: any, i: number) => (
                          <span key={`via-${msgId}-${s.id}-${i}`}>
                            <Link
                              to={`/nodes/${s.id}`}
                              className="underline hover:no-underline"
                              title={`${s.id} / ${s.longname}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {s.shortname ?? "UNK"}
                            </Link>
                            {i < viaNodes.length - 1 ? ", " : ""}
                          </span>
                        ))
                      ) : (
                        <span className="text-gray-500">UNK</span>
                      )}
                    </div>
                  </div>
                );
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
