/** HTTP lookup: which nodes cover a point, sorted by margin. Samples the
 *  per-node margin cache directly (4 bytes per candidate), no tile decode. */
import { open, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { bilinearMarginQ8, GRID_PREFIX_BYTES, gridFraction, hashKey, type NodeCacheHeader } from "./cache";
import * as cfg from "./config";

interface ActiveNode {
  header: NodeCacheHeader;
  binPath: string;
}

interface GroupCache {
  /** mtime:size of the group's state.json — cheaper change detection than
   *  re-reading and string-comparing the whole file per hover. */
  stamp: string;
  active: ActiveNode[];
  refreshing: Promise<void> | null;
}

/** Per-group ("all", "LongFast", …) active-node caches. LRU-capped: the group
 *  name is client-supplied (regex-valid but arbitrary), so unbounded growth
 *  would let a scanner inflate memory one probe at a time. */
const groupCaches = new Map<string, GroupCache>();
const MAX_GROUP_CACHES = 16;
const GROUP_NAME_RE = /^[A-Za-z0-9-]{1,32}$/;

/** Reload a group's active-node headers when its state.json (atomic with the
 *  tiles) changes. */
async function refreshActive(group: string, cache: GroupCache): Promise<void> {
  const statePath = join(cfg.OUTPUT_DIR, group, "state.json");
  let raw: string;
  let stamp: string;
  try {
    const st = await stat(statePath);
    stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === cache.stamp) return;
    raw = await readFile(statePath, "utf8");
  } catch {
    cache.stamp = "";
    cache.active = [];
    return;
  }
  let ids: string[];
  try {
    ids = Object.keys((JSON.parse(raw) as { active: Record<string, unknown> }).active ?? {});
  } catch {
    cache.stamp = "";
    cache.active = [];
    return;
  }
  const loaded = await Promise.all(
    ids.map(async (id): Promise<ActiveNode | null> => {
      try {
        const base = join(cfg.CACHE_DIR, "nodes", hashKey(id));
        const header = JSON.parse(await readFile(`${base}.json`, "utf8")) as NodeCacheHeader;
        return header.id === id ? { header, binPath: `${base}.bin` } : null;
      } catch {
        return null; // missing/torn entry: not hover-resolvable until the next bake
      }
    }),
  );
  cache.stamp = stamp;
  cache.active = loaded.filter((n): n is ActiveNode => n != null);
}

/** Single-flight per group so concurrent requests share one refresh. */
function ensureActive(group: string): Promise<GroupCache> {
  let cache = groupCaches.get(group);
  if (cache) {
    groupCaches.delete(group); // re-insert → mark most-recently-used
  } else {
    cache = { stamp: "", active: [], refreshing: null };
    while (groupCaches.size >= MAX_GROUP_CACHES) {
      const oldest = groupCaches.keys().next().value;
      if (oldest === undefined) break;
      groupCaches.delete(oldest);
    }
  }
  groupCaches.set(group, cache);
  const c = cache;
  c.refreshing ??= refreshActive(group, c).finally(() => {
    c.refreshing = null;
  });
  return c.refreshing.then(() => c);
}

/** Bilinear margin (dB) at lng/lat from two 2-byte row reads; NaN when outside
 *  bounds or any corner is the NaN sentinel. Projection + dequantization are
 *  the same helpers the bake's compositor uses (cache.ts), so hover and tiles
 *  can't disagree. */
async function sampleNode(n: ActiveNode, lng: number, lat: number): Promise<number> {
  const { width, height, stateKey } = n.header;
  const f = gridFraction(n.header.bounds, width, height, lng, lat);
  if (!f) return Number.NaN;
  const x0 = Math.floor(f.fx);
  const y0 = Math.floor(f.fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const len = x1 - x0 + 1;
  const prefix = Buffer.alloc(GRID_PREFIX_BYTES);
  const row0 = Buffer.alloc(len);
  const row1 = Buffer.alloc(len);
  const fh = await open(n.binPath, "r");
  try {
    // A bake may have atomically swapped this bin since the header was cached —
    // a moved node keeps its dimensions, so a size check alone can't catch it.
    // The embedded stateKey pins the bin to the header that describes it.
    const { size } = await fh.stat();
    if (size !== GRID_PREFIX_BYTES + width * height) return Number.NaN;
    await fh.read(prefix, 0, GRID_PREFIX_BYTES, 0);
    if (prefix.toString("utf8") !== stateKey) return Number.NaN;
    await fh.read(row0, 0, len, GRID_PREFIX_BYTES + y0 * width + x0);
    await fh.read(row1, 0, len, GRID_PREFIX_BYTES + y1 * width + x0);
  } finally {
    await fh.close();
  }
  return bilinearMarginQ8(row0[0], row0[len - 1], row1[0], row1[len - 1], f.fx - x0, f.fy - y0);
}

const MAX_ENTRIES = 12;

export function startLookupServer(): void {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/lookup") {
        res.writeHead(404).end();
        return;
      }
      const lng = Number(url.searchParams.get("lng"));
      const lat = Number(url.searchParams.get("lat"));
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad lng/lat" }));
        return;
      }
      const group = url.searchParams.get("group") ?? "all";
      if (!GROUP_NAME_RE.test(group)) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad group" }));
        return;
      }
      const { active } = await ensureActive(group);
      // Footprint bounds may be unwrapped past ±180 (seam frame) — shift the
      // query lng into each node's frame before the containment test.
      const candidates = active.filter(({ header: { bounds: b } }) => {
        const sLng = lng < b.west ? lng + 360 : lng > b.east ? lng - 360 : lng;
        return sLng >= b.west && sLng <= b.east && lat >= b.south && lat <= b.north;
      });
      const sampled = await Promise.all(
        candidates.map(async (n) => {
          try {
            return { id: n.header.id, marginDb: await sampleNode(n, lng, lat) };
          } catch {
            return { id: n.header.id, marginDb: Number.NaN }; // unreadable mid-bake: skip
          }
        }),
      );
      const entries = sampled
        .filter((e) => !Number.isNaN(e.marginDb) && e.marginDb >= 0)
        .map((e) => ({ id: e.id, marginDb: Math.round(e.marginDb * 10) / 10 }))
        .sort((a, b) => b.marginDb - a.marginDb);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      res.end(JSON.stringify({ total: entries.length, entries: entries.slice(0, MAX_ENTRIES) }));
    })().catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "lookup failed" }));
    });
  });
  server.on("error", (err) => {
    console.warn(`[coverage-worker] lookup server failed (:${cfg.LOOKUP_PORT}) — hover lookup disabled:`, err.message);
  });
  server.listen(cfg.LOOKUP_PORT, () => {
    console.log(`[coverage-worker] lookup server on :${cfg.LOOKUP_PORT}`);
    void ensureActive("all"); // warm the header cache so the first query is fast
  });
}
