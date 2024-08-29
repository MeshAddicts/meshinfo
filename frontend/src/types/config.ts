export interface IConfigResponse {
  mesh: Mesh;
  broker: Broker;
  paths: Paths;
  server: Server;
  integrations: Integrations;
  debug: boolean;
}

export interface Broker {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  client_id_prefix: string;
  topics: string[];
  decoders: Decoders;
  channels: Channels;
  client_id: string;
}

export interface Channels {
  encryption: Encryption[];
  display: string[];
}

export interface Encryption {
  key: string;
  key_name: string;
}

export interface Decoders {
  protobuf: JSON;
  json: JSON;
}

export interface JSON {
  enabled: boolean;
}

export interface Integrations {
  discord: Discord;
  geocoding: Geocoding;
}

export interface Discord {
  enabled: boolean;
  token: string;
  guild: string;
}

export interface Geocoding {
  enabled: boolean;
  provider: string;
  "geocode.maps.co": GeocodeMapsCo;
}

export interface GeocodeMapsCo {
  api_key: string;
}

export interface Mesh {
  name: string;
  shortname: string;
  description: string;
  url: string;
  contact: string;
  country: string;
  region: string;
  metro: string;
  latitude: number;
  longitude: number;
  altitude: number;
  timezone: string;
  announce: Announce;
  tools: Tool[];
}

export interface Announce {
  enabled: boolean;
  interval: number;
}

export interface Tool {
  name: string;
  url: string;
}

export interface Paths {
  backups: string;
  data: string;
  output: string;
  templates: string;
}

export interface Server {
  node_id: string;
  base_url: string;
  node_activity_prune_threshold: number;
  timezone: string;
  intervals: Intervals;
  backups: Announce;
  enrich: Enrich;
  graph: Graph;
  start_time: Date;
  version_info?: VersionInfo;
}

export interface VersionInfo {
  refName: string;
}

export interface Enrich {
  enabled: boolean;
  interval: number;
  provider: string;
}

export interface Graph {
  enabled: boolean;
  max_depth: number;
}

export interface Intervals {
  data_save: number;
  render: number;
}
