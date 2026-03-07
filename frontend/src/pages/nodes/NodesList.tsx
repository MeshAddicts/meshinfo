import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { Avatar } from "../../components/Avatar";
import { DateToSince } from "../../components/DateSince";
import { HardwareImg } from "../../components/HardwareImg";
import { HardwareModel, INode } from "../../types";
import { getTelemetrySnapshot, roleLabel } from "./nodesUtils";

export type NodeListItem = {
  id: string; // cleaned (no leading "!")
  rawId: string; // original (might include "!")
  node: INode;
  online: boolean;
  lastSeenMs: number | null;
  hasPosition: boolean;
  dxKm: number | null;
  batteryPct: number | null;
  voltage: number | null;
  airTx: number | null;
  chanUtil: number | null;
  role: any;
  hardware: any;
};

function pillClass(active: boolean) {
  return [
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border",
    active
      ? "bg-emerald-600 text-white border-emerald-600"
      : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
  ].join(" ");
}

export function NodesList({
  items,
  selectedId,
  onSelect,
  totalSeen,
  virtuosoRef,
}: {
  items: NodeListItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  totalSeen: number;
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}) {
  // Keep the “Seen X sec” counters smooth without re-rendering the entire page.
  const [currentDate, setCurrentDate] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setCurrentDate(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
        <div className="text-sm text-gray-800 dark:text-gray-200">
          <span className="font-semibold">{items.length}</span> shown{" "}
          <span className="text-gray-500 dark:text-gray-400">
            (out of {totalSeen} seen)
          </span>
        </div>

        <div className="text-xs text-gray-500 dark:text-gray-400">
          Tip: click a row to pin details
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Virtuoso
          ref={(r) => {
            // react-virtuoso uses callback refs; we store into provided ref
            (virtuosoRef as any).current = r;
          }}
          style={{ flex: 1, minHeight: 0, height: "100%" }}
          data={items}
          computeItemKey={(_index, item) => item.id}
          overscan={600}
          itemContent={(_index, item) => {
            const n: any = item.node as any;
            const telem = getTelemetrySnapshot(item.node);

            const short = String(n?.shortname ?? "UNK");
            const long = String(n?.longname ?? "");
            const role = n?.role;
            const hw = n?.hardware;

            const isSelected = !!selectedId && item.id === selectedId;

            return (
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={[
                  "w-full text-left px-4 py-3 border-b border-gray-200 dark:border-gray-800 transition",
                  "hover:bg-gray-50/70 dark:hover:bg-gray-900/40",
                  isSelected
                    ? "bg-indigo-50/50 dark:bg-indigo-900/15"
                    : "bg-transparent",
                ].join(" ")}
              >
                <div className="flex items-center gap-3">
                  <div className="shrink-0">
                    <Avatar id={item.id} size={10} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                        {short}
                      </div>

                      <span className={pillClass(item.online)}>
                        {item.online ? "Online" : "Offline"}
                      </span>

                      {typeof role === "number" ? (
                        <span className="hidden sm:inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200">
                          {roleLabel(role)}
                        </span>
                      ) : null}

                      <div className="ml-auto hidden sm:flex items-center gap-2">
                        {typeof telem.batteryPct === "number" ? (
                          <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                            🔋 {Math.round(telem.batteryPct)}%
                          </span>
                        ) : null}
                        {typeof telem.voltage === "number" ? (
                          <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                            ⚡ {telem.voltage.toFixed(2)}V
                          </span>
                        ) : null}
                        {item.dxKm != null ? (
                          <span className="text-xs text-gray-600 dark:text-gray-400 tabular-nums">
                            📡 {item.dxKm.toFixed(1)} km
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-1 flex items-center gap-2 min-w-0">
                      <div className="text-sm text-gray-600 dark:text-gray-400 truncate">
                        {long || <span className="opacity-60">no longname</span>}
                      </div>

                      {hw != null && HardwareModel[hw] ? (
                        <span className="ml-auto hidden md:inline-flex items-center">
                          <HardwareImg model={hw} />
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2 flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
                      <span className="tabular-nums">
                        Seen{" "}
                        <DateToSince
                          date={(n as any)?.last_seen}
                          currentDate={currentDate}
                        />
                      </span>

                      {item.hasPosition ? (
                        <span className="opacity-80">📍 has position</span>
                      ) : (
                        <span className="opacity-50">no position</span>
                      )}

                      {/* quick open link (does not steal selection click) */}
                      <span className="ml-auto">
                        <Link
                          to={`/nodes/${item.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="underline hover:no-underline text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                          title="Open the dedicated node page"
                        >
                          open
                        </Link>
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}
