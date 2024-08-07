export interface IChatResponse {
  channels: Record<string, IChannel>;
}

export interface IChannel {
  messages: IMessage[];
  totalMessages: number;
  name: string;
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
  shortname: string;
  longname: string;
  location: string;
  status: string;
  last_seen: string;
  hardware: number | null;
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

export interface INeighbor {
  node_id: number;
  snr: number;
  distance?: number;
}
export interface INodePosition {
  altitude?: number;
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
  RAK2560 = 22,
  HELTEC_HRU_3601 = 23,
  STATION_G1 = 25,
  RAK11310 = 26,
  SENSELORA_RP2040 = 27,
  SENSELORA_S3 = 28,
  CANARYONE = 29,
  RP2040_LORA = 30,
  STATION_G2 = 31,
  LORA_RELAY_V1 = 32,
  NRF52840DK = 33,
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
  PRIVATE_HW = 255,
}
