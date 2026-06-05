import { NodeRole } from "./types";

/** Node-role → color. Single source for map, graph, legend, and role badges. */
export const ROLE_COLORS: Record<number, string> = {
  [NodeRole.CLIENT]: "#32f032",        // green (default)
  [NodeRole.CLIENT_MUTE]: "#6b7280",   // gray
  [NodeRole.ROUTER]: "#3b82f6",        // blue
  [NodeRole.ROUTER_CLIENT]: "#60a5fa", // light blue
  [NodeRole.REPEATER]: "#f59e0b",      // amber
  [NodeRole.TRACKER]: "#a855f7",       // purple
  [NodeRole.SENSOR]: "#14b8a6",        // teal
  [NodeRole.TAK]: "#ef4444",           // red
  [NodeRole.CLIENT_HIDDEN]: "#4b5563", // dark gray
  [NodeRole.LOST_AND_FOUND]: "#d946ef",// fuchsia
  [NodeRole.TAK_TRACKER]: "#f87171",   // light red
  [NodeRole.ROUTER_LATE]: "#93c5fd",   // pale blue
  [NodeRole.CLIENT_BASE]: "#22c55e",   // emerald
};

/** Default/CLIENT node fill; also the legend/donut "online" green. */
export const DEFAULT_NODE_COLOR = "#32f032";
/** Offline node fill — mid-gray so it stays visible on the dark basemap. */
export const OFFLINE_NODE_COLOR = "#72798a";
/** Origin marker color shared by LoS, coverage, and scan. */
export const ORIGIN_COLOR = "#06b6d4";

/** MapLibre circle-color expression: offline → gray, else role color. */
export const mbRoleColorExpr = [
  "case",
  ["!", ["boolean", ["get", "online"], false]],
  OFFLINE_NODE_COLOR,
  ["match", ["get", "role"],
    ...Object.entries(ROLE_COLORS).flatMap(([k, v]) => [Number(k), v]),
    DEFAULT_NODE_COLOR,
  ],
] as any;
