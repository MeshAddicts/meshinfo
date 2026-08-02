/** ?cov=1|0 deep link for the live-coverage overlay. Reads accept 1/0 and
 * true/false; writes always emit "1"/"0". Pure string helpers so the URL
 * semantics stay unit-testable apart from Map.tsx. */

export const COVERAGE_URL_PARAM = "cov";

/** Tri-state read: null when the URL doesn't mention the overlay. */
export function parseCoverageParam(search: string): boolean | null {
  const v = new URLSearchParams(search).get(COVERAGE_URL_PARAM);
  if (v === null) return null;
  return v === "1" || v.toLowerCase() === "true";
}

/** Next query string reflecting `enabled`, or null when no write is needed.
 * Pristine URLs stay untouched while the overlay is off — cov only appears
 * once the overlay has been on, so bare /map links never grow a cov=0. An
 * explicit cov=0 matters when present: the viewer's saved preference may be
 * "on", and a shared link must reproduce the sharer's view either way. */
export function nextCoverageSearch(search: string, enabled: boolean): string | null {
  const sp = new URLSearchParams(search);
  const cur = sp.get(COVERAGE_URL_PARAM);
  const want = enabled ? "1" : "0";
  if (cur === want) return null;
  if (cur === null && !enabled) return null;
  sp.set(COVERAGE_URL_PARAM, want);
  return sp.toString();
}
