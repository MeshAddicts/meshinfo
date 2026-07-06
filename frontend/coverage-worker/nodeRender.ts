/** Per-node ITM rendering + per-tile compositing, shared by inline and worker paths. */
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import { renderCoverageRaster } from "../src/pages/map/rf/coverageRaster";
import type { ItmContext } from "../src/pages/map/rf/itm";
import type { BuildingRaster } from "../src/pages/map/terrain/buildingTiles";
import type { CanopyRaster } from "../src/pages/map/terrain/canopyTiles";
import type { ClutterRaster } from "../src/pages/map/terrain/landcoverTiles";
import { type DEM, type DEMBounds, demBoundsAround, sampleDEMAt } from "../src/pages/map/terrain/terrainDEM";
import { gridFraction, type MarginGridQ8, marginQ8At, quantizeMargin, readNodeGrid } from "./cache";
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
 *  data can only raise the antenna, never bury it. Implausible alt → default.
 *  `lng` is the origin longitude already shifted into the DEM's frame. */
function resolveOrigin(o: CoverageOrigin, lng: number, shared: DEM) {
  const demGround = sampleDEMAt(shared, lng, o.lat);
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
  return { position: [lng, o.lat] as [number, number], heightM: ground + agl, antennaHeightAboveGroundM: agl };
}

/** Footprint + output dims for one node — computed identically by the slice
 *  builder (bake thread) and the renderer (worker), so the per-node accuracy
 *  slices line up exactly with the margin grid they feed. */
export interface NodeRenderPlan {
  /** Node longitude shifted into the DEM's (possibly unwrapped) frame. */
  lng: number;
  fp: DEMBounds;
  outW: number;
  outH: number;
}

export function planNodeRender(o: CoverageOrigin, demBounds: DEMBounds): NodeRenderPlan | null {
  // Shift the node into the DEM's longitude frame: a seam-straddling bbox is
  // unwrapped (e.g. [178, 182]), so a node at -179.5 must render at +180.5.
  const lng = o.lng < demBounds.west ? o.lng + 360 : o.lng > demBounds.east ? o.lng - 360 : o.lng;
  const fp = clampBounds(demBoundsAround([lng, o.lat], o.reachKm, 1.0), demBounds);
  if (fp.east <= fp.west || fp.north <= fp.south) return null;

  // Uniform OUTPUT_M_PER_PX render grid, capped at NODE_OUTPUT_MAX.
  const midLat = ((fp.north + fp.south) / 2) * (Math.PI / 180);
  const fpWidthM = (fp.east - fp.west) * 111320 * Math.cos(midLat);
  const fpHeightM = (fp.north - fp.south) * 110540;
  const outW = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpWidthM / cfg.OUTPUT_M_PER_PX)));
  const outH = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpHeightM / cfg.OUTPUT_M_PER_PX)));
  return { lng, fp, outW, outH };
}

/** Render one node's quantized margin grid over its clamped footprint. The
 *  clutter/canopy/building rasters in `src` are per-node slices covering
 *  exactly this footprint at output resolution (see buildNodeSlices). */
export function renderNodeMargin(o: CoverageOrigin, src: RenderSources, itm: ItmContext): MarginGridQ8 | null {
  const shared = src.dem;
  const plan = planNodeRender(o, shared.bounds);
  if (!plan) {
    console.warn(`[coverage-worker] node ${o.id} footprint outside DEM bounds; skipped`);
    return null;
  }
  const { lng, fp, outW, outH } = plan;

  // Sub-DEM sized to the footprint's real extent in shared-DEM pixels (don't
  // upsample a coarse DEM), capped at NODE_DEM_SIZE.
  const sharedLonStep = (shared.bounds.east - shared.bounds.west) / Math.max(1, shared.width - 1);
  const sharedLatStep = (shared.bounds.north - shared.bounds.south) / Math.max(1, shared.height - 1);
  const subW = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.east - fp.west) / sharedLonStep)));
  const subH = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.north - fp.south) / sharedLatStep)));
  const subDem = sliceDEM(shared, fp, subW, subH);
  const res = renderCoverageRaster(
    subDem,
    buildLiveCoverageParams(o.txDbm, src.clutterAggression, o.preset),
    itm,
    [resolveOrigin(o, lng, shared)],
    undefined,
    { width: outW, height: outH },
    src.clutter,
    src.canopy,
    src.buildings,
  );
  return { data: quantizeMargin(res.marginDb), width: outW, height: outH, bounds: fp };
}

/**
 * Max-blend one grid into a tile's q8 accumulation buffer (0 = empty/NaN).
 * Same projection + bilinear corner logic as compositeTileMargin, but in
 * q-space: the dequantization is affine, so bilerp commutes with it, and
 * rounding to a byte costs ≤0.125 dB (composite.test.ts holds the two paths
 * to that budget).
 */
export function blendGridIntoTileQ8(tx: number, ty: number, z: number, g: MarginGridQ8, tile: Uint8Array): void {
  const px0 = tx * TILE_SIZE;
  const py0 = ty * TILE_SIZE;
  const b = g.bounds;
  const tileWest = pxToLng(px0, z);
  const tileEast = pxToLng(px0 + TILE_SIZE, z);
  const tileNorth = pxToLat(py0, z);
  const tileSouth = pxToLat(py0 + TILE_SIZE, z);
  if (b.east <= tileWest || b.west >= tileEast || b.north <= tileSouth || b.south >= tileNorth) return;

  const gx0 = Math.max(px0, Math.floor(lngToPx(b.west, z)));
  const gx1 = Math.min(px0 + TILE_SIZE, Math.ceil(lngToPx(b.east, z)));
  const gy0 = Math.max(py0, Math.floor(latToPx(b.north, z)));
  const gy1 = Math.min(py0 + TILE_SIZE, Math.ceil(latToPx(b.south, z)));
  // Hoisted like compositeTileMargin: pxToLng/pxToLat recompute 2^z per call.
  const lngs = new Float64Array(gx1 - gx0);
  for (let i = 0; i < lngs.length; i++) lngs[i] = pxToLng(gx0 + i + 0.5, z);
  const { data, width, height } = g;
  for (let gpy = gy0; gpy < gy1; gpy++) {
    const lat = pxToLat(gpy + 0.5, z);
    const row = (gpy - py0) * TILE_SIZE;
    for (let gpx = gx0; gpx < gx1; gpx++) {
      const f = gridFraction(b, width, height, lngs[gpx - gx0], lat);
      if (!f) continue;
      const x0 = Math.floor(f.fx);
      const y0 = Math.floor(f.fy);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const q00 = data[y0 * width + x0];
      const q10 = data[y0 * width + x1];
      const q01 = data[y1 * width + x0];
      const q11 = data[y1 * width + x1];
      if (q00 === 0 || q10 === 0 || q01 === 0 || q11 === 0) continue; // NaN sentinel corner
      const txf = f.fx - x0;
      const tyf = f.fy - y0;
      const top = q00 + (q10 - q00) * txf;
      const qf = top + (q01 + (q11 - q01) * txf - top) * tyf;
      const qr = Math.round(qf);
      const idx = row + (gpx - px0);
      if (qr > tile[idx]) tile[idx] = qr;
    }
  }
}

/**
 * Stream grids from the margin cache into a sparse q8 canvas covering `keys`
 * (unwrapped "tx/ty" at zoom z): read one grid, max-blend it into every owned
 * tile it touches, drop it. Peak memory = the canvas + ONE grid, independent
 * of node count, clustering, or output resolution. All-empty tiles are pruned.
 */
export async function streamCompositeQ8(
  refs: Array<{ id: string; bounds: DEMBounds }>,
  keys: string[],
  z: number,
  cacheDir: string,
): Promise<{ canvas: Map<string, Uint8Array>; unreadable: string[] }> {
  const owned = new Set(keys);
  const canvas = new Map<string, Uint8Array>();
  const unreadable: string[] = [];
  for (const ref of refs) {
    const g = await readNodeGrid(cacheDir, ref.id);
    if (!g) {
      unreadable.push(ref.id);
      continue;
    }
    const r = tileRectForBounds(g.bounds, z);
    for (let ty = r.ty0; ty < r.ty1; ty++) {
      for (let tx = r.tx0; tx < r.tx1; tx++) {
        const key = `${tx}/${ty}`;
        if (!owned.has(key)) continue;
        let tile = canvas.get(key);
        if (!tile) {
          tile = new Uint8Array(TILE_SIZE * TILE_SIZE);
          canvas.set(key, tile);
        }
        blendGridIntoTileQ8(tx, ty, z, g, tile);
      }
    }
  }
  for (const [key, tile] of canvas) {
    if (!tile.some((v) => v !== 0)) canvas.delete(key); // grid overlapped but was all-NaN here
  }
  return { canvas, unreadable };
}

/** Composite one 256² tile from the node grids whose footprints intersect it;
 *  per-pixel max-margin. Returns null when the tile ends up empty.
 *  Not used in production (blendGridIntoTileQ8 is) — do not delete: it is the
 *  float-exact reference the parity test compares against. */
export function compositeTileMargin(tx: number, ty: number, z: number, nodes: MarginGridQ8[]): Float32Array | null {
  const px0 = tx * TILE_SIZE;
  const py0 = ty * TILE_SIZE;
  const tileWest = pxToLng(px0, z);
  const tileEast = pxToLng(px0 + TILE_SIZE, z);
  const tileNorth = pxToLat(py0, z);
  const tileSouth = pxToLat(py0 + TILE_SIZE, z);

  // Column lngs and row lats hoisted out of the per-grid loops (pxToLng/pxToLat
  // recompute 2^z per call; per-pixel that dominated composite time).
  const lngs = new Float64Array(TILE_SIZE);
  for (let i = 0; i < TILE_SIZE; i++) lngs[i] = pxToLng(px0 + i + 0.5, z);
  const lats = new Float64Array(TILE_SIZE);
  for (let j = 0; j < TILE_SIZE; j++) lats[j] = pxToLat(py0 + j + 0.5, z);

  let margin: Float32Array | null = null;
  for (const g of nodes) {
    const b = g.bounds;
    if (b.east <= tileWest || b.west >= tileEast || b.north <= tileSouth || b.south >= tileNorth) continue;
    const gx0 = Math.max(px0, Math.floor(lngToPx(b.west, z)));
    const gx1 = Math.min(px0 + TILE_SIZE, Math.ceil(lngToPx(b.east, z)));
    const gy0 = Math.max(py0, Math.floor(latToPx(b.north, z)));
    const gy1 = Math.min(py0 + TILE_SIZE, Math.ceil(latToPx(b.south, z)));
    for (let gpy = gy0; gpy < gy1; gpy++) {
      const lat = lats[gpy - py0];
      const row = (gpy - py0) * TILE_SIZE;
      for (let gpx = gx0; gpx < gx1; gpx++) {
        const m = marginQ8At(g, lngs[gpx - px0], lat);
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
