/** Shared live/paused toggle pill used in page top bars (Logs, Telemetry). */
export function LivePill({
  live,
  onToggle,
  title,
}: {
  live: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border text-[11px] font-medium transition",
        live
          ? "border-emerald-500/60 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10"
          : "border-gray-300/60 dark:border-gray-700 text-gray-500 dark:text-gray-400",
      ].join(" ")}
    >
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          live ? "bg-emerald-500 animate-pulse" : "bg-gray-400",
        ].join(" ")}
      />
      {live ? "Live" : "Paused"}
    </button>
  );
}
