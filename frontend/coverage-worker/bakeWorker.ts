/** Persistent bake thread: keeps the main thread (poll loop + lookup server)
 *  responsive and holds the raster RAM cache across bakes. */
import { parentPort } from "node:worker_threads";

import { installEnvShim } from "./envShim";
import type { CoverageOrigin } from "./nodes";
import { bakeCoverage, type BakeMetadata } from "./render";
import { installSharpDecoder } from "./sharpImage";

export interface BakeRequest {
  origins: CoverageOrigin[];
  version: string;
}

export type BakeResponse = { ok: BakeMetadata | null } | { err: string };

installSharpDecoder();
installEnvShim();

parentPort!.on("message", ({ origins, version }: BakeRequest) => {
  void bakeCoverage(origins, version)
    .then((meta) => parentPort!.postMessage({ ok: meta } satisfies BakeResponse))
    .catch((err) => parentPort!.postMessage({ err: err instanceof Error ? err.message : String(err) } satisfies BakeResponse));
});
