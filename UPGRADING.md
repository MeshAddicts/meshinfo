# Upgrading

Release-specific notes. The routine update command is in [README.md](README.md#3-update).

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

## Discord bridge channel maps

`[integrations.discord.bridge.channels]` and `position_channels` keys keyed on
legacy slot-index values (e.g. `"0"`) stop matching once traffic resolves to
hashes. Re-key them to hash ids — find yours via `/v1/channels` or the `?ch=`
value in Chat URLs.

## Coverage preset renames

The meta preset names `LongModerate` and `VeryLongSlow` are now aliases of
`LongMod` and `LongFast`. Saved Coverage-tool presets that used `VeryLongSlow`
restore as `LongFast`.
