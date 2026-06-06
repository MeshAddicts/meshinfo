import { useEffect } from "react";

import { env } from "../env";
import { useAppDispatch } from "../hooks";
import { apiSlice } from "../slices/apiSlice";
import { chatPinged } from "../slices/appSlice";
import { transformNode } from "../slices/nodeTransform";
import { INode } from "../types";

// Anchored to the same base RTK Query uses (env.API_BASE_URL ?? origin) + /v1,
// so the stream follows the identical, already-working proxy route as every
// REST call (resolves to /api/v1/events behind Caddy in this deployment).
const EVENTS_URL = `${env.API_BASE_URL ?? window.location.origin}/v1/events`;

// Coalesce bursts of node updates into one cache write per window so a busy
// mesh (many packets/sec) can't trigger a React re-render per packet. Caps the
// node-driven cache churn at ~1 write / FLUSH_MS regardless of event rate.
const FLUSH_MS = 400;

/**
 * Owns the single, app-wide SSE connection to /v1/events and merges live
 * updates into the RTK Query cache:
 *  - `node` events are buffered and patched into the getNodes cache in place
 *    (no refetch); the Nodes list freezes itself when paused/scrolled.
 *  - `chat` events bump a redux ping; the Chat page refetches on change when
 *    its live toggle is on (so pause is respected and the vetted dedup/sort
 *    transform is reused rather than re-implemented here).
 * On every (re)connect we resync — invalidate the node list and ping chat — to
 * close any gap from a dropped stream. Mount exactly once (<LiveEvents/>).
 */
export function useLiveEvents(enabled: boolean): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(EVENTS_URL);
    const pending = new Map<string, INode>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      const batch = Array.from(pending.values());
      pending.clear();
      // Patch both known getNodes arg variants; a patch on an arg that isn't
      // currently cached is a silent no-op in RTK Query.
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

    es.onopen = () => {
      // Full resync on (re)connect: refetch the node list, ping chat.
      dispatch(apiSlice.util.invalidateTags([{ type: "Node", id: "LIST" }]));
      dispatch(chatPinged());
    };

    es.addEventListener("node", (event) => {
      let node: INode;
      try {
        node = transformNode(JSON.parse((event as MessageEvent).data) as INode);
      } catch {
        return;
      }
      if (!node?.id) return;
      pending.set(node.id, node);
      if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
    });

    es.addEventListener("chat", () => {
      dispatch(chatPinged());
    });

    return () => {
      es.close();
      if (flushTimer !== null) clearTimeout(flushTimer);
    };
  }, [enabled, dispatch]);
}
