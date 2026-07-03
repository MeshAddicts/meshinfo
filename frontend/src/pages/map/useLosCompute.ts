import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { env } from "../../env";
import { effectiveAltitudeMslM } from "../nodes/altitudeAssessment";
import { type BuildingRaster, sampleBuildingAt } from "./buildingTiles";
import { type CanopyRaster, sampleCanopyAt } from "./canopyTiles";
import { normalizeLng, shortestLngDelta } from "./geo";
import { computeP2PLoss, isItmAvailable } from "./itm";
import { DEFAULT_ITM_ENV } from "./itmEnv";
import { analyzeLineOfSight, haversineKm, type LoSResult } from "./losAnalysis";
import { losPointsToTubeData, LosTubeLayer, obstructionsToGeoJSON, pickObstructions } from "./losTubeLayer";
import { buildCoverageRasters } from "./rasterBuildClient";
import { type DEM, demBoundsAround, demBoundsContain, sampleDEMAt } from "./terrainDEM";
import type { DemSource } from "./terrainRgb";
import type { IMapNode } from "./types";

type LosComputeParams = {
  activeTool: "los" | "traceroute" | "coverage" | "scan" | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolToId: string | null;
  losVirtualFrom: [number, number] | null;
  losVirtualTo: [number, number] | null;
  losFromHeightM: number;
  losToHeightM: number;
  /** Link frequency (MHz) — drives Fresnel geometry and ITM. */
  losFreqMhz: number;
  terrain3D: boolean;
  /** Bumped on style.load — re-pushes tube/obstructions after setStyle wipes them. */
  styleEpoch: number;
  /** Nodes query errored — an empty `nodes` map is final, not still-loading. */
  nodesLoadFailed: boolean;
  nodes: Record<string, IMapNode>;
  losResult: LoSResult | null;
  mbMapRef: React.RefObject<MlMap | null>;
  losTubeLayerRef: React.RefObject<LosTubeLayer | null>;
  /** Suppresses map click handlers while an endpoint marker is dragged. */
  isDraggingMarkerRef: React.RefObject<boolean>;
  /** Dragging an endpoint marker commits it as a virtual pin (detaches node anchors). */
  onEndpointDragged: (which: "from" | "to", pos: [number, number]) => void;
  setLosResult: (r: LoSResult | null) => void;
  setLosDemSource: (s: DemSource | null) => void;
  setLosError: (e: string | null) => void;
  setIsComputingLos: (v: boolean) => void;
  setLosTerrainWarning: (w: string | null) => void;
};

export function useLosCompute(params: LosComputeParams) {
  const {
    activeTool, toolStep, toolFromId, toolToId,
    losVirtualFrom, losVirtualTo, losFromHeightM, losToHeightM,
    losFreqMhz, terrain3D, styleEpoch, nodes, nodesLoadFailed, losResult,
    mbMapRef, losTubeLayerRef,
    isDraggingMarkerRef, onEndpointDragged,
    setLosResult, setLosDemSource, setLosError, setIsComputingLos,
    setLosTerrainWarning,
  } = params;

  // Distinguishes "nodes not loaded yet" (URL-restored link) from "endpoint gone"
  const nodesEmpty = Object.keys(nodes).length === 0;

  // Endpoint scalars (not the whole `nodes` object) drive the effects below, so
  // live SSE node churn can't retrigger a compute unless an endpoint actually moved.
  const resolveEndpoint = (
    id: string | null,
    virtual: [number, number] | null,
  ): { lng: number | null; lat: number | null; alt: number | null } => {
    if (id) {
      const n = nodes[id] ?? nodes[`!${id}`];
      if (!n?.map_position) return { lng: null, lat: null, alt: null };
      return { lng: n.map_position[0], lat: n.map_position[1], alt: effectiveAltitudeMslM(n.position) };
    }
    if (virtual) return { lng: virtual[0], lat: virtual[1], alt: null };
    return { lng: null, lat: null, alt: null };
  };
  const { lng: fromLng, lat: fromLat, alt: fromAlt } = resolveEndpoint(toolFromId, losVirtualFrom);
  const { lng: toLng, lat: toLat, alt: toAlt } = resolveEndpoint(toolToId, losVirtualTo);

  // LOS endpoints from the compute effect; refs so the hover-marker callback reads them without deps churn
  const losFromPosRef = useRef<[number, number] | null>(null);
  const losToPosRef = useRef<[number, number] | null>(null);
  // Marker for the LOS elevation-chart hover
  const losHoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Skips fitBounds re-zoom when the user changes config without moving endpoints
  const losFitKeyRef = useRef<string | null>(null);
  // Cached rasters for the last computed link; reused via containment + resolution
  // checks so height tweaks and endpoint drags skip the re-fetch entirely.
  const losDemCacheRef = useRef<{
    dem: DEM;
    source: DemSource;
    /** Meters/pixel the cache was built at. */
    mpp: number;
    canopy: CanopyRaster | null;
    buildings: BuildingRaster | null;
  } | null>(null);
  // Draggable endpoint markers (result step only)
  const losFromMarkerRef = useRef<maplibregl.Marker | null>(null);
  const losToMarkerRef = useRef<maplibregl.Marker | null>(null);

  // Remove markers on unmount (resetTool covers tool changes, not navigation away).
  useEffect(() => () => {
    losHoverMarkerRef.current?.remove();
    losHoverMarkerRef.current = null;
    if (losFromMarkerRef.current || losToMarkerRef.current) {
      losFromMarkerRef.current?.remove();
      losFromMarkerRef.current = null;
      losToMarkerRef.current?.remove();
      losToMarkerRef.current = null;
      // A removal mid-drag skips dragend; don't leave the shared flag stuck
      isDraggingMarkerRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warm the ITM WASM while the user is still picking endpoints so the first
  // result doesn't pay tile fetch + module load sequentially.
  useEffect(() => {
    if (activeTool === "los") void isItmAvailable();
  }, [activeTool]);

  const handleLosProfileHover = useCallback((fraction: number | null) => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (fraction == null) {
      losHoverMarkerRef.current?.remove();
      losHoverMarkerRef.current = null;
      return;
    }
    const from = losFromPosRef.current;
    const to = losToPosRef.current;
    if (!from || !to) return;
    const lng = normalizeLng(from[0] + shortestLngDelta(from[0], to[0]) * fraction);
    const lat = from[1] + (to[1] - from[1]) * fraction;
    if (!losHoverMarkerRef.current) {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "width:14px;height:14px;border-radius:50%;background:#f97316;" +
        "border:2px solid white;box-shadow:0 0 8px rgba(0,0,0,0.5);" +
        "pointer-events:none;";
      losHoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .addTo(mb);
    } else {
      losHoverMarkerRef.current.setLngLat([lng, lat]);
    }
  }, [mbMapRef]);

  // LoS analysis between toolFromId and toolToId (LOS tool active + both picks done)
  useEffect(() => {
    if (activeTool !== "los" || toolStep !== "result") {
      setLosResult(null);
      setLosError(null);
      setLosTerrainWarning(null);
      setIsComputingLos(false);
      return;
    }
    if (fromLng == null || fromLat == null || toLng == null || toLat == null) {
      setLosResult(null);
      // Nodes not loaded yet (URL-restored link): stay in the loading state and
      // let the nodes arrival retrigger via the endpoint-scalar/nodesEmpty deps.
      // A failed nodes query is final — fall through to the error instead.
      if (nodesEmpty && !nodesLoadFailed) return;
      // A picked endpoint lost its position (e.g. a live update dropped it) —
      // land on the error state, not an eternal spinner.
      setLosError("An endpoint no longer has a map position.");
      setIsComputingLos(false);
      return;
    }
    if (!terrain3D) { setLosResult(null); return; }
    const mb = mbMapRef.current;
    if (!mb) { setLosResult(null); return; }

    const fromPos: [number, number] = [fromLng, fromLat];
    const fromAltitude = fromAlt;
    const toPos: [number, number] = [toLng, toLat];
    const toAltitude = toAlt;

    // Stashed for the hover-marker callback (refs avoid deps churn)
    losFromPosRef.current = fromPos;
    losToPosRef.current = toPos;

    if (haversineKm(fromPos, toPos) < 0.01) {
      setLosError("Endpoints are the same — choose two different points.");
      setLosResult(null);
      setIsComputingLos(false);
      return;
    }

    const run = async () => {
      setLosError(null);
      setIsComputingLos(true);
      try {
      // Fetch our own DEM sized to the link bbox; queryTerrainElevation is viewport-limited (~400 m peak underread at low zoom)
      const midLng = normalizeLng(fromPos[0] + shortestLngDelta(fromPos[0], toPos[0]) / 2);
      const midLat = (fromPos[1] + toPos[1]) / 2;
      const dLat = (toPos[1] - fromPos[1]) * Math.PI / 180;
      const dLng = shortestLngDelta(fromPos[0], toPos[0]) * Math.PI / 180;
      const midLatRad = midLat * Math.PI / 180;
      const linkKm = 6371 * Math.sqrt(
        dLat * dLat + (dLng * Math.cos(midLatRad)) ** 2,
      );
      // Square bbox sized to the link (min 2 km pad) — a 500 m neighbor link
      // shouldn't fetch a 30 km DEM. Grid targets ~30 m/px (source-native)
      // capped at 2048, so short links also skip most of the resample cost.
      // The extra 25% fetch pad keeps nearby endpoint drags inside the cached
      // rasters (containment check below) so they recompute without a fetch.
      const halfSpanKm = linkKm / 2 + Math.max(2, linkKm * 0.15);
      const DEM_PAD = 1.25;
      const demBounds = demBoundsAround([midLng, midLat], halfSpanKm, DEM_PAD);
      const demWidthM = 2 * halfSpanKm * DEM_PAD * 1000;
      const demSize = Math.min(2048, Math.max(256, Math.ceil(demWidthM / 30)));

      const mapboxToken = env.MAPBOX_TOKEN;
      if (!mapboxToken) {
        console.warn("[Map] LoS aborted — Mapbox token missing.");
        setLosError("Terrain elevation source unavailable (Mapbox token not configured).");
        setLosResult(null);
        return;
      }

      const neededMpp = demWidthM / demSize;
      let dem: DEM;
      let demSourceUsedForLos: DemSource;
      let demTilesFailed = 0;
      let demTilesTotal = 0;
      let canopy: CanopyRaster | null = null;
      let buildings: BuildingRaster | null = null;
      let usedMpp = neededMpp;
      const demCache = losDemCacheRef.current;
      if (demCache && demBoundsContain(demCache.dem.bounds, demBounds) && demCache.mpp <= neededMpp * 2) {
        dem = demCache.dem;
        demSourceUsedForLos = demCache.source;
        canopy = demCache.canopy;
        buildings = demCache.buildings;
        usedMpp = demCache.mpp;
        setLosDemSource(demSourceUsedForLos);
      } else {
        try {
          // Worker-offloaded (same path as coverage) so the tile decode + resample
          // doesn't freeze the map; falls back to main thread. Canopy/buildings are
          // fetched for the profile's clutter bands (fault-tolerant: missing bakes
          // just yield mask-0 rasters and no bands).
          const built = await buildCoverageRasters({
            bounds: demBounds,
            size: demSize,
            maxTiles: 256,
            token: mapboxToken,
            wantClutter: false,
            wantCanopy: true,
            wantBuildings: true,
          });
          if (cancelled) return;
          dem = built.dem;
          demSourceUsedForLos = built.demSource;
          demTilesFailed = built.demTilesFailed;
          demTilesTotal = built.demTilesTotal;
          // stdM is unread on the LOS path (only heightM feeds the profile bands);
          // dropping it saves 16.8 MB at the 2048² cap while the cache is held.
          canopy = built.canopy ? { ...built.canopy, stdM: new Float32Array(0) } : null;
          buildings = built.buildings;
          // A holed DEM would pin bad terrain under this bbox forever — let failed tiles retry.
          if (built.demTilesFailed === 0) {
            losDemCacheRef.current = { dem, source: demSourceUsedForLos, mpp: neededMpp, canopy, buildings };
          }
          setLosDemSource(demSourceUsedForLos);
        } catch (err) {
          // A stale run's late rejection must not clobber the newer run's state
          if (cancelled) return;
          console.warn("[Map] LoS DEM fetch failed:", err);
          setLosError("Couldn't load terrain elevation data. Check your connection and try again.");
          setLosResult(null);
          return;
        }
      }

      // Sample near the DEM's native resolution so narrow ridge crests can't fall
      // between profile points (a fixed 150 aliases out ridges past ~30 km links).
      const samples = Math.min(1000, Math.max(150, Math.ceil((linkKm * 1000) / usedMpp)));

      const canopyRaster = canopy;
      const buildingRaster = buildings;
      let nullTerrainSamples = 0;
      let result: LoSResult;
      try {
        result = analyzeLineOfSight({
          from: fromPos,
          to: toPos,
          fromAltitudeM: fromAltitude,
          toAltitudeM: toAltitude,
          fromAntennaHeightM: losFromHeightM,
          toAntennaHeightM: losToHeightM,
          freqGHz: losFreqMhz / 1000,
          samples,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            if (Number.isNaN(elev)) {
              nullTerrainSamples++;
              return null;
            }
            return elev;
          },
          queryCanopyM: canopyRaster
            ? (lng, lat) => sampleCanopyAt(canopyRaster, lng, lat)?.heightM ?? null
            : undefined,
          queryBuildingM: buildingRaster
            ? (lng, lat) => sampleBuildingAt(buildingRaster, lng, lat)?.heightM ?? null
            : undefined,
        });
      } catch (err) {
        console.warn("[Map] LoS analysis failed:", err);
        setLosError("Line-of-sight analysis failed for this path.");
        setLosResult(null);
        return;
      }
      // Show geometric result immediately; ITM enhances async
      setLosResult(result);
      // Missing terrain reads as sea level in the analysis — never let that pass silently.
      if (demTilesFailed > 0) {
        setLosTerrainWarning(
          `${demTilesFailed} of ${demTilesTotal} terrain tiles failed to load — gaps read as sea level, so this result may be unreliable. Recompute to retry.`,
        );
      } else if (nullTerrainSamples > 0) {
        setLosTerrainWarning(
          `${nullTerrainSamples} of ${result.points.length} path samples had no terrain data and read as sea level.`,
        );
      } else {
        setLosTerrainWarning(null);
      }

      // ITM enhancement — silently skips if WASM isn't built
      try {
        const profileM = new Float64Array(result.points.map((p) => p.ground));
        if (profileM.length < 2) return;
        const spacingM = (result.totalDistanceKm * 1000) / (profileM.length - 1);
        const fromGroundM = result.points[0].ground;
        const toGroundM = result.points[result.points.length - 1].ground;
        const itm = await computeP2PLoss({
          txHeightM: Math.max(0.5, result.fromHeightM - fromGroundM),
          rxHeightM: Math.max(0.5, result.toHeightM - toGroundM),
          profileM,
          pointSpacingM: spacingM,
          ...DEFAULT_ITM_ENV,
          freqMhz: result.frequencyGHz * 1000,
        });
        if (cancelled) return;
        setLosResult({
          ...result,
          itmLossDb: itm.lossDb,
          itmFreeSpaceDb: itm.intermediate.aFreeSpaceDb,
          itmMode: itm.intermediate.mode,
        });
      } catch (itmErr) {
        console.warn("[Map] LoS ITM enhancement unavailable:", itmErr);
      }
      } finally {
        if (!cancelled) setIsComputingLos(false);
      }
    };

    // Fit viewport only when endpoints change, not on config tweaks
    const fitKey = `${fromPos[0]},${fromPos[1]}-${toPos[0]},${toPos[1]}`;
    if (losFitKeyRef.current !== fitKey) {
      losFitKeyRef.current = fitKey;
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend(fromPos);
      // Unwrap so an antimeridian-crossing pair frames the short way, not the whole world
      bounds.extend([fromPos[0] + shortestLngDelta(fromPos[0], toPos[0]), toPos[1]]);
      mb.fitBounds(bounds, { padding: 120, duration: 600, maxZoom: 11 });
    }

    let cancelled = false;
    run().catch((err) => {
      if (!cancelled) console.warn("[Map] LoS run failed:", err);
    });
    return () => { cancelled = true; };
    // styleEpoch: map-readiness signal — a URL-restored analysis mounts before the
    // map exists and needs style.load to retrigger (DEM cache keeps re-runs cheap).
  }, [activeTool, toolStep, fromLng, fromLat, fromAlt, toLng, toLat, toAlt, losFromHeightM, losToHeightM, losFreqMhz, terrain3D, styleEpoch, nodesEmpty, nodesLoadFailed, mbMapRef, setLosResult, setLosDemSource, setLosError, setIsComputingLos, setLosTerrainWarning]);

  // Push LoS result → 3D tube layer + obstruction source.
  // Altitudes are scaled by terrain exaggeration to stay pinned to the visual surface.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const obsSrc = mb.getSource("los-obstructions") as MlGeoJSONSource | undefined;
    const tube = losTubeLayerRef.current;

    if (
      activeTool !== "los" || toolStep !== "result" || !losResult ||
      fromLng == null || fromLat == null || toLng == null || toLat == null
    ) {
      tube?.setData(null);
      obsSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const fromPos: [number, number] = [fromLng, fromLat];
    const toPos: [number, number] = [toLng, toLat];

    // Tube layer scales altitudes internally
    const tubeData = losPointsToTubeData(fromPos, toPos, losResult.points, losResult.totalDistanceKm);
    tube?.setData(tubeData);

    // fill-extrusion doesn't auto-scale base/top — scale manually
    const obstructions = pickObstructions(
      fromPos,
      toPos,
      losResult.points,
      losResult.totalDistanceKm,
      3,
    );
    const exagRaw = mb.getTerrain()?.exaggeration;
    const exag = typeof exagRaw === "number" ? exagRaw : 1;
    const obsGeo = obstructionsToGeoJSON(obstructions);
    obsGeo.features.forEach((f) => {
      f.properties.baseM *= exag;
      f.properties.topM *= exag;
    });
    obsSrc?.setData(obsGeo);
    // styleEpoch dep: setStyle recreates the obstruction source empty and strips the
    // tube layer's GL objects — this effect re-pushes both after style.load.
  }, [activeTool, toolStep, losResult, fromLng, fromLat, toLng, toLat, styleEpoch, mbMapRef, losTubeLayerRef]);

  // Draggable endpoint markers while a result is shown; dragging one converts
  // the endpoint to a virtual pin (with a micro-drag snap-back for wiggles).
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const showing = activeTool === "los" && toolStep === "result";
    const ends: Array<{
      which: "from" | "to";
      lng: number | null;
      lat: number | null;
      ref: React.RefObject<maplibregl.Marker | null>;
      color: string;
    }> = [
      { which: "from", lng: fromLng, lat: fromLat, ref: losFromMarkerRef, color: "#06b6d4" },
      { which: "to", lng: toLng, lat: toLat, ref: losToMarkerRef, color: "#d946ef" },
    ];
    for (const end of ends) {
      if (!showing || end.lng == null || end.lat == null) {
        if (end.ref.current) {
          // Marker.remove() unbinds drag listeners, so a removal mid-drag would
          // otherwise leave the shared dragging flag stuck true forever.
          end.ref.current.remove();
          end.ref.current = null;
          isDraggingMarkerRef.current = false;
        }
        continue;
      }
      if (end.ref.current) {
        end.ref.current.setLngLat([end.lng, end.lat]);
        continue;
      }
      const marker = new maplibregl.Marker({ color: end.color, draggable: true, scale: 0.75 })
        .setLngLat([end.lng, end.lat])
        .addTo(mb);
      let dragStart: maplibregl.LngLat | null = null;
      marker.on("dragstart", () => {
        isDraggingMarkerRef.current = true;
        dragStart = marker.getLngLat();
      });
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        if (dragStart) {
          // Screen-space threshold: a ground-meter one would swallow deliberate
          // fine-tuning drags at high zoom (5 m ≈ 33 px at z20).
          const p0 = mb.project(dragStart);
          const p1 = mb.project(ll);
          if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 6) {
            // Wiggle: snap back instead of detaching a node-anchored endpoint
            marker.setLngLat(dragStart);
            return;
          }
        }
        onEndpointDragged(end.which, [normalizeLng(ll.lng), ll.lat]);
      });
      end.ref.current = marker;
    }
  }, [activeTool, toolStep, fromLng, fromLat, toLng, toLat, styleEpoch, mbMapRef, isDraggingMarkerRef, onEndpointDragged]);

  return {
    losFromPosRef,
    losToPosRef,
    losHoverMarkerRef,
    losFitKeyRef,
    losDemCacheRef,
    losFromMarkerRef,
    losToMarkerRef,
    handleLosProfileHover,
  };
}
