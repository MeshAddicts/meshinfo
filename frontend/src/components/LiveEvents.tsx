import { useLiveEvents } from "../hooks/useLiveEvents";

/**
 * Owns the single, app-wide SSE connection to /v1/events (via useLiveEvents)
 * and renders nothing. Mount once near the store Provider.
 */
export function LiveEvents() {
  useLiveEvents(true);
  return null;
}
