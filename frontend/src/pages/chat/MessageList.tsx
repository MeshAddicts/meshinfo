import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { copyTextToClipboard } from "../../utils/clipboard";
import { formatTimestamp } from "../../utils/formatTimestamp";
import { calculateDistanceBetweenNodes } from "../../utils/getDistanceBetweenTwoNodes";
import { isBroadcast, renderHighlightedText } from "./chatUtils";
import { NodeChip } from "./NodeChip";

type FollowEdge = "top" | "bottom";

const buildMessagePermalink = (msgId: string) => {
  const mid = String(msgId ?? "").trim();
  if (!mid) return window.location.href;

  try {
    const u = new URL(window.location.href);
    u.searchParams.set("msg", mid);
    return u.toString();
  } catch {
    return window.location.href;
  }
};

type MessageRowProps = {
  m: any;
  msgId: string;
  fromId: string;
  toId: string;
  fromNode: any;
  toNode: any;
  viaNodes: any[];
  isSelected: boolean;
  isFlashing: boolean;
  isCopied: boolean;
  thisInFocus: boolean;
  urlQ: string;
  onSelect: (msgId: string) => void;
  onCopyLink: (msgId: string) => void;
  onFocusNode: (id: string) => void;
};

// viaNodes gets a fresh array identity per dispatch, so compare it element-wise
function areRowPropsEqual(prev: MessageRowProps, next: MessageRowProps) {
  if (
    prev.m !== next.m ||
    prev.msgId !== next.msgId ||
    prev.fromId !== next.fromId ||
    prev.toId !== next.toId ||
    prev.fromNode !== next.fromNode ||
    prev.toNode !== next.toNode ||
    prev.isSelected !== next.isSelected ||
    prev.isFlashing !== next.isFlashing ||
    prev.isCopied !== next.isCopied ||
    prev.thisInFocus !== next.thisInFocus ||
    prev.urlQ !== next.urlQ ||
    prev.onSelect !== next.onSelect ||
    prev.onCopyLink !== next.onCopyLink ||
    prev.onFocusNode !== next.onFocusNode
  ) {
    return false;
  }
  if (prev.viaNodes.length !== next.viaNodes.length) return false;
  for (let i = 0; i < prev.viaNodes.length; i++) {
    if (prev.viaNodes[i] !== next.viaNodes[i]) return false;
  }
  return true;
}

const MessageRow = memo(function MessageRow({
  m,
  msgId,
  fromId,
  toId,
  fromNode,
  toNode,
  viaNodes,
  isSelected,
  isFlashing,
  isCopied,
  thisInFocus,
  urlQ,
  onSelect,
  onCopyLink,
  onFocusNode,
}: MessageRowProps) {
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

  return (
    <div
      id={`msg-${msgId}`}
      className={[
        "group px-4 py-3 cursor-pointer transition outline-hidden border-b border-gray-200 dark:border-gray-800",
        isSelected
          ? "bg-indigo-50/70 dark:bg-indigo-900/20 ring-1 ring-indigo-400/30"
          : "hover:bg-gray-50 dark:hover:bg-gray-900/30",
        thisInFocus ? "ring-1 ring-indigo-400/15" : "",
        isFlashing
          ? "animate-pulse ring-2 ring-amber-400/40 bg-amber-50/60 dark:bg-amber-900/10"
          : "",
      ].join(" ")}
      onClick={() => onSelect(msgId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(msgId);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <NodeChip
            nodeId={fromId}
            nodes={{ [fromId]: fromNode }}
            fallback="UNK"
            titlePrefix="From"
            compact
            stopPropagation
            onFocus={onFocusNode}
          />
          <span className="text-gray-400">→</span>

          {isBroadcast(toId) ? (
            <span className="rounded-md px-2 py-0.5 text-[11px] font-medium bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300">
              ALL
            </span>
          ) : (
            <NodeChip
              nodeId={toId}
              nodes={{ [toId]: toNode }}
              fallback="UNK"
              titlePrefix="To"
              compact
              stopPropagation
              onFocus={onFocusNode}
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

        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {isCopied ? (
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              Copied
            </span>
          ) : null}

          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 transition rounded-md px-2 py-1 border border-gray-300/50 dark:border-gray-700 hover:bg-gray-100/60 dark:hover:bg-gray-800/40"
            title="Copy permalink to this message"
            aria-label="Copy message permalink"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(msgId);
              onCopyLink(msgId);
            }}
          >
            🔗
          </button>

          <span>{formatTimestamp(m.timestamp) || "Unknown"}</span>
        </div>
      </div>

      <div className="mt-2 text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap wrap-break-word">
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
}, areRowPropsEqual);

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
  urlSort,
  setParam,
  applyFocus,
  clearFilters,
  setRangeAll,
  virtuosoRef,
  liveEnabled,
  setLiveEnabled,
  followEdge,
  filtersSig,
  onFollowStateChange,
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
  urlSort: "desc" | "asc";
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
  applyFocus: (nodeId: string) => void;
  clearFilters: () => void;
  setRangeAll: () => void;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  liveEnabled: boolean;
  setLiveEnabled: (v: boolean) => void;
  followEdge: FollowEdge;
  filtersSig: string;
  onFollowStateChange?: (s: {
    atEdge: boolean;
    selectionPinned: boolean;
    newCount: number;
  }) => void;
}) {
  const EDGE_BUFFER_ITEMS = 2;

  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const isAtEdge = followEdge === "bottom" ? atBottom : atTop;

  // If a msg is selected, we treat that as “pinned view”
  const selectionPinned = !!String(urlMsg ?? "").trim();

  // When live is enabled AND you’re at the live edge AND no selection is pinned,
  // we consider new messages “consumed”.
  const shouldAutoFollow = liveEnabled && isAtEdge && !selectionPinned;

  // Track "new messages" count when paused
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(0);
  const prevEdgeIdRef = useRef<string>("");
  const prevSigRef = useRef<string>("");

  const edgeMsgId = useMemo(() => {
    if (!messages.length) return "";
    const m =
      followEdge === "top" ? messages[0] : messages[messages.length - 1];
    return String(m?.id ?? "");
  }, [messages, followEdge]);

  // Report follow state upwards so the header can reflect "Paused"/"Pinned" accurately.
  const lastReportedRef = useRef<string>("");
  useEffect(() => {
    if (!onFollowStateChange) return;

    const payload = {
      atEdge: !!isAtEdge,
      selectionPinned: !!selectionPinned,
      newCount: Number(newCount ?? 0),
    };

    const key = `${payload.atEdge}-${payload.selectionPinned}-${payload.newCount}`;
    if (lastReportedRef.current === key) return;

    lastReportedRef.current = key;
    onFollowStateChange(payload);
  }, [isAtEdge, selectionPinned, newCount, onFollowStateChange]);

  // Reset pause counters when filters/sort/channel changes
  useEffect(() => {
    if (prevSigRef.current === filtersSig) return;

    prevSigRef.current = filtersSig;
    prevLenRef.current = messages.length;
    prevEdgeIdRef.current = edgeMsgId;
    setNewCount(0);

    // Reset edge assumptions so we don’t incorrectly show “paused” before Virtuoso reports range.
    setAtTop(true);
    setAtBottom(true);
  }, [filtersSig, messages.length, edgeMsgId]);

  // When new data arrives, increment counter if paused; clear if following.
  useEffect(() => {
    if (!messages.length) {
      prevLenRef.current = 0;
      prevEdgeIdRef.current = edgeMsgId;
      setNewCount(0);
      return;
    }

    const prevLen = prevLenRef.current;
    const prevEdge = prevEdgeIdRef.current;

    const len = messages.length;
    const edgeChanged =
      edgeMsgId && prevEdge ? String(edgeMsgId) !== String(prevEdge) : false;

    prevLenRef.current = len;
    prevEdgeIdRef.current = edgeMsgId;

    const deltaRaw = len - prevLen;
    if (deltaRaw <= 0 && !edgeChanged) return;

    const delta = deltaRaw > 0 ? deltaRaw : edgeChanged ? 1 : 0;
    if (delta <= 0) return;

    if (shouldAutoFollow) {
      setNewCount(0);
    } else {
      setNewCount((c) => Math.min(9999, c + delta));
    }
  }, [messages.length, edgeMsgId, shouldAutoFollow]);

  // If we resume following, clear counter
  useEffect(() => {
    if (shouldAutoFollow) setNewCount(0);
  }, [shouldAutoFollow]);

  // Top-edge follow (Virtuoso followOutput is bottom oriented)
  const lastTopFollowIdRef = useRef<string>("");
  useEffect(() => {
    if (followEdge !== "top") return;
    if (!liveEnabled) return;
    if (selectionPinned) return;
    if (!atTop) return;

    if (!edgeMsgId) return;
    if (lastTopFollowIdRef.current === edgeMsgId) return;
    lastTopFollowIdRef.current = edgeMsgId;

    virtuosoRef.current?.scrollToIndex({
      index: 0,
      align: "start",
      behavior: "smooth",
    });
  }, [followEdge, liveEnabled, selectionPinned, atTop, edgeMsgId, virtuosoRef]);

  const msgPresentInList = useMemo(() => {
    const mid = String(urlMsg ?? "").trim();
    if (!mid) return true;
    return (messages as any[]).some((m: any) => String(m?.id ?? "") === mid);
  }, [messages, urlMsg]);

  // Flash selected message briefly when it becomes available in the list
  const [flashMsgId, setFlashMsgId] = useState<string>("");
  useEffect(() => {
    const mid = String(urlMsg ?? "").trim();
    if (!mid) {
      setFlashMsgId("");
      return;
    }
    if (!msgPresentInList) {
      setFlashMsgId("");
      return;
    }

    setFlashMsgId(mid);
    const t = window.setTimeout(() => setFlashMsgId(""), 2000);
    return () => window.clearTimeout(t);
  }, [urlMsg, msgPresentInList, selectedChannel]);

  const [copiedMsgId, setCopiedMsgId] = useState<string>("");

  // Stable row callbacks: read latest handlers via refs so memoized rows survive URL churn
  const setParamRef = useRef(setParam);
  setParamRef.current = setParam;
  const applyFocusRef = useRef(applyFocus);
  applyFocusRef.current = applyFocus;

  const selectMessage = useCallback((msgId: string) => {
    setParamRef.current("msg", msgId, "push");
  }, []);

  const focusNode = useCallback((id: string) => {
    applyFocusRef.current(id);
  }, []);

  const copyMessageLink = useCallback(async (msgId: string) => {
    const mid = String(msgId ?? "").trim();
    if (!mid) return;

    const href = buildMessagePermalink(mid);
    const ok = await copyTextToClipboard(href);

    if (ok) {
      setCopiedMsgId(mid);
      window.setTimeout(() => setCopiedMsgId(""), 1200);
      return;
    }

    // last resort: manual copy prompt
    window.prompt("Copy message link:", href);
  }, []);

  const jumpToLive = () => {
    if (selectionPinned) setParam("msg", undefined, "push");

    setLiveEnabled(true);
    setNewCount(0);

    if (!messages.length) return;

    const index = followEdge === "top" ? 0 : Math.max(0, messages.length - 1);
    virtuosoRef.current?.scrollToIndex({
      index,
      align: followEdge === "top" ? "start" : "end",
      behavior: "smooth",
    });
  };

  // Dispatcher resolves memo-friendly props; MessageRow bails unless its data changed
  const itemContent = useCallback(
    (index: number) => {
      const m: any = (messages as any[])[index];

      const fromId = String(m.from ?? "");
      const toId = String(m.to ?? "");
      const msgId = String(m.id ?? `${index}`);

      const viaIds: string[] = Array.isArray(m.sender)
        ? m.sender.map((x: any) => String(x))
        : [];
      const viaNodes = viaIds
        .map((sid: string) => nodes?.[sid])
        .filter(Boolean);

      const focusId = urlNode.trim();
      const thisInFocus = !!(
        focusId &&
        (fromId === focusId ||
          toId === focusId ||
          (urlFocus === "any" && viaIds.includes(focusId)))
      );

      return (
        <MessageRow
          m={m}
          msgId={msgId}
          fromId={fromId}
          toId={toId}
          fromNode={nodes?.[fromId] ?? null}
          toNode={nodes?.[toId] ?? null}
          viaNodes={viaNodes}
          isSelected={!!urlMsg && msgId === String(urlMsg)}
          isFlashing={!!flashMsgId && flashMsgId === msgId}
          isCopied={copiedMsgId === msgId}
          thisInFocus={thisInFocus}
          urlQ={urlQ}
          onSelect={selectMessage}
          onCopyLink={copyMessageLink}
          onFocusNode={focusNode}
        />
      );
    },
    [
      messages,
      nodes,
      urlMsg,
      urlQ,
      urlNode,
      urlFocus,
      flashMsgId,
      copiedMsgId,
      selectMessage,
      copyMessageLink,
      focusNode,
    ]
  );

  const showPausedOverlay =
    (liveEnabled && !isAtEdge && messages.length > 0) ||
    selectionPinned ||
    newCount > 0;

  const pausedLabel = selectionPinned
    ? "Selection pinned"
    : liveEnabled
      ? "Paused"
      : "Live off";

  const overlayText =
    newCount > 0 ? `New messages (${newCount.toLocaleString()})` : pausedLabel;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col min-h-0 flex-1">
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
              <span className="ml-3 text-xs text-gray-500 dark:text-gray-400">
                • edge: {followEdge === "bottom" ? "bottom" : "top"}{" "}
                {urlSort === "asc" ? "(oldest→newest)" : "(newest→oldest)"}
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
        {urlMsg && !msgPresentInList && messages.length > 0 ? (
          <div className="px-4 py-3 border-b border-amber-300/40 dark:border-amber-700/40 bg-amber-50/60 dark:bg-amber-900/10">
            <div className="text-sm text-amber-900 dark:text-amber-100 font-medium">
              Selected message isn’t in the current view.
            </div>
            <div className="mt-1 text-xs text-amber-900/80 dark:text-amber-100/80">
              It may be outside the time range or filtered out. Try widening the
              range or clearing filters.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs bg-amber-600 text-white hover:bg-amber-700 transition"
                onClick={setRangeAll}
              >
                Set range: all
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs border border-amber-600/50 text-amber-900 dark:text-amber-100 hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition"
                onClick={clearFilters}
              >
                Clear filters
              </button>
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs border border-amber-600/30 text-amber-900/90 dark:text-amber-100/90 hover:bg-amber-100/40 dark:hover:bg-amber-900/10 transition"
                onClick={() => setParam("msg", undefined, "push")}
              >
                Clear selection
              </button>
            </div>
          </div>
        ) : null}

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
          <div className="h-full min-h-0 flex flex-col overflow-hidden relative">
            {showPausedOverlay ? (
              <div
                className={[
                  "pointer-events-none absolute z-10 left-1/2 -translate-x-1/2",
                  followEdge === "top" ? "top-3" : "bottom-3",
                ].join(" ")}
              >
                <button
                  type="button"
                  className={[
                    "pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-xs border transition",
                    newCount > 0
                      ? "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
                      : "bg-gray-900 text-white border-gray-900 hover:bg-gray-800",
                  ].join(" ")}
                  onClick={jumpToLive}
                  title={
                    selectionPinned
                      ? "Jump back to the live edge (also clears selection)"
                      : "Jump back to the live edge"
                  }
                >
                  {overlayText}
                  <span className="ml-2 opacity-90">•</span>
                  <span className="ml-2 underline decoration-white/40">
                    {selectionPinned || newCount > 0 ? "Jump" : "Back to live"}
                    <span className="ml-2 opacity-80">
                      {followEdge === "top" ? "↑" : "↓"}
                    </span>
                  </span>
                </button>
              </div>
            ) : null}

            <Virtuoso
              key={selectedChannel ?? "ch"}
              ref={virtuosoRef}
              style={{ flex: 1, minHeight: 0, height: "100%" }}
              totalCount={messages.length}
              rangeChanged={(r) => {
                const total = messages.length;
                const top = r.startIndex <= EDGE_BUFFER_ITEMS;
                const bottom =
                  r.endIndex >= Math.max(0, total - 1 - EDGE_BUFFER_ITEMS);
                setAtTop(top);
                setAtBottom(bottom);
              }}
              followOutput={
                (followEdge === "bottom"
                  ? ((isAtBottom: boolean) =>
                      liveEnabled && !selectionPinned && isAtBottom
                        ? "smooth"
                        : false)
                  : false) as any
              }
              computeItemKey={(index) => {
                const m: any = (messages as any[])[index];
                return `${selectedChannel ?? "ch"}-${String(m?.id ?? index)}`;
              }}
              itemContent={itemContent}
            />
          </div>
        )}
      </div>
    </div>
  );
}
