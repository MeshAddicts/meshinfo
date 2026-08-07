import { DrawerNodeSearch } from "./DrawerNodeSearch";

export function FiltersDrawer({
  open,
  onClose,
  clearFilters,
  onlyUnknownEndpoints,
  requireVia,
  urlFrom,
  urlTo,
  urlVia,
  urlHopsMin,
  urlHopsMax,
  nodes,
  setParam,
}: {
  open: boolean;
  onClose: () => void;
  clearFilters: () => void;

  onlyUnknownEndpoints: boolean;
  requireVia: boolean;

  urlFrom: string;
  urlTo: string;
  urlVia: string;

  urlHopsMin: number | undefined;
  urlHopsMax: number | undefined;

  nodes: any;
  setParam: (key: string, value?: string, mode?: "replace" | "push") => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="Close filters"
      />

      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 shadow-xl">
        <div className="h-full flex flex-col">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Advanced filters
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-xs underline hover:no-underline text-gray-600 dark:text-gray-300"
                onClick={clearFilters}
              >
                clear all
              </button>

              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>

          <div className="p-4 overflow-y-auto space-y-5">
            <div className="space-y-4">
              <DrawerNodeSearch
                label="From"
                paramKey="from"
                currentValue={urlFrom}
                placeholder="Type 2+ chars to filter sender…"
                nodes={nodes}
                setParam={setParam}
              />
              <DrawerNodeSearch
                label="To"
                paramKey="to"
                currentValue={urlTo}
                placeholder="Type 2+ chars to filter recipient…"
                allowAll
                nodes={nodes}
                setParam={setParam}
              />
              <DrawerNodeSearch
                label="Via contains"
                paramKey="via"
                currentValue={urlVia}
                placeholder="Type 2+ chars to require a specific via…"
                nodes={nodes}
                setParam={setParam}
              />
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Hops range
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Min
                  </div>
                  <select
                    value={typeof urlHopsMin === "number" ? String(urlHopsMin) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setParam("hmin", v || undefined, "push");
                    }}
                    className="mt-1 w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                  >
                    <option value="">any</option>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <option key={`hmin-${n}`} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Max
                  </div>
                  <select
                    value={typeof urlHopsMax === "number" ? String(urlHopsMax) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setParam("hmax", v || undefined, "push");
                    }}
                    className="mt-1 w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                  >
                    <option value="">any</option>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <option key={`hmax-${n}`} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Tip: set both min & max for an exact hop count.
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-3">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Flags
              </div>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-800 dark:text-gray-200">
                  Only unknown endpoints
                </span>
                <input
                  type="checkbox"
                  checked={onlyUnknownEndpoints}
                  onChange={(e) =>
                    setParam("unk", e.target.checked ? "1" : undefined, "push")
                  }
                />
              </label>

              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-800 dark:text-gray-200">
                  Require via (sender list present)
                </span>
                <input
                  type="checkbox"
                  checked={requireVia}
                  onChange={(e) =>
                    setParam("hv", e.target.checked ? "1" : undefined, "push")
                  }
                />
              </label>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Keyboard: <b>/</b> focus search, <b>Esc</b> close filters/details/export.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
