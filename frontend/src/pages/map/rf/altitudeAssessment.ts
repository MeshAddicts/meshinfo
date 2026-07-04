/** Pure altitude-assessment logic (no network/DOM deps), unit-testable in isolation. */

export interface GroundSample {
  /** Min/max/center terrain elevation (m) around the node. The spread absorbs DEM
   *  under-read on peaks/ridges and small position error before the altitude check. */
  min: number;
  max: number;
  center: number;
}

/** Meshtastic Position.AltSource / LocSource enum values we act on. */
export const ALT_SOURCE = { MANUAL: 1, BAROMETRIC: 4 } as const;
export const LOC_SOURCE = { MANUAL: 1 } as const;

/** Altitude-relevant subset of a node position (snake_case matches the API/protobuf). */
export interface AltitudeInput {
  altitude?: number | null;
  altitude_hae?: number | null;
  altitude_geoidal_separation?: number | null;
  altitude_source?: number | null;
  location_source?: number | null;
  precision_bits?: number | null;
}

export interface AltitudeAssessment {
  /** Effective MSL altitude (HAE-normalized) used for the assessment + display. */
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
/** Barometric altimeters drift; widen both tolerances when the source is barometric. */
const BAROMETRIC_EXTRA_M = 60;
/** Above this horizontal uncertainty the terrain check is meaningless — the broadcast
 *  position can be kilometres from the node, so its terrain isn't the node's terrain. */
export const MAX_VALIDATABLE_UNCERTAINTY_M = 150;

/** Meshtastic truncates lat/lng to the top `precisionBits` of the int32 (deg×1e7);
 *  this returns the resulting half-step horizontal error in meters. 0 = full/unknown precision. */
export function positionUncertaintyM(precisionBits?: number | null): number {
  if (precisionBits == null || precisionBits <= 0 || precisionBits >= 32) return 0;
  return 2 ** (31 - precisionBits) * 0.011132;
}

/** Best-effort MSL altitude (m). Uses `altitude` (MSL per spec) when present; otherwise falls
 *  back to a node that reports HAE, converting via MSL = HAE − geoidal_separation. */
export function effectiveAltitudeMslM(pos: AltitudeInput | null | undefined): number | null {
  if (!pos) return null;
  const msl = pos.altitude;
  if (typeof msl === "number" && Number.isFinite(msl)) return msl;
  const hae = pos.altitude_hae;
  if (typeof hae === "number" && Number.isFinite(hae)) {
    const geoid = pos.altitude_geoidal_separation;
    return typeof geoid === "number" && Number.isFinite(geoid) ? hae - geoid : hae;
  }
  return null;
}

export function classifyAltitude(
  pos: AltitudeInput | null | undefined,
  ground: GroundSample | null,
): AltitudeAssessment {
  const r = effectiveAltitudeMslM(pos);
  const groundM = ground?.center ?? null;
  const fine: AltitudeAssessment = { reportedM: r, groundM, severity: null, suspectReason: null };

  if (r == null) return fine;

  if (pos?.altitude != null && Math.round(pos.altitude) === ALT_SENTINEL) {
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
  if (positionUncertaintyM(pos?.precision_bits) > MAX_VALIDATABLE_UNCERTAINTY_M) return fine;

  if (ground != null) {
    const manual =
      pos?.location_source === LOC_SOURCE.MANUAL || pos?.altitude_source === ALT_SOURCE.MANUAL;
    const slack = pos?.altitude_source === ALT_SOURCE.BAROMETRIC ? BAROMETRIC_EXTRA_M : 0;
    const subject = manual ? "Manually-set altitude" : "Reported altitude";

    if (r < ground.min - (BELOW_TERRAIN_M + slack)) {
      return {
        reportedM: r,
        groundM,
        severity: "bad",
        suspectReason: `${subject}: ${r.toFixed(0)} m, ${(ground.min - r).toFixed(0)} m below terrain (${ground.min.toFixed(0)} m).`,
      };
    }
    if (r > ground.max + (ABOVE_TERRAIN_M + slack)) {
      return {
        reportedM: r,
        groundM,
        severity: "info",
        suspectReason: `${subject}: ${r.toFixed(0)} m, ${(r - ground.max).toFixed(0)} m above terrain (${ground.max.toFixed(0)} m). Tall tower, aircraft, or datum offset.`,
      };
    }
  }

  return fine;
}
