#!/usr/bin/env python3

import asyncio
import base64
import datetime
import json
import logging
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

logger = logging.getLogger(__name__)

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
        logger.info("Connecting to MQTT broker at %s:%d", self.config['broker']['host'], self.config['broker']['port'])
        while True:
            try:
                async with aiomqtt.Client(
                    hostname = self.config["broker"]["host"],
                    port = self.config["broker"]["port"],
                    identifier = self.config["broker"]["client_id"],
                    username = self.config["broker"]["username"],
                    password = self.config["broker"]["password"],
                ) as client:
                    logger.info("Connected to MQTT broker at %s:%d", self.config["broker"]["host"], self.config["broker"]["port"])
                    if "topics" in self.config["broker"] and self.config["broker"]["topics"] is not None and isinstance(self.config["broker"]["topics"], list):
                        for topic in self.config["broker"]["topics"]:
                            await client.subscribe(topic)
                    elif "topic" in self.config["broker"] and self.config["broker"]["topic"] is not None and isinstance(self.config["broker"]["topic"], str):
                        await client.subscribe(self.config["broker"]["topic"])
                    else:
                        raise RuntimeError("No MQTT topics to subscribe to defined in config broker.topics or broker.topic")

                    self.data.mqtt_connect_time = datetime.datetime.now(ZoneInfo(self.config['server']['timezone']))
                    async for msg in client.messages:
                        # paho adds a timestamp to messages which is not in
                        # aiomqtt. We will do that ourself here so it is compatible.
                        msg.timestamp = time.monotonic() # type: ignore
                        await self.process_mqtt_msg(client, msg)
            except aiomqtt.MqttError as err:
                logger.warning("Disconnected from MQTT broker: %s", err)
                logger.info("Reconnecting...")
                await asyncio.sleep(5)

    async def process_mqtt_msg(self, client, msg):
        if self.config['broker']['decoders']['protobuf']['enabled']:
            if'/2/e/' in msg.topic.value or '/2/map/' in msg.topic.value:
                logger.debug("Received a protobuf message: %s %s", msg.topic, msg.payload)
                is_encrypted = False
                mp = mesh_pb2.MeshPacket()
                outs = {}

                try:
                    se = mqtt_pb2.ServiceEnvelope()
                    se.ParseFromString(msg.payload)
                    mp = se.packet
                    outs = json.loads(MessageToJson(mp, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                    logger.debug("Decoded protobuf message: %s", outs)
                except Exception as _:
                    pass

                if mp.HasField("encrypted") and not mp.HasField("decoded"):
                    is_encrypted = True
                    for key_item in self.config['broker']['channels']['encryption']:
                        key_bytes = base64.b64decode(key_item['key'].encode('ascii'))
                        try:
                            logger.debug("Attempting decryption with key: %s", key)
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
                            break
                        except Exception as e:
                            logger.debug("Decryption failed: %s", e)
                            continue

                outs['rssi'] = mp.rx_rssi
                outs['snr'] = mp.rx_snr
                # Clamp rx_time to current time if node clock is ahead
                rx_time = mp.rx_time
                now_epoch = int(time.time())
                if rx_time and rx_time > now_epoch + 300:  # 5 min tolerance
                    node_id = utils.convert_node_id_from_int_to_hex(getattr(mp, "from", 0))
                    logger.warning("Node %s has future clock: rx_time=%s (%.0f min ahead), clamping to now", node_id, rx_time, (rx_time - now_epoch) / 60)
                    rx_time = now_epoch
                outs['timestamp'] = rx_time
                outs['topic'] = msg.topic.value
                outs["qos"] = getattr(msg, "qos", None)
                outs["retain"] = getattr(msg, "retain", None)

                # Calculate hops_away from hop_start and hop_limit
                hop_start = outs.get("hop_start")
                hop_limit = outs.get("hop_limit")
                if hop_start is not None and hop_limit is not None:
                    try:
                        outs["hops_away"] = int(hop_start) - int(hop_limit)
                    except (ValueError, TypeError):
                        pass

                if mp.decoded.portnum == portnums_pb2.TEXT_MESSAGE_APP:
                    payload_bytes = bytes(mp.decoded.payload)
                    try:
                        text = payload_bytes.decode("utf-8")
                        outs["type"] = "text"
                        outs["payload"] = {"text": text}
                        logger.debug("Decoded protobuf message: text: %s", outs)
                        await self.handle_text(outs)

                    except UnicodeDecodeError:
                        outs["type"] = "text_binary"
                        outs["payload"] = {
                            "text_b64": base64.b64encode(payload_bytes).decode("ascii"),
                            "len": len(payload_bytes),
                        }
                        logger.debug("Decoded protobuf message: text_binary: %s", outs)
                        # log it, but don't treat as chat text
                        await self.handle_log(outs)

                elif mp.decoded.portnum == portnums_pb2.MAP_REPORT_APP:
                    try:
                        report = mesh_pb2.Position().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(report, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                        outs["type"] = "mapreport"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: mapreport: %s", outs)
                        # self.handle_mapreport(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.NEIGHBORINFO_APP:
                    try:
                        info = mesh_pb2.NeighborInfo().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                        outs["type"] = "neighborinfo"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: neighborinfo: %s", outs)
                        await self.handle_neighborinfo(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.NODEINFO_APP:
                    try:
                        info = mesh_pb2.User().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        if isinstance(out['id'], int):
                            out["id"] = utils.convert_node_id_from_int_to_hex(out['id'])
                        out["id"] = out['id'].replace('!', '')
                        outs["type"] = "nodeinfo"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: nodeinfo: %s", outs)
                        await self.handle_nodeinfo(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.ROUTING_APP:
                    try:
                        data = mesh_pb2.Routing().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(data, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        outs["type"] = "routing"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: routing: %s", outs)
                        # self.handle_routing(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.TRACEROUTE_APP:
                    try:
                        route = mesh_pb2.RouteDiscovery().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(route, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                        if 'route' in out:
                            route = []
                            for r in out['route']:
                                id = utils.convert_node_id_from_int_to_hex(int(r))
                                route.append(id)
                            outs["route"] = route
                        outs["type"] = "traceroute"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: traceroute: %s", outs)
                        await self.handle_traceroute(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.POSITION_APP:
                    try:
                        pos = mesh_pb2.Position().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(pos, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        outs["type"] = "position"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: position: %s", outs)
                        await self.handle_position(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)

                elif mp.decoded.portnum == portnums_pb2.TELEMETRY_APP:
                    try:
                        env = telemetry_pb2.Telemetry().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(env, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        if 'timestamp' in outs and outs['timestamp'] is not None:
                            out['timestamp'] = datetime.datetime.fromtimestamp(int(outs['timestamp'])).astimezone(
                                ZoneInfo(self.config['server']['timezone'])
                            )
                        outs["type"] = "telemetry"

                        # Determine the telemetry variant using protobuf oneof
                        variant = env.WhichOneof('variant')
                        outs["telemetry_type"] = variant  # e.g. "device_metrics", "environment_metrics", etc.

                        if variant and variant in out:
                            outs["payload"] = out[variant]
                        elif 'device_metrics' in out:
                            # Fallback for edge cases where WhichOneof returns None
                            outs["payload"] = out['device_metrics']
                            outs["telemetry_type"] = "device_metrics"
                        elif 'environment_metrics' in out:
                            outs["payload"] = out['environment_metrics']
                            outs["telemetry_type"] = "environment_metrics"
                        else:
                            # Unknown or empty telemetry variant; mark telemetry_type explicitly
                            outs["payload"] = out
                            outs["telemetry_type"] = "unknown"
                            logger.debug("Telemetry with unrecognized variant=%s: %s", variant, out)

                        logger.debug("Decoded protobuf message: telemetry (variant=%s): %s", variant, outs)
                        await self.handle_telemetry(outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    except Exception as e:
                        logger.error("Telemetry processing error: %s", e)

                else:
                    logger.debug("Received an unknown protobuf message: %s", mp)
                    outs["type"] = "unknown"
                    if mp.decoded.payload is not None:
                        try:
                            outs["payload"] = mp.decoded.payload.decode("utf-8")
                        except UnicodeDecodeError as e:
                            logger.debug("Unicode decoding error: text: %s", e)
                            outs["payload"] = {}
                        except DecodeError as e:
                            logger.debug("Protobuf decode error: text: %s", e)
                            outs["payload"] = {}
                    else:
                        outs["payload"] = {}

                logger.debug("Processed message: %s", outs)
                await self.handle_log(outs)
                await self.prune_expired_nodes()

        elif self.config['broker']['decoders']['json']['enabled']:
            if '/2/json' in msg.topic.value:
                logger.debug("Received a JSON message: %s %s", msg.topic, msg.payload)
                try:
                    decoded = msg.payload.decode("utf-8")
                    j = json.loads(decoded, cls=_JSONDecoder)
                    j['topic'] = msg.topic.value
                    j["qos"] = getattr(msg, "qos", None)
                    j["retain"] = getattr(msg, "retain", None)

                    await self.handle_log(j)

                    if j['type'] == "neighborinfo":
                        await self.handle_neighborinfo(j)
                    if j['type'] == "nodeinfo":
                        await self.handle_nodeinfo(j)
                    if j['type'] == "position":
                        await self.handle_position(j)
                    if j['type'] == "telemetry":
                        await self.handle_telemetry(j)
                    if j['type'] == "text":
                        await self.handle_text(j)
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
                        await self.handle_traceroute(j)
                    await self.prune_expired_nodes()
                except Exception as e:
                    logger.error("JSON message processing error: %s", e, exc_info=True)

    async def publish(self, client, topic, msg):
        result = await client.publish(topic, msg)
        status = result[0]
        if status == 0:
            logger.debug("Sent message to topic %s", topic)
            return True
        else:
            logger.warning("Failed to send message to topic %s", topic)
            return False

    async def subscribe(self, client, topic):
        client.subscribe(topic)
        logger.info("Subscribed to topic %s", topic)

    async def unsubscribe(self, client, topic):
        client.unsubscribe(topic)

    ### message handlers

    async def handle_log(self, msg):
        topic = msg['topic'] if 'topic' in msg else 'unknown'
        logger.debug("MQTT >> %s -- %s", topic, msg)

        self.data.mqtt_messages.append(msg)

        clean_msg = msg.copy()
        clean_msg.pop("decoded", None)
        clean_msg.pop("encrypted", None)

        self.data.messages.append(clean_msg)

        # Real-time write to Postgres if enabled (raw MQTT log table)
        if 'postgres' in self.config.get('storage', {}).get('write_to', []):
            try:
                await self.data.pg_storage.write_mqtt_message(clean_msg)
            except Exception as e:
                logger.error("Failed to write mqtt_message to postgres: %s", e)
                if self.config.get('debug'):
                    logger.debug("Postgres write traceback", exc_info=True)


    async def handle_neighborinfo(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['neighborinfo'] = msg['payload']
        else:
            node = Node.default_node(id)
            node['neighborinfo'] = msg['payload']
        if msg.get('sender'):
            node['gateway'] = msg['sender']
        self.data.update_node(id, node)
        logger.debug("Node %s updated with neighborinfo", id)
        await self.data.save()

    async def handle_nodeinfo(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['payload']['id']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            logger.debug("Updating node %s", id)
        else:
            node = Node.default_node(id)
            logger.debug("Discovered node %s", id)

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

        if 'role' in msg['payload']:
            node['role'] = msg['payload']['role']
        else:
            node['role'] = 0

        if msg.get('sender'):
            node['gateway'] = msg['sender']

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        self.data.update_node(id, node)

        self.sort_nodes_by_shortname()
        await self.data.save()

    async def handle_position(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        if id in self.data.nodes:
            node = self.data.nodes[id]
            node['position'] = msg['payload'] if 'payload' in msg else None
        else:
            node = Node.default_node(id)
            node['position'] = msg['payload'] if 'payload' in msg else None
            self.data.update_node(id, node)
            logger.debug("Node %s skeleton added with position", id)

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        # Emit event for Discord bridge
        try:
            self.data.discord_event_queue.put_nowait({
                'type': 'position',
                'msg': msg,
                'node_id': id,
            })
        except asyncio.QueueFull:
            pass  # Drop event if consumer is behind

        await self.data.save()

    async def handle_telemetry(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')

        id = msg['from']
        telemetry_type = msg.get('telemetry_type')
        payload = msg.get('payload')

        if id in self.data.nodes:
            node = self.data.nodes[id]
        else:
            node = Node.default_node(id)

        # Merge incoming telemetry into the node's existing telemetry dict
        # instead of replacing it entirely. This preserves device_metrics
        # fields when an environment_metrics message arrives, and vice versa.
        if payload is not None:
            existing = node.get('telemetry')
            if existing is None or not isinstance(existing, dict):
                existing = {}
            # Merge: new fields overwrite, but fields not in this payload survive
            existing.update(payload)
            node['telemetry'] = existing

        if msg.get('sender'):
            node['gateway'] = msg['sender']

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        self.data.update_node(id, node)
        logger.debug("Node %s updated with telemetry (variant=%s)", id, telemetry_type)

        if id not in self.data.telemetry_by_node:
            self.data.telemetry_by_node[id] = []

        if payload is not None:
            self.data.telemetry.insert(0, msg)
            self.data.telemetry_by_node[id].insert(0, msg)

            # Real-time write to Postgres if enabled
            if 'postgres' in self.config.get('storage', {}).get('write_to', []):
                # Write to telemetry history table
                await self.data.pg_storage.write_telemetry(id, msg)

                # Update node_telemetry_current with variant-aware write.
                # For JSONB variants (power_metrics, air_quality, etc.) this
                # stores the payload in the correct JSONB column. For typed
                # variants (device_metrics, environment_metrics) it updates
                # the individual typed columns as before.
                if self.data.pg_storage and self.data.pg_storage.pool:
                    try:
                        async with self.data.pg_storage.pool.acquire() as conn:
                            await self.data.pg_storage._write_node_telemetry_current(
                                conn, id, payload, telemetry_type=telemetry_type
                            )
                    except Exception as e:
                        logger.error("Failed to update node_telemetry_current for node %s: %s", id, e)
                else:
                    logger.warning(
                        "handle_telemetry: pg_storage or pool not available; "
                        "skipping node_telemetry_current update for node %s", id
                    )

        await self.data.save()

    async def handle_text(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')
        if 'channel' not in msg:
            msg['channel'] = "0"

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
        
        # Real-time write to Postgres if enabled
        if 'postgres' in self.config.get('storage', {}).get('write_to', []):
            await self.data.pg_storage.write_chat_message(chat['from'], chat)

        node = self.data.find_node_by_hex_id(msg['from'])
        # TODO: Replace with something more configurable
        if node:
            if 'TC' in chat['text'] and 'BBS' in chat['text'] and 'Commands' in chat['text']:
                node['tc2_bbs'] = True
            node['last_channel'] = str(msg['channel'])
            self.data.update_node(node['id'], node)

        # Emit event for Discord bridge
        try:
            self.data.discord_event_queue.put_nowait({
                'type': 'text',
                'msg': msg,
                'chat': chat,
            })
        except asyncio.QueueFull:
            pass  # Drop event if consumer is behind

        await self.data.save()

    async def handle_traceroute(self, msg):
        msg['from'] = utils.convert_node_id_from_int_to_hex(msg["from"])
        if 'to' in msg:
            msg['to'] = utils.convert_node_id_from_int_to_hex(msg["to"])
        if 'sender' in msg and msg['sender'] and isinstance(msg['sender'], str):
            msg['sender'] = msg['sender'].replace('!', '')
        msg['route'] = msg['payload']['route']
        msg['route_ids'] = []
        for r in msg['route']:
            if isinstance(r, str):
                node = self.data.find_node_by_longname(r)
            elif isinstance(r, int):
                node = self.data.find_node_by_hex_id(utils.convert_node_id_from_int_to_hex(r))
            else:
                node = None

            if node:
                msg['route_ids'].append(node['id'])
            else:
                msg['route_ids'].append(r)

        id = msg['from']
        if id in self.data.traceroutes_by_node:
            self.data.traceroutes_by_node[id].insert(0, msg)
        else:
            self.data.traceroutes_by_node[id] = [msg]
        self.data.traceroutes.insert(0, msg)
        
        # Real-time write to Postgres if enabled
        if 'postgres' in self.config.get('storage', {}).get('write_to', []):
            await self.data.pg_storage.write_traceroute(id, msg)
        
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
                logger.warning("Node %s has invalid last_seen: %s", id, node['last_seen'])
                self.data.nodes[id]['last_seen'] = None
                self.data.nodes[id]['active'] = False
            if node['active'] and since >= self.config['server']['node_activity_prune_threshold']:
                ids_to_delete.append(node['id'])
                logger.debug("Node %s pruned (last heard %d seconds ago)", id, since)

        for id in ids_to_delete:
            self.data.nodes[id]['active'] = False

    # TODO: where should this really live?
    def sort_nodes_by_shortname(self):
        self.data.nodes = dict(sorted(self.data.nodes.items(), key=lambda item: item[1]["shortname"]))