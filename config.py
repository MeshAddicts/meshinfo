
import datetime
import uuid
import yaml

class Config:
  @classmethod
  def load(cls):
    config = cls.load_from_file('config.yaml')
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
      return yaml.safe_load(f)
