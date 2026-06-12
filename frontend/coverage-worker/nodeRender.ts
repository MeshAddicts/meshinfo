/** Per-node ITM rendering + per-tile compositing, shared by inline and worker paths. */
import type { BuildingRaster } from "../src/pages/map/buildingTiles";
import type { CanopyRaster } from "../src/pages/map/canopyTiles";
import { renderCoverageRaster } from "../src/pages/map/coverageRaster";
import type { ItmContext } from "../src/pages/map/itm";
import type { ClutterRaster } from "../src/pages/map/landcoverTiles";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { type DEM, type DEMBounds, demBoundsAround, sampleDEMAt } from "../src/pages/map/terrainDEM";
import { type MarginGridQ8, marginQ8At, quantizeMargin } from "./cache";
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

export interface TileRect {
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
}

/** Tile range of `bounds` at zoom `z` (exclusive upper). */
export function tileRectForBounds(bounds: DEMBounds, z: number): TileRect {
  return {
    tx0: Math.floor(lngToPx(bounds.west, z) / TILE_SIZE),
    tx1: Math.ceil(lngToPx(bounds.east, z) / TILE_SIZE),
    ty0: Math.floor(latToPx(bounds.north, z) / TILE_SIZE),
    ty1: Math.ceil(latToPx(bounds.south, z) / TILE_SIZE),
  };
}

export function clampRect(r: TileRect, outer: TileRect): TileRect {
  return {
    tx0: Math.max(r.tx0, outer.tx0),
    tx1: Math.min(r.tx1, outer.tx1),
    ty0: Math.max(r.ty0, outer.ty0),
    ty1: Math.min(r.ty1, outer.ty1),
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

/** AGL = reported alt − DEM ground, floored at the 6 m default so bad altitude
 *  data can only raise the antenna, never bury it. Implausible alt → default. */
function resolveOrigin(o: CoverageOrigin, shared: DEM) {
  const demGround = sampleDEMAt(shared, o.lng, o.lat);
  const demOk = !Number.isNaN(demGround);
  const ground = demOk ? demGround : 0;
  const alt = o.altitudeM;
  const altValid =
    demOk &&
    alt != null &&
    Number.isFinite(alt) &&
    alt >= ground &&
    alt <= ground + MAX_HEIGHT_ABOVE_TERRAIN_M;
  const agl = altValid ? Math.max(LIVE_ANTENNA_AGL_M, (alt as number) - ground) : LIVE_ANTENNA_AGL_M;
  return { position: [o.lng, o.lat] as [number, number], heightM: ground + agl, antennaHeightAboveGroundM: agl };
}

/** Render one node's quantized margin grid over its clamped footprint. */
export function renderNodeMargin(o: CoverageOrigin, src: RenderSources, itm: ItmContext): MarginGridQ8 | null {
  const shared = src.dem;
  const fp = clampBounds(demBoundsAround([o.lng, o.lat], o.reachKm, 1.0), shared.bounds);
  if (fp.east <= fp.west || fp.north <= fp.south) {
    console.warn(`[coverage-worker] node ${o.id} footprint outside DEM bounds; skipped`);
    return null;
  }

  // Uniform OUTPUT_M_PER_PX render grid, capped at NODE_OUTPUT_MAX.
  const midLat = ((fp.north + fp.south) / 2) * (Math.PI / 180);
  const fpWidthM = (fp.east - fp.west) * 111320 * Math.cos(midLat);
  const fpHeightM = (fp.north - fp.south) * 110540;
  const outW = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpWidthM / cfg.OUTPUT_M_PER_PX)));
  const outH = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpHeightM / cfg.OUTPUT_M_PER_PX)));

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
  return { data: quantizeMargin(res.marginDb), width: outW, height: outH, bounds: fp };
}

/** Composite one 256² tile from the node grids whose footprints intersect it;
 *  per-pixel max-margin. Returns null when the tile ends up empty. */
export function compositeTileMargin(tx: number, ty: number, z: number, nodes: MarginGridQ8[]): Float32Array | null {
  const px0 = tx * TILE_SIZE;
  const py0 = ty * TILE_SIZE;
  const tileWest = pxToLng(px0, z);
  const tileEast = pxToLng(px0 + TILE_SIZE, z);
  const tileNorth = pxToLat(py0, z);
  const tileSouth = pxToLat(py0 + TILE_SIZE, z);

  let margin: Float32Array | null = null;
  for (const g of nodes) {
    const b = g.bounds;
    if (b.east <= tileWest || b.west >= tileEast || b.north <= tileSouth || b.south >= tileNorth) continue;
    const gx0 = Math.max(px0, Math.floor(lngToPx(b.west, z)));
    const gx1 = Math.min(px0 + TILE_SIZE, Math.ceil(lngToPx(b.east, z)));
    const gy0 = Math.max(py0, Math.floor(latToPx(b.north, z)));
    const gy1 = Math.min(py0 + TILE_SIZE, Math.ceil(latToPx(b.south, z)));
    for (let gpy = gy0; gpy < gy1; gpy++) {
      const lat = pxToLat(gpy + 0.5, z);
      const row = (gpy - py0) * TILE_SIZE;
      for (let gpx = gx0; gpx < gx1; gpx++) {
        const m = marginQ8At(g, pxToLng(gpx + 0.5, z), lat);
        if (Number.isNaN(m)) continue;
        if (!margin) {
          margin = new Float32Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
        }
        const idx = row + (gpx - px0);
        const prev = margin[idx];
        if (Number.isNaN(prev) || m > prev) margin[idx] = m;
      }
    }
  }
  return margin;
}
