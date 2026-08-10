export function formatTimestamp(
  timestamp?: number | null,
  options?: Intl.DateTimeFormatOptions
): string {
  if (timestamp == null || Number.isNaN(timestamp)) {
    return "";
  }

  // Heuristic: < 1e12 → seconds, otherwise assume ms
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;

  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...options,
  });
}
