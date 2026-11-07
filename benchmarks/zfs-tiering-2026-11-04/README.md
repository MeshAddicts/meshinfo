# ZFS tiered cold storage — measurements (2026-11-04)

Lab measurements behind [ZFS.md](../../ZFS.md): how much a compressing
filesystem shrinks the raw packet archive (`mqtt_messages`, `packet_receptions`)
on stock PostgreSQL 18, what the ZFS record-size/codec choice does to that, what
it costs in query latency, and how the tiering job behaves under concurrent load.

Everything here is reproducible with the scripts in [`lab/`](lab/) (see
"Reproducing" at the end). Numbers are from one run; the synthetic archive is
deterministic (`--seed 1`), the timings are from a Docker Desktop VM on a
Windows 10 workstation and should be read as orders of magnitude.

## Setup

| | |
|---|---|
| PostgreSQL | 18.4 (Debian `postgres:18` image); `lab/lab-setup.sh` sets `shared_buffers=1GB`, `work_mem=16MB`, `maintenance_work_mem=256MB`, `effective_cache_size=3GB`, `max_wal_size=8GB`, `checkpoint_timeout=15min`, `max_locks_per_transaction=256`, `log_lock_waits=on`, `log_min_duration_statement=2000`. Sections 1–4 ran with `wal_level=minimal` (the copy skips WAL and the rebuilt partition's files are fsynced at `COMMIT`, under the parent lock: ~0.8 s per swap); section 4b was re-measured with the default `wal_level=replica`, which `lab-setup.sh` now sets |
| Host | Docker Desktop 29.5 (WSL2 kernel 6.18, 24 CPUs assigned, 8 GB VM RAM), privileged container, loop-mounted images on the VM's ext4 disk |
| Baseline FS | ext4 (`noatime`) holding `PGDATA` |
| Compressing FS | btrfs loop mounts with `compress-force=zstd:3`, `compress-force=zstd:9`, `compress-force=lzo`; one tablespace on each (`ts_zstd3`, `ts_zstd9`, `ts_lzo`). ZFS itself is not loadable in this kernel; btrfs compresses per 128 KiB extent with 4 KiB sectors, i.e. roughly a ZFS `recordsize=128K` dataset, and the ZFS model below covers the other record sizes |
| Schema | `postgres/sql/schema.sql` plus every runtime object `PostgresStorage.ensure_schema` creates (partial indexes, the trigram GIN, the node-id trigger), dumped from a cluster the app initialised |
| Data | `scripts/synth_history.py --from 2026-02 --to 2026-07 --packets-per-month 250000 --receptions-per-packet 4.5 --seed 1` |

### Synthetic archive (calibrated to production)

| table | rows | heap | heap B/row | indexes | total | total B/row |
|---|---:|---:|---:|---:|---:|---:|
| `mqtt_messages` (6 months) | 1,499,996 | 1.13 GB | 753 | 0.67 GB | 1.80 GB | 1,201 |
| `packet_receptions` | 6,248,815 | 0.66 GB | 105 | 0.65 GB | 1.31 GB | 210 |
| database (`pg_database_size`) | | | | | **3.12 GB** | |

The canonical rows carry Meshtastic-shaped JSON exactly as `write_mqtt_message`
serialises it (position/telemetry/nodeinfo/neighborinfo/text/traceroute/mapreport
mix, ~570 B of payload text, 11 rows per 8 KiB page → 753 B per heap row, the
production figure). Each packet gets 1–12 receptions (Poisson, mean 4.5; mapreports
none) through the parent table, so some land in the next month's partition.
Reception rows measure 105 B in the heap plus 104 B across their two B-trees
(the `(gateway, created_at DESC)` index is 70 % of that). **Production
receptions are 176 B per heap row** (the reference "~155 B" sits between the
two figures), so the synthetic receptions are under-sized by about 40 % in
the heap — and `packet_receptions` is about a third of the real database
(9.6 of 29.08 GB, section 5). Every reception-side size and ratio below is
therefore indicative only; the authoritative number for an installation is
`scripts/zfs_estimate.py` run on the live volume, which models the real files.
The archive measured here was generated before a review fix that gives
mapreports (5 % of packets, no packet id) the one-reception-per-gateway that
ingest records for them; with the shipped generator the same command yields
~6.5 M receptions instead of 6.25 M, which changes nothing below materially.
Note that none of the payloads reach PostgreSQL's 2 KB TOAST threshold: the
`COMPRESSION lz4` on `payload` never fires, the heap is plain JSON text, and the
filesystem is the only compression this data ever gets.

Relation classes in the 3.12 GB: heap 1.79 GB (57 %), B-tree 1.15 GB (37 %),
trigram GIN 0.18 GB (6 %), TOAST/FSM/VM < 0.01 GB.

## 1. Real on-disk size on a compressing filesystem (btrfs, `compsize`)

`PGDATA/base/<db>` copied onto each mount after a `CHECKPOINT` with the server
stopped, then `compsize -b` per file, mapped to relation classes through the
catalog from `scripts/zfs_estimate.py dump-catalog` (`lab/compsize_by_class.py`).
Logical size 3,122,782,208 B in every case.

| mount | on disk | whole-DB ratio | heap | B-tree | trigram GIN |
|---|---:|---:|---:|---:|---:|
| btrfs `zstd:3` | 622 MB | **5.02×** | 4.75× | 5.20× | 7.82× |
| btrfs `zstd:9` | 593 MB | **5.27×** | 4.82× | 5.81× | 8.22× |
| btrfs `lzo` | 1,249 MB | **2.50×** | 2.25× | 2.99× | 2.72× |

Per relation (zstd:3): `mqtt_messages_YYYY_MM` heap 5.33×, `packet_receptions`
heap 4.00×, the receptions' `(gateway, created_at)` B-tree 6.39×. Sorted index
keys compress better than the JSON heap; the trigram GIN best of all. These match
the reference lab (zstd:3 4.7×, zstd:9 5.3×, lzo 2.4×; B-trees 5–6×, GIN ~7×,
JSON heap ~5×).

Raw per-relation numbers (relations ≥ 1 MiB): [`compsize_zstd3.json`](compsize_zstd3.json),
[`compsize_zstd9.json`](compsize_zstd9.json), [`compsize_lzo.json`](compsize_lzo.json).

## 2. ZFS model: codec × recordsize

<!-- MODEL:START -->
`scripts/zfs_estimate.py estimate` over the real relation files of the ext4
cluster (3,146,481,664 B logical incl. catalogs; 1,558 files; every record
compressed, no sampling). ZFS rules modelled: records of `recordsize`, the
compressed buffer kept only when it saves ≥ 12.5 %, physical size rounded up to
4 KiB (`ashift=12`), all-zero records stored as holes. Whole-database ratio
(logical / physical), with per-class ratios for the heap, B-trees and the trigram GIN:

| codec | 8K | 16K | 32K | 64K | 128K | 128K heap / btree / gin |
|---|---:|---:|---:|---:|---:|---|
| lz4 | 1.91× | 2.19× | 2.61× | 3.10× | 3.28× | 3.06 / 3.54 / 4.48 |
| zstd-3 | 1.99× | 2.98× | 3.52× | 4.36× | **5.01×** | 4.75 / 5.20 / 7.82 |
| zstd-9 | 1.99× | 2.99× | 4.26× | 5.04× | **5.26×** | 4.82 / 5.81 / 8.19 |
| gzip-6 | 1.99× | 2.97× | 3.50× | 4.35× | 4.92× | 4.75 / 5.06 / 6.24 |

Per-class ratios at 16K (the hot setting): zstd-3 heap 2.92×, btree 3.07×,
gin 3.00×; zstd-9 heap 2.93×, btree 3.08×, gin 3.04× — at 16 KiB records the
4 KiB rounding, not the codec, sets the outcome, which is why the hot dataset
uses the cheaper zstd-3.

Record size dominates: an 8 KiB record (one PostgreSQL page) can only ever
shrink to 4 KiB, so every codec sits at 2.0× there; 128 KiB records give the
codec 16 pages of similar JSON/keys to work with. The model's 128K results
reproduce the btrfs measurements of section 1 (zstd-3 5.01× vs 5.02×
measured; zstd-9 5.26× vs 5.27×), which is the cross-check that the model
can be trusted for the record sizes btrfs cannot emulate. Reference lab for
zstd-9: 2.0× @8K, 3.5× @16K, 4.1× @32K, 5.2× @128K — same shape; this archive
compresses a little worse at 16K and a little better at 32K.

Tiered projection on the lab itself (`--hot zstd-3@16K --cold zstd-9@128K
--now 2026-11-01`, cold_after_months 1 or 3): every synthetic month is cold,
so the cluster lands at 602,112,000 B, **5.23×** (heap 4.81×, btree 5.80×,
gin 8.19×); the hot tier holds only the live partitions and catalogs (34 MB
logical → 12 MB).

Raw outputs: [`model_lz4.json`](model_lz4.json), [`model_zstd-3.json`](model_zstd-3.json),
[`model_zstd-9.json`](model_zstd-9.json), [`model_gzip-6.json`](model_gzip-6.json),
[`model_tiered_n1.json`](model_tiered_n1.json), [`model_tiered_n3.json`](model_tiered_n3.json).
Model run times on 24 vCPUs, one process per codec: lz4 17 s, zstd-3 39 s,
zstd-9 222 s, gzip-6 248 s for all five record sizes.
<!-- MODEL:END -->

## 3. Query latency, ext4 vs compressed

<!-- LATENCY:START -->
`lab/bench_queries.py`: the app's representative queries against one cold
month (2026-06), each run once **cold** (PostgreSQL restarted and the page cache
dropped with `drop_caches` first) and then five times **warm** (median shown),
with the six months on ext4, then rebuilt on `ts_zstd3`, then on `ts_zstd9` —
moved each time with `scripts/tier_partitions.py run --apply --all` and verified
with whole-row digests through the parent tables (identical after every move).
Final code (the job runs `VACUUM (FREEZE, ANALYZE)` on each moved partition).

| query | ext4 cold | ext4 warm | zstd:3 cold | zstd:3 warm | zstd:9 cold | zstd:9 warm |
|---|---:|---:|---:|---:|---:|---:|
| month page, newest 101 (`ORDER BY created_at DESC, id DESC`) | 47 ms | 4.7 ms | 90 ms | 8.4 ms | 76 ms | 4.7 ms |
| month page, keyset cursor into the middle | 54 ms | 4.8 ms | 77 ms | 5.3 ms | 73 ms | 4.8 ms |
| node page (`from_node_id = $1 OR to_node_id = $1`) | 431 ms | 10.3 ms | 378 ms | 11.2 ms | 311 ms | 13.0 ms |
| topic filter page (trigram GIN, `ILIKE '%MediumFast%'`) | 58 ms | 5.6 ms | 87 ms | 7.4 ms | 79 ms | 5.8 ms |
| payload `ILIKE` search over 3 days (seq scan, 0 hits) | 720 ms | 103 ms | 527 ms | 104 ms | 494 ms | 91 ms |
| packet permalink + its receptions | 33 ms | 2.5 ms | 46 ms | 3.0 ms | 41 ms | 2.9 ms |
| one gateway's receptions for a day (index-only count) | 22 ms | 1.8 ms | 30 ms | 1.9 ms | 35 ms | 2.4 ms |
| `count(*)` of the month | 66 ms | 13.4 ms | 73 ms | 14.3 ms | 63 ms | 13.9 ms |

Warm, everything the Logs page, node pages, deeplinks and stats do is the same
on all three filesystems (differences of 0–2 ms are run-to-run noise; the
seq-scan search is slightly faster on the compressed mounts because it reads
fewer bytes). Cold, page/permalink/topic queries pay 10–40 ms more on the
compressed mounts: btrfs decompresses a whole 128 KiB extent to serve one 8 KiB
page. Plans do not change — the same indexes are used, and the planner never
sees the tablespace layout.

A first run of this sequence, before the job vacuumed the rebuilt partition,
showed the two index-only-scan rows at 25 ms and 25–42 ms warm on the
compressed mounts versus 1.5 ms and 13 ms on ext4: a freshly rebuilt partition
has no visibility-map bits, so every index entry costs a heap visit until it
is vacuumed. That is a property of the rebuild, not of the filesystem, and the
reason the job now runs `VACUUM (FREEZE, ANALYZE)` right after the swap (it
also keeps readers from ever dirtying the cold pages, see section 4).

Move timings in this sequence (14 partitions: 6 months × 2 tables + 2 empty
spill partitions; 1.5 M + 6.25 M rows; no concurrent load):

| pass | from → to | bytes before → after | wall time |
|---|---|---:|---:|
| 1 | ext4 (`pg_default`) → `ts_zstd3` | 2.69 GB → 2.69 GB | 38.0 s |
| 2 | `ts_zstd3` → `ts_zstd9` | 2.69 GB → 2.69 GB | 45.2 s |
| 3 | `ts_zstd9` → `pg_default` (`--tablespace pg_default`) | 2.69 GB → 2.69 GB | 37.2 s |

Per partition: 3.6–4.0 s for a 250k-row `mqtt_messages` month (190 MB heap +
9 indexes), 2.4–2.8 s for a 1.04 M-row `packet_receptions` month, every swap on
its first attempt; the vacuum adds ~0.4 s per partition. The very first rebuild
(an earlier pass from the loaded-as-inserted state, [`tier_to_zstd3.json`](tier_to_zstd3.json))
packed the indexes: 112 MB → 75.5 MB per `mqtt_messages` month and 109 MB →
75.1 MB per `packet_receptions` month (−33 %, the reference's figure; 3.11 GB →
2.69 GB for the archive). The tablespaces measured with `compsize` after a
`CHECKPOINT` (never before — freshly moved pages are still dirty in shared
buffers and a half-written file reports a bogus ratio): `ts_zstd3` 2.69 GB →
609 MB (4.41×), `ts_zstd9` 2.69 GB → 588 MB (4.57×), both in ~20,700 extents
(≈ 130 KiB each, i.e. full-size).

Per class on `ts_zstd9` after the rebuild (`lab/lab-coldclass.sh`, catalog
re-dumped because relfilenodes change): heap 4.78×, B-tree 4.19×, GIN 4.25×.
The dense rebuilt indexes compress less per byte than the loose originals
(5.81× / 8.22× in section 1) because compression was already harvesting the
slack in half-empty pages — the compressed bytes come out nearly the same
(loose B-trees 1,152 MB → 198 MB; rebuilt 791 MB → 189 MB), so the −33 %
rebuild gain is a logical-size gain, not an on-disk one, on a compressing
filesystem. The projection in section 5 uses the loose-index ratios on
loose-index logical sizes, which is the consistent pair.

Raw: [`latency_ext4.json`](latency_ext4.json), [`latency_zstd3.json`](latency_zstd3.json),
[`latency_zstd9.json`](latency_zstd9.json), [`tier_to_zstd3.json`](tier_to_zstd3.json),
[`tier_to_zstd9.json`](tier_to_zstd9.json), [`tier_back_1.json`](tier_back_1.json),
[`compsize_rebuilt_zstd9.json`](compsize_rebuilt_zstd9.json).
<!-- LATENCY:END -->

## 4. End-to-end tiering run under concurrent load

<!-- E2E:START -->
`lab/lab-e2e.sh`: whole-row digests of every month through the parent tables,
then `lab/load_harness.py` (6 readers running the Logs page queries — newest
page, node page, topic filter, a cold-month window page, packet permalink +
receptions, 24 h stats — and 2 writers inserting canonical packets + receptions
into the current month through the parents, exactly like ingest) for the whole
duration of

```
tier_partitions.py --tablespace ts_zstd9 --cold-after-months 3 run --apply --all --deep-verify
```

Acceptance run on the shipped code (after the review fixes):

| | |
|---|---|
| partitions moved | 12 (6 months × 2 tables), 7.75 M rows, 2.69 GB |
| wall time under load | **61.9 s** (5.3–5.9 s per `mqtt_messages` month, 4.4–5.6 s per `packet_receptions` month; quiet: 38–45 s for the same set) |
| swap attempts | 1 for every partition (no `busy`, no retries, no postponed attempts) |
| deep verify | digest of every row compared before the swap, all equal |
| concurrent requests | **13,233 completed, 0 errors** |
| latency, all ops | p50 1.5 ms, p99 193 ms, max 1.27 s |
| whole-row digests before vs after (per month, both tables) | identical |
| `plan` afterwards | empty (nothing left to move) |
| scratch objects (`*_tiering*`) afterwards | none |
| `run --apply --all --tablespace pg_default` afterwards | 12 moved back in 55.1 s, digests identical again |

Per operation during the move (ms, p50 / p99 / max): newest page 1.0 / 36 /
1,196; node page 15 / 378 / 1,270; topic filter 2.2 / 41 / 949; cold-month
window page 1.2 / 6.1 / 1,117; permalink 1.3 / 9.6 / 1,194; 24 h stats 1.1 /
2.4 / 806; writes 5.5 / 564 / 1,206. The 1–1.3 s maxima are the twelve swaps:
`DETACH PARTITION` needs ACCESS EXCLUSIVE on the parent, so it waits for the
readers in flight (a node-page query under this load can take 400 ms) while
new requests queue behind it, and the lock is held until the commit — which
in this run, under `wal_level=minimal`, fsynced the rebuilt partition's files
first (~0.8 s; section 4b measures the same swap under the default
`wal_level=replica`, where the commit takes tens of milliseconds); dropping
the detached 260 MB original is not the cost (measured separately: 29 ms).
Everything else
is the copy's I/O competing with the readers. Three earlier loaded runs of the
same script (before the review fixes, [`e2e_run.json`](e2e_run.json) is the
final one) took 66–80 s with 10,641–16,861 requests, 0 errors every time,
p99 58–393 ms and maxima of 1.1–3.0 s. Reference lab: 986 requests, 0 errors,
p99 18 ms for two months.

**Copy-on-write caveat (btrfs-specific).** Measured with `compsize` after a
`CHECKPOINT`, the cold tablespace came out at 2.69 GB → 712 MB (**3.79×**, in
69,297 extents) after this loaded run — 657–784 MB (3.4–4.1×) across the
loaded runs — against 588 MB (4.57×, 20,689 extents) after the quiet run of
section 3. Under load the 2.69 GB of new pages leave the 1 GB of shared
buffers one 8 KiB page at a time in scrambled order, so btrfs writes back many
short extents, each compressed on its own (an 8 KiB extent can at best halve).
The data is not the problem, the layout is: `lab/lab-defrag.sh` reproduced a
loaded move (10,641 concurrent requests, 0 errors) at 657 MB (4.09×), and
`btrfs filesystem defragment -r -czstd` of the tablespace took 4 s and brought
it to 609 MB — exactly the quiet-run `zstd:3` figure (defragment recompresses
at the level it is given), with the digests unchanged
([`defrag_before.txt`](defrag_before.txt), [`defrag_after.txt`](defrag_after.txt)).
ZFS does not have this failure mode: records are fixed-size (128 KiB on the
cold dataset), a stray 8 KiB write rewrites and recompresses the whole record,
so the ratio stays at the record-size figure (write amplification instead of
fragmentation). The job's post-move `VACUUM (FREEZE, ANALYZE)` makes sure
nothing touches the cold pages afterwards.

Raw: [`e2e_run.json`](e2e_run.json), [`e2e_harness.json`](e2e_harness.json),
[`e2e_digest_before.json`](e2e_digest_before.json), [`e2e_digest_after.json`](e2e_digest_after.json),
[`e2e_digest_back.json`](e2e_digest_back.json), [`e2e_status_after.json`](e2e_status_after.json),
[`e2e_back.json`](e2e_back.json), [`e2e_compsize_cold.txt`](e2e_compsize_cold.txt),
[`defrag_harness.json`](defrag_harness.json), [`defrag_run.json`](defrag_run.json).
<!-- E2E:END -->

### 4b. The swap stall bound

<!-- STALL:START -->
The swap's `DETACH PARTITION` needs ACCESS EXCLUSIVE on the parent. While
that request waits for the queries already running, every new query and
insert on the parent queues behind it, so the per-attempt timeout is what
bounds the stall an API user can see, and the number of attempts bounds how
long a move can be delayed. `lab/lab-stall.sh` measures both: the e2e load
of section 4 (6 readers + 2 writers) plus one more client that every 12 s
holds ACCESS SHARE on `mqtt_messages` for 3.5–7 s (four payload `ILIKE`
sequential scans over the cold month inside one transaction — the "long
in-flight query"), while `run --apply --all` moves the six months onto
`ts_zstd9`; then everything is moved back and the run repeated with the
previous constants through `lab/tier_with_constants.py`. Both legs start
from freshly rebuilt partitions (the script primes them once), and this run
used PostgreSQL's default `wal_level = replica` (sections 1–4 ran with the
lab's earlier `minimal`; see Setup).

| swap constants | moves | swaps that met a scan | longest ordinary request | > 3 s | > 1 s | requests queued behind a swap | p50 / p99 | errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| shipped: 2.5 s per attempt (`lock_timeout`, and `statement_timeout` on the DETACH), 10 attempts, pauses 1/2/4/8/16/20 s, wall-clock probe | 12 in 55.8 s | 3 attempts postponed by the probe (two months, completed on attempts 3 and 2); none timed out | **1.87 s** — a node page: ~0.7 s queued behind one swap, then ~1.1 s of its own under the copy's I/O | 0 | 1 | 8, at one swap, 0.70–0.78 s | 3.0 / 93 ms | 0 of 14,319 |
| previous: 20 s, 6 attempts, pauses ≤ 5 s, probe against `now()` | 12 in 32.2 s | 0 (the slow client's 5 scans fell between the swaps) | 2.16 s — a node page during the warm-up, before any move | 0 | 2 | 0 | 1.8 / 134 ms | 0 of 10,051 |

What the shipped leg shows: the probe now sees the slow client's scan
although it started during the copy (the first measurement's probe compared
against `now()`, which is frozen at the move's BEGIN, and never fired —
finding 1 of the second-pass review), so the three attempts that would have
met a scan were postponed instead of queueing every request for the timeout:
the swap log carries `postponed … has held a lock on mqtt_messages since …`
three times and `hit lock_timeout` never. The one stall of the run is the
`mqtt_messages_2026_03` swap, whose ACCESS EXCLUSIVE request waited about
0.7 s for node-page queries in flight (p99 269 ms under this load, a few
reaching 0.5–0.9 s while the WAL-logged copy competes for I/O): all eight
clients queued 0.70–0.78 s there, and the node page among them went on to
take 1.87 s in total. The swap's own hold is not visible at all: measured on
the idle server with a prober hitting the parent every 5 ms
(`lab/hold_probe.py`), moving `mqtt_messages_2026_02` (250 k rows, 263 MB,
9 indexes) held the parent for **33 ms** on the way to the cold tablespace
and 27 ms on the way back ([`hold_to_cold.json`](hold_to_cold.json),
[`hold_back.json`](hold_back.json)) — DETACH, renames, ATTACH, DROP and the
commit's WAL flush together. Under `wal_level = minimal` the same hold was
~0.8 s (the commit fsyncs the rebuilt partition's files first), which the
first measurement of this section — longest wait 2.51 s with the shipped
constants against 5.70 s with the previous ones, one collision each way —
had folded into "the swap itself".

The previous-constants leg met no scan this time (5 scans, 12 swaps, none
overlapping), so its row cannot show the 5.7 s stall the first measurement
did; its longest request happened during the warm-up. Whole-row digests were
identical before and after both legs, nothing was busy or failed, and the
slow client's own scans completed every time (its transactions cause the
stalls; they are never their victims). Wall times and p50 are not a
controlled pair: the shipped leg ran first, straight after the prime and the
reset had written about 5 GB of WAL, with the checkpoint that follows. The
aggregate p99 sits at the edge of the ~1 % of requests that meet a swap at
all and is not comparable between legs either; "longest request", "> 1 s"
and "> 3 s" are the comparison. Worst case by construction: a move whose
every attempt meets such a scan is given up as busy after ten attempts
(~2.5 min of pauses and timeouts) and retried an hour later; no single
request ever waits longer than the 2.5 s timeout plus the swap's hold.

Raw: [`stall_new_harness.json`](stall_new_harness.json), [`stall_new_run.json`](stall_new_run.json),
[`stall_new_run.log`](stall_new_run.log), [`stall_old_harness.json`](stall_old_harness.json),
[`stall_old_run.json`](stall_old_run.json), [`stall_old_run.log`](stall_old_run.log),
[`stall_prime.json`](stall_prime.json).
<!-- STALL:END -->

## 5. Projection onto the production inventory

<!-- PROJECTION:START -->
Production inventory: **29.08 GB** on 2026-11-01 — `pg_database_size`, which
already includes every index: 13.6 GB heap + 5.4 GB indexes for the canonical
`mqtt_messages` partitions and 5.4 GB + 4.2 GB for `packet_receptions`,
28.6 GB of the 29.08. The projection applies the lab's heap ratios from
section 2 (hot zstd-3@16K 2.92×, cold zstd-9@128K 4.82×) to the whole size
with [`lab/project_production.py`](lab/project_production.py) and
[`ratios.json`](ratios.json). Assumptions, all adjustable on the command line:

* every month carries the same volume, so with `M` months of history and
  `cold_after_months = 1` the cold share is `(M − 2) / M` (current + previous
  month hot); production's month count is not known here, so 12 / 18 / 24 are shown;
* the heap ratio is used for the whole database: the heap is the class that
  compresses least (B-trees 3.07× / 5.81×, GIN 3.00× / 8.19× in the lab), so
  this errs on the large side. The last row applies the per-class ratios to
  the inventory's own split instead (19.0 GB heap, 9.6 GB indexes at B-tree
  ratios, 0.5 GB other) as a cross-check — fresh lab indexes are tighter than
  bloated production ones, which is why it is not the headline;
* the "conservative" rows add 25 % to the whole compressed size, indexes
  included (a heap-only haircut would give 11.6 / 7.5 GB at 18 months), to
  cover payload entropy the synthetic archive cannot reproduce (unique text,
  real positions, encrypted channels); the per-class cross-check applies its
  25 % to the heap share only (11.4 / 7.3 GB conservative,
  [`projection-split-m18.json`](projection-split-m18.json)).

| layout | 12 months | 18 months | 24 months | reference |
|---|---:|---:|---:|---:|
| one zstd-3@16K dataset | 9.95 GB | 9.95 GB | 9.95 GB | 9.6 GB |
| … conservative (+25 %) | 12.4 GB | 12.4 GB | 12.4 GB | 11 GB |
| tiered 16K/zstd-3 + 128K/zstd-9, `cold_after_months=1` | 6.69 GB | 6.47 GB | 6.36 GB | 5.9 GB |
| … conservative | 8.36 GB | 8.08 GB | 7.95 GB | 7.0 GB |
| tiered, `cold_after_months=3` | | 6.90 GB | | |
| per-class cross-check, single / tiered (`cold_after_months=1`) | | 9.80 / 6.21 GB | | |

Bottom line: a single 16K/zstd-3 dataset divides the archive by ~3; tiering
closed months onto 128K/zstd-9 divides it by ~4.5 (the cold tier alone runs
at 5.2×, section 2) and the gap widens as history accumulates, because the hot
share shrinks. The Citus-columnar branch reached 21.2 GB on the same inventory
with heap-only compression and 10–90× regressions on filtered queries; here
nothing about the plans changes (section 3). An earlier revision of this
section treated the 29.08 GB as heap only and added indexes on top at the
lab's proportion ("heap + indexes, 51 GB"); the inventory figure already
contains them, so that scope double-counted the indexes and is withdrawn.
Raw: [`projection-m12.json`](projection-m12.json), [`projection-m18.json`](projection-m18.json),
[`projection-m24.json`](projection-m24.json), [`projection-m18-n3.json`](projection-m18-n3.json),
[`projection-split-m18.json`](projection-split-m18.json).
<!-- PROJECTION:END -->

## Reproducing

```sh
# 1. lab image + container (privileged: loop mounts, drop_caches, pg_ctl)
docker build -t meshinfo-tiering-lab lab/
docker run -d --privileged --name meshinfo-tiering-lab -v "$PWD/../..:/repo:ro" meshinfo-tiering-lab
# btrfs must be loadable in the VM kernel; on Docker Desktop: wsl -d docker-desktop -- modprobe btrfs
docker cp lab/. meshinfo-tiering-lab:/lab/           # scripts + schema_full.sql (pg_dump --schema-only of an app-initialised DB)
docker exec meshinfo-tiering-lab /lab/lab-setup.sh   # loop images, PG 18 on ext4, tablespaces on btrfs
# 2. data
docker exec meshinfo-tiering-lab python3 /repo/scripts/synth_history.py --dsn postgresql://postgres@127.0.0.1:5432/meshinfo \
    --from 2026-02 --to 2026-07 --packets-per-month 250000 --receptions-per-packet 4.5 --seed 1
# 3. measurements
docker exec meshinfo-tiering-lab /lab/lab-measure-sizes.sh     # section 1 (+ catalog + inventory)
docker exec meshinfo-tiering-lab python3 /repo/scripts/zfs_estimate.py estimate --pgdata /mnt/ext4/pgdata \
    --catalog /lab/catalog.json --codec lz4 zstd-3 zstd-9 gzip-6 --recordsize 8K 16K 32K 64K 128K --json   # section 2
docker exec meshinfo-tiering-lab /lab/lab-latency.sh           # section 3 (+ a move back with --tablespace pg_default)
docker exec meshinfo-tiering-lab /lab/lab-e2e.sh               # section 4
docker exec meshinfo-tiering-lab /lab/lab-stall.sh             # section 4b: the swap stall bound, shipped vs previous constants
#    (an existing lab from before lab-setup.sh switched to wal_level=replica: ALTER SYSTEM SET wal_level = 'replica' + pg_ctl restart first)
#    the swap's hold alone: python3 /lab/hold_probe.py --dsn ... --stop-file /lab/hold.stop --json /lab/hold.json & then one `run --apply --partition ...`
python3 lab/project_production.py --ratios ratios.json --database-gb 29.08 --months 18 --cold-after-months 1   # section 5
```
