import type { ExpressionSpecification } from "maplibre-gl";

import { NodeRole } from "./types";

/** Node-role → color. Used only where the role is named next to the swatch:
 *  role badges, the role filter menu, graph views. The map does not color
 *  individual nodes by role — see {@link nodeColor}. */
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

/** Router-family roles keep their blue on the map; every other role renders as
 *  a plain online node, so gray means offline and nothing else. */
export const MAP_ROUTER_COLORS: Record<number, string> = {
  [NodeRole.ROUTER]: ROLE_COLORS[NodeRole.ROUTER],
  [NodeRole.ROUTER_CLIENT]: ROLE_COLORS[NodeRole.ROUTER_CLIENT],
  [NodeRole.ROUTER_LATE]: ROLE_COLORS[NodeRole.ROUTER_LATE],
};

/** Map node fill: offline → gray, online router → blue, online → green. */
export function nodeColor(role: number | null | undefined, online: boolean): string {
  if (!online) return OFFLINE_NODE_COLOR;
  return (role != null && MAP_ROUTER_COLORS[role]) || DEFAULT_NODE_COLOR;
}

/** MapLibre form of {@link nodeColor}. */
export const mbNodeColorExpr = [
  "case",
  ["!", ["boolean", ["get", "online"], false]],
  OFFLINE_NODE_COLOR,
  ["match", ["get", "role"],
    ...Object.entries(MAP_ROUTER_COLORS).flatMap(([k, v]) => [Number(k), v]),
    DEFAULT_NODE_COLOR,
  ],
] as unknown as ExpressionSpecification;
