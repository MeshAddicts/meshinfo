import { createContext, useContext, useEffect, useRef } from "react";

// The app-wide EventSource (owned by LiveEventsProvider), shared so any page can
// subscribe to extra event types on the one connection.
export const LiveEventsContext = createContext<EventSource | null>(null);

// Subscribe to a named SSE event (e.g. "packet") on the shared connection.
export function useLiveEvent<T = unknown>(
  type: string,
  handler: (data: T) => void,
): void {
  const source = useContext(LiveEventsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!source) return;
    const listener = (event: Event) => {
      let data: T;
      try {
        data = JSON.parse((event as MessageEvent).data) as T;
      } catch {
        return;
      }
      handlerRef.current(data);
    };
    source.addEventListener(type, listener);
    return () => source.removeEventListener(type, listener);
  }, [source, type]);
}
