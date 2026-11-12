#!/usr/bin/env python3
"""
Build a synthetic, production-shaped raw-packet archive for storage benchmarks.

Fills far-past monthly partitions of mqtt_messages and packet_receptions with
Meshtastic-shaped JSON messages whose on-disk footprint matches a real deploy
(~750 B per mqtt_messages heap row; ~105 B per packet_receptions row with the
default ~10% of rows carrying a small extras patch, ~135 B at --extras-rate 1),
so the tiering / ZFS-compression numbers measured against them are meaningful:

- one canonical mqtt_messages row per logical packet, its payload being the
  json.dumps(message dict) text the ingest path stores (storage/db/postgres.py
  write_mqtt_message), with from_node_id/to_node_id/packet_id set exactly as
  the trg_mqtt_messages_extract_node_ids trigger would derive them;
- a Poisson number of packet_receptions rows per packet (one per uplinking
  gateway, the first being the canonical copy), their sparse `extras` patch
  computed with the real storage/db/uplink_dedup helpers so every copy stays
  reconstructible;
- a Zipf-like population of ~2000 nodes and ~60 gateways, interned uplink
  topics (mqtt_topics) and a diurnal created_at distribution.

Rows go through the PARENT tables with COPY (ids pre-allocated from
mqtt_messages_id_seq); reception created_at trails the canonical row by up to
120 s, so the month after the last requested one is created too. Everything is
deterministic for a given --seed. Every topic carries the region segment
"synthvalley" so the synthetic data is easy to find and remove again:

    python scripts/synth_history.py --dsn postgresql://... --from 2025-01 --to 2025-03 --dry-run
    python scripts/synth_history.py --dsn postgresql://... --from 2025-01 --to 2025-03
    python scripts/synth_history.py --config config.toml --months 2025_01 2025_02 --packets-per-month 50000

Clean-up afterwards (the script prints the exact statements):

    DROP TABLE mqtt_messages_2025_01, packet_receptions_2025_01, ...;
    DELETE FROM mqtt_topics WHERE topic LIKE 'msh/%/synthvalley/%';

Only ever point it at months that hold no real data: it refuses to write into
a non-empty target partition unless --append is given.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import datetime
import json
import math
import random
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import asyncpg

# Run as `python scripts/...` from the repo root or anywhere else.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage.db.uplink_dedup import (  # noqa: E402
    gateway_from_msg,
    reception_fields,
    reception_patch,
    reception_template,
)

UTC = datetime.timezone.utc

# Region segment every synthetic topic carries; the clean-up DELETE keys on it.
SYNTH_REGION = "synthvalley"
TOPIC_PREFIX = f"msh/US/CA/{SYNTH_REGION}/2"

MQTT_COLUMNS = (
    "id", "topic", "payload", "qos", "retain", "timestamp",
    "created_at", "from_node_id", "to_node_id", "packet_id",
)
RECEPTION_COLUMNS = (
    "mqtt_row_id", "created_at", "gateway", "topic_id", "rx_rssi", "rx_snr",
    "rx_time", "hop_limit", "hops_away", "relay_node", "transport", "extras",
)

# Portnum mix (weights sum to 1). Mapreports carry no packet id (ingest dedups
# them by content) but, like every packet, get one reception per uplink copy.
TYPE_MIX = (
    ("position", 0.35),
    ("telemetry", 0.25),
    ("nodeinfo", 0.15),
    ("neighborinfo", 0.10),
    ("text", 0.05),
    ("traceroute", 0.035),
    ("routing", 0.015),
    ("mapreport", 0.05),
)

# (preset name, channel hash bucket the resolver assigns, share of gateways)
PRESETS = (("LongFast", 8, 0.70), ("MediumFast", 20, 0.25), ("MediumSlow", 31, 0.05))

NODE_COUNT = 2000
GATEWAY_COUNT = 60
ZIPF_EXPONENT = 0.85

# Hour-of-day (UTC) activity weights: a Pacific-coast mesh is quietest around
# 10:00 UTC (2-3 am local) and busiest in the local afternoon/evening.
HOUR_WEIGHTS = [1.0 + 0.6 * math.sin(2 * math.pi * (h - 10) / 24.0) for h in range(24)]

WORDS = (
    "test", "hello", "anyone", "copy", "mesh", "node", "solar", "battery", "ok", "thanks",
    "radio", "tower", "signal", "range", "from", "the", "hill", "today", "morning", "evening",
    "checking", "in", "new", "antenna", "works", "great", "still", "online", "reading", "you",
    "loud", "clear", "weather", "rain", "wind", "trail", "ride", "road", "coffee", "73",
)
ADJECTIVES = ("Blue", "Red", "Tall", "Quiet", "North", "South", "River", "Ridge", "Oak", "Pine",
              "Delta", "Valley", "Summit", "Harbor", "Canyon", "Meadow", "Creek", "Lake", "Bay", "Peak")
NOUNS = ("Relay", "Base", "Router", "Node", "Tracker", "Solar", "Repeater", "Station", "Beacon",
         "Link", "Mobile", "Rover", "Roof", "Mast", "Shed", "Truck", "Cabin", "Tower", "Post", "Gate")
HW_MODELS = (9, 43, 44, 47, 48, 50, 71, 73, 86, 90)   # mixture of popular Meshtastic boards
FIRMWARE = ("2.5.20.4c97351", "2.6.4.b89355f", "2.6.11.60ec05e", "2.7.4.c2dfba2", "2.7.15.ab3b6ae")

# Centre of the synthetic mesh (integer degrees * 1e7), ~60 km spread.
LAT0, LON0 = 386000000, -1214000000


# --- helpers ---

def _dsn_from_config(path: Path) -> str:
    try:
        import tomllib
    except ImportError:  # Python < 3.11: pass --dsn instead
        raise SystemExit("tomllib unavailable on this interpreter; pass --dsn")

    with open(path, "rb") as f:
        pg = tomllib.load(f).get("storage", {}).get("postgres", {})
    return (
        f"postgresql://{pg.get('username', 'postgres')}:{pg.get('password', 'password')}"
        f"@{pg.get('host', 'postgres')}:{pg.get('port', 5432)}/{pg.get('database', 'meshinfo')}"
    )


def parse_month(text: str) -> datetime.date:
    """'YYYY-MM' or 'YYYY_MM' -> first day of that month."""
    t = text.strip().replace("_", "-")
    try:
        year, month = t.split("-")
        return datetime.date(int(year), int(month), 1)
    except ValueError:
        raise argparse.ArgumentTypeError(f"bad month {text!r}: expected YYYY-MM")


def next_month(month: datetime.date) -> datetime.date:
    return (month + datetime.timedelta(days=32)).replace(day=1)


def month_label(month: datetime.date) -> str:
    return f"{month:%Y_%m}"


def month_bounds_sql(month: datetime.date) -> Tuple[str, str]:
    """Half-open [lo, hi) TIMESTAMPTZ literal bodies, as ensure_mqtt_partitions writes them."""
    return f"{month:%Y-%m-%d} 00:00:00+00", f"{next_month(month):%Y-%m-%d} 00:00:00+00"


def month_range(start: datetime.date, end: datetime.date) -> List[datetime.date]:
    months = []
    m = start
    while m <= end:
        months.append(m)
        m = next_month(m)
    return months


def poisson(rng: random.Random, mean: float) -> int:
    """Knuth's Poisson sampler (mean is small here)."""
    limit = math.exp(-mean)
    k = 0
    p = rng.random()
    while p > limit:
        k += 1
        p *= rng.random()
    return k


def hex8(value: int) -> str:
    return f"{value & 0xFFFFFFFF:08x}"


def b64(rng: random.Random, nbytes: int) -> str:
    return base64.b64encode(bytes(rng.getrandbits(8) for _ in range(nbytes))).decode("ascii")


def weighted_pick(rng: random.Random, items: Tuple[Tuple[str, float], ...]) -> str:
    r = rng.random()
    acc = 0.0
    for name, w in items:
        acc += w
        if r < acc:
            return name
    return items[-1][0]


# --- population ---

class Population:
    """Nodes, gateways and topics shared by every month of one seed."""

    def __init__(self, seed: int):
        rng = random.Random(f"synth-history:{seed}:population")
        ids = set()
        while len(ids) < NODE_COUNT:
            ids.add(rng.getrandbits(32))
        self.nodes: List[str] = [hex8(i) for i in ids]
        rng.shuffle(self.nodes)
        self.node_ints: Dict[str, int] = {n: int(n, 16) for n in self.nodes}
        # Zipf-like activity: rank r talks with weight 1/(r+1)^s.
        weights = [1.0 / (r + 1) ** ZIPF_EXPONENT for r in range(NODE_COUNT)]
        self.node_cum: List[float] = []
        acc = 0.0
        for w in weights:
            acc += w
            self.node_cum.append(acc)
        # Gateways are well-placed, fairly active nodes (sampled from the top ~300).
        self.gateways: List[str] = rng.sample(self.nodes[:300], GATEWAY_COUNT)
        gw_weights = [1.0 / (r + 1) ** 0.6 for r in range(GATEWAY_COUNT)]
        self.preset_of: Dict[str, str] = {}
        self.topic_of: Dict[str, str] = {}
        self.map_topic_of: Dict[str, str] = {}
        self.gateways_by_preset: Dict[str, List[str]] = {p[0]: [] for p in PRESETS}
        self.gw_cum_by_preset: Dict[str, List[float]] = {p[0]: [] for p in PRESETS}
        presets = tuple((name, share) for name, _, share in PRESETS)
        for rank, gw in enumerate(self.gateways):
            preset = weighted_pick(rng, presets)
            self.preset_of[gw] = preset
            self.topic_of[gw] = f"{TOPIC_PREFIX}/e/{preset}/!{gw}"
            self.map_topic_of[gw] = f"{TOPIC_PREFIX}/map/!{gw}"
            self.gateways_by_preset[preset].append(gw)
            cum = self.gw_cum_by_preset[preset]
            cum.append((cum[-1] if cum else 0.0) + gw_weights[rank])
        for preset, gws in self.gateways_by_preset.items():
            if not gws:  # tiny shares can draw zero gateways; borrow one so the preset exists
                gws.append(self.gateways[-1])
                self.gw_cum_by_preset[preset].append(1.0)
        self.channel_of_preset: Dict[str, int] = {name: ch for name, ch, _ in PRESETS}
        # Stable per-node identity for nodeinfo/mapreport payloads.
        self.identity: Dict[str, Tuple[str, str, int, int, str, str]] = {}
        for n in self.nodes:
            long_name = f"{rng.choice(ADJECTIVES)} {rng.choice(NOUNS)} {rng.randint(1, 99)}"
            short = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ0123456789") for _ in range(4))
            self.identity[n] = (
                long_name, short, rng.choice(HW_MODELS),
                rng.choice((0, 0, 0, 1, 1, 2, 2, 4, 5, 6, 8, 11)),
                b64(rng, 6), b64(rng, 32),
            )

    def pick_node(self, rng: random.Random) -> str:
        r = rng.random() * self.node_cum[-1]
        lo, hi = 0, NODE_COUNT - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if self.node_cum[mid] < r:
                lo = mid + 1
            else:
                hi = mid
        return self.nodes[lo]

    def pick_gateways(self, rng: random.Random, preset: str, n: int) -> List[str]:
        """n distinct gateways on `preset`, busier gateways first-heard more often."""
        gws = self.gateways_by_preset[preset]
        cum = self.gw_cum_by_preset[preset]
        n = min(n, len(gws))
        chosen: List[str] = []
        seen = set()
        attempts = 0
        while len(chosen) < n and attempts < n * 20:
            attempts += 1
            r = rng.random() * cum[-1]
            idx = 0
            while cum[idx] < r:
                idx += 1
            gw = gws[idx]
            if gw not in seen:
                seen.add(gw)
                chosen.append(gw)
        for gw in gws:  # pathological weights: top up deterministically
            if len(chosen) >= n:
                break
            if gw not in seen:
                chosen.append(gw)
        return chosen


# --- message generator ---

def _position_payload(rng: random.Random) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if rng.random() < 0.75:
        out["altitude"] = rng.randint(-5, 2400)
    if rng.random() < 0.25:
        out["ground_speed"] = rng.randint(0, 110)
        out["ground_track"] = rng.randint(0, 35999)
    out["latitude_i"] = LAT0 + rng.randint(-3000000, 3000000)
    out["longitude_i"] = LON0 + rng.randint(-4000000, 4000000)
    out["location_source"] = rng.choice((1, 2, 2, 2, 3))
    if rng.random() < 0.15:
        out["PDOP"] = rng.randint(80, 900)
    out["precision_bits"] = rng.choice((13, 14, 15, 16, 32, 32))
    if rng.random() < 0.2:
        out["sats_in_view"] = rng.randint(3, 14)
    out["time"] = rng.randint(1700000000, 1780000000)
    if rng.random() < 0.15:
        out["timestamp"] = out["time"] - rng.randint(0, 30)
    return out


def _telemetry_payload(rng: random.Random) -> Tuple[str, Dict[str, Any]]:
    r = rng.random()
    if r < 0.65:
        out: Dict[str, Any] = {
            "air_util_tx": round(rng.uniform(0.1, 9.0), rng.choice((2, 3, 4))),
            "battery_level": rng.randint(5, 101),
            "channel_utilization": round(rng.uniform(1.0, 45.0), rng.choice((2, 3, 4))),
            "uptime_seconds": rng.randint(60, 3000000),
            "voltage": round(rng.uniform(3.2, 4.25), rng.choice((2, 3, 4))),
        }
        return "device_metrics", out
    if r < 0.95:
        out = {
            "barometric_pressure": round(rng.uniform(950.0, 1030.0), rng.choice((2, 4, 6))),
            "relative_humidity": round(rng.uniform(10.0, 95.0), rng.choice((2, 4, 6))),
            "temperature": round(rng.uniform(-5.0, 42.0), rng.choice((2, 4, 6))),
        }
        if rng.random() < 0.3:
            out["gas_resistance"] = round(rng.uniform(20.0, 400.0), 4)
            out["iaq"] = rng.randint(20, 250)
        if rng.random() < 0.2:
            out["lux"] = round(rng.uniform(0.0, 80000.0), 2)
        return "environment_metrics", out
    out = {}
    for ch in (1, 2, 3):
        out[f"ch{ch}_current"] = round(rng.uniform(-500.0, 1500.0), 3)
        out[f"ch{ch}_voltage"] = round(rng.uniform(0.0, 14.5), 3)
    return "power_metrics", out


def _nodeinfo_payload(rng: random.Random, pop: Population, node: str) -> Dict[str, Any]:
    long_name, short, hw, role, mac, pubkey = pop.identity[node]
    out: Dict[str, Any] = {"hw_model": hw, "id": node}
    if rng.random() < 0.1:
        out["is_unmessagable"] = True
    out["long_name"] = long_name
    out["macaddr"] = mac
    if rng.random() < 0.55:
        out["public_key"] = pubkey
    if role:
        out["role"] = role
    out["short_name"] = short
    return out


def _neighborinfo_payload(rng: random.Random, pop: Population, node: str) -> Dict[str, Any]:
    count = min(int(rng.expovariate(1 / 2.5)), 12)
    interval = rng.choice((900, 1800, 3600, 7200))
    neighbors = []
    for _ in range(count):
        other = pop.pick_node(rng)
        neighbors.append({
            "last_rx_time": rng.choice((0, 0, rng.randint(1700000000, 1780000000))),
            "node_broadcast_interval_secs": rng.choice((0, interval)),
            "node_id": pop.node_ints[other],
            "snr": round(rng.uniform(-18.0, 12.0) * 4) / 4,
        })
    return {
        "last_sent_by_id": pop.node_ints[node],
        "neighbors": neighbors,
        "node_broadcast_interval_secs": interval,
        "node_id": pop.node_ints[node],
    }


def _text_payload(rng: random.Random) -> Dict[str, Any]:
    n = 1 + min(int(rng.expovariate(1 / 5.0)), 40)
    text = " ".join(rng.choice(WORDS) for _ in range(n))
    if rng.random() < 0.08:
        text += " ☀️"  # the odd emoji: ensure_ascii=False keeps it as UTF-8
    return {"text": text}


def _traceroute_payload(rng: random.Random, pop: Population) -> Dict[str, Any]:
    hops = min(int(rng.expovariate(1 / 1.5)), 6)
    route = [pop.node_ints[pop.pick_node(rng)] for _ in range(hops)]
    snr_towards = [rng.randint(-80, 48) for _ in range(hops + 1)]
    out: Dict[str, Any] = {"route": route, "route_back": [], "snr_back": [], "snr_towards": snr_towards}
    if rng.random() < 0.4:  # reply carries the return path too
        back = min(int(rng.expovariate(1 / 1.5)), 6)
        out["route_back"] = [pop.node_ints[pop.pick_node(rng)] for _ in range(back)]
        out["snr_back"] = [rng.randint(-80, 48) for _ in range(back + 1)]
    return out


def _mapreport_payload(rng: random.Random, pop: Population, node: str) -> Dict[str, Any]:
    long_name, short, hw, role, _mac, _pk = pop.identity[node]
    out: Dict[str, Any] = {
        "altitude": rng.randint(0, 2000),
        "firmware_version": rng.choice(FIRMWARE),
        "has_default_channel": True,
        "hw_model": hw,
        "latitude_i": LAT0 + rng.randint(-3000000, 3000000),
        "long_name": long_name,
        "longitude_i": LON0 + rng.randint(-4000000, 4000000),
        "modem_preset": rng.choice((0, 0, 0, 3, 3, 4)),
        "num_online_local_nodes": rng.randint(1, 120),
        "position_precision": rng.choice((13, 14, 15, 16, 32)),
        "region": 1,
        "short_name": short,
    }
    if rng.random() < 0.2:
        out["has_opted_report_location"] = True
    if role:
        out["role"] = role
    return out


class Generator:
    """Deterministic month-by-month packet generator."""

    def __init__(self, seed: int, receptions_per_packet: float, extras_rate: float = 0.08):
        self.seed = seed
        self.pop = Population(seed)
        self.mean_receptions = receptions_per_packet
        self.extras_rate = extras_rate

    def month_rng(self, month: datetime.date) -> random.Random:
        return random.Random(f"synth-history:{self.seed}:{month:%Y-%m}")

    def _created_at(self, rng: random.Random, month: datetime.date) -> datetime.datetime:
        days = (next_month(month) - month).days
        day = rng.randrange(days)
        hour = rng.choices(range(24), weights=HOUR_WEIGHTS)[0]
        second = rng.random() * 3600.0
        base = datetime.datetime(month.year, month.month, 1, tzinfo=UTC)
        return base + datetime.timedelta(days=day, hours=hour, seconds=second)

    def _envelope(self, rng: random.Random, kind: str, node: str, gateway: str,
                  preset: str, created_at: datetime.datetime, packet_id: Optional[int]) -> Dict[str, Any]:
        """The per-packet dict as handle_log gives it to write_mqtt_message: sorted MeshPacket keys, then mqtt.py's."""
        pop = self.pop
        rx_time = int(created_at.timestamp()) - rng.randint(0, 3)
        legacy = rng.random() < 0.08           # pre-2.3 firmware: hop_start absent
        hop_start = 0 if legacy else rng.choice((3, 3, 3, 4, 5, 7))
        hops_away = 0 if legacy else min(int(rng.expovariate(1 / 1.2)), hop_start)
        hop_limit = (rng.choice((0, 1, 2, 3)) if legacy else hop_start - hops_away)
        direct = kind in ("text", "traceroute", "routing") and rng.random() < 0.3
        to = pop.pick_node(rng) if direct else "ffffffff"
        no_rf = rng.random() < 0.03           # heard via MQTT first: no RF measurement on the copy
        rssi = 0 if no_rf else rng.randint(-132, -45)
        snr = 0.0 if no_rf else round(rng.uniform(-20.0, 12.0) * 4) / 4

        msg: Dict[str, Any] = {"channel": pop.channel_of_preset[preset], "from": node}
        if hop_limit:
            msg["hop_limit"] = hop_limit
        if hop_start:
            msg["hop_start"] = hop_start
        if packet_id is not None:
            msg["id"] = packet_id
        if direct and rng.random() < 0.5:
            msg["next_hop"] = rng.randint(1, 255)
        if direct and rng.random() < 0.6:
            msg["pki_encrypted"] = True
        priority = {"text": 64, "traceroute": 64, "routing": 70}.get(kind, rng.choice((0, 0, 0, 0, 10)))
        if priority:
            msg["priority"] = priority
        if hops_away and rng.random() < 0.7:
            msg["relay_node"] = rng.randint(1, 255)
        if rssi:
            msg["rx_rssi"] = rssi
        if snr:
            msg["rx_snr"] = snr
        msg["rx_time"] = rx_time
        msg["to"] = to
        if rng.random() < 0.2:
            msg["transport_mechanism"] = rng.choice((1, 2, 2, 2, 6))
        if no_rf or rng.random() < 0.08:
            msg["via_mqtt"] = True
        if kind == "text" and not direct and rng.random() < 0.3:
            msg["want_ack"] = True
        elif direct:
            msg["want_ack"] = True
        # Keys mqtt.py appends after decoding the ServiceEnvelope.
        msg["sender"] = gateway
        if rssi:
            msg["rssi"] = rssi
            msg["snr"] = snr
        msg["timestamp"] = rx_time
        msg["topic"] = pop.map_topic_of[gateway] if kind == "mapreport" else pop.topic_of[gateway]
        msg["qos"] = 0
        msg["retain"] = False
        msg["channel_name"] = preset
        if hop_start:
            msg["hops_away"] = hops_away
        return msg

    def _copy_of(self, rng: random.Random, canonical: Dict[str, Any], gateway: str,
                 topic: str, rx_time: int) -> Dict[str, Any]:
        """Another gateway's uplink of the same packet: same content, its own RF envelope."""
        copy = dict(canonical)
        copy["sender"] = gateway
        copy["topic"] = topic
        # Typed reception columns never need a patch; only the deviations below (and
        # a canonical copy heard without an RF reading) produce an `extras` patch.
        deviation = rng.random() < self.extras_rate
        no_rf = deviation and rng.random() < 0.2
        for k in ("rx_rssi", "rx_snr", "rssi", "snr"):
            copy.pop(k, None)
        if not no_rf:
            rssi = rng.randint(-132, -45)
            snr = round(rng.uniform(-20.0, 12.0) * 4) / 4
            copy["rx_rssi"] = rssi
            if snr:
                copy["rx_snr"] = snr
            copy["rssi"] = rssi
            copy["snr"] = snr
        copy["rx_time"] = rx_time
        copy["timestamp"] = rx_time
        hop_start = canonical.get("hop_start", 0)
        if hop_start:
            hops_away = min(int(rng.expovariate(1 / 1.2)), hop_start)
            copy["hop_limit"] = hop_start - hops_away
            copy["hops_away"] = hops_away
            if copy["hop_limit"] == 0:
                del copy["hop_limit"]
            copy.pop("relay_node", None)
            if hops_away and rng.random() < 0.7:
                copy["relay_node"] = rng.randint(1, 255)
        if rng.random() < 0.2:
            copy["transport_mechanism"] = rng.choice((1, 2, 2, 2, 6))
        else:
            copy.pop("transport_mechanism", None)
        copy.pop("via_mqtt", None)
        if canonical.get("via_mqtt") and not deviation:
            copy["via_mqtt"] = True
        if deviation:
            r = rng.random()
            if no_rf or r < 0.5:
                # Bridged through MQTT on the way to this gateway (or not, when
                # the canonical copy was): via_mqtt flips.
                if not canonical.get("via_mqtt"):
                    copy["via_mqtt"] = True
            elif r < 0.85:
                # Gateway clock ahead: ingest clamps the alias, keeps rx_time.
                copy["timestamp"] = rx_time - rng.randint(301, 90000)
            else:
                copy["priority"] = 64 if canonical.get("priority") != 64 else 70
        return copy

    def packets(self, month: datetime.date, count: int) -> Iterator[Tuple[Dict[str, Any], datetime.datetime, List[Dict[str, Any]]]]:
        """Yield (canonical message, created_at, all copies incl. the canonical one) for count packets, in created_at order."""
        rng = self.month_rng(month)
        pop = self.pop
        stamps = sorted(self._created_at(rng, month) for _ in range(count))
        for created_at in stamps:
            kind = weighted_pick(rng, TYPE_MIX)
            node = pop.pick_node(rng)
            preset = weighted_pick(rng, tuple((name, share) for name, _, share in PRESETS))
            n_copies = max(1, poisson(rng, self.mean_receptions))
            gateways = pop.pick_gateways(rng, preset, n_copies)
            packet_id = None if kind == "mapreport" else rng.getrandbits(32) or 1
            msg = self._envelope(rng, kind, node, gateways[0], preset, created_at, packet_id)
            if kind == "position":
                msg["type"] = "position"
                msg["payload"] = _position_payload(rng)
            elif kind == "telemetry":
                variant, payload = _telemetry_payload(rng)
                msg["type"] = "telemetry"
                msg["payload"] = payload
                msg["telemetry_type"] = variant
            elif kind == "nodeinfo":
                msg["type"] = "nodeinfo"
                msg["payload"] = _nodeinfo_payload(rng, pop, node)
            elif kind == "neighborinfo":
                msg["type"] = "neighborinfo"
                msg["payload"] = _neighborinfo_payload(rng, pop, node)
            elif kind == "text":
                msg["type"] = "text"
                msg["payload"] = _text_payload(rng)
            elif kind == "traceroute":
                msg["type"] = "traceroute"
                msg["payload"] = _traceroute_payload(rng, pop)
                msg["packet_id"] = rng.getrandbits(32) if rng.random() < 0.5 else None
            elif kind == "routing":
                msg["type"] = "routing"
                msg["payload"] = {"error_reason": rng.choice((0, 0, 1, 3, 5, 9))}
            else:
                msg["type"] = "mapreport"
                msg["payload"] = _mapreport_payload(rng, pop, node)
            copies = [msg]
            for gw in gateways[1:]:
                copies.append(self._copy_of(rng, msg, gw, pop.topic_of[gw],
                                            msg["rx_time"] + rng.randint(0, 6)))
            yield msg, created_at, copies

    def rows(self, month: datetime.date, count: int, ids: Iterator[int],
             rng_recv: random.Random) -> Iterator[Tuple[tuple, List[tuple]]]:
        """Yield (mqtt row, reception rows with the topic string in the topic_id slot) per packet; the caller interns topics."""
        for msg, created_at, copies in self.packets(month, count):
            row_id = next(ids)
            payload_text = json.dumps(msg, ensure_ascii=False)
            packet_id = msg.get("id")
            mqtt_row = (
                row_id, msg["topic"], payload_text, msg["qos"], msg["retain"],
                msg["timestamp"], created_at, msg["from"], msg["to"], packet_id,
            )
            receptions: List[tuple] = []
            if copies:
                canonical = json.loads(payload_text)
                for i, copy in enumerate(copies):
                    # The canonical copy lands with the row; later uplinks trail it.
                    at = created_at if i == 0 else created_at + datetime.timedelta(
                        seconds=min(120.0, rng_recv.expovariate(1 / 25.0)))
                    gateway = gateway_from_msg(copy)
                    topic = copy["topic"]
                    fields = reception_fields(copy)
                    patch = reception_patch(reception_template(canonical, gateway, topic, fields), copy)
                    receptions.append((
                        row_id, at, gateway, topic,
                        fields["rx_rssi"], fields["rx_snr"], fields["rx_time"],
                        fields["hop_limit"], fields["hops_away"], fields["relay_node"],
                        fields["transport"], json.dumps(patch) if patch else None,
                    ))
            yield mqtt_row, receptions


# --- database side ---

async def partition_exists(conn: asyncpg.Connection, name: str) -> bool:
    return await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", name)


async def partition_has_rows(conn: asyncpg.Connection, name: str) -> bool:
    return bool(await conn.fetchval(f"SELECT EXISTS (SELECT 1 FROM {name})"))


async def ensure_partition(conn: asyncpg.Connection, table: str, month: datetime.date) -> bool:
    """Create <table>_YYYY_MM when missing (DDL identical to ensure_mqtt_partitions)."""
    name = f"{table}_{month_label(month)}"
    if await partition_exists(conn, name):
        return False
    lo, hi = month_bounds_sql(month)
    await conn.execute(
        f"CREATE TABLE IF NOT EXISTS {name} PARTITION OF {table} "
        f"FOR VALUES FROM (TIMESTAMPTZ '{lo}') TO (TIMESTAMPTZ '{hi}')"
    )
    return True


async def intern_topics(conn: asyncpg.Connection, receptions: List[tuple],
                        cache: Dict[str, int]) -> List[tuple]:
    """Replace each reception's topic string with its mqtt_topics id (as _intern_topic does)."""
    out = []
    for r in receptions:
        topic = r[3]
        tid = cache.get(topic)
        if tid is None:
            tid = await conn.fetchval(
                "INSERT INTO mqtt_topics (topic) VALUES ($1) "
                "ON CONFLICT (topic) DO UPDATE SET topic = EXCLUDED.topic RETURNING id",
                topic,
            )
            cache[topic] = int(tid)
        out.append(r[:3] + (cache[topic],) + r[4:])
    return out


async def allocate_ids(conn: asyncpg.Connection, n: int) -> List[int]:
    rows = await conn.fetch(
        "SELECT nextval('mqtt_messages_id_seq') AS id FROM generate_series(1, $1)", n)
    return [int(r["id"]) for r in rows]


async def load_month(conn: asyncpg.Connection, gen: Generator, month: datetime.date,
                     packets: int, batch: int, topic_cache: Dict[str, int]) -> Tuple[int, int, int]:
    """COPY one month through the parent tables. Returns (mqtt rows, receptions, rows with extras)."""
    rng_recv = random.Random(f"synth-history:{gen.seed}:{month:%Y-%m}:receptions")
    mqtt_rows: List[tuple] = []
    recv_rows: List[tuple] = []
    n_mqtt = n_recv = n_extras = 0
    ids: "collections.deque[int]" = collections.deque()

    def id_stream() -> Iterator[int]:
        while True:
            if not ids:
                raise RuntimeError("id block exhausted")
            yield ids.popleft()

    async def flush() -> None:
        nonlocal n_mqtt, n_recv
        if mqtt_rows:
            await conn.copy_records_to_table("mqtt_messages", records=mqtt_rows, columns=MQTT_COLUMNS)
            n_mqtt += len(mqtt_rows)
            mqtt_rows.clear()
        if recv_rows:
            records = await intern_topics(conn, recv_rows, topic_cache)
            await conn.copy_records_to_table("packet_receptions", records=records,
                                             columns=RECEPTION_COLUMNS)
            n_recv += len(recv_rows)
            recv_rows.clear()

    async with conn.transaction():
        ids.extend(await allocate_ids(conn, batch))
        stream = id_stream()
        for mqtt_row, receptions in gen.rows(month, packets, stream, rng_recv):
            mqtt_rows.append(mqtt_row)
            recv_rows.extend(receptions)
            n_extras += sum(1 for r in receptions if r[-1] is not None)
            if len(mqtt_rows) >= batch:
                await flush()
                ids.extend(await allocate_ids(conn, batch))
        await flush()
    return n_mqtt, n_recv, n_extras


async def month_stats(conn: asyncpg.Connection, month: datetime.date) -> List[Tuple[str, int, int]]:
    """(partition, rows, heap bytes) for both tables' partitions of `month`."""
    out = []
    for table in ("mqtt_messages", "packet_receptions"):
        name = f"{table}_{month_label(month)}"
        if not await partition_exists(conn, name):
            continue
        rows = await conn.fetchval(f"SELECT count(*) FROM {name}")
        heap = await conn.fetchval("SELECT pg_relation_size($1)", name)
        out.append((name, int(rows), int(heap)))
    return out


async def trigger_mismatches(conn: asyncpg.Connection, month: datetime.date) -> int:
    """Rows whose from/to/packet_id columns differ from what the node-id trigger derives; must be 0."""
    name = f"mqtt_messages_{month_label(month)}"
    if not await partition_exists(conn, name):
        return 0
    return int(await conn.fetchval(
        f"""SELECT count(*) FROM {name}
            WHERE from_node_id IS DISTINCT FROM left(regexp_replace(payload::jsonb ->> 'from', '^!', ''), 8)
               OR to_node_id IS DISTINCT FROM left(regexp_replace(payload::jsonb ->> 'to', '^!', ''), 8)
               OR packet_id IS DISTINCT FROM (CASE WHEN payload::jsonb ->> 'id' ~ '^[0-9]+$'
                                                   THEN (payload::jsonb ->> 'id')::bigint END)"""
    ))


# --- CLI ---

def _print_sample(gen: Generator, month: datetime.date) -> None:
    """One packet of every kind, with the byte length the archive would store."""
    seen: Dict[str, Tuple[str, int]] = {}
    sizes: Dict[str, List[int]] = {}
    for msg, _created_at, copies in gen.packets(month, 3000):
        text = json.dumps(msg, ensure_ascii=False)
        sizes.setdefault(msg["type"], []).append(len(text.encode("utf-8")))
        if msg["type"] not in seen:
            extras = None
            canonical = json.loads(text)
            for copy in copies[1:]:
                fields = reception_fields(copy)
                patch = reception_patch(
                    reception_template(canonical, gateway_from_msg(copy), copy["topic"], fields), copy)
                if patch:
                    extras = json.dumps(patch)
                    break
            seen[msg["type"]] = (text, len(copies), extras)
    print("sample payloads (first of each kind; byte length = octet_length(payload)):")
    for kind, (text, n_copies, extras) in seen.items():
        print(f"  [{kind}] {len(text.encode('utf-8'))} B, {n_copies} uplink cop(y/ies)"
              + (f", example extras: {extras}" if extras else ""))
        print("    " + text)
    total = sum(sum(v) for v in sizes.values())
    n = sum(len(v) for v in sizes.values())
    print("mean payload bytes by kind: " + ", ".join(
        f"{k}={sum(v) / len(v):.0f}" for k, v in sorted(sizes.items())))
    print(f"mean payload bytes overall: {total / max(n, 1):.0f} over {n} sampled packets")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", help="postgres DSN (default: from --config)")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parents[1] / "config.toml"))
    ap.add_argument("--from", dest="start", type=parse_month, help="first month YYYY-MM")
    ap.add_argument("--to", dest="end", type=parse_month, help="last month YYYY-MM (inclusive)")
    ap.add_argument("--months", nargs="+", type=parse_month, metavar="YYYY_MM",
                    help="explicit months instead of --from/--to")
    ap.add_argument("--packets-per-month", type=int, default=250000)
    ap.add_argument("--receptions-per-packet", type=float, default=4.5,
                    help="Poisson mean of uplink copies per packet, min 1 (default 4.5)")
    ap.add_argument("--extras-rate", type=float, default=0.08,
                    help="share of non-canonical uplink copies that deviate from the reconstruction "
                         "template and so carry an extras patch (default 0.08, ~10%% of rows overall)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--batch", type=int, default=5000, help="packets per COPY (default 5000)")
    ap.add_argument("--append", action="store_true",
                    help="add to target partitions that already hold rows (refused otherwise)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan and sample payloads; write nothing")
    args = ap.parse_args()

    if args.months:
        if args.start or args.end:
            print("pass either --months or --from/--to")
            return 2
        months = sorted(set(args.months))
    elif args.start:
        end = args.end or args.start
        if end < args.start:
            print("--to is before --from")
            return 2
        months = month_range(args.start, end)
    else:
        print("pass --from YYYY-MM [--to YYYY-MM] or --months YYYY_MM ...")
        return 2
    if args.packets_per_month < 1 or args.batch < 1 or args.receptions_per_packet <= 0 \
            or not 0.0 <= args.extras_rate <= 1.0:
        print("--packets-per-month/--batch must be >= 1, --receptions-per-packet > 0, "
              "--extras-rate within 0..1")
        return 2
    # Receptions trail their packet by up to 120 s, so each requested month
    # needs its successor to exist (non-contiguous lists spill into several).
    spills = [m for m in dict.fromkeys(next_month(x) for x in months) if m not in months]
    all_months = months + spills

    gen = Generator(args.seed, args.receptions_per_packet, args.extras_rate)
    print(f"plan: {len(months)} month(s) {month_label(months[0])}..{month_label(months[-1])}, "
          f"{args.packets_per_month} packets/month, {args.receptions_per_packet} receptions/packet, "
          f"seed {args.seed}, batch {args.batch}; spill month(s) "
          f"{', '.join(month_label(m) for m in spills) or 'none'}")
    print(f"population: {NODE_COUNT} nodes, {GATEWAY_COUNT} gateways, "
          f"{len(set(gen.pop.topic_of.values()) | set(gen.pop.map_topic_of.values()))} topics "
          f"under {TOPIC_PREFIX}/")

    if not args.dsn and not Path(args.config).is_file():
        print(f"no --dsn and config file {args.config} not found")
        return 2
    dsn = args.dsn or _dsn_from_config(Path(args.config))
    try:
        conn = await asyncpg.connect(dsn, command_timeout=None, timeout=30)
    except Exception as e:
        if args.dry_run:
            print(f"(database unreachable: {e}; printing the generator preview only)")
            _print_sample(gen, months[0])
            return 0
        raise
    t0 = time.monotonic()
    try:
        await conn.execute("SET TIME ZONE 'UTC'")
        for table in ("mqtt_messages", "packet_receptions"):
            relkind = await conn.fetchval(
                "SELECT relkind::text FROM pg_class WHERE relname = $1 "
                "AND relnamespace = 'public'::regnamespace", table)
            if relkind != "p":
                print(f"refusing: {table} is not a partitioned table (relkind={relkind!r})")
                return 2

        # preconditions / plan
        to_create: List[str] = []
        busy: List[str] = []
        for m in all_months:
            for table in ("mqtt_messages", "packet_receptions"):
                name = f"{table}_{month_label(m)}"
                if not await partition_exists(conn, name):
                    to_create.append(name)
                elif await partition_has_rows(conn, name):
                    busy.append(name)
        if to_create:
            print("partitions to create: " + ", ".join(to_create))
        if busy:
            print("partitions already holding rows: " + ", ".join(busy))
            if not args.append:
                print("refusing: target partitions are not empty (pass --append to add to them)")
                return 2

        if args.dry_run:
            _print_sample(gen, months[0])
            print("dry run complete - nothing written")
            return 0

        # load
        for m in all_months:
            for table in ("mqtt_messages", "packet_receptions"):
                if await ensure_partition(conn, table, m):
                    print(f"created {table}_{month_label(m)}")
        topic_cache: Dict[str, int] = {}
        for m in months:
            t_month = time.monotonic()
            n_mqtt, n_recv, n_extras = await load_month(
                conn, gen, m, args.packets_per_month, args.batch, topic_cache)
            print(f"[{month_label(m)}] loaded {n_mqtt} mqtt_messages + {n_recv} packet_receptions "
                  f"({n_extras} with extras, {100.0 * n_extras / max(n_recv, 1):.1f}%) "
                  f"in {time.monotonic() - t_month:.1f}s")
        print(f"interned {len(topic_cache)} topic(s) in mqtt_topics")
        # Leave the partitions as autovacuum would (stats, visibility map, COPY's
        # trailing empty pages truncated) so the footprint below is steady state.
        for m in all_months:
            for table in ("mqtt_messages", "packet_receptions"):
                await conn.execute(f"VACUUM (ANALYZE) {table}_{month_label(m)}")

        # report
        print("per-month heap footprint (pg_relation_size / count):")
        for m in all_months:
            for name, rows, heap in await month_stats(conn, m):
                per_row = heap / rows if rows else 0.0
                print(f"  {name:<30} {rows:>10} rows {heap:>13} B  {per_row:7.1f} B/row")
        for m in months:
            mism = await trigger_mismatches(conn, m)
            print(f"  mqtt_messages_{month_label(m)}: trigger-derived column mismatches: {mism}"
                  + ("" if mism == 0 else "  <-- generator bug"))
        print(f"elapsed {time.monotonic() - t0:.1f}s")
        drops = ", ".join(
            f"{t}_{month_label(m)}" for m in all_months for t in ("mqtt_messages", "packet_receptions"))
        print("clean-up when done:")
        print(f"  DROP TABLE {drops};")
        print(f"  DELETE FROM mqtt_topics WHERE topic LIKE 'msh/%/{SYNTH_REGION}/%';")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
