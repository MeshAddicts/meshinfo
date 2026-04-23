/**
 * Donut HTML markers for Mapbox clusters. Purely visual — interaction goes to the
 * underlying "clusters" circle layer. Matched by position (not cluster_id) so they
 * survive cluster-ID reassignment across setData() calls.
 */
import maplibregl from "maplibre-gl";

interface MarkerEntry {
  marker: maplibregl.Marker;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  clusterId: number;
  count: number;
  online: number;
  size: number;
}

const COLOR_ONLINE = "#22c55e";
const COLOR_OFFLINE = "rgba(100,116,139,0.45)";
const COLOR_BG = "rgba(15,23,42,0.82)";
const COLOR_BORDER = "rgba(255,255,255,0.12)";

function markerSize(count: number): number {
  return Math.round(28 + Math.min(Math.log2(Math.max(count, 2)) * 3, 18));
}

function abbreviate(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

const DPR = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

function drawDonut(
  canvas: HTMLCanvasElement,
  sizePx: number,
  onlineCount: number,
  totalCount: number,
): void {
  const canvasPx = Math.round(sizePx * DPR);
  canvas.width = canvasPx;
  canvas.height = canvasPx;
  canvas.style.width = `${sizePx}px`;
  canvas.style.height = `${sizePx}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const cx = canvasPx / 2;
  const cy = canvasPx / 2;
  const outerR = canvasPx / 2 - DPR;
  const ringWidth = Math.max(3.5 * DPR, outerR * 0.14);
  const midR = outerR - ringWidth / 2;
  const innerR = outerR - ringWidth;
  const TAU = Math.PI * 2;
  const start = -Math.PI / 2;

  ctx.clearRect(0, 0, canvasPx, canvasPx);

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, TAU);
  ctx.fillStyle = COLOR_BG;
  ctx.fill();

  ctx.lineWidth = ringWidth;
  ctx.lineCap = "butt";

  if (totalCount > 0) {
    if (onlineCount === totalCount) {
      ctx.beginPath();
      ctx.arc(cx, cy, midR, 0, TAU);
      ctx.strokeStyle = COLOR_ONLINE;
      ctx.stroke();
    } else if (onlineCount === 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, midR, 0, TAU);
      ctx.strokeStyle = COLOR_OFFLINE;
      ctx.stroke();
    } else {
      const gap = 0.05;
      const onlineAngle = (onlineCount / totalCount) * TAU;
      ctx.beginPath();
      ctx.arc(cx, cy, midR, start + gap / 2, start + onlineAngle - gap / 2);
      ctx.strokeStyle = COLOR_ONLINE;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, midR, start + onlineAngle + gap / 2, start + TAU - gap / 2);
      ctx.strokeStyle = COLOR_OFFLINE;
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.arc(cx, cy, innerR - 0.5 * DPR, 0, TAU);
  ctx.fillStyle = COLOR_BG;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, TAU);
  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = DPR;
  ctx.lineCap = "butt";
  ctx.stroke();

  const fontSize = Math.round(sizePx * 0.34 * DPR);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(abbreviate(totalCount), cx, cy + 0.5 * DPR);
}

/** Position key (~1m precision); stable across setData() unlike cluster_id. */
function posKey(lng: number, lat: number): string {
  return `${Math.round(lng * 1e5)},${Math.round(lat * 1e5)}`;
}

const byPos = new Map<string, MarkerEntry>();
const idToPos = new Map<number, string>(); // for hover highlight lookup

function createEntry(
  map: maplibregl.Map,
  lngLat: [number, number],
  clusterId: number,
  count: number,
  onlineCount: number,
): MarkerEntry {
  const size = markerSize(count);

  const el = document.createElement("div");
  el.style.cssText = `
    width: ${size}px;
    height: ${size}px;
    border-radius: 50%;
    pointer-events: none;
    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));
  `;

  const canvas = document.createElement("canvas");
  el.appendChild(canvas);
  drawDonut(canvas, size, onlineCount, count);

  const marker = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat(lngLat)
    .addTo(map);

  return { marker, el, canvas, clusterId, count, online: onlineCount, size };
}

export function updateClusterMarkers(map: maplibregl.Map): void {
  if (!map.getLayer("clusters")) return;

  // Single-arg form — passing `undefined` as geometry drops the layer filter (Mapbox overload quirk)
  const features = map.queryRenderedFeatures({ layers: ["clusters"] });

  // Dedupe features by position key
  const incoming = new Map<string, {
    id: number;
    coords: [number, number];
    count: number;
    online: number;
  }>();

  for (const f of features) {
    const id = f.properties?.cluster_id as number;
    if (id == null) continue;

    const raw = (f.geometry as any)?.coordinates;
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const lng = raw[0] as number;
    const lat = raw[1] as number;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const pk = posKey(lng, lat);
    if (incoming.has(pk)) continue;

    incoming.set(pk, {
      id,
      coords: [lng, lat],
      count: f.properties?.point_count ?? 0,
      online: f.properties?.onlineCount ?? 0,
    });
  }

  // If query returned nothing but markers exist, tiles aren't ready — bail to next idle
  if (incoming.size === 0 && byPos.size > 0) return;

  const seen = new Set<string>();

  for (const [pk, data] of incoming) {
    seen.add(pk);
    const existing = byPos.get(pk);

    if (existing) {
      if (existing.clusterId !== data.id) {
        idToPos.delete(existing.clusterId);
        existing.clusterId = data.id;
      }
      idToPos.set(data.id, pk);

      const cur = existing.marker.getLngLat();
      if (Math.abs(cur.lng - data.coords[0]) > 1e-6 || Math.abs(cur.lat - data.coords[1]) > 1e-6) {
        existing.marker.setLngLat(data.coords);
      }

      if (existing.count !== data.count || existing.online !== data.online) {
        const newSize = markerSize(data.count);
        if (newSize !== existing.size) {
          existing.el.style.width = `${newSize}px`;
          existing.el.style.height = `${newSize}px`;
          existing.size = newSize;
        }
        drawDonut(existing.canvas, newSize, data.online, data.count);
        existing.count = data.count;
        existing.online = data.online;
      }
    } else {
      const entry = createEntry(map, data.coords, data.id, data.count, data.online);
      byPos.set(pk, entry);
      idToPos.set(data.id, pk);
    }
  }

  for (const [pk, entry] of byPos) {
    if (!seen.has(pk)) {
      entry.marker.remove();
      idToPos.delete(entry.clusterId);
      byPos.delete(pk);
    }
  }
}

export function highlightCluster(clusterId: number): void {
  const pk = idToPos.get(clusterId);
  const entry = pk != null ? byPos.get(pk) : undefined;
  if (entry) {
    entry.el.style.filter = "drop-shadow(0 2px 8px rgba(0,0,0,0.5)) brightness(1.3)";
  }
}

export function unhighlightCluster(clusterId: number): void {
  const pk = idToPos.get(clusterId);
  const entry = pk != null ? byPos.get(pk) : undefined;
  if (entry) {
    entry.el.style.filter = "drop-shadow(0 2px 6px rgba(0,0,0,0.45))";
  }
}

export function removeAllClusterMarkers(): void {
  for (const [, entry] of byPos) {
    entry.marker.remove();
  }
  byPos.clear();
  idToPos.clear();
}
