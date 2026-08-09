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
