/**
 * Coverage-prediction slice worker.
 *
 * This is the "compute" half of the Phase 10D worker pool: it runs
 * Longley-Rice per pixel for a range of rows in a pre-built DEM. The
 * main thread owns the pool, fetches the DEM once, and hands each
 * worker its slice; workers return RGBA tiles that the main thread
 * stitches into the final image.
 *
 * Each worker loads its own copy of the ITM WASM module (one-time
 * ~10–20ms init) and keeps it warm across subsequent dispatches.
 */
import type { DEM, DEMBounds } from "./terrainDEM";
import {
  type ItmContext,
  loadItmContext,
  disposeItmContext,
  Climate,
  Polarization,
} from "./itm";
import {
  renderCoverageRaster,
  type RasterParams,
} from "./coverageRaster";

export interface CoverageSliceRequest {
  requestId: number;
  /** Transferable DEM buffer — main thread ships a copy to each worker. */
  demBuffer: ArrayBuffer;
  demWidth: number;
  demHeight: number;
  bounds: DEMBounds;
  origin: [number, number];
  originHeightM: number;
  params: RasterParams;
  rowStart: number;
  rowEnd: number;
}

export interface CoverageSliceResponse {
  requestId: number;
  rgba: Uint8ClampedArray;
  rowStart: number;
  rowEnd: number;
  clearCount: number;
  fresnelCount: number;
  blockedCount: number;
  maxMarginDb: number;
  itmUnavailable?: boolean;
}

// Cache the ITM context across requests so the WASM module is loaded
// exactly once per worker instance.
let itmContextPromise: Promise<ItmContext> | null = null;
function getItmContext(): Promise<ItmContext> {
  if (!itmContextPromise) {
    itmContextPromise = loadItmContext(128).catch((err) => {
      itmContextPromise = null;
      throw err;
    });
  }
  return itmContextPromise;
}

const post = (msg: CoverageSliceResponse, transfer: Transferable[] = []) => {
  (self as unknown as {
    postMessage: (m: CoverageSliceResponse, t: Transferable[]) => void;
  }).postMessage(msg, transfer);
};

self.onmessage = async (evt: MessageEvent<CoverageSliceRequest>) => {
  const msg = evt.data;

  let itm: ItmContext;
  try {
    itm = await getItmContext();
  } catch (err) {
    console.warn("[coverageSliceWorker] ITM WASM not available:", err);
    const empty = new Uint8ClampedArray(msg.demWidth * (msg.rowEnd - msg.rowStart) * 4);
    post({
      requestId: msg.requestId,
      rgba: empty,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: 0,
      fresnelCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
      itmUnavailable: true,
    }, [empty.buffer]);
    return;
  }

  try {
    const dem: DEM = {
      data: new Float32Array(msg.demBuffer),
      width: msg.demWidth,
      height: msg.demHeight,
      bounds: msg.bounds,
    };
    const rendered = renderCoverageRaster(
      dem,
      msg.params,
      itm,
      { position: msg.origin, heightM: msg.originHeightM },
      { rowStart: msg.rowStart, rowEnd: msg.rowEnd },
    );
    post({
      requestId: msg.requestId,
      rgba: rendered.rgba,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: rendered.clearCount,
      fresnelCount: rendered.fresnelCount,
      blockedCount: rendered.blockedCount,
      maxMarginDb: rendered.maxMarginDb,
    }, [rendered.rgba.buffer]);
  } catch (err) {
    console.warn("[coverageSliceWorker] compute failed:", err);
    const empty = new Uint8ClampedArray(msg.demWidth * (msg.rowEnd - msg.rowStart) * 4);
    post({
      requestId: msg.requestId,
      rgba: empty,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: 0,
      fresnelCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
    }, [empty.buffer]);
  }
};

self.addEventListener("unload", () => {
  if (itmContextPromise) itmContextPromise.then(disposeItmContext).catch(() => {});
});

// Silence unused-import warnings — these are part of the public request
// type surface so consumers can strongly type their messages.
void Climate;
void Polarization;
