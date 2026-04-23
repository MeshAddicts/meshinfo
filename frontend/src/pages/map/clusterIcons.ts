/**
 * Pre-rendered donut sprite images (0-100% online in 10% steps) registered as
 * Mapbox sprites; a symbol layer picks the right one by onlineCount/point_count.
 */
import type { Map as MlMap } from "maplibre-gl";

const COLOR_ONLINE = "#22c55e";
const COLOR_OFFLINE = "rgba(100,116,139,0.45)";
const COLOR_BG = "rgba(15,23,42,0.82)";
const COLOR_BORDER = "rgba(255,255,255,0.15)";

const IMG_DPR = 2;
const IMG_DIAMETER = 48; // CSS px at largest size
const IMG_PX = IMG_DIAMETER * IMG_DPR;

function renderDonut(onlinePercent: number): { width: number; height: number; data: Uint8Array } {
  const canvas = document.createElement("canvas");
  canvas.width = IMG_PX;
  canvas.height = IMG_PX;
  const ctx = canvas.getContext("2d")!;

  const cx = IMG_PX / 2;
  const cy = IMG_PX / 2;
  const outerR = IMG_PX / 2 - IMG_DPR;
  const ringWidth = Math.max(3.5 * IMG_DPR, outerR * 0.14);
  const midR = outerR - ringWidth / 2;
  const innerR = outerR - ringWidth;
  const TAU = Math.PI * 2;
  const start = -Math.PI / 2;

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, TAU);
  ctx.fillStyle = COLOR_BG;
  ctx.fill();

  ctx.lineWidth = ringWidth;
  ctx.lineCap = "butt";
  const ratio = onlinePercent / 100;

  if (ratio >= 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, TAU);
    ctx.strokeStyle = COLOR_ONLINE;
    ctx.stroke();
  } else if (ratio <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, TAU);
    ctx.strokeStyle = COLOR_OFFLINE;
    ctx.stroke();
  } else {
    const gap = 0.05;
    const onlineAngle = ratio * TAU;
    ctx.beginPath();
    ctx.arc(cx, cy, midR, start + gap / 2, start + onlineAngle - gap / 2);
    ctx.strokeStyle = COLOR_ONLINE;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, midR, start + onlineAngle + gap / 2, start + TAU - gap / 2);
    ctx.strokeStyle = COLOR_OFFLINE;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, innerR - 0.5 * IMG_DPR, 0, TAU);
  ctx.fillStyle = COLOR_BG;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, TAU);
  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = IMG_DPR;
  ctx.lineCap = "butt";
  ctx.stroke();

  const imageData = ctx.getImageData(0, 0, IMG_PX, IMG_PX);
  return { width: IMG_PX, height: IMG_PX, data: new Uint8Array(imageData.data.buffer) };
}

/** Register donut sprite images for each 10% online-ratio bucket. Idempotent. */
export function registerClusterIcons(map: MlMap): void {
  for (let pct = 0; pct <= 100; pct += 10) {
    const id = `donut-${pct}`;
    if (map.hasImage(id)) continue;
    map.addImage(id, renderDonut(pct), { pixelRatio: IMG_DPR });
  }
}

/** Mapbox expression → "donut-0"..."donut-100" by onlineCount/point_count.
 *  Uses numeric `step` (not concat+to-string+round) — per-feature string alloc stutters on pan/zoom. */
export const clusterIconExpr: any = [
  "step",
  ["/", ["coalesce", ["get", "onlineCount"], 0], ["max", ["get", "point_count"], 1]],
  "donut-0",
  0.05, "donut-10",
  0.15, "donut-20",
  0.25, "donut-30",
  0.35, "donut-40",
  0.45, "donut-50",
  0.55, "donut-60",
  0.65, "donut-70",
  0.75, "donut-80",
  0.85, "donut-90",
  0.95, "donut-100",
];

/** Smooth icon scaling based on point_count. */
export const clusterIconSizeExpr: any = [
  "interpolate",
  ["linear"],
  ["get", "point_count"],
  2, 0.55,   // ~26px
  5, 0.65,   // ~31px
  10, 0.75,  // ~36px
  50, 0.9,   // ~43px
  200, 1.0,  // 48px
];
