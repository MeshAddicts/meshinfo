#!/usr/bin/env python3

import datetime
import json
import traceback
from zoneinfo import ZoneInfo
import paho.mqtt.client as mqtt_client

from encoders import _JSONDecoder
from models.node import Node

class MQTT:
    def __init__(self, config, data):
        self.config = config
        self.data = data

        self.host = config['broker']['host']
        self.port = config['broker']['port']
        self.client_id = config['broker']['client_id']
        self.username = config['broker']['username']
        self.password = config['broker']['password']

        self.client = self.connect()
        self.client.loop_forever()

    ### actions

    def connect(self):
        ### paho callbacks

        def on_connect(client, userdata, flags, rc, properties=None):
            if rc == 0:
                self.data.mqtt_connect_time = datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
                print("Connected to MQTT broker at %s:%d (as client_id %s)" % (self.host, self.port, self.client_id))
                self.subscribe(self.config['broker']['topic'])
            else:
                print("Failed to connect, error: %s\n" % rc)

        def on_message(client, userdata, msg, properties=None):
            try:
                decoded = msg.payload.decode("utf-8")
                j = json.loads(decoded, cls=_JSONDecoder)
                self.handle_log(msg)
                if j['type'] == "neighborinfo":
                    self.handle_neighborinfo(j)
                if j['type'] == "nodeinfo":
                    self.handle_nodeinfo(j)
                if j['type'] == "position":
                    self.handle_position(j)
                if j['type'] == "telemetry":
                    self.handle_telemetry(j)
                if j['type'] == "text":
                    self.handle_text(j)
                if j['type'] == "traceroute":
                    self.handle_traceroute(j)
                self.prune_expired_nodes()
            except Exception as e:
                print(e)
                traceback.print_exc()

        client = mqtt_client.Client(client_id=self.client_id, callback_api_version=mqtt_client.CallbackAPIVersion.VERSION2)
        client.on_connect = on_connect
        client.on_message = on_message
        client.username_pw_set(self.username, self.password)
        client.connect(self.host, self.port)
        return client

    def publish(self, topic, msg):
        result = self.client.publish(topic, msg)
        status = result[0]
        if status == 0:
            print(f"Send `{msg}` to topic `{topic}`")
            print("Done!")
            return True
        else:
            print(f"Failed to send message to topic {topic}")
            return False

    def subscribe(self, topic):
        self.client.subscribe(topic)
        print(f"Subscribed to topic `{topic}`")

    def unsubscribe(self, topic):
        self.client.unsubscribe(topic)

    ### message handlers

    def handle_log(self, msg):
        print(f"MQTT >> {msg.topic} -- {msg.payload.decode("utf-8")}")
        self.data.messages.append(msg.payload.decode("utf-8"))
        self.data.mqtt_messages.append(msg)
        with open(f'{self.config["paths"]["data"]}/message-log.jsonl', 'a', encoding='utf-8') as f:
            f.write(f"{msg.payload.decode("utf-8")}\n")

    def handle_neighborinfo(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['neighborinfo'] = msg['payload']
            self.data.update_node(id, node)
            print(f"Node {id} updated with neighborinfo")
        else:
            node = Node.default_node(id)
            node['neighborinfo'] = msg['payload']
            self.data.update_node(id, node)
            print(f"Node {id} skeleton added with neighborinfo")
        self.data.save()

    def handle_nodeinfo(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['payload']['id']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['hardware'] = msg['payload']['hardware']
            node['longname'] = msg['payload']['longname']
            node['shortname'] = msg['payload']['shortname']
            self.data.update_node(id, node)
            print(f"Node {id} updated")
        else:
            node = Node.default_node(id)
            node['hardware'] = msg['payload']['hardware']
            node['longname'] = msg['payload']['longname']
            node['shortname'] = msg['payload']['shortname']
            self.data.update_node(id, node)
            print(f"Node {id} added")
        self.sort_nodes_by_shortname()
        self.data.save()

    def handle_position(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['position'] = msg['payload'] if 'payload' in msg else None
            self.data.update_node(id, node)
            print(f"Node {id} updated with position")
        else:
            node = Node.default_node(id)
            node['position'] = msg['payload'] if 'payload' in msg else None
            self.data.update_node(id, node)
            print(f"Node {id} skeleton added with position")
        self.data.save()

    def handle_telemetry(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['telemetry'] = msg['payload'] if 'payload' in msg else None
            self.data.update_node(id, node)
            print(f"Node {id} updated with telemetry")
        else:
            node = Node.default_node(id)
            node['telemetry'] = msg['payload'] if 'payload' in msg else None
            self.data.update_node(id, node)
            print(f"Node {id} skeleton added with telemetry")

        if id not in self.data.telemetry_by_node:
            self.data.telemetry_by_node[id] = []

        if 'payload' in msg:
            self.data.telemetry.insert(0, msg)
            self.data.telemetry_by_node[id].insert(0, msg)

        self.data.save()

    def handle_text(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        self.data.chat['channels'][str(msg['channel'])]['messages'].insert(0, {
            'id': msg['id'],
            'sender': msg['sender'],
            'from': msg['from'],
            'to': msg['to'],
            'channel': str(msg['channel']),
            'text': msg['payload']['text'],
            'timestamp': msg['timestamp'],
            'hops_away': msg['hops_away'] if 'hops_away' in msg else None,
            'rssi': msg['rssi'] if 'rssi' in msg else None,
            'snr': msg['snr'] if 'snr' in msg else None,
        })
        self.data.save()

    def handle_traceroute(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        msg['to'] = f'{msg["to"]:x}'
        if msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')
        msg['route'] = msg['payload']['route']
        msg['route_ids'] = []
        for r in msg['route']:
            node = self.data.find_node_by_longname(r)
            if node:
                msg['route_ids'].append(node['id'])
            else:
                msg['route_ids'].append(r)

        if id in self.data.traceroutes_by_node:
            self.data.traceroutes_by_node[id].insert(0, msg)
        else:
            self.data.traceroutes_by_node[id] = [msg]
        self.data.traceroutes.insert(0, msg)
        self.data.save()

    ### helpers

    # TODO: where should this really live?
    def prune_expired_nodes(self):
        now = datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
        ids_to_delete: list[str] = []
        for id, node in self.data.nodes.items():
            if node['last_seen'] is None:
                ids_to_delete.append(node['id'])
                continue
            last_seen = datetime.datetime.fromisoformat(node['last_seen']).astimezone() if isinstance(node['last_seen'], str) else node['last_seen']
            try:
                since = (now - last_seen).seconds
            except Exception:
                print(f"Node {id} has invalid last_seen: {node['last_seen']}")
                self.data.nodes[id]['last_seen'] = None
                self.data.nodes[id]['active'] = False
            if node['active'] and since >= self.config['server']['node_activity_prune_threshold']:
                ids_to_delete.append(node['id'])
                print(f"Node {id} pruned (last heard {since} seconds ago)")

        for id in ids_to_delete:
            self.data.nodes[id]['active'] = False

    # TODO: where should this really live?
    def sort_nodes_by_shortname(self):
        self.data.nodes = dict(sorted(self.data.nodes.items(), key=lambda item: item[1]["shortname"]))
