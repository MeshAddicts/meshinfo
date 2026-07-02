/** HTTP lookup: which nodes cover a point, sorted by margin. Samples the
 *  per-node margin cache directly (4 bytes per candidate), no tile decode. */
import { open, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { hashKey, type NodeCacheHeader } from "./cache";
import * as cfg from "./config";

interface ActiveNode {
  header: NodeCacheHeader;
  binPath: string;
}

let stateRaw = "";
let active: ActiveNode[] = [];
let refreshing: Promise<void> | null = null;

/** Reload the active-node headers when state.json (atomic with the tiles) changes. */
async function refreshActive(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(cfg.OUTPUT_DIR, "state.json"), "utf8");
  } catch {
    stateRaw = "";
    active = [];
    return;
  }
  if (raw === stateRaw) return;
  const state = JSON.parse(raw) as { active: Record<string, string> };
  const loaded = await Promise.all(
    Object.keys(state.active).map(async (id): Promise<ActiveNode | null> => {
      try {
        const base = join(cfg.CACHE_DIR, "nodes", hashKey(id));
        const header = JSON.parse(await readFile(`${base}.json`, "utf8")) as NodeCacheHeader;
        return header.id === id ? { header, binPath: `${base}.bin` } : null;
      } catch {
        return null; // missing/torn entry: not hover-resolvable until the next bake
      }
    }),
  );
  stateRaw = raw;
  active = loaded.filter((n): n is ActiveNode => n != null);
}

/** Single-flight wrapper so concurrent requests share one refresh. */
function ensureActive(): Promise<void> {
  refreshing ??= refreshActive().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Bilinear margin (dB) at lng/lat from two 2-byte row reads; NaN when outside
 *  bounds or any corner is the NaN sentinel (mirrors cache.marginQ8At). */
async function sampleNode(n: ActiveNode, lng: number, lat: number): Promise<number> {
  const { west, south, east, north } = n.header.bounds;
  const { width, height } = n.header;
  const fx = ((lng - west) / (east - west)) * (width - 1);
  const fy = ((north - lat) / (north - south)) * (height - 1);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > width - 1 || fy < 0 || fy > height - 1) {
    return Number.NaN;
  }
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const len = x1 - x0 + 1;
  const row0 = Buffer.alloc(len);
  const row1 = Buffer.alloc(len);
  const fh = await open(n.binPath, "r");
  try {
    await fh.read(row0, 0, len, y0 * width + x0);
    await fh.read(row1, 0, len, y1 * width + x0);
  } finally {
    await fh.close();
  }
  const q00 = row0[0];
  const q10 = row0[len - 1];
  const q01 = row1[0];
  const q11 = row1[len - 1];
  if (q00 === 0 || q10 === 0 || q01 === 0 || q11 === 0) return Number.NaN;
  const tx = fx - x0;
  const ty = fy - y0;
  const top = q00 + (q10 - q00) * tx;
  const bot = q01 + (q11 - q01) * tx;
  return (top + (bot - top) * ty - 1) / 4 - 20;
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
      await ensureActive();
      const candidates = active.filter(({ header: { bounds: b } }) => lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north);
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
    void ensureActive(); // warm the header cache so the first query is fast
  });
}
