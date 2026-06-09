/**
 * Bake coverage tiles: one shared DEM over the network bbox; per node, render
 * single-origin coverage over a footprint sub-DEM and composite max-margin into a
 * web-mercator accumulator; colourise → slice to XYZ tiles.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { renderCoverageRaster } from "../src/pages/map/coverageRaster";
import { type ItmContext, loadItmContext } from "../src/pages/map/itm";
import { buildLiveCoverageParams, LIVE_ANTENNA_AGL_M } from "../src/pages/map/live/liveCoverageParams";
import {
  type DEM,
  type DEMBounds,
  demBoundsAround,
  sampleDEMAt,
  unionDemBoundsAround,
} from "../src/pages/map/terrainDEM";
import { buildDem } from "../src/pages/map/terrainRgb";
import { colorizeMargin } from "./colorize";
import * as cfg from "./config";
import { latToPx, lngToPx, pxToLat, pxToLng, TILE_SIZE } from "./mercator";
import type { CoverageOrigin } from "./nodes";
import { encodePng } from "./sharpImage";

const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;

export interface BakeMetadata {
  version: string;
  generatedAt: string;
  bounds: [number, number, number, number]; // [west, south, east, north]
  minZoom: number;
  maxZoom: number;
  nodeCount: number;
  tileCount: number;
  recencyHours: number;
  sources: string[];
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

/** Composite all nodes into a tile-aligned web-mercator margin accumulator at zoom `z`. */
function renderAccumulator(
  origins: CoverageOrigin[],
  shared: DEM,
  bbox: DEMBounds,
  itm: ItmContext,
  z: number,
) {
  const tx0 = Math.floor(lngToPx(bbox.west, z) / TILE_SIZE);
  const tx1 = Math.ceil(lngToPx(bbox.east, z) / TILE_SIZE);
  const ty0 = Math.floor(latToPx(bbox.north, z) / TILE_SIZE);
  const ty1 = Math.ceil(latToPx(bbox.south, z) / TILE_SIZE);
  const accX0 = tx0 * TILE_SIZE;
  const accY0 = ty0 * TILE_SIZE;
  const accW = (tx1 - tx0) * TILE_SIZE;
  const accH = (ty1 - ty0) * TILE_SIZE;
  const margin = new Float32Array(accW * accH);
  margin.fill(Number.NaN);

  for (const o of origins) {
    const fp = clampBounds(demBoundsAround([o.lng, o.lat], o.reachKm, 1.0), bbox);
    if (fp.east <= fp.west || fp.north <= fp.south) continue;

    // Render grid capped well below the footprint's z-pixel extent: coverage is
    // smooth, so it upsamples into the accumulator cleanly and ITM cost stays off
    // the MAX_ZOOM treadmill (terrain stays fine via the sub-DEM).
    const fpPxW = lngToPx(fp.east, z) - lngToPx(fp.west, z);
    const fpPxH = latToPx(fp.south, z) - latToPx(fp.north, z);
    const outW = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpPxW)));
    const outH = Math.max(8, Math.min(cfg.NODE_OUTPUT_MAX, Math.ceil(fpPxH)));

    // Sub-DEM sized to the footprint's real extent in shared-DEM pixels (don't
    // upsample a coarse DEM), capped at NODE_DEM_SIZE.
    const sharedLonStep = (shared.bounds.east - shared.bounds.west) / Math.max(1, shared.width - 1);
    const sharedLatStep = (shared.bounds.north - shared.bounds.south) / Math.max(1, shared.height - 1);
    const subW = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.east - fp.west) / sharedLonStep)));
    const subH = Math.max(16, Math.min(cfg.NODE_DEM_SIZE, Math.ceil((fp.north - fp.south) / sharedLatStep)));
    const subDem = sliceDEM(shared, fp, subW, subH);
    const params = buildLiveCoverageParams(o.txDbm);
    const origin = resolveOrigin(o, shared);
    const res = renderCoverageRaster(subDem, params, itm, [origin], undefined, {
      width: outW,
      height: outH,
    });
    // Node margin grid as a DEM-shaped raster so sampleDEMAt bilinear-samples it.
    const nodeGrid: DEM = { data: res.marginDb, width: outW, height: outH, bounds: fp };

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

  return { margin, accX0, accY0, accW, accH, tx0, tx1, ty0, ty1 };
}

/** Extract a 256² RGBA tile from the accumulator RGBA at (ox, oy). */
function extractTile(rgba: Uint8ClampedArray, accW: number, accH: number, ox: number, oy: number) {
  const tile = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  let any = false;
  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const ay = oy + ty;
    if (ay < 0 || ay >= accH) continue;
    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const ax = ox + tx;
      if (ax < 0 || ax >= accW) continue;
      const a = rgba[(ay * accW + ax) * 4 + 3];
      if (a === 0) continue;
      const di = (ty * TILE_SIZE + tx) * 4;
      const si = (ay * accW + ax) * 4;
      tile[di] = rgba[si];
      tile[di + 1] = rgba[si + 1];
      tile[di + 2] = rgba[si + 2];
      tile[di + 3] = a;
      any = true;
    }
  }
  return any ? tile : null;
}

/** Bake to a temp dir then atomically swap into OUTPUT_DIR; returns + writes metadata.json. */
export async function bakeCoverage(origins: CoverageOrigin[], version: string): Promise<BakeMetadata> {
  const itm = await loadItmContext(128);
  const positions = origins.map((o) => [o.lng, o.lat] as [number, number]);
  const maxReach = origins.reduce((m, o) => Math.max(m, o.reachKm), cfg.CLIENT_REACH_KM);
  const bbox = unionDemBoundsAround(positions, maxReach, 1.05);

  const { dem: shared } = await buildDem({
    bounds: bbox,
    targetWidth: cfg.SHARED_DEM_SIZE,
    targetHeight: cfg.SHARED_DEM_SIZE,
    token: "",
    maxTiles: 1024,
  });

  const tmpDir = `${cfg.OUTPUT_DIR}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  let tileCount = 0;

  const acc = renderAccumulator(origins, shared, bbox, itm, cfg.MAX_ZOOM);
  const accRgba = colorizeMargin(acc.margin, acc.accW * acc.accH);

  for (let tx = acc.tx0; tx < acc.tx1; tx++) {
    for (let ty = acc.ty0; ty < acc.ty1; ty++) {
      const tile = extractTile(accRgba, acc.accW, acc.accH, tx * TILE_SIZE - acc.accX0, ty * TILE_SIZE - acc.accY0);
      if (!tile) continue;
      const png = await encodePng(tile, TILE_SIZE, TILE_SIZE);
      const p = join(tmpDir, String(cfg.MAX_ZOOM), String(tx), `${ty}.png`);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, png);
      tileCount++;
    }
  }

  const meta: BakeMetadata = {
    version,
    generatedAt: new Date().toISOString(),
    bounds: [bbox.west, bbox.south, bbox.east, bbox.north],
    minZoom: cfg.MAX_ZOOM, // single zoom level for now
    maxZoom: cfg.MAX_ZOOM,
    nodeCount: origins.length,
    tileCount,
    recencyHours: cfg.RECENCY_HOURS,
    sources: ["itm"],
  };
  await writeFile(join(tmpDir, "metadata.json"), JSON.stringify(meta, null, 2));

  // Swap old aside, new into place.
  const oldDir = `${cfg.OUTPUT_DIR}.old`;
  await rm(oldDir, { recursive: true, force: true });
  await rename(cfg.OUTPUT_DIR, oldDir).catch(() => {});
  await mkdir(dirname(cfg.OUTPUT_DIR) || ".", { recursive: true });
  await rename(tmpDir, cfg.OUTPUT_DIR);
  await rm(oldDir, { recursive: true, force: true });

  return meta;
}
