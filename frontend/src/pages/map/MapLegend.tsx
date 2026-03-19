export function MapLegend() {
  return (
    <div
      id="legend"
      className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-3"
    >
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Legend
      </div>
      <div className="space-y-1.5 text-xs text-gray-600 dark:text-gray-300">
        {/* Node symbols */}
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#32f032] border-2 border-white shadow-sm shrink-0" />
          <span>Online Node</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-black/50 border-2 border-white shadow-sm shrink-0" />
          <span>Offline Node</span>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

        {/* Line symbols */}
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#66FF66] rounded-full shrink-0" />
          <span>Heard A Neighbor</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#6666FF] rounded-full shrink-0" />
          <span>Heard By Neighbor</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-[#FF66FF] rounded-full shrink-0" />
          <span>Mutual Connection</span>
        </div>

        {/* Threshold note */}
        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
        <div className="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
          Online = seen in last 6 hours.
          <br />
          Lines shown when a node is selected.
        </div>
      </div>
    </div>
  );
}
