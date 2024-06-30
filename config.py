
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
    return config

  @classmethod
  def load_from_file(cls, path):
    with open(path, 'r') as f:
      return json.load(f)
