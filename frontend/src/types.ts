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

export type INodesResponse = Record<string, INode>;

export interface INode {
  shortname: string;
  longname: string;
  location: string;
  status: string;
  last_seen: string;
  position: {
    latitude_i: number;
    longitude_i: number;
  };
}
