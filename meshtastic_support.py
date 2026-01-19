#!/usr/bin/env python3

from enum import Enum

"""
  HardwareModel definition of Meshtastic supported hardware models
  from https://buf.build/meshtastic/protobufs/docs/main:meshtastic#meshtastic.HardwareModel
"""
class HardwareModel(Enum):
  UNSET = 0
  TLORA_V2 = 1
  TLORA_V1 = 2
  TLORA_V2_1_1P6 = 3
  TBEAM = 4
  HELTEC_V2_0 = 5
  TBEAM_V0P7 = 6
  T_ECHO = 7
  TLORA_V1_1P3 = 8
  RAK4631 = 9
  HELTEC_V2_1 = 10
  HELTEC_V1 = 11
  LILYGO_TBEAM_S3_CORE = 12
  RAK11200 = 13
  NANO_G1 = 14
  TLORA_V2_1_1P8 = 15
  TLORA_T3_S3 = 16
  NANO_G1_EXPLORER = 17
  NANO_G2_ULTRA = 18
  LORA_TYPE = 19
  WIPHONE = 20
  WIO_WM1110 = 21
  WISMESH_HUB = 22
  HELTEC_HRU_3601 = 23
  STATION_G1 = 25
  RAK11310 = 26
  SENSELORA_RP2040 = 27
  SENSELORA_S3 = 28
  CANARYONE = 29
  RP2040_LORA = 30
  STATION_G2 = 31
  LORA_RELAY_V1 = 32
  T_ECHO_PLUS = 33
  PPR = 34
  GENIEBLOCKS = 35
  NRF52_UNKNOWN = 36
  PORTDUINO = 37
  ANDROID_SIM = 38
  DIY_V1 = 39
  NRF52840_PCA10059 = 40
  DR_DEV = 41
  M5STACK = 42
  HELTEC_V3 = 43
  HELTEC_WSL_V3 = 44
  BETAFPV_2400_TX = 45
  BETAFPV_900_NANO_TX = 46
  RPI_PICO = 47
  HELTEC_WIRELESS_TRACKER = 48
  HELTEC_WIRELESS_PAPER = 49
  T_DECK = 50
  T_WATCH_S3 = 51
  PICOMPUTER_S3 = 52
  HELTEC_HT62 = 53
  EBYTE_ESP32_S3 = 54
  ESP32_S3_PICO = 55
  CHATTER_2 = 56
  HELTEC_WIRELESS_PAPER_V1_0 = 57
  HELTEC_WIRELESS_TRACKER_V1_0 = 58
  UNPHONE = 59
  TD_LORAC = 60
  CDEBYTE_EORA_S3 = 61
  TWC_MESH_V4 = 62
  NRF52_PROMICRO_DIY = 63
  RADIOMASTER_900_BANDIT_NANO = 64
  HELTEC_CAPSULE_SENSOR_V3 = 65
  HELTEC_VISION_MASTER_T190 = 66
  HELTEC_VISION_MASTER_E213 = 67
  HELTEC_VISION_MASTER_E290 = 68
  HELTEC_MESH_NODE_T114 = 69
  SENSECAP_INDICATOR = 70
  TRACKER_T1000_E = 71
  # Hardware models 72-80 are reserved in the Meshtastic protocol
  SEEED_XIAO_S3 = 81
  WISMESH_TAP = 84
  XIAO_NRF52_KIT = 88
  THINKNODE_M1 = 89
  THINKNODE_M2 = 90
  MUZI_BASE = 93
  HELTEC_MESH_POCKET = 94
  SEEED_SOLAR_NODE = 95
  WISMESH_TAG = 105
  THINKNODE_M5 = 107
  PRIVATE_HW = 255

HARDWARE_PHOTOS = {
  HardwareModel.HELTEC_HT62: "HELTEC_HT62.png",
  HardwareModel.HELTEC_V2_0: "HELTEC_V2_0.png",
  HardwareModel.HELTEC_V2_1: "HELTEC_V2_1.png",
  HardwareModel.HELTEC_V3: "HELTEC_V3.png",
  HardwareModel.HELTEC_WIRELESS_PAPER: "HELTEC_WIRELESS_PAPER.png",
  HardwareModel.HELTEC_WIRELESS_PAPER_V1_0: "HELTEC_WIRELESS_PAPER_V1_0.png",
  HardwareModel.HELTEC_WIRELESS_TRACKER: "HELTEC_WIRELESS_TRACKER.png",
  HardwareModel.HELTEC_WIRELESS_TRACKER_V1_0: "HELTEC_WIRELESS_TRACKER_V1_0.png",
  HardwareModel.HELTEC_WSL_V3: "HELTEC_WSL_V3.png",
  HardwareModel.LILYGO_TBEAM_S3_CORE: "LILYGO_TBEAM_S3_CORE.png",
  HardwareModel.NANO_G1_EXPLORER: "NANO_G1_EXPLORER.png",
  HardwareModel.NANO_G2_ULTRA: "NANO_G2_ULTRA.png",
  HardwareModel.NRF52_PROMICRO_DIY: "NRF52_PROMICRO_DIY.png",
  HardwareModel.RAK11310: "RAK11310.png",
  HardwareModel.RAK4631: "RAK4631.png",
  HardwareModel.RP2040_LORA: "RP2040_LORA.png",
  HardwareModel.RPI_PICO: "RPI_PICO.png",
  HardwareModel.TBEAM: "TBEAM.png",
  HardwareModel.TLORA_T3_S3: "TLORA_T3_S3.png",
  HardwareModel.TLORA_V2_1_1P6: "TLORA_V2_1_1P6.png",
  HardwareModel.T_DECK: "T_DECK.png",
  HardwareModel.T_ECHO: "T_ECHO.png",
  HardwareModel.T_WATCH_S3: "T_WATCH_S3.png",
  HardwareModel.PRIVATE_HW: "PRIVATE_HW.png",
  HardwareModel.HELTEC_VISION_MASTER_T190: "heltec-vision-master-t190.svg",
  HardwareModel.HELTEC_VISION_MASTER_E213: "heltec-vision-master-e213.svg",
  HardwareModel.HELTEC_VISION_MASTER_E290: "heltec-vision-master-e290.svg",
  HardwareModel.HELTEC_MESH_NODE_T114: "heltec-mesh-node-t114.svg",
  HardwareModel.SENSECAP_INDICATOR: "seeed-sensecap-indicator.svg",
  HardwareModel.TRACKER_T1000_E: "tracker-t1000-e.svg",
  HardwareModel.SEEED_XIAO_S3: "seeed-xiao-s3.svg",
  HardwareModel.WISMESH_TAP: "rak-wismeshtap.svg",
  HardwareModel.XIAO_NRF52_KIT: "seeed_xiao_nrf52_kit.svg",
  HardwareModel.THINKNODE_M1: "thinknode_m1.svg",
  HardwareModel.THINKNODE_M2: "thinknode_m2.svg",
  HardwareModel.THINKNODE_M5: "thinknode_m1.svg",  # M5 uses same image as M1 per device_hardware.json
  HardwareModel.MUZI_BASE: "muzi_base.svg",
  HardwareModel.HELTEC_MESH_POCKET: "heltec_mesh_pocket.svg",
  HardwareModel.SEEED_SOLAR_NODE: "seeed_solar.svg",
  HardwareModel.WISMESH_TAG: "rak_wismesh_tag.svg",
  HardwareModel.WISMESH_HUB: "rak2560.svg",
  HardwareModel.T_ECHO_PLUS: "t-echo_plus.svg",
}
