import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { toast } from "../../components/toast";
import { env } from "../../env";
import { buildBuildingRaster, type BuildingRaster, downsampleBuildingRaster } from "./buildingTiles";
import { buildCanopyRaster, type CanopyRaster, downsampleCanopyRaster } from "./canopyTiles";
import { AGGRESSION_STOPS, type MergeOrigin, reliabilityPreset, REPRESENTATIVE_CLUTTER_DB } from "./coverageAnalysis";
import { type ContourFeatureCollection, extractCoverageContours } from "./coverageContours";
import { COVERAGE_DETAIL_MAX_TILES, COVERAGE_DETAIL_SIZE } from "./coverageDetail";
import { exportCoverage } from "./coverageExport";
import type { RasterParams } from "./coverageRaster";
import { extractCoverageRays, type VisibilityRayFeatureCollection } from "./coverageRays";
import type { CoverageSliceRequest, SliceOrigin } from "./coverageSliceWorker";
import { CoverageWorkerPool } from "./coverageWorkerPool";
import { queryTerrainElevationMSL } from "./helpers";
import { buildClutterRaster, type ClutterRaster, downsampleClutterRaster } from "./landcoverTiles";
import { type DEM, type DEMBounds, demBoundsAround, downsampleDEM, sampleDEMAt } from "./terrainDEM";
import { buildDem, fetchElevationAt } from "./terrainRgb";
import type { IMapNode } from "./types";
import type { CoverageState } from "./useCoverageState";

type CoverageComputeParams = {
  coverage: CoverageState;
  // Tool state
  activeTool: "los" | "traceroute" | "coverage" | "scan" | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolVirtualPos: [number, number] | null;
  setToolFromId: (id: string | null) => void;
  setToolVirtualPos: (p: [number, number] | null) => void;
  // Other map state
  provider: string;
  terrain3D: boolean;
  nodes: Record<string, IMapNode>;
  // Refs
  mbMapRef: React.RefObject<MlMap | null>;
  isDraggingMarkerRef: React.RefObject<boolean>;
  // Merge origins
  coverageMergeOrigins: MergeOrigin[];
  setCoverageMergeOrigins: React.Dispatch<React.SetStateAction<MergeOrigin[]>>;
  pickingMergeOrigin: boolean;
  setPickingMergeOrigin: (v: boolean) => void;
  moveCoverageMergeOrigin: (id: string, position: [number, number]) => void;
};

export function useCoverageCompute(params: CoverageComputeParams) {
  const {
    coverage: c,
    activeTool, toolStep, toolFromId, toolVirtualPos,
    setToolFromId, setToolVirtualPos,
    provider, terrain3D, nodes,
    mbMapRef, isDraggingMarkerRef,
    coverageMergeOrigins, setCoverageMergeOrigins,
    pickingMergeOrigin, setPickingMergeOrigin,
    moveCoverageMergeOrigin,
  } = params;

  // DEM/raster bbox size from free-space budget. Capped at 200 km — beyond that
  // low tile-zoom averages terrain away (Mt. Oso reads ~200 m low at 500 km bbox).
  // The sizer can't run the per-pixel clutter model before the bbox exists, so
  // it uses REPRESENTATIVE_CLUTTER_DB scaled by aggression as a sizing heuristic.
  // When the user disables the model entirely, drop the clutter term to 0.
  const coverageRadiusKm = useMemo(() => {
    const CABLE = 0.5;
    const FADE = 15;
    const aggression = c.coverageClutterEnabled
      ? (AGGRESSION_STOPS[c.coverageAggressionIdx]?.value ?? 1.0)
      : 0;
    const clutter = REPRESENTATIVE_CLUTTER_DB * aggression;
    const budget =
      c.coverageTxDbm +
      c.coverageAntennaDbi +
      c.coverageRxAntennaDbi -
      c.coverageEffectiveSensitivityDbm -
      FADE -
      CABLE -
      clutter;
    const plConstant = 32.45 + 20 * Math.log10(915);
    const maxKm = Math.pow(10, (budget - plConstant) / 20);
    return Math.max(5, Math.min(200, Math.round(maxKm)));
  }, [c.coverageAntennaDbi, c.coverageRxAntennaDbi, c.coverageTxDbm, c.coverageEffectiveSensitivityDbm, c.coverageAggressionIdx, c.coverageClutterEnabled]);

  /** DOM pin for the Coverage origin (draggable). */
  const coverageOriginMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Per-id pins for additional merge origins; amber to distinguish from primary cyan.
   *  globalThis.Map qualifies the constructor — the component itself is named `Map`. */
  const coverageMergeMarkersRef = useRef<Map<string, maplibregl.Marker>>(new globalThis.Map());
  /** Last origin we recentered on; used to suppress easeTo across pure parameter changes. */
  const lastRecenteredOriginRef = useRef<[number, number] | null>(null);
  /** Monotonic request id — stale worker replies are dropped. */
  const coverageRequestIdRef = useRef(0);
  // Suppresses the redundant coverage recompute the activeTool flip would
  // otherwise trigger on Scan-from-here overlay enter/exit.
  const skipNextCoverageComputeRef = useRef(false);
  /** Lazily-created coverage worker pool; terminated on unmount. */
  const coveragePoolRef = useRef<CoverageWorkerPool | null>(null);
  const ensureCoveragePool = useCallback((): CoverageWorkerPool => {
    if (!coveragePoolRef.current) {
      coveragePoolRef.current = new CoverageWorkerPool();
    }
    return coveragePoolRef.current;
  }, []);
  useEffect(() => {
    return () => {
      coveragePoolRef.current?.terminate();
      coveragePoolRef.current = null;
    };
  }, []);

  /** Cached authoritative DEM; drag-preview reuses it without re-fetching tiles. */
  const coverageDemRef = useRef<DEM | null>(null);
  /** 256² downsample of the above; lets drag preview run LR at ~8-12 fps. */
  const coverageDragDemRef = useRef<DEM | null>(null);
  /** Authoritative + 256² downsampled class-ID rasters; drag preview reuses these. */
  const coverageClutterRef = useRef<ClutterRaster | null>(null);
  const coverageDragClutterRef = useRef<ClutterRaster | null>(null);
  /** Authoritative + 256² downsampled canopy-height rasters; drag preview reuses these. */
  const coverageCanopyRef = useRef<CanopyRaster | null>(null);
  const coverageDragCanopyRef = useRef<CanopyRaster | null>(null);
  /** Authoritative + 256² downsampled building-height rasters; drag preview reuses these. */
  const coverageBuildingsRef = useRef<BuildingRaster | null>(null);
  const coverageDragBuildingsRef = useRef<BuildingRaster | null>(null);
  /** Latest raster params snapshot (drag preview reuses untouched). */
  const coverageLastRasterParamsRef = useRef<RasterParams | null>(null);
  /** Last origin context (bounds); drag re-samples DEM per move. */
  const coverageLastOriginContextRef = useRef<{ bounds: DEMBounds } | null>(null);
  /** Single-flight drag preview; latest pending position fires when current completes. */
  const dragPreviewBusyRef = useRef(false);
  const dragPreviewPendingRef = useRef<[number, number] | null>(null);

  /** Cached contour GeoJSON for Export without recomputing. */
  const coverageContoursRef = useRef<ContourFeatureCollection | null>(null);
  /** Cached visibility-ray fan. */
  const coverageRaysRef = useRef<VisibilityRayFeatureCollection | null>(null);
  /** Cached margin grid for export. */
  const coverageMarginRef = useRef<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: DEMBounds;
  } | null>(null);
  /** Blob URL for coverage-raster; tracked so we revoke on update/close (else ~5 MB leak per Survey compute). */
  const coverageRasterUrlRef = useRef<string | null>(null);

  /** Latest coverage result exposed via ref for export. */
  const coverageResultRef = useRef(c.coverageResult);
  useEffect(() => {
    coverageResultRef.current = c.coverageResult;
  }, [c.coverageResult]);

  /** Export coverage as GeoJSON or KML (iso-margin 0/10/20 dB contours + metadata). */
  const handleCoverageExport = useCallback((format: "geojson" | "kml") => {
    if (!coverageResultRef.current || !coverageContoursRef.current) {
      toast("Nothing to export yet — run a coverage prediction first.");
      return;
    }
    exportCoverage(format, coverageContoursRef.current, coverageResultRef.current);
    toast(`Coverage exported as ${format.toUpperCase()}.`, { kind: "success" });
  }, []);

  /** Run pool over a DEM, stitch slices, paint RGBA to `coverage-raster`.
   *  Shared by main compute + drag preview. Null = superseded or WASM missing. */
  const renderCoverageToImageSource = useCallback(async (opts: {
    dem: DEM;
    /** Optional class-ID raster aligned to DEM bounds. Null = workers fall back to default class. */
    clutter?: ClutterRaster | null;
    /** Optional canopy-height raster aligned to DEM bounds. Null = workers fall back to class-nominal. */
    canopy?: CanopyRaster | null;
    /** Optional building-height raster aligned to DEM bounds. Null = bare-earth + class-nominal endpoint h_a. */
    buildings?: BuildingRaster | null;
    /** Primary + (optional) merge origins. Single-element array preserves the
     *  pre-merge single-origin compute byte-identically. */
    origins: SliceOrigin[];
    params: RasterParams;
    requestId: number;
    /** Defaults to DEM dims (drag-preview path where DEM == output == 256²). */
    outputWidth?: number;
    outputHeight?: number;
    /** Per-slice progress (completed, total); drag preview omits this. */
    onSliceProgress?: (completed: number, total: number) => void;
  }): Promise<{
    clearCount: number;
    fresnelCount: number;
    blockedCount: number;
    demCoveredPixels: number;
    totalPx: number;
    /** Stitched margin dB; NaN = no-data. */
    marginDb: Float32Array;
    /** Actual output dims (callers use these for contours). */
    outputWidth: number;
    outputHeight: number;
    itmUnavailable?: boolean;
  } | null> => {
    const { dem, clutter, canopy, buildings, origins, params: rp, requestId, onSliceProgress } = opts;
    const outputWidth = opts.outputWidth ?? dem.width;
    const outputHeight = opts.outputHeight ?? dem.height;
    const mb = mbMapRef.current;
    if (!mb) return null;
    const pool = ensureCoveragePool();
    const poolSize = pool.size;
    const rowsPerTask = Math.ceil(outputHeight / poolSize);

    const sliceResponses: Array<{
      rgba: Uint8ClampedArray;
      marginDb: Float32Array;
      rowStart: number;
      rowEnd: number;
      clearCount: number;
      fresnelCount: number;
      blockedCount: number;
      itmUnavailable?: boolean;
    }> = [];
    const tasks: Promise<unknown>[] = [];
    const totalSlices = Math.min(
      poolSize,
      Math.ceil(outputHeight / rowsPerTask),
    );
    let completedSlices = 0;
    onSliceProgress?.(0, totalSlices);

    for (let i = 0; i < poolSize; i++) {
      const rowStart = i * rowsPerTask;
      if (rowStart >= outputHeight) break;
      const rowEnd = Math.min(rowStart + rowsPerTask, outputHeight);
      const demCopy = new Float32Array(dem.data);
      // Transferable buffers can't be shared across workers; copy per slice.
      const clutterCopy = clutter ? new Uint8Array(clutter.data) : null;
      const canopyHeightCopy = canopy ? new Float32Array(canopy.heightM) : null;
      const canopyStdCopy = canopy ? new Float32Array(canopy.stdM) : null;
      const canopyMaskCopy = canopy ? new Float32Array(canopy.mask) : null;
      const buildingHeightCopy = buildings ? new Float32Array(buildings.heightM) : null;
      const buildingMaskCopy = buildings ? new Float32Array(buildings.mask) : null;
      const req: CoverageSliceRequest = {
        requestId,
        demBuffer: demCopy.buffer,
        demWidth: dem.width,
        demHeight: dem.height,
        bounds: dem.bounds,
        origins,
        params: rp,
        outputWidth,
        outputHeight,
        rowStart,
        rowEnd,
        clutterBuffer: clutterCopy?.buffer,
        clutterWidth: clutter?.width,
        clutterHeight: clutter?.height,
        canopyHeightBuffer: canopyHeightCopy?.buffer,
        canopyStdBuffer: canopyStdCopy?.buffer,
        canopyMaskBuffer: canopyMaskCopy?.buffer,
        canopyWidth: canopy?.width,
        canopyHeight: canopy?.height,
        buildingHeightBuffer: buildingHeightCopy?.buffer,
        buildingMaskBuffer: buildingMaskCopy?.buffer,
        buildingWidth: buildings?.width,
        buildingHeight: buildings?.height,
      };
      const transfer: Transferable[] = [demCopy.buffer];
      if (clutterCopy) transfer.push(clutterCopy.buffer);
      if (canopyHeightCopy) transfer.push(canopyHeightCopy.buffer);
      if (canopyStdCopy) transfer.push(canopyStdCopy.buffer);
      if (canopyMaskCopy) transfer.push(canopyMaskCopy.buffer);
      if (buildingHeightCopy) transfer.push(buildingHeightCopy.buffer);
      if (buildingMaskCopy) transfer.push(buildingMaskCopy.buffer);
      tasks.push(
        pool.dispatch(req, transfer).then((resp) => {
          sliceResponses.push(resp);
          completedSlices += 1;
          if (requestId === coverageRequestIdRef.current) {
            onSliceProgress?.(completedSlices, totalSlices);
          }
        }),
      );
    }
    await Promise.all(tasks);

    // Bail if superseded
    if (requestId !== coverageRequestIdRef.current) return null;

    if (sliceResponses.some((r) => r.itmUnavailable)) {
      const nanMargin = new Float32Array(outputWidth * outputHeight);
      nanMargin.fill(Number.NaN);
      return {
        clearCount: 0, fresnelCount: 0, blockedCount: 0,
        demCoveredPixels: 0, totalPx: outputWidth * outputHeight,
        marginDb: nanMargin,
        outputWidth, outputHeight,
        itmUnavailable: true,
      };
    }

    const fullRgba = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    const fullMargin = new Float32Array(outputWidth * outputHeight);
    let clearCount = 0;
    let fresnelCount = 0;
    let blockedCount = 0;
    for (const s of sliceResponses) {
      fullRgba.set(s.rgba, s.rowStart * outputWidth * 4);
      fullMargin.set(s.marginDb, s.rowStart * outputWidth);
      clearCount += s.clearCount;
      fresnelCount += s.fresnelCount;
      blockedCount += s.blockedCount;
    }
    const demCoveredPixels = clearCount + fresnelCount + blockedCount;

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imgData = new ImageData(
      fullRgba as Uint8ClampedArray<ArrayBuffer>,
      outputWidth,
      outputHeight,
    );
    ctx.putImageData(imgData, 0, 0);

    // Blob URL (not data URL): at 2048² raw RGBA is ~16 MB, data URL would base64-encode 22 MB
    const url = await new Promise<string>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
        resolve(URL.createObjectURL(blob));
      }, "image/png");
    });

    const src = mb.getSource("coverage-raster") as maplibregl.ImageSource | undefined;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [dem.bounds.west, dem.bounds.north],
      [dem.bounds.east, dem.bounds.north],
      [dem.bounds.east, dem.bounds.south],
      [dem.bounds.west, dem.bounds.south],
    ];
    type UpdateImageFn = (o: { url: string; coordinates: typeof coords }) => void;
    const updateImage = (src as unknown as { updateImage?: UpdateImageFn }).updateImage;
    if (src && typeof updateImage === "function") {
      updateImage.call(src, { url, coordinates: coords });
      // Revoke previous blob — the GPU already holds the new texture.
      const previous = coverageRasterUrlRef.current;
      coverageRasterUrlRef.current = url;
      if (previous) URL.revokeObjectURL(previous);
    } else {
      URL.revokeObjectURL(url);
    }
    if (mb.getLayer("coverage-raster")) {
      mb.setLayoutProperty("coverage-raster", "visibility", "visible");
    }

    return {
      clearCount,
      fresnelCount,
      blockedCount,
      demCoveredPixels,
      totalPx: outputWidth * outputHeight,
      marginDb: fullMargin,
      outputWidth,
      outputHeight,
    };
  }, [ensureCoveragePool, mbMapRef]);

  // Coverage prediction — also runs while a Scan-from-here overlay is active
  // so coverage-setting tweaks through the minimized panel still recompute.
  useEffect(() => {
    if ((activeTool !== "coverage" && !c.keepCoveragePaint) || toolStep !== "result") {
      // Overlay holds onto the result so the paint stays up and the
      // minimized panel keeps showing the reachable summary.
      if (!c.keepCoveragePaint) c.setCoverageResult(null);
      c.setIsComputingCoverage(false);
      c.setIsFetchingCoverageTerrain(false);
      c.setCoverageError(null);
      c.setCoverageProgress({ completed: 0, total: 0 });
      lastRecenteredOriginRef.current = null;
      return;
    }
    // Suppress the redundant recompute on overlay enter/exit (params unchanged).
    if (skipNextCoverageComputeRef.current) {
      skipNextCoverageComputeRef.current = false;
      return;
    }
    if (!terrain3D) {
      c.setCoverageResult(null);
      c.setIsComputingCoverage(false);
      c.setIsFetchingCoverageTerrain(false);
      c.setCoverageProgress({ completed: 0, total: 0 });
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) {
      c.setCoverageResult(null);
      return;
    }

    // Determine origin: either a node, or a virtual position on the map
    let origin: [number, number] | null = null;
    let altitude: number | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) {
        origin = [n.map_position[0], n.map_position[1]];
        altitude = n.position?.altitude ?? null;
      }
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
      altitude = null; // virtual = no known altitude, will fall back to terrain + antenna
    }
    if (!origin) {
      c.setCoverageResult(null);
      return;
    }

    // Mark as computing but keep the previous result visible so controls stay up
    c.setIsComputingCoverage(true);
    c.setCoverageError(null);
    c.setCoverageProgress({ completed: 0, total: 0 });

    const radKm = coverageRadiusKm;
    // Union bbox over primary + merge origins (all share radiusKm since TX
    // params are global). Empty merge set collapses to the primary's bbox.
    const primaryBounds = demBoundsAround(origin, radKm, 1.05);
    let demBounds = primaryBounds;
    if (coverageMergeOrigins.length > 0) {
      let west = primaryBounds.west, south = primaryBounds.south;
      let east = primaryBounds.east, north = primaryBounds.north;
      for (const m of coverageMergeOrigins) {
        const b = demBoundsAround(m.position, radKm, 1.05);
        if (b.west < west) west = b.west;
        if (b.south < south) south = b.south;
        if (b.east > east) east = b.east;
        if (b.north > north) north = b.north;
      }
      demBounds = { west, south, east, north };
    }
    // Recenter only when the origin actually moved; pure parameter recomputes
    // (TX power, antenna, clutter on/off, etc.) shouldn't yank the user's view.
    const prev = lastRecenteredOriginRef.current;
    const movedSignificantly =
      !prev ||
      Math.abs(prev[0] - origin[0]) > 1e-6 ||
      Math.abs(prev[1] - origin[1]) > 1e-6;
    if (movedSignificantly) {
      mb.easeTo({ center: origin, duration: 300 });
      lastRecenteredOriginRef.current = [origin[0], origin[1]];
    }

    const mapboxToken = env.MAPBOX_TOKEN;
    if (!mapboxToken) {
      console.warn("[Map] Coverage compute aborted — Mapbox token missing.");
      c.setIsComputingCoverage(false);
      return;
    }

    const requestId = ++coverageRequestIdRef.current;
    let cancelled = false;

    // Pool-based compute: fetch DEM once, slice to workers, stitch RGBA.
    // DEM is fixed 2048²; "Detail" only changes OUTPUT_SIZE (paint pixelation, not RF accuracy).
    const DEM_SIZE = 2048;
    const OUTPUT_SIZE = COVERAGE_DETAIL_SIZE[c.coverageDetail];
    const rel = reliabilityPreset(c.coverageReliability);
    const rasterParams: RasterParams = {
      freqMhz: 915,
      txDbm: c.coverageTxDbm,
      txAntennaDbi: c.coverageAntennaDbi,
      rxAntennaDbi: c.coverageRxAntennaDbi,
      rxAntennaHeightAboveGroundM: c.coverageRxHeightM,
      rxSensitivityDbm: c.coverageEffectiveSensitivityDbm,
      fadeMarginDb: 15,
      cableLossDb: 0.5,
      clutterAggression: c.coverageClutterEnabled
        ? (AGGRESSION_STOPS[c.coverageAggressionIdx]?.value ?? 1.0)
        : 0,
      // Continental Temperate + N=301 is the NA Meshtastic default
      climate: 5 /* Climate.ContinentalTemperate */,
      surfaceRefractivityN: 301,
      polarization: 1 /* Polarization.Vertical */,
      groundDielectric: 15,
      groundConductivity: 0.005,
      timePct: rel.time,
      locationPct: rel.location,
      situationPct: rel.situation,
    };

    (async () => {
      const t0 = performance.now();
      const timings: Record<string, number> = {};
      const mark = (name: string, fromMs: number) => {
        timings[name] = performance.now() - fromMs;
      };
      try {
        // 1. Fetch terrain + (when enabled) land-cover + canopy + buildings in
        //    parallel; all at DEM_SIZE so the worker samples them at the same
        //    lng/lat indexing. Skip individual fetches when their respective
        //    models are toggled off — saves the network + decode cost.
        const tFetch = performance.now();
        c.setIsFetchingCoverageTerrain(true);
        const [{ dem, source: demSourceUsed }, clutter, canopy, buildings] = await Promise.all([
          buildDem({
            bounds: demBounds,
            targetWidth: DEM_SIZE,
            targetHeight: DEM_SIZE,
            token: mapboxToken,
            maxTiles: COVERAGE_DETAIL_MAX_TILES[c.coverageDetail],
          }),
          c.coverageClutterEnabled
            ? buildClutterRaster({
                bounds: demBounds,
                targetWidth: DEM_SIZE,
                targetHeight: DEM_SIZE,
                maxTiles: COVERAGE_DETAIL_MAX_TILES[c.coverageDetail],
              })
            : Promise.resolve(null),
          c.coverageCanopyEnabled
            ? buildCanopyRaster({
                bounds: demBounds,
                targetWidth: DEM_SIZE,
                targetHeight: DEM_SIZE,
                maxTiles: COVERAGE_DETAIL_MAX_TILES[c.coverageDetail],
              })
            : Promise.resolve(null),
          c.coverageBuildingsEnabled
            ? buildBuildingRaster({
                bounds: demBounds,
                targetWidth: DEM_SIZE,
                targetHeight: DEM_SIZE,
                maxTiles: COVERAGE_DETAIL_MAX_TILES[c.coverageDetail],
              })
            : Promise.resolve(null),
        ]);
        c.setCoverageDemSource(demSourceUsed);
        c.setCoverageClutterStatus(
          clutter ? { tilesPresent: clutter.tilesPresent, tilesTotal: clutter.tilesTotal } : null,
        );
        c.setCoverageCanopyStatus(
          canopy ? { tilesPresent: canopy.tilesPresent, tilesTotal: canopy.tilesTotal } : null,
        );
        c.setCoverageBuildingsStatus(
          buildings ? { tilesPresent: buildings.tilesPresent, tilesTotal: buildings.tilesTotal } : null,
        );
        mark("demFetchMs", tFetch);
        if (cancelled || requestId !== coverageRequestIdRef.current) {
          c.setIsFetchingCoverageTerrain(false);
          return;
        }
        c.setIsFetchingCoverageTerrain(false);

        // Resolve origin ground via two independent sources; we take the MAX because
        // a low-zoom-averaged reading can only under-report a peak, never over-report:
        //   1. `queryTerrainElevation` reads the loaded raster-dem tiles. Accurate when
        //      zoomed in (~5-30 m px at z=13-14); at low zoom can under-read a peak by ~180 m.
        //   2. `fetchElevationAt` does a dedicated z=15 fetch — viewport-independent,
        //      LRU-cached. Source: Tilezen (USGS 3DEP / SRTM), Mapbox terrain-RGB fallback.
        // queryTerrainElevationMSL undoes MapLibre's built-in exaggeration multiply.
        const mbElev = queryTerrainElevationMSL(mb, origin!);
        const mbElevOk = typeof mbElev === "number" && Number.isFinite(mbElev);
        const fetchElev = await fetchElevationAt(origin![0], origin![1], mapboxToken);
        const fetchOk = fetchElev != null && Number.isFinite(fetchElev);
        let originGroundHighZoom: number | null = null;
        if (mbElevOk && fetchOk) {
          originGroundHighZoom = Math.max(mbElev, fetchElev);
        } else if (mbElevOk) {
          originGroundHighZoom = mbElev;
        } else if (fetchOk) {
          originGroundHighZoom = fetchElev;
        }
        const originGroundFromDem = sampleDEMAt(dem, origin![0], origin![1]);
        const groundOkDem = !Number.isNaN(originGroundFromDem);
        const groundOkHz = originGroundHighZoom != null;
        const groundOk = groundOkHz || groundOkDem;
        // Narrowed to number with a 0 fallback; downstream usage is guarded by groundOk.
        const originGround: number = groundOkHz
          ? (originGroundHighZoom as number)
          : groundOkDem
            ? originGroundFromDem
            : 0;
        // Guards against junk altitudes (GPS glitch, unit-scaled values); matches losAnalysis.ts
        const MAX_HEIGHT_ABOVE_TERRAIN_M = 1000;
        const altValid =
          altitude != null &&
          Number.isFinite(altitude) &&
          (!groundOk ||
            (altitude >= originGround &&
              altitude <= originGround + MAX_HEIGHT_ABOVE_TERRAIN_M));
        const baseM = altValid
          ? (altitude as number)
          : (groundOk ? originGround : 0);
        const originHeightM = baseM + c.coverageAntennaHeightM;
        const originIsFallback = !groundOk && !altValid;
        // ITM wants TX height above profile[0] (bbox DEM value). Compensate so TX MSL matches
        // originHeightM after profile[0]+txHeight. Collapses to antennaHeight on flat terrain.
        const txAboveGroundM = groundOkDem
          ? originHeightM - originGroundFromDem
          : c.coverageAntennaHeightM;

        // Sample terrain off the same DEM the workers see so txHeightM (AGL
        // relative to profile[0]) collapses cleanly to coverageAntennaHeightM
        // on flat terrain.
        const mergeOriginsResolved: SliceOrigin[] = [];
        for (const m of coverageMergeOrigins) {
          const terrain = sampleDEMAt(dem, m.position[0], m.position[1]);
          const terrainOk = !Number.isNaN(terrain);
          const altOk =
            m.altitudeM != null &&
            Number.isFinite(m.altitudeM) &&
            (!terrainOk ||
              (m.altitudeM >= terrain && m.altitudeM <= terrain + 1000));
          const baseM = altOk ? (m.altitudeM as number) : (terrainOk ? terrain : 0);
          const heightM = baseM + c.coverageAntennaHeightM;
          mergeOriginsResolved.push({
            position: m.position,
            heightM,
            antennaHeightAboveGroundM: terrainOk ? heightM - terrain : c.coverageAntennaHeightM,
          });
        }

        // 3. Dispatch pool; OUTPUT_SIZE decoupled from DEM_SIZE so Detail only changes paint sharpness
        const tDispatch = performance.now();
        const rendered = await renderCoverageToImageSource({
          dem,
          clutter,
          canopy,
          buildings,
          origins: [
            {
              position: origin!,
              heightM: originHeightM,
              antennaHeightAboveGroundM: txAboveGroundM,
            },
            ...mergeOriginsResolved,
          ],
          params: rasterParams,
          requestId,
          outputWidth: OUTPUT_SIZE,
          outputHeight: OUTPUT_SIZE,
          onSliceProgress: (completed, total) => {
            c.setCoverageProgress({ completed, total });
          },
        });
        mark("poolComputeMs", tDispatch);
        if (cancelled || requestId !== coverageRequestIdRef.current) return;
        if (!rendered) {
          // Current request (supersession returned above) → hard failure; a
          // vanished map is a benign teardown, so only surface a real failure.
          c.setIsComputingCoverage(false);
          c.setCoverageProgress({ completed: 0, total: 0 });
          if (mbMapRef.current) {
            c.setCoverageResult(null);
            c.setCoverageError("Coverage compute failed. See the developer console and try again.");
          }
          return;
        }
        if (rendered.itmUnavailable) {
          console.warn(
            "[Map] Coverage compute: ITM WASM not built. Run `yarn build:wasm`.",
          );
          c.setCoverageResult(null);
          c.setIsComputingCoverage(false);
          c.setCoverageProgress({ completed: 0, total: 0 });
          c.setCoverageError(
            "Coverage model unavailable — the ITM WebAssembly module failed to load. " +
              "Try refreshing the page; if the problem persists, check the developer console.",
          );
          return;
        }

        // 4. Cache full + downsampled rasters for the drag-preview pass.
        coverageDemRef.current = dem;
        coverageDragDemRef.current = downsampleDEM(dem, 256, 256);
        coverageClutterRef.current = clutter;
        coverageDragClutterRef.current = clutter ? downsampleClutterRaster(clutter, 256, 256) : null;
        coverageCanopyRef.current = canopy;
        coverageDragCanopyRef.current = canopy ? downsampleCanopyRaster(canopy, 256, 256) : null;
        coverageBuildingsRef.current = buildings;
        coverageDragBuildingsRef.current = buildings ? downsampleBuildingRaster(buildings, 256, 256) : null;
        coverageLastRasterParamsRef.current = rasterParams;
        coverageLastOriginContextRef.current = { bounds: dem.bounds };

        // 5. Iso-contours (0 dB = edge, +10 reliable, +20 strong) from output-sized margin grid
        coverageMarginRef.current = {
          data: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
        };
        const contours = extractCoverageContours({
          margin: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
          thresholdsDb: [0, 10, 20],
        });
        coverageContoursRef.current = contours;
        try {
          const src = mb.getSource("coverage-contours") as MlGeoJSONSource | undefined;
          src?.setData(contours);
        } catch {}

        // 6. Visibility rays: R2 viewshed AND margin grid; costs ~50-100 ms
        const rays = extractCoverageRays({
          dem,
          margin: rendered.marginDb,
          width: rendered.outputWidth,
          height: rendered.outputHeight,
          bounds: dem.bounds,
          origin: origin!,
          originHeightM,
          azimuthStepDeg: 1,
        });
        coverageRaysRef.current = rays;
        try {
          const src = mb.getSource("coverage-rays") as MlGeoJSONSource | undefined;
          src?.setData(rays);
        } catch {}

        const computeMs = performance.now() - t0;
        if (import.meta.env.DEV) {
          console.info(
            `[Map] Coverage compute: ${computeMs.toFixed(0)} ms ` +
              `for ${OUTPUT_SIZE}² output / ${DEM_SIZE}² dem across ${ensureCoveragePool().size} workers ` +
              `(${Math.round((rendered.demCoveredPixels / rendered.totalPx) * 100)}% terrain-covered)`,
            timings,
          );
        }

        c.setCoverageResult({
          origin: origin!,
          originHeightM,
          originIsFallback,
          radiusKm: radKm,
          clearCount: rendered.clearCount,
          fresnelCount: rendered.fresnelCount,
          blockedCount: rendered.blockedCount,
          scannedPixels: rendered.totalPx,
          frequencyGHz: 0.915,
          txAntennaDbi: c.coverageAntennaDbi,
          rxAntennaDbi: c.coverageRxAntennaDbi,
          rxAntennaHeightAboveGroundM: c.coverageRxHeightM,
          txDbm: c.coverageTxDbm,
          rxSensitivityDbm: c.coverageEffectiveSensitivityDbm,
        });
        c.setIsComputingCoverage(false);
        c.setCoverageProgress({ completed: 0, total: 0 });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // User cancel rejects pool tasks with "pool terminated" — expected, not an error
        if (/pool terminated/i.test(msg)) {
          c.setIsComputingCoverage(false);
          c.setIsFetchingCoverageTerrain(false);
          c.setCoverageProgress({ completed: 0, total: 0 });
          return;
        }
        console.warn("[Map] Coverage computation failed:", err);
        c.setCoverageResult(null);
        c.setIsComputingCoverage(false);
        c.setIsFetchingCoverageTerrain(false);
        c.setCoverageProgress({ completed: 0, total: 0 });
        const isTerrain = /terrain|tile|fetch|network|cors|http/i.test(msg);
        c.setCoverageError(
          isTerrain
            ? "Couldn't fetch terrain tiles. Check your connection and try again."
            : "Coverage compute failed. See the developer console and try again.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, coverageRadiusKm, c.coverageAntennaDbi, c.coverageRxAntennaDbi, c.coverageRxHeightM, c.coverageTxDbm, c.coverageAggressionIdx, c.coverageClutterEnabled, c.coverageCanopyEnabled, c.coverageBuildingsEnabled, coverageMergeOrigins, c.coverageSensitivityDbm, c.coverageDetail, c.coverageAntennaHeightM, c.coverageReliability, provider, terrain3D, nodes, c.coverageRetryNonce, c.keepCoveragePaint]);

  // Hide coverage layers when leaving tool; sources/layers stay for fast
  // re-entry. keepCoveragePaint exempts the Scan-from-here overlay.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (activeTool !== "coverage" && !c.keepCoveragePaint) {
      try {
        if (mb.getLayer("coverage-raster")) {
          mb.setLayoutProperty("coverage-raster", "visibility", "none");
        }
        if (mb.getLayer("coverage-contours-line")) {
          mb.setLayoutProperty("coverage-contours-line", "visibility", "none");
        }
        if (mb.getLayer("coverage-rays-line")) {
          mb.setLayoutProperty("coverage-rays-line", "visibility", "none");
        }
      } catch {}
    }
  }, [activeTool, c.keepCoveragePaint, mbMapRef]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!mb.getLayer("coverage-contours-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-contours-line",
        "visibility",
        (activeTool === "coverage" || c.keepCoveragePaint) && c.showCoverageContours ? "visible" : "none",
      );
    } catch {}
  }, [activeTool, c.showCoverageContours, c.coverageResult, c.keepCoveragePaint, mbMapRef]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!mb.getLayer("coverage-rays-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-rays-line",
        "visibility",
        (activeTool === "coverage" || c.keepCoveragePaint) && c.showCoverageRays ? "visible" : "none",
      );
    } catch {}
  }, [activeTool, c.showCoverageRays, c.coverageResult, c.keepCoveragePaint, mbMapRef]);

  // Sync coverage pin to origin (node pick or virtual placement)
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const clear = () => {
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
    };

    if (activeTool !== "coverage" || toolStep !== "result") {
      clear();
      return;
    }

    let origin: [number, number] | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) origin = [n.map_position[0], n.map_position[1]];
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
    }
    if (!origin) {
      clear();
      return;
    }

    if (coverageOriginMarkerRef.current) {
      coverageOriginMarkerRef.current.setLngLat(origin);
    } else {
      const marker = new maplibregl.Marker({ color: "#22d3ee", draggable: true })
        .setLngLat(origin)
        .addTo(mb);

      // Drag preview: 256² compute off cached downsampled DEM, single-flight, newest-wins
      const runDragPreview = async (lngLat: [number, number]) => {
        if (dragPreviewBusyRef.current) {
          dragPreviewPendingRef.current = lngLat;
          return;
        }
        const dem = coverageDragDemRef.current;
        const clutter = coverageDragClutterRef.current;
        const canopy = coverageDragCanopyRef.current;
        const buildings = coverageDragBuildingsRef.current;
        const dragParams = coverageLastRasterParamsRef.current;
        if (!dem || !dragParams) return;
        dragPreviewBusyRef.current = true;
        try {
          // Negative id keeps drag previews out of the authoritative id namespace
          const previewId = -Math.floor(performance.now());
          const demGround = sampleDEMAt(dem, lngLat[0], lngLat[1]);
          const demGroundOk = !Number.isNaN(demGround);
          // Real MSL — see queryTerrainElevationMSL helper for the exaggeration math.
          const mbGround = queryTerrainElevationMSL(mb, lngLat);
          const mbGroundOk = typeof mbGround === "number" && Number.isFinite(mbGround);
          const accurateGround = mbGroundOk ? mbGround : (demGroundOk ? demGround : 0);
          const antennaH = c.coverageAntennaHeightMRef.current;
          const originH = accurateGround + antennaH;
          const txAboveGroundM = demGroundOk
            ? originH - demGround
            : antennaH;
          coverageRequestIdRef.current = previewId;
          await renderCoverageToImageSource({
            dem,
            clutter,
            canopy,
            buildings,
            origins: [{
              position: lngLat,
              heightM: originH,
              antennaHeightAboveGroundM: txAboveGroundM,
            }],
            params: dragParams,
            requestId: previewId,
          });
        } finally {
          dragPreviewBusyRef.current = false;
          const pending = dragPreviewPendingRef.current;
          if (pending) {
            dragPreviewPendingRef.current = null;
            runDragPreview(pending);
          }
        }
      };

      marker.on("dragstart", () => {
        isDraggingMarkerRef.current = true;
      });
      marker.on("drag", () => {
        const ll = marker.getLngLat();
        runDragPreview([ll.lng, ll.lat]);
      });

      // On dragend: switch to a virtual origin (detach any node pick) and kick a full recompute
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        dragPreviewPendingRef.current = null;
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      coverageOriginMarkerRef.current = marker;
    }
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, nodes, mbMapRef, isDraggingMarkerRef, c.coverageAntennaHeightMRef, renderCoverageToImageSource, setToolFromId, setToolVirtualPos]);

  useEffect(() => {
    return () => {
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
    };
  }, []);

  // While picking, the next map click adds a virtual merge origin and exits.
  // Auto-cancels if the user navigates away from the coverage tool.
  useEffect(() => {
    if (pickingMergeOrigin && activeTool !== "coverage") setPickingMergeOrigin(false);
  }, [activeTool, pickingMergeOrigin, setPickingMergeOrigin]);

  useEffect(() => {
    if (!pickingMergeOrigin) return;
    const mb = mbMapRef.current;
    if (!mb) return;
    const canvas = mb.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const lng = e.lngLat.lng;
      const lat = e.lngLat.lat;
      // 6-dp coords give ~0.1 m precision and a stable id key.
      const id = `virtual:${lng.toFixed(6)},${lat.toFixed(6)}`;
      setCoverageMergeOrigins((prev) =>
        prev.some((o) => o.id === id)
          ? prev
          : [...prev, {
              id,
              label: `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
              position: [lng, lat],
              altitudeM: null,
            }],
      );
      setPickingMergeOrigin(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickingMergeOrigin(false);
    };
    mb.on("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      mb.off("click", onClick);
      document.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
    };
  }, [pickingMergeOrigin, mbMapRef, setCoverageMergeOrigins, setPickingMergeOrigin]);

  // Cleared when the coverage tool isn't in result mode so amber pins don't linger.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const markers = coverageMergeMarkersRef.current;
    const inCoverageResult = activeTool === "coverage" && toolStep === "result";
    if (!inCoverageResult) {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      return;
    }
    const wantedIds = new Set(coverageMergeOrigins.map((o) => o.id));
    for (const [id, marker] of markers) {
      if (!wantedIds.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }
    for (const o of coverageMergeOrigins) {
      const existing = markers.get(o.id);
      if (existing) {
        existing.setLngLat(o.position);
      } else {
        const isVirtual = o.id.startsWith("virtual:");
        const marker = new maplibregl.Marker({ color: "#f59e0b", draggable: isVirtual })
          .setLngLat(o.position)
          .setPopup(new maplibregl.Popup({ closeButton: false, offset: 24 }).setText(o.label))
          .addTo(mb);
        if (isVirtual) {
          marker.on("dragend", () => {
            const ll = marker.getLngLat();
            moveCoverageMergeOrigin(o.id, [ll.lng, ll.lat]);
          });
        }
        markers.set(o.id, marker);
      }
    }
  }, [coverageMergeOrigins, activeTool, toolStep, moveCoverageMergeOrigin, mbMapRef]);

  useEffect(() => {
    const markers = coverageMergeMarkersRef.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
    };
  }, []);

  // Cleanup the coverage raster blob URL on unmount.
  useEffect(() => {
    return () => {
      if (coverageRasterUrlRef.current) {
        URL.revokeObjectURL(coverageRasterUrlRef.current);
        coverageRasterUrlRef.current = null;
      }
    };
  }, []);

  return {
    coverageRadiusKm,
    coverageRequestIdRef,
    skipNextCoverageComputeRef,
    coveragePoolRef,
    coverageContoursRef,
    coverageRaysRef,
    coverageMarginRef,
    coverageRasterUrlRef,
    coverageOriginMarkerRef,
    handleCoverageExport,
  };
}
