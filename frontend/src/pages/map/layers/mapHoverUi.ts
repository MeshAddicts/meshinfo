/** Bind-once hover UI: cursor elevation feed, node tooltips, link hover cards. */
import maplibregl, { Map as MlMap } from "maplibre-gl";

import { NodeRole, roleTitles } from "../../../types";
import type { CoordPillSink } from "../components/MapCoordinatePill";
import { bestSnr, queryTerrainElevationMSL, relativeTime, signalBarsHtml } from "../lib/helpers";
import type { IMapNode } from "../lib/types";
import { escapeHtml } from "../lib/utils";
import { SPIDERFY_LAYER_NODES } from "./spiderfy";

export type HoverUiCtx = {
  mbMapRef: { current: MlMap | null };
  nodesRef: { current: Record<string, IMapNode> };
  coordPillSinkRef: { current: CoordPillSink | null };
  isDraggingMarkerRef: { current: boolean };
  terrain3DRef: { current: boolean };
};

export function bindMapHoverUi(map: MlMap, ctx: HoverUiCtx): void {
  const { mbMapRef, nodesRef, coordPillSinkRef, isDraggingMarkerRef, terrain3DRef } = ctx;

  // Live terrain elevation under the cursor (when 3D terrain is on).
  // Throttled via rAF so we don't call queryTerrainElevation on every pixel.
  let elevRafQueued = false;
  let pendingElevE: { lng: number; lat: number } | null = null;
  // Gate setHoverCoord on a real 5dp change so a stationary cursor doesn't
  // re-render the whole Map page each rAF frame.
  let lastHoverLng = NaN;
  let lastHoverLat = NaN;
  const onMapMouseMove = (e: maplibregl.MapMouseEvent) => {
    // Skip during marker drag — setHoverElevationM re-renders Map.tsx each
    // frame and stutters the marker behind the cursor.
    if (isDraggingMarkerRef.current) return;
    pendingElevE = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    if (elevRafQueued) return;
    elevRafQueued = true;
    requestAnimationFrame(() => {
      elevRafQueued = false;
      if (!pendingElevE || !mbMapRef.current) return;
      const lng = Math.round(pendingElevE.lng * 1e5) / 1e5;
      const lat = Math.round(pendingElevE.lat * 1e5) / 1e5;
      if (lng === lastHoverLng && lat === lastHoverLat) return;
      lastHoverLng = lng;
      lastHoverLat = lat;
      let elev: number | null = null;
      try {
        // Real MSL meters — users expect the elevation pill to match a topo map,
        // not the rendered terrain's exaggerated value. See queryTerrainElevationMSL.
        elev = queryTerrainElevationMSL(mbMapRef.current, [pendingElevE.lng, pendingElevE.lat]);
      } catch {}
      coordPillSinkRef.current?.setHover([lng, lat], terrain3DRef.current ? elev : null);
    });
  };
  const onMapMouseOut = () => {
    coordPillSinkRef.current?.setHover(null, null);
    lastHoverLng = NaN;
    lastHoverLat = NaN;
  };
  map.on("mousemove", onMapMouseMove);
  map.on("mouseout", onMapMouseOut);

  // --- Hover tooltips (desktop only) ---
  const hoverPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
    className: "map-hover-tooltip",
  });

  const showTooltip = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const p = feature.properties!;
    const nodeId = p.id as string;
    const role = p.role != null ? roleTitles[p.role as NodeRole]?.title ?? "" : "";
    const snr = bestSnr(nodeId, nodesRef.current);
    hoverPopup
      .setLngLat((feature.geometry as any).coordinates)
      .setHTML(
        `<div style="display:flex;align-items:center;gap:4px">` +
        signalBarsHtml(snr) +
        `<strong>${escapeHtml(p.shortname || nodeId)}</strong>` +
        `</div>` +
        (role ? `<span style="opacity:0.6">${role}</span><br/>` : "") +
        // Store, not feature props — last_seen isn't in the setData signature
        `<span style="opacity:0.6">${relativeTime((nodesRef.current[nodeId] ?? nodesRef.current[`!${nodeId}`])?.last_seen ?? p.last_seen)}</span>`
      )
      .addTo(map);
  };
  const hideTooltip = () => hoverPopup.remove();

  for (const layerId of ["unclustered-nodes", "plain-nodes", SPIDERFY_LAYER_NODES]) {
    map.on("mouseenter", layerId, showTooltip);
    map.on("mouseleave", layerId, hideTooltip);
  }

  // --- Link hover card ---
  const linkPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 12,
    className: "map-link-tooltip",
  });

  const KIND_LABEL: Record<string, string> = {
    neighbor: "Neighbor",
    heard_by: "Heard by",
    both: "Mutual",
    traceroute: "Traceroute",
  };

  const buildLinkPopupHtml = (p: Record<string, unknown>): string => {
    const liveNodes = nodesRef.current;
    const aId = String(p.aId ?? "");
    const bId = String(p.bId ?? "");
    const aShort = liveNodes[aId]?.shortname ?? aId.slice(0, 8);
    const bShort = liveNodes[bId]?.shortname ?? bId.slice(0, 8);
    const kind = String(p.kind ?? "");
    const kindLabel = KIND_LABEL[kind] ?? kind;
    const snrRaw = p.snr;
    const snrStr = typeof snrRaw === "number" && Number.isFinite(snrRaw)
      ? `${snrRaw.toFixed(1)} dB`
      : "—";
    const lastHeardMs = p.lastHeardMs;
    const heardStr = typeof lastHeardMs === "number" && Number.isFinite(lastHeardMs)
      ? relativeTime(new Date(lastHeardMs).toISOString())
      : "—";

    return (
      `<div style="display:flex;align-items:center;gap:6px;font-size:11px">` +
        `<strong>${escapeHtml(aShort)}</strong>` +
        `<span style="opacity:0.6">↔</span>` +
        `<strong>${escapeHtml(bShort)}</strong>` +
      `</div>` +
      `<div style="display:flex;justify-content:space-between;gap:12px;margin-top:4px;font-size:10px;opacity:0.85">` +
        `<span>${escapeHtml(kindLabel)}</span>` +
        `<span>SNR <strong>${snrStr}</strong></span>` +
      `</div>` +
      `<div style="font-size:10px;opacity:0.6;margin-top:2px">${escapeHtml(heardStr)}</div>`
    );
  };

  // Only rebuild the popup HTML when the hovered link changes; otherwise just
  // move it (setLngLat) as the cursor travels along the same link.
  let lastLinkKey: string | null = null;
  const showLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties ?? {};
    lastLinkKey = `${props.aId}|${props.bId}`;
    linkPopup.setLngLat(e.lngLat).setHTML(buildLinkPopupHtml(props)).addTo(map);
  };
  const moveLinkPopup = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
    const f = e.features?.[0];
    if (!f) return;
    const props = f.properties ?? {};
    const key = `${props.aId}|${props.bId}`;
    if (key !== lastLinkKey) {
      lastLinkKey = key;
      linkPopup.setHTML(buildLinkPopupHtml(props));
    }
    linkPopup.setLngLat(e.lngLat);
  };
  const hideLinkPopup = () => { lastLinkKey = null; linkPopup.remove(); };

  for (const layerId of ["links-solid", "links-dashed", "links-dotted"]) {
    map.on("mouseenter", layerId, showLinkPopup);
    map.on("mousemove", layerId, moveLinkPopup);
    map.on("mouseleave", layerId, hideLinkPopup);
  }
}
