#!/usr/bin/env python3

import base64
import datetime
import json
import traceback
from zoneinfo import ZoneInfo
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2, telemetry_pb2
import paho.mqtt.client as mqtt_client
from google.protobuf.json_format import MessageToJson
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

from encoders import _JSONDecoder
import _meshtastic
from models.node import Node
import utils

key = "AQ=="
key_hash = "1PG7OiApB1nwvP+rz05pAQ==" # AQ==
key_bytes = base64.b64decode(key_hash.encode('ascii'))

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
                if 'topic' in self.config['broker'] and self.config['broker']['topic'] is not None and isinstance(self.config['broker']['topic'], str):
                    self.subscribe(self.config['broker']['topic'])
                if 'topics' in self.config['broker'] and self.config['broker']['topics'] is not None and isinstance(self.config['broker']['topics'], list):
                    for topic in self.config['broker']['topics']:
                        self.subscribe(topic)

            else:
                print("Failed to connect, error: %s\n" % rc)

        def on_message(client, userdata, msg, properties=None):
            if '/2/e/' in msg.topic or '/2/map/' in msg.topic:
                print(f"Received a protobuf message: {msg.topic} {msg.payload}")
                is_encrypted = False
                mp = mesh_pb2.MeshPacket()
                outs = {}

                try:
                    se = mqtt_pb2.ServiceEnvelope()
                    se.ParseFromString(msg.payload)
                    mp = se.packet
                    outs = json.loads(MessageToJson(mp, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    print(f"Decoded protobuf message: {outs}")
                except Exception as e:
                    # print(f"*** ParseFromString: {str(e)}")
                    pass

                if mp.HasField("encrypted") and not mp.HasField("decoded"):
                    try:
                        nonce_packet_id = getattr(mp, "id").to_bytes(8, "little")
                        nonce_from_node = getattr(mp, "from").to_bytes(8, "little")
                        nonce = nonce_packet_id + nonce_from_node
                        cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(nonce), backend=default_backend())
                        decryptor = cipher.decryptor()
                        decrypted_bytes = decryptor.update(getattr(mp, "encrypted")) + decryptor.finalize()
                        data = mesh_pb2.Data()
                        data.ParseFromString(decrypted_bytes)
                        mp.decoded.CopyFrom(data)
                        outs = json.loads(MessageToJson(mp, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    except Exception as e:
                        print(f"*** Decryption failed: {str(e)}")
                        return
                    is_encrypted = True

                outs['rssi'] = mp.rx_rssi
                outs['snr'] = mp.rx_snr
                outs['timestamp'] = mp.rx_time

                # TODO: Need to handle this
                # self.handle_log(mp.decoded)

                if mp.decoded.portnum == portnums_pb2.TEXT_MESSAGE_APP:
                    text = mp.decoded.payload.decode("utf-8")
                    payload = { "text": text }
                    outs["type"] = "text"
                    outs["payload"] = payload
                    print(f"Decoded protobuf message: text: {outs}")
                    self.handle_text(outs)

                elif mp.decoded.portnum == portnums_pb2.MAP_REPORT_APP:
                    report = mesh_pb2.Position()
                    report.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(report, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                    outs["type"] = "mapreport"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: mapreport: {outs}")
                    # self.handle_mapreport(outs)

                elif mp.decoded.portnum == portnums_pb2.NEIGHBORINFO_APP:
                    info = mesh_pb2.NeighborInfo()
                    info.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                    outs["type"] = "neighborinfo"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: neighborinfo: {outs}")
                    self.handle_neighborinfo(outs)

                elif mp.decoded.portnum == portnums_pb2.NODEINFO_APP:
                    info = mesh_pb2.User()
                    info.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    out["id"] = out['id'].replace('!', '')
                    outs["type"] = "nodeinfo"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: nodeinfo: {outs}")
                    self.handle_nodeinfo(outs)

                elif mp.decoded.portnum == portnums_pb2.ROUTING_APP:
                    data = mesh_pb2.Routing()
                    data.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(data, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    outs["type"] = "routing"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: routing: {outs}")
                    # self.handle_routing(outs)

                elif mp.decoded.portnum == portnums_pb2.TRACEROUTE_APP:
                    route = mesh_pb2.RouteDiscovery()
                    route.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(route, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                    if 'route' in out:
                        route = []
                        for r in out['route']:
                           id = utils.convert_node_id_from_int_to_hex(r)
                           route.append(id)
                        outs["route"] = route
                    outs["type"] = "traceroute"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: traceroute: {outs}")
                    self.handle_traceroute(outs)

                elif mp.decoded.portnum == portnums_pb2.POSITION_APP:
                    pos = mesh_pb2.Position()
                    pos.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(pos, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    outs["type"] = "position"
                    outs["payload"] = out
                    print(f"Decoded protobuf message: position: {outs}")
                    self.handle_position(outs)

                elif mp.decoded.portnum == portnums_pb2.TELEMETRY_APP:
                    env = telemetry_pb2.Telemetry()
                    env.ParseFromString(mp.decoded.payload)
                    out = json.loads(MessageToJson(env, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    if 'rx_time' in outs:
                        out['timestamp'] = datetime.datetime.fromtimestamp(outs['rx_time'] / 1000).astimezone(ZoneInfo(self.config['server']['timezone']))
                    outs["type"] = "telemetry"
                    if 'device_metrics' in out:
                        outs["payload"] = out['device_metrics']
                    if 'environment_metrics' in out:
                        outs["payload"] = out['environment_metrics']
                    print(f"Decoded protobuf message: telemetry: {outs}")
                    self.handle_telemetry(outs)

                else:
                    print(f"Received an unknown protobuf message: {mp}")

            elif '/2/json/' in msg.topic:
                print(f"Received a JSON message: {msg.topic} {msg.payload}")
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
                        if 'route' in j['payload']:
                            route = []
                            for r in j['payload']['route']:
                                node = self.data.find_node_by_longname(r)
                                if node is not None:
                                    id = node['id']
                                else:
                                    id = None
                                route.append(id)
                            j['route'] = route
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
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
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
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['payload']['id']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            if 'hardware' in msg['payload']:
                node['hardware'] = msg['payload']['hardware']
            elif 'hw_model' in msg['payload']:
                node['hardware'] = msg['payload']['hw_model']
            if 'longname' in msg['payload']:
                node['longname'] = msg['payload']['longname']
            elif 'long_name' in msg['payload']:
                node['longname'] = msg['payload']['long_name']
            if 'shortname' in msg['payload']:
                node['shortname'] = msg['payload']['shortname']
            elif 'short_name' in msg['payload']:
                node['shortname'] = msg['payload']['short_name']
            self.data.update_node(id, node)
            print(f"Node {id} updated")
        else:
            node = Node.default_node(id)
            if 'hardware' in msg['payload']:
                node['hardware'] = msg['payload']['hardware']
            elif 'hw_model' in msg['payload']:
                node['hardware'] = msg['payload']['hw_model']
            if 'longname' in msg['payload']:
                node['longname'] = msg['payload']['longname']
            elif 'long_name' in msg['payload']:
                node['longname'] = msg['payload']['long_name']
            if 'shortname' in msg['payload']:
                node['shortname'] = msg['payload']['shortname']
            elif 'short_name' in msg['payload']:
                node['shortname'] = msg['payload']['short_name']
            self.data.update_node(id, node)
            print(f"Node {id} added")
        self.sort_nodes_by_shortname()
        self.data.save()

    def handle_position(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
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
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
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
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        if str(msg['channel']) not in self.data.chat['channels']:
            self.data.chat['channels'][str(msg['channel'])] = {
                'name': f'Channel {msg["channel"]}',
                'messages': []
            }

        chat = {
            'id': msg['id'],
            'from': msg['from'],
            'to': msg['to'],
            'channel': str(msg['channel']),
            'text': msg['payload']['text'],
            'timestamp': msg['timestamp'],
            'hops_away': msg['hops_away'] if 'hops_away' in msg else None,
            'rssi': msg['rssi'] if 'rssi' in msg else None,
            'snr': msg['snr'] if 'snr' in msg else None,
        }
        if 'sender' in msg:
            chat['sender'] = msg['sender']
        self.data.chat['channels'][str(msg['channel'])]['messages'].insert(0, chat)
        self.data.save()

    def handle_traceroute(self, msg):
        msg['from'] = f'{msg["from"]:x}'
        if 'to' in msg:
            msg['to'] = f'{msg["to"]:x}'
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')
        msg['route'] = msg['payload']['route']
        msg['route_ids'] = []
        for r in msg['route']:
            if isinstance(r, str):
                node = self.data.find_node_by_longname(r)
            elif isinstance(r, int):
                node = self.data.find_node_by_hex_id(r)
            else:
                node = None

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
