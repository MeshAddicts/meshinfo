export function MapLegend() {
  return (
    <div
      id="legend"
      className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-3"
    >
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Legend
      </div>
      <div className="space-y-1 text-xs text-gray-600 dark:text-gray-300">
        <div className="flex items-center justify-center gap-2">
          <div className="w-4 h-1 bg-green-400 rounded-full" />
          <span>Heard A Neighbor</span>
        </div>
        <div className="flex items-center justify-center gap-2">
          <div className="w-4 h-1 bg-blue-400 rounded-full" />
          <span>Heard By Neighbor</span>
        </div>
        <div className="flex items-center justify-center gap-2">
          <div className="w-4 h-1 bg-purple-400 rounded-full" />
          <span>Mutual Connection</span>
        </div>
      </div>
    </div>
  );
}