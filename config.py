
import datetime
import json

class Config:
  @classmethod
  def load(cls):
    config = cls.load_from_file('config.json')
    config['server']['start_time'] = datetime.datetime.now(datetime.timezone.utc).astimezone()
    return config

  @classmethod
  def load_from_file(cls, path):
    with open(path, 'r') as f:
      return json.load(f)
