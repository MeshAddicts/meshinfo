"""
Shared test scaffolding for the MQTT test modules.

Inline fakes: record interactions without touching the network or a real DB.
Imported as a plain module (`from _helpers import ...`) — tests/conftest.py
puts this directory on sys.path so the import works under any pytest
import mode.
"""

import asyncio

from meshtastic import mesh_pb2, mqtt_pb2
from broadcaster import Broadcaster


class FakePgStorage:
    def __init__(self, nodes=None):
        self._nodes: dict = dict(nodes or {})
        self.writes: list = []
        self.chat_writes: list = []
        self.telemetry_writes: list = []
        self.traceroute_writes: list = []
        self.mqtt_writes: list = []
        self.rebucket_calls: list = []
        self.name_bucket_names: list = []
        self.label_calls: list = []
        self.rebucket_fail_times = 0
        self._mqtt_row_seq = 0
        self.pool = None  # disables _write_node_telemetry_current side-branch

    async def rebucket_name_channel(self, name: str, learned_hash: int) -> None:
        self.rebucket_calls.append((name, learned_hash))
        if self.rebucket_fail_times > 0:
            self.rebucket_fail_times -= 1
            raise RuntimeError("simulated merge failure")

    async def get_name_bucket_names(self) -> list:
        return list(self.name_bucket_names)

    async def ensure_channel_label(self, channel_id: str, name: str) -> bool:
        self.label_calls.append((channel_id, name))
        return True

    async def write_mqtt_message(self, mqtt_msg) -> int:
        self.mqtt_writes.append(dict(mqtt_msg))
        self._mqtt_row_seq += 1
        return self._mqtt_row_seq

    # Flood-guard peeks (per-node budget + id-less repeat); tests flip these.
    over_budget_nodes: set = frozenset()
    idless_repeats: int = 0  # >0: the next N idless_repeat() calls answer True

    def node_over_budget(self, node_id) -> bool:
        return node_id in self.over_budget_nodes

    def idless_repeat(self, msg) -> bool:
        if self.idless_repeats > 0:
            self.idless_repeats -= 1
            return True
        return False

    async def get_node_cached(self, node_id: str):
        return self._nodes.get(node_id)

    def cache_node_set(self, node_id: str, node) -> None:
        self._nodes[node_id] = node

    async def write_node(self, node_id: str, node) -> None:
        # Copy on write so test assertions see a snapshot of the moment.
        self._nodes[node_id] = node
        self.writes.append((node_id, dict(node)))

    async def write_chat_message(self, from_id: str, chat) -> None:
        self.chat_writes.append((from_id, dict(chat)))

    async def write_telemetry(self, node_id: str, msg) -> None:
        self.telemetry_writes.append((node_id, dict(msg)))

    async def write_traceroute(self, node_id: str, msg) -> str:
        # Mirrors the real upsert's outcome contract ('inserted' | 'upgraded'
        # | 'duplicate'); id-less messages always insert.
        def richness(m):
            p = m.get("payload") or {}
            return sum(
                len(p[k])
                for k in ("route", "route_back", "snr_towards", "snr_back")
                if isinstance(p.get(k), list)
            )

        msg_id = msg.get("id")
        if msg_id is not None:
            for i, (nid, prev) in enumerate(self.traceroute_writes):
                if nid == node_id and prev.get("id") == msg_id:
                    if richness(msg) > richness(prev):
                        # Upgrades keep the original row's created_at.
                        msg["created_at"] = prev.get("created_at")
                        self.traceroute_writes[i] = (node_id, dict(msg))
                        return "upgraded"
                    return "duplicate"
        msg["created_at"] = 1753600000
        self.traceroute_writes.append((node_id, dict(msg)))
        return "inserted"

    async def find_node_by_longname(self, name: str):
        for nid, n in self._nodes.items():
            if n.get("longname", "").lower() == name.lower():
                return dict(n, id=nid)
        return None


class FakeDataStore:
    def __init__(self, config, nodes=None):
        self.config = config
        self.pg_storage = FakePgStorage(nodes=nodes)
        self.discord_event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        # Real hub — it's dependency-free, so handlers exercise the actual
        # publish path and tests can drain a subscriber queue.
        self.broadcaster = Broadcaster()

    async def update_node(self, node_id: str, node) -> None:
        await self.pg_storage.write_node(node_id, node)
        self.pg_storage.cache_node_set(node_id, node)


def run(coro):
    """Drive an async function without pytest-asyncio (not in requirements-dev)."""
    return asyncio.run(coro)


class _FakeTopic:
    def __init__(self, value: str):
        self.value = value


class FakeMqttMessage:
    """Minimal aiomqtt message stand-in for driving process_mqtt_msg."""

    def __init__(self, topic: str, payload: bytes, qos: int = 0, retain: bool = False):
        self.topic = _FakeTopic(topic)
        self.payload = payload
        self.qos = qos
        self.retain = retain


def build_envelope(
    from_=0x67EA9400,
    to=0xABCD1234,
    packet_id=123456,
    portnum=1,  # TEXT_MESSAGE_APP
    payload=b"hi",
    hop_start=0,
    hop_limit=0,
    rx_rssi=0,
    rx_snr=0.0,
    rx_time=1753500000,
    channel=0,
    gateway_id="!abcd1234",
    topic="msh/US/2/e/LongFast/!abcd1234",
    request_id=0,
) -> FakeMqttMessage:
    """Serialize a real ServiceEnvelope wrapping an unencrypted MeshPacket, so
    proto3 zero-omission (hop_limit==0, rx_rssi==0, channel==0) is exercised."""
    mp = mesh_pb2.MeshPacket(
        **{"from": from_},
        to=to,
        id=packet_id,
        hop_start=hop_start,
        hop_limit=hop_limit,
        rx_rssi=rx_rssi,
        rx_snr=rx_snr,
        rx_time=rx_time,
        channel=channel,
    )
    mp.decoded.portnum = portnum
    mp.decoded.payload = payload
    mp.decoded.request_id = request_id
    se = mqtt_pb2.ServiceEnvelope(packet=mp, gateway_id=gateway_id, channel_id="LongFast")
    return FakeMqttMessage(topic, se.SerializeToString())
