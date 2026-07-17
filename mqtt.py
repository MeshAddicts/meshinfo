#!/usr/bin/env python3

import asyncio
import base64
import datetime
import json
import logging
import time
import traceback
from typing import Optional
from zoneinfo import ZoneInfo
import aiomqtt
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2, telemetry_pb2
from google.protobuf.json_format import MessageToJson
from google.protobuf.message import DecodeError
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from fastapi.encoders import jsonable_encoder

from encoders import _JSONDecoder
from models.node import Node
import utils
from utils import normalize_node_id

logger = logging.getLogger(__name__)

class MQTT:
    _DISCORD_DROP_LOG_EVERY = 100

    def __init__(self, config, data):
        self.config = config
        self.data = data

        self.host = config['broker']['host']
        self.port = config['broker']['port']
        self.client_id = config['broker']['client_id']
        self.username = config['broker']['username']
        self.password = config['broker']['password']

        # Discord bridge queue is bounded; we'd rather drop than balloon memory.
        # Track drops so the warning at every Nth surfaces a stalled consumer.
        self._discord_drops_total: int = 0

    def _record_discord_drop(self, event_type: str) -> None:
        self._discord_drops_total += 1
        if self._discord_drops_total % self._DISCORD_DROP_LOG_EVERY == 0:
            logger.warning(
                "Discord bridge queue full; dropped %d events so far (latest type=%s) — consumer may be stalled",
                self._discord_drops_total, event_type,
            )

    ### actions

    async def connect(self):
        # Single attempt; main.py's supervise() owns reconnect + exponential backoff.
        logger.info("Connecting to MQTT broker at %s:%d", self.config['broker']['host'], self.config['broker']['port'])
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
            # Friendly log before re-raising; supervise() will log the traceback at restart.
            logger.warning("Disconnected from MQTT broker: %s", err)
            raise

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
                    # Extract gateway_id (the node that uplinked this packet to MQTT)
                    if se.gateway_id:
                        gw = se.gateway_id.replace('!', '')
                        if len(gw) <= 8:
                            outs['sender'] = gw
                    logger.debug("Decoded protobuf message: %s", outs)
                except DecodeError as e:
                    logger.warning("Discarding malformed protobuf ServiceEnvelope on %s: %s", msg.topic.value, e)
                    return
                except Exception as e:
                    # Returning early avoids logging a noisy type='unknown' row for a packet we can't read.
                    logger.exception("Unexpected error decoding protobuf envelope on %s: %s", msg.topic.value, e)
                    return

                if mp.HasField("encrypted") and not mp.HasField("decoded"):
                    is_encrypted = True
                    for key_item in self.config['broker']['channels']['encryption']:
                        key_bytes = base64.b64decode(key_item['key'].encode('ascii'))
                        try:
                            logger.debug("Attempting decryption with key: %s", key_item.get('name', '<unnamed>'))
                            nonce_packet_id = getattr(mp, "id").to_bytes(8, "little")
                            nonce_from_node = getattr(mp, "from").to_bytes(8, "little")
                            nonce = nonce_packet_id + nonce_from_node
                            cipher = Cipher(algorithms.AES(key_bytes), modes.CTR(nonce), backend=default_backend())
                            decryptor = cipher.decryptor()
                            decrypted_bytes = decryptor.update(getattr(mp, "encrypted")) + decryptor.finalize()
                            data = mesh_pb2.Data()
                            data.ParseFromString(decrypted_bytes)
                            mp.decoded.CopyFrom(data)
                            saved_sender = outs.get('sender')
                            outs = json.loads(MessageToJson(mp, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                            if saved_sender:
                                outs['sender'] = saved_sender
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

                # Fallback: extract gateway from topic suffix if gateway_id was empty
                if not outs.get('sender'):
                    topic_parts = msg.topic.value.split('/')
                    if topic_parts and topic_parts[-1].startswith('!'):
                        outs['sender'] = topic_parts[-1].replace('!', '')

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
                    except UnicodeDecodeError:
                        outs["type"] = "text_binary"
                        outs["payload"] = {
                            "text_b64": base64.b64encode(payload_bytes).decode("ascii"),
                            "len": len(payload_bytes),
                        }
                        logger.debug("Decoded protobuf message: text_binary: %s", outs)
                    # Route text payloads through the chat handler; binary payloads only get logged.
                    if outs.get("type") == "text":
                        await self._safe_handle("handle_text", self.handle_text(outs))

                elif mp.decoded.portnum == portnums_pb2.MAP_REPORT_APP:
                    try:
                        report = mqtt_pb2.MapReport().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(report, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        outs["type"] = "mapreport"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: mapreport: %s", outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    else:
                        await self._safe_handle("handle_mapreport", self.handle_mapreport(outs))

                elif mp.decoded.portnum == portnums_pb2.NEIGHBORINFO_APP:
                    try:
                        info = mesh_pb2.NeighborInfo().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                        outs["type"] = "neighborinfo"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: neighborinfo: %s", outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    else:
                        await self._safe_handle("handle_neighborinfo", self.handle_neighborinfo(outs))

                elif mp.decoded.portnum == portnums_pb2.NODEINFO_APP:
                    try:
                        info = mesh_pb2.User().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(info, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        # User.id is occasionally unset; MeshPacket.from is the fallback.
                        nid = normalize_node_id(out.get('id')) or normalize_node_id(outs.get('from'))
                        if nid is None:
                            logger.debug("NODEINFO packet missing identity; skipping: %s", out)
                        else:
                            out["id"] = nid
                            outs["type"] = "nodeinfo"
                            outs["payload"] = out
                            logger.debug("Decoded protobuf message: nodeinfo: %s", outs)
                            await self._safe_handle("handle_nodeinfo", self.handle_nodeinfo(outs))
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
                        route_msg = mesh_pb2.RouteDiscovery().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(route_msg, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True, always_print_fields_with_no_presence=True))
                        outs["type"] = "traceroute"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: traceroute: %s", outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    else:
                        await self._safe_handle("handle_traceroute", self.handle_traceroute(outs))

                elif mp.decoded.portnum == portnums_pb2.POSITION_APP:
                    try:
                        pos = mesh_pb2.Position().FromString(mp.decoded.payload)
                        out = json.loads(MessageToJson(pos, preserving_proto_field_name=True, ensure_ascii=False, indent=2, sort_keys=True, use_integers_for_enums=True))
                        outs["type"] = "position"
                        outs["payload"] = out
                        logger.debug("Decoded protobuf message: position: %s", outs)
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    else:
                        await self._safe_handle("handle_position", self.handle_position(outs))

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
                    except UnicodeDecodeError as e:
                        logger.debug("Unicode decoding error: text: %s", e)
                    except DecodeError as e:
                        logger.debug("Protobuf decode error: text: %s", e)
                    except Exception as e:
                        logger.exception("Telemetry decoding error: %s", e)
                    else:
                        await self._safe_handle("handle_telemetry", self.handle_telemetry(outs))

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

        elif self.config['broker']['decoders']['json']['enabled']:
            if '/2/json' in msg.topic.value:
                logger.debug("Received a JSON message: %s %s", msg.topic, msg.payload)
                try:
                    decoded = msg.payload.decode("utf-8")
                    j = json.loads(decoded, cls=_JSONDecoder)
                    j['topic'] = msg.topic.value
                    j["qos"] = getattr(msg, "qos", None)
                    j["retain"] = getattr(msg, "retain", None)

                    # Extract gateway node from topic suffix (e.g. msh/US/2/json/LongFast/!67ea9400)
                    if 'sender' not in j or not j.get('sender'):
                        topic_parts = msg.topic.value.split('/')
                        if topic_parts and topic_parts[-1].startswith('!'):
                            j['sender'] = topic_parts[-1].replace('!', '')

                    await self.handle_log(j)

                    msg_type = j.get('type')
                    if msg_type == "neighborinfo":
                        await self._safe_handle("handle_neighborinfo", self.handle_neighborinfo(j))
                    elif msg_type == "nodeinfo":
                        await self._safe_handle("handle_nodeinfo", self.handle_nodeinfo(j))
                    elif msg_type == "position":
                        await self._safe_handle("handle_position", self.handle_position(j))
                    elif msg_type == "telemetry":
                        await self._safe_handle("handle_telemetry", self.handle_telemetry(j))
                    elif msg_type == "text":
                        await self._safe_handle("handle_text", self.handle_text(j))
                    elif msg_type == "traceroute":
                        await self._safe_handle("handle_traceroute", self.handle_traceroute(j))
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

    async def _safe_handle(self, label: str, coro) -> None:
        """Run a handler coroutine; log + swallow exceptions so one bad packet
        doesn't kill the aiomqtt loop and drop concurrent in-flight messages."""
        try:
            await coro
        except Exception as e:
            logger.exception("%s failed: %s", label, e)

    def _normalize_msg_addrs(self, msg: dict) -> Optional[str]:
        """Normalize msg['from'/'to'/'sender'] in-place; return canonical 'from' or None
        if missing/invalid. Accepts int (protobuf) or hex string (JSON publisher)."""
        from_id = normalize_node_id(msg.get("from"))
        if from_id is None:
            return None
        msg['from'] = from_id
        if 'to' in msg:
            to_id = normalize_node_id(msg['to'])
            if to_id is not None:
                msg['to'] = to_id
            else:
                msg.pop('to', None)
        sender = msg.get('sender')
        if isinstance(sender, str):
            msg['sender'] = sender.replace('!', '')
        return from_id

    async def handle_log(self, msg):
        topic = msg['topic'] if 'topic' in msg else 'unknown'
        logger.debug("MQTT >> %s -- %s", topic, msg)

        clean_msg = msg.copy()
        clean_msg.pop("decoded", None)
        clean_msg.pop("encrypted", None)

        row_id = None
        try:
            row_id = await self.data.pg_storage.write_mqtt_message(clean_msg)
        except Exception as e:
            logger.error("Failed to write mqtt_message to postgres: %s", e)
            if self.config.get('debug'):
                logger.debug("Postgres write traceback", exc_info=True)

        # Live push: raw packet feed (mqtt_row_id lets the client dedup/deeplink).
        if row_id is not None and self.data.broadcaster.subscriber_count:
            try:
                self.data.broadcaster.publish(
                    "packet", jsonable_encoder({**clean_msg, "mqtt_row_id": row_id})
                )
            except Exception as e:
                logger.debug("packet broadcast failed: %s", e)


    async def handle_neighborinfo(self, msg):
        id = self._normalize_msg_addrs(msg)
        if id is None:
            logger.debug("handle_neighborinfo: missing/invalid 'from'; skipping: %s", msg)
            return
        payload = msg.get('payload')
        if not isinstance(payload, dict):
            logger.debug("handle_neighborinfo: missing/invalid payload for %s; skipping", id)
            return

        node = await self.data.pg_storage.get_node_cached(id)
        if node is None:
            node = Node.default_node(id)
        node['neighborinfo'] = payload
        if msg.get('sender'):
            node['gateway'] = msg['sender']
        await self.data.update_node(id, node)
        logger.debug("Node %s updated with neighborinfo", id)

    async def handle_nodeinfo(self, msg):
        from_id = self._normalize_msg_addrs(msg)
        payload = msg.get('payload')
        if not isinstance(payload, dict):
            logger.debug("handle_nodeinfo: missing/invalid payload; skipping: %s", msg)
            return

        # User.id when present, MeshPacket 'from' as fallback.
        id = normalize_node_id(payload.get('id')) or from_id
        if id is None:
            logger.debug("handle_nodeinfo: no usable node id; skipping: %s", msg)
            return

        node = await self.data.pg_storage.get_node_cached(id)
        if node is None:
            node = Node.default_node(id)
            logger.debug("Discovered node %s", id)
        else:
            logger.debug("Updating node %s", id)

        # Different decoders emit snake_case or camelCase for the same field.
        if 'hardware' in payload:
            node['hardware'] = payload['hardware']
        elif 'hw_model' in payload:
            node['hardware'] = payload['hw_model']

        if 'longname' in payload:
            node['longname'] = payload['longname']
        elif 'long_name' in payload:
            node['longname'] = payload['long_name']

        if 'shortname' in payload:
            node['shortname'] = payload['shortname']
        elif 'short_name' in payload:
            node['shortname'] = payload['short_name']

        if 'role' in payload:
            node['role'] = payload['role']
        else:
            node['role'] = 0

        if msg.get('sender'):
            node['gateway'] = msg['sender']

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        await self.data.update_node(id, node)

    async def handle_mapreport(self, msg):
        from_id = self._normalize_msg_addrs(msg)
        if from_id is None:
            logger.debug("handle_mapreport: missing/invalid 'from'; skipping: %s", msg)
            return
        payload = msg.get('payload')
        if not isinstance(payload, dict):
            logger.debug("handle_mapreport: missing/invalid payload; skipping: %s", msg)
            return

        node = await self.data.pg_storage.get_node_cached(from_id)
        if node is None:
            node = Node.default_node(from_id)
            logger.debug("Discovered node %s via mapreport", from_id)

        if payload.get('long_name'):
            node['longname'] = payload['long_name']
        if payload.get('short_name'):
            node['shortname'] = payload['short_name']
        if 'hw_model' in payload:
            node['hardware'] = payload['hw_model']
        # proto3 omits zero enums: an absent role means CLIENT (0), same as NODEINFO.
        node['role'] = payload.get('role', 0)

        # Map reports carry no timestamp, so only fill a position for nodes
        # that have none — a real POSITION packet owns the field once seen
        # (the node_positions upsert rejects timeless updates over timestamped
        # ones; this guard keeps the node cache consistent with that).
        if not node.get('position') and payload.get('latitude_i') and payload.get('longitude_i'):
            node['position'] = {
                'latitude_i': payload['latitude_i'],
                'longitude_i': payload['longitude_i'],
                'altitude': payload.get('altitude'),
                'precision_bits': payload.get('position_precision'),
            }

        if msg.get('sender'):
            node['gateway'] = msg['sender']

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        await self.data.update_node(from_id, node)

    async def handle_position(self, msg):
        id = self._normalize_msg_addrs(msg)
        if id is None:
            logger.debug("handle_position: missing/invalid 'from'; skipping: %s", msg)
            return

        node = await self.data.pg_storage.get_node_cached(id)
        if node is None:
            node = Node.default_node(id)
            logger.debug("Node %s skeleton added with position", id)

        node['position'] = msg.get('payload')

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        await self.data.update_node(id, node)

        # Emit event for Discord bridge
        try:
            self.data.discord_event_queue.put_nowait({
                'type': 'position',
                'msg': msg,
                'node_id': id,
            })
        except asyncio.QueueFull:
            self._record_discord_drop('position')


    async def handle_telemetry(self, msg):
        id = self._normalize_msg_addrs(msg)
        if id is None:
            logger.debug("handle_telemetry: missing/invalid 'from'; skipping: %s", msg)
            return
        telemetry_type = msg.get('telemetry_type')
        payload = msg.get('payload')

        node = await self.data.pg_storage.get_node_cached(id)
        if node is None:
            node = Node.default_node(id)

        # Merge incoming telemetry into the node's existing telemetry dict
        # instead of replacing it entirely. This preserves device_metrics
        # fields when an environment_metrics message arrives, and vice versa.
        if payload is not None:
            existing = node.get('telemetry')
            if existing is None or not isinstance(existing, dict):
                existing = {}
            existing.update(payload)
            node['telemetry'] = existing

        if msg.get('sender'):
            node['gateway'] = msg['sender']

        if 'channel' in msg:
            node['last_channel'] = str(msg['channel'])

        await self.data.update_node(id, node)
        logger.debug("Node %s updated with telemetry (variant=%s)", id, telemetry_type)

        if payload is not None:
            await self.data.pg_storage.write_telemetry(id, msg)
            # node_telemetry_current uses a variant-aware write so a device_metrics
            # message doesn't NULL out environment_metrics columns and vice versa.
            if self.data.pg_storage.pool:
                try:
                    async with self.data.pg_storage.pool.acquire() as conn:
                        await self.data.pg_storage._write_node_telemetry_current(
                            conn, id, payload, telemetry_type=telemetry_type
                        )
                except Exception as e:
                    logger.error("Failed to update node_telemetry_current for node %s: %s", id, e)

            # Live push: telemetry sample (feeds the Telemetry page charts/feed).
            if self.data.broadcaster.subscriber_count:
                try:
                    self.data.broadcaster.publish("telemetry", jsonable_encoder(msg))
                except Exception as e:
                    logger.debug("telemetry broadcast failed: %s", e)


    async def handle_text(self, msg):
        from_id = self._normalize_msg_addrs(msg)
        if from_id is None:
            logger.debug("handle_text: missing/invalid 'from'; skipping: %s", msg)
            return
        if 'channel' not in msg:
            msg['channel'] = "0"

        payload = msg.get('payload')
        text = payload.get('text') if isinstance(payload, dict) else None
        if not isinstance(text, str):
            logger.debug("handle_text: missing payload.text for %s; skipping", from_id)
            return

        msg_id = msg.get('id')
        timestamp = msg.get('timestamp')
        if msg_id is None or timestamp is None:
            logger.debug("handle_text: missing id/timestamp for %s; skipping", from_id)
            return

        chat = {
            'id': msg_id,
            'from': from_id,
            'to': msg.get('to'),
            'channel': str(msg['channel']),
            'text': text,
            'timestamp': timestamp,
            'hops_away': msg.get('hops_away'),
            'rssi': msg.get('rssi'),
            'snr': msg.get('snr'),
        }
        if 'sender' in msg:
            chat['sender'] = msg['sender']

        await self.data.pg_storage.write_chat_message(from_id, chat)

        # Live push: a new chat message. Published before the node update below
        # so a chat still streams even if the node touch no-ops.
        try:
            self.data.broadcaster.publish("chat", jsonable_encoder(chat))
        except Exception as e:
            logger.debug("chat broadcast failed: %s", e)

        node = await self.data.pg_storage.get_node_cached(from_id)
        # TODO: Replace with something more configurable
        if node:
            if 'TC' in text and 'BBS' in text and 'Commands' in text:
                node['tc2_bbs'] = True
            node['last_channel'] = str(msg['channel'])
            await self.data.update_node(node['id'], node)

        # Emit event for Discord bridge
        try:
            self.data.discord_event_queue.put_nowait({
                'type': 'text',
                'msg': msg,
                'chat': chat,
            })
        except asyncio.QueueFull:
            self._record_discord_drop('text')


    async def handle_traceroute(self, msg):
        id = self._normalize_msg_addrs(msg)
        if id is None:
            logger.debug("handle_traceroute: missing/invalid 'from'; skipping: %s", msg)
            return
        payload = msg.get('payload')
        route = payload.get('route') if isinstance(payload, dict) else None
        if not isinstance(route, list):
            logger.debug("handle_traceroute: missing payload.route for %s; skipping", id)
            return

        msg['route'] = route
        msg['route_ids'] = []
        for r in route:
            if isinstance(r, str):
                # JSON publisher path: route entries arrive as longnames.
                node = await self.data.pg_storage.find_node_by_longname(r)
            elif isinstance(r, int):
                # Protobuf path: route entries are uint32 node ids.
                node = await self.data.pg_storage.get_node_cached(utils.convert_node_id_from_int_to_hex(r))
            else:
                node = None

            if node:
                msg['route_ids'].append(node['id'])
            else:
                msg['route_ids'].append(r)

        await self.data.pg_storage.write_traceroute(id, msg)

        # Live push: resolved multi-hop path for the map's traceroute tracer.
        if self.data.broadcaster.subscriber_count:
            try:
                self.data.broadcaster.publish(
                    "traceroute",
                    jsonable_encoder(
                        {
                            "from": id,
                            "to": msg.get("to"),
                            "route_ids": msg["route_ids"],
                            "id": msg.get("id"),
                        }
                    ),
                )
            except Exception as e:
                logger.debug("traceroute broadcast failed: %s", e)