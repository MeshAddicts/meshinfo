/**
 * The channel pill bar — one presentational component for Chat/Nodes/Log so
 * grouping, headers, and pill styling can't drift between pages. Auto-mode
 * pills carry a group and render as labeled rows (presets, then custom);
 * ungrouped pills (manual mode) collapse to a single unlabeled row.
 */

export interface ChannelPill {
  key: string;
  label: string;
  /** Badge value; omit to render a label-only pill (Log has no per-pill counts). */
  count?: number;
  active: boolean;
  group?: "presets" | "custom";
  tooltip?: string;
  onClick: () => void;
}

const GROUP_LABELS: Record<string, string> = {
  presets: "Modem presets",
  custom: "Custom channels",
};

function Pill({ pill }: { pill: ChannelPill }) {
  return (
    <button
      type="button"
      className={[
        "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
        pill.active
          ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
          : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
      ].join(" ")}
      onClick={pill.onClick}
      title={pill.tooltip}
    >
      {pill.label}
      {pill.count != null && (
        <span
          className={[
            "ml-2 rounded-full px-2 py-0.5 text-xs",
            pill.active
              ? "bg-white/20 text-white"
              : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200",
          ].join(" ")}
        >
          {pill.count}
        </span>
      )}
    </button>
  );
}

export function ChannelPillGroups({
  pills,
  leading,
}: {
  pills: ChannelPill[];
  /** Rendered at the head of the first row, outside grouping (the All pill). */
  leading?: ChannelPill;
}) {
  // Consecutive runs of the same group; pills arrive pre-ordered by the model.
  const groups: Array<{ key: string; items: ChannelPill[] }> = [];
  for (const p of pills) {
    const key = p.group ?? "all";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(p);
    else groups.push({ key, items: [p] });
  }
  if (groups.length === 0 && leading) groups.push({ key: "all", items: [] });

  return (
    <>
      {groups.map((grp, gi) => (
        <div key={`grp-${grp.key}`}>
          {groups.length > 1 && GROUP_LABELS[grp.key] && (
            <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {GROUP_LABELS[grp.key]}
            </div>
          )}
          <div
            className={[
              groups.length > 1 ? "mt-1" : "mt-3",
              "flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]",
            ].join(" ")}
          >
            {gi === 0 && leading && <Pill pill={leading} />}
            {grp.items.map((p) => (
              <Pill key={`pill-${p.key}`} pill={p} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
