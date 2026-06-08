export type LiveMode = "live" | "paused" | "off";

/**
 * Shared live-status pill used in page top bars (Logs, Telemetry, Nodes, Chat).
 *  - live:   stream is flowing (green, pulsing dot)
 *  - paused: stream held — scrolled away or a row/selection pinned (amber)
 *  - off:    live toggled off (gray)
 * Clicking toggles the page's live flag.
 */
export function LivePill({
  mode,
  onToggle,
  title,
}: {
  mode: LiveMode;
  onToggle: () => void;
  title?: string;
}) {
  const label = mode === "live" ? "Live" : mode === "off" ? "Off" : "Paused";
  const tone =
    mode === "live"
      ? "border-emerald-500/60 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10"
      : mode === "paused"
        ? "border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-500/10"
        : "border-gray-300/60 dark:border-gray-700 text-gray-500 dark:text-gray-400";
  const dot =
    mode === "live"
      ? "bg-emerald-500 animate-pulse"
      : mode === "paused"
        ? "bg-amber-500"
        : "bg-gray-400";

  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border text-[11px] font-medium transition",
        tone,
      ].join(" ")}
    >
      <span className={["h-1.5 w-1.5 rounded-full", dot].join(" ")} />
      {label}
    </button>
  );
}
