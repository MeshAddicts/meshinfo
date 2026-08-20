"""
MeshBridge (#585): straggler gateway copies must edit the posted embed, not
re-post it, and every Discord payload must respect the platform limits
(4096/description, 6000/message, 10 embeds/message).
"""

import asyncio

import discord

from bot.cogs.mesh_bridge import MeshBridge, _PendingPacket, WEBHOOK_NAME
from bot.embeds import (
    EMBED_DESC_LIMIT,
    EMBED_TOTAL_LIMIT,
    MESSAGE_EMBED_LIMIT,
    build_gateway_detail_embed,
    build_text_embed,
)


def run(coro):
    return asyncio.run(coro)


# ─── fakes ───────────────────────────────────────────────────────────────────


class FakePg:
    async def get_node_cached(self, node_id):
        return None

    async def is_node_banned(self, node_id):
        return False

    async def get_node_owner(self, node_id):
        return None

    async def is_node_tracked(self, node_id):
        return False

    async def get_tracker_type(self, node_id):
        return None


class FakeData:
    def __init__(self):
        self.pg_storage = FakePg()
        self.discord_event_queue = asyncio.Queue()


class FakeSent:
    def __init__(self, i=1):
        self.id = i


class FakeWebhook:
    def __init__(self):
        self.name = WEBHOOK_NAME
        self.sends = []
        self.edits = []
        self.on_send = None  # optional side effect (dirty-race test)

    async def send(self, **kw):
        self.sends.append(kw)
        if self.on_send:
            self.on_send()
        # discord.py contract: without wait=True the send returns None
        return FakeSent(len(self.sends)) if kw.get("wait") else None

    async def edit_message(self, message_id, **kw):
        self.edits.append((message_id, kw))


class FakeChannel:
    def __init__(self, webhook):
        self.id = 555
        self._webhook = webhook

    async def webhooks(self):
        return [self._webhook]


class FakeBot:
    def __init__(self, channel):
        self._channel = channel

    def get_channel(self, cid):
        return self._channel


def make_bridge(position_channels=None, **bridge_cfg):
    cfg = {"enabled": True, "channels": {"31": "555"}}
    if position_channels:
        cfg["position_channels"] = position_channels
    cfg.update(bridge_cfg)
    config = {
        "integrations": {"discord": {"bridge": cfg}},
        "server": {"base_url": "https://mesh.example.com"},
    }
    webhook = FakeWebhook()
    bridge = MeshBridge(FakeBot(FakeChannel(webhook)), config, FakeData())
    return bridge, webhook


def copy_msg(sender, ts=1787000000, text="hello mesh"):
    """One uplink copy of packet 933111847 as handle_text emits it."""
    return {
        "type": "text",
        "msg": {
            "from": "d952bddd", "to": "ffffffff", "id": 933111847,
            "sender": sender, "topic": f"msh/US/x/2/e/MediumFast/!{sender}",
            "hop_start": 5, "hop_limit": 3, "hops_away": 2,
            "rssi": -100, "snr": 1.5, "timestamp": ts,
        },
        "chat": {
            "id": 933111847, "from": "d952bddd", "channel": "31",
            "text": text, "timestamp": ts,
        },
    }


# ─── aggregation / straggler behavior ────────────────────────────────────────


class TestStragglerEditsNotReposts:
    def test_copies_aggregate_into_one_post(self):
        async def scenario():
            bridge, webhook = make_bridge()
            for i in range(3):
                await bridge._handle_event(copy_msg(f"{i:08x}"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10  # age past the aggregate window
            await bridge._flush_once()
            assert len(webhook.sends) == 1
            assert len(pending.gateways) == 3
        run(scenario())

    def test_straggler_within_window_edits_same_embed(self):
        """The #585 shape: a copy 2 minutes late must edit, not re-post."""
        async def scenario():
            bridge, webhook = make_bridge()
            for i in range(3):
                await bridge._handle_event(copy_msg(f"{i:08x}"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 125
            pending.last_post = 0.0
            await bridge._flush_once()
            assert len(webhook.sends) == 1

            await bridge._handle_event(copy_msg("aabbccdd"))  # straggler
            assert len(bridge._pending) == 1  # same pending, no new entry
            pending.last_post -= 10  # past the edit throttle
            await bridge._flush_once()
            assert len(webhook.sends) == 1
            assert len(webhook.edits) == 1
            assert len(pending.gateways) == 4
        run(scenario())

    def test_entry_expires_after_edit_window(self):
        async def scenario():
            bridge, webhook = make_bridge(edit_window_seconds=900)
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 901
            await bridge._flush_once()
            assert bridge._pending == {}
        run(scenario())

    def test_same_gateway_repeat_does_not_redirty(self):
        async def scenario():
            bridge, webhook = make_bridge()
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.dirty = False
            await bridge._handle_event(copy_msg("00000001"))
            assert pending.dirty is False
            assert len(pending.gateways) == 1
        run(scenario())

    def test_gateway_id_prefers_sender_over_topic(self):
        p = _PendingPacket("text", {})
        p.add_gateway({"sender": "aabbccdd", "topic": "msh/US/x/2/map/"})
        p.add_gateway({"sender": "aabbccdd", "topic": "msh/other/suffix"})
        assert [g["gateway_id"] for g in p.gateways] == ["aabbccdd"]

    def test_gateway_list_is_capped(self):
        p = _PendingPacket("text", {})
        for i in range(_PendingPacket.MAX_GATEWAYS + 50):
            p.add_gateway({"sender": f"{i:08x}", "topic": ""})
        assert len(p.gateways) == _PendingPacket.MAX_GATEWAYS

    def test_pending_map_evicts_oldest(self):
        async def scenario():
            bridge, _ = make_bridge()
            bridge._pending_max = 5
            for i in range(8):
                ev = copy_msg("00000001")
                ev["msg"] = dict(ev["msg"], id=1000 + i)
                await bridge._handle_event(ev)
            assert len(bridge._pending) == 5
            assert "1000:d952bddd" not in bridge._pending
            assert "1007:d952bddd" in bridge._pending
        run(scenario())

    def test_gateway_landing_mid_post_survives(self):
        """dirty set during the awaited post must not be clobbered."""
        async def scenario():
            bridge, webhook = make_bridge()
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10
            webhook.on_send = lambda: pending.add_gateway(
                {"sender": "eeeeeeee", "topic": "msh/US/x/2/e/MediumFast/!eeeeeeee"})
            await bridge._flush_once()
            assert pending.dirty is True  # picked up next tick as an edit
            pending.last_post -= 10
            await bridge._flush_once()
            assert len(webhook.edits) == 1
        run(scenario())

    def test_edits_throttled_to_one_per_aggregate_window(self):
        async def scenario():
            bridge, webhook = make_bridge()
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10
            await bridge._flush_once()
            await bridge._handle_event(copy_msg("00000002"))
            await bridge._flush_once()  # within the throttle: no edit yet
            assert webhook.edits == []
            pending.last_post -= bridge.aggregate_seconds + 1
            await bridge._flush_once()
            assert len(webhook.edits) == 1
        run(scenario())

    def test_failed_post_stays_dirty_for_retry(self):
        """An exception escaping the post (e.g. a DB hiccup) re-dirties the
        pending so the next tick retries; webhook failures themselves fall
        back to bot-send inside _post_text."""
        async def scenario():
            bridge, webhook = make_bridge()
            calls = {"n": 0}

            async def flaky(node_id):
                calls["n"] += 1
                raise RuntimeError("db hiccup")
            bridge.data.pg_storage.is_node_banned = flaky
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10
            await bridge._flush_once()
            assert pending.dirty is True and webhook.sends == []

            async def ok(node_id):
                return False
            bridge.data.pg_storage.is_node_banned = ok
            pending.last_post = 0.0
            await bridge._flush_once()
            assert len(webhook.sends) == 1 and pending.dirty is False
        run(scenario())

    def test_unmapped_channel_never_occupies_a_pending_slot(self):
        async def scenario():
            bridge, webhook = make_bridge()
            ev = copy_msg("00000001")
            ev["chat"]["channel"] = "99"
            await bridge._handle_event(ev)
            assert bridge._pending == {}
            await bridge._flush_once()
            assert webhook.sends == []
        run(scenario())

    def test_untracked_position_never_occupies_a_pending_slot(self):
        async def scenario():
            bridge, _ = make_bridge(position_channels={"31": "555"})
            ev = {"type": "position",
                  "msg": {"from": "d952bddd", "id": 42, "channel": "31",
                          "sender": "00000001", "topic": "msh/x/2/e/Y/!00000001"},
                  "node_id": "d952bddd"}
            await bridge._handle_event(ev)  # FakePg.is_node_tracked -> False
            assert bridge._pending == {}
        run(scenario())

    def test_eviction_prefers_posted_clean_entries(self):
        """Capacity pressure must not evict an unposted packet while a
        posted-and-clean one is available to drop."""
        async def scenario():
            bridge, webhook = make_bridge()
            bridge._pending_max = 2
            await bridge._handle_event(copy_msg("00000001"))  # will be posted
            posted = next(iter(bridge._pending.values()))
            posted.first_seen -= 10
            await bridge._flush_once()
            assert len(webhook.sends) == 1 and posted.dirty is False
            ev2 = copy_msg("00000002"); ev2["msg"] = dict(ev2["msg"], id=2)
            await bridge._handle_event(ev2)  # unposted, dirty
            ev3 = copy_msg("00000003"); ev3["msg"] = dict(ev3["msg"], id=3)
            await bridge._handle_event(ev3)  # forces eviction
            keys = set(bridge._pending)
            assert "933111847:d952bddd" not in keys  # posted+clean evicted first
            assert "2:d952bddd" in keys and "3:d952bddd" in keys
        run(scenario())

    def test_expiring_dirty_pending_gets_final_flush(self):
        """A straggler landing just after the last edit, at the end of the
        window, must reach the embed before the entry is discarded."""
        async def scenario():
            bridge, webhook = make_bridge()
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 901          # past the edit window
            pending.last_post = 0.0
            pending.discord_message = FakeSent()
            pending.sent_via_webhook = True
            # throttle would normally block: pretend an edit just happened
            import time as _t
            pending.last_post = _t.monotonic() - 1
            await bridge._flush_once()
            assert len(webhook.edits) == 1     # throttle waived on expiry
            assert bridge._pending == {}
        run(scenario())

    def test_failed_post_retries_once_per_window_not_per_tick(self):
        async def scenario():
            bridge, webhook = make_bridge()

            async def flaky(node_id):
                raise RuntimeError("db hiccup")
            bridge.data.pg_storage.is_node_banned = flaky
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10
            await bridge._flush_once()
            first_stamp = pending.last_post
            assert pending.dirty is True and first_stamp > 0
            await bridge._flush_once()  # inside the window: no second attempt
            assert pending.last_post == first_stamp
        run(scenario())

    def test_bot_sent_message_edits_as_bot_even_when_webhook_appears(self):
        """A message sent via channel.send must never be edited through the
        webhook (404 -> duplicate)."""
        async def scenario():
            bridge, webhook = make_bridge()
            await bridge._handle_event(copy_msg("00000001"))
            pending = next(iter(bridge._pending.values()))
            pending.first_seen -= 10

            class FakeBotMsg(FakeSent):
                def __init__(self):
                    super().__init__()
                    self.edits = []

                async def edit(self, **kw):
                    self.edits.append(kw)
            bot_msg = FakeBotMsg()
            pending.discord_message = bot_msg
            pending.sent_via_webhook = False
            await bridge._flush_once()
            assert webhook.edits == [] and webhook.sends == []
            assert len(bot_msg.edits) == 1
        run(scenario())


# ─── Discord payload limits ──────────────────────────────────────────────────


def big_gateways(n, hops_spread=8):
    return [{"gateway_id": f"{i:08x}", "rssi": -110, "snr": -3.25,
             "hops_away": i % hops_spread,
             "topic": f"msh/US/somewhere/2/e/LongFast/!{i:08x}"} for i in range(n)]


def named_nodes(gws):
    return {g["gateway_id"]: {"shortname": "GWXX", "longname": "A Rather Long Gateway Name " + g["gateway_id"]}
            for g in gws}


class TestDiscordLimits:
    def test_text_embed_respects_all_limits(self):
        gws = big_gateways(300)
        embed, was_truncated = build_text_embed(
            msg={"from": "d952bddd", "id": 933111847, "hop_start": 5, "timestamp": 1787000000},
            chat={"from": "d952bddd", "text": "x" * 200, "timestamp": 1787000000},
            nodes=named_nodes(gws), base_url="https://mesh.example.com",
            config={}, owner_id="123456789012345678", gateway_entries=gws,
        )
        assert was_truncated is True
        assert len(embed.description) <= EMBED_DESC_LIMIT
        assert len(embed) <= EMBED_TOTAL_LIMIT

    def test_text_embed_small_case_untruncated(self):
        gws = big_gateways(3)
        embed, was_truncated = build_text_embed(
            msg={"from": "d952bddd", "id": 1, "timestamp": 1787000000},
            chat={"from": "d952bddd", "text": "hi", "timestamp": 1787000000},
            nodes={}, base_url="", config={}, gateway_entries=gws,
        )
        assert was_truncated is False
        assert len(embed) <= EMBED_TOTAL_LIMIT

    def test_detail_view_fits_one_discord_message(self):
        for n in (12, 120, 400, 1000):
            gws = big_gateways(n)
            embeds = build_gateway_detail_embed(
                msg={"from": "d952bddd", "id": 933111847, "hop_start": 5},
                nodes=named_nodes(gws), base_url="https://mesh.example.com",
                gateway_entries=gws,
            )
            assert embeds, f"n={n}: no embeds"
            assert len(embeds) <= MESSAGE_EMBED_LIMIT
            assert all(len(e.description) <= EMBED_DESC_LIMIT for e in embeds)
            assert sum(len(e) for e in embeds) <= EMBED_TOTAL_LIMIT, f"n={n}"

    def test_detail_view_truncation_is_flagged(self):
        gws = big_gateways(1000)
        embeds = build_gateway_detail_embed(
            msg={"from": "d952bddd", "id": 1}, nodes=named_nodes(gws),
            base_url="https://mesh.example.com", gateway_entries=gws,
        )
        assert "truncated" in embeds[-1].footer.text

    def test_single_oversized_hop_group_is_chunked_safely(self):
        gws = big_gateways(600, hops_spread=1)  # all one hop group
        embeds = build_gateway_detail_embed(
            msg={"from": "d952bddd", "id": 1}, nodes=named_nodes(gws),
            base_url="https://mesh.example.com", gateway_entries=gws,
        )
        assert embeds
        assert all(len(e.description) <= EMBED_DESC_LIMIT for e in embeds)
        assert sum(len(e) for e in embeds) <= EMBED_TOTAL_LIMIT

    def test_embed_timestamp_is_packet_time_not_build_time(self):
        kw = dict(msg={"from": "d952bddd", "id": 1, "timestamp": 1787000000},
                  chat={"from": "d952bddd", "text": "hi", "timestamp": 1787000000},
                  nodes={}, base_url="", config={}, gateway_entries=big_gateways(2))
        e1, _ = build_text_embed(**kw)
        e2, _ = build_text_embed(**kw)
        assert e1.timestamp == e2.timestamp
        assert int(e1.timestamp.timestamp()) == 1787000000


class TestNameAndContentLimits:
    def test_webhook_username_is_sanitized_and_capped(self):
        from bot.cogs.mesh_bridge import MeshBridge
        name = MeshBridge._get_display_name({"longname": "x" * 255, "shortname": "ABCD"}, "id")
        assert 1 <= len(name) <= 80
        name = MeshBridge._get_display_name({"longname": "Team Clyde Discord Relay", "shortname": "TC"}, "id")
        assert "clyde" not in name.lower() and "discord" not in name.lower()
        assert MeshBridge._get_display_name(None, "ab12cd34") == "!ab12cd34"

    def test_author_name_clamped_to_256(self):
        gws = big_gateways(2)
        nodes = {"d952bddd": {"longname": "L" * 300, "shortname": "SHRT"}}
        embed, _ = build_text_embed(
            msg={"from": "d952bddd", "id": 1, "timestamp": 1787000000},
            chat={"from": "d952bddd", "text": "hi", "timestamp": 1787000000},
            nodes=nodes, base_url="", config={}, gateway_entries=gws,
        )
        assert len(embed.author.name) <= 256
        assert embed.author.name.endswith("[SHRT]")

    def test_mention_chunks_never_split_a_token_or_exceed_content_limit(self):
        from bot.cogs.mesh_bridge import MESSAGE_CONTENT_LIMIT, _chunk_mentions
        ids = [str(10**17 + i) for i in range(300)]
        chunks = _chunk_mentions(ids)
        assert all(len(c) <= MESSAGE_CONTENT_LIMIT for c in chunks)
        rejoined = " ".join(chunks).split(" ")
        assert rejoined == [f"<@{i}>" for i in ids]

    def test_altitude_junk_is_dropped(self):
        from bot.embeds import build_position_embed
        for alt in ("a" * 1200, True, float("nan"), None):
            embed = build_position_embed(
                msg={"from": "d952bddd", "id": 1, "timestamp": 1787000000,
                     "payload": {"latitude_i": 393412608, "longitude_i": -1210384384,
                                 "altitude": alt}},
                node_id="d952bddd", nodes={}, base_url="", config={},
            )
            assert not any(f.name == "Altitude" for f in embed.fields)
        embed = build_position_embed(
            msg={"from": "d952bddd", "id": 1, "timestamp": 1787000000,
                 "payload": {"latitude_i": 393412608, "longitude_i": -1210384384,
                             "altitude": 853}},
            node_id="d952bddd", nodes={}, base_url="", config={},
        )
        assert any(f.name == "Altitude" and f.value == "853m" for f in embed.fields)

    def test_oversized_hop_group_spills_into_more_embeds_not_silent_cuts(self):
        """A single huge hop group must chunk across embeds; anything actually
        cut must raise the truncation note."""
        gws = big_gateways(200, hops_spread=1)
        embeds = build_gateway_detail_embed(
            msg={"from": "d952bddd", "id": 1}, nodes=named_nodes(gws),
            base_url="https://mesh.example.com", gateway_entries=gws,
        )
        assert len(embeds) >= 2  # spilled, not squeezed into one
        assert all(len(e.description) <= EMBED_DESC_LIMIT for e in embeds)
        assert sum(len(e) for e in embeds) <= EMBED_TOTAL_LIMIT
