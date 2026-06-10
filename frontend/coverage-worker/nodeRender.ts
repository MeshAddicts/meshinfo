/** Per-node coverage compositing, shared by the inline and worker_threads paths. */
import type { BuildingRaster } from "../src/pages/map/buildingTiles";
import type { CanopyRaster } from "../src/pages/map/canopyTiles";
import { renderCoverageRaster } from "../src/pages/map/coverageRaster";
import type { ItmContext } from "../src/pages/map/itm";
import type { ClutterRaster } from "../src/pages/map/landcoverTiles";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { type DEM, type DEMBounds, demBoundsAround, sampleDEMAt } from "../src/pages/map/terrainDEM";
import * as cfg from "./config";
import { latToPx, lngToPx, pxToLat, pxToLng, TILE_SIZE } from "./mercator";
import type { CoverageOrigin } from "./nodes";

const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;

/** Shared terrain + accuracy rasters over the network bbox (clutter/canopy/buildings
 *  are sampled by lng/lat, so they need no per-node slicing). */
export interface RenderSources {
  dem: DEM;
  clutter: ClutterRaster | null;
  canopy: CanopyRaster | null;
  buildings: BuildingRaster | null;
  clutterAggression: number;
}

export interface Accumulator {
  margin: Float32Array;
  accX0: number;
  accY0: number;
  accW: number;
  accH: number;
}

export interface AccDims {
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
  accX0: number;
  accY0: number;
  accW: number;
  accH: number;
}

/** Tile-aligned mercator pixel extent of the network bbox at zoom `z`. */
export function computeAccDims(bbox: DEMBounds, z: number): AccDims {
  const tx0 = Math.floor(lngToPx(bbox.west, z) / TILE_SIZE);
  const tx1 = Math.ceil(lngToPx(bbox.east, z) / TILE_SIZE);
  const ty0 = Math.floor(latToPx(bbox.north, z) / TILE_SIZE);
  const ty1 = Math.ceil(latToPx(bbox.south, z) / TILE_SIZE);
  return {
    tx0,
    tx1,
    ty0,
    ty1,
    accX0: tx0 * TILE_SIZE,
    accY0: ty0 * TILE_SIZE,
    accW: (tx1 - tx0) * TILE_SIZE,
    accH: (ty1 - ty0) * TILE_SIZE,
  };
}

function clampBounds(b: DEMBounds, outer: DEMBounds): DEMBounds {
  return {
    west: Math.max(b.west, outer.west),
    east: Math.min(b.east, outer.east),
    south: Math.max(b.south, outer.south),
    north: Math.min(b.north, outer.north),
  };
}

/** Resample a sub-rectangle of the shared DEM to its own grid (bounds == footprint). */
function sliceDEM(shared: DEM, bounds: DEMBounds, width: number, height: number): DEM {
  const data = new Float32Array(width * height);
  const lonStep = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const latStep = (bounds.north - bounds.south) / Math.max(1, height - 1);
  for (let j = 0; j < height; j++) {
    const lat = bounds.north - j * latStep;
    const row = j * width;
    for (let i = 0; i < width; i++) {
      data[row + i] = sampleDEMAt(shared, bounds.west + i * lonStep, lat);
    }
  }
  return { data, width, height, bounds };
}

/** TX height off the DEM: GPS MSL altitude when sane, else DEM ground; + assumed AGL. */
function resolveOrigin(o: CoverageOrigin, shared: DEM) {
  const demGround = sampleDEMAt(shared, o.lng, o.lat);
  const demOk = !Number.isNaN(demGround);
  const ground = demOk ? demGround : 0;
  const alt = o.altitudeM;
  const altValid =
    alt != null &&
    Number.isFinite(alt) &&
    (!demOk || (alt >= ground && alt <= ground + MAX_HEIGHT_ABOVE_TERRAIN_M));
  const baseM = altValid ? (alt as number) : ground;
  const heightM = baseM + LIVE_ANTENNA_AGL_M;
  const antennaHeightAboveGroundM = demOk ? heightM - demGround : LIVE_ANTENNA_AGL_M;
  return { position: [o.lng, o.lat] as [number, number], heightM, antennaHeightAboveGroundM };
}

/** Render one node and composite per-pixel max-margin into `acc.margin`. */
export function compositeNode(o: CoverageOrigin, src: RenderSources, itm: ItmContext, z: number, acc: Accumulator): void {
  const shared = src.dem;
  const fp = clampBounds(demBoundsAround([o.lng, o.lat], o.reachKm, 1.0), shared.bounds);
  if (fp.east <= fp.west || fp.north <= fp.south) return;

  // Render grid capped well below the footprint's z-pixel extent: coverage is
  // smooth, so it upsamples into the accumulator cleanly and ITM cost stays off
  // the MAX_ZOOM treadmill (terrain stays fine via the sub-DEM).
  const outW = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(lngToPx(fp.east, z) - lngToPx(fp.west, z))));
  const outH = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(latToPx(fp.south, z) - latToPx(fp.north, z))));

  // Sub-DEM sized to the footprint's real extent in shared-DEM pixels (don't
  // upsample a coarse DEM), capped at NODE_DEM_SIZE.
  const sharedLonStep = (shared.bounds.east - shared.bounds.west) / Math.max(1, shared.width - 1);
  const sharedLatStep = (shared.bounds.north - shared.bounds.south) / Math.max(1, shared.height - 1);
  const subW = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.east - fp.west) / sharedLonStep)));
  const subH = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.north - fp.south) / sharedLatStep)));
  const subDem = sliceDEM(shared, fp, subW, subH);
  // Clutter/canopy/buildings cover the whole network and are sampled by lng/lat,
  // so the full rasters are passed through unsliced.
  const res = renderCoverageRaster(
    subDem,
    buildLiveCoverageParams(o.txDbm, src.clutterAggression),
    itm,
    [resolveOrigin(o, shared)],
    undefined,
    { width: outW, height: outH },
    src.clutter,
    src.canopy,
    src.buildings,
  );
  // Node margin grid as a DEM-shaped raster so sampleDEMAt bilinear-samples it.
  const nodeGrid: DEM = { data: res.marginDb, width: outW, height: outH, bounds: fp };

  const { margin, accX0, accY0, accW, accH } = acc;
  const gpx0 = Math.max(accX0, Math.floor(lngToPx(fp.west, z)));
  const gpx1 = Math.min(accX0 + accW, Math.ceil(lngToPx(fp.east, z)));
  const gpy0 = Math.max(accY0, Math.floor(latToPx(fp.north, z)));
  const gpy1 = Math.min(accY0 + accH, Math.ceil(latToPx(fp.south, z)));
  for (let gpy = gpy0; gpy < gpy1; gpy++) {
    const lat = pxToLat(gpy + 0.5, z);
    const accRow = (gpy - accY0) * accW;
    for (let gpx = gpx0; gpx < gpx1; gpx++) {
      const m = sampleDEMAt(nodeGrid, pxToLng(gpx + 0.5, z), lat);
      if (Number.isNaN(m)) continue;
      const idx = accRow + (gpx - accX0);
      const prev = margin[idx];
      if (Number.isNaN(prev) || m > prev) margin[idx] = m;
    }
  }
}
