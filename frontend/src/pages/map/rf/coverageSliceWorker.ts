/**
 * Coverage slice worker: runs ITM per pixel over a row range of a shared DEM.
 * Keeps its ITM WASM context warm across requests and caches the raster set
 * by generation id, so same-generation slices carry no buffers.
 */
import type { BuildingRaster } from "../terrain/buildingTiles";
import type { CanopyRaster } from "../terrain/canopyTiles";
import type { ClutterRaster } from "../terrain/landcoverTiles";
import type { DEM, DEMBounds } from "../terrain/terrainDEM";
import {
  type RasterParams,
  renderCoverageRaster,
} from "./coverageRaster";
import {
  Climate,
  disposeItmContext,
  type ItmContext,
  loadItmContext,
  Polarization,
} from "./itm";

/** Per-origin link-budget inputs; renderCoverageRaster takes max margin across all entries. */
export interface SliceOrigin {
  position: [number, number];
  /** Origin MSL height (m); display/export only — ITM doesn't receive this. */
  heightM: number;
  /** TX antenna AGL (m); ITM txHeightM must be AGL, not MSL. */
  antennaHeightAboveGroundM: number;
}

/** Raster buffers shipped once per generation (pool attaches them lazily,
 *  only for workers that haven't seen the generation yet). */
export interface CoverageRasterPayload {
  demBuffer: ArrayBuffer;
  demWidth: number;
  demHeight: number;
  bounds: DEMBounds;
  /** Optional class-ID raster aligned to DEM bounds. Absent → default class everywhere. */
  clutterBuffer?: ArrayBuffer;
  clutterWidth?: number;
  clutterHeight?: number;
  /** Optional canopy-height raster aligned to DEM bounds. Absent → class-nominal heights. */
  canopyHeightBuffer?: ArrayBuffer;
  canopyStdBuffer?: ArrayBuffer;
  canopyMaskBuffer?: ArrayBuffer;
  canopyWidth?: number;
  canopyHeight?: number;
  /** Optional building-height raster aligned to DEM bounds. Absent → bare-earth + class-nominal. */
  buildingHeightBuffer?: ArrayBuffer;
  buildingMaskBuffer?: ArrayBuffer;
  buildingWidth?: number;
  buildingHeight?: number;
}

export interface CoverageSliceRequest {
  requestId: number;
  /** Raster generation this slice targets; the worker's cache must match. */
  rasterGen: number;
  /** Present only when the pool decides this worker needs the buffers. */
  rasters?: CoverageRasterPayload;
  /** Primary + optional merge origins. */
  origins: SliceOrigin[];
  params: RasterParams;
  /** rowStart/rowEnd are OUTPUT-grid indices (decoupled from DEM). */
  outputWidth: number;
  outputHeight: number;
  rowStart: number;
  rowEnd: number;
}

/** Control messages: free cached rasters (tool exit — they hold ~100 MB at
 *  full tiers) or pre-compile the ITM WASM ahead of the first compute. */
export interface ControlMessage {
  kind: "clearRasters" | "warmup";
}

export type CoverageWorkerMessage = CoverageSliceRequest | ControlMessage;

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
  /** Worker lacks rasters for `rasterGen` — the pool re-sends the slice with buffers attached. */
  cacheMiss?: boolean;
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

// Raster cache, valid while cachedGen matches incoming requests.
let cachedGen = -1;
let cachedDem: DEM | null = null;
let cachedClutter: ClutterRaster | null = null;
let cachedCanopy: CanopyRaster | null = null;
let cachedBuildings: BuildingRaster | null = null;

function clearRasterCache(): void {
  cachedGen = -1;
  cachedDem = null;
  cachedClutter = null;
  cachedCanopy = null;
  cachedBuildings = null;
}

function adoptRasters(gen: number, r: CoverageRasterPayload): void {
  cachedDem = {
    data: new Float32Array(r.demBuffer),
    width: r.demWidth,
    height: r.demHeight,
    bounds: r.bounds,
  };
  cachedClutter =
    r.clutterBuffer && r.clutterWidth && r.clutterHeight
      ? {
          data: new Uint8Array(r.clutterBuffer),
          width: r.clutterWidth,
          height: r.clutterHeight,
          bounds: r.bounds,
          tilesPresent: 0,
          tilesTotal: 0,
        }
      : null;
  cachedCanopy =
    r.canopyHeightBuffer && r.canopyStdBuffer && r.canopyMaskBuffer && r.canopyWidth && r.canopyHeight
      ? {
          heightM: new Float32Array(r.canopyHeightBuffer),
          stdM: new Float32Array(r.canopyStdBuffer),
          mask: new Float32Array(r.canopyMaskBuffer),
          width: r.canopyWidth,
          height: r.canopyHeight,
          bounds: r.bounds,
          tilesPresent: 0,
          tilesTotal: 0,
        }
      : null;
  cachedBuildings =
    r.buildingHeightBuffer && r.buildingMaskBuffer && r.buildingWidth && r.buildingHeight
      ? {
          heightM: new Float32Array(r.buildingHeightBuffer),
          mask: new Float32Array(r.buildingMaskBuffer),
          width: r.buildingWidth,
          height: r.buildingHeight,
          bounds: r.bounds,
          tilesPresent: 0,
          tilesTotal: 0,
        }
      : null;
  cachedGen = gen;
}

const post = (msg: CoverageSliceResponse, transfer: Transferable[] = []) => {
  (self as unknown as {
    postMessage: (m: CoverageSliceResponse, t: Transferable[]) => void;
  }).postMessage(msg, transfer);
};

/** Empty slice payload for error/miss responses. */
function emptySlice(
  msg: CoverageSliceRequest,
  extra: Partial<CoverageSliceResponse>,
): void {
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
    ...extra,
  }, [empty.buffer, emptyMargin.buffer]);
}

self.onmessage = async (evt: MessageEvent<CoverageWorkerMessage>) => {
  const msg = evt.data;
  if ("kind" in msg) {
    if (msg.kind === "clearRasters") clearRasterCache();
    else if (msg.kind === "warmup") void getItmContext().catch(() => {});
    return;
  }

  let itm: ItmContext;
  try {
    itm = await getItmContext();
  } catch (err) {
    console.warn("[coverageSliceWorker] ITM WASM not available:", err);
    emptySlice(msg, { itmUnavailable: true });
    return;
  }

  try {
    if (msg.rasters) adoptRasters(msg.rasterGen, msg.rasters);
    if (cachedGen !== msg.rasterGen || !cachedDem) {
      // Worker-recreation race; the pool re-sends with buffers attached
      emptySlice(msg, { cacheMiss: true });
      return;
    }
    const rendered = renderCoverageRaster(
      cachedDem,
      msg.params,
      itm,
      msg.origins,
      { rowStart: msg.rowStart, rowEnd: msg.rowEnd },
      { width: msg.outputWidth, height: msg.outputHeight },
      cachedClutter,
      cachedCanopy,
      cachedBuildings,
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
    emptySlice(msg, {});
  }
};

self.addEventListener("unload", () => {
  if (itmContextPromise) itmContextPromise.then(disposeItmContext).catch(() => {});
});

// Keep imports so consumers can strongly type their messages
void Climate;
void Polarization;
