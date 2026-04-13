/**
 * Coverage-prediction Web Worker (Phase 10A).
 *
 * Receives a lat/lng bbox + link-budget parameters, fetches Mapbox
 * terrain-rgb tiles directly over HTTPS, builds a DEM, runs the viewshed,
 * renders a per-pixel RGBA coverage raster, and posts the result back. No
 * dependency on the main thread's map viewport — works at any zoom.
 *
 * Instantiate via Vite's worker import:
 *   const worker = new Worker(
 *     new URL("./coverageWorker.ts", import.meta.url),
 *     { type: "module" }
 *   );
 */
import { sampleDEMAt, type DEM } from "./terrainDEM";
import { buildDemFromTerrainRgb } from "./terrainRgb";
import { computeViewshed } from "./viewshed";
import { renderCoverageRaster, type RasterParams } from "./coverageRaster";

export interface CoverageWorkerRequest {
  requestId: number;
  /**
   * Geographic bounds of the analysis area. The worker fetches Mapbox
   * terrain-rgb tiles covering this bbox and builds the DEM directly — no
   * main-thread dependency. Previously we shipped a pre-sampled DEM here.
   */
  bounds: { west: number; south: number; east: number; north: number };
  demWidth: number;
  demHeight: number;
  /**
   * Mapbox access token used to authenticate terrain-dem-v1 tile requests.
   */
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
  /** Fraction of DEM pixels that had valid terrain data (0–1). UI uses this
   *  to decide whether to show the "no terrain data" warning. */
  demCoverage: number;
  /** Final resolved origin MSL height the viewshed used. */
  originHeightM: number;
  /** True if the worker had to fall back to terrain + antenna because the
   *  caller's altitude was missing or below ground. */
  originIsFallback: boolean;
}

/**
 * Count valid (non-NaN) DEM pixels to compute a coverage fraction we can
 * surface to the UI — lets the panel distinguish "no terrain data loaded"
 * from "terrain loaded but link budget failed."
 */
function demValidFraction(dem: DEM): number {
  let valid = 0;
  for (let i = 0; i < dem.data.length; i++) {
    if (!Number.isNaN(dem.data[i])) valid++;
  }
  return dem.data.length > 0 ? valid / dem.data.length : 0;
}

// `self` in a module worker is the DedicatedWorkerGlobalScope.
self.onmessage = async (evt: MessageEvent<CoverageWorkerRequest>) => {
  const msg = evt.data;
  const post = (response: CoverageWorkerResponse, transfer: Transferable[] = []) => {
    (self as unknown as {
      postMessage: (m: CoverageWorkerResponse, t: Transferable[]) => void;
    }).postMessage(response, transfer);
  };

  try {
    // Phase 10A: fetch Mapbox terrain-rgb tiles ourselves. No dependency
    // on the main thread's map viewport; works at any zoom, any bbox.
    const dem = await buildDemFromTerrainRgb({
      bounds: msg.bounds,
      targetWidth: msg.demWidth,
      targetHeight: msg.demHeight,
      token: msg.mapboxToken,
    });

    // Resolve origin height: use reported altitude if valid + above-ground,
    // otherwise use terrain ground + antenna height. Mirrors the previous
    // main-thread logic but sources ground elevation from our own DEM.
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

    const viewshed = computeViewshed({
      dem,
      origin: msg.origin,
      originHeightM,
      targetAntennaHeightM: msg.targetAntennaHeightM,
      freqGHz: msg.freqGHz,
      raySamples: msg.raySamples,
    });

    const rendered = renderCoverageRaster(dem, viewshed, msg.raster);

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
    }, [rendered.rgba.buffer]);
  } catch (err) {
    console.warn("[coverageWorker] compute failed:", err);
    // Post an empty result so the main thread can stop the spinner and
    // the panel can render the "no terrain" hint.
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
    }, [empty.buffer]);
  }
};

// Export to make TypeScript treat this as a module file.
export {};
