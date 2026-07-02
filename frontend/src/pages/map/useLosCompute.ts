import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { env } from "../../env";
import { effectiveAltitudeMslM } from "../nodes/altitudeAssessment";
import { normalizeLng, shortestLngDelta } from "./geo";
import { computeP2PLoss } from "./itm";
import { DEFAULT_ITM_ENV } from "./itmEnv";
import { analyzeLineOfSight, haversineKm, type LoSResult } from "./losAnalysis";
import { losPointsToTubeData, LosTubeLayer, obstructionsToGeoJSON, pickObstructions } from "./losTubeLayer";
import { type DEM, demBoundsAround, sampleDEMAt } from "./terrainDEM";
import { buildDem, type DemSource } from "./terrainRgb";
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
  terrain3D: boolean;
  /** Bumped on style.load — re-pushes tube/obstructions after setStyle wipes them. */
  styleEpoch: number;
  nodes: Record<string, IMapNode>;
  losResult: LoSResult | null;
  mbMapRef: React.RefObject<MlMap | null>;
  losTubeLayerRef: React.RefObject<LosTubeLayer | null>;
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
    terrain3D, styleEpoch, nodes, losResult,
    mbMapRef, losTubeLayerRef,
    setLosResult, setLosDemSource, setLosError, setIsComputingLos,
    setLosTerrainWarning,
  } = params;

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
  // Cache the bbox-derived DEM so height tweaks reuse it instead of re-stitching.
  const losDemCacheRef = useRef<{ key: string; dem: DEM; source: DemSource } | null>(null);

  // Remove the hover marker on unmount (resetTool covers tool changes, not navigation away).
  useEffect(() => () => {
    losHoverMarkerRef.current?.remove();
    losHoverMarkerRef.current = null;
  }, []);

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
      // A picked endpoint lost its position (e.g. a live update dropped it) —
      // land on the error state, not an eternal spinner.
      setLosResult(null);
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
      // Square bbox, 15 km minimum so short links still get a useful bbox
      const halfSpanKm = Math.max(15, linkKm / 2 + Math.max(15, linkKm * 0.15));
      const demBounds = demBoundsAround([midLng, midLat], halfSpanKm, 1.0);

      const mapboxToken = env.MAPBOX_TOKEN;
      if (!mapboxToken) {
        console.warn("[Map] LoS aborted — Mapbox token missing.");
        setLosError("Terrain elevation source unavailable (Mapbox token not configured).");
        setLosResult(null);
        return;
      }

      const demKey = `${demBounds.west.toFixed(4)},${demBounds.south.toFixed(4)},${demBounds.east.toFixed(4)},${demBounds.north.toFixed(4)}`;
      let dem: DEM;
      let demSourceUsedForLos: DemSource;
      let demTilesFailed = 0;
      let demTilesTotal = 0;
      const demCache = losDemCacheRef.current;
      if (demCache && demCache.key === demKey) {
        dem = demCache.dem;
        demSourceUsedForLos = demCache.source;
        setLosDemSource(demSourceUsedForLos);
      } else {
        try {
          // 2048² → ~115 m/px at 200 km. buildDem tries Tilezen first, falls back to Mapbox.
          const built = await buildDem({
            bounds: demBounds,
            targetWidth: 2048,
            targetHeight: 2048,
            token: mapboxToken,
          });
          if (cancelled) return;
          dem = built.dem;
          demSourceUsedForLos = built.source;
          demTilesFailed = built.tilesFailed;
          demTilesTotal = built.tilesTotal;
          // A holed DEM would pin bad terrain under this bbox forever — let failed tiles retry.
          if (built.tilesFailed === 0) {
            losDemCacheRef.current = { key: demKey, dem, source: demSourceUsedForLos };
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
      const demMetersPerPx = (2 * halfSpanKm * 1000) / 2048;
      const samples = Math.min(1000, Math.max(150, Math.ceil((linkKm * 1000) / demMetersPerPx)));

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
          freqGHz: 0.915,
          samples,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            if (Number.isNaN(elev)) {
              nullTerrainSamples++;
              return null;
            }
            return elev;
          },
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
  }, [activeTool, toolStep, fromLng, fromLat, fromAlt, toLng, toLat, toAlt, losFromHeightM, losToHeightM, terrain3D, mbMapRef, setLosResult, setLosDemSource, setLosError, setIsComputingLos, setLosTerrainWarning]);

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

  return {
    losFromPosRef,
    losToPosRef,
    losHoverMarkerRef,
    losFitKeyRef,
    handleLosProfileHover,
  };
}
