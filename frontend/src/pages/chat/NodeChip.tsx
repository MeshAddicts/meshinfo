import { Link } from "react-router-dom";

export function NodeChip({
  nodeId,
  nodes,
  fallback,
  onFocus,
  titlePrefix,
  compact,
  stopPropagation,
}: {
  nodeId: string;
  nodes: any;
  fallback?: string;
  onFocus?: (id: string) => void;
  titlePrefix?: string;
  compact?: boolean;
  stopPropagation?: boolean;
}) {
  const n = nodes?.[nodeId];
  const short = n?.shortname ?? fallback ?? "UNK";
  const long = n?.longname ?? "Unknown";
  const title = `${titlePrefix ? `${titlePrefix}: ` : ""}${nodeId} / ${long}`;

  const base =
    "inline-flex items-center rounded-md font-medium border border-transparent hover:border-gray-300/40 dark:hover:border-gray-600/40 transition";
  const pad = compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  const bg =
    "bg-gray-200/60 dark:bg-gray-700/50 text-gray-900 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700";

  return (
    <span className="inline-flex items-center gap-1">
      {nodeId && nodeId !== "ffffffff" ? (
        <Link
          to={`/nodes/${nodeId}`}
          className={`${base} ${pad} ${bg}`}
          title={title}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
          }}
        >
          {short}
        </Link>
      ) : (
        <span
          className={`${base} ${pad} bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300`}
          title={title}
        >
          {short}
        </span>
      )}

      {onFocus && nodeId && nodeId !== "ffffffff" ? (
        <button
          type="button"
          className="rounded-md px-2 py-0.5 text-[11px] font-semibold border border-gray-300/60 dark:border-gray-600/60 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
          onClick={(e) => {
            e.stopPropagation();
            onFocus(nodeId);
          }}
          title="Focus this node"
        >
          ⊙
        </button>
      ) : null}
    </span>
  );
}
