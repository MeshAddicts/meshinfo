"""Unit tests for the SSE Broadcaster fan-out hub.

Covers the invariants the live-push path depends on: every subscriber gets
every event, a slow subscriber drops its OLDEST item (never blocks the
producer), and the node producer's snapshot is isolated from later mutations.
"""


from fastapi.encoders import jsonable_encoder


from broadcaster import Broadcaster


def test_publish_delivers_to_all_subscribers():
    b = Broadcaster()
    q1 = b.subscribe()
    q2 = b.subscribe()
    assert b.subscriber_count == 2

    b.publish("node", {"id": "abc"})

    assert q1.get_nowait() == ("node", {"id": "abc"})
    assert q2.get_nowait() == ("node", {"id": "abc"})


def test_unsubscribe_stops_delivery_and_is_idempotent():
    b = Broadcaster()
    q = b.subscribe()
    b.unsubscribe(q)
    assert b.subscriber_count == 0

    b.publish("node", {"id": "x"})
    assert q.empty()

    b.unsubscribe(q)  # second call must not raise


def test_publish_with_no_subscribers_is_noop():
    b = Broadcaster()
    b.publish("node", {"id": "x"})  # must not raise
    assert b.subscriber_count == 0
    assert b.dropped_total == 0


def test_overflow_drops_oldest_without_blocking():
    b = Broadcaster(max_queue=2)
    q = b.subscribe()

    b.publish("node", {"n": 1})
    b.publish("node", {"n": 2})
    # Third publish overflows: the oldest (n=1) is dropped, newest kept.
    b.publish("node", {"n": 3})

    assert q.qsize() == 2
    assert q.get_nowait() == ("node", {"n": 2})
    assert q.get_nowait() == ("node", {"n": 3})
    assert b.dropped_total == 1


def test_overflow_is_per_subscriber():
    b = Broadcaster(max_queue=1)
    slow = b.subscribe()
    fast = b.subscribe()

    b.publish("node", {"n": 1})
    fast.get_nowait()  # drain only the fast subscriber

    b.publish("node", {"n": 2})

    # Fast subscriber sees the newest; slow overflowed but kept the newest only.
    assert fast.get_nowait() == ("node", {"n": 2})
    assert slow.qsize() == 1
    assert slow.get_nowait() == ("node", {"n": 2})


def test_published_node_snapshot_is_isolated_from_later_mutation():
    """The node producer publishes jsonable_encoder(n); a later handler mutating
    the live cache ref must not change an already-queued payload."""
    b = Broadcaster()
    q = b.subscribe()

    node = {"id": "abc", "position": {"latitude_i": 100}, "telemetry": {"v": 1}}
    b.publish("node", jsonable_encoder(node))

    node["telemetry"]["v"] = 999
    node["position"]["latitude_i"] = 0

    _type, payload = q.get_nowait()
    assert payload["telemetry"]["v"] == 1
    assert payload["position"]["latitude_i"] == 100
