/**
 * Coverage-prediction Web Worker.
 *
 * Receives a pre-sampled DEM + link-budget parameters, runs the viewshed and
 * renders a per-pixel RGBA coverage raster, then posts the result back with
 * transferable buffers so the main thread stays responsive.
 *
 * Instantiate via Vite's worker import:
 *   const worker = new Worker(
 *     new URL("./coverageWorker.ts", import.meta.url),
 *     { type: "module" }
 *   );
 */
import type { DEM } from "./terrainDEM";
import { computeViewshed } from "./viewshed";
import { renderCoverageRaster, type RasterParams } from "./coverageRaster";

export interface CoverageWorkerRequest {
  requestId: number;
  dem: {
    data: Float32Array;
    width: number;
    height: number;
    bounds: { west: number; south: number; east: number; north: number };
  };
  origin: [number, number];
  originHeightM: number;
  targetAntennaHeightM: number;
  freqGHz: number;
  raySamples: number;
  raster: RasterParams;
}

export interface CoverageWorkerResponse {
  requestId: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  clearCount: number;
  fresnelCount: number;
  diffractedCount: number;
  blockedCount: number;
  maxMarginDb: number;
}

// `self` in a module worker is the DedicatedWorkerGlobalScope.
self.onmessage = (evt: MessageEvent<CoverageWorkerRequest>) => {
  const msg = evt.data;
  const dem: DEM = {
    data: msg.dem.data,
    width: msg.dem.width,
    height: msg.dem.height,
    bounds: msg.dem.bounds,
  };

  const viewshed = computeViewshed({
    dem,
    origin: msg.origin,
    originHeightM: msg.originHeightM,
    targetAntennaHeightM: msg.targetAntennaHeightM,
    freqGHz: msg.freqGHz,
    raySamples: msg.raySamples,
  });

  const rendered = renderCoverageRaster(dem, viewshed, msg.raster);

  const response: CoverageWorkerResponse = {
    requestId: msg.requestId,
    rgba: rendered.rgba,
    width: rendered.width,
    height: rendered.height,
    clearCount: rendered.clearCount,
    fresnelCount: rendered.fresnelCount,
    diffractedCount: rendered.diffractedCount,
    blockedCount: rendered.blockedCount,
    maxMarginDb: rendered.maxMarginDb,
  };

  // Transfer the RGBA buffer to avoid a copy.
  // `self` in a module worker implements `postMessage(message, transfer?)`.
  (self as unknown as {
    postMessage: (msg: CoverageWorkerResponse, transfer: Transferable[]) => void;
  }).postMessage(response, [rendered.rgba.buffer]);
};

// Export to make TypeScript treat this as a module file.
export {};
