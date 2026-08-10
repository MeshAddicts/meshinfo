export interface IConfigResponse {
  mesh?: Mesh;
  broker?: Broker;
  paths?: Paths;
  server?: Server;
  integrations?: Integrations;
  debug?: boolean;
}

export interface Broker {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  client_id_prefix?: string;
  topics?: string[];
  decoders?: Decoders;
  channels?: Channels;
  client_id?: string;
}

export interface Channels {
  encryption?: Encryption[];
  /** Which channels the Chat UI shows; display-only, ingest stores everything. */
  mode?: "presets" | "all" | "manual";
  /** Allowlist of channel-hash ids; only honored when mode = "manual". */
  display?: string[];
  /** Per-bucket annotation (label/short/preset/description); honored in every mode. */
  meta?: Record<string, ChannelMeta>;
  /** Hand-curated Chat tabs; only honored when mode = "manual". */
  views?: ChannelView[];
}

export interface ChannelMeta {
  label?: string;
  short?: string;
  preset?: string;
  description?: string;
}

export interface ChannelView {
  id?: string;
  label?: string;
  short?: string;
  channels?: string[];
  default?: boolean;
  description?: string;
}

export interface Encryption {
  key?: string;
  key_name?: string;
}

export interface Decoders {
  protobuf?: JSON;
  json?: JSON;
}

export interface JSON {
  enabled?: boolean;
}

export interface Integrations {
  discord?: Discord;
  geocoding?: Geocoding;
}

export interface Discord {
  enabled?: boolean;
  token?: string;
  guild?: string;
}

export interface Geocoding {
  enabled?: boolean;
  provider?: string;
  "geocode.maps.co"?: GeocodeMapsCo;
}

export interface GeocodeMapsCo {
  api_key?: string;
}

export interface Mesh {
  name?: string;
  shortname?: string;
  description?: string;
  /** Optional logo (path or URL) shown in the collapsed nav rail; falls back
   *  to the mesh name's first letter when unset. */
  icon?: string;
  url?: string;
  contact?: string;
  country?: string;
  region?: string;
  metro?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  timezone?: string;
  announce?: Announce;
  tools?: Tool[];
  elsewhere_links?: ElsewhereLink[];
}

export interface Announce {
  enabled?: boolean;
  interval?: number;
}

export interface Tool {
  name?: string;
  url?: string;
}

export interface ElsewhereLink {
  name?: string;
  url?: string;
}

export interface Paths {
  backups?: string;
  data?: string;
  output?: string;
  templates?: string;
}

export interface Server {
  node_id?: string;
  base_url?: string;
  node_activity_prune_threshold?: number;
  timezone?: string;
  intervals?: Intervals;
  backups?: Announce;
  enrich?: Enrich;
  graph?: Graph;
  start_time?: Date;
  version_info?: VersionInfo;
}

export interface VersionInfo {
  refName?: string;
}

export interface Enrich {
  enabled?: boolean;
  interval?: number;
  provider?: string;
}

export interface Graph {
  enabled?: boolean;
  max_depth?: number;
}

export interface Intervals {
  data_save?: number;
  render?: number;
}
