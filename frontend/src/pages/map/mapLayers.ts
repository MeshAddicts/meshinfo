/** Idempotent creation of every map source + layer (re-run on each style.load). */
import type { FeatureCollection, GeoJsonProperties, Point as GeoPoint } from "geojson";
import type { Map as MlMap } from "maplibre-gl";

import { ActivityLayer } from "./activityLayer";
import { ClusterDonutLayer } from "./clusterDonutLayer";
import { mbRoleColorExpr, TRANSPARENT_1PX_PNG } from "./helpers";
import { LosTubeLayer } from "./losTubeLayer";
import { emptyLineFeatureCollection } from "./utils";

type LayerRef<T> = { current: T | null };

export type EnsureLayersCtx = {
  /** Fresh node GeoJSON for the two node sources (called once per invocation). */
  getNodesData: () => FeatureCollection<GeoPoint, GeoJsonProperties>;
  losTubeLayerRef: LayerRef<LosTubeLayer>;
  traceTubeLayerRef: LayerRef<LosTubeLayer>;
  clusterDonutLayerRef: LayerRef<ClusterDonutLayer>;
  activityLayerRef: LayerRef<ActivityLayer>;
  animationsEnabled: boolean;
  /** An RF tool is showing results — donuts + count labels start dimmed. */
  dimForTool: boolean;
};

export function ensureMapSourcesAndLayers(map: MlMap, ctx: EnsureLayersCtx): void {
  if (!map.getSource("nodes_clustered")) {
    map.addSource("nodes_clustered", {
      type: "geojson",
      data: ctx.getNodesData(),
      cluster: true,
      // 80 (vs default 50) spaces large donut centroids enough to avoid overlap
      clusterRadius: 80,
      // Align zoom range with map's (default 22); source defaults (18/17) break auto-spiderfy for stacked nodes
      maxzoom: 22,
      clusterMaxZoom: 21,
      clusterProperties: {
        onlineCount: ["+", ["case", ["get", "online"], 1, 0]],
      },
    });
  }

  if (!map.getSource("nodes_plain")) {
    map.addSource("nodes_plain", {
      type: "geojson",
      data: ctx.getNodesData(),
    });
  }

  if (!map.getSource("links")) {
    map.addSource("links", {
      type: "geojson",
      data: emptyLineFeatureCollection(),
    });
  }

  // Link highlight source + layer (for hover-highlight from details panel)
  if (!map.getSource("link-highlight")) {
    map.addSource("link-highlight", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("link-highlight-line")) {
    map.addLayer({
      id: "link-highlight-line",
      type: "line",
      source: "link-highlight",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": 5,
        "line-opacity": 0.9,
        "line-blur": 1,
      },
    });
  }

  // Path analysis source + layer
  if (!map.getSource("path-analysis")) {
    map.addSource("path-analysis", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("path-analysis-line")) {
    map.addLayer({
      id: "path-analysis-line",
      type: "line",
      source: "path-analysis",
      filter: ["!=", ["get", "gap"], true],
      layout: {
        "line-join": "round",
        "line-cap": "round",
        // Higher key renders later → the newest (primary) path sits on top
        "line-sort-key": ["get", "sort"],
      },
      paint: {
        "line-color": ["case", ["get", "primary"], "#06b6d4", "#38bdf8"],
        "line-width": ["coalesce", ["get", "width"], 2],
        "line-opacity": ["get", "opacity"],
      },
    });
  }
  // Legs spanning position-less (ghost) hops: dashed gray — estimated, not observed geometry
  if (!map.getLayer("path-analysis-line-gap")) {
    map.addLayer({
      id: "path-analysis-line-gap",
      type: "line",
      source: "path-analysis",
      filter: ["==", ["get", "gap"], true],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#9ca3af",
        "line-width": 2.5,
        "line-opacity": 0.7,
        "line-dasharray": [1.5, 2],
      },
    });
  }

  // Coverage radius source + layers
  if (!map.getSource("coverage")) {
    map.addSource("coverage", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("coverage-fill")) {
    map.addLayer({
      id: "coverage-fill",
      type: "fill",
      source: "coverage",
      paint: {
        "fill-color": ["coalesce", ["get", "color"], "#32f032"],
        "fill-opacity": 0.08,
      },
    });
  }
  if (!map.getLayer("coverage-outline")) {
    map.addLayer({
      id: "coverage-outline",
      type: "line",
      source: "coverage",
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#32f032"],
        "line-width": 1.5,
        "line-opacity": 0.5,
        "line-dasharray": [4, 4],
      },
    });
  }

  // Coverage-prediction raster (Phase 9.5 — raster+viewshed tool).
  // The worker posts back an RGBA buffer; we upload it as an image source
  // anchored to the DEM's lng/lat bounds, so it drapes on 3D terrain.
  // Initial placeholder: a 1×1 transparent PNG at a degenerate quad near 0,0.
  if (!map.getSource("coverage-raster")) {
    map.addSource("coverage-raster", {
      type: "image",
      url: TRANSPARENT_1PX_PNG,
      coordinates: [
        [0, 0.0001],
        [0.0001, 0.0001],
        [0.0001, 0],
        [0, 0],
      ],
    });
  }
  if (!map.getLayer("coverage-raster")) {
    map.addLayer({
      id: "coverage-raster",
      type: "raster",
      source: "coverage-raster",
      layout: { visibility: "none" },
      paint: {
        "raster-opacity": 0.7,
        "raster-fade-duration": 300,
        "raster-resampling": "linear",
      },
    });
  }

  // Iso-margin contour lines
  if (!map.getSource("coverage-contours")) {
    map.addSource("coverage-contours", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("coverage-contours-line")) {
    map.addLayer({
      id: "coverage-contours-line",
      type: "line",
      source: "coverage-contours",
      layout: {
        "line-join": "round",
        "line-cap": "round",
        visibility: "none",
      },
      paint: {
        // 0 dB = magenta (edge), 10 = cyan, 20 = deep cyan
        "line-color": [
          "match", ["get", "thresholdDb"],
          0,  "#d946ef",
          10, "#06b6d4",
          20, "#0891b2",
          "#a1a1aa",
        ],
        "line-width": [
          "match", ["get", "thresholdDb"],
          0,  2.2,
          10, 1.6,
          20, 1.2,
          1,
        ],
        "line-opacity": 0.92,
      },
    });
  }

  // Visibility rays; rendered under contours for layer order
  if (!map.getSource("coverage-rays")) {
    map.addSource("coverage-rays", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("coverage-rays-line")) {
    map.addLayer(
      {
        id: "coverage-rays-line",
        type: "line",
        source: "coverage-rays",
        layout: {
          "line-cap": "butt",
          visibility: "none",
        },
        paint: {
          // Interpolated on segment peak marginDb, matching raster gradient
          "line-color": [
            "interpolate",
            ["linear"],
            ["get", "marginDb"],
            0,  "#d946ef",
            5,  "#f97316",
            15, "#06b6d4",
            25, "#0891b2",
          ],
          "line-width": 1,
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["get", "marginDb"],
            0,  0.2,
            5,  0.35,
            15, 0.55,
            25, 0.65,
          ],
        },
      },
      "coverage-contours-line",
    );
  }

  // 3D LoS tube (WebGL) + obstruction fill-extrusion pylons
  if (!map.getSource("los-obstructions")) {
    map.addSource("los-obstructions", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("los-obstructions-fill")) {
    map.addLayer({
      id: "los-obstructions-fill",
      type: "fill-extrusion",
      source: "los-obstructions",
      paint: {
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["get", "severity"],
          0, "#f87171",
          1, "#b91c1c",
        ],
        "fill-extrusion-base": ["get", "baseM"],
        "fill-extrusion-height": ["get", "topM"],
        "fill-extrusion-opacity": 0.75,
        "fill-extrusion-vertical-gradient": true,
      },
    });
  }
  if (!map.getLayer("los-tube")) {
    try {
      if (!ctx.losTubeLayerRef.current) ctx.losTubeLayerRef.current = new LosTubeLayer();
      map.addLayer(ctx.losTubeLayerRef.current);
    } catch (err) {
      console.warn("[Map] Failed to add LoS tube layer:", err);
    }
  }

  // Traceroute per-hop analysis: obstruction pylons + direct-path
  // counterfactual + 3D graded tube (own instances so LOS and traceroute
  // never clear each other's geometry)
  if (!map.getSource("trace-obstructions")) {
    map.addSource("trace-obstructions", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trace-obstructions-fill")) {
    map.addLayer({
      id: "trace-obstructions-fill",
      type: "fill-extrusion",
      source: "trace-obstructions",
      paint: {
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["get", "severity"],
          0, "#f87171",
          1, "#b91c1c",
        ],
        "fill-extrusion-base": ["get", "baseM"],
        "fill-extrusion-height": ["get", "topM"],
        "fill-extrusion-opacity": 0.75,
        "fill-extrusion-vertical-gradient": true,
      },
    });
  }
  if (!map.getSource("trace-direct")) {
    map.addSource("trace-direct", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trace-direct-line")) {
    map.addLayer({
      id: "trace-direct-line",
      type: "line",
      source: "trace-direct",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": [
          "match", ["get", "verdict"],
          "blocked", "#ef4444",
          "fresnel", "#f97316",
          "#22c55e",
        ],
        "line-width": 2.5,
        "line-opacity": 0.7,
        "line-dasharray": [2, 2],
      },
    });
  }
  if (!map.getLayer("trace-tube")) {
    try {
      if (!ctx.traceTubeLayerRef.current) ctx.traceTubeLayerRef.current = new LosTubeLayer("trace-tube");
      map.addLayer(ctx.traceTubeLayerRef.current);
    } catch (err) {
      console.warn("[Map] Failed to add trace tube layer:", err);
    }
  }
  // Lit-up picking: rings on nodes with observed routes through the origin
  if (!map.getSource("trace-candidates")) {
    map.addSource("trace-candidates", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("trace-candidates-ring")) {
    map.addLayer({
      id: "trace-candidates-ring",
      type: "circle",
      source: "trace-candidates",
      paint: {
        "circle-radius": 11,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#06b6d4",
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0.85,
        "circle-pitch-alignment": "map",
      },
    });
  }

  if (!map.getSource("scan-links")) {
    map.addSource("scan-links", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("scan-links-line")) {
    map.addLayer({
      id: "scan-links-line",
      type: "line",
      source: "scan-links",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": [
          "match", ["get", "cls"],
          "clear",      "#06b6d4",
          "fresnel",    "#f97316",
          "diffracted", "#d946ef",
          "blocked",    "#ef4444",
          "#9ca3af",
        ],
        "line-width": [
          "case",
          ["boolean", ["feature-state", "hover"], false], 4,
          2,
        ],
        "line-opacity": [
          "match", ["get", "cls"],
          "blocked", 0.4,
          0.85,
        ],
      },
    });
  }

  const linkWidth = [
    "case",
    ["==", ["get", "snr"], null], 3,
    ["interpolate", ["linear"], ["get", "snr"],
      -10, 1.5, 0, 3, 5, 5, 10, 7, 20, 9,
    ],
  ] as any;
  // Color = SNR (link quality); kind is conveyed by line style. Traceroute
  // keeps its orange — per-hop SNR isn't meaningful on an inferred path.
  const linkColor = [
    "case",
    ["==", ["get", "kind"], "traceroute"], "#F59E0B",
    ["==", ["get", "snr"], null], "#9ca3af",
    ["interpolate", ["linear"], ["get", "snr"],
      -10, "#FF4444", -5, "#FF6644", 0, "#FFAA00",
      2.5, "#FFDD00", 5, "#88DD00", 10, "#44CC44",
    ],
  ] as any;

  // Initial line-opacity bakes recencyOpacity from the feature; focus-on-hover
  // swaps these expressions in to dim non-connected links.
  const linkOpacityInitial = (base: number) =>
    // 0.6 = unknown-recency default (see recencyOpacityFromAgeMs).
    ["*", base, ["coalesce", ["get", "recencyOpacity"], 0.6]] as any;

  // Neighbor + both links (solid; "both" uses curved arcs)
  if (!map.getLayer("links-solid")) {
    map.addLayer({
      id: "links-solid",
      type: "line",
      source: "links",
      filter: ["in", ["get", "kind"], ["literal", ["neighbor", "both"]]],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-opacity": linkOpacityInitial(0.9),
        "line-width": linkWidth,
        "line-color": linkColor,
      },
    });
  }

  if (!map.getLayer("links-dashed")) {
    map.addLayer({
      id: "links-dashed",
      type: "line",
      source: "links",
      filter: ["==", ["get", "kind"], "heard_by"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-opacity": linkOpacityInitial(0.7),
        "line-width": linkWidth,
        "line-color": linkColor,
        "line-dasharray": [4, 3],
      },
    });
  }

  if (!map.getLayer("links-dotted")) {
    map.addLayer({
      id: "links-dotted",
      type: "line",
      source: "links",
      filter: ["==", ["get", "kind"], "traceroute"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-opacity": linkOpacityInitial(0.7),
        "line-width": linkWidth,
        "line-color": linkColor,
        "line-dasharray": [1, 3],
      },
    });
  }

  // Invisible hit-test layer for cluster clicks (donut layer is visual-only)
  if (!map.getLayer("clusters")) {
    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "nodes_clustered",
      filter: ["has", "point_count"],
      paint: {
        // ~2 px larger than donut for forgiving click target
        "circle-radius": ["interpolate", ["linear"], ["get", "point_count"],
          2, 20, 10, 26, 25, 34, 100, 48, 200, 56],
        "circle-color": "#000000",
        "circle-opacity": 0.005,
        "circle-stroke-width": 0,
        "circle-pitch-alignment": "viewport",
      },
    });
  }

  if (!map.getLayer("clusters-donuts")) {
    const donutLayer = new ClusterDonutLayer();
    map.addLayer(donutLayer);
    ctx.clusterDonutLayerRef.current = donutLayer;
    donutLayer.setAnimationsEnabled(ctx.animationsEnabled);
    if (ctx.dimForTool) donutLayer.setAlpha(0.25);
  }

  if (!map.getLayer("clusters-count")) {
    map.addLayer({
      id: "clusters-count",
      type: "symbol",
      source: "nodes_clustered",
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-size": ["interpolate", ["linear"], ["get", "point_count"],
          2, 12, 10, 15, 25, 18, 100, 21, 200, 24],
        "text-font": ["DIN Pro Medium", "Arial Unicode MS Bold"],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-opacity": ctx.dimForTool ? 0.25 : 1,
      },
    });
  }

  // Online node pulse behind unclustered nodes
  if (!map.getLayer("unclustered-pulse")) {
    map.addLayer({
      id: "unclustered-pulse",
      type: "circle",
      source: "nodes_clustered",
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "online"], true]],
      paint: {
        "circle-radius": 16,
        "circle-color": mbRoleColorExpr,
        "circle-opacity": 0.28,
        "circle-stroke-width": 0,
      },
    });
  }

  // clustered unclustered nodes
  if (!map.getLayer("unclustered-nodes")) {
    map.addLayer({
      id: "unclustered-nodes",
      type: "circle",
      source: "nodes_clustered",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 8],
        "circle-color": mbRoleColorExpr,
        // Recency brightness via `dim`; selected stays full-bright.
        "circle-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
        "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
        "circle-stroke-width": 2.5,
        "circle-stroke-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          "orange",
          "white",
        ],
      },
    });
  }

  if (!map.getLayer("unclustered-labels")) {
    map.addLayer({
      id: "unclustered-labels",
      type: "symbol",
      source: "nodes_clustered",
      filter: ["!", ["has", "point_count"]],
      minzoom: 9,
      layout: {
        "text-field": ["get", "shortname"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 14, 16, 16],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-halo-color": "#000000",
        "text-halo-width": 1.25,
        "text-color": "#ffffff",
      },
    });
  }

  // online node pulse (behind plain nodes)
  if (!map.getLayer("plain-pulse")) {
    map.addLayer({
      id: "plain-pulse",
      type: "circle",
      source: "nodes_plain",
      filter: ["==", ["get", "online"], true],
      paint: {
        "circle-radius": 16,
        "circle-color": mbRoleColorExpr,
        "circle-opacity": 0.28,
        "circle-stroke-width": 0,
      },
    });
  }

  // plain nodes layer
  if (!map.getLayer("plain-nodes")) {
    map.addLayer({
      id: "plain-nodes",
      type: "circle",
      source: "nodes_plain",
      paint: {
        "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 12, 8],
        "circle-color": mbRoleColorExpr,
        // Recency brightness via `dim`; selected stays full-bright.
        "circle-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
        "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, ["coalesce", ["get", "dim"], 1]],
        "circle-stroke-width": 2.5,
        "circle-stroke-color": [
          "case",
          ["boolean", ["feature-state", "selected"], false],
          "orange",
          "white",
        ],
      },
    });
  }

  if (!map.getLayer("plain-labels")) {
    map.addLayer({
      id: "plain-labels",
      type: "symbol",
      source: "nodes_plain",
      minzoom: 9,
      layout: {
        "text-field": ["get", "shortname"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 14, 16, 16],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-halo-color": "#000000",
        "text-halo-width": 1.25,
        "text-color": "#ffffff",
      },
    });
  }

  // Live packet activity (custom WebGL layer; drawn above nodes)
  if (!map.getLayer("activity")) {
    const al = new ActivityLayer();
    map.addLayer(al);
    ctx.activityLayerRef.current = al;
  }
}
