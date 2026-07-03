import { ReactNode, useEffect, useState } from "react";

import { env } from "../env";
import { useAppDispatch } from "../hooks";
import { LiveEventsContext } from "../hooks/useLiveEvent";
import { apiSlice } from "../slices/apiSlice";
import { chatPinged } from "../slices/appSlice";
import { transformNode } from "../slices/nodeTransform";
import { INode } from "../types";
import { liveNodeFlushGate } from "../utils/liveGate";

// Same base as RTK Query, so the stream uses the same proxy route as REST.
const EVENTS_URL = `${env.API_BASE_URL ?? window.location.origin}/v1/events`;

// Coalesce node bursts into one cache write per window.
const FLUSH_MS = 400;

// Handles node + chat internally; exposes the EventSource for other event types.
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const [source, setSource] = useState<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(EVENTS_URL);
    setSource(es);

    const pending = new Map<string, INode>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      if (liveNodeFlushGate.suspended) {
        // Camera tour in progress — keep coalescing, retry shortly
        flushTimer = setTimeout(flush, 500);
        return;
      }
      const batch = Array.from(pending.values());
      pending.clear();
      // Patch both known getNodes args (no-op if uncached).
      dispatch(
        apiSlice.util.updateQueryData("getNodes", undefined, (draft) => {
          for (const node of batch) draft[node.id] = node;
        }),
      );
      dispatch(
        apiSlice.util.updateQueryData("getNodes", { status: "online" }, (draft) => {
          for (const node of batch) draft[node.id] = node;
        }),
      );
    };

    const onOpen = () => {
      // Resync on (re)connect.
      dispatch(apiSlice.util.invalidateTags([{ type: "Node", id: "LIST" }]));
      dispatch(chatPinged());
    };
    const onNode = (event: Event) => {
      let node: INode;
      try {
        node = transformNode(JSON.parse((event as MessageEvent).data) as INode);
      } catch {
        return;
      }
      if (!node?.id) return;
      pending.set(node.id, node);
      if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    const onChat = () => dispatch(chatPinged());

    es.addEventListener("open", onOpen);
    es.addEventListener("node", onNode);
    es.addEventListener("chat", onChat);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("node", onNode);
      es.removeEventListener("chat", onChat);
      es.close();
      setSource(null);
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [dispatch]);

  return (
    <LiveEventsContext.Provider value={source}>
      {children}
    </LiveEventsContext.Provider>
  );
}
