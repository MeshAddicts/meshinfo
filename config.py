
import datetime
import json
import uuid

class Config:
  @classmethod
  def load(cls):
    config = cls.load_from_file('config.json')
    random_uuid = str(uuid.uuid4())
    config['broker']['client_id'] = config['broker']['client_id_prefix'] + '-' + random_uuid
    config['server']['start_time'] = datetime.datetime.now(datetime.timezone.utc).astimezone()

    try:
      version_info = cls.load_from_file('version-info.json')
      if version_info is not None:
        config['server']['version_info'] = version_info
    except FileNotFoundError:
      pass

    return config

  @classmethod
  def load_from_file(cls, path):
    with open(path, 'r') as f:
      return json.load(f)

  @classmethod
  def cleanse(cls, config):
    config_clean = config.deepcopy()
    blacklist = {
        "config": {
            "broker": {
                "password": {},
                "username": {},
            },
            "integrations": {
                "discord": {
                    "token": {},
                },
                "geocoding": {
                    "geocode.maps.co": {
                        "api_key": {},
                    }
                }
            }
        }
    }

    def recursive_filter_dict(d, blacklist):
        for key, value in list(d.items()):
            if key in blacklist:
                del d[key]
            elif isinstance(value, dict):
                recursive_filter_dict(value, blacklist[key] if key in blacklist else {})

    recursive_filter_dict(config_clean, blacklist)
    return config_clean
