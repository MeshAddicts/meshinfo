import type { Dispatch, SetStateAction } from "react";
import { NodeRole, roleTitles } from "../../types";
import { FilterDropup, type DropupOption } from "./FilterDropup";
import type { LinkMode } from "./types";
import { ROLE_COLORS } from "./utils";

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

function daysShortLabel(days: number): string {
  return days >= 30 ? "30d" : `${days}d`;
}

function linkModeShortLabel(mode: LinkMode): string {
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
  const channelOptions: DropupOption<string | null>[] = [
    { value: null, label: "All Channels" },
    ...availableChannels.map((ch) => ({
      value: ch,
      label: resolveChannelLabel?.(ch) ?? `Ch ${ch}`,
    })),
  ];

  return (
    <div className={`fixed bottom-4 left-4 right-24 sm:right-auto z-1100 items-center gap-1.5 overflow-x-auto no-scrollbar hidden sm:flex ${hidden ? "sm:hidden" : ""}`}>
      <FilterDropup
        label={`Last ${daysShortLabel(recentDays)}`}
        value={recentDays}
        options={DAYS_OPTIONS}
        onChange={(v) => setRecentDays(v)}
        isActive={recentDays !== 30}
      />

      <FilterDropup
        label={`Links: ${linkModeShortLabel(linkMode)}`}
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
              ? ((resolveChannelLabel?.(channelFilter) ?? `Ch ${channelFilter}`).slice(0, 10))
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
