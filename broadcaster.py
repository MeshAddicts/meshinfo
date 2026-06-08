"""In-process Server-Sent Events fan-out.

A tiny, dependency-free pub/sub used to push live data (node + chat updates)
to connected SSE clients. One bounded ``asyncio.Queue`` per client; producers
call :meth:`publish` from the same event loop. ``publish`` is synchronous and
never awaits, so the MQTT ingest path (the single ``data.update_node``
chokepoint and ``mqtt.handle_text``) can emit without ever blocking on a slow
or stalled client — mirroring the existing ``discord_event_queue`` discipline.

The transport (the SSE route in ``api/api.py``) is intentionally separate: this
hub knows nothing about HTTP, so a future WebSocket endpoint could subscribe to
the same instance without changing producers.
"""

import asyncio
import logging
from typing import Any, Tuple

logger = logging.getLogger(__name__)

# Per-subscriber backlog before we start dropping. Generous enough to absorb a
# burst, small enough that a dead client can't grow unbounded memory.
DEFAULT_MAX_QUEUE = 100


class Broadcaster:
    """Fan-out of ``(event_type, payload)`` items to all subscribers.

    Payloads MUST already be plain, serializable snapshots — callers own
    isolation. ``get_node_cached`` hands back the *live* LRU dict, so the node
    producer publishes ``jsonable_encoder(n)`` rather than the dict itself.
    """

    def __init__(self, max_queue: int = DEFAULT_MAX_QUEUE) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._max_queue = max(1, max_queue)
        self._dropped_total = 0

    def subscribe(self) -> "asyncio.Queue[Tuple[str, Any]]":
        """Register a new client and return its private queue."""
        q: asyncio.Queue = asyncio.Queue(maxsize=self._max_queue)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Deregister a client. Safe to call more than once."""
        self._subscribers.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def dropped_total(self) -> int:
        return self._dropped_total

    def publish(self, event_type: str, payload: Any) -> None:
        """Enqueue an event for every subscriber. Non-blocking; never awaits.

        On a full subscriber queue we drop that subscriber's OLDEST item and
        enqueue the newest — a live UI cares about current state, not history,
        and the client's reconnect/resync (or fallback poll) closes any gap.
        """
        if not self._subscribers:
            return
        item: Tuple[str, Any] = (event_type, payload)
        for q in self._subscribers:
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()       # drop oldest
                    q.put_nowait(item)   # make room for newest
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    # Raced with the consumer; the next publish will catch up.
                    pass
                self._dropped_total += 1
                if self._dropped_total % 100 == 0:
                    logger.warning(
                        "SSE broadcaster dropped %d event(s) total (slow subscriber)",
                        self._dropped_total,
                    )
