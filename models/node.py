import datetime

# The "since" default exists only so callers don't crash when reading the field
# before update_node has set the real value. The real value is set in
# data_store.update_node:65 (now_local - last_seen) on the first packet.
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
