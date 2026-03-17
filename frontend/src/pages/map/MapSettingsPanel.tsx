import type { Dispatch, RefObject, SetStateAction } from "react";

import type { OsmBasemap } from "../../maps/baseLayer";
import { MapLegend } from "./MapLegend";
import type { MapProvider } from "./types";

export function MapSettingsPanel({
  settingsPanelRef,
  settingsToggleRef,
  settingsPanelOpen,
  setSettingsPanelOpen,

  provider,
  setProvider,

  mapboxStyle,
  setMapboxStyle,

  osmBasemap,
  setOsmBasemap,

  recentDays,
  setRecentDays,

  clusterEnabled,
  setClusterEnabled,

  canUseMapbox,
  usingMapbox,
}: {
  settingsPanelRef: RefObject<HTMLDivElement | null>;
  settingsToggleRef: RefObject<HTMLButtonElement | null>;
  settingsPanelOpen: boolean;
  setSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;

  provider: MapProvider;
  setProvider: Dispatch<SetStateAction<MapProvider>>;

  mapboxStyle: string;
  setMapboxStyle: Dispatch<SetStateAction<string>>;

  osmBasemap: OsmBasemap;
  setOsmBasemap: Dispatch<SetStateAction<OsmBasemap>>;

  recentDays: number;
  setRecentDays: Dispatch<SetStateAction<number>>;

  clusterEnabled: boolean;
  setClusterEnabled: Dispatch<SetStateAction<boolean>>;

  canUseMapbox: boolean;
  usingMapbox: boolean;
}) {
  return (
    <div className="fixed bottom-4 right-4 z-1100 min-w-56">
      {/* Toggle button - shows when closed */}
      {!settingsPanelOpen && (
        <button
          ref={settingsToggleRef}
          type="button"
          onClick={() => setSettingsPanelOpen(true)}
          className="mb-2 ml-auto block p-2 rounded-lg shadow-lg backdrop-blur-xs border
                      bg-white/90 dark:bg-gray-800/90 border-gray-200 dark:border-gray-600
                      hover:bg-gray-50 dark:hover:bg-gray-700"
          aria-label="Open Map Settings"
        >
          <div className="w-5 h-5 flex items-center justify-center">
            <svg
              className="w-4 h-4 text-gray-700 dark:text-gray-200"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100-4m0 4v2m0-6V4"
              />
            </svg>
          </div>
        </button>
      )}

      {/* Map Settings Panel - shows when open */}
      {settingsPanelOpen && (
        <div
          ref={settingsPanelRef}
          className="mb-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl shadow-lg border border-gray-200/70 dark:border-gray-700/70 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md"
        >
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                Map Settings
              </h3>

              <button
                type="button"
                onClick={() => setSettingsPanelOpen(false)}
                className="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close settings"
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

            <div className="space-y-4 text-sm">
              {/* Provider */}
              <div>
                <label
                  htmlFor="provider-select"
                  className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-2 block"
                >
                  Provider
                </label>
                <select
                  id="provider-select"
                  aria-label="Map provider selection"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as MapProvider)}
                >
                  <option value="osm">OSM (OpenLayers)</option>
                  <option value="mapbox" disabled={!canUseMapbox}>
                    Mapbox (GL JS)
                    {!canUseMapbox ? " — token not configured" : ""}
                  </option>
                </select>
              </div>

              {/* Style/Basemap */}
              {usingMapbox ? (
                <div>
                  <label
                    htmlFor="mapbox-style-select"
                    className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-2 block"
                  >
                    Mapbox Style
                  </label>
                  <select
                    id="mapbox-style-select"
                    aria-label="Mapbox map style selection"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400"
                    value={mapboxStyle}
                    onChange={(e) => setMapboxStyle(e.target.value)}
                  >
                    <option value="mapbox/dark-v11">Dark</option>
                    <option value="mapbox/streets-v12">Streets</option>
                    <option value="mapbox/satellite-streets-v12">
                      Satellite Streets
                    </option>
                  </select>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="osm-basemap-select"
                    className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-2 block"
                  >
                    OSM Basemap
                  </label>
                  <select
                    id="osm-basemap-select"
                    aria-label="OpenStreetMap basemap selection"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400"
                    value={osmBasemap}
                    onChange={(e) => setOsmBasemap(e.target.value as OsmBasemap)}
                  >
                    <option value="osm">OSM Standard</option>
                    <option value="osm_hot">OSM HOT</option>
                    <option value="carto_positron">Carto Positron (Light)</option>
                    <option value="carto_dark">Carto Dark Matter (Dark)</option>
                  </select>
                </div>
              )}

              {/* Last Seen Filter */}
              <div>
                <label
                  htmlFor="recent-days-select"
                  className="text-xs font-medium uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-2 block"
                >
                  Show Last Seen
                </label>
                <select
                  id="recent-days-select"
                  aria-label="Filter nodes by last seen timeframe"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:border-blue-500 dark:focus:border-blue-400 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400"
                  value={recentDays}
                  onChange={(e) => setRecentDays(Number(e.target.value))}
                >
                  <option value={30}>30 days</option>
                  <option value={14}>14 days</option>
                  <option value={7}>7 days</option>
                  <option value={5}>5 days</option>
                  <option value={3}>3 days</option>
                  <option value={1}>1 day</option>
                </select>
              </div>

              {/* Clustering Toggle */}
              <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                <div className="flex flex-col">
                  <label
                    htmlFor="clustering-checkbox"
                    className="text-sm font-medium text-gray-900 dark:text-gray-100"
                  >
                    Node Clustering
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {!usingMapbox ? "Mapbox only" : "Group nearby nodes"}
                  </p>
                </div>
                <div className="relative">
                  <input
                    id="clustering-checkbox"
                    type="checkbox"
                    checked={clusterEnabled}
                    onChange={(e) => setClusterEnabled(e.target.checked)}
                    disabled={!usingMapbox}
                    className="h-4 w-4 rounded-sm border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    aria-label="Toggle node clustering (Mapbox only)"
                  />
                </div>
              </div>

              {/* Info Note */}
              {!canUseMapbox && (
                <div className="text-xs text-gray-500 dark:text-gray-400 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                  Mapbox features are disabled because{" "}
                  <code className="bg-gray-200 dark:bg-gray-700 px-1 py-0.5 rounded-sm text-xs">
                    VITE_MAPBOX_TOKEN
                  </code>{" "}
                  is not configured.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <MapLegend />
    </div>
  );
}