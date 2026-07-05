/**
 * Coverage-worker entry.
 *   default : service — poll /v1/nodes, rebake on change (throttled) + 4h backstop, notify.
 *   --once  : single bake then exit.
 */
import { Worker } from "node:worker_threads";

import { fetchWithTimeout } from "../src/pages/map/terrain/fetchWithTimeout";
import type { BakeRequest, BakeResponse } from "./bakeWorker";
import {
  BACKSTOP_MS,
  MESHINFO_URL,
  MIN_RECOMPUTE_MS,
  POLL_INTERVAL_MS,
} from "./config";
import { installEnvShim } from "./envShim";
import { startLookupServer } from "./lookupServer";
import { type CoverageOrigin, fetchCoverageOrigins } from "./nodes";
import { bakeAllGroups, type BakeMetadata, cleanupLegacyLayout, terminateWorkerPool } from "./render";
import { installSharpDecoder } from "./sharpImage";

/** Persistent bake thread: keeps the lookup server responsive during bakes and
 *  the raster RAM cache warm across them. Any exit clears the reference so the
 *  next bake respawns a fresh thread instead of posting into a dead one. */
let bakeThread: Worker | null = null;

function bakeInThread(origins: CoverageOrigin[], version: string): Promise<BakeMetadata | null> {
  if (!bakeThread) {
    const spawned = new Worker(new URL("./bakeWorker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
    spawned.on("error", (err) => console.error("[coverage-worker] bake thread error:", err));
    spawned.on("exit", () => {
      if (bakeThread === spawned) bakeThread = null;
    });
    bakeThread = spawned;
  }
  const w = bakeThread;
  return new Promise<BakeMetadata | null>((resolve, reject) => {
    // Paired once-listeners with explicit cleanup: without it, one 'exit'
    // listener per bake accumulates on the long-lived thread.
    const cleanup = () => {
      w.off("message", onMessage);
      w.off("exit", onExit);
    };
    const onMessage = (msg: BakeResponse) => {
      cleanup();
      if ("err" in msg) reject(new Error(msg.err));
      else resolve(msg.ok);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("bake thread exited"));
    };
    w.once("message", onMessage);
    w.once("exit", onExit);
    w.postMessage({ origins, version } satisfies BakeRequest);
  });
}

/** Stable dirty-key: rebake only when the contributing set / positions / TX / preset change. */
function signatureOf(origins: CoverageOrigin[]): string {
  return origins
    .map((o) => `${o.id}:${o.lng.toFixed(5)}:${o.lat.toFixed(5)}:${o.altitudeM == null ? "_" : Math.round(o.altitudeM)}:${o.txDbm}:${o.preset}`)
    .sort()
    .join("|");
}

async function notifyMeshinfo(): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${MESHINFO_URL}/v1/coverage/notify`, {
      timeoutMs: 10_000,
      init: { method: "POST" }, // the endpoint reads the payload from disk; no body needed
    });
    if (!res.ok) console.warn(`[coverage-worker] notify HTTP ${res.status}`);
  } catch (err) {
    console.warn("[coverage-worker] notify failed:", err);
  }
}

async function bakeAndNotify(origins: CoverageOrigin[], inThread: boolean): Promise<BakeMetadata | null> {
  const t0 = Date.now();
  const meta = inThread ? await bakeInThread(origins, String(t0)) : await bakeAllGroups(origins, String(t0));
  if (!meta) {
    console.log("[coverage-worker] nothing to bake (no eligible nodes, no prior output)");
    return null;
  }
  console.log(
    `[coverage-worker] baked ${meta.tileCount} tiles (z${meta.minZoom}-${meta.maxZoom}) ` +
      `from ${meta.nodeCount} nodes across ${meta.groups.length} groups in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  await notifyMeshinfo();
  return meta;
}

export async function runOnce(): Promise<void> {
  const origins = await fetchCoverageOrigins(Date.now());
  console.log(`[coverage-worker] ${origins.length} eligible origins`);
  try {
    await bakeAndNotify(origins, false);
  } finally {
    await terminateWorkerPool(); // idle pool threads would keep --once alive forever
  }
}

async function runLoop(): Promise<void> {
  let lastSig: string | null = null;
  let lastBakeAt = 0;
  let baking = false;

  const tick = async () => {
    if (baking) return;
    // Claim the slot before the first await — with a slow /v1/nodes and a short
    // poll interval, two ticks could otherwise both reach bakeAndNotify.
    baking = true;
    try {
      const now = Date.now();
      let origins: CoverageOrigin[];
      try {
        origins = await fetchCoverageOrigins(now);
      } catch (err) {
        console.warn("[coverage-worker] node fetch failed:", err);
        return;
      }
      // An empty set still bakes (erasing stale tiles); bakeCoverage no-ops when
      // there's nothing on disk either.
      const sig = signatureOf(origins);
      const sinceLast = now - lastBakeAt;
      // The empty→populated transition skips the recompute gate: after a quiet
      // spell the first node deserves coverage immediately, not in 10 minutes.
      const changedAndReady = sig !== lastSig && (sinceLast >= MIN_RECOMPUTE_MS || lastSig === "");
      const backstop = sinceLast >= BACKSTOP_MS;
      if (lastSig !== null && !changedAndReady && !backstop) return;

      await bakeAndNotify(origins, true);
      lastSig = sig;
      lastBakeAt = Date.now();
    } catch (err) {
      console.error("[coverage-worker] bake failed:", err);
    } finally {
      baking = false;
    }
  };

  startLookupServer();
  await tick(); // initial bake
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  console.log(`[coverage-worker] polling every ${POLL_INTERVAL_MS / 1000}s (min ${MIN_RECOMPUTE_MS / 60000}m, backstop ${BACKSTOP_MS / 3600000}h)`);
}

async function main(): Promise<void> {
  installSharpDecoder();
  installEnvShim();
  await cleanupLegacyLayout(); // pre-group flat tiles would sit unread forever
  if (process.argv.includes("--once")) {
    await runOnce();
  } else {
    await runLoop();
  }
}

main().catch((err) => {
  console.error("[coverage-worker] fatal:", err);
  process.exit(1);
});
