import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";

import type { OsmBasemap } from "../../maps/baseLayer";
import { MapLegend } from "./MapLegend";
import type { LinkMode, MapProvider } from "./types";

interface NodeOption {
  id: string;
  shortname?: string;
  longname?: string;
}

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

  linkMode,
  setLinkMode,

  myNodeId,
  setMyNodeId,

  nodeList,

  canUseMapbox,
  usingMapbox,
  terrain3D,
  setTerrain3D,
  terrainExaggeration,
  setTerrainExaggeration,
  onExport,
  hidden = false,
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

  linkMode: LinkMode;
  setLinkMode: Dispatch<SetStateAction<LinkMode>>;

  myNodeId: string;
  setMyNodeId: Dispatch<SetStateAction<string>>;

  nodeList: NodeOption[];

  canUseMapbox: boolean;
  usingMapbox: boolean;
  terrain3D: boolean;
  setTerrain3D: Dispatch<SetStateAction<boolean>>;
  terrainExaggeration: number;
  setTerrainExaggeration: Dispatch<SetStateAction<number>>;
  onExport?: () => void;
  hidden?: boolean;
}) {
  const [nodeSearch, setNodeSearch] = useState("");
  const [legendOpen, setLegendOpen] = useState(false);
  const [openSection, setOpenSection] = useState<string>("appearance");
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredNodes = useMemo(() => {
    if (!nodeSearch) return nodeList.slice(0, 50);
    const q = nodeSearch.toLowerCase();
    return nodeList
      .filter(
        (n) =>
          n.id.toLowerCase().includes(q) ||
          n.shortname?.toLowerCase().includes(q) ||
          n.longname?.toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [nodeList, nodeSearch]);

  const myNodeLabel = useMemo(() => {
    if (!myNodeId) return "";
    const node = nodeList.find((n) => n.id === myNodeId);
    return node?.shortname || node?.longname || myNodeId;
  }, [myNodeId, nodeList]);

  useEffect(() => {
    if (!legendOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setLegendOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [legendOpen]);

  const selectClasses =
    "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-200 focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50 [&>option]:bg-gray-800 [&>option]:text-gray-200";

  const iconBtnBase =
    "p-2 rounded-xl shadow-2xl border backdrop-blur-xl transition-colors";

  const toggleSection = (key: string) => {
    setOpenSection((cur) => (cur === key ? "" : key));
  };

  const Section = ({
    id,
    title,
    subtitle,
    children,
  }: {
    id: string;
    title: string;
    subtitle?: string;
    children: React.ReactNode;
  }) => {
    const open = openSection === id;
    return (
      <div className="border-t border-white/5 first:border-t-0">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          className="w-full flex items-center justify-between py-2.5 text-left hover:text-gray-100 transition-colors"
        >
          <div>
            <div className="text-xs font-semibold text-gray-200">{title}</div>
            {subtitle && <div className="text-[10px] text-gray-500 mt-0.5">{subtitle}</div>}
          </div>
          <svg
            className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {open && <div className="pb-3 space-y-3">{children}</div>}
      </div>
    );
  };

  return (
    <div ref={containerRef} className={`fixed bottom-4 right-4 z-1100 flex flex-col items-end ${hidden ? "max-sm:hidden" : ""}`}>
      {legendOpen && !settingsPanelOpen && (
        <div className="mb-2">
          <MapLegend linkMode={linkMode} myNodeLabel={myNodeLabel} />
        </div>
      )}

      {settingsPanelOpen && (
        <div
          ref={settingsPanelRef}
          className="mb-2 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-8rem)] overflow-y-auto
                     rounded-xl shadow-2xl border border-white/10 bg-gray-900/80 backdrop-blur-xl"
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-200">Map Settings</h3>
              <button
                type="button"
                onClick={() => setSettingsPanelOpen(false)}
                className="p-1 rounded-md hover:bg-white/10 transition-colors"
                aria-label="Close settings"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-[10px] text-gray-500 mb-2">
              Filters (last-seen, links, clustering, role, channel) are in the pills at the bottom-left.
            </p>

            <Section id="appearance" title="Appearance" subtitle="Map provider and visual style">
              <div>
                <label
                  htmlFor="provider-select"
                  className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1.5 block"
                >
                  Provider
                </label>
                <select
                  id="provider-select"
                  aria-label="Map provider selection"
                  className={selectClasses}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as MapProvider)}
                >
                  <option value="osm">OSM (OpenLayers)</option>
                  <option value="mapbox" disabled={!canUseMapbox}>
                    Mapbox (GL JS){!canUseMapbox ? " — token not configured" : ""}
                  </option>
                </select>
              </div>

              {usingMapbox ? (
                <div>
                  <label
                    htmlFor="mapbox-style-select"
                    className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1.5 block"
                  >
                    Mapbox Style
                  </label>
                  <select
                    id="mapbox-style-select"
                    aria-label="Mapbox map style selection"
                    className={selectClasses}
                    value={mapboxStyle}
                    onChange={(e) => setMapboxStyle(e.target.value)}
                  >
                    <option value="mapbox/dark-v11">Dark</option>
                    <option value="mapbox/streets-v12">Streets</option>
                    <option value="mapbox/satellite-streets-v12">Satellite Streets</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="osm-basemap-select"
                    className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1.5 block"
                  >
                    OSM Basemap
                  </label>
                  <select
                    id="osm-basemap-select"
                    aria-label="OpenStreetMap basemap selection"
                    className={selectClasses}
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

              {!canUseMapbox && (
                <div className="text-[11px] text-gray-500 p-2 rounded-lg bg-white/5">
                  Mapbox disabled — <code className="bg-white/10 px-1 rounded-sm text-[10px]">VITE_MAPBOX_TOKEN</code> not configured.
                </div>
              )}
            </Section>

            {/* 3D terrain (Mapbox only) */}
            {usingMapbox && (
              <Section id="terrain" title="3D Terrain" subtitle={terrain3D ? `On · ${terrainExaggeration.toFixed(1)}× exaggeration` : "Off"}>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white/5">
                  <div className="flex flex-col">
                    <label htmlFor="terrain-3d-checkbox" className="text-sm font-medium text-gray-300">
                      Enable 3D Terrain
                    </label>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      Drapes map onto real elevation
                    </p>
                  </div>
                  <input
                    id="terrain-3d-checkbox"
                    type="checkbox"
                    checked={terrain3D}
                    onChange={(e) => setTerrain3D(e.target.checked)}
                    className="h-4 w-4 rounded-sm border-gray-600 bg-gray-700 text-cyan-500 focus:ring-cyan-500"
                    aria-label="Toggle 3D terrain"
                  />
                </div>

                {terrain3D && (
                  <>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label htmlFor="terrain-exag" className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                          Exaggeration
                        </label>
                        <span className="text-[10px] text-gray-400">{terrainExaggeration.toFixed(1)}×</span>
                      </div>
                      <input
                        id="terrain-exag"
                        type="range"
                        min={0.5}
                        max={3}
                        step={0.1}
                        value={terrainExaggeration}
                        onChange={(e) => setTerrainExaggeration(Number(e.target.value))}
                        className="w-full accent-cyan-500"
                        aria-label="Terrain exaggeration"
                      />
                    </div>
                    <div className="text-[10px] text-gray-500 p-2 rounded-lg bg-white/5 leading-relaxed">
                      <strong className="text-gray-400">Tip:</strong> hold{" "}
                      <kbd className="bg-white/10 px-1 rounded-sm text-[10px] mx-0.5">Right-Click</kbd>
                      {" "}and drag to rotate/pitch. Ctrl + scroll changes pitch.
                    </div>
                  </>
                )}
              </Section>
            )}

            <Section id="mynode" title="My Node" subtitle={myNodeLabel || "Not set"}>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="my-node-search"
                    className="text-[10px] font-medium uppercase tracking-wider text-gray-500"
                  >
                    Search nodes
                  </label>
                  {myNodeId && (
                    <button
                      type="button"
                      onClick={() => {
                        setMyNodeId("");
                        setLinkMode("selected");
                      }}
                      className="text-[10px] text-red-400 hover:text-red-300 transition-colors"
                      aria-label="Clear My Node"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  id="my-node-search"
                  type="text"
                  placeholder="Search by name or ID…"
                  className={selectClasses}
                  value={nodeSearch}
                  onChange={(e) => setNodeSearch(e.target.value)}
                />
                {nodeSearch && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-white/10 bg-gray-800/90">
                    {filteredNodes.length === 0 && (
                      <div className="px-3 py-2 text-xs text-gray-500">No nodes found</div>
                    )}
                    {filteredNodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/10 text-gray-300 truncate transition-colors"
                        onClick={() => {
                          setMyNodeId(node.id);
                          setNodeSearch("");
                        }}
                      >
                        <span className="font-medium">{node.shortname || node.id}</span>
                        {node.longname && <span className="ml-1 text-gray-500">{node.longname}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-gray-600 mt-1.5">
                  Tip: right-click (or long-press) a node on the map to set it as My Node.
                </p>
              </div>
            </Section>

            {onExport && (
              <Section id="export" title="Export" subtitle="Save current view as image">
                <button
                  type="button"
                  onClick={onExport}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
                    bg-cyan-500/10 border border-cyan-500/30 text-cyan-300
                    hover:bg-cyan-500/20 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Download PNG
                </button>
                <p className="text-[10px] text-gray-500">
                  Captures the current map view including all visible nodes and overlays.
                </p>
              </Section>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setLegendOpen(!legendOpen);
            if (settingsPanelOpen) setSettingsPanelOpen(false);
          }}
          className={`${iconBtnBase} ${
            legendOpen
              ? "bg-gray-900/90 border-cyan-500/50"
              : "bg-gray-900/80 border-white/10 hover:bg-gray-900/90"
          }`}
          aria-label="Toggle legend"
        >
          <div className="w-5 h-5 flex items-center justify-center">
            <svg className={`w-4 h-4 ${legendOpen ? "text-cyan-400" : "text-gray-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </button>

        <button
          ref={settingsToggleRef}
          type="button"
          onClick={() => {
            setSettingsPanelOpen(!settingsPanelOpen);
            if (legendOpen) setLegendOpen(false);
          }}
          className={`${iconBtnBase} ${
            settingsPanelOpen
              ? "bg-gray-900/90 border-cyan-500/50"
              : "bg-gray-900/80 border-white/10 hover:bg-gray-900/90"
          }`}
          aria-label="Toggle Map Settings"
        >
          <div className="w-5 h-5 flex items-center justify-center">
            <svg className={`w-4 h-4 ${settingsPanelOpen ? "text-cyan-400" : "text-gray-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100-4m0 4v2m0-6V4" />
            </svg>
          </div>
        </button>
      </div>
    </div>
  );
}
