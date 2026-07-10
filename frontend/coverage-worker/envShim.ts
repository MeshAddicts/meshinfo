/** Make env.ts + tileBaseUrl() resolve outside Vite so the clutter tile builders
 *  fetch from meshinfo. Call once per thread before building rasters. */
import { MESHINFO_URL } from "./config";

export function installEnvShim(): void {
  // env.ts get() reads globalThis.__env__ directly (window === globalThis only
  // in browsers), so the shim must land on globalThis — same slot
  // rasterBuildWorker.ts uses when it forwards the env into browser workers.
  (globalThis as { __env__?: Record<string, string> }).__env__ = {
    VITE_API_BASE_URL: MESHINFO_URL,
  };
}
