#!/usr/bin/env python3

from geo import distance_between_two_points

def calculate_distance_between_nodes(node1, node2):
  if node1 is None or node2 is None:
    return None
  if node1["position"] is None or node2["position"] is None:
    return None
  return round(distance_between_two_points(
    node1["position"]["latitude_i"] / 10000000,
    node1["position"]["longitude_i"] / 10000000,
    node2["position"]["latitude_i"] / 10000000,
    node2["position"]["longitude_i"] / 10000000
  ), 2)

def convert_node_id_from_int_to_hex(id: int):
  return f'{id:x}'

def convert_node_id_from_hex_to_int(id: str):
  if id.startswith('!'):
      id = id.replace('!', '')
  return int(id, 16)
