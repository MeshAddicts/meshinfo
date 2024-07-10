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

class _JSONDecoder(json.JSONDecoder):
  def __init__(self, *args, **kwargs):
    json.JSONDecoder.__init__(
      self, object_hook=self.object_hook, *args, **kwargs)

  def object_hook(self, obj):
    ret = {}
    for key, value in obj.items():
      if key in {'last_seen', 'last_geocoding'}:
        ret[key] = datetime.datetime.fromisoformat(value)
      elif key in {'id'}:
        if isinstance(value, str):
          ret[key] = value.replace('!', '')
        else:
          ret[key] = value
      elif key in {'sender'}:
        if isinstance(value, str):
          ret[key] = value.replace('!', '')
        else:
          ret[key] = value
      else:
        if isinstance(value, str):
          ret[key] = value.replace('!', '')
        else:
          ret[key] = value
    return ret
