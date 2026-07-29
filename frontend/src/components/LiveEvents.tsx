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
const API_BASE = env.API_BASE_URL ?? window.location.origin;
const EVENTS_URL = `${API_BASE}/v1/events`;

// Coalesce node bursts into one cache write per window.
const FLUSH_MS = 400;

// Only resync the node list after a reconnect if the stream was actually
// down long enough to have missed meaningful state. Short blips (proxy restart,
// wifi hiccup) cost nothing; the next SSE events catch us up.
const RESYNC_DOWN_MS = 30_000;

// Delta resync: ask the server only for nodes seen since the gap started,
// with a 2-minute overlap against clock skew and in-flight events. Past a
// 60-minute gap, fall back to the full ~1.4 MB refetch — an old cache plus a
// giant delta isn't worth it, and nodes that fell out of the server's 7-day
// window are never dropped by deltas.
const RESYNC_DELTA_OVERLAP_MS = 120_000;
const RESYNC_DELTA_MAX_GAP_MS = 60 * 60_000;

// Handles node + chat internally; exposes the EventSource for other event types.
export function LiveEventsProvider({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const [source, setSource] = useState<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(EVENTS_URL);
    setSource(es);

    const pending = new Map<string, INode>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // Patch both known getNodes args (no-op if uncached). Shared by the SSE
    // flush and the delta resync so both write byte-identical cache entries.
    const patchNodeCaches = (batch: INode[]) => {
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
      patchNodeCaches(batch);
    };

    // Delta window basis: lastActivityAt captured when the resync is TRIGGERED
    // (onOpen). By the time a hidden-tab resync actually runs, post-reconnect
    // events have already bumped lastActivityAt past the gap it must cover.
    let resyncSinceBasis = Date.now();
    let resyncInFlight = false;
    // A reconnect while a resync is in flight must not be LOST — onOpen has
    // already burned its cooldown slot and basis by the time it calls us, and
    // on flaky networks a hung fetch could otherwise eat resyncs for minutes.
    let resyncQueued = false;
    const resync = async () => {
      dispatch(chatPinged());
      if (resyncInFlight) {
        resyncQueued = true;
        return;
      }
      resyncInFlight = true;
      try {
        // Bounded gap → fetch only nodes seen since it opened (a few KB)
        // instead of invalidating the full ~1.4 MB list.
        if (Date.now() - resyncSinceBasis <= RESYNC_DELTA_MAX_GAP_MS) {
          try {
            const since = Math.floor((resyncSinceBasis - RESYNC_DELTA_OVERLAP_MS) / 1000);
            const res = await fetch(`${API_BASE}/v1/nodes?slim=1&since=${since}`, {
              // Bound the wait: the flaky networks that trigger resyncs are the
              // ones where a fetch can hang toward the browser's ~300s default.
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) throw new Error(`delta resync HTTP ${res.status}`);
            const body = (await res.json()) as { nodes?: Record<string, INode> };
            if (body?.nodes == null || typeof body.nodes !== "object") {
              throw new Error("delta resync: malformed response");
            }
            // An older backend ignores `since` and returns the full node set —
            // the same upsert applies it wholesale (correct, just not a delta).
            const batch = Object.values(body.nodes)
              .map(transformNode)
              .filter((n) => n?.id);
            if (batch.length > 0) patchNodeCaches(batch);
            return;
          } catch {
            // Network error / timeout / non-OK / bad JSON — fall through.
          }
        }
        dispatch(apiSlice.util.invalidateTags([{ type: "Node", id: "LIST" }]));
      } finally {
        resyncInFlight = false;
        if (resyncQueued) {
          // Re-run with the newer basis onOpen already stored; if this run
          // fell back to a full refetch, the rerun's delta is a cheap no-op.
          resyncQueued = false;
          void resync();
        }
      }
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
      // Snapshot before any post-reconnect event bumps lastActivityAt.
      resyncSinceBasis = lastActivityAt;
      if (document.hidden) {
        // Defer to a single catch-up when the tab becomes visible.
        pendingResync = true;
        return;
      }
      void resync();
    };
    const onVisible = () => {
      if (document.hidden) return;
      if (pendingResync) {
        pendingResync = false;
        void resync();
        pending.clear(); // the resync supersedes anything coalesced
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
