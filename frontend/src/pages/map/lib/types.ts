import type { INode, ITraceroutesResponse, NodeRole } from "../../../types";
import type { ElsewhereLink } from "../../../types/config";

export type { MapProvider } from "../../../maps/mapStyle";

/** [lon, lat] tuple for map coordinates. */
export type Coordinate = [number, number];

export type LinkMode = "selected" | "all" | "mynode";

/** `lastRxTime` is `NeighborInfo.last_rx_time` from the protobuf — Unix epoch
 *  seconds, NOT ms. Multiply by 1000 before comparing to `Date.now()`. */
export interface IMapNeighbor {
  id: string;
  snr: number;
  distance: number;
  lastRxTime?: number;
}

export type IMapNode = INode & {
  online: boolean;
  map_position?: Coordinate; // [lon, lat]
  neighbors?: IMapNeighbor[];
};

export type IFeatureNode = {
  id: string;
  shortname?: string;
  longname?: string;
  last_seen?: string;
  gateway?: string | null;
  position: Coordinate; // [lon, lat]
  online: boolean;
  neighbors?: IMapNeighbor[];
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
  neighbors?: IMapNeighbor[];
};

export type NodeDetailsData = {
  node: NodeLike;
  liveNodes: Record<string, IMapNode>;
  displayName: string;
  elsewhereLinks?: ElsewhereLink[];
  traceroutes?: ITraceroutesResponse[];
  channelLabel?: string;
  heardBy: string[];
  maxRangeKm?: number | null;
};

