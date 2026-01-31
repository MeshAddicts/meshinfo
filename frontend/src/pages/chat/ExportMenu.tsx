import { RefObject } from "react";

export function ExportMenu({
  open,
  setOpen,
  exportRowsCount,
  doExportCsv,
  doExportJson,
  exportMenuRef,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  exportRowsCount: number;
  doExportCsv: () => void;
  doExportJson: () => void;
  exportMenuRef: RefObject<HTMLDivElement>;
}) {
  return (
    <div className="relative" ref={exportMenuRef}>
      <button
        type="button"
        className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
        onClick={() => setOpen(!open)}
        title="Export the current view (filters applied)"
      >
        Export
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-56 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-30">
          <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
            Exporting{" "}
            <span className="font-medium">{exportRowsCount.toLocaleString()}</span>{" "}
            row(s)
          </div>

          <button
            type="button"
            disabled={exportRowsCount === 0}
            className={[
              "w-full text-left px-3 py-2 text-sm",
              exportRowsCount === 0
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-gray-50 dark:hover:bg-gray-800/40",
            ].join(" ")}
            onClick={doExportCsv}
          >
            Download CSV
          </button>

          <button
            type="button"
            disabled={exportRowsCount === 0}
            className={[
              "w-full text-left px-3 py-2 text-sm",
              exportRowsCount === 0
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-gray-50 dark:hover:bg-gray-800/40",
            ].join(" ")}
            onClick={doExportJson}
          >
            Download JSON
          </button>
        </div>
      ) : null}
    </div>
  );
}
