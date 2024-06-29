
import datetime


class Config:
  @classmethod
  def load(cls):
    return {
      'broker': {
          'host': 'localhost',
          'port': 1883,
          'client_id': 'meshinfo',
          'topic': 'msh/2/json/#',
          'username': 'username',
          'password': 'password',
      },
      'paths': {
          'data': 'output/data',
          'output': 'output/static-html',
          'templates': 'templates'
      },
      'server': {
          'node_id': '!4355f528',
          'node_activity_prune_threshold': 7200,
          'timezone': 'America/Los_Angeles',
          'start_time': datetime.datetime.now(datetime.timezone.utc).astimezone(),
          'intervals': {
            'data_save': 60,
            'render': 5
          }
      },
      'mesh': {
          'name': 'Sac Valley Mesh',
          'shortname': 'SVM',
          'description': 'Serving Meshtastic to the Sacramento Valley and surrounding areas.',
          'url': 'https://sacvalleymesh.com',
          'contact': 'https://sacvalleymesh.com',
          'country': 'US',
          'region': 'California',
          'metro': 'Sacramento',
          'latitude': 38.58,
          'longitude': -121.49,
          'altitude': 0,
          'timezone': 'America/Los_Angeles',
          'announce': {
            'enabled': True,
            'interval': 60,
          },
      },
      'integrations': {
          'discord': {
            'enabled': True,
            'token': 'token',
            'channel': '1247618108810596392',
            'webhook': 'webhook',
          },
      }
    }
