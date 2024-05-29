#!/usr/bin/env python3

import datetime
import json
import paho.mqtt.client as mqtt_client
import os
from jinja2 import Environment, FileSystemLoader

from encoders import _JSONDecoder, _JSONEncoder
from geo import distance_between_two_points
from meshtastic import HardwareModel
from models import Node

config = {
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
      'output': 'output',
      'templates': 'templates'
  },
  'server': {
      'node_id': '!4355f528',
      'node_activity_prune_threshold': 7200
  }
}

chat = {
    'channels': {
        '0': {
          'name': 'General',
          'messages': []
        }
    }
}
messages = []
mqtt_messages = []
mqtt_connect_time = datetime.datetime.now()
nodes = {}
telemetry = []
telemetry_by_node = {}

def connect_mqtt(broker, port, client_id, username, password):
    def on_connect(client, userdata, flags, rc, properties=None):
        global mqtt_connect_time
        if rc == 0:
            mqtt_connect_time = datetime.datetime.now()
            print("Connected to MQTT broker at %s:%d" % (broker, port))
        else:
            print("Failed to connect, error: %s\n" % rc)

    client = mqtt_client.Client(client_id=client_id, callback_api_version=mqtt_client.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    # client.username_pw_set(username, password)
    client.connect(broker, port)
    return client

def publish(client, topic, msg):
    result = client.publish(topic, msg)

    status = result[0]

    if status == 0:
        print(f"Send `{msg}` to topic `{topic}`")
        print("Done!")
        return True
    else:
        print(f"Failed to send message to topic {topic}")
        return False

def subscribe(client, topic):
    def on_message(client, userdata, msg, properties=None):
        # {"channel":0,"from":3663958104,"hops_away":2,"id":1525817618,"payload":{"hardware":43,"id":"!da639058","longname":"SMRN-SS-Ca sacvalleymesh.com","shortname":"JTRC"},"rssi":-106,"sender":"!4355f528","snr":-5.5,"timestamp":1715852073,"to":2086296284,"type":"nodeinfo"}
        # parse msg.payload.decode() from json string to object
        print(msg.payload)
        j = json.loads(msg.payload.decode(), cls=_JSONDecoder)
        handle_log(msg)
        if j['type'] == "neighborinfo":
            handle_neighborinfo(client, userdata, j)
        if j['type'] == "nodeinfo":
            handle_nodeinfo(client, userdata, j)
        if j['type'] == "position":
            handle_position(client, userdata, j)
        if j['type'] == "telemetry":
            handle_telemetry(client, userdata, j)
        if j['type'] == "text":
            handle_text(client, userdata, j)
        prune_expired_nodes()

    client.subscribe(topic)
    client.on_message = on_message

def update_node(id, node):
    node['active'] = True
    node['last_seen'] = datetime.datetime.now()
    nodes[id] = node

def convert_node_id_from_int_to_hex(id):
    return '!' + f'{id:x}'

def prune_expired_nodes():
    global config

    now = datetime.datetime.now()
    ids_to_delete = []
    for id, node in nodes.items():
        since = (now - node['last_seen']).seconds
        if node['active'] and since >= config['server']['node_activity_prune_threshold']:
            ids_to_delete.append(id)
            print(f"Node {id} pruned (last heard {since} seconds ago)")
    for id in ids_to_delete:
        nodes[id]['active'] = False

def handle_log(msg):
    global messages
    global mqtt_messages
    messages.append(msg.payload.decode())
    mqtt_messages.append(msg)
    print(f"MQTT >> {msg.topic} -- {msg.payload.decode()}")
    with open(f'{config["paths"]["data"]}/message-log.jsonl', 'a') as f:
        f.write(f"{msg.payload.decode()}\n")

def handle_neighborinfo(client, userdata, msg):
    id = '!' + f'{msg["from"]:x}'
    if id in nodes:
      node = nodes[id]
      node['neighborinfo'] = msg['payload']
      update_node(id, node)
      print(f"Node {id} updated with neighborinfo")
    else:
      node = Node.default_node(id)
      node['neighborinfo'] = msg['payload']
      update_node(id, node)
      print(f"Node {id} skeleton added with neighborinfo")
    save()

def handle_nodeinfo(client, userdata, msg):
    global nodes
    id = msg['payload']['id']
    if id in nodes:
        node = nodes[id]
        node['hardware'] = msg['payload']['hardware']
        node['longname'] = msg['payload']['longname']
        node['shortname'] = msg['payload']['shortname']
        update_node(id, node)
        print(f"Node {id} updated")
    else:
        node = Node.default_node(id)
        node['hardware'] = msg['payload']['hardware']
        node['longname'] = msg['payload']['longname']
        node['shortname'] = msg['payload']['shortname']
        update_node(id, node)
        print(f"Node {id} added")
    sort_nodes_by_shortname()
    save()

def handle_position(client, userdata, msg):
    # convert msg['from'] to hex
    id = '!' + f'{msg["from"]:x}'
    if id in nodes:
        node = nodes[id]
        node['position'] = msg['payload'] if 'payload' in msg else None
        update_node(id, node)
        print(f"Node {id} updated with position")
    else:
        node = Node.default_node(id)
        node['position'] = msg['payload'] if 'payload' in msg else None
        update_node(id, node)
        print(f"Node {id} skeleton added with position")
    save()

def handle_telemetry(client, userdata, msg):
    global nodes
    global telemetry

    id = '!' + f'{msg["from"]:x}'
    if id in nodes:
        node = nodes[id]
        node['telemetry'] = msg['payload'] if 'payload' in msg else None
        update_node(id, node)
        print(f"Node {id} updated with telemetry")
    else:
        node = Node.default_node(id)
        node['telemetry'] = msg['payload'] if 'payload' in msg else None
        update_node(id, node)
        print(f"Node {id} skeleton added with telemetry")

    if id not in telemetry_by_node:
      telemetry_by_node[id] = []
    if 'payload' in msg:
      msg['from'] = '!' + f'{msg["from"]:x}'
      msg['to'] = '!' + f'{msg["to"]:x}'
      telemetry.insert(0, msg)
      telemetry_by_node[id].insert(0, msg)

    save()

def handle_text(client, userdata, msg):
    global chat

    id = '!' + f'{msg["from"]:x}'
    to = '!' + f'{msg["to"]:x}'
    chat['channels'][str(msg['channel'])]['messages'].insert(0, {
        'id': msg['id'],
        'sender': msg['sender'],
        'from': id,
        'to': to,
        'channel': str(msg['channel']),
        'text': msg['payload']['text'],
        'timestamp': msg['timestamp'],
        'hops_away': msg['hops_away'] if 'hops_away' in msg else None,
        'rssi': msg['rssi'] if 'rssi' in msg else None,
        'snr': msg['snr'] if 'snr' in msg else None,
    })
    save()

def load_nodes_from_file():
    n = {}
    if os.path.exists("output/data/nodes.json"):
        with open("output/data/nodes.json", "r") as f:
            n = json.load(f, cls=_JSONDecoder)
    return n

def _serialize_node(node):
    """
    Serialize a node object to a format suitable for saving to an HTML file.
    """
    global config
    global nodes

    last_seen = node["last_seen"] if isinstance(node["last_seen"], datetime.datetime) else datetime.datetime.fromisoformat(node["last_seen"])
    serialized = {
        "id": node["id"],
        "shortname": node["shortname"],
        "longname": node["longname"],
        "hardware": node["hardware"],
        "position": _serialize_position(node["position"]) if node["position"] else None,
        "neighborinfo": _serialize_neighborinfo(node) if node['neighborinfo'] else None,
        "telemetry": node["telemetry"],
        "last_seen_human": last_seen.strftime("%Y-%m-%d %H:%M:%S"),
        "last_seen": last_seen,
        "since": datetime.datetime.now() - last_seen,
    }
    server_node = nodes[f'{config["server"]["node_id"]}']
    if server_node and 'position' in server_node and server_node["position"] and server_node["position"]["latitude_i"] != 0 and server_node["position"]["longitude_i"] != 0 and node["position"] and node["position"]["latitude_i"] != 0 and node["position"]["longitude_i"] != 0:
        serialized["distance_from_host_node"] = round(distance_between_two_points(
            node["position"]["latitude_i"] / 10000000,
            node["position"]["longitude_i"] / 10000000,
            server_node["position"]["latitude_i"] / 10000000,
            server_node["position"]["longitude_i"] / 10000000
          ), 2)
    return serialized

def _serialize_neighborinfo(node):
    """
    Serialize a neighborinfo object to a format suitable for saving to an HTML file.
    """
    ni = node['neighborinfo'].copy()
    ni['neighbors'] = _serialize_neighborinfo_neighbors(node) if 'neighbors' in ni else None
    return ni

def _serialize_neighborinfo_neighbors(node):
    """
    Serialize a neighborinfo object to a format suitable for saving to an HTML file.
    """
    global nodes

    from_node = nodes[node['id']]
    ns = []
    for n in node['neighborinfo']['neighbors']:
      id = convert_node_id_from_int_to_hex(n["node_id"])
      neighbor = {
        "node_id": id,
        "snr": n["snr"],
      }
      if id in nodes:
        ni = nodes[id]
        if from_node['position'] and ni['position']:
          neighbor["distance"] = round(distance_between_two_points(
            from_node["position"]["latitude_i"] / 10000000,
            from_node["position"]["longitude_i"] / 10000000,
            ni["position"]["latitude_i"] / 10000000,
            ni["position"]["longitude_i"] / 10000000
          ), 2)
      ns.append(neighbor)
    return ns

def _serialize_position(position):
    """
    Serialize a position object to a format suitable for saving to an HTML file.
    """
    if "altitude" in position:
        altitude = position["altitude"]
    else:
        altitude = None

    return {
        "altitude": altitude,
        "latitude": position["latitude_i"] / 10000000,
        "longitude": position["longitude_i"] / 10000000
    }

def sort_nodes_by_shortname():
    global nodes
    nodes = dict(sorted(nodes.items(), key=lambda item: item[1]['shortname']))

def render_static_html_files():
    global config
    global chat
    global nodes
    global telemetry

    # index.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/index.html.j2')
    rendered_html = template.render(nodes=nodes, active_nodes=nodes, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/index.html", "w") as f:
        f.write(rendered_html)

    # chat.html
    save_chat_to_file(chat, "html", f"{config['paths']['output']}/chat.html")

    # map.html
    server_node = nodes[f'{config["server"]["node_id"]}']
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/map.html.j2')
    rendered_html = template.render(server_node=server_node, nodes=nodes, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/map.html", "w") as f:
        f.write(rendered_html)

    # mesh_log.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/mesh_log.html.j2')
    rendered_html = template.render(messages=messages, json=json, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/mesh_log.html", "w") as f:
        f.write(rendered_html)

    # mqtt_log.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/mqtt_log.html.j2')
    rendered_html = template.render(messages=mqtt_messages, mqtt_connect_time=mqtt_connect_time, json=json, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/mqtt_log.html", "w") as f:
        f.write(rendered_html)

    # nodes.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/nodes.html.j2')
    active_nodes = {}
    for id, node in nodes.items():
        if 'active' in node and node['active']:
            active_nodes[id] = _serialize_node(node)
    rendered_html = template.render(nodes=nodes, active_nodes=active_nodes, hardware=HardwareModel, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/nodes.html", "w") as f:
        f.write(rendered_html)

    # neighbors.html
    active_nodes_with_neighbors = {}
    for id, node in nodes.items():
        if 'active' in node and node['active'] and 'neighborinfo' in node and node['neighborinfo']:
            active_nodes_with_neighbors[id] = _serialize_node(node)
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/neighbors.html.j2')
    rendered_html = template.render(nodes=nodes, active_nodes=active_nodes, active_nodes_with_neighbors=active_nodes_with_neighbors, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/neighbors.html", "w") as f:
        f.write(rendered_html)

    # routes.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/routes.html.j2')
    rendered_html = template.render(nodes=nodes, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/routes.html", "w") as f:
        f.write(rendered_html)

    # stats.html
    stats = {}
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/stats.html.j2')
    rendered_html = template.render(stats=stats, nodes=nodes, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/stats.html", "w") as f:
        f.write(rendered_html)

    # telemetry.html
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template = env.get_template(f'{config["paths"]["templates"]}/static/telemetry.html.j2')
    rendered_html = template.render(nodes=nodes, telemetry=telemetry, datetime=datetime.datetime, timestamp=datetime.datetime.now())
    with open(f"{config['paths']['output']}/telemetry.html", "w") as f:
        f.write(rendered_html)

def save():
    global nodes
    global chat
    global config

    start = datetime.datetime.now()
    save_nodes_to_file()
    render_static_html_files()
    end = datetime.datetime.now()
    print(f"Saved in {round(end.timestamp() - start.timestamp(), 3)} seconds")

def save_nodes_to_file():
    global config
    global chat
    global nodes

    save_chat_to_file(chat, "json", f"{config['paths']['data']}/chat.json")
    save_to_json_file(nodes, f"{config['paths']['data']}/nodes.json")
    save_to_json_file(telemetry, f"{config['paths']['data']}/telemetry.json")

def save_node_infos_to_file(node_infos, type,path, config=config):
    if type == "json":
      with open(path, "w") as f:
          json.dump(node_infos, f, indent=2, sort_keys=True, cls=_JSONEncoder)
    if type == "html":
      env = Environment(loader=FileSystemLoader('.'), autoescape=True)
      template = env.get_template(f'{config["paths"]["templates"]}/static/node_infos.html.j2')
      rendered_html = template.render(node_infos=node_infos, datetime=datetime.datetime, timestamp=datetime.datetime.now())
      with open(path, "w") as f:
          f.write(rendered_html)

def load():
    global config
    global chat
    global nodes
    global telemetry
    global telemetry_by_node

    try:
      nodes = load_nodes_from_file()
      print(f"Loaded {len(nodes)} existing nodes from file ({config['paths']['data']}/nodes.json)")
    except FileNotFoundError:
      nodes = {}
    if config['server']['node_id'] not in nodes:
      nodes[config['server']['node_id']] = Node.default_node(config['server']['node_id'])
    nodes['!ffffffff'] = Node.default_node('!ffffffff')

    try:
      chat = load_chat_from_file("json", f"{config['paths']['data']}/chat.json")
      print(f"Loaded {len(chat['channels']['0']['messages'])} chat messages from file ({config['paths']['data']}/chat.json)")
    except FileNotFoundError:
      chat = {
          'channels': {
              '0': {
                'name': 'General',
                'messages': []
              }
          }
      }

    try:
      telemetry = load_from_json_file(f"{config['paths']['data']}/telemetry.json")
      if telemetry is None or len(telemetry) == 0:
        telemetry = []
      if telemetry_by_node is None or len(telemetry_by_node) == 0:
        telemetry_by_node = {}
      for msg in telemetry:
        id = msg['from']
        if id not in telemetry_by_node:
          telemetry_by_node[id] = []
        telemetry_by_node[id].insert(0, msg)
      print(f"Loaded {len(telemetry)} telemetry messages from file ({config['paths']['data']}/telemetry.json)")
      print(f"Loaded telemetry data for {len(telemetry_by_node)} nodes")
    except FileNotFoundError:
      telemetry = []
      telemetry_by_node = {}

def load_chat_from_file(type, path, config=config):
    global chat
    if type == "json":
      with open(path, "r") as f:
          return json.load(f, cls=_JSONDecoder)
    if type == "html":
      pass

def load_from_json_file(path, config=config):
    with open(path, "r") as f:
        return json.load(f, cls=_JSONDecoder)

def save_to_json_file(data, path, config=config):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True, cls=_JSONEncoder)

def save_chat_to_file(chat, type, path, config=config):
    global nodes
    if type == "json":
      with open(path, "w") as f:
          json.dump(chat, f, indent=2, sort_keys=True, cls=_JSONEncoder)
    if type == "html":
      env = Environment(loader=FileSystemLoader('.'), autoescape=True)
      template = env.get_template(f'{config["paths"]["templates"]}/static/chat.html.j2')
      rendered_html = template.render(nodes=nodes, chat=chat, datetime=datetime.datetime, timestamp=datetime.datetime.now())
      with open(path, "w") as f:
          f.write(rendered_html)

def run():
    global chat
    global config
    global nodes

    if not os.path.exists(config['paths']['output']):
        os.makedirs(config['paths']['output'])
    if not os.path.exists(config['paths']['data']):
        os.makedirs(config['paths']['data'])

    load()
    save()

    if os.environ.get('MQTT_BROKER') is not None:
        config['broker']['host'] = os.environ['MQTT_BROKER']
    if os.environ.get('MQTT_PORT') is not None:
        config['broker']['port'] = int(os.environ['MQTT_PORT'])
    if os.environ.get('MQTT_CLIENT_ID') is not None:
        config['broker']['client_id'] = os.environ['MQTT_CLIENT_ID']
    if os.environ.get('MQTT_TOPIC') is not None:
        config['broker']['topic'] = os.environ['MQTT_TOPIC']

    client = connect_mqtt(config['broker']['host'], config['broker']['port'], config['broker']['client_id'], config['broker']['username'], config['broker']['password'])
    subscribe(client, config['broker']['topic'])
    client.loop_forever()

if __name__ == "__main__":
    run()
