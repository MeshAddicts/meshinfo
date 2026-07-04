/** In-flight cap for bulk tile fetches. Browsers cap per-host themselves; Node
 *  (undici) does not, and hundreds of parallel sockets get ECONNRESET. */
const TILE_FETCH_LANES = 24;

/** Outage-shaped failures: worth one retry, and counted so the coverage-worker
 *  can abort a bake rather than cache degraded margins. Everything else (4xx,
 *  corrupt/undecodable tile) is deterministic — retrying can't fix it and
 *  aborting would stall forever, so those degrade to `failValue` like a 404. */
function isTransientFailure(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /HTTP 5\d\d|TimeoutError|AbortError|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network/i.test(msg);
}

/** Transient failures get up to this many retries with linear backoff. Cold
 *  first bakes pull thousands of tiles through ~4 concurrent pools; S3 timeouts
 *  and keep-alive races ("other side closed") are routine at that scale, and a
 *  single surviving failure aborts + restarts the whole coverage bake. */
const TRANSIENT_RETRIES = 3;
const RETRY_BACKOFF_MS = 500;

/**
 * Fetch tiles into `out` with bounded concurrency and retries for transient
 * failures (timeouts, 5xx, dropped sockets); failed tiles get `failValue`.
 * Returns the TRANSIENT failure count so callers can distinguish an outage
 * from tiles that simply aren't baked or are permanently bad.
 */
export async function fetchTilesPooled<T>(
  wanted: Array<{ key: string; x: number; y: number }>,
  fetchOne: (x: number, y: number) => Promise<T>,
  out: Map<string, T>,
  failValue: T,
  label: string,
): Promise<number> {
  let failureCount = 0;
  let i = 0;
  const lanes = Array.from({ length: Math.min(TILE_FETCH_LANES, wanted.length) }, async () => {
    while (i < wanted.length) {
      const t = wanted[i++];
      try {
        for (let attempt = 0; ; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
          try {
            out.set(t.key, await fetchOne(t.x, t.y));
            break;
          } catch (err) {
            if (!isTransientFailure(err) || attempt >= TRANSIENT_RETRIES) throw err;
          }
        }
      } catch (err) {
        if (isTransientFailure(err)) failureCount += 1;
        console.warn(label, err);
        out.set(t.key, failValue);
      }
    }
  });
  await Promise.all(lanes);
  return failureCount;
}
