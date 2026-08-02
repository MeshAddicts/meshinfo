"""
Shared test scaffolding for the MQTT test modules.

Inline fakes: record interactions without touching the network or a real DB.
Imported as a plain module (`from _helpers import ...`) — tests/conftest.py
puts this directory on sys.path so the import works under any pytest
import mode.
"""

import asyncio

from broadcaster import Broadcaster


class FakePgStorage:
    def __init__(self, nodes=None):
        self._nodes: dict = dict(nodes or {})
        self.writes: list = []
        self.chat_writes: list = []
        self.telemetry_writes: list = []
        self.traceroute_writes: list = []
        self.mqtt_writes: list = []
        self._mqtt_row_seq = 0
        self.pool = None  # disables _write_node_telemetry_current side-branch

    async def write_mqtt_message(self, mqtt_msg) -> int:
        self.mqtt_writes.append(dict(mqtt_msg))
        self._mqtt_row_seq += 1
        return self._mqtt_row_seq

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

    async def write_traceroute(self, node_id: str, msg) -> None:
        self.traceroute_writes.append((node_id, dict(msg)))

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
