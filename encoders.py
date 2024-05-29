#!/usr/bin/env python3

import datetime
import json

class _JSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (datetime.date, datetime.datetime)):
            return obj.astimezone().isoformat()
        return json.JSONEncoder.default(obj)

class _JSONDecoder(json.JSONDecoder):
    def __init__(self, *args, **kwargs):
        json.JSONDecoder.__init__(
            self, object_hook=self.object_hook, *args, **kwargs)

    def object_hook(self, obj):
        ret = {}
        for key, value in obj.items():
            if key in {'last_seen'}:
                ret[key] = datetime.datetime.fromisoformat(value)
            else:
                ret[key] = value
        return ret
