import type { Coordinate } from "ol/coordinate";

import type { INode, ITraceroutesResponse, NodeRole } from "../../types";
import type { ElsewhereLink } from "../../types/config";

export type MapProvider = "osm" | "mapbox";
export type LinkMode = "selected" | "all" | "mynode";

export type IMapNode = INode & {
  online: boolean;
  map_position?: Coordinate; // [lon, lat]
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// OL Feature properties for click handling
export type IFeatureNode = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  gateway?: string | null;
  position: Coordinate; // [lon, lat]
  online: boolean;
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// Normalized shape for shared details rendering/link building
export type NodeLike = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  gateway?: string | null;
  online: boolean;
  position: Coordinate; // [lon, lat]
  role?: NodeRole;
  neighbors?: {
    id: string;
    snr: number;
    distance: number;
  }[];
};

// Data passed to the React details panel
export type NodeDetailsData = {
  node: NodeLike;
  liveNodes: Record<string, IMapNode>;
  displayName: string;
  elsewhereLinks?: ElsewhereLink[];
  traceroutes?: ITraceroutesResponse[];
  channelLabel?: string | null;
  heardBy: string[];
  maxRangeKm?: number | null;
};

export type MapToolId = "los" | "traceroute";

// Tool-picker props for the details panel
export type PathAnalysisProps = {
  pickMode: boolean;
  targetId: string | null;
  activeTool: MapToolId | null;
  onEnterPickMode: (tool: MapToolId) => void;
  onClearPath: () => void;
};
