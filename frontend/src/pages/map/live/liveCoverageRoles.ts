/** Role + tuning constants for live coverage. ROUTER_CLIENT (3) is deprecated, omitted. */
import { NodeRole } from "../../../types";

/** All offerable roles (display order). */
export const ALL_COVERAGE_ROLES: NodeRole[] = [
  NodeRole.ROUTER,
  NodeRole.ROUTER_LATE,
  NodeRole.REPEATER,
  NodeRole.CLIENT,
  NodeRole.CLIENT_MUTE,
  NodeRole.CLIENT_HIDDEN,
  NodeRole.CLIENT_BASE,
  NodeRole.TRACKER,
  NodeRole.SENSOR,
  NodeRole.TAK,
  NodeRole.TAK_TRACKER,
  NodeRole.LOST_AND_FOUND,
];

/** On by default: dedicated infrastructure only. Everything else is opt-in. */
export const DEFAULT_COVERAGE_ROLES: NodeRole[] = [
  NodeRole.ROUTER,
  NodeRole.ROUTER_LATE,
  NodeRole.REPEATER,
];

/** Roles on the high-power TX class (33 dBm); everything else is 22 dBm. */
export const ROUTER_CLASS_ROLES: ReadonlySet<NodeRole> = new Set([
  NodeRole.ROUTER,
  NodeRole.ROUTER_LATE,
  NodeRole.REPEATER,
]);

/** Contributes if heard within this window. */
export const LIVE_COVERAGE_RECENCY_MS = 4 * 60 * 60 * 1000;

/** Hard cap on origins per build (per-pixel cost is O(N)). */
export const LIVE_COVERAGE_MAX_ORIGINS = 24;

/** Drop origins farther than this from the set centroid (keeps the bbox sane). */
export const LIVE_COVERAGE_MAX_SPAN_KM = 200;

/** Coalesce a burst of node updates into one rebuild this long after they settle. */
export const LIVE_COVERAGE_DEBOUNCE_MS = 4000;

/** Never rebuild more often than this once a surface exists (survey builds are heavy). */
export const LIVE_COVERAGE_MIN_RECOMPUTE_MS = 2 * 60 * 1000;

/** UI grouping for the role popover. */
export interface CoverageRoleGroup {
  label: string;
  roles: NodeRole[];
}
export const COVERAGE_ROLE_GROUPS: CoverageRoleGroup[] = [
  { label: "Infrastructure", roles: [NodeRole.ROUTER, NodeRole.ROUTER_LATE, NodeRole.REPEATER] },
  { label: "Clients", roles: [NodeRole.CLIENT, NodeRole.CLIENT_MUTE, NodeRole.CLIENT_HIDDEN, NodeRole.CLIENT_BASE] },
  { label: "Other", roles: [NodeRole.TRACKER, NodeRole.SENSOR, NodeRole.TAK, NodeRole.TAK_TRACKER, NodeRole.LOST_AND_FOUND] },
];
