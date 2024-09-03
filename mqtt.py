#!/usr/bin/env python3

import asyncio
import base64
import datetime
import json
import time
import traceback
from zoneinfo import ZoneInfo
import aiomqtt
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2, telemetry_pb2
from google.protobuf.json_format import MessageToJson
from google.protobuf.message import DecodeError
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

from encoders import _JSONDecoder
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

    ### actions

    async def connect(self):
        print(f"Connecting to MQTT broker at {self.config['broker']['host']}:{self.config['broker']['port']}")
        while True:
            try:
                async with aiomqtt.Client(
                    hostname = self.config["broker"]["host"],
                    port = self.config["broker"]["port"],
                    identifier = self.config["broker"]["client_id"],
                    username = self.config["broker"]["username"],
                    password = self.config["broker"]["password"],
                ) as client:
                    print("Connected to MQTT broker at %s:%d" % (
                        self.config["broker"]["host"],
                        self.config["broker"]["port"],
                    ))
                    if "topics" in self.config["broker"] and self.config["broker"]["topics"] is not None and isinstance(self.config["broker"]["topics"], list):
                        for topic in self.config["broker"]["topics"]:
                            await client.subscribe(topic)
                    elif "topic" in self.config["broker"] and self.config["broker"]["topic"] is not None and isinstance(self.config["broker"]["topic"], str):
                        await client.subscribe(self.config["broker"]["topic"])
                    else:
                        print("No MQTT topics to subscribe to defined in config broker.topics or broker.topic")
                        exit(1)

                    self.data.mqtt_connect_time = datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
                    async for msg in client.messages:
                        # paho adds a timestamp to messages which is not in
                        # aiomqtt. We will do that ourself here so it is compatible.
                        msg.timestamp = time.monotonic() # type: ignore
                        await self.process_mqtt_msg(client, msg)
            except aiomqtt.MqttError as err:
                print(f"Disconnected from MQTT broker: {err}")
                print("Reconnecting...")
                await asyncio.sleep(5)

    async def process_mqtt_msg(self, client, msg):
        if self.config['broker']['decoders']['protobuf']['enabled']:
            if '/2/e/' in msg.topic.value or '/2/map/' in msg.topic.value:
                if self.config['debug']:
                    print(f"Received a protobuf message: {msg.topic} {msg.payload}")
                is_encrypted = False
                mp = mesh_pb2.MeshPacket()
                outs = {}

                common_MTJ_kwargs = {'preserving_proto_field_name': True,
                                     'ensure_ascii': False,
                                     'indent': 2,
                                     'sort_keys': True,
                                     'use_integers_for_enums': True,
                                    }

                try:
                    se = mqtt_pb2.ServiceEnvelope()
                    se.ParseFromString(msg.payload)
                    mp = se.packet
                    outs = json.loads(MessageToJson(mp, **common_MTJ_kwargs))
                    if self.config['debug']:
                        print(f"Decoded protobuf message: {outs}")
                except Exception as _:
                    # print(f"*** ParseFromString: {str(e)}")
                    pass

                if mp.HasField("encrypted") and not mp.HasField("decoded"):
                    is_encrypted = True
                    for key_item in self.config['broker']['channels']['encryption']:
                        key_bytes = base64.b64decode(key_item['key'].encode('ascii'))
                        try:
                            if self.config['debug']:
                                print(f"Attempting decryption with key: {key}")
                            nonce_packet_id = getattr(mp, "id").to_bytes(8, "little")
                            nonce_from_node = getattr(mp, "from").to_bytes(8, "little")
                            nonce = nonce_packet_id + nonce_from_node
                            cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(nonce), backend=default_backend())
                            decryptor = cipher.decryptor()
                            decrypted_bytes = decryptor.update(getattr(mp, "encrypted")) + decryptor.finalize()
                            data = mesh_pb2.Data()
                            data.ParseFromString(decrypted_bytes)
                            mp.decoded.CopyFrom(data)
                            outs = json.loads(MessageToJson(mp, **common_MTJ_kwargs))
                            break
                        except Exception as e:
                            if self.config['debug']:
                                print(f"*** Decryption failed: {str(e)}")
                            continue

                if hasattr(mp, 'hops_away'):
                    outs['hops_away'] = mp.hops_away

                outs['hop_limit'] = mp.hop_limit
                outs['hop_start'] = mp.hop_start
                outs['rssi'] = mp.rx_rssi
                outs['snr'] = mp.rx_snr
                outs['timestamp'] = mp.rx_time
                outs['topic'] = msg.topic.value

                if mp.decoded.portnum == portnums_pb2.TEXT_MESSAGE_APP:
                    try:
                        text = mp.decoded.payload.decode("utf-8")
                        payload = { "text": text }
                        outs["type"] = "text"
                        outs["payload"] = payload
                        if self.config['debug']:
                            print(f"Decoded protobuf message: text: {outs}")
                        await self.handle_text(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.MAP_REPORT_APP:
                    try:
                        report = mesh_pb2.Position().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(report, always_print_fields_with_no_presence=True, **common_MTJ_kwargs))
                        outs["type"] = "mapreport"
                        outs["payload"] = out
                        if self.config['debug']:
                            print(f"Decoded protobuf message: mapreport: {outs}")
                        # self.handle_mapreport(outs)
                        await self.handle_default(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.NEIGHBORINFO_APP:
                    try:
                        info = mesh_pb2.NeighborInfo().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, always_print_fields_with_no_presence=True, **common_MTJ_kwargs))
                        outs["type"] = "neighborinfo"
                        outs["payload"] = out
                        if self.config['debug']:
                            print(f"Decoded protobuf message: neighborinfo: {outs}")
                        await self.handle_neighborinfo(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.NODEINFO_APP:
                    try:
                        info = mesh_pb2.User().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, **common_MTJ_kwargs))
                        if isinstance(out['id'], int):
                            out["id"] = utils.convert_node_id_from_int_to_hex(out['id'])
                        out["id"] = out['id'].replace('!', '')
                        outs["type"] = "nodeinfo"
                        outs["payload"] = out
                        if self.config['debug']:
                            print(f"Decoded protobuf message: nodeinfo: {outs}")
                        await self.handle_nodeinfo(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.ROUTING_APP:
                    try:
                        data = mesh_pb2.Routing().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(data, **common_MTJ_kwargs))
                        outs["type"] = "routing"
                        outs["payload"] = out
                        if self.config['debug']:
                            print(f"Decoded protobuf message: routing: {outs}")
                        # self.handle_routing(outs)
                        await self.handle_default(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.TRACEROUTE_APP:
                    try:
                        route = mesh_pb2.RouteDiscovery().FromString(mp.decoded.payload)
                        outs["payload"] = json.loads(MessageToJson(route, always_print_fields_with_no_presence=True, **common_MTJ_kwargs))
                        outs["type"] = "traceroute"
                        if self.config['debug']:
                            print(f"Decoded protobuf message: traceroute: {outs}")
                        await self.handle_traceroute(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.POSITION_APP:
                    try:
                        pos = mesh_pb2.Position().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(pos, **common_MTJ_kwargs))
                        outs["type"] = "position"
                        outs["payload"] = out
                        if self.config['debug']:
                            print(f"Decoded protobuf message: position: {outs}")
                        await self.handle_position(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")

                elif mp.decoded.portnum == portnums_pb2.TELEMETRY_APP:
                    try:
                        env = telemetry_pb2.Telemetry().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(env, **common_MTJ_kwargs))
                        if 'rx_time' in outs:
                            out['timestamp'] = datetime.datetime.fromtimestamp(outs['rx_time'] / 1000).astimezone(ZoneInfo(self.config['server']['timezone']))
                        outs["type"] = "telemetry"
                        if 'device_metrics' in out:
                            outs["payload"] = out['device_metrics']
                        if 'environment_metrics' in out:
                            outs["payload"] = out['environment_metrics']
                        if self.config['debug']:
                            print(f"Decoded protobuf message: telemetry: {outs}")
                        await self.handle_telemetry(outs)
                    except UnicodeDecodeError as e:
                        print(f"*** Unicode decoding error: text: {str(e)}")
                    except DecodeError as e:
                        print(f"*** Protobuf decode error: text: {str(e)}")
                    except Exception as e:
                        print(e)

                else:
                    if self.config['debug']:
                        print(f"Received an unknown protobuf message: {mp}")
                    outs["type"] = "unknown"
                    if mp.decoded.payload is not None:
                        try:
                            outs["payload"] = mp.decoded.payload.decode("utf-8")
                        except UnicodeDecodeError as e:
                            print(f"*** Unicode decoding error: text: {str(e)}")
                            outs["payload"] = {}
                        except DecodeError as e:
                            print(f"*** Protobuf decode error: text: {str(e)}")
                            outs["payload"] = {}
                    else:
                        outs["payload"] = {}
                    await self.handle_default(outs)

                print(outs)
                await self.handle_log(outs)
                await self.prune_expired_nodes()

        elif self.config['broker']['decoders']['json']['enabled']:
            if '/2/json/' in msg.topic.value:
                if self.config['debug']:
                    print(f"Received a JSON message: {msg.topic} {msg.payload}")
                try:
                    decoded = msg.payload.decode("utf-8")
                    j = json.loads(decoded, cls=_JSONDecoder)
                    j['topic'] = msg.topic.value
                    if j['type'] == "neighborinfo":
                        await self.handle_neighborinfo(j)
                    elif j['type'] == "nodeinfo":
                        await self.handle_nodeinfo(j)
                    elif j['type'] == "position":
                        await self.handle_position(j)
                    elif j['type'] == "telemetry":
                        await self.handle_telemetry(j)
                    elif j['type'] == "text":
                        await self.handle_text(j)
                    elif j['type'] == "traceroute":
                        await self.handle_traceroute(j)
                    await self.handle_log(j)
                    await self.prune_expired_nodes()
                except Exception as e:
                    print(e)
                    traceback.print_exc()

    async def publish(self, client, topic, msg):
        result = await client.publish(topic, msg)
        status = result[0]
        if status == 0:
            print(f"Send `{msg}` to topic `{topic}`")
            return True
        else:
            print(f"Failed to send message to topic {topic}")
            return False

    async def subscribe(self, client, topic):
        client.subscribe(topic)
        print(f"Subscribed to topic `{topic}`")

    async def unsubscribe(self, client, topic):
        client.unsubscribe(topic)

    def node_create_or_update(self, node_id, msg,
                              sort_nodes=None,
                              create_string="Node {node_id} added",
                              update_string="Node {node_id} updated",
                              **updates):
        """
        Helper to create or update nodes
        :param node_id: The id for the node, in hex format
        :param msg: Dict object containing the message
        :param sort_nodes: Whether to sort our stored node data afterwards, defaults to yes
        :param create_string: String template to print when new node added
        :param update_string: String template to print when node is updated
        :param updates: Keyword arguments that will be set for the node's data (is not validated)
        """

        info_string = update_string  # default to using the update_string, unless we create a new node

        if node_id in self.data.nodes:
            node = self.data.nodes[node_id]
        else:
            node = Node.default_node(node_id)
            info_string = create_string

        # obtain node override data and purge if need be
        overrides = self.data.nodes_overrides.get(id, {})
        if overrides.get("purge", False):
            if id in self.data.nodes:
                self.data.nodes.pop(id)
            return

        # may want to ignore some keys for some nodes, including any keys overriden at startup
        ignored_keys = overrides.get('ignore_update_keys', list(overrides.keys()))

        # update node with keyword arguments
        if updates:
            node.update({k:v for k,v in updates.items() if k not in ignored_keys})

        # record time first seen if not already there
        if 'first_seen' not in node:
            node['first_seen'] = datetime.datetime.now().astimezone(ZoneInfo(self.config['server']['timezone']))

        # store the changed node
        self.data.update_node(node_id, node)

        print(info_string.format(node_id=node_id))

        if sort_nodes is not False:
            self.sort_nodes_by_shortname()


    ### message handlers

    def handle_common(self, msg, id_from_payload=None):
        """
        Helper that handles common tasks for incoming messages
        :param msg: Dict object containing the message
        :param id_from_payload: Whether to use the id from the payload as the node id, defaults to trying to use it.
        :return: Tuple containing the node id and an adjusted message dict
        """

        if 'from' in msg:
            msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])

        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])

        # store last part of mqtt topic as sender if missing from message
        if 'sender' not in msg:
            msg['sender'] = msg['topic'].rpartition('/!')[2]

        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        node_id = msg.get('from', None)
        if id_from_payload is not False:
            try:
                if isinstance(msg['payload'], dict):
                    node_id = msg['payload']['id']
                    # revert back to any 'from' address if the payload provides nothing
                    if node_id is None:
                        node_id = msg.get('from', None)
            except KeyError:
                pass

        # calculate hops_away if missing and we have enough info
        if msg.get('hops_away', None) is None and msg.get('hop_start', 0) != 0:
            msg['hops_away'] = msg['hop_start'] - msg['hop_limit']

        return node_id, msg

    async def handle_default(self, msg):
        id, msg = self.handle_common(msg)

        self.node_create_or_update(id, msg=msg)
        await self.data.save()

    async def handle_log(self, msg):
        topic = msg['topic'] if 'topic' in msg else 'unknown'
        if self.config['debug']:
            print(f"MQTT >> {topic} -- {msg}")
        self.data.mqtt_messages.append(msg)
        clean_msg = msg.copy()
        if 'decoded' in clean_msg:
            del clean_msg['decoded']
        if 'encrypted' in clean_msg:
            del clean_msg['encrypted']
        self.data.messages.append(clean_msg)
        with open(f'{self.config["paths"]["data"]}/message-log.jsonl', 'a', encoding='utf-8') as f:
            f.write(f"{msg}\n")

    async def handle_neighborinfo(self, msg):
        id, msg = self.handle_common(msg, id_from_payload=False)

        self.node_create_or_update(id, msg,
                                   sort_nodes=False,
                                   create_string="Node {node_id} skeleton added with neighborinfo",
                                   update_string="Node {node_id} updated with neighborinfo",
                                   neighborinfo=msg['payload'],
                                  )
        await self.data.save()

    async def handle_nodeinfo(self, msg):
        id, msg = self.handle_common(msg, id_from_payload=True)
        node = self.data.nodes.get(id, None)

        update_dict = {}

        if 'hardware' in msg['payload']:
            update_dict['hardware'] = msg['payload']['hardware']
        elif 'hw_model' in msg['payload']:
            update_dict['hardware'] = msg['payload']['hw_model']

        if 'longname' in msg['payload']:
            update_dict['longname'] = msg['payload']['longname']
        elif 'long_name' in msg['payload']:
            update_dict['longname'] = msg['payload']['long_name']

        if 'shortname' in msg['payload']:
            update_dict['shortname'] = msg['payload']['shortname']
        elif 'short_name' in msg['payload']:
            update_dict['shortname'] = msg['payload']['short_name']

        if 'role' in msg['payload']:
            update_dict['role'] = msg['payload']['role']

        self.node_create_or_update(id, msg,
                                   create_string="Node {node_id} added",
                                   update_string="Node {node_id} updated",
                                   **update_dict,
                                  )
        await self.data.save()

    async def handle_position(self, msg):
        id, msg = self.handle_common(msg, id_from_payload=False)
        position=msg['payload'] if 'payload' in msg else None

        self.node_create_or_update(id, msg,
                                   sort_nodes=False,
                                   create_string="Node {node_id} skeleton added with position",
                                   update_string="Node {node_id} updated with position",
                                   position=position,
                                   last_position_update=datetime.datetime.fromtimestamp(msg['timestamp']).astimezone(ZoneInfo(self.config['server']['timezone'])),
                                  )
        await self.data.save()

    async def handle_telemetry(self, msg):
        id, msg = self.handle_common(msg, id_from_payload=False)

        self.node_create_or_update(id, msg,
                                   sort_nodes=False,
                                   create_string="Node {node_id} skeleton added with telemetry",
                                   update_string="Node {node_id} updated with telemetry",
                                   telemetry=msg['payload'] if 'payload' in msg else None
                                  )

        # only hold onto data about telemetry if our config has us saving it (store) and/or keeping it in memory (retain)
        history_settings = self.config.get('history', {}).get('telemetry', {})
        if history_settings.get('store', True) or history_settings.get('retain', True):

            if id not in self.data.telemetry_by_node:
                self.data.telemetry_by_node[id] = []

            if 'payload' in msg:
                self.data.telemetry.insert(0, msg)
                self.data.telemetry_by_node[id].insert(0, msg)

        await self.data.save()

    async def handle_text(self, msg):
        id, msg = self.handle_common(msg, id_from_payload=False)
        if 'channel' not in msg:
            msg['channel'] = "0"

        if str(msg['channel']) not in self.data.chat['channels']:
            self.data.chat['channels'][str(msg['channel'])] = {
                'name': f'Channel {msg["channel"]}',
                'messages': []
            }

        chat = {
            'id': id,
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

        # TODO: Replace with something more configurable
        update_dict = {'tc2_bbs': True} if 'TC' in chat['text'] and 'BBS' in chat['text'] and 'Commands' in chat['text'] else {}

        self.node_create_or_update(id, msg,
                                   sort_nodes=False,
                                   create_string="Node {node_id} skeleton added with text",
                                   update_string="Node {node_id} updated with text",
                                   **update_dict,
                                  )

        await self.data.save()

    async def handle_traceroute(self, msg):

        id, msg = self.handle_common(msg, id_from_payload=False)

        # creating/doing empty update of the node first, in case needed for route lookup
        self.node_create_or_update(id, msg,
                                   sort_nodes=False,
                                   create_string="Node {node_id} skeleton added with traceroute",
                                   update_string="Node {node_id} updated with traceroute",
                                  )

        msg['route_ids'] = []
        for r in msg['payload']['route']:
            if isinstance(r, str):
                node_id = r
            elif isinstance(r, int):
                node_id = utils.convert_node_id_from_int_to_hex(r)
            else:
                node_id = None

            msg['route_ids'].append(node_id)

        history_settings = self.config.get('history', {}).get('traceroutes', {})
        if history_settings.get('store', True) or history_settings.get('retain', True):
            if id in self.data.traceroutes_by_node:
                self.data.traceroutes_by_node[id].insert(0, msg)
            else:
                self.data.traceroutes_by_node[id] = [msg]
            self.data.traceroutes.insert(0, msg)
        await self.data.save()

    ### helpers

    # TODO: where should this really live?
    async def prune_expired_nodes(self):
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
