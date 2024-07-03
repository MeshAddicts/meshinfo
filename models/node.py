import datetime

class Node():
  @staticmethod
  def default_node(id: str):
    id = id.replace('!', '')
    if id == 'ffffffff':
      return {
        'id': id,
        'neighborinfo': None,
        'hardware': None,
        'longname': 'Everyone',
        'shortname': 'ALL',
        'position': None,
        'telemetry': None,
        'active': False,
        'last_seen': datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
      }

    return {
      'id': id,
      'neighborinfo': None,
      'hardware': None,
      'longname': 'Unknown',
      'shortname': 'UNK',
      'position': None,
      'telemetry': None,
      'active': True,
      'last_seen': datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat()
    }
