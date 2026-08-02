// Single source of truth for the primary nav. Both the persistent desktop rail
// and the mobile/overlay drawer render from MESH_NAV, so the two can never drift.
// Icons are inline stroke="currentColor" SVGs (matching the map-panel idiom) so
// they tint with the active/hover text color — no icon-library dependency.
/* eslint-disable react-refresh/only-export-components */
import type { ReactElement, ReactNode } from "react";

export type IconProps = { className?: string };
export type IconComponent = (props: IconProps) => ReactElement;

// Outline icon factory — shared stroke geometry, paths supplied per icon.
function strokeIcon(children: ReactNode): IconComponent {
  return function Icon({ className }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };
}

// --- Route icons ---
export const ChatIcon = strokeIcon(
  <>
    <path d="M7.5 8.25h9m-9 3.75h6" />
    <path d="M7.1 18.16 3 21V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25v9A2.25 2.25 0 0 1 18.75 16.5H8.69a2.25 2.25 0 0 0-1.59.66Z" />
  </>,
);
export const MapIcon = strokeIcon(
  <>
    <circle cx="12" cy="10.5" r="2.5" />
    <path d="M19.5 10.5c0 6-7.5 10.5-7.5 10.5S4.5 16.5 4.5 10.5a7.5 7.5 0 0 1 15 0Z" />
  </>,
);
export const GraphIcon = strokeIcon(
  <>
    <circle cx="6" cy="12" r="2.25" />
    <circle cx="18" cy="6" r="2.25" />
    <circle cx="18" cy="18" r="2.25" />
    <path d="m8.05 11.05 7.9-3.95M8.05 12.95l7.9 3.95" />
  </>,
);
export const NodesIcon = strokeIcon(
  <>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <rect x="9.25" y="9.25" width="5.5" height="5.5" rx="0.75" />
    <path d="M9 3v1.75M12 3v1.75M15 3v1.75M9 19.25V21M12 19.25V21M15 19.25V21M3 9h1.75M3 12h1.75M3 15h1.75M19.25 9H21M19.25 12H21M19.25 15H21" />
  </>,
);
export const NeighborsIcon = strokeIcon(
  <>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6" />
    <path d="M17.5 13.4a5.5 5.5 0 0 1 3 4.9" />
  </>,
);
export const StatsIcon = strokeIcon(
  <>
    <path d="M3.5 20.5h17" />
    <rect x="5" y="11" width="3.4" height="7.5" rx="0.6" />
    <rect x="10.3" y="6.5" width="3.4" height="12" rx="0.6" />
    <rect x="15.6" y="14" width="3.4" height="4.5" rx="0.6" />
  </>,
);
export const TelemetryIcon = strokeIcon(
  <path d="M3 12h3.2l2.4-7 4 14 2.4-7H21" />,
);
export const TraceroutesIcon = strokeIcon(
  <>
    <circle cx="6" cy="6" r="2" />
    <circle cx="18" cy="18" r="2" />
    <path d="M8 6h6a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h6" />
  </>,
);
export const LogsIcon = strokeIcon(
  <>
    <path d="M8.5 7h9M8.5 12h9M8.5 17h6" />
    <path d="M4.75 7h.01M4.75 12h.01M4.75 17h.01" />
  </>,
);

// --- UI chrome icons ---
export const ChevronDoubleLeftIcon = strokeIcon(
  <path d="m18 6-6 6 6 6M12 6l-6 6 6 6" />,
);
export const ExternalLinkIcon = strokeIcon(
  <>
    <path d="M14 5h5v5" />
    <path d="M19 5 11.5 12.5" />
    <path d="M19 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5" />
  </>,
);
export const SunIcon = strokeIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </>,
);
export const MoonIcon = strokeIcon(
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />,
);

export const GitHubIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05A9.34 9.34 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
  </svg>
);

export interface NavItemDef {
  to: string;
  label: string;
  Icon: IconComponent;
  badge?: string;
}

export interface ExternalLinkDef {
  name: string;
  url: string;
}

// Primary in-app destinations. Order preserved from the legacy sidebar.
export const MESH_NAV: NavItemDef[] = [
  { to: "/chat", label: "Chat", Icon: ChatIcon },
  { to: "/map", label: "Map", Icon: MapIcon },
  { to: "/graph", label: "Graph", Icon: GraphIcon, badge: "Experimental" },
  { to: "/nodes", label: "Nodes", Icon: NodesIcon },
  { to: "/neighbors", label: "Node Neighbors", Icon: NeighborsIcon },
  { to: "/stats", label: "Stats", Icon: StatsIcon },
  { to: "/telemetry", label: "Telemetry", Icon: TelemetryIcon },
  { to: "/traceroutes", label: "Traceroutes", Icon: TraceroutesIcon },
  { to: "/logs", label: "Logs", Icon: LogsIcon },
];

// Falls back here when config.mesh.tools is absent.
export const DEFAULT_TOOLS: ExternalLinkDef[] = [
  { name: "Liam's Meshtastic Map", url: "https://meshtastic.liamcottle.net" },
  { name: "MeshMap", url: "https://meshmap.net" },
  { name: "Bay Mesh Explorer", url: "https://meshview.bayme.sh" },
  { name: "HWT Path Profiler", url: "https://heywhatsthat.com/profiler.html" },
];

export const MESHTASTIC_ADDONS: ExternalLinkDef[] = [
  { name: "DopeWars", url: "https://github.com/armooo/meshtastic_dopewars" },
  { name: "TheCommsChannel BBS", url: "https://github.com/TheCommsChannel/TC2-BBS-mesh" },
];
