import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";

import type { OsmBasemap } from "../../maps/mapStyle";
import { NodeRole, roleTitles } from "../../types";
import { type DropupOption,FilterDropup } from "./FilterDropup";
import { MapLegend } from "./MapLegend";
import type { LinkMode, MapProvider } from "./types";
import { useBottomSheetGesture } from "./useBottomSheet";
import { ROLE_COLORS } from "./utils";

interface NodeOption {
  id: string;
  shortname?: string;
  longname?: string;
}

function filtersSubtitle(
  recentDays: number,
  linkMode: LinkMode,
  clusterEnabled: boolean,
  roleFilter: number | null,
  channelFilter: string | null,
): string {
  const parts: string[] = [];
  if (recentDays !== 30) parts.push(`Last ${recentDays}d`);
  if (linkMode !== "selected") parts.push(linkMode === "all" ? "All links" : "My Node");
  if (!clusterEnabled) parts.push("No cluster");
  if (roleFilter != null) parts.push(roleTitles[roleFilter as NodeRole]?.abbreviation ?? "Role");
  if (channelFilter != null) parts.push(`Ch ${channelFilter}`);
  return parts.length === 0 ? "Defaults" : parts.join(" · ");
}

function FiltersSection({
  recentDays,
  setRecentDays,
  linkMode,
  setLinkMode,
  clusterEnabled,
  setClusterEnabled,
  roleFilter,
  setRoleFilter,
  channelFilter,
  setChannelFilter,
  availableChannels,
  resolveChannelLabel,
}: {
  recentDays: number;
  setRecentDays: Dispatch<SetStateAction<number>>;
  linkMode: LinkMode;
  setLinkMode: Dispatch<SetStateAction<LinkMode>>;
  clusterEnabled: boolean;
  setClusterEnabled: Dispatch<SetStateAction<boolean>>;
  roleFilter: number | null;
  setRoleFilter: Dispatch<SetStateAction<number | null>>;
  channelFilter: string | null;
  setChannelFilter: Dispatch<SetStateAction<string | null>>;
  availableChannels: string[];
  resolveChannelLabel?: (id: string | null | undefined) => string | null;
}) {
  const DAYS_OPTIONS: DropupOption<number>[] = [
    { value: 1, label: "Last 1 day" },
    { value: 3, label: "Last 3 days" },
    { value: 5, label: "Last 5 days" },
    { value: 7, label: "Last 7 days" },
    { value: 14, label: "Last 14 days" },
    { value: 30, label: "Last 30 days" },
  ];
  const LINK_MODE_OPTIONS: DropupOption<LinkMode>[] = [
    { value: "selected", label: "Selected Node Only" },
    { value: "all", label: "All Nodes" },
    { value: "mynode", label: "My Node" },
  ];
  const CLUSTER_OPTIONS: DropupOption<string>[] = [
    { value: "on", label: "Clustering On" },
    { value: "off", label: "Clustering Off" },
  ];
  const ROLE_OPTIONS: DropupOption<number | null>[] = [
    { value: null, label: "All Roles" },
    ...Object.entries(roleTitles).map(([val, info]) => ({
      value: Number(val),
      label: info.title,
      color: ROLE_COLORS[Number(val)],
    })),
  ];
  const channelOptions: DropupOption<string | null>[] = [
    { value: null, label: "All Channels" },
    ...availableChannels.map((ch) => ({
      value: ch,
      label: resolveChannelLabel?.(ch) ?? `Ch ${ch}`,
    })),
  ];

  const daysLabel = (d: number) => (d >= 30 ? "30d" : `${d}d`);
  const linkModeLabel = (m: LinkMode) =>
    m === "selected" ? "Selected" : m === "all" ? "All" : "My Node";

  return (
    <div className="flex flex-wrap gap-1.5">
        <FilterDropup
          label={`Last ${daysLabel(recentDays)}`}
          value={recentDays}
          options={DAYS_OPTIONS}
          onChange={(v) => setRecentDays(v)}
          isActive={recentDays !== 30}
        />
        <FilterDropup
          label={`Links: ${linkModeLabel(linkMode)}`}
          value={linkMode}
          options={LINK_MODE_OPTIONS}
          onChange={(v) => setLinkMode(v)}
          isActive={linkMode !== "selected"}
        />
        <FilterDropup
          label={`Cluster: ${clusterEnabled ? "On" : "Off"}`}
          value={clusterEnabled ? "on" : "off"}
          options={CLUSTER_OPTIONS}
          onChange={(v) => setClusterEnabled(v === "on")}
          isActive={clusterEnabled}
        />
        <FilterDropup
          label={
            roleFilter != null
              ? (roleTitles[roleFilter as NodeRole]?.abbreviation ?? "Role")
              : "Role"
          }
          value={roleFilter}
          options={ROLE_OPTIONS}
          onChange={(v) => setRoleFilter(v)}
          isActive={roleFilter != null}
          maxHeight={340}
        />
        {availableChannels.length > 0 && (
          <FilterDropup
            label={
              channelFilter != null
                ? (resolveChannelLabel?.(channelFilter) ?? `Ch ${channelFilter}`).slice(0, 10)
                : "Channel"
            }
            value={channelFilter}
            options={channelOptions}
            onChange={(v) => setChannelFilter(v)}
            isActive={channelFilter != null}
          />
        )}
    </div>
  );
}

export function MapSettingsPanel({
  settingsPanelRef,
  settingsToggleRef,
  settingsPanelOpen,
  setSettingsPanelOpen,
  openSections,
  setOpenSections,

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
  buildings3D,
  setBuildings3D,
  onExport,
  hidden = false,

  recentDays,
  setRecentDays,
  clusterEnabled,
  setClusterEnabled,
  roleFilter,
  setRoleFilter,
  channelFilter,
  setChannelFilter,
  availableChannels = [],
  resolveChannelLabel,
}: {
  settingsPanelRef: RefObject<HTMLDivElement | null>;
  settingsToggleRef: RefObject<HTMLButtonElement | null>;
  settingsPanelOpen: boolean;
  setSettingsPanelOpen: Dispatch<SetStateAction<boolean>>;
  openSections: Set<string>;
  setOpenSections: Dispatch<SetStateAction<Set<string>>>;

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
  buildings3D: boolean;
  setBuildings3D: Dispatch<SetStateAction<boolean>>;
  onExport?: () => void;
  hidden?: boolean;

  recentDays: number;
  setRecentDays: Dispatch<SetStateAction<number>>;
  clusterEnabled: boolean;
  setClusterEnabled: Dispatch<SetStateAction<boolean>>;
  roleFilter: number | null;
  setRoleFilter: Dispatch<SetStateAction<number | null>>;
  channelFilter: string | null;
  setChannelFilter: Dispatch<SetStateAction<string | null>>;
  availableChannels?: string[];
  resolveChannelLabel?: (id: string | null | undefined) => string | null;
}) {
  const [nodeSearch, setNodeSearch] = useState("");
  const [legendOpen, setLegendOpen] = useState(false);
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

  const sheet = useBottomSheetGesture(() => setSettingsPanelOpen(false));

  const selectClasses =
    "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-200 focus:border-cyan-500/50 focus:outline-hidden focus:ring-1 focus:ring-cyan-500/50 [&_option]:bg-gray-800 [&_option]:text-gray-200 [&_optgroup]:bg-gray-900 [&_optgroup]:text-gray-400";

  const iconBtnBase =
    "p-2 rounded-xl shadow-2xl border backdrop-blur-xl transition-colors";

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
    const open = openSections.has(id);
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
          ref={(el) => {
            (settingsPanelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            (sheet.sheetRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }}
          className="shadow-2xl border border-white/10 bg-gray-900/80 backdrop-blur-xl
                     fixed inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl flex flex-col
                     animate-[slideInUp_200ms_ease-out]
                     sm:static sm:mb-2 sm:inset-x-auto sm:bottom-auto
                     sm:w-72 sm:max-w-[calc(100vw-2rem)] sm:h-130 sm:max-h-[calc(100vh-8rem)]
                     sm:rounded-xl sm:animate-none"
        >
          <div
            className="sm:hidden flex justify-center pt-2 pb-1 shrink-0 touch-none cursor-grab active:cursor-grabbing"
            onTouchStart={sheet.onTouchStart}
            onTouchMove={sheet.onTouchMove}
            onTouchEnd={sheet.onTouchEnd}
          >
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>

          <div className="px-4 py-3 pb-6 sm:pb-3 overflow-y-auto overscroll-contain flex-1 min-h-0 sm:overflow-y-auto">
            <div
              className="flex items-center justify-between mb-2 max-sm:touch-none"
              onTouchStart={sheet.onTouchStart}
              onTouchMove={sheet.onTouchMove}
              onTouchEnd={sheet.onTouchEnd}
            >
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

            <Section
              id="filters"
              title="Filters"
              subtitle={filtersSubtitle(recentDays, linkMode, clusterEnabled, roleFilter, channelFilter)}
            >
              <FiltersSection
                recentDays={recentDays}
                setRecentDays={setRecentDays}
                linkMode={linkMode}
                setLinkMode={setLinkMode}
                clusterEnabled={clusterEnabled}
                setClusterEnabled={setClusterEnabled}
                roleFilter={roleFilter}
                setRoleFilter={setRoleFilter}
                channelFilter={channelFilter}
                setChannelFilter={setChannelFilter}
                availableChannels={availableChannels}
                resolveChannelLabel={resolveChannelLabel}
              />
            </Section>

            <Section id="appearance" title="Appearance" subtitle="Basemap">
              <div>
                <label
                  htmlFor="basemap-select"
                  className="text-[10px] font-medium uppercase tracking-wider text-gray-500 mb-1.5 block"
                >
                  Basemap
                </label>
                <select
                  id="basemap-select"
                  aria-label="Basemap selection"
                  className={selectClasses}
                  value={
                    usingMapbox
                      ? `mapbox:${mapboxStyle}`
                      : `osm:${osmBasemap}`
                  }
                  onChange={(e) => {
                    const [kind, value] = e.target.value.split(":", 2);
                    if (kind === "mapbox") {
                      setProvider("mapbox");
                      setMapboxStyle(value);
                    } else {
                      setProvider("osm");
                      setOsmBasemap(value as OsmBasemap);
                    }
                  }}
                >
                  <optgroup label="OpenStreetMap (free)">
                    <option value="osm:osm">OSM Standard</option>
                    <option value="osm:osm_hot">OSM Humanitarian</option>
                    <option value="osm:carto_positron">Carto Positron (Light)</option>
                    <option value="osm:carto_dark">Carto Dark Matter (Dark)</option>
                  </optgroup>
                  <optgroup label={canUseMapbox ? "Mapbox (token)" : "Mapbox — token not configured"}>
                    <option value="mapbox:mapbox/dark-v11" disabled={!canUseMapbox}>Mapbox Dark</option>
                    <option value="mapbox:mapbox/streets-v12" disabled={!canUseMapbox}>Mapbox Streets</option>
                    <option value="mapbox:mapbox/satellite-streets-v12" disabled={!canUseMapbox}>Mapbox Satellite</option>
                  </optgroup>
                </select>
              </div>

              {!canUseMapbox && (
                <div className="text-[11px] text-gray-500 p-2 rounded-lg bg-white/5">
                  Set <code className="bg-white/10 px-1 rounded-sm text-[10px]">VITE_MAPBOX_TOKEN</code> to enable Mapbox imagery. OpenStreetMap + 3D terrain work fully without a token.
                </div>
              )}
            </Section>

            <Section
              id="terrain"
              title="3D Layers"
              subtitle={[terrain3D && "Terrain", buildings3D && "Buildings"].filter(Boolean).join(" + ") || "Off"}
            >
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

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-white/5">
                  <div className="flex flex-col">
                    <label htmlFor="buildings-3d-checkbox" className="text-sm font-medium text-gray-300">
                      Enable 3D Buildings
                    </label>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      Cosmetic OpenFreeMap extrusions (visible at zoom ≥ 14)
                    </p>
                  </div>
                  <input
                    id="buildings-3d-checkbox"
                    type="checkbox"
                    checked={buildings3D}
                    onChange={(e) => setBuildings3D(e.target.checked)}
                    className="h-4 w-4 rounded-sm border-gray-600 bg-gray-700 text-cyan-500 focus:ring-cyan-500"
                    aria-label="Toggle 3D buildings"
                  />
                </div>

                {terrain3D && (
                  <div className="text-[10px] text-gray-500 p-2 rounded-lg bg-white/5 leading-relaxed">
                    <strong className="text-gray-400">Tip:</strong> hold{" "}
                    <kbd className="bg-white/10 px-1 rounded-sm text-[10px] mx-0.5">Right-Click</kbd>
                    {" "}and drag to rotate/pitch. Ctrl + scroll changes pitch.
                  </div>
                )}
              </Section>

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

      <div className={`flex items-center gap-2 ${settingsPanelOpen ? "max-sm:hidden" : ""}`}>
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
