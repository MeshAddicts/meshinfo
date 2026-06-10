/** Make env.ts + tileBaseUrl() resolve outside Vite so the clutter tile builders
 *  fetch from meshinfo. Call once in the main process before building rasters. */
import { MESHINFO_URL } from "./config";

export function installEnvShim(): void {
  (globalThis as unknown as { window?: unknown }).window = {
    __env__: { VITE_API_BASE_URL: MESHINFO_URL },
  };
}
