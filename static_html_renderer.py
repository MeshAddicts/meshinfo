#!/usr/bin/env python3

import asyncio
import copy
import datetime
import json
from zoneinfo import ZoneInfo
from jinja2 import Environment, FileSystemLoader

import encoders
import geo
import meshtastic_support
import utils

class StaticHTMLRenderer:
  def __init__(self, config, data):
    self.config = config
    self.data = data
    self.output_path = self.config['paths']['output']
    self.template_path = f"{self.config['paths']['templates']}/static"

  async def render(self):
      await asyncio.to_thread(self._render)

  def _render(self):
    self.render_index()
    self.render_chat()
    self.render_graph()
    self.render_map()
    self.render_mesh_log()
    self.render_mqtt_log()
    self.render_neighbors()
    self.render_nodes_each()
    self.render_nodes()
    self.render_routes()
    self.render_stats()
    self.render_telemetry()
    self.render_traceroutes()
    print("Done rendering static HTML files")

  def save_file(self, filename, content):
    with open(f"{self.output_path}/{filename}", "w", encoding='utf-8') as f:
      f.write(content)

  def render_html(self, template_file, **kwargs):
    env = Environment(loader=FileSystemLoader('.'), autoescape=True)
    template_file = 'node.html' if template_file.startswith('node_') else f'{template_file}'
    template = env.get_template(f'{self.template_path}/{template_file}.j2')
    html = template.render(**kwargs)
    return html

  def render_html_and_save(self, filename, **kwargs):
    if self.config['debug']:
      print(f"Rendering {filename}")
    html = self.render_html(filename, **kwargs)
    self.save_file(filename, html)


  ### Page Renderers

  def render_chat(self):
    self.render_html_and_save(
      'chat.html',
      config=self.config,
      nodes=self.data.nodes,
      chat=self.data.chat,
      utils=utils,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_graph(self):
    self.render_html_and_save(
      'graph.html',
      config=self.config,
      nodes=self.data.nodes,
      graph=self.data.graph,
      utils=utils,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_index(self):
    self.render_html_and_save(
      'index.html',
      config=self.config,
      nodes=self.data.nodes,
      active_nodes=self.data.nodes,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_map(self):
    server_node = self.data.nodes[self.config['server']['node_id']]
    self.render_html_and_save(
      'map.html',
      config=self.config,
      server_node=server_node,
      nodes=self.data.nodes,
      utils=utils,
      datetime=datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_mesh_log(self):
    self.render_html_and_save(
      'mesh_log.html',
      config=self.config,
      messages=self.data.messages,
      json=json,
      datetime=datetime.datetime,
      JSONEncoder=encoders._JSONEncoder,
      ZoneInfo=ZoneInfo,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_mqtt_log(self):
    self.render_html_and_save(
      'mqtt_log.html',
      config=self.config,
      messages=self.data.mqtt_messages,
      mqtt_connect_time=self.data.mqtt_connect_time,
      json=json,
      datetime=datetime.datetime,
      ZoneInfo=ZoneInfo,
      JSONEncoder=encoders._JSONEncoder,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_neighbors(self):
    active_nodes_with_neighbors = {}
    for id, node in self.data.nodes.items():
        if 'active' in node and node['active'] and 'neighborinfo' in node and node['neighborinfo']:
            active_nodes_with_neighbors[id] = self._serialize_node(node)

    self.render_html_and_save(
      'neighbors.html',
      config=self.config,
      nodes=self.data.nodes,
      active_nodes_with_neighbors=active_nodes_with_neighbors,
      geo=geo,
      utils=utils,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_nodes(self):
    active_nodes = {}
    for id, node in self.data.nodes.items():
        if 'active' in node and node['active']:
            active_nodes[id] = self._serialize_node(node)

    self.render_html_and_save(
      'nodes.html',
      config=self.config,
      nodes=self.data.nodes,
      active_nodes=active_nodes,
      hardware=meshtastic_support.HardwareModel,
      meshtastic_support=meshtastic_support,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_nodes_each(self):
    for id, node in self.data.nodes.items():
      id = id.replace('!', '') # todo: remove this line
      self.render_html_and_save(
        f"node_{id}.html",
        config=self.config,
        node=node,
        nodes=self.data.nodes,
        hardware=meshtastic_support.HardwareModel,
        meshtastic_support=meshtastic_support,
        utils=utils,
        datetime=datetime.datetime,
        zoneinfo=ZoneInfo(self.config['server']['timezone']),
        timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
      )

  def render_routes(self):
    self.render_html_and_save(
      'routes.html',
      config=self.config,
      nodes=self.data.nodes,
      active_nodes=self.data.nodes,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_stats(self):
    stats = {
      'active_nodes': 0,
      'total_chat': len(self.data.chat['channels']['0']['messages']),
      'total_nodes': len(self.data.nodes),
      'total_messages': len(self.data.messages),
      'total_mqtt_messages': len(self.data.mqtt_messages),
      'total_telemetry': len(self.data.telemetry),
      'total_traceroutes': len(self.data.traceroutes),
    }
    for _, node in self.data.nodes.items():
        if 'active' in node and node['active']:
            stats['active_nodes'] += 1

    self.render_html_and_save(
      'stats.html',
      config=self.config,
      stats=stats,
      nodes=self.data.nodes,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_telemetry(self):
    self.render_html_and_save(
      'telemetry.html',
      config=self.config,
      nodes=self.data.nodes,
      telemetry=self.data.telemetry,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  def render_traceroutes(self):
    self.render_html_and_save(
      'traceroutes.html',
      config=self.config,
      nodes=self.data.nodes,
      traceroutes=self.data.traceroutes,
      datetime=datetime.datetime,
      zoneinfo=ZoneInfo(self.config['server']['timezone']),
      timestamp=datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
    )

  # TODO: move to models
  def _serialize_node(self, node):
    """
    Serialize a node object to a format suitable for saving to an HTML file.
    """

    last_seen = node["last_seen"] if isinstance(node["last_seen"], datetime.datetime) else datetime.datetime.fromisoformat(node["last_seen"])
    id = node["id"].replace("!","") if isinstance(node["id"], str) else node["id"]
    serialized = {
        "id": id,
        "shortname": node["shortname"],
        "longname": node["longname"],
        "hardware": node["hardware"],
        "role": node["role"] if "role" in node else None,
        "position": self._serialize_position(node["position"]) if node["position"] else None,
        "neighborinfo": self._serialize_neighborinfo(node) if node['neighborinfo'] else None,
        "telemetry": node["telemetry"],
        "last_seen_human": last_seen.astimezone().isoformat(),
        "last_seen": last_seen,
        "since": datetime.datetime.now(ZoneInfo(self.config['server']['timezone'])) - last_seen,
    }
    server_node = self.data.nodes[f'{self.config["server"]["node_id"]}']
    if server_node and 'position' in server_node and node and 'position' in node:
      if server_node["position"] and 'latitude_i' in server_node["position"] and 'longitude_i' in server_node["position"] and node["position"] and 'latitude_i' in node["position"] and 'longitude_i' in node["position"]:
        if server_node["position"]["latitude_i"] != 0 and server_node["position"]["longitude_i"] != 0 and node["position"] and node["position"]["latitude_i"] != 0 and node["position"]["longitude_i"] != 0:
          serialized["distance_from_host_node"] = round(geo.distance_between_two_points(
              node["position"]["latitude_i"] / 10000000,
              node["position"]["longitude_i"] / 10000000,
              server_node["position"]["latitude_i"] / 10000000,
              server_node["position"]["longitude_i"] / 10000000
            ), 2)
    return serialized

  def _serialize_neighborinfo(self, node):
    """
    Serialize a neighborinfo object to a format suitable for saving to an HTML file.
    """
    ni = node['neighborinfo'].copy()
    ni['neighbors'] = self._serialize_neighborinfo_neighbors(node) if 'neighbors' in ni else None
    return ni

  def _serialize_neighborinfo_neighbors(self, node):
    """
    Serialize a neighborinfo object to a format suitable for saving to an HTML file.
    """
    global nodes

    from_node = self.data.nodes[node['id']]
    ns = []
    for n in node['neighborinfo']['neighbors']:
      id = utils.convert_node_id_from_int_to_hex(n["node_id"])
      neighbor = {
        "node_id": id,
        "snr": n["snr"],
      }
      if id in self.data.nodes:
        ni = self.data.nodes[id]
        if from_node['position'] and ni['position'] and 'latitude_i' in from_node['position'] and 'longitude_i' in from_node['position'] and 'latitude_i' in ni['position'] and 'longitude_i' in ni['position']:
          neighbor["distance"] = round(geo.distance_between_two_points(
            from_node["position"]["latitude_i"] / 10000000,
            from_node["position"]["longitude_i"] / 10000000,
            ni["position"]["latitude_i"] / 10000000,
            ni["position"]["longitude_i"] / 10000000
          ), 2)
      ns.append(neighbor)
    return ns

  def _serialize_position(self, position):
    """
    Serialize a position object to a format suitable for saving to an HTML file.
    """
    if "altitude" in position:
        altitude = position["altitude"]
    else:
        altitude = None

    if "latitude_i" in position and "longitude_i" in position:
       latitude = position["latitude_i"] / 10000000
       longitude = position["longitude_i"] / 10000000
    else:
       latitude = None
       longitude = None

    return {
        "altitude": altitude,
        "latitude": latitude,
        "longitude": longitude
    }
