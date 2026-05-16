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


# Node-id keys may carry a leading '!'; stripping is only correct on these,
# not on free-form text payloads that legitimately contain '!'.
_ID_KEYS = frozenset({"id", "sender", "from", "to", "gateway"})


class _JSONDecoder(json.JSONDecoder):
  def __init__(self, *args, **kwargs):
    json.JSONDecoder.__init__(
      self, object_hook=self.object_hook, *args, **kwargs)

  def object_hook(self, obj):
    ret = {}
    for key, value in obj.items():
      if key in {'last_seen', 'last_geocoding'}:
        # DB rows often arrive with NULL here.
        if value is None:
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
