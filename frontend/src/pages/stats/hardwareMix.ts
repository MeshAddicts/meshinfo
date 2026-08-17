import { hardwareLabel } from "../nodes/nodesUtils";

/** Bars shown before the remainder collapses into "Other". */
export const HARDWARE_TOP_N = 8;

export type HardwareSlice = {
  name: string;
  count: number;
};

/**
 * Keys are stringified HardwareModel enum ids ("9", "43", ...): resolve to a
 * readable name, merge same-label keys, sort commonest-first. Unfolded.
 */
export function hardwareSlicesFrom(
  byHardware: Record<string, number> | undefined
): HardwareSlice[] {
  const counts = new Map<string, number>();
  for (const [key, raw] of Object.entries(byHardware ?? {})) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const trimmed = String(key).trim();
    // Only plain decimal keys resolve via the enum — Number() alone would also
    // accept hex/exponent notation and misattribute junk to real models.
    const id = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (id === 0) continue; // UNSET — not a reported model
    const name = Number.isFinite(id)
      ? hardwareLabel(id)
      : trimmed.slice(0, 24) || "Unknown";
    counts.set(name, (counts.get(name) ?? 0) + n);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

/** Keep the top N slices and fold the rest into "Other". */
export function foldHardwareSlices(
  slices: HardwareSlice[],
  topN: number = HARDWARE_TOP_N
): HardwareSlice[] {
  if (slices.length <= topN) return slices;
  const kept = slices.slice(0, topN);
  const other = slices.slice(topN).reduce((acc, s) => acc + s.count, 0);
  if (other > 0) kept.push({ name: "Other", count: other });
  return kept;
}
