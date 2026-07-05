/**
 * RF parameters per TX class. TX power is a role-based stand-in until per-node
 * owner config exists; `txDbmForRole` is the override point.
 */
import { NodeRole } from "../../../types";
import { effectiveSensitivityDbm, reliabilityPreset } from "../rf/coverageAnalysis";
import type { RasterParams } from "../rf/coverageRaster";
import { CABLE_LOSS_DB, clampRxHeightM, DEFAULT_ITM_ENV, FADE_MARGIN_DB, FREQ_MHZ } from "../rf/itmEnv";
import { DEFAULT_LIVE_PRESET, presetSensitivityDbm } from "./liveCoveragePresets";

/** High-power infrastructure TX (dBm) — Station-G2-class routers/repeaters. */
export const ROUTER_TX_DBM = 33;
/** Conservative client/other TX (dBm). */
export const CLIENT_TX_DBM = 22;

/** Roles on the high-power TX class; everything else gets CLIENT_TX_DBM.
 *  ROUTER_CLIENT (3) is deprecated upstream and deliberately omitted. */
export const ROUTER_CLASS_ROLES: ReadonlySet<NodeRole> = new Set([
  NodeRole.ROUTER,
  NodeRole.ROUTER_LATE,
  NodeRole.REPEATER,
]);

/** Role-default TX power (dBm). Override hook for future per-node owner config. */
export function txDbmForRole(role: NodeRole | undefined): number {
  return role != null && ROUTER_CLASS_ROLES.has(role) ? ROUTER_TX_DBM : CLIENT_TX_DBM;
}

/** TX antenna gain (dBi) — a real omni typical of deployed infrastructure. */
export const LIVE_TX_ANTENNA_DBI = 5.8;
/** RX probe = a stock handheld trying to hear the node. */
export const LIVE_RX_ANTENNA_DBI = 1.5;
/** RX probe antenna height above ground (m). */
export const LIVE_RX_HEIGHT_M = 2;
/** Assumed TX antenna height above ground (m). No per-node AGL is reported, so
 *  this is a single tunable constant approximating masted infrastructure. */
export const LIVE_ANTENNA_AGL_M = 6;

const LIVE_RELIABILITY = reliabilityPreset("typical"); // 90/50/70

/** RasterParams for one TX class on one modem preset. The RX probe matches the
 *  node's own mesh: an SX1262 handheld on that preset (margin is meaningless
 *  across presets — a LongFast node can't be heard by a MediumFast radio).
 *  All classes share env / RX height / reliability; txDbm + sensitivity vary. */
export function buildLiveCoverageParams(
  txDbm: number,
  clutterAggression = 0,
  preset: string = DEFAULT_LIVE_PRESET,
): RasterParams {
  return {
    freqMhz: FREQ_MHZ,
    txDbm,
    txAntennaDbi: LIVE_TX_ANTENNA_DBI,
    rxAntennaDbi: LIVE_RX_ANTENNA_DBI,
    rxAntennaHeightAboveGroundM: clampRxHeightM(LIVE_RX_HEIGHT_M),
    rxSensitivityDbm: effectiveSensitivityDbm(presetSensitivityDbm(preset), "SX1262"),
    fadeMarginDb: FADE_MARGIN_DB,
    cableLossDb: CABLE_LOSS_DB,
    clutterAggression,
    ...DEFAULT_ITM_ENV,
    timePct: LIVE_RELIABILITY.time,
    locationPct: LIVE_RELIABILITY.location,
    situationPct: LIVE_RELIABILITY.situation,
  };
}
