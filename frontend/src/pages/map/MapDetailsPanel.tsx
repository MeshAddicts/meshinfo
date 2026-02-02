export function MapDetailsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      id="details"
      className="hidden fixed top-2 right-2 z-[1050]
           w-[92vw] sm:w-80 max-w-[calc(100vw-1rem)]
           bg-white dark:bg-gray-900 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700
           max-h-[60vh] sm:max-h-[calc(100vh-2rem)]
           overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex-1 min-w-0">
          <div
            id="details-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate"
          >
            NODE NAME
          </div>
          <div
            id="details-subtitle"
            className="text-sm text-gray-500 dark:text-gray-400 truncate"
          >
            NODE
          </div>
        </div>
        <button
          onClick={onClose}
          className="ml-3 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          aria-label="Close details"
        >
          <svg
            className="w-4 h-4 text-gray-500 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <div
        id="details-content"
        className="p-4 overflow-y-auto min-h-0 flex-1 text-sm text-gray-700 dark:text-gray-300"
      />
    </div>
  );
}
