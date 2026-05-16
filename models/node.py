import datetime

# Placeholder; the real 'since' is set on the first packet via update_node.
_ZERO_DELTA = datetime.timedelta(0)


class Node():
  @staticmethod
  def default_node(id: str):
    id = id.replace('!', '')
    now = datetime.datetime.now(datetime.timezone.utc).astimezone()
    if id == 'ffffffff':
      return {
        'id': id,
        'neighborinfo': None,
        'hardware': None,
        'longname': 'Everyone',
        'shortname': 'ALL',
        'position': None,
        'telemetry': None,
        'gateway': None,
        'last_channel': None,
        'active': False,
        'since': _ZERO_DELTA,
        'last_seen': now.isoformat()
      }

    return {
      'id': id,
      'neighborinfo': None,
      'hardware': None,
      'longname': 'Unknown',
      'shortname': 'UNK',
      'position': None,
      'telemetry': None,
      'gateway': None,
      'last_channel': None,
      'active': True,
      'since': _ZERO_DELTA,
      'last_seen': now.isoformat()
    }
