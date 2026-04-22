/**
 * Coverage slice worker: runs ITM per pixel over a row range of a shared DEM.
 * Each worker keeps its own ITM WASM context warm across requests.
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
  /** Transferable DEM buffer (main thread ships a copy per worker). */
  demBuffer: ArrayBuffer;
  demWidth: number;
  demHeight: number;
  bounds: DEMBounds;
  origin: [number, number];
  originHeightM: number;
  /** TX antenna AGL (m); ITM txHeightM must be AGL, not MSL. */
  originAntennaHeightAboveGroundM: number;
  params: RasterParams;
  /** rowStart/rowEnd are OUTPUT-grid indices (decoupled from DEM). */
  outputWidth: number;
  outputHeight: number;
  rowStart: number;
  rowEnd: number;
}

export interface CoverageSliceResponse {
  requestId: number;
  rgba: Uint8ClampedArray;
  /** Per-pixel margin dB (NaN for no-data/failure). Main thread stitches for contour extraction. */
  marginDb: Float32Array;
  rowStart: number;
  rowEnd: number;
  clearCount: number;
  fresnelCount: number;
  blockedCount: number;
  maxMarginDb: number;
  itmUnavailable?: boolean;
}

// One ITM WASM context per worker, kept warm across requests.
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
    const sliceN = msg.outputWidth * (msg.rowEnd - msg.rowStart);
    const empty = new Uint8ClampedArray(sliceN * 4);
    const emptyMargin = new Float32Array(sliceN);
    emptyMargin.fill(Number.NaN);
    post({
      requestId: msg.requestId,
      rgba: empty,
      marginDb: emptyMargin,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: 0,
      fresnelCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
      itmUnavailable: true,
    }, [empty.buffer, emptyMargin.buffer]);
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
      {
        position: msg.origin,
        heightM: msg.originHeightM,
        antennaHeightAboveGroundM: msg.originAntennaHeightAboveGroundM,
      },
      { rowStart: msg.rowStart, rowEnd: msg.rowEnd },
      { width: msg.outputWidth, height: msg.outputHeight },
    );
    post({
      requestId: msg.requestId,
      rgba: rendered.rgba,
      marginDb: rendered.marginDb,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: rendered.clearCount,
      fresnelCount: rendered.fresnelCount,
      blockedCount: rendered.blockedCount,
      maxMarginDb: rendered.maxMarginDb,
    }, [rendered.rgba.buffer, rendered.marginDb.buffer]);
  } catch (err) {
    console.warn("[coverageSliceWorker] compute failed:", err);
    const sliceN = msg.outputWidth * (msg.rowEnd - msg.rowStart);
    const empty = new Uint8ClampedArray(sliceN * 4);
    const emptyMargin = new Float32Array(sliceN);
    emptyMargin.fill(Number.NaN);
    post({
      requestId: msg.requestId,
      rgba: empty,
      marginDb: emptyMargin,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
      clearCount: 0,
      fresnelCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
    }, [empty.buffer, emptyMargin.buffer]);
  }
};

self.addEventListener("unload", () => {
  if (itmContextPromise) itmContextPromise.then(disposeItmContext).catch(() => {});
});

// Keep imports so consumers can strongly type their messages
void Climate;
void Polarization;
