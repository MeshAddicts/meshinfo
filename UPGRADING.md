# Upgrading

Release-specific notes. The routine update command is in [README.md](README.md#3-update).

## Per-node flood guard

A single node looping Meshtastic MapReports at ~50/s filled a production disk
in days: MapReports carry no packet id, so uplink dedup never applied and every
copy became an `mqtt_messages` row. Three changes, none needing a migration:

- **Id-less packets dedup by content.** A packet without a packet id (MapReport,
  `MeshPacket.id = 0`) now merges with identical-content copies from the same
  node inside `[storage] content_dedup_window_seconds` (default 120 s — real
  re-publications are minutes apart; the window is short so they stay separate
  rows), recording one `packet_receptions` row per gateway. A same-gateway
  repeat inside the window writes nothing and skips the node update too. A node
  whose copies keep being absorbed (30+ in a minute) is called out in the logs:
  once when it starts —
  `Node eba3d8e8 keeps re-sending identical packets (30 duplicate copies this minute); dedup is absorbing them (add "eba3d8e8" to [storage] ingest_denylist to drop it at the decoder)`
  — then per minute while it continues:
  `Node eba3d8e8: 2900 duplicate copies absorbed by dedup in the last minute`.
  This is part of uplink dedup: with `dedup_uplinks = false` id-less packets are
  stored per copy again.
- **`[storage] max_packets_per_node_per_minute = 60` / `max_packets_per_node_per_hour = 600`**
  cap *new* archive rows per originating node. Uplink copies that dedup folds
  into `packet_receptions` don't count, so dense meshes are unaffected (measured
  legit peaks ≈ 28/min and 119/hour). Overflow is dropped before it reaches the
  database, and a node over budget stops writing anywhere — telemetry/chat/
  traceroute history rows and node/position/telemetry state — until its window
  rolls over (it still gets 60 rows a minute until the 600-per-hour tier is
  spent, then nothing until the hour rolls over). WARNING per node — once when
  dropping starts, then a per-minute summary:
  `Node eba3d8e8: dropped 2880 writes in the last minute (over 60/min or 600/hour new rows)`.
  Set a tier to `0` to disable it. The guard needs `dedup_uplinks = true`
  (without dedup every copy is a row and the caps would clip busy nodes; the
  config check warns if you have dedup off). Uplink copies have a ceiling of
  their own: roughly 1000 receptions per archived packet per dedup window (the
  densest legit packet seen carries ~90), so replaying one packet id at flood
  rate can't grow `packet_receptions` without bound either. Known gap: while
  the database is down nothing can be charged, so a flood whose content varies
  per message is bounded only by the 10,000-item retry buffer, as before.
- **`[storage] ingest_denylist = ["eba3d8e8"]`** drops a node's packets at the
  decoder — as origin or as the uplinking gateway — so nothing is archived and no
  node/position/telemetry update runs (logged once per node at INFO when its
  packets start being dropped). Blunt, for a node you have given up on; note a
  denylisted gateway silences every packet it uplinks.

Rows a flood already wrote stay put: `scripts/compact_mqtt_partitions.py`
passes id-less rows through unchanged. Purge them by hand, with the app up
(row locks only). Always bound the `DELETE` by node **and** the flood dates:
archive rows from before uplink dedup (#526) also carry `packet_id IS NULL` and
are legit history. Delete in batches — a day at a time, or an hour at a time
while the disk is critical (a day of flood is millions of rows and the DELETE
writes WAL first). A plain `VACUUM` only marks the space reusable inside that
monthly partition, and once the month is over nothing new lands there, so `df`
won't move; to get the space back on the volume run `VACUUM FULL` on the leaf
partition later, when there is headroom for a copy of its live rows (it locks
that partition for the duration):

```sql
SELECT from_node_id, count(*) FROM mqtt_messages
 WHERE packet_id IS NULL AND created_at > now() - interval '7 days'
 GROUP BY 1 ORDER BY 2 DESC LIMIT 5;

DELETE FROM mqtt_messages
 WHERE from_node_id = 'eba3d8e8' AND packet_id IS NULL
   AND created_at >= '2026-08-13' AND created_at < '2026-08-14';   -- repeat per day
VACUUM (VERBOSE) mqtt_messages_2026_08;          -- space reusable within the month
-- later, with headroom: VACUUM FULL mqtt_messages_2026_08;   -- returns it to the OS
```

## Channel ids are now resolved hashes

Chat channels are bucketed by the firmware channel id — a hash of the channel name
and PSK — instead of the gateway's slot index (0–7). New traffic files itself
correctly; historical rows stay in the old 0–7 buckets until you re-file them:

```sh
docker compose exec meshinfo python scripts/backfill_channel_buckets.py           # dry-run
docker compose exec meshinfo python scripts/backfill_channel_buckets.py --apply
```

Dry-run first and take the backup it prints the command for. The script refuses to
run until the app's automatic node-ID backfill has finished (it tells you if it
hasn't). Safe to interrupt, re-run, and run while ingest is live.

New rows store their wire channel name (`chat_messages.channel_name`); the
backfill also fills it for historical rows while their archive copies exist.

### Name-keyed buckets for decode-only meshes

When every gateway on a channel uplinks already-decoded packets (MQTT
`encryption_enabled = false`), its real hash never appears on the wire, so it
can't be learned. Those packets used to keep the gateway's slot index, which
conflated every such channel sharing a slot. They now file under a stable
bucket derived from the wire channel name (a large id, ≥ 2^30), labeled with
that name automatically. If the real hash is ever observed later, the name
bucket merges into it on its own. This applies to new traffic; messages already
stored under a slot index stay where they are. These buckets are "named
channels" for `broker.channels.mode` purposes: visible under `"all"`, hidden
under `"presets"` unless the name is a stock preset.

A named channel is never bucketed in 0–7 anymore, even when that is its genuine
hash (roughly 3% of name/PSK pairs hash into the slot-index range — `ares`
hashes to 7). Those ids cannot be told apart from a gateway slot index and
cannot carry a channel name in storage, so such a channel gets a name bucket
too. If you have one, its ids will differ from instances that bucket it by hash.

First start after this upgrade also builds a `pg_trgm` GIN index over
`mqtt_messages.topic` (backs the Log page's channel filters) — expect roughly
40s per 3M archived rows. `pg_trgm` is a trusted extension (PostgreSQL 13+), so
the database owner can create it without superuser; if creation still fails,
MeshInfo logs a warning and runs without it — topic filters just get slower.

## `broker.channels.mode`

`display` and `[[broker.channels.views]]` are honored only when
`broker.channels.mode = "manual"`. A config that has them without a `mode` gets a
startup warning and shows automatic pills instead. Set `mode = "manual"` to keep
your curated list, or drop the lists and use `"presets"` (default) or `"all"`.

## Discord bridge: straggler copies edit instead of re-posting

The bridge used to forget a packet 60 s after first sight, so a gateway copy
arriving later (measured up to ~14 min on a real mesh) re-posted the same
packet as a fresh embed with `Gateways 1` (#585). Posted embeds now stay
editable for `[integrations.discord.bridge] edit_window_seconds` (default
900 s): late copies update the original embed's gateway list, and the embed
timestamp stays the packet's own time instead of shifting on each edit. The
"View All Gateways" detail view is also capped to Discord's per-message
limits (10 embeds / 6000 chars) with a truncation note when a very large
reception list is cut.

## Discord bridge channel maps

`[integrations.discord.bridge.channels]` and `position_channels` now accept
wire channel **names** as keys (`"MediumFast" = "<discord id>"`) — the
recommended form: names are what operators know, they follow a channel across
PSK re-keys, and they also match decode-only channels whose hash never appears
on the wire. Matching is case-sensitive (wire names are). Numeric keys still
work and take precedence — use one to pin a single name+PSK domain when two
communities share a channel name, or for a channel whose *name* is all digits.
Caveat: messages from the JSON decoder carry no wire name, so JSON-only
deployments should keep numeric keys.

Legacy slot-index keys (e.g. `"0"`) stop matching once the protobuf decoder
resolves traffic to hash buckets; JSON-only deployments are unaffected and
keep their slot-index keys. Protobuf deployments should re-key to names, or
find bucket ids via `/v1/channels` or the `?ch=` value in Chat URLs.

## Coverage preset renames

The meta preset names `LongModerate` and `VeryLongSlow` are now aliases of
`LongMod` and `LongFast`. Saved Coverage-tool presets that used `VeryLongSlow`
restore as `LongFast`.
