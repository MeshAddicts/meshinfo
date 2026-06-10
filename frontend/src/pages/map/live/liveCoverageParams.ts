/**
 * RF parameters per TX class. TX power is a role-based stand-in until per-node
 * owner config exists; `txDbmForRole` is the override point.
 */
import { NodeRole } from "../../../types";
import { effectiveSensitivityDbm, MESHTASTIC_PRESETS, reliabilityPreset } from "../coverageAnalysis";
import type { RasterParams } from "../coverageRaster";
import { CABLE_LOSS_DB, clampRxHeightM, DEFAULT_ITM_ENV, FADE_MARGIN_DB, FREQ_MHZ } from "../itmEnv";
import { ROUTER_CLASS_ROLES } from "./liveCoverageRoles";

/** High-power infrastructure TX (dBm) — Station-G2-class routers/repeaters. */
export const ROUTER_TX_DBM = 33;
/** Conservative client/other TX (dBm). */
export const CLIENT_TX_DBM = 22;

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

const MEDIUM_FAST = MESHTASTIC_PRESETS[0]; // MediumFast (-124 dBm typical)
const LIVE_RELIABILITY = reliabilityPreset("typical"); // 90/50/70

/** RasterParams for one TX class. All classes share env / RX / sensitivity /
 *  reliability; only `txDbm` differs. `clutterAggression` 0 = clutter model off. */
export function buildLiveCoverageParams(txDbm: number, clutterAggression = 0): RasterParams {
  return {
    freqMhz: FREQ_MHZ,
    txDbm,
    txAntennaDbi: LIVE_TX_ANTENNA_DBI,
    rxAntennaDbi: LIVE_RX_ANTENNA_DBI,
    rxAntennaHeightAboveGroundM: clampRxHeightM(LIVE_RX_HEIGHT_M),
    rxSensitivityDbm: effectiveSensitivityDbm(MEDIUM_FAST.sensitivityDbm, "SX1262"),
    fadeMarginDb: FADE_MARGIN_DB,
    cableLossDb: CABLE_LOSS_DB,
    clutterAggression,
    ...DEFAULT_ITM_ENV,
    timePct: LIVE_RELIABILITY.time,
    locationPct: LIVE_RELIABILITY.location,
    situationPct: LIVE_RELIABILITY.situation,
  };
}

/** Free-space link-budget reach (km), clamped [5, 200] like the tool's bbox sizer. */
export function liveCoverageReachKm(txDbm: number): number {
  const p = buildLiveCoverageParams(txDbm);
  const budget =
    p.txDbm + p.txAntennaDbi + p.rxAntennaDbi - p.rxSensitivityDbm - p.fadeMarginDb - p.cableLossDb;
  const plConstant = 32.45 + 20 * Math.log10(FREQ_MHZ);
  const maxKm = Math.pow(10, (budget - plConstant) / 20);
  return Math.max(5, Math.min(200, Math.round(maxKm)));
}
