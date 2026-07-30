/** MapLibre v6's ESM build loads its worker from a real URL instead of
 *  inlining it in the bundle, and inside Vite's module graph that URL can't
 *  be derived automatically — without this bootstrap the map boots but no
 *  tiles ever load. Must run before the first `new Map()`; importing this
 *  module from every Map-constructing module guarantees that.
 *  `?worker&url` (not plain `?url`) is required: the worker imports its
 *  maplibre-gl-shared.mjs sibling, and `?url` would emit it unbundled — a
 *  break that only shows up in production builds, never in dev. */
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
