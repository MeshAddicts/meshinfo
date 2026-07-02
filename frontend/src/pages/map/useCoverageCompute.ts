import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { toast } from "../../components/toastStore";
import { env } from "../../env";
import { effectiveAltitudeMslM } from "../nodes/altitudeAssessment";
import { buildBuildingRaster, type BuildingRaster, downsampleBuildingRaster } from "./buildingTiles";
import { buildCanopyRaster, type CanopyRaster, downsampleCanopyRaster } from "./canopyTiles";
import { AGGRESSION_STOPS, type MergeOrigin, reliabilityPreset, REPRESENTATIVE_CLUTTER_DB } from "./coverageAnalysis";
import { type ContourFeatureCollection, extractCoverageContours } from "./coverageContours";
import { COVERAGE_DETAIL_MAX_TILES, COVERAGE_DETAIL_SIZE } from "./coverageDetail";
import { exportCoverage } from "./coverageExport";
import type { RasterParams } from "./coverageRaster";
import { extractCoverageRays, type VisibilityRayFeatureCollection } from "./coverageRays";
import type { SliceOrigin } from "./coverageSliceWorker";
import { CoverageWorkerPool } from "./coverageWorkerPool";
import { queryTerrainElevationMSL } from "./helpers";
import { CABLE_LOSS_DB, clampRxHeightM, DEFAULT_ITM_ENV, FADE_MARGIN_DB, FREQ_MHZ } from "./itmEnv";
import { buildClutterRaster, type ClutterRaster, downsampleClutterRaster } from "./landcoverTiles";
import { type DEM, type DEMBounds, downsampleDEM, sampleDEMAt, unionDemBoundsAround } from "./terrainDEM";
import { buildDem, type DemSource, fetchElevationAt } from "./terrainRgb";
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

/** Debounce for parameter-only recomputes; origin moves and explicit
 *  recalculates run immediately. */
const PARAM_RECOMPUTE_DEBOUNCE_MS = 350;

/** Fetched rasters + telemetry, reused while bounds/detail/layer toggles are
 *  unchanged. */
type FetchedRasters = {
  key: string;
  dem: DEM;
  clutter: ClutterRaster | null;
  canopy: CanopyRaster | null;
  buildings: BuildingRaster | null;
  demSource: DemSource;
  clutterStatus: { tilesPresent: number; tilesTotal: number } | null;
  canopyStatus: { tilesPresent: number; tilesTotal: number } | null;
  buildingsStatus: { tilesPresent: number; tilesTotal: number } | null;
};

/** Pool raster registration handle; pool identity matters because Cancel
 *  terminates + recreates the pool, which resets its generation counter. */
type RasterGenHandle = { pool: CoverageWorkerPool; gen: number; key: string };

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

export function useCoverageCompute(params: CoverageComputeParams) {
  const {
    coverage: c,
    activeTool, toolStep, toolFromId, toolVirtualPos,
    setToolFromId, setToolVirtualPos,
    terrain3D, nodes,
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
    const CABLE = CABLE_LOSS_DB;
    const FADE = FADE_MARGIN_DB;
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
    const plConstant = 32.45 + 20 * Math.log10(FREQ_MHZ);
    const maxKm = Math.pow(10, (budget - plConstant) / 20);
    return Math.max(5, Math.min(200, Math.round(maxKm)));
  }, [c.coverageAntennaDbi, c.coverageRxAntennaDbi, c.coverageTxDbm, c.coverageEffectiveSensitivityDbm, c.coverageAggressionIdx, c.coverageClutterEnabled]);

  // Resolved origin coords so the compute effect depends on the position, not the
  // whole nodes-map identity (which is a new object every 5s poll → wasteful recompute).
  const coverageOrigin = useMemo<{ lng: number; lat: number; alt: number | null } | null>(() => {
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (!n?.map_position) return null;
      // HAE-aware MSL altitude, matching merge-origin resolution
      return { lng: n.map_position[0], lat: n.map_position[1], alt: effectiveAltitudeMslM(n.position) };
    }
    if (toolVirtualPos) return { lng: toolVirtualPos[0], lat: toolVirtualPos[1], alt: null };
    return null;
  }, [toolFromId, toolVirtualPos, nodes]);
  const originLng = coverageOrigin?.lng ?? null;
  const originLat = coverageOrigin?.lat ?? null;
  const originAlt = coverageOrigin?.alt ?? null;

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
      // Invalidate first so terminate's rejections read as superseded
      coverageRequestIdRef.current += 1;
      coveragePoolRef.current?.terminate();
      coveragePoolRef.current = null;
    };
  }, []);

  /** Fetched rasters keyed by bounds/detail/layer toggles; parameter-only
   *  recomputes reuse them (no refetch, no 2048² main-thread resample). */
  const coverageFetchCacheRef = useRef<FetchedRasters | null>(null);
  /** Pool registration of the authoritative rasters (worker-side cache). */
  const coverageRasterGenRef = useRef<RasterGenHandle | null>(null);
  /** Pool registration of the downsampled drag-preview rasters. */
  const coverageDragGenRef = useRef<RasterGenHandle | null>(null);
  /** 256² downsample of the authoritative DEM; drag preview runs LR at ~8-12 fps. */
  const coverageDragDemRef = useRef<DEM | null>(null);
  const coverageDragClutterRef = useRef<ClutterRaster | null>(null);
  const coverageDragCanopyRef = useRef<CanopyRaster | null>(null);
  const coverageDragBuildingsRef = useRef<BuildingRaster | null>(null);
  /** Latest raster params snapshot (drag preview reuses untouched). */
  const coverageLastRasterParamsRef = useRef<RasterParams | null>(null);
  /** Single-flight drag preview; latest pending position fires when current completes. */
  const dragPreviewBusyRef = useRef(false);
  const dragPreviewPendingRef = useRef<[number, number] | null>(null);

  /** Origin ground per rounded lng/lat, so recomputes at the same pin reuse
   *  the exact same height. Viewport-sourced fallbacks are retried against
   *  the deterministic z15 fetch on later computes. */
  const originGroundCacheRef = useRef<Map<string, { value: number; source: "fetch" | "viewport" }>>(new globalThis.Map());

  /** Change-detection for the compute effect: skip refires that don't alter
   *  the render (poll identity churn, overlay flips, zero-move drags). */
  const lastComputedKeyRef = useRef<string | null>(null);
  const lastOriginKeyRef = useRef<string | null>(null);
  const lastNoncesRef = useRef<{ retry: number; recalc: number }>({ retry: 0, recalc: 0 });
  /** Retry-nonce value at the last fetch; a bump busts the raster fetch cache. */
  const lastRetryNonceRef = useRef(0);
  /** Live full computes; the no-op early-return only tidies UI state when 0. */
  const activeComputeCountRef = useRef(0);
  /** computeKey whose run was cancelled — the paint doesn't reflect it, so
   *  matching settings must offer Recalculate. */
  const cancelledComputeKeyRef = useRef<string | null>(null);
  /** Origin metadata of the last painted compute, for lazy ray extraction. */
  const lastRenderMetaRef = useRef<{
    origin: [number, number];
    originHeightM: number;
    rxHeightM: number;
  } | null>(null);

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

  /** Export coverage as GeoJSON or KML (iso-margin 0/10/20 dB contours + metadata).
   *  Contours are built lazily from the cached margin grid. */
  const handleCoverageExport = useCallback((format: "geojson" | "kml") => {
    if (!coverageContoursRef.current && coverageMarginRef.current) {
      const m = coverageMarginRef.current;
      coverageContoursRef.current = extractCoverageContours({
        margin: m.data,
        width: m.width,
        height: m.height,
        bounds: m.bounds,
        thresholdsDb: [0, 10, 20],
      });
    }
    if (!coverageResultRef.current || !coverageContoursRef.current) {
      toast("Nothing to export yet — run a coverage prediction first.");
      return;
    }
    exportCoverage(format, coverageContoursRef.current, coverageResultRef.current);
    toast(`Coverage exported as ${format.toUpperCase()}.`, { kind: "success" });
  }, []);

  /** Run pool over the registered raster generation, stitch slices, paint RGBA
   *  to `coverage-raster`. Shared by main compute + drag preview. The raster
   *  buffers live in the pool (see setRasters); slices carry only params.
   *  Null = superseded or WASM missing. */
  const renderCoverageToImageSource = useCallback(async (opts: {
    /** Authoritative DEM for bounds/dims; buffers already registered on the pool. */
    dem: DEM;
    /** Pool raster generation to compute against. */
    rasterGen: number;
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
    const { dem, rasterGen, origins, params: rp, requestId, onSliceProgress } = opts;
    const outputWidth = opts.outputWidth ?? dem.width;
    const outputHeight = opts.outputHeight ?? dem.height;
    const mb = mbMapRef.current;
    if (!mb) return null;
    const pool = ensureCoveragePool();
    // Queued tasks belong to superseded requests; drop them
    pool.dropQueued();
    // 2 slices per worker: finer progress + less straggler tail than 1:1
    const totalSlices = Math.min(pool.size * 2, outputHeight);
    const rowsPerTask = Math.ceil(outputHeight / totalSlices);

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
    let completedSlices = 0;
    onSliceProgress?.(0, totalSlices);

    for (let rowStart = 0; rowStart < outputHeight; rowStart += rowsPerTask) {
      const rowEnd = Math.min(rowStart + rowsPerTask, outputHeight);
      tasks.push(
        pool.dispatch({
          requestId,
          rasterGen,
          origins,
          params: rp,
          outputWidth,
          outputHeight,
          rowStart,
          rowEnd,
        }).then((resp) => {
          sliceResponses.push(resp);
          completedSlices += 1;
          if (requestId === coverageRequestIdRef.current) {
            onSliceProgress?.(completedSlices, totalSlices);
          }
        }),
      );
      // Yield between dispatches; per-worker buffer clones on gen change are heavy
      if (rowStart + rowsPerTask < outputHeight) await yieldToMain();
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
    // A newer request may have painted while toBlob ran
    if (requestId !== coverageRequestIdRef.current) {
      URL.revokeObjectURL(url);
      return null;
    }

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
      c.setCoverageParamsDirty(false);
      c.setCoverageProgress({ completed: 0, total: 0 });
      lastRecenteredOriginRef.current = null;
      lastComputedKeyRef.current = null;
      lastOriginKeyRef.current = null;
      // Invalidate in-flight computes — no ghost paint after close
      coverageRequestIdRef.current += 1;
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
      lastComputedKeyRef.current = null;
      coverageRequestIdRef.current += 1;
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
        altitude = effectiveAltitudeMslM(n.position);
      }
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
      altitude = null; // virtual = no known altitude, will fall back to terrain + antenna
    }
    if (!origin) {
      c.setCoverageResult(null);
      lastComputedKeyRef.current = null;
      coverageRequestIdRef.current += 1;
      return;
    }

    // Tokenless OK — all sources are Tilezen/self-hosted; the token only
    // enables the Mapbox terrain-rgb fallback.
    const mapboxToken = env.MAPBOX_TOKEN ?? "";

    const radKm = coverageRadiusKm;
    // Union bbox over primary + merge origins (all share radiusKm since TX
    // params are global); seam-aware so straddling origins don't span the globe.
    // Positions quantized to the change-detection precision (4/5 dp) so GPS
    // jitter can't change fetchKey.
    const demBounds = unionDemBoundsAround(
      [
        [Number(origin[0].toFixed(4)), Number(origin[1].toFixed(4))] as [number, number],
        ...coverageMergeOrigins.map(
          (m) => [Number(m.position[0].toFixed(5)), Number(m.position[1].toFixed(5))] as [number, number],
        ),
      ],
      radKm,
      1.05,
    );

    // Pool-based compute: fetch DEM once, slice to workers, stitch RGBA.
    // DEM is fixed 2048²; "Detail" only changes OUTPUT_SIZE (paint pixelation, not RF accuracy).
    const DEM_SIZE = 2048;
    const OUTPUT_SIZE = COVERAGE_DETAIL_SIZE[c.coverageDetail];
    const rel = reliabilityPreset(c.coverageReliability);
    const rasterParams: RasterParams = {
      freqMhz: FREQ_MHZ,
      txDbm: c.coverageTxDbm,
      txAntennaDbi: c.coverageAntennaDbi,
      rxAntennaDbi: c.coverageRxAntennaDbi,
      rxAntennaHeightAboveGroundM: c.coverageRxHeightM,
      rxSensitivityDbm: c.coverageEffectiveSensitivityDbm,
      fadeMarginDb: FADE_MARGIN_DB,
      cableLossDb: CABLE_LOSS_DB,
      clutterAggression: c.coverageClutterEnabled
        ? (AGGRESSION_STOPS[c.coverageAggressionIdx]?.value ?? 1.0)
        : 0,
      ...DEFAULT_ITM_ENV,
      timePct: rel.time,
      locationPct: rel.location,
      situationPct: rel.situation,
    };

    // ---- Change detection & scheduling -------------------------------------
    // Rounding gives GPS-jitter hysteresis: ~11 m position, 10 m altitude
    const mergeKey = coverageMergeOrigins
      .map((m) => `${m.id}@${m.position[0].toFixed(5)},${m.position[1].toFixed(5)},${m.altitudeM == null ? "x" : Math.round(m.altitudeM / 10)}`)
      .join(";");
    const originKey = `${origin[0].toFixed(4)},${origin[1].toFixed(4)}|${mergeKey}`;
    const altKey = altitude == null || !Number.isFinite(altitude) ? "x" : String(Math.round(altitude / 10) * 10);
    const computeKey = JSON.stringify({
      o: originKey,
      alt: altKey,
      r: radKm,
      p: rasterParams,
      d: c.coverageDetail,
      ah: c.coverageAntennaHeightM,
      layers: [c.coverageClutterEnabled, c.coverageCanopyEnabled, c.coverageBuildingsEnabled],
      nr: c.coverageRetryNonce,
      nc: c.coverageRecalcNonce,
    });
    if (computeKey === cancelledComputeKeyRef.current) {
      // Cancelled settings: the paint doesn't reflect them despite
      // lastComputedKeyRef — keep the dirty chip up
      c.setCoverageParamsDirty(true);
      return;
    }
    if (computeKey === lastComputedKeyRef.current) {
      // Settings match the painted result (e.g. changed and changed back,
      // poll-identity refire, zero-move drag) — nothing to recompute.
      c.setCoverageParamsDirty(false);
      if (activeComputeCountRef.current === 0) {
        // Tidy leftover busy state (e.g. after a drag-preview stomp) — never
        // while a live compute owns the indicators
        c.setIsComputingCoverage(false);
        c.setIsFetchingCoverageTerrain(false);
        c.setCoverageProgress({ completed: 0, total: 0 });
      }
      return;
    }
    const noncesChanged =
      lastNoncesRef.current.retry !== c.coverageRetryNonce ||
      lastNoncesRef.current.recalc !== c.coverageRecalcNonce;
    const originChanged = lastOriginKeyRef.current !== originKey;
    const isFirst = lastComputedKeyRef.current === null;

    if (!c.coverageAutoRecalc && !originChanged && !noncesChanged && !isFirst) {
      // Manual mode: parameter tweaks wait for the Recalculate button
      c.setCoverageParamsDirty(true);
      return;
    }
    const delayMs = originChanged || noncesChanged || isFirst ? 0 : PARAM_RECOMPUTE_DEBOUNCE_MS;

    let cancelled = false;
    const commitAndLaunch = () => {
      lastComputedKeyRef.current = computeKey;
      lastOriginKeyRef.current = originKey;
      cancelledComputeKeyRef.current = null;
      const retryNonceChanged = lastRetryNonceRef.current !== c.coverageRetryNonce;
      lastRetryNonceRef.current = c.coverageRetryNonce;
      // Retry implies the cached ground may be bad too
      if (retryNonceChanged) originGroundCacheRef.current.clear();
      lastNoncesRef.current = { retry: c.coverageRetryNonce, recalc: c.coverageRecalcNonce };
      c.setCoverageParamsDirty(false);

      // Mark as computing but keep the previous result visible so controls stay up
      c.setIsComputingCoverage(true);
      c.setCoverageError(null);
      c.setCoverageProgress({ completed: 0, total: 0 });

      // Recenter only when the origin actually moved; pure parameter recomputes
      // (TX power, antenna, clutter on/off, etc.) shouldn't yank the user's view.
      const prev = lastRecenteredOriginRef.current;
      const movedSignificantly =
        !prev ||
        Math.abs(prev[0] - origin![0]) > 1e-6 ||
        Math.abs(prev[1] - origin![1]) > 1e-6;
      if (movedSignificantly) {
        mb.easeTo({ center: origin!, duration: 300 });
        lastRecenteredOriginRef.current = [origin![0], origin![1]];
      }

      const requestId = ++coverageRequestIdRef.current;

      activeComputeCountRef.current += 1;
      (async () => {
        const t0 = performance.now();
        const timings: Record<string, number> = {};
        const mark = (name: string, fromMs: number) => {
          timings[name] = performance.now() - fromMs;
        };
        try {
          // 1. Rasters: reuse the fetched set when bounds/detail/layer toggles
          //    are unchanged; otherwise fetch terrain + enabled clutter tiers in
          //    parallel, all at DEM_SIZE for uniform lng/lat indexing.
          const fetchKey = [
            demBounds.west.toFixed(6), demBounds.south.toFixed(6),
            demBounds.east.toFixed(6), demBounds.north.toFixed(6),
            c.coverageDetail,
            c.coverageClutterEnabled, c.coverageCanopyEnabled, c.coverageBuildingsEnabled,
          ].join("|");
          let fetched = coverageFetchCacheRef.current;
          const cacheHit = fetched != null && fetched.key === fetchKey && !retryNonceChanged;
          if (!cacheHit) {
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
            mark("demFetchMs", tFetch);
            if (requestId !== coverageRequestIdRef.current) {
              c.setIsFetchingCoverageTerrain(false);
              return;
            }
            c.setIsFetchingCoverageTerrain(false);
            fetched = {
              key: fetchKey,
              dem, clutter, canopy, buildings,
              demSource: demSourceUsed,
              clutterStatus: clutter ? { tilesPresent: clutter.tilesPresent, tilesTotal: clutter.tilesTotal } : null,
              canopyStatus: canopy ? { tilesPresent: canopy.tilesPresent, tilesTotal: canopy.tilesTotal } : null,
              buildingsStatus: buildings ? { tilesPresent: buildings.tilesPresent, tilesTotal: buildings.tilesTotal } : null,
            };
            coverageFetchCacheRef.current = fetched;
          }
          const { dem, clutter, canopy, buildings } = fetched!;
          // After the supersession check, so stale computes can't clobber chips
          c.setCoverageDemSource(fetched!.demSource);
          c.setCoverageClutterStatus(fetched!.clutterStatus);
          c.setCoverageCanopyStatus(fetched!.canopyStatus);
          c.setCoverageBuildingsStatus(fetched!.buildingsStatus);

          // 2. Origin ground: the z=15 fetch (viewport-independent, LRU-cached;
          //    Tilezen 3DEP/SRTM, Mapbox fallback) is authoritative. The map
          //    query depends on loaded viewport tiles — fallback only, never
          //    max()ed in — and results are pinned per position for the session
          //    so identical settings paint identically.
          const groundKey = `${origin![0].toFixed(5)},${origin![1].toFixed(5)}`;
          const groundCached = originGroundCacheRef.current.get(groundKey) ?? null;
          let originGroundHighZoom: number | null = groundCached?.value ?? null;
          if (groundCached == null || groundCached.source === "viewport") {
            const fetchElev = await fetchElevationAt(origin![0], origin![1], mapboxToken);
            if (fetchElev != null && Number.isFinite(fetchElev)) {
              originGroundHighZoom = fetchElev;
              if (originGroundCacheRef.current.size > 64) originGroundCacheRef.current.clear();
              originGroundCacheRef.current.set(groundKey, { value: fetchElev, source: "fetch" });
            } else if (groundCached == null) {
              const mbElev = queryTerrainElevationMSL(mb, origin!);
              if (typeof mbElev === "number" && Number.isFinite(mbElev)) {
                originGroundHighZoom = mbElev;
                if (originGroundCacheRef.current.size > 64) originGroundCacheRef.current.clear();
                originGroundCacheRef.current.set(groundKey, { value: mbElev, source: "viewport" });
              }
            }
          }
          if (requestId !== coverageRequestIdRef.current) return;
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

          // 3. Register rasters on the pool (buffers ship per worker per
          //    generation). Reuse only on a true cache hit AND while the handle
          //    is the pool's live gen — a refetch means new buffers, and drag
          //    previews advance the gen.
          const pool = ensureCoveragePool();
          const genHandle = coverageRasterGenRef.current;
          let rasterGen: number;
          if (
            cacheHit &&
            genHandle &&
            genHandle.pool === pool &&
            genHandle.key === fetchKey &&
            genHandle.gen === pool.currentGen
          ) {
            rasterGen = genHandle.gen;
          } else {
            rasterGen = pool.setRasters({ dem, clutter, canopy, buildings });
            coverageRasterGenRef.current = { pool, gen: rasterGen, key: fetchKey };
            // A new authoritative generation obsoletes any drag registration
            coverageDragGenRef.current = null;
          }
          const tDispatch = performance.now();
          const rendered = await renderCoverageToImageSource({
            dem,
            rasterGen,
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
          if (requestId !== coverageRequestIdRef.current) return;
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

          // Don't cache a hollow DEM (transient tile failure) — Retry must refetch
          if (rendered.demCoveredPixels / rendered.totalPx < 0.05 && coverageFetchCacheRef.current?.key === fetchKey) {
            coverageFetchCacheRef.current = null;
          }

          // 4. Publish margin + metadata; contours/rays are built lazily by
          //    the overlay effects (saves ~50-150 ms when toggled off)
          coverageMarginRef.current = {
            data: rendered.marginDb,
            width: rendered.outputWidth,
            height: rendered.outputHeight,
            bounds: dem.bounds,
          };
          lastRenderMetaRef.current = {
            origin: origin!,
            originHeightM,
            rxHeightM: clampRxHeightM(c.coverageRxHeightM),
          };
          coverageContoursRef.current = null;
          coverageRaysRef.current = null;

          const computeMs = performance.now() - t0;
          if (import.meta.env.DEV) {
            console.info(
              `[Map] Coverage compute: ${computeMs.toFixed(0)} ms ` +
                `for ${OUTPUT_SIZE}² output / ${DEM_SIZE}² dem across ${ensureCoveragePool().size} workers ` +
                `(${Math.round((rendered.demCoveredPixels / rendered.totalPx) * 100)}% terrain-covered, ` +
                `rasters ${cacheHit ? "cached" : "fetched"})`,
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

          // 5. Refresh drag-preview downsamples off the critical path
          setTimeout(() => {
            if (requestId !== coverageRequestIdRef.current) return;
            coverageDragDemRef.current = downsampleDEM(dem, 256, 256);
            coverageDragClutterRef.current = clutter ? downsampleClutterRaster(clutter, 256, 256) : null;
            coverageDragCanopyRef.current = canopy ? downsampleCanopyRaster(canopy, 256, 256) : null;
            coverageDragBuildingsRef.current = buildings ? downsampleBuildingRaster(buildings, 256, 256) : null;
            coverageDragGenRef.current = null; // re-register on next drag
            coverageLastRasterParamsRef.current = rasterParams;
          }, 0);
        } catch (err) {
          // Superseded computes must not touch the successor's state. Effect
          // `cancelled` is deliberately not consulted — a re-run may not
          // relaunch; only supersession means someone else owns the indicators.
          if (requestId !== coverageRequestIdRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          // User cancel / supersession rejects pool tasks — expected, not an error
          if (/pool (terminated|superseded)/i.test(msg)) {
            c.setIsComputingCoverage(false);
            c.setIsFetchingCoverageTerrain(false);
            c.setCoverageProgress({ completed: 0, total: 0 });
            // Still current here = the pool moved on underneath us; drop the
            // registration so the next compute self-heals
            coverageRasterGenRef.current = null;
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
      })().finally(() => {
        activeComputeCountRef.current = Math.max(0, activeComputeCountRef.current - 1);
      });
    };

    // Immediate for origin/nonce/first (a deferred launch would flash the
    // paused state); debounced for parameter tweaks. `cancelled` guards only
    // the deferred launch — in-flight computes are cancelled solely via
    // requestId supersession (an effect re-run may not relaunch).
    let timer: number | null = null;
    if (delayMs === 0) {
      commitAndLaunch();
    } else {
      timer = window.setTimeout(() => {
        if (!cancelled) commitAndLaunch();
      }, delayMs);
    }

    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, coverageRadiusKm, c.coverageAntennaDbi, c.coverageRxAntennaDbi, c.coverageRxHeightM, c.coverageTxDbm, c.coverageAggressionIdx, c.coverageClutterEnabled, c.coverageCanopyEnabled, c.coverageBuildingsEnabled, coverageMergeOrigins, c.coverageEffectiveSensitivityDbm, c.coverageDetail, c.coverageAntennaHeightM, c.coverageReliability, terrain3D, originLng, originLat, originAlt, c.coverageRetryNonce, c.coverageRecalcNonce, c.coverageAutoRecalc, c.keepCoveragePaint]);

  // Hide coverage layers when leaving tool; sources/layers stay for fast
  // re-entry. keepCoveragePaint exempts the Scan-from-here overlay. Cached
  // rasters (~100 MB/worker at full tiers) are released; re-entry refetches.
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
      coveragePoolRef.current?.releaseRasters();
      coverageFetchCacheRef.current = null;
      coverageRasterGenRef.current = null;
      coverageDragGenRef.current = null;
      coverageDragDemRef.current = null;
      coverageDragClutterRef.current = null;
      coverageDragCanopyRef.current = null;
      coverageDragBuildingsRef.current = null;
      coverageLastRasterParamsRef.current = null;
    }
  }, [activeTool, c.keepCoveragePaint, mbMapRef]);

  // Contours are extracted lazily on first show after each compute
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const show = (activeTool === "coverage" || c.keepCoveragePaint) && c.showCoverageContours;
    if (show && !coverageContoursRef.current && coverageMarginRef.current) {
      const m = coverageMarginRef.current;
      coverageContoursRef.current = extractCoverageContours({
        margin: m.data,
        width: m.width,
        height: m.height,
        bounds: m.bounds,
        thresholdsDb: [0, 10, 20],
      });
      try {
        const src = mb.getSource("coverage-contours") as MlGeoJSONSource | undefined;
        src?.setData(coverageContoursRef.current);
      } catch (err) { if (import.meta.env.DEV) console.warn("[Map] coverage-contours setData:", err); }
    }
    if (!mb.getLayer("coverage-contours-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-contours-line",
        "visibility",
        show ? "visible" : "none",
      );
    } catch {}
  }, [activeTool, c.showCoverageContours, c.coverageResult, c.keepCoveragePaint, mbMapRef]);

  // Rays likewise; needs the full-res DEM from the fetch cache
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const show = (activeTool === "coverage" || c.keepCoveragePaint) && c.showCoverageRays;
    const meta = lastRenderMetaRef.current;
    const dem = coverageFetchCacheRef.current?.dem;
    if (show && !coverageRaysRef.current && coverageMarginRef.current && meta && dem) {
      const m = coverageMarginRef.current;
      coverageRaysRef.current = extractCoverageRays({
        dem,
        margin: m.data,
        width: m.width,
        height: m.height,
        bounds: m.bounds,
        origin: meta.origin,
        originHeightM: meta.originHeightM,
        rxHeightM: meta.rxHeightM,
        azimuthStepDeg: 1,
      });
      try {
        const src = mb.getSource("coverage-rays") as MlGeoJSONSource | undefined;
        src?.setData(coverageRaysRef.current);
      } catch (err) { if (import.meta.env.DEV) console.warn("[Map] coverage-rays setData:", err); }
    }
    if (!mb.getLayer("coverage-rays-line")) return;
    try {
      mb.setLayoutProperty(
        "coverage-rays-line",
        "visibility",
        show ? "visible" : "none",
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

      /** Meters between two lng/lat points (equirectangular, fine at pin scale). */
      const metersBetween = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) => {
        const dLat = (b.lat - a.lat) * 111_320;
        const dLng = (b.lng - a.lng) * 111_320 * Math.cos((b.lat * Math.PI) / 180);
        return Math.hypot(dLat, dLng);
      };
      /** Wiggle threshold: below this, no preview and snap back on release
       *  (keeps node anchor + GPS altitude). */
      const MICRO_DRAG_M = 8;
      let dragStartPos: maplibregl.LngLat | null = null;
      let previewRanThisDrag = false;

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
          // Preview-only; dragend runs the full deterministic resolution
          const accurateGround = mbGroundOk && demGroundOk
            ? Math.max(mbGround, demGround)
            : mbGroundOk ? mbGround : demGroundOk ? demGround : 0;
          const antennaH = c.coverageAntennaHeightMRef.current;
          const originH = accurateGround + antennaH;
          const txAboveGroundM = demGroundOk
            ? originH - demGround
            : antennaH;
          // Register the downsampled rasters once per drag session (a full
          // compute may have advanced the pool generation since)
          const pool = ensureCoveragePool();
          let dragGen = coverageDragGenRef.current;
          if (!dragGen || dragGen.pool !== pool || dragGen.gen !== pool.currentGen) {
            dragGen = { pool, gen: pool.setRasters({ dem, clutter, canopy, buildings }), key: "drag" };
            coverageDragGenRef.current = dragGen;
            // Drag rasters own the pool gen now; full computes must re-register
            coverageRasterGenRef.current = null;
          }
          previewRanThisDrag = true;
          coverageRequestIdRef.current = previewId;
          // Stomping the id discards any in-flight compute; clear its indicators
          c.setIsComputingCoverage(false);
          c.setIsFetchingCoverageTerrain(false);
          c.setCoverageProgress({ completed: 0, total: 0 });
          await renderCoverageToImageSource({
            dem,
            rasterGen: dragGen.gen,
            origins: [{
              position: lngLat,
              heightM: originH,
              antennaHeightAboveGroundM: txAboveGroundM,
            }],
            params: dragParams,
            requestId: previewId,
          });
        } catch (err) {
          // Supersession rejections are expected mid-drag
          const msg = err instanceof Error ? err.message : String(err);
          if (!/pool (terminated|superseded)/i.test(msg)) {
            console.warn("[Map] Coverage drag preview failed:", err);
          }
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
        dragStartPos = marker.getLngLat();
        previewRanThisDrag = false;
      });
      marker.on("drag", () => {
        const ll = marker.getLngLat();
        // No preview inside the micro-drag radius — nothing to restore on snapback
        if (dragStartPos && metersBetween(dragStartPos, ll) < MICRO_DRAG_M) return;
        runDragPreview([ll.lng, ll.lat]);
      });

      // On dragend: switch to a virtual origin (detach any node pick) and kick a full recompute
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        dragPreviewPendingRef.current = null;
        if (dragStartPos && metersBetween(dragStartPos, ll) < MICRO_DRAG_M) {
          // Wiggle: snap back instead of detaching a node-anchored origin
          marker.setLngLat(dragStartPos);
          if (previewRanThisDrag) {
            // Wander-and-return painted low-res previews; force a full repaint
            c.setCoverageRecalcNonce((n) => n + 1);
          }
          return;
        }
        // An 8-14 m move can round into the same originKey cell; bump the
        // nonce so the low-res preview is always replaced
        if (previewRanThisDrag) c.setCoverageRecalcNonce((n) => n + 1);
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      coverageOriginMarkerRef.current = marker;
    }
    // c.* used in drag closures are stable setters/refs; depending on the whole
    // `c` object (new identity per render) would re-run this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, nodes, mbMapRef, isDraggingMarkerRef, c.coverageAntennaHeightMRef, ensureCoveragePool, renderCoverageToImageSource, setToolFromId, setToolVirtualPos]);

  useEffect(() => {
    return () => {
      if (coverageOriginMarkerRef.current) {
        coverageOriginMarkerRef.current.remove();
        coverageOriginMarkerRef.current = null;
      }
    };
  }, []);

  // Pre-warm workers + ITM WASM while the user is still picking an origin
  useEffect(() => {
    if (activeTool === "coverage") ensureCoveragePool().warmup();
  }, [activeTool, ensureCoveragePool]);

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

  /** Panel Cancel: the committed computeKey was never painted, so matching
   *  settings must offer Recalculate. */
  const setCoverageParamsDirtyStable = c.setCoverageParamsDirty;
  const markComputeCancelled = useCallback(() => {
    cancelledComputeKeyRef.current = lastComputedKeyRef.current;
    setCoverageParamsDirtyStable(true);
  }, [setCoverageParamsDirtyStable]);

  return {
    coverageRadiusKm,
    coverageRequestIdRef,
    skipNextCoverageComputeRef,
    markComputeCancelled,
    coveragePoolRef,
    coverageContoursRef,
    coverageRaysRef,
    coverageMarginRef,
    coverageRasterUrlRef,
    coverageOriginMarkerRef,
    handleCoverageExport,
  };
}
