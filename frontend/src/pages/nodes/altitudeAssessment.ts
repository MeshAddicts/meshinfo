/** Pure altitude-assessment logic (no network/DOM deps), unit-testable in isolation. */

export interface GroundSample {
  /** Min/max/center terrain elevation (m) around the node. The spread absorbs DEM
   *  under-read on peaks/ridges and small position error before the altitude check. */
  min: number;
  max: number;
  center: number;
}

export interface AltitudeAssessment {
  reportedM: number | null;
  groundM: number | null;
  /** "bad" = likely-wrong reading (amber), "info" = plausible but notable (neutral), null = looks fine. */
  severity: "bad" | "info" | null;
  /** Human-readable explanation of the flag, or null when the reading looks fine. */
  suspectReason: string | null;
}

const ALT_SENTINEL = 65535;
/** Absolute plausibility bounds (m); lower bound matches the DEM decode's clamp. */
const HARD_MIN_M = -500;
const HARD_MAX_M = 50_000;
/** Reported this far below local terrain ⇒ bad GPS/datum. */
const BELOW_TERRAIN_M = 50;
/** Reported this far above local terrain ⇒ notable (tall tower, aircraft, datum offset), not necessarily wrong. */
const ABOVE_TERRAIN_M = 120;
/** Above this horizontal uncertainty the terrain check is meaningless — the broadcast
 *  position can be kilometres from the node, so its terrain isn't the node's terrain. */
export const MAX_VALIDATABLE_UNCERTAINTY_M = 150;

/** Meshtastic truncates lat/lng to the top `precisionBits` of the int32 (deg×1e7);
 *  this returns the resulting half-step horizontal error in meters. 0 = full/unknown precision. */
export function positionUncertaintyM(precisionBits?: number | null): number {
  if (precisionBits == null || precisionBits <= 0 || precisionBits >= 32) return 0;
  return 2 ** (31 - precisionBits) * 0.011132;
}

export function classifyAltitude(
  reported: number | null | undefined,
  ground: GroundSample | null,
  precisionBits?: number | null,
): AltitudeAssessment {
  const r =
    typeof reported === "number" && Number.isFinite(reported) ? reported : null;
  const groundM = ground?.center ?? null;
  const fine: AltitudeAssessment = { reportedM: r, groundM, severity: null, suspectReason: null };

  if (r == null) return fine;

  if (Math.round(r) === ALT_SENTINEL) {
    return {
      reportedM: r,
      groundM,
      severity: "bad",
      suspectReason: "Reports 65535 m — firmware sentinel for missing altitude.",
    };
  }

  if (r < HARD_MIN_M || r > HARD_MAX_M) {
    return {
      reportedM: r,
      groundM,
      severity: "bad",
      suspectReason: `Reports ${r.toFixed(0)} m — outside any plausible altitude.`,
    };
  }

  // Privacy-truncated positions land up to kilometres off; terrain here isn't the node's terrain.
  if (positionUncertaintyM(precisionBits) > MAX_VALIDATABLE_UNCERTAINTY_M) return fine;

  if (ground != null) {
    if (r < ground.min - BELOW_TERRAIN_M) {
      return {
        reportedM: r,
        groundM,
        severity: "bad",
        suspectReason: `Reports ${r.toFixed(0)} m — ${(ground.min - r).toFixed(0)} m below terrain (${ground.min.toFixed(0)} m).`,
      };
    }
    if (r > ground.max + ABOVE_TERRAIN_M) {
      return {
        reportedM: r,
        groundM,
        severity: "info",
        suspectReason: `Reports ${r.toFixed(0)} m — ${(r - ground.max).toFixed(0)} m above terrain (${ground.max.toFixed(0)} m). Tall tower, aircraft, or HAE-vs-MSL offset.`,
      };
    }
  }

  return fine;
}
