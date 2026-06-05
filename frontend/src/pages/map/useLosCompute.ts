import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { env } from "../../env";
import { Climate, computeP2PLoss, Polarization } from "./itm";
import { analyzeLineOfSight, type LoSResult } from "./losAnalysis";
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
  provider: string;
  terrain3D: boolean;
  nodes: Record<string, IMapNode>;
  losResult: LoSResult | null;
  mbMapRef: React.RefObject<MlMap | null>;
  losTubeLayerRef: React.RefObject<LosTubeLayer | null>;
  setLosResult: (r: LoSResult | null) => void;
  setLosDemSource: (s: DemSource | null) => void;
  setLosError: (e: string | null) => void;
};

export function useLosCompute(params: LosComputeParams) {
  const {
    activeTool, toolStep, toolFromId, toolToId,
    losVirtualFrom, losVirtualTo, losFromHeightM, losToHeightM,
    provider, terrain3D, nodes, losResult,
    mbMapRef, losTubeLayerRef,
    setLosResult, setLosDemSource, setLosError,
  } = params;

  // LOS endpoints from the compute effect; refs so the hover-marker callback reads them without deps churn
  const losFromPosRef = useRef<[number, number] | null>(null);
  const losToPosRef = useRef<[number, number] | null>(null);
  // Marker for the LOS elevation-chart hover
  const losHoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  // Skips fitBounds re-zoom when the user changes config without moving endpoints
  const losFitKeyRef = useRef<string | null>(null);

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
    const lng = from[0] + (to[0] - from[0]) * fraction;
    const lat = from[1] + (to[1] - from[1]) * fraction;
    if (!losHoverMarkerRef.current) {
      const el = document.createElement("div");
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
      return;
    }
    const hasFrom = toolFromId || losVirtualFrom;
    const hasTo = toolToId || losVirtualTo;
    if (!hasFrom || !hasTo) { setLosResult(null); return; }
    if (!terrain3D) { setLosResult(null); return; }
    const mb = mbMapRef.current;
    if (!mb) { setLosResult(null); return; }

    let fromPos: [number, number];
    let fromAltitude: number | null = null;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (!n?.map_position) { setLosResult(null); return; }
      fromPos = [n.map_position[0], n.map_position[1]];
      fromAltitude = n.position?.altitude ?? null;
    } else {
      fromPos = losVirtualFrom!;
    }

    let toPos: [number, number];
    let toAltitude: number | null = null;
    if (toolToId) {
      const n = nodes[toolToId] ?? nodes[`!${toolToId}`];
      if (!n?.map_position) { setLosResult(null); return; }
      toPos = [n.map_position[0], n.map_position[1]];
      toAltitude = n.position?.altitude ?? null;
    } else {
      toPos = losVirtualTo!;
    }

    // Stashed for the hover-marker callback (refs avoid deps churn)
    losFromPosRef.current = fromPos;
    losToPosRef.current = toPos;

    const run = async () => {
      setLosError(null);
      // Fetch our own DEM sized to the link bbox; queryTerrainElevation is viewport-limited (~400 m peak underread at low zoom)
      const midLng = (fromPos[0] + toPos[0]) / 2;
      const midLat = (fromPos[1] + toPos[1]) / 2;
      const dLat = (toPos[1] - fromPos[1]) * Math.PI / 180;
      const dLng = (toPos[0] - fromPos[0]) * Math.PI / 180;
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

      let dem: DEM;
      let demSourceUsedForLos: DemSource;
      try {
        // 2048² → ~115 m/px at 200 km. buildDem tries Tilezen first, falls back to Mapbox.
        ({ dem, source: demSourceUsedForLos } = await buildDem({
          bounds: demBounds,
          targetWidth: 2048,
          targetHeight: 2048,
          token: mapboxToken,
        }));
        setLosDemSource(demSourceUsedForLos);
      } catch (err) {
        console.warn("[Map] LoS DEM fetch failed:", err);
        setLosError("Couldn't load terrain elevation data. Check your connection and try again.");
        setLosResult(null);
        return;
      }

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
          samples: 150,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            return Number.isNaN(elev) ? null : elev;
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
          climate: Climate.ContinentalTemperate,
          surfaceRefractivityN: 301,
          freqMhz: result.frequencyGHz * 1000,
          polarization: Polarization.Vertical,
          groundDielectric: 15,
          groundConductivity: 0.005,
        });
        setLosResult({
          ...result,
          itmLossDb: itm.lossDb,
          itmFreeSpaceDb: itm.intermediate.aFreeSpaceDb,
          itmMode: itm.intermediate.mode,
        });
      } catch (itmErr) {
        console.warn("[Map] LoS ITM enhancement unavailable:", itmErr);
      }
    };

    // Fit viewport only when endpoints change, not on config tweaks
    const fitKey = `${fromPos[0]},${fromPos[1]}-${toPos[0]},${toPos[1]}`;
    if (losFitKeyRef.current !== fitKey) {
      losFitKeyRef.current = fitKey;
      const bounds = new maplibregl.LngLatBounds(fromPos, toPos);
      mb.fitBounds(bounds, { padding: 120, duration: 600, maxZoom: 11 });
    }

    let cancelled = false;
    run().catch((err) => {
      if (!cancelled) console.warn("[Map] LoS run failed:", err);
    });
    return () => { cancelled = true; };
  }, [activeTool, toolStep, toolFromId, toolToId, losVirtualFrom, losVirtualTo, losFromHeightM, losToHeightM, provider, terrain3D, nodes, mbMapRef, setLosResult, setLosDemSource, setLosError]);

  // Push LoS result → 3D tube layer + obstruction source.
  // Altitudes are scaled by terrain exaggeration to stay pinned to the visual surface.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;

    const hasFrom = toolFromId || losVirtualFrom;
    const hasTo = toolToId || losVirtualTo;
    const showing =
      activeTool === "los" && toolStep === "result" && losResult && hasFrom && hasTo;
    const obsSrc = mb.getSource("los-obstructions") as MlGeoJSONSource | undefined;
    const tube = losTubeLayerRef.current;

    if (!showing) {
      tube?.setData(null);
      obsSrc?.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    let fromPos: [number, number];
    let toPos: [number, number];
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (!n?.map_position) return;
      fromPos = [n.map_position[0], n.map_position[1]];
    } else {
      fromPos = losVirtualFrom!;
    }
    if (toolToId) {
      const n = nodes[toolToId] ?? nodes[`!${toolToId}`];
      if (!n?.map_position) return;
      toPos = [n.map_position[0], n.map_position[1]];
    } else {
      toPos = losVirtualTo!;
    }

    // Tube layer scales altitudes internally
    const tubeData = losPointsToTubeData(fromPos, toPos, losResult!.points, losResult!.totalDistanceKm);
    tube?.setData(tubeData);

    // fill-extrusion doesn't auto-scale base/top — scale manually
    const obstructions = pickObstructions(
      fromPos,
      toPos,
      losResult!.points,
      losResult!.totalDistanceKm,
      3,
    );
    const exagRaw = mb.getTerrain()?.exaggeration;
    const exag = typeof exagRaw === "number" ? exagRaw : 1;
    const obsGeo = obstructionsToGeoJSON(obstructions, 60);
    obsGeo.features.forEach((f) => {
      f.properties.baseM *= exag;
      f.properties.topM *= exag;
    });
    obsSrc?.setData(obsGeo);
  }, [activeTool, toolStep, losResult, toolFromId, toolToId, losVirtualFrom, losVirtualTo, nodes, mbMapRef, losTubeLayerRef]);

  return {
    losFromPosRef,
    losToPosRef,
    losHoverMarkerRef,
    losFitKeyRef,
    handleLosProfileHover,
  };
}
