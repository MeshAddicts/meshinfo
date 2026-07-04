/** Shared ITM env + link-budget constants so coverage, scan, and LoS can't drift.
 *  Continental Temperate + N=301 is the North-American Meshtastic default. */
import { Climate, Polarization } from "./itm";

export const DEFAULT_ITM_ENV = {
  climate: Climate.ContinentalTemperate,
  surfaceRefractivityN: 301,
  polarization: Polarization.Vertical,
  groundDielectric: 15,
  groundConductivity: 0.005,
} as const;

export const FREQ_MHZ = 915;
export const FADE_MARGIN_DB = 15;
export const CABLE_LOSS_DB = 0.5;

/** ITM RX antenna height bounds (m AGL). */
export const RX_HEIGHT_CLAMP = { min: 0.5, max: 3000 } as const;
export function clampRxHeightM(m: number): number {
  return Math.max(RX_HEIGHT_CLAMP.min, Math.min(RX_HEIGHT_CLAMP.max, m));
}
