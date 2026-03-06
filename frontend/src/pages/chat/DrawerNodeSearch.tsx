import { useDeferredValue, useMemo, useState } from "react";

import { isBroadcast } from "./chatUtils";

export function DrawerNodeSearch({
  label,
  paramKey,
  currentValue,
  placeholder,
  allowAll,
  nodes,
  setParam,
}: {
  label: string;
  paramKey: string;
  currentValue: string;
  placeholder: string;
  allowAll?: boolean;
  nodes: any;
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
}) {
  const [q, setQ] = useState("");
  const qDef = useDeferredValue(q);

  const matches = useMemo(() => {
    const s = qDef.trim().toLowerCase();
    if (s.length < 2) return [];
    const all = Object.entries(nodes as any).map(([id, n]: any) => ({
      id: String(id),
      short: String(n?.shortname ?? ""),
      long: String(n?.longname ?? ""),
    }));
    return all
      .filter((x) => (`${x.id} ${x.short} ${x.long}`).toLowerCase().includes(s))
      .slice(0, 10);
  }, [nodes, qDef]);

  const setValue = (v?: string) => {
    setParam(paramKey, v, "push");
    setQ("");
  };

  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>

      <div className="mt-1 flex items-center gap-2">
        {currentValue ? (
          <span className="inline-flex items-center gap-2 rounded-md border border-gray-200 dark:border-gray-800 px-2 py-1 text-sm">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {allowAll && isBroadcast(currentValue)
                ? "ALL"
                : (nodes as any)[currentValue]?.shortname ?? "UNK"}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {currentValue}
            </span>
            <button
              type="button"
              className="text-xs underline hover:no-underline"
              onClick={() => setValue(undefined)}
            >
              clear
            </button>
          </span>
        ) : (
          <span className="text-xs text-gray-500 dark:text-gray-400">none</span>
        )}
      </div>

      <div className="mt-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        />
      </div>

      {allowAll ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            onClick={() => setValue("ffffffff")}
          >
            Set to ALL
          </button>
        </div>
      ) : null}

      {matches.length > 0 ? (
        <div className="mt-2 rounded-md border border-gray-200 dark:border-gray-800 overflow-hidden">
          <ul className="divide-y divide-gray-200 dark:divide-gray-800 max-h-56 overflow-y-auto">
            {matches.map((m) => (
              <li
                key={`drawer-${paramKey}-${m.id}`}
                className="px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-900/30 cursor-pointer"
                onClick={() => setValue(m.id)}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-gray-900 dark:text-gray-100 font-medium">
                    {m.short || "UNK"}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                    {m.id}
                  </div>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {m.long || "Unknown"}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
