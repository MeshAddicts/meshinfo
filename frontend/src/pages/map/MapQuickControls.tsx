import type { Dispatch, SetStateAction } from "react";
import { NodeRole, roleTitles } from "../../types";
import type { LinkMode } from "./types";

const DAYS_OPTIONS = [1, 3, 5, 7, 14, 30] as const;

function daysLabel(days: number): string {
  return days >= 30 ? "30d" : `${days}d`;
}

function linkModeLabel(mode: LinkMode): string {
  switch (mode) {
    case "selected": return "Selected";
    case "all": return "All";
    case "mynode": return "My Node";
  }
}

export function MapQuickControls({
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
  availableChannels = [],
  resolveChannelLabel,
  hidden = false,
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
  availableChannels?: string[];
  resolveChannelLabel?: (id: string | null | undefined) => string | null;
  hidden?: boolean;
}) {
  const cycleDays = () => {
    const idx = DAYS_OPTIONS.indexOf(recentDays as (typeof DAYS_OPTIONS)[number]);
    const next = idx === -1 ? 7 : DAYS_OPTIONS[(idx + 1) % DAYS_OPTIONS.length];
    setRecentDays(next);
  };

  // Cycle through common roles: null → Router → Client → Repeater → null
  const ROLE_CYCLE = [null, NodeRole.ROUTER, NodeRole.ROUTER_CLIENT, NodeRole.CLIENT, NodeRole.REPEATER, NodeRole.TRACKER];
  const cycleRole = () => {
    const idx = ROLE_CYCLE.indexOf(roleFilter);
    setRoleFilter(ROLE_CYCLE[(idx + 1) % ROLE_CYCLE.length]);
  };

  const cycleChannel = () => {
    if (availableChannels.length === 0) return;
    if (channelFilter == null) {
      setChannelFilter(availableChannels[0]);
    } else {
      const idx = availableChannels.indexOf(channelFilter);
      if (idx === -1 || idx === availableChannels.length - 1) {
        setChannelFilter(null);
      } else {
        setChannelFilter(availableChannels[idx + 1]);
      }
    }
  };

  const cycleLinkMode = () => {
    const modes: LinkMode[] = ["selected", "all", "mynode"];
    const idx = modes.indexOf(linkMode);
    setLinkMode(modes[(idx + 1) % modes.length]);
  };

  const pillClasses =
    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer select-none " +
    "bg-gray-900/80 backdrop-blur-xl border-white/10 shadow-2xl " +
    "hover:bg-gray-900/90 hover:border-white/20 " +
    "text-gray-300 hover:text-gray-100";

  const activePillClasses =
    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer select-none " +
    "bg-cyan-500/20 backdrop-blur-xl border-cyan-500/40 shadow-2xl " +
    "hover:bg-cyan-500/30 " +
    "text-cyan-300";

  return (
    <div className={`fixed bottom-4 left-4 right-24 sm:right-auto z-1100 flex items-center gap-1.5 overflow-x-auto no-scrollbar ${hidden ? "max-sm:hidden" : ""}`}>
      {/* Last Seen */}
      <button
        type="button"
        onClick={cycleDays}
        className={pillClasses}
        title={`Showing nodes seen in last ${recentDays} days. Click to cycle.`}
      >
        Last {daysLabel(recentDays)}
      </button>

      {/* Link Mode */}
      <button
        type="button"
        onClick={cycleLinkMode}
        className={linkMode !== "selected" ? activePillClasses : pillClasses}
        title={`Link mode: ${linkModeLabel(linkMode)}. Click to cycle.`}
      >
        Links: {linkModeLabel(linkMode)}
      </button>

      {/* Clustering */}
      <button
        type="button"
        onClick={() => setClusterEnabled(!clusterEnabled)}
        className={clusterEnabled ? activePillClasses : pillClasses}
        title={`Clustering ${clusterEnabled ? "on" : "off"}. Click to toggle.`}
      >
        <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
        {clusterEnabled ? "On" : "Off"}
      </button>

      {/* Role filter */}
      <button
        type="button"
        onClick={cycleRole}
        className={roleFilter != null ? activePillClasses : pillClasses}
        title={roleFilter != null ? `Filtering: ${roleTitles[roleFilter as NodeRole]?.title}. Click to cycle.` : "Filter by role. Click to cycle."}
      >
        {roleFilter != null ? roleTitles[roleFilter as NodeRole]?.abbreviation ?? "?" : "Role"}
      </button>

      {/* Channel filter */}
      {availableChannels.length > 0 && (
        <button
          type="button"
          onClick={cycleChannel}
          className={channelFilter != null ? activePillClasses : pillClasses}
          title={channelFilter != null ? `Channel: ${resolveChannelLabel?.(channelFilter) ?? channelFilter}. Click to cycle.` : "Filter by channel. Click to cycle."}
        >
          {channelFilter != null ? (resolveChannelLabel?.(channelFilter) ?? `Ch ${channelFilter}`).slice(0, 8) : "Channel"}
        </button>
      )}
    </div>
  );
}
