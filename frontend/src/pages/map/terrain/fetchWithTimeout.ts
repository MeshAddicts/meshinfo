/** fetch() that aborts after timeoutMs so one hung tile can't stall a build
 *  forever. Throws an abort the tile callers already handle as a failed tile. */
export function fetchWithTimeout(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; init?: RequestInit } = {},
): Promise<Response> {
  const { timeoutMs = 15000, signal, init } = opts;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Tile fetch timed out", "TimeoutError")),
    timeoutMs,
  );
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  });
}
