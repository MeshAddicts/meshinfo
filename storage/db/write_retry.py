"""
Bounded retry buffer for archive writes that failed on a database outage.

When Postgres bounces (restart, failover, host maintenance) the ingest loop
used to drop packets: every write_* method caught the connection error, logged
it, and moved on. This queue buffers the failed *append-only* writes — the
mqtt_messages archive plus telemetry/chat/traceroute history, i.e. the rows
that cannot be regenerated — and replays them once the database answers again.

State upserts (write_node, node_telemetry_current) are deliberately NOT
retried: the next packet from a node rewrites them within minutes, and
replaying a stale snapshot after recovery could clobber fresher state.

Replay protocol: the replay callback re-runs the write and raises
WriteStillFailing if the database is still (or again) unavailable — the item
goes back to the head of the queue and the drain backs off. Any other
exception drops that item (it would fail identically forever). This is an
explicit signal rather than queue-growth inference, so live writes failing
concurrently can never be mistaken for replay failures.

Known, accepted semantics:
- At-least-once: an ambiguous failure (connection dies after the server
  committed but before the client read the result) replays a write that
  already landed. telemetry/chat inserts are idempotent (ON CONFLICT DO
  NOTHING); the traceroute upsert's strict `>` richness guard makes an exact
  replay a no-op. A replayed mqtt_message can in rare cases add a duplicate
  reception/row — weighed against certain loss, we take it.
- Replayed rows get created_at = replay time (they sort/partition by when
  they were actually stored).
- Live SSE broadcasts for replayed writes are not re-emitted; the archive
  backfills, open dashboards show the outage gap until reload.

Memory bound: at most ``max_items`` entries, drop-oldest beyond that with a
running counter. At typical mesh ingest rates the default cap holds roughly
half an hour of full-rate traffic, far beyond a normal restart window.
"""

import asyncio
import logging
from collections import deque
from typing import Any, Awaitable, Callable, Optional, Tuple

logger = logging.getLogger(__name__)


class WriteStillFailing(Exception):
    """Raised by the replay callback when the DB is still unavailable — the
    item is requeued at the head and the drain backs off."""


class WriteRetryQueue:
    DROP_LOG_EVERY = 100

    def __init__(
        self,
        replay: Callable[[str, Tuple[Any, ...], float], Awaitable[None]],
        probe: Callable[[], Awaitable[bool]],
        *,
        max_items: int = 10_000,
        base_delay_s: float = 1.0,
        max_delay_s: float = 30.0,
    ):
        self._replay = replay
        self._probe = probe
        self._items: "deque[Tuple[str, Tuple[Any, ...], float]]" = deque()
        self._max_items = max_items
        self._base_delay_s = base_delay_s
        self._max_delay_s = max_delay_s
        self._drops_total = 0
        self._task: Optional[asyncio.Task] = None
        self._closed = False

    def __len__(self) -> int:
        return len(self._items)

    @property
    def drops_total(self) -> int:
        return self._drops_total

    def put(self, kind: str, args: Tuple[Any, ...], failed_at: float) -> bool:
        """Buffer one failed write; starts the drain task if idle.

        Returns False (write NOT buffered) after close(), so shutdown can't
        resurrect the drain task and callers can log the loss honestly.
        Must be called from a running event loop (the write methods always are).
        """
        if self._closed:
            return False
        self._items.append((kind, args, failed_at))
        while len(self._items) > self._max_items:
            self._items.popleft()
            self._drops_total += 1
            if self._drops_total == 1 or self._drops_total % self.DROP_LOG_EVERY == 0:
                logger.error(
                    "Write-retry queue full; dropped %d oldest buffered writes so far",
                    self._drops_total,
                )
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._drain())
        return True

    async def close(self) -> None:
        """Stop draining. Anything still queued is lost (process is exiting)."""
        self._closed = True
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass  # best-effort; shutdown shouldn't block on this
        self._task = None

    async def _drain(self) -> None:
        try:
            delay = self._base_delay_s
            while self._items and not self._closed:
                if not await self._probe():
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self._max_delay_s)
                    continue

                # One snapshot's worth per probe round: items appended by live
                # writes during the round wait for the next probe.
                made_progress = False
                for _ in range(len(self._items)):
                    if not self._items or self._closed:
                        break
                    item = self._items.popleft()
                    try:
                        await self._replay(*item)
                    except WriteStillFailing as e:
                        self._items.appendleft(item)
                        logger.debug("Write-retry: %s still failing (%s); backing off", item[0], e)
                        break
                    except Exception as e:
                        logger.error("Write-retry replay of %s failed; dropping item: %s", item[0], e)
                        continue
                    made_progress = True
                    # Yield so live ingest interleaves with a large backlog.
                    await asyncio.sleep(0)

                if made_progress:
                    delay = self._base_delay_s
                else:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self._max_delay_s)

            if not self._items:
                logger.info("Write-retry queue drained")
        except asyncio.CancelledError:
            raise
        except Exception:
            # The queue must never die silently with items buffered; the next
            # failed write's put() restarts the task.
            logger.exception("Write-retry drain task crashed; will restart on next failed write")
