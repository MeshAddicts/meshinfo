#!/usr/bin/env python3

import datetime
import json

class _JSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (datetime.date, datetime.datetime)):
            return obj.astimezone().isoformat()
        if isinstance(obj, str) and obj.startswith('!'):
            return json.JSONEncoder.default(obj[1:])
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
            elif key in {'id'}:
                if isinstance(value, str):
                    if value.startswith('!'):
                        ret[key] = value[1:]
                    else:
                        ret[key] = value
                else:
                    ret[key] = value
            else:
                ret[key] = value
        return ret
