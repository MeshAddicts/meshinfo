/** ?cov= deep link for the live-coverage overlay: on/off plus which preset
 * group is shown. Reads accept 1/0/true/false (legacy on/off with the
 * viewer's own group), "all", a preset short code (mf, lf, vls, …), a full
 * preset id in any case, or — forward-compat for groups we don't know yet —
 * any other string, which passes through as a raw group id (Map.tsx
 * validates it against the server's baked groups and falls back to "all").
 * Writes emit "0" when off and the group's short code ("all" for All) when
 * on, so a shared link reproduces the preset filter too. Pure string
 * helpers so the URL semantics stay unit-testable apart from Map.tsx. */

import {
  LIVE_PRESET_SENSITIVITY_DBM,
  presetShortLabel,
} from "./liveCoveragePresets";

export const COVERAGE_URL_PARAM = "cov";

export type CoverageParam = {
  enabled: boolean;
  /** Canonical preset id, "all", a raw passthrough group, or null when the
   * link doesn't say (legacy cov=1 keeps the viewer's own group). */
  group: string | null;
};

/** "mf"/"mediumfast" → "MediumFast" — every preset in the RX profile table
 * gets a code, so new presets are deeplinkable the day they're added there. */
const GROUP_BY_TOKEN: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const id of Object.keys(LIVE_PRESET_SENSITIVITY_DBM)) {
    m.set(presetShortLabel(id).toLowerCase(), id);
    m.set(id.toLowerCase(), id);
  }
  return m;
})();

/** The URL spelling for a group: "all", a known preset's short code, or the
 * raw id for groups the preset table doesn't know. */
export function coverageGroupCode(group: string): string {
  if (group === "all") return "all";
  return group in LIVE_PRESET_SENSITIVITY_DBM
    ? presetShortLabel(group).toLowerCase()
    : group;
}

/** Tri-state read: null when the URL doesn't mention the overlay. */
export function parseCoverageParam(search: string): CoverageParam | null {
  const v = new URLSearchParams(search).get(COVERAGE_URL_PARAM);
  if (v === null || v === "") return null;
  const t = v.toLowerCase();
  if (t === "0" || t === "false") return { enabled: false, group: null };
  if (t === "1" || t === "true") return { enabled: true, group: null };
  if (t === "all") return { enabled: true, group: "all" };
  return { enabled: true, group: GROUP_BY_TOKEN.get(t) ?? v };
}

/** Next query string reflecting the overlay state, or null when no write is
 * needed. Pristine URLs stay untouched while the overlay is off — cov only
 * appears once the overlay has been on, so bare /map links never grow a
 * cov=0. An explicit cov=0 matters when present: the viewer's saved
 * preference may be "on", and a shared link must reproduce the sharer's
 * view either way. */
export function nextCoverageSearch(
  search: string,
  enabled: boolean,
  group: string,
): string | null {
  const sp = new URLSearchParams(search);
  const cur = sp.get(COVERAGE_URL_PARAM);
  const want = enabled ? coverageGroupCode(group) : "0";
  if (cur === want) return null;
  if (cur === null && !enabled) return null;
  sp.set(COVERAGE_URL_PARAM, want);
  return sp.toString();
}
