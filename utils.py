#!/usr/bin/env python3
import datetime
import logging
import requests
from geo import distance_between_two_points
logger = logging.getLogger(__name__)
def calculate_distance_between_nodes(node1, node2):
  if node1 is None or node2 is None:
    return None
  if node1["position"] is None or node2["position"] is None:
    return None
  if 'latitude_i' not in node1["position"] or 'longitude_i' not in node1["position"] or 'latitude_i' not in node2["position"] or 'longitude_i' not in node2["position"] or node1["position"]["latitude_i"] is None or node1["position"]["longitude_i"] is None or node2["position"]["latitude_i"] is None or node2["position"]["longitude_i"] is None:
    return None
  return round(distance_between_two_points(
    node1["position"]["latitude_i"] / 10000000,
    node1["position"]["longitude_i"] / 10000000,
    node2["position"]["latitude_i"] / 10000000,
    node2["position"]["longitude_i"] / 10000000
  ), 2)
def convert_node_id_from_int_to_hex(id: int):
  id_hex = f'{id:08x}'
  return id_hex
def convert_node_id_from_hex_to_int(id: str):
  if id.startswith('!'):
      id = id[1:]
  if not all(c in '0123456789abcdefABCDEF' for c in id):
      return None
  return int(id, 16)
def normalize_node_id(value):
  """Coerce a node id (int from protobuf, str from JSON) to canonical 8-char
  lowercase hex, or None if invalid. Accepts a single leading '!' and short
  hex (left-padded). Rejects ints outside uint32 and embedded '!' chars."""
  if value is None:
    return None
  if isinstance(value, int):
    # uint32 only — schema is VARCHAR(8). bool subclasses int intentionally.
    if 0 <= value <= 0xffffffff:
      return convert_node_id_from_int_to_hex(value)
    return None
  if isinstance(value, str):
    s = value.lower()
    if s.startswith('!'):
      s = s[1:]
    # Embedded '!' (e.g. "ab!cd") is rejected by the hex-only check below.
    if 1 <= len(s) <= 8 and all(c in '0123456789abcdef' for c in s):
      return s.rjust(8, '0')
  return None
def days_since_datetime(dt: datetime.datetime):
  # Returns the number of days since the given datetime using UTC
  now = datetime.datetime.now(datetime.timezone.utc)
  if isinstance(dt, str):
    dt = datetime.datetime.fromisoformat(dt)
  diff = now - dt
  return diff.days
def geocode_position(api_key: str, latitude: float, longitude: float):
  if latitude is None or longitude is None:
    return None
  logger.debug("Geocoding %s, %s", latitude, longitude)
  url = f"https://geocode.maps.co/reverse?lat={latitude}&lon={longitude}&api_key={api_key}"
  try:
    response = requests.get(url, timeout=5)
  except requests.RequestException as exc:
    logger.warning("Geocoding request failed for %s, %s: %s", latitude, longitude, exc)
    return None
  if response.status_code != 200:
    return None
  try:
    data = response.json()
  except ValueError as exc:
    logger.warning("Failed to decode geocoding response for %s, %s: %s", latitude, longitude, exc)
    return None
  logger.debug("Geocoded %s, %s to %s", latitude, longitude, data)
  return data
def filter_dict(d, whitelist):
    """
    Recursively filter a dictionary to only include whitelisted keys.
    :param d: The original dictionary or list.
    :param whitelist: A dictionary that mirrors the structure of `d` with the keys you want to keep.
                      Nested dictionaries and lists should be specified with the keys you want to retain.
    :return: A new dictionary or list containing only the whitelisted keys.
    """
    if isinstance(d, dict):
        return {
            key: filter_dict(d[key], whitelist[key]) if isinstance(d[key], (dict, list)) else d[key]
            for key in whitelist if key in d
        }
    elif isinstance(d, list):
        return [
            filter_dict(item, whitelist) if isinstance(item, dict) else item
            for item in d
        ]
    else:
        return d  # Return the value if it's neither a dict nor a list