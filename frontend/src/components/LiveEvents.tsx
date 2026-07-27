import { ReactNode, useEffect, useState } from "react";

import { env } from "../env";
import { useAppDispatch } from "../hooks/redux";
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

// Only refetch the full node list after a reconnect if the stream was actually
// down long enough to have missed meaningful state. Short blips (proxy restart,
// wifi hiccup) cost nothing; the next SSE events catch us up.
const RESYNC_DOWN_MS = 30_000;

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
      // Hidden tab: keep coalescing (bounded by node count — pending is keyed
      // by id) but skip the dispatch; the whole downstream pipeline (Map
      // re-render, derived-node rebuild, GeoJSON upload) is wasted work the
      // user can't see. One catch-up flush runs on visibilitychange.
      if (document.hidden) return;
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

    const resync = () => {
      dispatch(apiSlice.util.invalidateTags([{ type: "Node", id: "LIST" }]));
      dispatch(chatPinged());
    };

    // `open` fires on the FIRST connect too — when useGetNodesQuery's initial
    // fetch is already in flight — so resyncing there double-fetched the full
    // node list at every page load. EventSource also auto-reconnects (~3s) after
    // every sleep/blip, and each of those used to refetch the full list as well.
    let hadOpened = false;
    let disconnectedAt: number | null = null;
    let pendingResync = false;
    // Sleep freezes the tab ('error' only fires at wake, seconds before the
    // reconnect 'open') and connection flapping resets the error clock each
    // cycle — the error→open gap alone under-measures both. Time since the
    // last DELIVERED event catches them; the cooldown keeps the quiet-mesh /
    // flapping cases from resyncing on every reopen.
    let lastActivityAt = Date.now();
    let lastResyncAt = 0;
    const RESYNC_COOLDOWN_MS = 60_000;
    const onError = () => {
      if (disconnectedAt === null) disconnectedAt = Date.now();
    };
    const onOpen = () => {
      const now = Date.now();
      const errDownMs = disconnectedAt === null ? 0 : now - disconnectedAt;
      disconnectedAt = null;
      const quietMs = now - lastActivityAt;
      const firstOpen = !hadOpened;
      hadOpened = true;
      // First connect: the initial queries are already fetching — skip unless
      // the stream itself took >30s to come up (events missed in the gap).
      const downMs = firstOpen ? errDownMs : Math.max(errDownMs, quietMs);
      if (downMs < RESYNC_DOWN_MS) return;
      if (now - lastResyncAt < RESYNC_COOLDOWN_MS) return;
      lastResyncAt = now;
      if (document.hidden) {
        // Defer to a single catch-up when the tab becomes visible.
        pendingResync = true;
        return;
      }
      resync();
    };
    const onVisible = () => {
      if (document.hidden) return;
      if (pendingResync) {
        pendingResync = false;
        resync();
        pending.clear(); // the refetch supersedes anything coalesced
        return;
      }
      flush();
    };
    const onNode = (event: Event) => {
      lastActivityAt = Date.now();
      let node: INode;
      try {
        node = transformNode(JSON.parse((event as MessageEvent).data) as INode);
      } catch {
        return;
      }
      if (!node?.id) return;
      pending.set(node.id, node);
      // Hidden tab: no timer — onVisible flushes the coalesced batch.
      if (flushTimer === null && !document.hidden) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    const onChat = () => {
      lastActivityAt = Date.now();
      dispatch(chatPinged());
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("node", onNode);
    es.addEventListener("chat", onChat);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("node", onNode);
      es.removeEventListener("chat", onChat);
      document.removeEventListener("visibilitychange", onVisible);
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
