import { Coordinate } from "ol/coordinate";

export interface IChatResponse {
  channels: Record<string, IChannel>;
}

export interface IChannel {
  messages: IMessage[];
  name: string;
}

export interface IMessage {
  to: string;
  from: string;
  sender: string;
  hops_away: number;
  timestamp: string;
  message: string;
  text: string;
}

export type INodesResponse = Record<string, INode & INodeResponse>;

export interface INodeResponse {
  position?: {
    latitude_i: number;
    longitude_i: number;
  };
  neighborinfo?: {
    last_sent_by_id: string;
    neighbors_count: number;
    node_broadcast_interval_secs: number;
    node_id: number;
    neighbors?: INeighbor[];
  };
}

export interface INode {
  id: string;
  shortname: string;
  longname: string;
  location: string;
  status: string;
  last_seen: string;
  position?: Coordinate;
  online?: boolean;
  neighbors?: {
    id: string;
    snr: number;
    distance?: number;
  }[];
}

export interface INeighbor {
  node_id: number;
  snr: number;
  distance?: number;
}
