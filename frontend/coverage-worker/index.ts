/**
 * Coverage-worker entry.
 *   default : service — poll /v1/nodes, rebake on change (throttled) + 4h backstop, notify.
 *   --once  : single bake then exit.
 */
import {
  BACKSTOP_MS,
  MESHINFO_URL,
  MIN_RECOMPUTE_MS,
  POLL_INTERVAL_MS,
} from "./config";
import { installEnvShim } from "./envShim";
import { type CoverageOrigin, fetchCoverageOrigins } from "./nodes";
import { bakeCoverage, type BakeMetadata } from "./render";
import { installSharpDecoder } from "./sharpImage";

/** Stable dirty-key: rebake only when the contributing set / positions / TX change. */
function signatureOf(origins: CoverageOrigin[]): string {
  return origins
    .map((o) => `${o.id}:${o.lng.toFixed(5)}:${o.lat.toFixed(5)}:${o.altitudeM == null ? "_" : Math.round(o.altitudeM)}:${o.txDbm}`)
    .sort()
    .join("|");
}

async function notifyMeshinfo(meta: BakeMetadata): Promise<void> {
  try {
    const res = await fetch(`${MESHINFO_URL}/v1/coverage/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!res.ok) console.warn(`[coverage-worker] notify HTTP ${res.status}`);
  } catch (err) {
    console.warn("[coverage-worker] notify failed:", err);
  }
}

async function bakeAndNotify(origins: CoverageOrigin[]): Promise<BakeMetadata> {
  const t0 = Date.now();
  const meta = await bakeCoverage(origins, String(t0));
  console.log(
    `[coverage-worker] baked ${meta.tileCount} tiles (z${meta.minZoom}-${meta.maxZoom}) ` +
      `from ${meta.nodeCount} nodes in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  await notifyMeshinfo(meta);
  return meta;
}

export async function runOnce(): Promise<void> {
  const origins = await fetchCoverageOrigins(Date.now());
  console.log(`[coverage-worker] ${origins.length} eligible origins`);
  if (origins.length === 0) {
    console.log("[coverage-worker] no eligible nodes — skipping bake");
    return;
  }
  await bakeAndNotify(origins);
}

async function runLoop(): Promise<void> {
  let lastSig: string | null = null;
  let lastBakeAt = 0;
  let baking = false;

  const tick = async () => {
    if (baking) return;
    const now = Date.now();
    let origins: CoverageOrigin[];
    try {
      origins = await fetchCoverageOrigins(now);
    } catch (err) {
      console.warn("[coverage-worker] node fetch failed:", err);
      return;
    }
    if (origins.length === 0) return;
    const sig = signatureOf(origins);
    const sinceLast = now - lastBakeAt;
    const changedAndReady = sig !== lastSig && sinceLast >= MIN_RECOMPUTE_MS;
    const backstop = sinceLast >= BACKSTOP_MS;
    if (lastSig !== null && !changedAndReady && !backstop) return;

    baking = true;
    try {
      await bakeAndNotify(origins);
      lastSig = sig;
      lastBakeAt = Date.now();
    } catch (err) {
      console.error("[coverage-worker] bake failed:", err);
    } finally {
      baking = false;
    }
  };

  await tick(); // initial bake
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  console.log(`[coverage-worker] polling every ${POLL_INTERVAL_MS / 1000}s (min ${MIN_RECOMPUTE_MS / 60000}m, backstop ${BACKSTOP_MS / 3600000}h)`);
}

async function main(): Promise<void> {
  installSharpDecoder();
  installEnvShim();
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
