#!/usr/bin/env python3
"""
Per-node ingest rate limit for the mqtt_messages archive: caps new rows per
originating node per minute/hour so one looping publisher can't own the disk.
Dedup'd uplink copies don't count, so dense meshes are unaffected (measured
legit peaks: ~30 rows/node/minute, ~120/hour).
"""

import logging
import time
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Shared budget bucket for messages with no usable `from`.
NO_FROM = "<no-from>"


class NodeRateLimiter:
    """Fixed-window (minute + hour) row budget per originating node.

    `allow` peeks, `charge` spends — charging only on the actual insert means
    a DB outage never consumes budget, so buffered-for-retry copies survive.
    Denials WARN once when dropping starts, then one summary per minute.
    A limit of 0 disables that tier.
    """

    def __init__(self, per_minute: int = 60, per_hour: int = 600, max_nodes: int = 50000):
        self.per_minute = max(0, int(per_minute))
        self.per_hour = max(0, int(per_hour))
        self.max_nodes = int(max_nodes)
        # node -> [minute start, minute rows, hour start, hour rows,
        #          denied this minute, denied previous minute]
        self._nodes: Dict[str, List[float]] = {}
        self.denied_total = 0

    @property
    def enabled(self) -> bool:
        return self.per_minute > 0 or self.per_hour > 0

    def _limits(self) -> str:
        tiers = []
        if self.per_minute:
            tiers.append(f"{self.per_minute}/min")
        if self.per_hour:
            tiers.append(f"{self.per_hour}/hour")
        return " or ".join(tiers)

    def _entry(self, node_id: str, now: float) -> List[float]:
        e = self._nodes.get(node_id)
        if e is None:
            if len(self._nodes) >= self.max_nodes:
                self._purge(now)
            e = self._nodes[node_id] = [now, 0, now, 0, 0, 0]
            return e
        if now - e[0] >= 60.0:
            if e[4]:
                logger.warning(
                    "Node %s: dropped %d writes in the last minute (over %s new rows)",
                    node_id, int(e[4]), self._limits(),
                )
            e[0], e[1], e[5], e[4] = now, 0, e[4], 0
        if now - e[2] >= 3600.0:
            e[2], e[3] = now, 0
        return e

    def exhausted(self, node_id: Optional[str], now: Optional[float] = None) -> bool:
        """Is this node over either budget right now? Counts/logs no denial."""
        if not self.enabled:
            return False
        e = self._entry(node_id or NO_FROM, time.monotonic() if now is None else now)
        return bool((self.per_minute and e[1] >= self.per_minute)
                    or (self.per_hour and e[3] >= self.per_hour))

    def allow(self, node_id: Optional[str], now: Optional[float] = None) -> bool:
        """False (and counted/logged as a drop) once the node is over budget."""
        if not self.enabled:
            return True
        now = time.monotonic() if now is None else now
        if not self.exhausted(node_id, now):
            return True
        node_id = node_id or NO_FROM
        e = self._entry(node_id, now)
        e[4] += 1
        self.denied_total += 1
        if e[4] == 1 and not e[5]:
            logger.warning(
                "Node %s exceeded %s new archive rows; dropping its further archive, "
                "node-state and history writes this window (add \"%s\" to [storage] "
                "ingest_denylist to silence it entirely)", node_id, self._limits(), node_id,
            )
        return False

    def charge(self, node_id: Optional[str], now: Optional[float] = None) -> None:
        """Record one archive row created for the node."""
        if not self.enabled:
            return
        e = self._entry(node_id or NO_FROM, time.monotonic() if now is None else now)
        e[1] += 1
        e[3] += 1

    def _purge(self, now: float) -> None:
        stale = [n for n, e in self._nodes.items() if now - e[2] >= 3600.0]
        for n in stale:
            del self._nodes[n]
        if len(self._nodes) >= self.max_nodes:
            self._nodes.clear()  # pathological node churn: reset, stays correct


class SuppressedCopyLog:
    """WARNs when dedup keeps absorbing a node's copies (nothing else would
    log a looping node): once on crossing `threshold` per window, then one
    summary per window. Summaries emit lazily on the node's next copy, so a
    flood's final partial window may go unsummarized.
    """

    def __init__(self, threshold: int = 30, window_seconds: float = 60.0,
                 max_nodes: int = 10000):
        self.threshold = max(1, int(threshold))
        self.window = float(window_seconds)
        self.max_nodes = int(max_nodes)
        # node -> [window start, absorbed, crossed previous window]
        self._nodes: Dict[str, List[float]] = {}

    def note(self, node_id: Optional[str], now: Optional[float] = None) -> None:
        """Record one absorbed duplicate copy for the node."""
        if node_id is None:
            return
        now = time.monotonic() if now is None else now
        e = self._nodes.get(node_id)
        if e is None or now - e[0] >= self.window:
            # Only a just-ended window summarizes; after a gap the crossing warning re-arms.
            crossed = (e is not None and e[1] >= self.threshold
                       and now - e[0] < 2 * self.window)
            if crossed:
                logger.warning(
                    "Node %s: %d duplicate copies absorbed by dedup in the last minute",
                    node_id, int(e[1]),
                )
            elif e is None and len(self._nodes) >= self.max_nodes:
                stale = [n for n, v in self._nodes.items() if now - v[0] >= self.window]
                for n in stale:
                    del self._nodes[n]
                if len(self._nodes) >= self.max_nodes:
                    self._nodes.clear()
            e = self._nodes[node_id] = [now, 0, crossed]
        e[1] += 1
        if e[1] == self.threshold and not e[2]:
            logger.warning(
                "Node %s keeps re-sending identical packets (%d duplicate copies this "
                "minute); dedup is absorbing them (add \"%s\" to [storage] "
                "ingest_denylist to drop it at the decoder)",
                node_id, self.threshold, node_id,
            )
