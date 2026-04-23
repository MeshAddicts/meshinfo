import type { INode, ITraceroutesResponse, NodeRole } from "../../types";
import type { ElsewhereLink } from "../../types/config";

/** [lon, lat] tuple for map coordinates. */
export type Coordinate = [number, number];

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

