/**
 * Per-hop RF analysis for the traceroute tool ("Why This Path").
 *
 * Fetches one union-bounds raster set (DEM + canopy + buildings) covering the
 * whole route, grades every adjacent positioned hop pair with the LOS engine,
 * analyzes the straight A→B counterfactual, and (async) enhances each leg with
 * ITM loss. Results feed a multi-hop graded tube, obstruction pylons, and the
 * panel's per-hop dossier.
 */
import {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { env } from "../../../env";
import type { ToolId } from "../components/MapToolsDrawer";
import {
  type LosTubeData,
  type LosTubeLayer,
  type ObstructionFeature,
  obstructionsToGeoJSON,
  pickObstructions,
} from "../layers/losTubeLayer";
import { normalizeLng, unwrapLngTo } from "../lib/geo";
import type { AnalyzedPath } from "../lib/pathAnalysis";
import type { IMapNode } from "../lib/types";
import { effectiveAltitudeMslM } from "../rf/altitudeAssessment";
import { computeP2PLoss, isItmAvailable } from "../rf/itm";
import { DEFAULT_ITM_ENV } from "../rf/itmEnv";
import { analyzeLineOfSight, haversineKm, type LoSResult } from "../rf/losAnalysis";
import { type BuildingRaster, sampleBuildingAt } from "../terrain/buildingTiles";
import { type CanopyRaster, sampleCanopyAt } from "../terrain/canopyTiles";
import { buildCoverageRasters } from "../terrain/rasterBuildClient";
import { type DEM, demBoundsAround, demBoundsContain, sampleDEMAt } from "../terrain/terrainDEM";
import type { DemSource } from "../terrain/terrainRgb";

/** Matches LOS tool defaults: 2 m antennas, 915 MHz. */
const TRACE_ANTENNA_HEIGHT_M = 2;
const TRACE_FREQ_GHZ = 0.915;

export type TraceLegVerdict = "clear" | "fresnel" | "blocked" | "gap";

/** One dossier row: the hops[index] → hops[index+1] leg of the analyzed path. */
export interface TraceLeg {
  index: number;
  fromId: string;
  toId: string;
  /** null when either end lacks a position — not implied by verdict "gap":
   *  ungraded analyses mark every leg "gap" yet still carry real distances. */
  distanceKm: number | null;
  verdict: TraceLegVerdict;
  /** Worst first-Fresnel clearance along the leg as a ratio of F₁ (≥0.6 = clear enough). */
  minClearanceRatio: number | null;
  worstObstructionM: number;
  diffractionLossDb: number;
  itmLossDb?: number;
  itmMode?: string;
}

export interface TraceDirect {
  distanceKm: number;
  verdict: Exclude<TraceLegVerdict, "gap">;
  worstObstructionM: number;
  worstObstructionDistKm: number;
  diffractionLossDb: number;
  itmLossDb?: number;
  itmMode?: string;
}

export interface TraceAnalysis {
  /** Path signature this analysis belongs to (hops.join(">")). */
  sig: string;
  /** False for ungraded dossiers (no terrain/token/positions): their legs all
   *  read verdict "gap" regardless of real obstruction state. */
  graded: boolean;
  legs: TraceLeg[];
  direct: TraceDirect | null;
  /** Hops in the path with no known position. */
  ghostHops: number;
  /** Finished render artifacts (unscaled MSL heights). */
  tubeData: LosTubeData | null;
  obstructions: ObstructionFeature[];
  /** Direct-line coords (destination unwrapped), for the counterfactual overlay. */
  directCoords: [number, number][] | null;
}

type TraceComputeParams = {
  activeTool: ToolId | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  /** Path selected for analysis (primary or user-chosen alternate). */
  path: AnalyzedPath | null;
  /** Position signature of the path's hops — a hop position arriving or moving
   *  must regrade, or tube/pylons/dossier diverge from the drawn line. */
  posKey: string;
  terrain3D: boolean;
  styleEpoch: number;
  showDirect: boolean;
  nodesRef: React.RefObject<Record<string, IMapNode>>;
  mbMapRef: React.RefObject<MlMap | null>;
  traceTubeLayerRef: React.RefObject<LosTubeLayer | null>;
};

export function useTraceCompute(params: TraceComputeParams) {
  const {
    activeTool, toolStep, path, posKey, terrain3D, styleEpoch, showDirect,
    nodesRef, mbMapRef, traceTubeLayerRef,
  } = params;

  const [traceAnalysis, setTraceAnalysis] = useState<TraceAnalysis | null>(null);
  const [isComputingTrace, setIsComputingTrace] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceWarning, setTraceWarning] = useState<string | null>(null);

  // Cached rasters for the last analyzed route; containment + resolution reuse
  // makes switching between alternates of the same pair free.
  const traceDemCacheRef = useRef<{
    dem: DEM;
    source: DemSource;
    mpp: number;
    canopy: CanopyRaster | null;
    buildings: BuildingRaster | null;
  } | null>(null);

  // Warm the ITM WASM while the user is picking so results don't pay the load.
  useEffect(() => {
    if (activeTool === "traceroute") void isItmAvailable();
  }, [activeTool]);

  // Path identity — recompute only when the analyzed sequence itself changes.
  const pathKey = path ? path.hops.join(">") : "";

  useEffect(() => {
    if (activeTool !== "traceroute" || toolStep !== "result" || !path || !pathKey) {
      setTraceAnalysis(null);
      setTraceError(null);
      setTraceWarning(null);
      setIsComputingTrace(false);
      return;
    }
    // A different path was selected — drop the previous path's artifacts now,
    // not when the new grade lands (the push effect renders whatever is set).
    setTraceAnalysis((prev) => (prev && prev.sig !== pathKey ? null : prev));

    // The real array, not pathKey.split(">") — hop ids can contain ">"
    // (unresolved longnames), and any hops change also changes pathKey.
    const hops = path.hops;
    const liveNodes = nodesRef.current ?? {};
    const posOf = (id: string): [number, number] | null => {
      const n = liveNodes[id] ?? liveNodes[`!${id}`];
      return n?.map_position ? [n.map_position[0], n.map_position[1]] : null;
    };
    const altOf = (id: string): number | null => {
      const n = liveNodes[id] ?? liveNodes[`!${id}`];
      return n ? effectiveAltitudeMslM(n.position) : null;
    };

    const positions = hops.map(posOf);
    const positioned = positions
      .map((pos, i) => ({ pos, i }))
      .filter((x): x is { pos: [number, number]; i: number } => x.pos != null);
    const ghostHops = hops.length - positioned.length;

    // Ungraded dossier: distances/measured SNR need neither terrain nor a
    // token; verdicts stay "gap" and the tube/obstruction artifacts null.
    const ungradedAnalysis = (): TraceAnalysis => ({
      sig: pathKey,
      graded: false,
      legs: hops.slice(0, -1).map((id, i) => {
        const a = positions[i];
        const b = positions[i + 1];
        return {
          index: i, fromId: id, toId: hops[i + 1],
          distanceKm: a && b ? haversineKm(a, b) : null,
          verdict: "gap" as const,
          minClearanceRatio: null, worstObstructionM: 0, diffractionLossDb: 0,
        };
      }),
      direct: null, ghostHops, tubeData: null, obstructions: [], directCoords: null,
    });

    if (positioned.length < 2) {
      setTraceAnalysis(ungradedAnalysis());
      setTraceError(null);
      setTraceWarning("Too few hops have known positions to grade this route.");
      setIsComputingTrace(false);
      return;
    }

    if (!terrain3D) {
      // Panel shows the enable-terrain hint; distances + measured SNR stay.
      setTraceAnalysis(ungradedAnalysis());
      setTraceError(null);
      setTraceWarning(null);
      setIsComputingTrace(false);
      return;
    }

    const token = env.MAPBOX_TOKEN;
    if (!token) {
      setTraceAnalysis(ungradedAnalysis());
      setTraceError("Terrain elevation source unavailable (Mapbox token not configured).");
      setTraceWarning(null);
      setIsComputingTrace(false);
      return;
    }

    let cancelled = false;

    const run = async () => {
      setTraceError(null);
      setTraceWarning(null);
      setIsComputingTrace(true);
      try {
        // Union bbox of every positioned hop, unwrapped into the first hop's
        // longitude frame so seam-crossing routes stay one tight box.
        const ref = positioned[0].pos;
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const { pos } of positioned) {
          const lngU = unwrapLngTo(ref[0], pos[0]);
          if (lngU < minLng) minLng = lngU;
          if (lngU > maxLng) maxLng = lngU;
          if (pos[1] < minLat) minLat = pos[1];
          if (pos[1] > maxLat) maxLat = pos[1];
        }
        const midLng = normalizeLng((minLng + maxLng) / 2);
        const midLat = (minLat + maxLat) / 2;
        const halfWKm = ((maxLng - minLng) / 2) * 111 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
        const halfHKm = ((maxLat - minLat) / 2) * 111;
        // Min 2 km pad; 15% of span keeps re-fetches rare as data refreshes.
        const spanKm = Math.max(halfWKm, halfHKm) * 2;
        const halfSpanKm = Math.max(halfWKm, halfHKm) + Math.max(2, spanKm * 0.15);
        const DEM_PAD = 1.25;
        const demBounds = demBoundsAround([midLng, midLat], halfSpanKm, DEM_PAD);
        const demWidthM = 2 * halfSpanKm * DEM_PAD * 1000;
        const demSize = Math.min(2048, Math.max(256, Math.ceil(demWidthM / 30)));
        const neededMpp = demWidthM / demSize;

        let dem: DEM;
        let canopy: CanopyRaster | null = null;
        let buildings: BuildingRaster | null = null;
        let usedMpp = neededMpp;
        let demTilesFailed = 0;
        let demTilesTotal = 0;
        const cache = traceDemCacheRef.current;
        if (cache && demBoundsContain(cache.dem.bounds, demBounds) && cache.mpp <= neededMpp * 2) {
          dem = cache.dem;
          canopy = cache.canopy;
          buildings = cache.buildings;
          usedMpp = cache.mpp;
        } else {
          const built = await buildCoverageRasters({
            bounds: demBounds,
            size: demSize,
            maxTiles: 256,
            token,
            wantClutter: false,
            wantCanopy: true,
            wantBuildings: true,
          });
          if (cancelled) return;
          dem = built.dem;
          demTilesFailed = built.demTilesFailed;
          demTilesTotal = built.demTilesTotal;
          canopy = built.canopy ? { ...built.canopy, stdM: new Float32Array(0) } : null;
          buildings = built.buildings;
          // A holed DEM would pin bad terrain under this bbox — let failed tiles retry.
          if (built.demTilesFailed === 0) {
            traceDemCacheRef.current = { dem, source: built.demSource, mpp: neededMpp, canopy, buildings };
          }
        }

        let nullTerrainSamples = 0;
        let totalSamples = 0;
        const queryTerrainM = (lng: number, lat: number): number | null => {
          const elev = sampleDEMAt(dem, lng, lat);
          if (Number.isNaN(elev)) {
            nullTerrainSamples++;
            return null;
          }
          return elev;
        };
        const canopyRaster = canopy;
        const buildingRaster = buildings;
        const queryCanopyM = canopyRaster
          ? (lng: number, lat: number) => sampleCanopyAt(canopyRaster, lng, lat)?.heightM ?? null
          : undefined;
        const queryBuildingM = buildingRaster
          ? (lng: number, lat: number) => sampleBuildingAt(buildingRaster, lng, lat)?.heightM ?? null
          : undefined;

        const analyzeLeg = (from: [number, number], to: [number, number], fromAlt: number | null, toAlt: number | null): LoSResult => {
          const legKm = haversineKm(from, to);
          const samples = Math.min(600, Math.max(64, Math.ceil((legKm * 1000) / usedMpp)));
          totalSamples += samples;
          return analyzeLineOfSight({
            from, to,
            fromAltitudeM: fromAlt,
            toAltitudeM: toAlt,
            fromAntennaHeightM: TRACE_ANTENNA_HEIGHT_M,
            toAntennaHeightM: TRACE_ANTENNA_HEIGHT_M,
            freqGHz: TRACE_FREQ_GHZ,
            samples,
            queryTerrainM,
            queryCanopyM,
            queryBuildingM,
          });
        };

        const verdictOf = (r: LoSResult): Exclude<TraceLegVerdict, "gap"> =>
          !r.losClear ? "blocked" : !r.fresnelClear ? "fresnel" : "clear";
        const minClearanceOf = (r: LoSResult): number => {
          let min = Infinity;
          // Endpoints have fresnelRadius 0 → ratio Infinity; interior points decide.
          for (const p of r.points) if (p.clearanceRatio < min) min = p.clearanceRatio;
          return Number.isFinite(min) ? min : 1;
        };

        // Drawn segments: consecutive positioned hops. A span > 1 crosses ghost
        // hops — drawn gray, never graded (no real endpoints to grade).
        type Seg = { fromIdx: number; toIdx: number; result: LoSResult | null };
        const segs: Seg[] = [];
        for (let k = 0; k + 1 < positioned.length; k++) {
          const A = positioned[k];
          const B = positioned[k + 1];
          const isGap = B.i - A.i > 1;
          let result: LoSResult | null = null;
          if (!isGap) {
            result = analyzeLeg(A.pos, B.pos, altOf(hops[A.i]), altOf(hops[B.i]));
            // Yield periodically so long routes can't jank the frame.
            if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0));
            if (cancelled) return;
          }
          segs.push({ fromIdx: A.i, toIdx: B.i, result });
        }

        // Dossier rows — one per hop pair of the path.
        const legs: TraceLeg[] = [];
        for (let i = 0; i + 1 < hops.length; i++) {
          const seg = segs.find((s) => s.fromIdx === i && s.toIdx === i + 1);
          if (seg?.result) {
            const r = seg.result;
            legs.push({
              index: i, fromId: hops[i], toId: hops[i + 1],
              distanceKm: r.totalDistanceKm,
              verdict: verdictOf(r),
              minClearanceRatio: minClearanceOf(r),
              worstObstructionM: r.worstObstructionM,
              diffractionLossDb: r.diffractionLossDb,
            });
          } else {
            legs.push({
              index: i, fromId: hops[i], toId: hops[i + 1], distanceKm: null,
              verdict: "gap", minClearanceRatio: null, worstObstructionM: 0, diffractionLossDb: 0,
            });
          }
        }

        // Direct A→B counterfactual (endpoints are picked nodes → positioned).
        // A 1-hop route IS the direct line — no counterfactual to show.
        const endFrom = positions[0];
        const endTo = positions[positions.length - 1];
        let direct: TraceDirect | null = null;
        let directResult: LoSResult | null = null;
        let directCoords: [number, number][] | null = null;
        if (hops.length > 2 && endFrom && endTo && haversineKm(endFrom, endTo) >= 0.01) {
          directResult = analyzeLeg(endFrom, endTo, altOf(hops[0]), altOf(hops[hops.length - 1]));
          direct = {
            distanceKm: directResult.totalDistanceKm,
            verdict: verdictOf(directResult),
            worstObstructionM: directResult.worstObstructionM,
            worstObstructionDistKm: directResult.worstObstructionDistKm,
            diffractionLossDb: directResult.diffractionLossDb,
          };
          directCoords = [endFrom, [unwrapLngTo(endFrom[0], endTo[0]), endTo[1]]];
        }

        // Multi-hop tube: concat per-segment strips in ONE continuous unwrapped
        // longitude frame (per-vertex normalizeLng would streak a seam-crossing
        // strip across the world; MercatorCoordinate maps out-of-range lngs
        // continuously). Boundary vertices are duplicated around gap connectors
        // (zero-length transitions) so gray never bleeds into graded colors.
        const tubePoints: LosTubeData["points"] = [];
        let prevWasGap = false;
        let chainLng: number | null = null;
        for (const seg of segs) {
          const A = positions[seg.fromIdx]!;
          const B = positions[seg.toIdx]!;
          const aLng = chainLng == null ? A[0] : unwrapLngTo(chainLng, A[0]);
          const bLng = unwrapLngTo(aLng, B[0]);
          chainLng = bLng;
          if (seg.result) {
            const r = seg.result;
            const total = r.totalDistanceKm;
            const startJ = tubePoints.length > 0 && !prevWasGap ? 1 : 0;
            for (let j = startJ; j < r.points.length; j++) {
              const p = r.points[j];
              const t = total > 0 ? p.distanceKm / total : 0;
              tubePoints.push({
                lng: aLng + (bLng - aLng) * t,
                lat: A[1] + (B[1] - A[1]) * t,
                altitude: p.chord,
                color: p.blocked ? "blocked" : p.fresnelIntruded ? "fresnel" : "clear",
              });
            }
            prevWasGap = false;
          } else {
            const hB = (queryTerrainM(B[0], B[1]) ?? 0) + TRACE_ANTENNA_HEIGHT_M;
            if (tubePoints.length === 0) {
              const hA = (queryTerrainM(A[0], A[1]) ?? 0) + TRACE_ANTENNA_HEIGHT_M;
              tubePoints.push({ lng: aLng, lat: A[1], altitude: hA, color: "gap" });
            } else {
              // Duplicate the boundary vertex in gray to start the connector
              tubePoints.push({ ...tubePoints[tubePoints.length - 1], color: "gap" });
            }
            tubePoints.push({ lng: bLng, lat: B[1], altitude: hB, color: "gap" });
            prevWasGap = true;
          }
        }

        // Obstruction pylons: worst offenders across all graded legs.
        const allObs: ObstructionFeature[] = [];
        for (const seg of segs) {
          if (!seg.result) continue;
          const A = positions[seg.fromIdx]!;
          const B = positions[seg.toIdx]!;
          allObs.push(...pickObstructions(A, B, seg.result.points, seg.result.totalDistanceKm, 2));
        }
        allObs.sort((x, y) => y.violationM - x.violationM);
        const topObs = allObs.slice(0, 5);
        const worstV = topObs[0]?.violationM || 1;
        for (const o of topObs) o.severity = Math.min(1, o.violationM / worstV);

        const geometric: TraceAnalysis = {
          sig: pathKey, graded: true, legs, direct, ghostHops,
          tubeData: tubePoints.length >= 2 ? { points: tubePoints } : null,
          obstructions: topObs,
          directCoords,
        };
        if (cancelled) return;
        setTraceAnalysis(geometric);

        if (demTilesFailed > 0) {
          setTraceWarning(
            `${demTilesFailed} of ${demTilesTotal} terrain tiles failed to load — gaps read as sea level, so grades may be unreliable.`,
          );
        } else if (nullTerrainSamples > 0) {
          setTraceWarning(
            `${nullTerrainSamples} of ${totalSamples} samples had no terrain data and read as sea level.`,
          );
        } else if (ghostHops > 0) {
          setTraceWarning(
            `${ghostHops} ${ghostHops === 1 ? "hop has" : "hops have"} no known position — gray segments are estimated, not graded.`,
          );
        } else {
          setTraceWarning(null);
        }

        // ITM enhancement per leg + direct (silently skips if WASM missing).
        try {
          const enhanced = geometric.legs.map((l) => ({ ...l }));
          let anyItm = false;
          for (const seg of segs) {
            if (!seg.result || seg.toIdx - seg.fromIdx > 1) continue;
            const r = seg.result;
            const profileM = new Float64Array(r.points.map((p) => p.ground));
            if (profileM.length < 2) continue;
            const itm = await computeP2PLoss({
              txHeightM: Math.max(0.5, r.fromHeightM - r.points[0].ground),
              rxHeightM: Math.max(0.5, r.toHeightM - r.points[r.points.length - 1].ground),
              profileM,
              pointSpacingM: (r.totalDistanceKm * 1000) / (profileM.length - 1),
              ...DEFAULT_ITM_ENV,
              freqMhz: TRACE_FREQ_GHZ * 1000,
            });
            if (cancelled) return;
            const leg = enhanced.find((l) => l.index === seg.fromIdx);
            if (leg) {
              leg.itmLossDb = itm.lossDb;
              leg.itmMode = itm.intermediate.mode;
              anyItm = true;
            }
          }
          let directEnhanced = geometric.direct;
          if (directResult && directEnhanced) {
            const profileM = new Float64Array(directResult.points.map((p) => p.ground));
            if (profileM.length >= 2) {
              const itm = await computeP2PLoss({
                txHeightM: Math.max(0.5, directResult.fromHeightM - directResult.points[0].ground),
                rxHeightM: Math.max(0.5, directResult.toHeightM - directResult.points[directResult.points.length - 1].ground),
                profileM,
                pointSpacingM: (directResult.totalDistanceKm * 1000) / (profileM.length - 1),
                ...DEFAULT_ITM_ENV,
                freqMhz: TRACE_FREQ_GHZ * 1000,
              });
              if (cancelled) return;
              directEnhanced = { ...directEnhanced, itmLossDb: itm.lossDb, itmMode: itm.intermediate.mode };
              anyItm = true;
            }
          }
          if (anyItm && !cancelled) {
            setTraceAnalysis({ ...geometric, legs: enhanced, direct: directEnhanced });
          }
        } catch (itmErr) {
          console.warn("[Map] Trace ITM enhancement unavailable:", itmErr);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("[Map] Trace analysis failed:", err);
        setTraceError("Couldn't load terrain data for this route. Check your connection and try again.");
        setTraceAnalysis(null);
      } finally {
        if (!cancelled) setIsComputingTrace(false);
      }
    };

    run().catch((err) => {
      if (!cancelled) console.warn("[Map] Trace run failed:", err);
    });
    return () => { cancelled = true; };
    // styleEpoch: map-readiness signal (URL-restored analyses mount pre-map);
    // nodes are read via ref on purpose — SSE churn must not retrigger grading,
    // but posKey (a value-stable string) re-grades when a hop actually moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolStep, pathKey, posKey, terrain3D, styleEpoch]);

  // Push artifacts → tube layer + obstruction pylons + direct-line overlay.
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const tube = traceTubeLayerRef.current;
    const obsSrc = mb.getSource("trace-obstructions") as MlGeoJSONSource | undefined;
    const directSrc = mb.getSource("trace-direct") as MlGeoJSONSource | undefined;
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

    if (activeTool !== "traceroute" || toolStep !== "result" || !traceAnalysis) {
      tube?.setData(null);
      obsSrc?.setData(empty);
      directSrc?.setData(empty);
      return;
    }

    tube?.setData(traceAnalysis.tubeData);

    // fill-extrusion doesn't auto-scale to terrain exaggeration — scale manually
    const exagRaw = mb.getTerrain()?.exaggeration;
    const exag = typeof exagRaw === "number" ? exagRaw : 1;
    const obsGeo = obstructionsToGeoJSON(traceAnalysis.obstructions);
    obsGeo.features.forEach((f) => {
      f.properties.baseM *= exag;
      f.properties.topM *= exag;
    });
    obsSrc?.setData(obsGeo);

    directSrc?.setData(
      showDirect && traceAnalysis.directCoords && traceAnalysis.direct
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              properties: { verdict: traceAnalysis.direct.verdict },
              geometry: { type: "LineString", coordinates: traceAnalysis.directCoords },
            }],
          }
        : empty,
    );
    // styleEpoch: setStyle recreates sources empty and strips the tube's GL objects.
  }, [activeTool, toolStep, traceAnalysis, showDirect, styleEpoch, mbMapRef, traceTubeLayerRef]);

  return {
    traceAnalysis,
    isComputingTrace,
    traceError,
    traceWarning,
    traceDemCacheRef,
  };
}
