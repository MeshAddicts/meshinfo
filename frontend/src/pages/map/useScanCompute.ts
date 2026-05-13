import maplibregl, {
  GeoJSONSource as MlGeoJSONSource,
  Map as MlMap,
} from "maplibre-gl";
import { useEffect, useRef } from "react";

import { env } from "../../env";
import { buildBuildingRaster } from "./buildingTiles";
import { buildCanopyRaster } from "./canopyTiles";
import { AGGRESSION_STOPS, type CoverageReliability, reliabilityPreset } from "./coverageAnalysis";
import { type ItmContext, loadItmContext } from "./itm";
import { buildClutterRaster } from "./landcoverTiles";
import { runScan, type ScanClass, type ScanSummary, type ScanTarget, scanToGeoJSON } from "./scanAnalysis";
import { demBoundsAround, sampleDEMAt } from "./terrainDEM";
import { buildDem, type DemSource } from "./terrainRgb";
import type { IMapNode } from "./types";

type ScanComputeParams = {
  activeTool: "los" | "traceroute" | "coverage" | "scan" | null;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolVirtualPos: [number, number] | null;
  provider: string;
  terrain3D: boolean;
  nodes: Record<string, IMapNode>;
  scanTxDbm: number;
  scanAntennaDbi: number;
  scanRxAntennaDbi: number;
  scanEffectiveSensitivityDbm: number;
  scanAggressionIdx: number;
  scanClutterEnabled: boolean;
  scanCanopyEnabled: boolean;
  scanBuildingsEnabled: boolean;
  scanAntennaHeightM: number;
  scanReliability: CoverageReliability;
  hiddenScanClasses: Set<ScanClass>;
  scanSummary: ScanSummary | null;
  scanHoverId: string | null;
  mbMapRef: React.RefObject<MlMap | null>;
  isDraggingMarkerRef: React.RefObject<boolean>;
  setScanSummary: (s: ScanSummary | null) => void;
  setIsScanning: (b: boolean) => void;
  setScanDemSource: (s: DemSource | null) => void;
  setScanClutterStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setScanCanopyStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setScanBuildingsStatus: (s: { tilesPresent: number; tilesTotal: number } | null) => void;
  setToolFromId: (id: string | null) => void;
  setToolVirtualPos: (p: [number, number] | null) => void;
};

export function useScanCompute(params: ScanComputeParams) {
  const {
    activeTool, toolStep, toolFromId, toolVirtualPos,
    provider, terrain3D, nodes,
    scanTxDbm, scanAntennaDbi, scanRxAntennaDbi, scanEffectiveSensitivityDbm,
    scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled,
    scanAntennaHeightM, scanReliability,
    hiddenScanClasses, scanSummary, scanHoverId,
    mbMapRef, isDraggingMarkerRef,
    setScanSummary, setIsScanning, setScanDemSource,
    setScanClutterStatus, setScanCanopyStatus, setScanBuildingsStatus,
    setToolFromId, setToolVirtualPos,
  } = params;

  /** Draggable pin at the scan origin. */
  const scanOriginMarkerRef = useRef<maplibregl.Marker | null>(null);
  /** Map view captured when scan starts; restored by the origin row / pin. */
  const scanInitialViewRef = useRef<{ center: [number, number]; zoom: number; pitch: number; bearing: number } | null>(null);
  const scanOriginKeyRef = useRef<string | null>(null);
  // Lazily loaded, reused across scans; same WASM module as the coverage workers (main thread)
  const scanItmContextRef = useRef<ItmContext | null>(null);

  // Scan tool: batch LoS to every node in radius from a chosen origin
  useEffect(() => {
    if (activeTool !== "scan" || toolStep !== "result") {
      setScanSummary(null);
      setIsScanning(false);
      return;
    }
    if (!terrain3D) {
      setScanSummary(null);
      return;
    }
    const mb = mbMapRef.current;
    if (!mb) return;

    let origin: [number, number] | null = null;
    let originAltitude: number | null = null;
    let originShortname: string | undefined;
    if (toolFromId) {
      const n = nodes[toolFromId] ?? nodes[`!${toolFromId}`];
      if (n?.map_position) {
        origin = [n.map_position[0], n.map_position[1]];
        originAltitude = n.position?.altitude ?? null;
        originShortname = n.shortname ?? undefined;
      }
    } else if (toolVirtualPos) {
      origin = toolVirtualPos;
    }
    if (!origin) {
      setScanSummary(null);
      return;
    }

    // Snapshot view per-origin so "return to overview" is stable across
    // config re-runs but re-captures when the origin moves.
    const originKey = `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`;
    if (scanOriginKeyRef.current !== originKey) {
      scanOriginKeyRef.current = originKey;
      scanInitialViewRef.current = null;
    }
    if (!scanInitialViewRef.current) {
      const c = mb.getCenter();
      scanInitialViewRef.current = {
        center: [c.lng, c.lat],
        zoom: mb.getZoom(),
        pitch: mb.getPitch(),
        bearing: mb.getBearing(),
      };
    }

    if (scanOriginMarkerRef.current) {
      scanOriginMarkerRef.current.setLngLat(origin);
    } else {
      const marker = new maplibregl.Marker({ color: "#22d3ee", draggable: true })
        .setLngLat(origin)
        .addTo(mb);
      marker.on("dragstart", () => { isDraggingMarkerRef.current = true; });
      marker.on("dragend", () => {
        isDraggingMarkerRef.current = false;
        const ll = marker.getLngLat();
        scanInitialViewRef.current = null;
        scanOriginKeyRef.current = null;
        setToolFromId(null);
        setToolVirtualPos([ll.lng, ll.lat]);
      });
      scanOriginMarkerRef.current = marker;
    }

    setIsScanning(true);
    let cancelled = false;

    const SCAN_RADIUS_KM = 200;

    const runAsync = async () => {
      try {
        // Collect ALL nodes; runScan's maxDistanceKm applies the radius cutoff
        const targets: ScanTarget[] = [];
        const seen = new Set<string>();
        for (const [rawId, node] of Object.entries(nodes)) {
          if (!node?.map_position) continue;
          const [lng, lat] = node.map_position;
          const norm = rawId.startsWith("!") ? rawId.slice(1) : rawId;
          if (toolFromId && (norm === toolFromId || rawId === toolFromId)) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          targets.push({
            id: norm,
            shortname: node.shortname ?? undefined,
            position: [lng, lat],
            altitudeM: node.position?.altitude ?? null,
          });
        }

        if (targets.length === 0) {
          setScanSummary({
            origin: origin!,
            originShortname,
            results: [],
            clearCount: 0,
            fresnelCount: 0,
            diffractedCount: 0,
            blockedCount: 0,
          });
          setIsScanning(false);
          return;
        }

        // Viewport-independent DEM around origin (same 200 km cap as coverage)
        const mapboxToken = env.MAPBOX_TOKEN;
        if (!mapboxToken) {
          console.warn("[Map] Scan aborted — Mapbox token missing.");
          setIsScanning(false);
          return;
        }
        const scanBounds = demBoundsAround(origin!, SCAN_RADIUS_KM, 1.05);
        // 2048² rasters match coverage's resolution so per-target ITM sees
        // the same terrain detail the painted prediction does.
        const [{ dem, source: demSourceUsedForScan }, scanClutter, scanCanopy, scanBuildings] = await Promise.all([
          buildDem({
            bounds: scanBounds,
            targetWidth: 2048,
            targetHeight: 2048,
            token: mapboxToken,
          }),
          // Skip individual fetches when their respective models are toggled off.
          scanClutterEnabled
            ? buildClutterRaster({
                bounds: scanBounds,
                targetWidth: 2048,
                targetHeight: 2048,
              })
            : Promise.resolve(null),
          scanCanopyEnabled
            ? buildCanopyRaster({
                bounds: scanBounds,
                targetWidth: 2048,
                targetHeight: 2048,
              })
            : Promise.resolve(null),
          scanBuildingsEnabled
            ? buildBuildingRaster({
                bounds: scanBounds,
                targetWidth: 2048,
                targetHeight: 2048,
              })
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setScanDemSource(demSourceUsedForScan);
        setScanClutterStatus(
          scanClutter ? { tilesPresent: scanClutter.tilesPresent, tilesTotal: scanClutter.tilesTotal } : null,
        );
        setScanCanopyStatus(
          scanCanopy ? { tilesPresent: scanCanopy.tilesPresent, tilesTotal: scanCanopy.tilesTotal } : null,
        );
        setScanBuildingsStatus(
          scanBuildings ? { tilesPresent: scanBuildings.tilesPresent, tilesTotal: scanBuildings.tilesTotal } : null,
        );

        // Override GPS altitude with terrain + configured AGL (matches coverage).
        // Falls back to GPS altitude if DEM sampling fails.
        const originTerrainM = sampleDEMAt(dem, origin![0], origin![1]);
        const terrainValid = Number.isFinite(originTerrainM) && !Number.isNaN(originTerrainM);
        const effectiveOriginAltitude = terrainValid
          ? originTerrainM + scanAntennaHeightM
          : originAltitude;

        if (!scanItmContextRef.current) {
          try {
            scanItmContextRef.current = await loadItmContext(128);
          } catch (err) {
            console.warn("[Map] Scan ITM WASM unavailable — falling back to FSPL:", err);
          }
        }
        if (cancelled) return;

        const summary = runScan({
          origin: origin!,
          originAltitudeM: effectiveOriginAltitude,
          originShortname,
          targets,
          maxDistanceKm: SCAN_RADIUS_KM,
          raySamples: 60,
          freqGHz: 0.915,
          txDbm: scanTxDbm,
          txAntennaDbi: scanAntennaDbi,
          rxAntennaDbi: scanRxAntennaDbi,
          rxSensitivityDbm: scanEffectiveSensitivityDbm,
          clutterRaster: scanClutter,
          canopyRaster: scanCanopy,
          buildingRaster: scanBuildings,
          // aggression = 0 when the user has toggled the model off → ITM-only path loss.
          clutterAggression: scanClutterEnabled
            ? (AGGRESSION_STOPS[scanAggressionIdx]?.value ?? 1.0)
            : 0,
          queryTerrainM: (lng, lat) => {
            const elev = sampleDEMAt(dem, lng, lat);
            return Number.isNaN(elev) ? null : elev;
          },
          itm: scanItmContextRef.current
            ? {
                context: scanItmContextRef.current,
                climate: 5 /* ContinentalTemperate */,
                surfaceRefractivityN: 301,
                polarization: 1 /* Vertical */,
                groundDielectric: 15,
                groundConductivity: 0.005,
                // Without these, scanAnalysis falls back to 50/50/50 — much
                // more optimistic than coverage's 90/50/70 default.
                timePct: reliabilityPreset(scanReliability).time,
                locationPct: reliabilityPreset(scanReliability).location,
                situationPct: reliabilityPreset(scanReliability).situation,
              }
            : undefined,
        });

        if (cancelled) return;
        setScanSummary(summary);
        const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
        src?.setData(scanToGeoJSON(summary));
      } catch (err) {
        console.warn("[Map] Scan failed:", err);
        setScanSummary(null);
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    };

    runAsync();
    return () => { cancelled = true; };
  }, [activeTool, toolStep, toolFromId, toolVirtualPos, provider, terrain3D, nodes,
      scanTxDbm, scanAntennaDbi, scanRxAntennaDbi, scanEffectiveSensitivityDbm,
      scanAggressionIdx, scanClutterEnabled, scanCanopyEnabled, scanBuildingsEnabled,
      scanAntennaHeightM, scanReliability,
      mbMapRef, isDraggingMarkerRef,
      setScanSummary, setIsScanning, setScanDemSource,
      setScanClutterStatus, setScanCanopyStatus, setScanBuildingsStatus,
      setToolFromId, setToolVirtualPos]);

  // Per-class map visibility filter (compute still runs for hidden classes).
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    const layer = "scan-links-line";
    if (!mb.getLayer(layer)) return;
    if (hiddenScanClasses.size === 0) {
      mb.setFilter(layer, null);
    } else {
      mb.setFilter(layer, [
        "!",
        ["in", ["get", "cls"], ["literal", Array.from(hiddenScanClasses)]],
      ] as any);
    }
  }, [hiddenScanClasses, activeTool, mbMapRef]);

  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (activeTool !== "scan") {
      try {
        const src = mb.getSource("scan-links") as MlGeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: [] });
      } catch {}
      if (scanOriginMarkerRef.current) {
        scanOriginMarkerRef.current.remove();
        scanOriginMarkerRef.current = null;
      }
      scanInitialViewRef.current = null;
      scanOriginKeyRef.current = null;
    }
  }, [activeTool, mbMapRef]);

  // Scan hover via feature-state
  useEffect(() => {
    const mb = mbMapRef.current;
    if (!mb) return;
    if (!scanSummary) return;
    for (let i = 0; i < scanSummary.results.length; i++) {
      try {
        mb.setFeatureState(
          { source: "scan-links", id: i },
          { hover: false },
        );
      } catch {}
    }
    if (scanHoverId == null) return;
    const idx = scanSummary.results.findIndex((r) => r.id === scanHoverId);
    if (idx >= 0) {
      try {
        mb.setFeatureState(
          { source: "scan-links", id: idx },
          { hover: true },
        );
      } catch {}
    }
  }, [scanHoverId, scanSummary, mbMapRef]);

  return {
    scanOriginMarkerRef,
    scanInitialViewRef,
    scanOriginKeyRef,
    scanItmContextRef,
  };
}
