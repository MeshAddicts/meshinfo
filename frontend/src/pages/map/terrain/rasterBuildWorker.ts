/**
 * Raster-build worker: fetches + decodes + resamples the coverage raster set
 * (DEM, clutter, canopy, buildings) off the main thread. The 2048² bilinear
 * resamples used to stall the UI for hundreds of ms per cache-miss compute.
 * Tile LRU caches live in this worker for the coverage tool.
 */
import { buildBuildingRaster, type BuildingRaster } from "./buildingTiles";
import { buildCanopyRaster, type CanopyRaster } from "./canopyTiles";
import { buildClutterRaster, type ClutterRaster } from "./landcoverTiles";
import type { DEM, DEMBounds } from "./terrainDEM";
import { buildDem, type DemSource } from "./terrainRgb";

export interface RasterBuildRequest {
  id: number;
  bounds: DEMBounds;
  size: number;
  maxTiles: number;
  token: string;
  wantClutter: boolean;
  wantCanopy: boolean;
  wantBuildings: boolean;
  /** Runtime env the worker can't read from window.__env__ (self-hosted tile base). */
  runtimeEnv?: { VITE_API_BASE_URL?: string };
}

export interface RasterBuildResult {
  dem: DEM;
  demSource: DemSource;
  demTilesFailed: number;
  demTilesTotal: number;
  clutter: ClutterRaster | null;
  canopy: CanopyRaster | null;
  buildings: BuildingRaster | null;
}

export type RasterBuildResponse =
  | ({ id: number; error?: undefined } & RasterBuildResult)
  | { id: number; error: string };

self.onmessage = async (evt: MessageEvent<RasterBuildRequest>) => {
  const req = evt.data;
  if (req.runtimeEnv) {
    const g = globalThis as { __env__?: Record<string, string | undefined> };
    g.__env__ = { ...g.__env__, ...req.runtimeEnv };
  }
  try {
    const common = {
      bounds: req.bounds,
      targetWidth: req.size,
      targetHeight: req.size,
      maxTiles: req.maxTiles,
    };
    const [built, clutter, canopy, buildings] = await Promise.all([
      buildDem({ ...common, token: req.token }),
      req.wantClutter ? buildClutterRaster(common) : Promise.resolve(null),
      req.wantCanopy ? buildCanopyRaster(common) : Promise.resolve(null),
      req.wantBuildings ? buildBuildingRaster(common) : Promise.resolve(null),
    ]);
    const response: RasterBuildResponse = {
      id: req.id,
      dem: built.dem,
      demSource: built.source,
      demTilesFailed: built.tilesFailed,
      demTilesTotal: built.tilesTotal,
      clutter,
      canopy,
      buildings,
    };
    const transfer: Transferable[] = [built.dem.data.buffer];
    if (clutter) transfer.push(clutter.data.buffer);
    if (canopy) transfer.push(canopy.heightM.buffer, canopy.stdM.buffer, canopy.mask.buffer);
    if (buildings) transfer.push(buildings.heightM.buffer, buildings.mask.buffer);
    (self as unknown as {
      postMessage: (m: RasterBuildResponse, t: Transferable[]) => void;
    }).postMessage(response, transfer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (self as unknown as { postMessage: (m: RasterBuildResponse) => void }).postMessage({
      id: req.id,
      error: msg,
    });
  }
};
