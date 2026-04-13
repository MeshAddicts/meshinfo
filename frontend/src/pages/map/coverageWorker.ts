/**
 * Coverage-prediction Web Worker (ITM / Longley-Rice edition).
 *
 * Receives a lat/lng bbox + link-budget parameters, fetches Mapbox
 * terrain-rgb tiles directly over HTTPS to build a DEM, then runs the
 * NTIA ITM WebAssembly model per pixel to compute basic transmission
 * loss, and finally emits an RGBA raster for display.
 *
 * Instantiate via Vite's worker import:
 *   const worker = new Worker(
 *     new URL("./coverageWorker.ts", import.meta.url),
 *     { type: "module" }
 *   );
 */
import { sampleDEMAt, type DEM } from "./terrainDEM";
import { buildDemFromTerrainRgb } from "./terrainRgb";
import {
  Climate,
  disposeItmContext,
  type ItmContext,
  loadItmContext,
  Polarization,
} from "./itm";
import { renderCoverageRaster, type RasterParams } from "./coverageRaster";

export interface CoverageWorkerRequest {
  requestId: number;
  /** Analysis bbox; worker fetches terrain tiles for this area. */
  bounds: { west: number; south: number; east: number; north: number };
  demWidth: number;
  demHeight: number;
  mapboxToken: string;
  /** Origin lng/lat. */
  origin: [number, number];
  /** Reported altitude in meters MSL, or null for virtual pins / unknown. */
  originAltitudeM: number | null;
  /** Antenna height above ground for origin when altitude is unknown. */
  antennaHeightM: number;
  /** Target / receiver antenna height above ground. */
  targetAntennaHeightM: number;
  freqGHz: number;
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
  /** Fraction of DEM pixels that had valid terrain data (0–1). */
  demCoverage: number;
  originHeightM: number;
  originIsFallback: boolean;
  /**
   * Wall-clock ms spent in the per-pixel LR pass. Useful for the UI to
   * show a "computed in Xs" note and for benchmarking Phase 10D
   * parallelism wins later.
   */
  computeMs: number;
  /**
   * Set when the ITM WASM module isn't available (user needs to run
   * `yarn build:wasm`). Lets the panel show a clear error rather than
   * an empty render.
   */
  itmUnavailable?: boolean;
}

function demValidFraction(dem: DEM): number {
  let valid = 0;
  for (let i = 0; i < dem.data.length; i++) {
    if (!Number.isNaN(dem.data[i])) valid++;
  }
  return dem.data.length > 0 ? valid / dem.data.length : 0;
}

// Cache the loaded ITM context across requests — reloading would
// re-instantiate the WASM module (slow) on every pin drop.
let itmContextPromise: Promise<ItmContext> | null = null;
async function getItmContext(): Promise<ItmContext> {
  if (!itmContextPromise) {
    // 128 samples is plenty for our 15–96-per-path heuristic.
    itmContextPromise = loadItmContext(128).catch((err) => {
      // Reset on failure so a fix (rebuild) can be picked up next call.
      itmContextPromise = null;
      throw err;
    });
  }
  return itmContextPromise;
}

self.onmessage = async (evt: MessageEvent<CoverageWorkerRequest>) => {
  const msg = evt.data;
  const post = (response: CoverageWorkerResponse, transfer: Transferable[] = []) => {
    (self as unknown as {
      postMessage: (m: CoverageWorkerResponse, t: Transferable[]) => void;
    }).postMessage(response, transfer);
  };

  // Try to load ITM first; if it fails, we fail fast so the UI can
  // surface the build-required warning.
  let itm: ItmContext;
  try {
    itm = await getItmContext();
  } catch (err) {
    console.warn("[coverageWorker] ITM WASM not available:", err);
    const empty = new Uint8ClampedArray(msg.demWidth * msg.demHeight * 4);
    post({
      requestId: msg.requestId,
      rgba: empty,
      width: msg.demWidth,
      height: msg.demHeight,
      clearCount: 0,
      fresnelCount: 0,
      diffractedCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
      demCoverage: 0,
      originHeightM: 0,
      originIsFallback: true,
      computeMs: 0,
      itmUnavailable: true,
    }, [empty.buffer]);
    return;
  }

  try {
    const dem = await buildDemFromTerrainRgb({
      bounds: msg.bounds,
      targetWidth: msg.demWidth,
      targetHeight: msg.demHeight,
      token: msg.mapboxToken,
    });

    // Resolve origin height: use reported altitude if valid + above-ground,
    // otherwise use terrain ground + antenna height.
    const originGround = sampleDEMAt(dem, msg.origin[0], msg.origin[1]);
    const altValid =
      msg.originAltitudeM != null &&
      Number.isFinite(msg.originAltitudeM) &&
      !Number.isNaN(originGround) &&
      msg.originAltitudeM >= originGround;
    const originHeightM = altValid
      ? (msg.originAltitudeM as number)
      : (Number.isNaN(originGround) ? 0 : originGround) + msg.antennaHeightM;
    const originIsFallback = !altValid;

    const t0 = performance.now();
    const rendered = renderCoverageRaster(
      dem,
      msg.raster,
      itm,
      { position: msg.origin, heightM: originHeightM },
    );
    const computeMs = performance.now() - t0;

    post({
      requestId: msg.requestId,
      rgba: rendered.rgba,
      width: rendered.width,
      height: rendered.height,
      clearCount: rendered.clearCount,
      fresnelCount: rendered.fresnelCount,
      diffractedCount: rendered.diffractedCount,
      blockedCount: rendered.blockedCount,
      maxMarginDb: rendered.maxMarginDb,
      demCoverage: demValidFraction(dem),
      originHeightM,
      originIsFallback,
      computeMs,
    }, [rendered.rgba.buffer]);
  } catch (err) {
    console.warn("[coverageWorker] compute failed:", err);
    const empty = new Uint8ClampedArray(msg.demWidth * msg.demHeight * 4);
    post({
      requestId: msg.requestId,
      rgba: empty,
      width: msg.demWidth,
      height: msg.demHeight,
      clearCount: 0,
      fresnelCount: 0,
      diffractedCount: 0,
      blockedCount: 0,
      maxMarginDb: 0,
      demCoverage: 0,
      originHeightM: 0,
      originIsFallback: true,
      computeMs: 0,
    }, [empty.buffer]);
  }
};

// Clean up on terminate — rarely triggered but polite.
self.addEventListener("unload", () => {
  if (itmContextPromise) {
    itmContextPromise.then(disposeItmContext).catch(() => {});
  }
});

// Silence an unused-import warning if Climate / Polarization aren't
// consumed elsewhere; they're part of the public request type.
void Climate;
void Polarization;
