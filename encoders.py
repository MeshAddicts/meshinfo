#!/usr/bin/env python3

import datetime
import json


class _JSONEncoder(json.JSONEncoder):
  def default(self, obj):
    if isinstance(obj, datetime.datetime):
      return obj.astimezone().isoformat()
    if isinstance(obj, datetime.timedelta):
      return None
    return obj


# Keys whose string values are node IDs and may carry a leading '!'. Stripping
# is only correct on these — applying it to every string value silently mangles
# chat text and any other free-form payload field containing '!'.
_ID_KEYS = frozenset({"id", "sender", "from", "to", "gateway"})


class _JSONDecoder(json.JSONDecoder):
  def __init__(self, *args, **kwargs):
    json.JSONDecoder.__init__(
      self, object_hook=self.object_hook, *args, **kwargs)

  def object_hook(self, obj):
    ret = {}
    for key, value in obj.items():
      if key in {'last_seen', 'last_geocoding'}:
        if value is None:
          # DB rows can return NULL last_seen/last_geocoding; pre-2026 fromisoformat
          # would raise TypeError here and abort the whole packet.
          ret[key] = None
        else:
          try:
            ret[key] = datetime.datetime.fromisoformat(value)
          except (TypeError, ValueError):
            ret[key] = None
      elif key in _ID_KEYS and isinstance(value, str):
        ret[key] = value.replace('!', '')
      else:
        ret[key] = value
    return ret
