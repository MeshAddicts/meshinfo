export interface IChatResponse {
  channels: Record<string, IChannel>;
}

export interface IStatsResponse {
  active_nodes: number;
  total_chat: number;
  total_nodes: number;
  total_messages: number;
  total_mqtt_messages: number;
  /** All-time gateway uplinks (#526); mqtt_messages counts logical packets. */
  total_receptions?: number;
  total_telemetry: number;
  total_traceroutes: number;
  /** Nodes heard in the last 6 hours — same window as the map's online dot. */
  online_nodes?: number;
  /** Hardware split (#579), keyed by stringified HardwareModel enum id. */
  nodes_by_hardware?: Record<string, number>;
  online_nodes_by_hardware?: Record<string, number>;
}

export interface ITelemetryResponse {
  channel: number;
  decoded: {
    payload: string;
    portnum: number;
  };
  from: string;
  hop_limit?: number;
  hop_start?: number;
  id: number;
  payload: { [key: string]: number };
  rssi: number;
  rx_rssi?: number;
  rx_snr?: number;
  rx_time?: number;
  snr: number;
  timestamp: number;
  to: string;
  topic: string;
  type: "telemetry";
  priority?: number;
}

export interface ITraceroutesResponse {
  channel: number;
  decoded?: {
    portnum: number;
    request_id?: number;
    want_response?: boolean;
  };
  from: string;
  hop_start?: number;
  id: number;
  /** Reply rows: the request's packet id (exact exchange pairing). */
  packet_id?: number | null;
  /** Server ingest time, epoch seconds (slim rows + SSE events). */
  created_at?: number | null;
  /** Resolved return-path hops, return-travel order. */
  route_back_ids?: (string | number)[];
  /** RouteDiscovery. SNR arrays ×4-scaled, -128 = unknown; snr_towards length = route + 1
   *  marks a REPLY — walk via orientTraceroute only. Slim rows omit payload.route. */
  payload: {
    route?: (string | number)[];
    route_back?: (string | number)[];
    snr_towards?: number[];
    snr_back?: number[];
  };
  route?: string[];
  route_ids?: string[];
  /** null/absent = no RF measurement (self-gatewayed or bridged copies). */
  rssi?: number | null;
  rx_rssi?: number;
  rx_snr?: number;
  rx_time?: number;
  snr?: number | null;
  timestamp: number;
  to: string;
  topic?: string;
  type: "traceroute";
  want_ack?: boolean;
  hop_limit?: number;
  hops_away?: number;
  sender?: string;
}

export interface IChannel {
  messages: IMessage[];
  /** All-time message count for the bucket. */
  totalMessages: number;
  /** Count within the requested range (== totalMessages at range "all"). */
  recentMessages?: number;
  /** Unix epoch of the bucket's newest message, null when empty. */
  newestTimestamp?: number | null;
  /** Wire-healed channel name, or a "General"/"Channel N" placeholder. */
  name: string;
}

/** /v1/channels — the message-free sibling of IChatResponse. */
export interface IChannelsResponse {
  channels: Record<string, Omit<IChannel, "messages">>;
}

export interface IMessage {
  /**
   * ID is not unique
   */
  id: number;
  to: string;
  from: string;
  sender: string[];
  hops_away: number;
  timestamp: number;
  message: string;
  text: string;
}

export type INodesResponse = Record<string, INode>;

export interface INode {
  id: string;
  active: boolean;
  shortname: string;
  longname: string;
  location: string;
  status: string;
  last_seen: string;
  hardware: number | null;
  role?: NodeRole;
  gateway?: string | null;
  last_channel?: string | null;
  position?: INodePosition;
  telemetry?: { [key: string]: number } | null;
  neighborinfo?: {
    last_sent_by_id: string;
    neighbors_count: number;
    node_broadcast_interval_secs: number;
    node_id: number;
    neighbors?: INeighbor[];
  };
}

export enum NodeRole {
  CLIENT = 0,
  CLIENT_MUTE = 1,
  ROUTER = 2,
  ROUTER_CLIENT = 3,
  REPEATER = 4,
  TRACKER = 5,
  SENSOR = 6,
  TAK = 7,
  CLIENT_HIDDEN = 8,
  LOST_AND_FOUND = 9,
  TAK_TRACKER = 10,
  ROUTER_LATE = 11,
  CLIENT_BASE = 12,
}

export const roleTitles: {
  [key in NodeRole]: { title: string; abbreviation: string };
} = {
  [NodeRole.CLIENT]: { title: "Client", abbreviation: "C" },
  [NodeRole.CLIENT_MUTE]: { title: "Client Mute", abbreviation: "CM" },
  [NodeRole.ROUTER]: { title: "Router", abbreviation: "R" },
  [NodeRole.ROUTER_CLIENT]: { title: "Router Client", abbreviation: "RC" },
  [NodeRole.REPEATER]: { title: "Repeater", abbreviation: "RE" },
  [NodeRole.TRACKER]: { title: "Tracker", abbreviation: "T" },
  [NodeRole.SENSOR]: { title: "Sensor", abbreviation: "S" },
  [NodeRole.TAK]: { title: "TAK", abbreviation: "TAK" },
  [NodeRole.CLIENT_HIDDEN]: { title: "Client Hidden", abbreviation: "CH" },
  [NodeRole.LOST_AND_FOUND]: { title: "Lost and Found", abbreviation: "LF" },
  [NodeRole.TAK_TRACKER]: { title: "TAK Tracker", abbreviation: "TT" },
  [NodeRole.ROUTER_LATE]: { title: "Router Late", abbreviation: "RL" },
  [NodeRole.CLIENT_BASE]: { title: "Client Base", abbreviation: "CB" },
};

export interface INeighbor {
  last_rx_time: number;
  node_broadcast_interval_secs: number;
  node_id: number;
  snr: number;
  distance?: number;
}

export interface INodePosition {
  altitude?: number;
  /** Height above WGS84 ellipsoid; alternative datum some devices report instead of MSL. */
  altitude_hae?: number;
  /** Geoid undulation N, where MSL = HAE − N. */
  altitude_geoidal_separation?: number;
  /** Meshtastic LocSource enum: 1=manual, 2=internal GPS, 3=external GPS. */
  location_source?: number;
  /** Meshtastic AltSource enum: 1=manual, 2=internal, 3=external, 4=barometric. */
  altitude_source?: number;
  latitude_i: number;
  latitude: number;
  longitude_i: number;
  longitude: number;
  precision_bits?: number;
  time?: number;
  PDOP?: number;
  ground_speed?: number;
  sats_in_view?: number;
  ground_track?: number;
  timestamp?: number;
  geocoded?: {
    display_name: string;
  };
}

export enum HardwareModel {
  UNSET = 0,
  TLORA_V2 = 1,
  TLORA_V1 = 2,
  TLORA_V2_1_1P6 = 3,
  TBEAM = 4,
  HELTEC_V2_0 = 5,
  TBEAM_V0P7 = 6,
  T_ECHO = 7,
  TLORA_V1_1P3 = 8,
  RAK4631 = 9,
  HELTEC_V2_1 = 10,
  HELTEC_V1 = 11,
  LILYGO_TBEAM_S3_CORE = 12,
  RAK11200 = 13,
  NANO_G1 = 14,
  TLORA_V2_1_1P8 = 15,
  TLORA_T3_S3 = 16,
  NANO_G1_EXPLORER = 17,
  NANO_G2_ULTRA = 18,
  LORA_TYPE = 19,
  WIPHONE = 20,
  WIO_WM1110 = 21,
  WISMESH_HUB = 22, // proto name: RAK2560
  HELTEC_HRU_3601 = 23,
  HELTEC_WIRELESS_BRIDGE = 24,
  STATION_G1 = 25,
  RAK11310 = 26,
  SENSELORA_RP2040 = 27,
  SENSELORA_S3 = 28,
  CANARYONE = 29,
  RP2040_LORA = 30,
  STATION_G2 = 31,
  LORA_RELAY_V1 = 32,
  T_ECHO_PLUS = 33,
  PPR = 34,
  GENIEBLOCKS = 35,
  NRF52_UNKNOWN = 36,
  PORTDUINO = 37,
  ANDROID_SIM = 38,
  DIY_V1 = 39,
  NRF52840_PCA10059 = 40,
  DR_DEV = 41,
  M5STACK = 42,
  HELTEC_V3 = 43,
  HELTEC_WSL_V3 = 44,
  BETAFPV_2400_TX = 45,
  BETAFPV_900_NANO_TX = 46,
  RPI_PICO = 47,
  HELTEC_WIRELESS_TRACKER = 48,
  HELTEC_WIRELESS_PAPER = 49,
  T_DECK = 50,
  T_WATCH_S3 = 51,
  PICOMPUTER_S3 = 52,
  HELTEC_HT62 = 53,
  EBYTE_ESP32_S3 = 54,
  ESP32_S3_PICO = 55,
  CHATTER_2 = 56,
  HELTEC_WIRELESS_PAPER_V1_0 = 57,
  HELTEC_WIRELESS_TRACKER_V1_0 = 58,
  UNPHONE = 59,
  TD_LORAC = 60,
  CDEBYTE_EORA_S3 = 61,
  TWC_MESH_V4 = 62,
  NRF52_PROMICRO_DIY = 63,
  RADIOMASTER_900_BANDIT_NANO = 64,
  HELTEC_CAPSULE_SENSOR_V3 = 65,
  HELTEC_VISION_MASTER_T190 = 66,
  HELTEC_VISION_MASTER_E213 = 67,
  HELTEC_VISION_MASTER_E290 = 68,
  HELTEC_MESH_NODE_T114 = 69,
  SENSECAP_INDICATOR = 70,
  TRACKER_T1000_E = 71,
  RAK3172 = 72,
  WIO_E5 = 73,
  RADIOMASTER_900_BANDIT = 74,
  ME25LS01_4Y10TD = 75,
  RP2040_FEATHER_RFM95 = 76,
  M5STACK_COREBASIC = 77,
  M5STACK_CORE2 = 78,
  RPI_PICO2 = 79,
  M5STACK_CORES3 = 80,
  SEEED_XIAO_S3 = 81,
  MS24SF1 = 82,
  TLORA_C6 = 83,
  WISMESH_TAP = 84,
  ROUTASTIC = 85,
  MESH_TAB = 86,
  MESHLINK = 87,
  XIAO_NRF52_KIT = 88,
  THINKNODE_M1 = 89,
  THINKNODE_M2 = 90,
  T_ETH_ELITE = 91,
  HELTEC_SENSOR_HUB = 92,
  MUZI_BASE = 93,
  HELTEC_MESH_POCKET = 94,
  SEEED_SOLAR_NODE = 95,
  NOMADSTAR_METEOR_PRO = 96,
  CROWPANEL = 97,
  LINK_32 = 98,
  SEEED_WIO_TRACKER_L1 = 99,
  SEEED_WIO_TRACKER_L1_EINK = 100,
  MUZI_R1_NEO = 101,
  T_DECK_PRO = 102,
  T_LORA_PAGER = 103,
  M5STACK_RESERVED = 104,
  WISMESH_TAG = 105,
  RAK3312 = 106,
  THINKNODE_M5 = 107,
  HELTEC_MESH_SOLAR = 108,
  T_ECHO_LITE = 109,
  HELTEC_V4 = 110,
  M5STACK_C6L = 111,
  M5STACK_CARDPUTER_ADV = 112,
  HELTEC_WIRELESS_TRACKER_V2 = 113,
  T_WATCH_ULTRA = 114,
  THINKNODE_M3 = 115,
  WISMESH_TAP_V2 = 116,
  RAK3401 = 117,
  RAK6421 = 118,
  THINKNODE_M4 = 119,
  THINKNODE_M6 = 120,
  MESHSTICK_1262 = 121,
  TBEAM_1_WATT = 122,
  T5_S3_EPAPER_PRO = 123,
  TBEAM_BPF = 124,
  MINI_EPAPER_S3 = 125,
  TDISPLAY_S3_PRO = 126,
  HELTEC_MESH_NODE_T096 = 127,
  MESH_TRACKER_X1 = 128,
  THINKNODE_M7 = 129,
  THINKNODE_M8 = 130,
  THINKNODE_M9 = 131,
  HELTEC_V4_R8 = 132,
  HELTEC_MESH_NODE_T1 = 133,
  STATION_G3 = 134,
  T_IMPULSE_PLUS = 135,
  T_ECHO_CARD = 136,
  SEEED_WIO_TRACKER_L2 = 137,
  CROWPANEL_P4 = 138,
  HELTEC_MESH_TOWER_V2 = 139,
  MESHNOLOGY_W10 = 140,
  HELTEC_RC32 = 141,
  HELTEC_RC52 = 142,
  HELTEC_RCC6 = 143,
  PRIVATE_HW = 255,
}

export const HARDWARE_PHOTOS: { [key in HardwareModel]?: string } = {
  [HardwareModel.HELTEC_HT62]: "HELTEC_HT62.png",
  [HardwareModel.HELTEC_V2_0]: "HELTEC_V2_0.png",
  [HardwareModel.HELTEC_V2_1]: "HELTEC_V2_1.png",
  [HardwareModel.HELTEC_V3]: "HELTEC_V3.png",
  [HardwareModel.HELTEC_WIRELESS_PAPER]: "HELTEC_WIRELESS_PAPER.png",
  [HardwareModel.HELTEC_WIRELESS_PAPER_V1_0]: "HELTEC_WIRELESS_PAPER_V1_0.png",
  [HardwareModel.HELTEC_WIRELESS_TRACKER]: "HELTEC_WIRELESS_TRACKER.png",
  [HardwareModel.HELTEC_WIRELESS_TRACKER_V1_0]:
    "HELTEC_WIRELESS_TRACKER_V1_0.png",
  [HardwareModel.HELTEC_WSL_V3]: "HELTEC_WSL_V3.png",
  [HardwareModel.LILYGO_TBEAM_S3_CORE]: "LILYGO_TBEAM_S3_CORE.png",
  [HardwareModel.NANO_G1_EXPLORER]: "NANO_G1_EXPLORER.png",
  [HardwareModel.NANO_G2_ULTRA]: "NANO_G2_ULTRA.png",
  [HardwareModel.NRF52_PROMICRO_DIY]: "NRF52_PROMICRO_DIY.png",
  [HardwareModel.RAK11310]: "RAK11310.png",
  [HardwareModel.RAK4631]: "RAK4631.png",
  [HardwareModel.RP2040_LORA]: "RP2040_LORA.png",
  [HardwareModel.RPI_PICO]: "RPI_PICO.png",
  [HardwareModel.TBEAM]: "TBEAM.png",
  [HardwareModel.TLORA_T3_S3]: "TLORA_T3_S3.png",
  [HardwareModel.TLORA_V2_1_1P6]: "TLORA_V2_1_1P6.png",
  [HardwareModel.T_DECK]: "T_DECK.png",
  [HardwareModel.T_ECHO]: "T_ECHO.png",
  [HardwareModel.T_WATCH_S3]: "T_WATCH_S3.png",
  [HardwareModel.PRIVATE_HW]: "PRIVATE_HW.png",
  [HardwareModel.HELTEC_VISION_MASTER_T190]: "heltec-vision-master-t190.webp",
  [HardwareModel.HELTEC_VISION_MASTER_E213]: "heltec-vision-master-e213.webp",
  [HardwareModel.HELTEC_VISION_MASTER_E290]: "heltec-vision-master-e290.webp",
  [HardwareModel.HELTEC_MESH_NODE_T114]: "heltec-mesh-node-t114.webp",
  [HardwareModel.SENSECAP_INDICATOR]: "seeed-sensecap-indicator.webp",
  [HardwareModel.TRACKER_T1000_E]: "tracker-t1000-e.webp",
  [HardwareModel.SEEED_XIAO_S3]: "seeed-xiao-s3.webp",
  [HardwareModel.WISMESH_TAP]: "rak-wismeshtap.webp",
  [HardwareModel.XIAO_NRF52_KIT]: "seeed_xiao_nrf52_kit.webp",
  [HardwareModel.THINKNODE_M1]: "thinknode_m1.webp",
  [HardwareModel.THINKNODE_M2]: "thinknode_m2.webp",
  [HardwareModel.THINKNODE_M5]: "thinknode_m1.webp",
  [HardwareModel.MUZI_BASE]: "muzi_base.webp",
  [HardwareModel.HELTEC_MESH_POCKET]: "heltec_mesh_pocket.webp",
  [HardwareModel.SEEED_SOLAR_NODE]: "seeed_solar.webp",
  [HardwareModel.WISMESH_TAG]: "rak_wismesh_tag.webp",
  [HardwareModel.WISMESH_HUB]: "rak2560.webp",
  [HardwareModel.T_ECHO_PLUS]: "t-echo_plus.svg",
};

export interface IMqttMessagesResponse {
  channel: number;
  decoded: {
    payload: string;
    portnum: number;
    want_response?: boolean;
    request_id?: number;
  };
  from: string;
  hop_limit?: number;
  hop_start: number;
  id: number;
  rx_rssi?: number;
  rx_snr?: number;
  rx_time: number;
  to: string;
  rssi: number;
  snr: number;
  timestamp: number;
  topic: string;
  type: "nodeinfo" | "telemetry";
  payload?: unknown;
  priority?: number;
}
