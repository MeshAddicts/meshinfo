# Compressed history on ZFS or btrfs

MeshInfo keeps the raw packet archive forever (`mqtt_messages` and
`packet_receptions`, 98%+ of all rows), so the data volume only ever grows.
This document covers two things that shrink it without changing the schema,
the queries or the application, on the two compressing filesystems the
tiering job's mount check accepts, ZFS and btrfs:

1. **Running Postgres on a compressed ZFS dataset.** The whole cluster — heap,
   indexes, TOAST, WAL — is compressed by the filesystem. Postgres sees
   ordinary 8 KiB pages; nothing in the app changes.
2. **Tiering closed months onto a cold-tuned filesystem.** Once a month is
   old enough, the app's tiering job moves its partitions into the
   `meshinfo_cold` tablespace, which lives on a ZFS dataset or a btrfs
   filesystem with a large record size and a heavy codec. Current data stays
   where it is: on a hot dataset tuned for random 8 KiB writes, or — in the
   cold-only layout — on the Docker volume it has always been on.

Part 2 on its own is the lower-effort layout and the one most installs want
("Choosing a layout" below): nothing moves except closed months, nothing is
copied by hand, and rolling back is a short procedure with the scheduler
switched off. Part 1 adds a hot dataset for the live months, WAL and
catalog. Both are opt-in: a stack without an overlay and with
`[storage.tiering] enabled = false` (the default) behaves exactly as before.

Quick reference once set up:

```sh
docker compose exec meshinfo python scripts/tier_partitions.py status          # every month, hot/cold, where it lives
docker compose exec meshinfo python scripts/tier_partitions.py plan            # what the next cycle would move
docker compose exec meshinfo python scripts/tier_partitions.py run             # dry run (default)
docker compose exec meshinfo python scripts/tier_partitions.py run --apply     # really move
zfs get compressratio,used,logicalused tank/meshinfo/pgdata tank/meshinfo/pgcold   # ZFS datasets
sudo compsize -x /srv/meshinfo/pgcold                                               # btrfs cold directory
```

## Why

The `payload` column is already `lz4`-compressed by Postgres (TOAST), but that
is per value and only for values large enough to TOAST. Everything else —
tuple headers, the fixed columns, every B-tree and GIN index entry, the
`packet_receptions` rows (~70 B each, far below the TOAST threshold), WAL —
is stored raw. Stock Postgres has no heap or index compression.

ZFS compresses each filesystem record independently, and a 16 KiB or 128 KiB
record holds dozens to hundreds of similar rows (same topic prefixes, same
gateways, consecutive ids and timestamps), so it compresses far better than a
single value can. Indexes compress too. Nothing about the query plans changes
because Postgres never knows: the OS hands it the same pages it wrote.

Closed months are the perfect tiering candidate. Ingest writes only into the
current month's partition, the legacy node-id backfill is a one-time job, and
nothing else updates history — so a closed month is effectively immutable and
read in range scans. That is exactly the workload where a big record size and
an expensive codec pay off and cost nothing at run time.

## Choosing a layout

The tiering job is filesystem-agnostic: it needs a directory mounted at
`/var/lib/postgresql/cold` inside the `postgres` container, and its mount
check accepts ZFS and btrfs. What differs between the layouts is how much of
the database gets compressed and how much work the switch is.

| layout | needs | compresses | lab ratio | production archive, 29 GB, 18 months |
|---|---|---|---|---|
| **Cold-only, btrfs** | a spare block device, partition or loop image file: `mkfs.btrfs`, mounted `compress-force=zstd:9,noatime`, one fstab line (`nofail`, ordered before Docker); `docker-compose.cold.yml`. Nothing to migrate; rollback is a `--tablespace pg_default` run with the scheduler off, then `DROP TABLESPACE` | the closed months only (with the default `cold_after_months = 1`: everything but the current and the previous month); the live cluster stays on its Docker volume, untouched | **5.3×** against the months' original size (3.12 GB → 593 MB, measured on btrfs `zstd:9` with `compsize`; heap 4.8×, B-trees 5.8×, trigram GIN 8.2×). On months the job has moved, `compsize` reads ≈ 4.6×: the rebuild packs the indexes by about a third, so the same bytes on disk are divided by a smaller logical size | ≈ 8.6 GB (10.7 GB conservative) |
| **Cold-only, ZFS** | a dataset on an existing pool: `setup-zfs-datasets.sh --cold-only`; `docker-compose.cold.yml`. Nothing to migrate; same rollback | the same | **5.3×** (ZFS model, `zstd-9` at 128K: 5.26× against the 5.27× measured on btrfs; `zfs get compressratio` on the rebuilt months reads ≈ 4.6× for the same reason) | ≈ 8.6 GB (10.7 GB conservative) |
| **Full ZFS** | ZFS on the host; two datasets (`setup-zfs-datasets.sh`); the stack stopped while the existing volume is rsynced onto the hot dataset; `docker-compose.zfs.yml` | everything: the live months, WAL and catalog on the hot dataset (16K / `zstd-3`), the closed months on the cold one (128K / `zstd-9`) | hot **3.0×** (model, `zstd-3` at 16K), cold **5.3×** | ≈ 6.5 GB (8.1 GB conservative) |

Production figures: the lab's heap ratios applied to a 29.08 GB
`pg_database_size` with 18 months of history and the default
`cold_after_months = 1` (`lab/project_production.py` in the benchmark
directory; "Measurements"
below has 12 and 24 months). The cold-only layouts leave the two hot months
uncompressed, which is where their extra ~2 GB comes from; the gap narrows
as history accumulates and the hot share shrinks.

Nothing is migrated in the cold-only layouts: mount the filesystem, `docker
compose up -d` with the overlay, flip `enabled = true`, and the job moves
closed months at one partition an hour (`run --apply --all` does it in one
go). Rolling back is the cold-only rollback below: scheduler off,
`tier_partitions.py --tablespace pg_default run --apply --all`, `DROP
TABLESPACE meshinfo_cold`, then drop the overlay. The full layout buys the
last ~25 % — the hot months at 3× instead of 1× — for the price of ZFS on
the host and a stop-the-stack copy of the cluster.

**Why btrfs is fine for the cold months and not recommended under the live
cluster.** A cold month is written once by the move (sequentially, in
128 KiB extents on a quiet server, then frozen by the post-move `VACUUM`)
and only read afterwards — the workload a copy-on-write filesystem with
per-extent compression handles best, and the lab measured the same 5.3× on
btrfs as the ZFS model gives at 128K. The live cluster is the opposite:
Postgres rewrites 8 KiB pages in place all day (ingest, hint bits, index
updates, autovacuum, WAL), and on btrfs every such rewrite becomes a new,
small, separately compressed extent — files fragment, range scans turn into
seeks, and the ratio decays. The lab saw this on the cold tablespace itself
when months were moved under heavy concurrent load: the copy's pages left
shared buffers one 8 KiB page at a time and the tablespace came out at
3.4–4.1× in three times as many extents, against 4.6× from a quiet move
(benchmark README, section 4). The post-move `VACUUM (FREEZE)` keeps readers
from dirtying the month afterwards but does not undo that layout;
`sudo btrfs filesystem defragment -r -czstd -L 9 /srv/meshinfo/pgcold`
coalesces it in seconds (`-L 9` needs kernel 6.15 / btrfs-progs 6.14 or
newer — an older kernel rejects it, so drop it and the mount's level
applies; on a newer kernel a bare `-czstd` recompresses at zstd level 3) —
a live cluster would need that continuously. ZFS is copy-on-write too, but
with fixed-size records, a tunable record size and the ARC it is the
filesystem PostgreSQL is routinely run on compressed — and even there the
hot dataset is tuned (16K records, `zstd-3`) rather than left at defaults.
So: ZFS or btrfs for the cold months; ZFS with those properties, or plain
ext4/xfs, under the cluster.

**Docker volumes already on a ZFS or btrfs pool** (common on NAS-style
hosts): there is nothing new to format. ZFS: create a dataset with the cold
properties — `setup-zfs-datasets.sh --cold-only <pool>/meshinfo-cold
/<pool>/meshinfo-cold`, or by hand `zfs create -o recordsize=128K -o
compression=zstd-9 -o atime=off -o xattr=sa -o logbias=throughput
<pool>/meshinfo-cold` — and point `MESHINFO_PGCOLD_DIR` at its mountpoint.
btrfs: create a subvolume for the cold directory (`btrfs subvolume create
/<pool>/meshinfo-cold`) and give it compression, either with
`compress-force=zstd:9` in the mount options if the whole filesystem may be
compressed, or as a property on the directory (`btrfs property set
/<pool>/meshinfo-cold compression zstd`, inherited by everything written
into it). The property selects only the codec: the level is the
filesystem's `compress=` mount level, or zstd's default 3 when there is
none, and a `zstd:9` suffix is accepted but silently ignored (`btrfs
property get` echoes it back; files written underneath report plain
`zstd`) — expect the lab's `zstd:3` figure, 5.0×, from the property, and
5.3× only with `zstd:9` in the mount options. Either way `chown 999:999`
the directory (the script does it; `zfs create` and `btrfs subvolume
create` leave it root-owned, and the job's `CREATE TABLESPACE` then fails
as "not writable"), and `findmnt -no FSTYPE -T <directory>` must print
`zfs` or `btrfs` (`-T`, because a subvolume is not a mount point of its own
and a plain `findmnt <directory>` prints nothing for it); that filesystem
type is what the job's mount check sees through the overlay's bind.

## Dataset layout

Two datasets under one parent, created by `scripts/setup-zfs-datasets.sh`, in
the full ZFS layout. The cold-only layouts use the second row alone — a
dataset from `setup-zfs-datasets.sh --cold-only`, or a btrfs filesystem
mounted `compress-force=zstd:9` — at whatever host path `MESHINFO_PGCOLD_DIR`
names:

| Dataset | Mountpoint (default) | Container path | Properties | Holds |
|---|---|---|---|---|
| `<pool>/meshinfo/pgdata` | `/tank/meshinfo/pgdata` | `postgres:/var/lib/postgresql` | `recordsize=16K compression=zstd-3 atime=off xattr=sa logbias=latency` | the cluster: catalog, every live table, hot months, WAL |
| `<pool>/meshinfo/pgcold` | `/tank/meshinfo/pgcold` | `postgres:/var/lib/postgresql/cold`, `meshinfo:/mnt/meshinfo-cold` (ro) | `recordsize=128K compression=zstd-9 atime=off xattr=sa logbias=throughput` | the `meshinfo_cold` tablespace: closed months moved by the tiering job |

`<pool>` is whatever your pool is called; `tank` is only the overlay's default.
The cold dataset is also bind-mounted read-only into the `meshinfo` container
so the job can check free space before it copies a month, confirm every cycle
that the mount really is zfs/btrfs, and refuse to create the tablespace on
anything else (see `cold_filesystem` below).

### Why those properties

**`recordsize` dominates, not the codec.** ZFS compresses one record at a
time and stores the result rounded up to the sector size — 4 KiB on the usual
`ashift=12` pool. An 8 KiB record can therefore only ever shrink to 4 KiB
(2:1), whatever the codec achieves. A 16 KiB record can land on 4, 8 or
12 KiB; a 128 KiB record has 32 steps and gets within a few percent of the
codec's native ratio. (ZFS also keeps a record uncompressed unless compression
saves at least 12.5%, which matters for small records.) This is why the
measured whole-database ratio moves much more with record size than with
`zstd-3` vs `zstd-9`.

**Hot stays at 16K.** Postgres writes random 8 KiB pages. With a 128 KiB
record every page write becomes a read–recompress–write of 128 KiB, which is
real write amplification on a live database with continuous ingest, WAL and
autovacuum. 16K is the standard Postgres-on-ZFS compromise: two pages per
record, bounded amplification, and still clear of the 2:1 ceiling that 8K
would impose.

**Cold goes to 128K / zstd-9.** A cold month is written once (sequentially,
by the move) and then only read, mostly in range scans over `created_at`, so
the large record costs nothing on reads and the one-off compression time is
irrelevant. `zstd-9` compresses several times slower than `zstd-3` but
decompresses at the same speed, which is the only side that matters after the
move.

**The rest.** `atime=off` avoids a metadata write on every read.
`xattr=sa` stores extended attributes in the inode instead of hidden
directories (the Docker daemon and PG's own file operations touch xattrs
occasionally; this is the standard Linux setting). `logbias=latency` on the
hot dataset keeps WAL fsyncs on the fast path (and on a SLOG if you have one);
`logbias=throughput` on the cold dataset tells ZFS not to funnel the bulk
copy's large writes through the ZIL. Leave `sync`, `primarycache` and
`full_page_writes` at their defaults — none of them is worth the risk here.

**Changing properties later** only affects newly written blocks: `zfs set
recordsize=...` does not rewrite existing files. That is fine for this design
because every byte on the cold dataset is written fresh by a move, and the
initial copy onto the hot dataset (below) rewrites the cluster at 16K.

**The btrfs equivalent.** btrfs has no record size: it compresses per extent
of up to 128 KiB with 4 KiB sectors, so `compress-force=zstd:9` behaves like
the cold dataset's 128K / `zstd-9` (the lab measured 5.27× on btrfs with
`compsize`; the ZFS model in `scripts/zfs_estimate.py` gives 5.26× at 128K /
`zstd-9`, within 0.2 % — the lab could not load ZFS itself, so the ZFS side
is modelled, as in the table below). Use `compress-force`, not `compress`:
with plain `compress` btrfs stops compressing a file after an extent that
did not shrink enough, and the benchmarks were run with `compress-force`.
`noatime` for the same reason as `atime=off`.

## Setup

The full ZFS layout is steps 1–5. A cold-only layout is the cold-only setup
right below and then steps 4 and 5; steps 1–3 do not apply to it.

### Cold-only setup

**a. A compressed filesystem for the cold months**, owned by the postgres
image's user (`999:999`). One of:

- *btrfs on a spare block device or partition* (`/dev/sdX1` below is
  formatted — the whole thing):

  ```sh
  sudo mkfs.btrfs -L meshinfo-cold /dev/sdX1
  sudo mkdir -p /srv/meshinfo/pgcold
  echo 'LABEL=meshinfo-cold  /srv/meshinfo/pgcold  btrfs  compress-force=zstd:9,noatime,nofail,x-systemd.device-timeout=30s,x-systemd.before=docker.service  0 0' | sudo tee -a /etc/fstab
  sudo mount /srv/meshinfo/pgcold
  sudo chown 999:999 /srv/meshinfo/pgcold && sudo chmod 750 /srv/meshinfo/pgcold
  ```

- *btrfs in a loop image file* when there is no spare device: the same thing
  on a file, sized for the compressed archive plus headroom (at 5× a 20 GB
  image holds some 100 GB of months), on ext4 or xfs — not on a filesystem
  that would compress or snapshot the image a second time:

  ```sh
  sudo fallocate -l 20G /var/lib/meshinfo-cold.img               # preallocated: fails now if the room is not there
  sudo mkfs.btrfs -L meshinfo-cold /var/lib/meshinfo-cold.img
  sudo mkdir -p /srv/meshinfo/pgcold
  echo '/var/lib/meshinfo-cold.img  /srv/meshinfo/pgcold  btrfs  loop,nodiscard,compress-force=zstd:9,noatime,nofail,x-systemd.before=docker.service  0 0' | sudo tee -a /etc/fstab
  sudo mount /srv/meshinfo/pgcold
  sudo chown 999:999 /srv/meshinfo/pgcold && sudo chmod 750 /srv/meshinfo/pgcold
  ```

  The job's free-space guard measures the btrfs inside the image, not what
  the filesystem holding it has left, so the image must be fully backed: a
  sparse image (`truncate`) would let a move fill the backing filesystem
  with the guard still passing, and `nodiscard` keeps btrfs from punching
  freed extents back out of the preallocation.

- *a ZFS dataset* on an existing pool, with the cold properties, mounted and
  chowned by the script:

  ```sh
  sudo scripts/setup-zfs-datasets.sh --cold-only <pool>/meshinfo-cold /srv/meshinfo/pgcold
  scripts/setup-zfs-datasets.sh --cold-only <pool>/meshinfo-cold /srv/meshinfo/pgcold --dry-run   # preview
  ```

- *already on ZFS or btrfs* — a dataset or subvolume with compression, see
  "Choosing a layout"; nothing to format.

Whichever it is, `findmnt /srv/meshinfo/pgcold` must show `btrfs` or `zfs`
(for a btrfs subvolume, which is not a mount point of its own, `findmnt -no
FSTYPE -T /srv/meshinfo/pgcold` must print `btrfs` instead): that is what
the job's mount check verifies from inside the container, and with it set
(step 5) the job refuses to create the tablespace anywhere else. `nofail`
keeps the host booting when the cold device or image is missing or broken —
without it a failed fstab mount fails `local-fs.target` and the boot drops
into emergency mode with no Docker and no ssh, to protect a filesystem that
only holds compressed copies of closed months; the stack must come up and
only the cold months fail, which is the UNMOUNTED line in step 4.
`x-systemd.before=docker.service` keeps the mount attempt ordered before
the Docker daemon, which `nofail` would otherwise drop, so the containers do
not bind the bare mountpoint while a slow device is still appearing. A ZFS
dataset needs neither: `zfs-mount.service` mounts it, and a failure there
does not stop the boot. After a reboot, `docker compose exec postgres
findmnt /var/lib/postgresql/cold` (or the check under "Upgrades") confirms
the bind points at the real filesystem — if it does not, mount it and
`docker compose restart postgres meshinfo` (step 4 explains why the restart
is needed).

**b. The overlay.** `docker-compose.cold.yml` binds that directory at
`/var/lib/postgresql/cold` in `postgres` and read-only at `/mnt/meshinfo-cold`
in `meshinfo`; the named volume stays exactly as it is. Put the path and the
overlay in `.env` next to the compose files:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=/srv/meshinfo/pgcold
```

Naming the files — in `COMPOSE_FILE` or with `-f` — switches off Compose's
automatic loading of `docker-compose.override.yml`. If you keep one
(`docker-compose.yml` suggests it for the `127.0.0.1:5432` port map), list
it too, before the overlay:
`COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml`;
`docker compose config` shows the merged result, so check that your
override's settings are still in it.

```sh
docker compose config | grep -B2 'target: /var/lib/postgresql/cold'   # the bind is there
docker compose up -d                                                  # recreates postgres and meshinfo with the binds
```

`MESHINFO_PGCOLD_DIR` has no default on purpose: without it `docker compose`
refuses to start instead of binding an empty directory on the root
filesystem. Nothing is migrated — the cluster has not moved — so this is a
restart, not a maintenance window.

**c. Steps 4 and 5 below.** The job creates the tablespace on its first
enabled cycle; configure it with `cold_filesystem = "/mnt/meshinfo-cold"`.

**Rolling back:** (1) set `[storage.tiering] enabled = false` and restart
`meshinfo` first — while the scheduler runs, every month the CLI brings
back is eligible again at the next hourly tick, and nothing coordinates the
two ("Moving months back" below). (2) `tier_partitions.py --tablespace
pg_default run --apply --all` brings every month back onto the Docker
volume (same locking, same verification); this direction is not
free-space-guarded, so the volume's filesystem needs room for
`pg_tablespace_size('meshinfo_cold')` uncompressed, plus the WAL of each
move; rerun on exit code 1 (busy). (3) `tier_partitions.py --tablespace
pg_default plan --all` must report nothing left to move. (4) `docker compose
exec postgres psql -U postgres -d meshinfo -c 'DROP TABLESPACE
meshinfo_cold'` while the directory is still mounted: it refuses while
anything is still on the tablespace, so it doubles as the check, and it
removes the `PG_<version>_…` directory. A tablespace left defined would
point at an empty directory inside the named volume once the bind is gone:
harmless for queries, but the next enabled cycle would skip `CREATE
TABLESPACE` and fail with `could not create directory` instead of one of
the step-4 refusals. (5) Remove the overlay from `COMPOSE_FILE` and the
fstab line, `docker compose up -d`; only then can the cold filesystem go.

### 1. Create the datasets

*Full ZFS layout — cold-only installs use the setup above instead.* On the
ZFS host, as root:

```sh
sudo scripts/setup-zfs-datasets.sh tank/meshinfo                # pool/parent of your choice
scripts/setup-zfs-datasets.sh tank/meshinfo --dry-run           # preview the commands first
sudo scripts/setup-zfs-datasets.sh tank/meshinfo --uid 999 --gid 999
```

The script creates `<parent>/pgdata` and `<parent>/pgcold` (and the parent if
missing), applies the properties above, chowns both mountpoints to the
postgres image's user (`999:999`), and prints the mountpoints plus the next
steps. It is idempotent: on re-run it leaves existing datasets alone and just
re-applies the properties. `--dry-run` works without `zfs` installed; the
real mode refuses to run without it or without root.

### 2. Point the stack at them

*Full ZFS layout.* `docker-compose.zfs.yml` is an overlay on
`docker-compose.yml`. It binds the
hot dataset at `/var/lib/postgresql` (replacing the `meshinfo_pgdata` named
volume mount), the cold dataset at `/var/lib/postgresql/cold`, and the cold
dataset read-only into `meshinfo` at `/mnt/meshinfo-cold`:

```sh
docker compose -f docker-compose.yml -f docker-compose.zfs.yml config    # check the merged result
docker compose -f docker-compose.yml -f docker-compose.zfs.yml up -d
```

The overlay must be passed on *every* compose command from now on, or the
stack falls back to the named volume. Make it the default by adding to `.env`
(next to the compose files, the same place the Postgres memory settings go):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.zfs.yml
MESHINFO_ZFS_HOT=/tank/meshinfo/pgdata       # only if your mountpoints differ
MESHINFO_ZFS_COLD=/tank/meshinfo/pgcold
```

With `COMPOSE_FILE` set, plain `docker compose up -d`, `docker compose exec
…` and the maintenance scripts (which run `docker compose` underneath) all
pick up the overlay. The named volume is no longer mounted; an existing
`meshinfo_meshinfo_pgdata` volume stays on disk until you remove it. If you
keep a `docker-compose.override.yml`, list it in `COMPOSE_FILE` too, before
the overlay — Compose stops loading it automatically once the files are
named (see the cold-only setup).

### 3. Switching an existing Docker volume

*Full ZFS layout — the cold-only layouts never move the cluster.* A fresh
install just starts (step 2) and Postgres initialises the cluster on
the hot dataset. An existing install has to carry its cluster across. The
copy rewrites every block at 16K/zstd-3, so the hot dataset shows the full
whole-database compression as soon as it finishes.

```sh
scripts/maintenance.sh on                                  # optional: branded 503 page while down
docker compose down                                        # whole stack stopped; the named volume stays

docker volume ls | grep meshinfo_pgdata                    # usually meshinfo_meshinfo_pgdata
SRC="$(docker volume inspect -f '{{.Mountpoint}}' meshinfo_meshinfo_pgdata)"
sudo rsync -aHAX --info=progress2 "$SRC/" /tank/meshinfo/pgdata/
sudo chown -R 999:999 /tank/meshinfo/pgdata

docker compose -f docker-compose.yml -f docker-compose.zfs.yml up -d
docker compose exec postgres psql -U postgres -d meshinfo -c 'SELECT count(*) FROM nodes;'
scripts/maintenance.sh off
```

Check the logs page and a few node pages, then reclaim the old volume with
`docker volume rm meshinfo_meshinfo_pgdata` (or keep it a while as a
rollback). The `rsync` runs as root because the volume's `_data` directory is
root-only; `-aHAX` keeps ownership, modes, hard links, ACLs and xattrs, and
the trailing slashes copy the *contents* (the `18/docker` subdirectory PG 18
uses) rather than nesting a directory.

### 4. The cold tablespace

The tiering job creates the `meshinfo_cold` tablespace itself the first time
it runs with `enabled = true` (so does `tier_partitions.py run --apply`):
`CREATE TABLESPACE meshinfo_cold LOCATION '<cold_tablespace_location>'`,
with `cold_tablespace_location = "/var/lib/postgresql/cold"` by default — the
path the overlay binds the cold dataset to inside the `postgres` container.
"Mount the dataset, flip `enabled`" is the whole operator path. It needs
three things, all of which the setup script, the overlay and the stock
compose file provide: the cold dataset must be mounted on the host, its root
must be owned by the postgres user (`999:999`), and the app's database role
must be a superuser (`POSTGRES_USER=postgres`). When one is missing the job
logs one actionable line and tries again an hour later; nothing moves until
it is fixed:

```
tiering: cycle not run: cannot create tablespace 'meshinfo_cold': directory /var/lib/postgresql/cold is not writable by the postgres server user. With docker-compose.zfs.yml or docker-compose.cold.yml this is also what an UNMOUNTED cold filesystem looks like (Compose binds the bare, root-owned mountpoint directory underneath it): check `findmnt <host mountpoint>` first, mount it, then `docker compose restart postgres meshinfo` …
tiering: cycle not run: not creating tablespace 'meshinfo_cold' at /var/lib/postgresql/cold: cold tablespace is on ext4 (/, holding cold_filesystem = '/mnt/meshinfo-cold') — months will move but not compress; a tablespace created on the wrong filesystem … would hide the moved months once the dataset mounts over it …
tiering: cycle not run: cannot create tablespace 'meshinfo_cold': directory /var/lib/postgresql/cold is not empty — it already holds a PG_<version> tablespace directory …
tiering: cycle not run: cannot create tablespace 'meshinfo_cold': the connecting role is not a superuser (CREATE TABLESPACE needs one) …
tiering: cycle not run: cannot create tablespace 'meshinfo_cold': directory /var/lib/postgresql/cold does not exist inside the postgres container — the overlays (docker-compose.zfs.yml, docker-compose.cold.yml) bind the cold directory at /var/lib/postgresql/cold; without one, or with another cold_tablespace_location, mount or create the directory there first …
```

With either overlay the directory inside the container always exists
(Compose creates the host path if it has to), so a cold filesystem that is
not mounted — the pool imported late, a reboot before `zfs mount -a`, an
fstab entry that did not mount — shows up as the first line, not as "does
not exist". Mounting it on the host is only half the fix: a bind taken while
the filesystem was unmounted keeps showing the bare directory for the life
of the container (Docker binds are private by default, so a mount made on
the host afterwards never appears inside), and a plain `docker compose up
-d` does not recreate containers whose configuration is unchanged — after
mounting, run `docker compose restart postgres meshinfo`. The same restart
brings back cold months that were already moved; until then Postgres
answers `could not open file` for them. Do not `chown` the bare directory
to make the first line go away: the next cycle would create the tablespace
on the root filesystem, and the moved months would vanish underneath the
real filesystem the moment it mounts. With `cold_filesystem` set (the
overlay's bind into `meshinfo`, step 5) the job notices on its own and
creates nothing until the mount is right — the second line. The last line
belongs to a stack that has never run with an overlay, or to another
`cold_tablespace_location`; a cold-only stack that ran with the overlay once
and then lost it (`docker compose -f docker-compose.yml up -d` by habit, or
`COMPOSE_FILE` dropped from `.env`) shows the first line instead — Docker
leaves the empty, root-owned mount point behind inside the named volume —
or the second with `cold_filesystem` set, reported as `on overlay`. Before
looking at the host mount, repeat the `docker compose config | grep
'target: /var/lib/postgresql/cold'` check from the cold-only setup: no match
means the bind is missing from this compose invocation, not from the host.

Prefer to manage tablespaces by hand? Set `cold_tablespace_location = ""`
(the job then only reports that the tablespace is missing) and create it
once yourself:

```sh
docker compose exec postgres psql -U postgres -d meshinfo \
  -c "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold';"
docker compose exec postgres psql -U postgres -d meshinfo -c '\db'
```

Either way Postgres creates a version-specific subdirectory (`PG_18_…`)
inside the location; a location that already holds one for the same major
version (another tablespace of this cluster, or a re-initialised cluster of
the same version) is refused. A previous major version's `PG_<old>_…`
directory is not: the new cluster creates its own beside it (see Upgrades).

### 5. Configure the job

```toml
[storage.tiering]
enabled = true                        # scheduler runs hourly while true; the CLI works regardless
cold_after_months = 1                 # a month is cold once this many whole calendar months have
                                      # elapsed since it closed (minimum 1: the current and the
                                      # previous month always stay hot); higher keeps more recent
                                      # months uncompressed, at the cost of ratio
cold_tablespace = "meshinfo_cold"     # created by the job when missing (step 4)
cold_tablespace_location = "/var/lib/postgresql/cold"   # where it is created; "" = by hand
tables = ["mqtt_messages", "packet_receptions"]
max_partitions_per_cycle = 1          # moves per hourly cycle; the rest wait for the next one
cold_filesystem = "/mnt/meshinfo-cold"  # the overlay's read-only bind — enables the free-space
                                      # check, the hourly "is this really zfs/btrfs?" warning and
                                      # the guard against creating the tablespace anywhere else
min_free_mb = 2048                    # keep at least this much free on cold_filesystem after a move
```

The defaults shipped in `config.toml.sample` are the same except
`enabled = false` and `cold_filesystem = ""` (no free-space check, no
filesystem check, no creation guard). Restart `meshinfo` after editing; the
first cycle starts on the next maintenance tick.

## Operating the tiering job

### What is "cold"

A month is cold once `cold_after_months` whole calendar months have elapsed
since it closed. The **current month never moves** (it is still being written)
and the **previous month never moves either** (`cold_after_months` is clamped
to at least 1), so there is always a hot runway for the `--tablespace
pg_default` path to bring data back. The default is 1: everything but the
current and the previous month is cold. The dial only goes one way — a higher
value keeps more recent months hot and uncompressed (worth it when the last
few months are queried heavily and the hot filesystem is the faster one), at
the cost of compression ratio: in the cold-only layouts every extra hot
month is one more month of the archive stored at 1× instead of about 5×.

| today | `cold_after_months` | cutoff | cold (will move) | hot (stays) |
|---|---|---|---|---|
| 2026-11-04 | 1 (default) | 2026-10-01 | September 2026 and older | Oct, Nov |
| 2026-11-04 | 3 | 2026-08-01 | July 2026 and older | Aug, Sep, Oct, Nov |
| 2026-01-15 | 3 | 2025-10-01 | September 2025 and older | Oct, Nov, Dec, Jan |

"Today" is the database clock in UTC, so the boundary is the UTC month
rollover, matching the partition bounds.

### The scheduler

With `enabled = true` the app checks once an hour whether anything is due,
moves up to `max_partitions_per_cycle` cold months (oldest first, both tables
in order), and logs a one-line summary at INFO (WARNING if something was busy,
refused or failed). Any failure backs the job off for an hour. A fresh
multi-year archive therefore tiers itself at one partition an hour; raise
`max_partitions_per_cycle` or run the CLI with `--all` to go faster. A cycle
is skipped while the in-app backup is running (`pg_dump` holds a share lock
on every table for the whole dump, which the swap would have to wait out
while every query queues behind it — the backup likewise waits for a running
cycle) and while the startup node-id backfill is still working (its UPDATEs
go through the parent table and would deadlock with the swap); both simply
try again at the next hourly tick. Every cycle also looks up the filesystem
behind `cold_filesystem` in the container's `/proc/mounts`: when it is not
`zfs` or `btrfs` the cycle still runs, but logs `tiering: cold tablespace is
on ext4 (…) — months will move but not compress` once an hour until the
mount is fixed (the overlay bind is missing, or points somewhere else).

### The CLI

`scripts/tier_partitions.py` works whether or not the scheduler is enabled
and reads the same `[storage.tiering]` section (the `--config` default is the
container's `/app/config.toml`):

```
tier_partitions.py [--config PATH] [--dsn DSN] [--cold-after-months N] [--tablespace NAME] [--json] <command>

  status      every monthly partition of both tables: month, HOT/COLD by policy, tablespace(s),
              table/index/total bytes, "(partial!)" if split across tablespaces, estimated rows
  plan        what the next cycle would move (respects max_partitions_per_cycle; --all / --max N override)
  run         move; DRY RUN unless --apply
              [--apply] [--all] [--max N] [--partition NAME ...] [--keep-original] [--deep-verify]
```

```sh
docker compose exec meshinfo python scripts/tier_partitions.py status
docker compose exec meshinfo python scripts/tier_partitions.py plan --all
docker compose exec meshinfo python scripts/tier_partitions.py run --all                 # dry run everything
docker compose exec meshinfo python scripts/tier_partitions.py run --apply               # one month, for real
docker compose exec meshinfo python scripts/tier_partitions.py run --apply --all --deep-verify
docker compose exec meshinfo python scripts/tier_partitions.py run --apply --partition mqtt_messages_2026_03 --keep-original
docker compose exec meshinfo python scripts/tier_partitions.py --json status | jq .
```

- **Dry run by default.** `run` without `--apply` goes through every
  precondition, takes the same locks, counts the rows and reports what it
  would do, then rolls back — nothing is written. The banner says so.
- **`--all` / `--max N`** lift or change the per-cycle cap. `--partition
  NAME` (repeatable) targets specific partitions; eligibility is still
  enforced, so naming a hot month gets you a refusal, not a move.
- **`--deep-verify`** additionally compares a hash over every row's text on
  both copies before the swap (a full scan of each copy — slower, but the
  strongest check). The row-count check always runs.
- **`--keep-original`** leaves the detached original behind as
  `<partition>_tiering_old` for spot checks. Drop it yourself when done; it
  keeps its disk until then, and while it exists that month cannot be moved
  again in either direction (the job refuses with `leftover relation …
  exists`): `DROP TABLE <partition>_tiering_old;` first.
- **`--cold-after-months N`** and **`--tablespace NAME`** override the
  config for one invocation. `--tablespace pg_default` (or whatever
  `\db` shows as your database default) **moves months back**: any closed
  month is allowed in that direction, not only cold ones.
- **`--json`** prints one JSON document instead of the tables, for scripting.
- Exit codes: `0` success, `1` if any move was busy / failed / failed
  verification, `2` for usage and config errors (unknown partition name,
  tablespace that does not exist).

### What a move does, and what it locks

Each partition is one transaction:

1. `LOCK TABLE <partition> IN SHARE MODE` with a 5 s `lock_timeout`. SHARE
   blocks writers to *that partition only* — a closed month has none — and
   never blocks readers. If anything holds a conflicting lock (an autovacuum
   pass, a stray `ALTER`), the job does not queue behind it: it reports
   **busy** and the cycle stops; it simply tries again next hour.
2. `mqtt_messages` only: refuse if the legacy node-id backfill still has rows
   to process in this month (`from_node_id IS NULL` with a JSON payload), so a
   month is never frozen half-backfilled.
3. Copy: `CREATE TABLE … (LIKE partition …) TABLESPACE meshinfo_cold`, `INSERT
   … SELECT`, recreate every index (including the primary key) on the cold
   tablespace, add a transient `CHECK` on the month's `created_at` range.
   **Readers continue throughout**, ingest into other months continues, and
   the original is untouched — this is the long part, and it holds only the
   SHARE lock.
4. Verify: row count of the original == rows copied == row count of the
   copy; with `--deep-verify`, also the row-text digest. A mismatch rolls the
   whole transaction back (**verify-failed**, cycle stops).
5. Swap: detach the original, rename it and its indexes aside, rename the
   copy and its indexes to the original names, attach the copy using the
   original partition bound (the range `CHECK` lets Postgres skip the
   validation scan of the copy; the DEFAULT partition is checked too, under
   the same lock, which is why the job refuses to move anything while that
   partition holds rows — it is empty as long as the monthly partitions keep
   being created ahead of time), drop the `CHECK`, drop the original (unless
   `--keep-original`). **This step is metadata-only and takes milliseconds,
   but it needs a brief ACCESS EXCLUSIVE lock on the parent table**, and
   while that request waits for the queries already running, every new query
   and insert on `mqtt_messages` / `packet_receptions` queues behind it. The
   job therefore waits at most **2.5 s** per attempt — `lock_timeout`, and
   `statement_timeout` on the `DETACH`, which takes that lock on the parent,
   then on the DEFAULT partition, then on the month, so that one timeout
   covers all three — and rolls the attempt back to a savepoint if a query in
   flight is still running then: a long query — a payload `ILIKE` over a
   month — can delay a move, but no request ever waits behind the swap for
   longer than those 2.5 s plus the swap itself. It retries up to 10 times
   with growing pauses (1, 2, 4, 8, 16, then 20 s, plus up to a second of
   jitter), skips an attempt outright while `pg_locks` shows a transaction
   that has already held the parent, the DEFAULT partition or the month for
   longer than the timeout (it would not be granted anyway), and gives the
   copy up at once when a writer through the parent — the node-id backfill's
   `UPDATE` — is queued behind its SHARE lock: the two would deadlock, and
   every second of waiting would only keep that writer blocked. If all ten
   attempts fail — about two and a half minutes — the whole transaction, copy
   included, rolls back and the result is **busy**; the next hourly cycle
   starts over. Nothing is ever left half-swapped.
6. After commit: `VACUUM (FREEZE, ANALYZE)` the new partition while its pages
   are still cached (SHARE UPDATE EXCLUSIVE only — readers and ingest
   continue). One sequential pass sets hint bits, the visibility map (so
   index-only scans on the month are fast again immediately) and all-frozen,
   so no later reader ever dirties a cold page and anti-wraparound vacuums
   never rewrite the month. This matters on a copy-on-write filesystem,
   where every later 8 KiB rewrite would come back as a separate short
   extent: in the lab a move made under heavy concurrent load already came
   out at 3.4–4.1× instead of 4.6× because its pages were written back
   piecemeal (benchmark README, section 4; `btrfs filesystem defragment -r
   -czstd -L 9` repairs it), and the freeze keeps readers from adding to
   that afterwards. The step is best effort — a lock
   timeout (30 s) or error degrades to a plain `ANALYZE` with a warning, and
   autovacuum's insert trigger catches up later; `vacuumed` in the JSON
   result says which happened.

Every index is re-attached to the parent's partitioned index automatically on
attach, the row trigger is cloned, and inserts through the parent route into
the moved month exactly as before. The partition keeps its name, so nothing
that refers to `mqtt_messages_2026_07` notices.

**Worst case for the API.** One swap attempt can hold new requests on the
parent for the 2.5 s timeout plus the swap's own hold, which lasts from the
`DETACH` to the `COMMIT`: a few milliseconds of catalog work and the commit's
WAL flush, tens of milliseconds on the default `wal_level = replica` (about
0.8 s under `wal_level = minimal`, which fsyncs the rebuilt partition's files
at commit instead of logging the copy). The pause before the next attempt
lets that queue drain, so the stall is never longer than that, however long
the query the swap is waiting for; it assumes empty DEFAULT partitions,
which the job enforces (step 5). A move whose every attempt collides with
such queries is given up as busy after ten attempts (about 2.5 minutes, the
copy's I/O being the only cost) and retried an hour later; ingest inserts
queue the same way as queries and resume unharmed (the app pool's 10 s
command timeout is never reached).
<!-- STALL:START -->
Measured in the lab (`benchmarks/zfs-tiering-2026-11-04/lab/lab-stall.sh`:
six readers, two writers, plus a client that holds the parent for 4–7 s
every 12 s with a payload `ILIKE` over a month, while all six months move;
PostgreSQL's default `wal_level = replica`): the three attempts that would
have met such a scan were postponed by the probe instead, none hit the
timeout, and the longest any ordinary request waited behind a swap was
**0.8 s** — the ACCESS EXCLUSIVE request waiting for node-page queries in
flight. The longest request of the run, 1.87 s, was one such node page that
then ran for another second under the copy's I/O; nothing exceeded 3 s in
14,319 requests, with 0 errors. The swap's own hold, measured alone, is
33 ms for a 263 MB month (27 ms on the way back). An earlier measurement,
under `wal_level = minimal` and before the probe was fixed to use the wall
clock, had one collision each way: 2.51 s under the shipped timeout against
5.7 s under the previous 20 s one. Details in the benchmark README, section
4b.
<!-- STALL:END -->

**Disk during a move:** both copies exist until the commit — the original on
hot, the new one on cold — and the copy is WAL-logged, so expect roughly the
partition's size in WAL churn on the hot dataset as well. Hot space is
released when the original is dropped at commit (immediately on ZFS, unless a
snapshot still references the blocks).

### Results and refusals

Every partition the job touches reports one status:

| status | meaning | cycle |
|---|---|---|
| `moved` | swapped and verified | continues |
| `dry-run` | would have moved; nothing written | continues |
| `skipped` | already entirely on the target tablespace | continues |
| `refused` | a precondition failed; nothing changed | continues with the next partition |
| `busy` | a lock could not be taken within its timeout; nothing changed | stops, retries next hour |
| `verify-failed` | count or digest mismatch; rolled back | stops |
| `failed` | any other error; rolled back, logged with traceback | stops |

A move is **refused** when the partition is not a monthly one (the `_default`
partition, for example), when the month is not closed yet (the current
month), when it is not yet cold under the policy — which always includes the
previous month — for a move *to* the cold tablespace (moving back to the
default tablespace is allowed for any closed month), when the target
tablespace does not exist, when the node-id backfill is still pending for
that month, when a `<partition>_tiering_old` left by `--keep-original` still
exists, or when the free-space guard trips.

**Free-space guard.** With `cold_filesystem` set, a move to the cold
tablespace is refused unless the filesystem at that path has at least the
partition's total size (table + indexes) plus `min_free_mb` free. It
deliberately **assumes zero compression** — the real footprint will be a
fraction of that — so a refusal means the dataset is genuinely tight and it
is time to look at `zfs list`. The path is checked from inside the `meshinfo`
container, which is why the overlay binds the cold dataset there read-only;
an unreadable or missing path is itself a refusal, not a pass.

### Moving months back

Bringing a month back onto the hot dataset — before a schema change you want
to run at 16K, or because you are dismantling tiering — is the same move in
the other direction:

```sh
docker compose exec meshinfo python scripts/tier_partitions.py --tablespace pg_default \
  run --apply --partition mqtt_messages_2026_07 --partition packet_receptions_2026_07
docker compose exec meshinfo python scripts/tier_partitions.py --tablespace pg_default run --apply --all
```

The target must be the database's default tablespace *by name* — `pg_default`
unless the database was created on another one (check with `\db`, or `SELECT
spcname FROM pg_tablespace WHERE oid = (SELECT dattablespace FROM pg_database
WHERE datname = current_database())`); any other name counts as a cold target
and gets the cold-month rule. Months moved back become eligible again on the
next hourly cycle while the scheduler is enabled, so set `enabled = false`
(and restart `meshinfo`) first if they are meant to stay.

## Backups and restores

Dumps keep working, with one rule: **restore without tablespace
assignments.** A plain restore into a cluster that has no `meshinfo_cold`
tablespace fails on the first cold partition with `tablespace "meshinfo_cold"
does not exist`, and a single-database dump never contains the `CREATE
TABLESPACE` statement itself.

- `scripts/migrate-postgres.sh` dumps with `pg_dump --no-tablespaces`
  already, so its plain-SQL dumps restore anywhere.
- The in-app scheduled backups and `scripts/backup_db.sh` produce custom
  format dumps (`-Fc`); for those the flag goes on the restore side:
  `pg_restore --no-tablespaces -U postgres -d meshinfo backups/meshinfo-pg-….dump`.

Either way the restore lands every partition on `pg_default`. That is by
design: once the stack is back up and the tablespace exists again, the tiering
job re-tiers the cold months on its hourly cadence (one per cycle by default),
or run `tier_partitions.py run --apply --all` to do it in one go.

**ZFS snapshots** are a cheap second layer underneath the logical dumps:
`zfs snapshot -r tank/meshinfo@nightly` is atomic across both datasets, which
makes it a crash-consistent image of the cluster *and* its tablespace that
Postgres recovers from like a power loss. Always snapshot and roll back the
two datasets **together** — the catalog on the hot dataset references files on
the cold one, and a one-sided rollback leaves the database inconsistent.
Snapshots are not a substitute for `pg_dump`: they live on the same pool.
In the cold-only layouts the catalog lives on the Docker volume and only the
tablespace on the compressed filesystem, so a snapshot of the cold filesystem
alone (ZFS or btrfs) is never a consistent image of the database; the logical
dumps are the backup there.

## Upgrades

**MeshInfo releases.** `git pull && docker compose pull && docker compose
down && docker compose up -d` as usual — with the overlay on every command,
which is what `COMPOSE_FILE` in `.env` is for. The cold dataset must be
mounted at `/var/lib/postgresql/cold` for every new `postgres` container,
and the failure mode when it is not is **silent**: Postgres starts anyway
(it only logs `could not open directory "pg_tblspc/…"`), and every query
that touches a cold month then fails with `could not open file`. Without
the overlay at all, a full-ZFS stack mounts the named volume instead and will
happily initialise an empty cluster there; a cold-only stack keeps its
cluster but every cold month fails the same way. Treat `COMPOSE_FILE` in
`.env` as mandatory once tiering has moved data, and after every restart
check that the binds are in place and a cold month answers:

```sh
docker compose config | grep -A2 'type: bind' | grep 'target: /var/lib/postgresql'
docker compose exec postgres psql -U postgres -d meshinfo -c '\db' \
  -c 'SELECT count(*) FROM mqtt_messages_2026_03;'   # any month status shows as COLD
```

If the bind is there but the month does not answer, the cold filesystem was
not mounted when the container started: mount it and `docker compose
restart postgres meshinfo` (step 4).

**PostgreSQL major versions.** The tablespace location is a path *inside the
container* and stays the same across versions; Postgres keeps each major
version's files in its own `PG_<major>_…` subdirectory under it, so a new
version can neither see nor damage the old one's data. `migrate-postgres.sh`
keeps working for installs that still use the named volume — the cold-only
layouts included: it mounts the cold directory into its temporary dump
container so that `pg_dump` can read the cold months, its dump is taken with
`--no-tablespaces`, and the restore lands every month on `pg_default` for
the job to re-tier — the whole archive, uncompressed, on the Docker volume,
so the script first checks that the volume's filesystem has room for
`pg_database_size` and refuses otherwise. The old version's `PG_<old>_…`
subdirectory stays behind in the cold directory (PostgreSQL only refuses a
location that holds one for the same major version); until it is removed it
counts against the free-space guard, so `sudo rm -rf
/srv/meshinfo/pgcold/PG_<old>_*` once the new cluster is verified (and the
volume backup, if kept, is no longer needed — its cold months live there).
On a full-ZFS install, with the cluster bind-mounted at `/var/lib/postgresql`,
the script refuses to run (it detects that bind in the compose config, because its
named-volume logic would otherwise migrate a stale leftover volume), so do
the same steps by hand, with the snapshot as the rollback point; remove the
old named volume (`docker volume rm <project>_meshinfo_pgdata`) once the
switch is verified so nothing stale is left behind:

```sh
scripts/maintenance.sh on
docker compose down
sudo zfs snapshot -r tank/meshinfo@pre-upgrade                       # rollback point for BOTH datasets

# dump with a temporary container of the OLD version; both datasets must be mounted
# or pg_dump cannot read the cold months (pre-18 images mount at /var/lib/postgresql/data)
docker run -d --name meshinfo-pg-migrate \
  -v /tank/meshinfo/pgdata:/var/lib/postgresql \
  -v /tank/meshinfo/pgcold:/var/lib/postgresql/cold \
  -e POSTGRES_PASSWORD=password postgres:<old-major>
until docker exec meshinfo-pg-migrate pg_isready -U postgres -d meshinfo; do sleep 1; done
docker exec -e PGPASSWORD=password meshinfo-pg-migrate \
  pg_dump -U postgres -d meshinfo --no-owner --no-privileges --no-tablespaces \
  | gzip > backups/meshinfo-pg-pre-upgrade.sql.gz
gzip -t backups/meshinfo-pg-pre-upgrade.sql.gz && docker rm -f meshinfo-pg-migrate

sudo find /tank/meshinfo/pgdata -mindepth 1 -delete                  # empty both datasets; the
sudo find /tank/meshinfo/pgcold -mindepth 1 -delete                  # snapshot still holds the old bits

docker compose up -d --wait postgres                                 # new version initialises fresh; --wait = healthy
docker compose exec postgres psql -U postgres -d meshinfo \
  -c "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold';"   # optional: the job would create it
gzip -dc backups/meshinfo-pg-pre-upgrade.sql.gz \
  | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d meshinfo -q
docker compose up -d
scripts/maintenance.sh off
# verify, then let the job re-tier (or: tier_partitions.py run --apply --all); finally
sudo zfs destroy -r tank/meshinfo@pre-upgrade
```

## Monitoring

```sh
# compression actually achieved, per dataset (logicalused = what Postgres thinks it wrote)
zfs list -o name,used,logicalused,compressratio,recordsize,compression,avail -r tank/meshinfo
# the same for a btrfs cold directory (package `compsize`: disk usage vs uncompressed, per codec)
sudo compsize -x /srv/meshinfo/pgcold

# where every month lives and how big it is on the Postgres side
docker compose exec meshinfo python scripts/tier_partitions.py status
docker compose exec meshinfo python scripts/tier_partitions.py --json status | jq '.[] | select(.partial)'

# tablespace totals as Postgres sees them (pre-compression bytes)
docker compose exec postgres psql -U postgres -d meshinfo \
  -c "SELECT spcname, pg_size_pretty(pg_tablespace_size(oid)) FROM pg_tablespace ORDER BY 1;"
```

`status` marks a partition `(partial!)` when its table and indexes are split
across tablespaces — that only happens if something outside the job moved
objects, since a move is all-or-nothing; running the job on that month fixes
it. The hourly cycle logs `tiering: …` at INFO; a WARNING there means busy or
refused (the message says which, and why — `swap of … postponed` is a long
holder of the parent, `given up` a writer queued behind the copy, `hit
lock_timeout` / `hit statement_timeout` an attempt that met a query in
flight), a tablespace that could not be created (step 4 lists the reasons),
or `cold tablespace is on … — months will move but not compress`, which says
the path in `cold_filesystem` is not on a ZFS/btrfs dataset in this
container (and keeps the job from creating the tablespace there). `zfs get
compressratio` on the cold dataset — `compsize` on a btrfs cold directory —
is the number to watch over time: expect about 21–22 % (≈ 4.6×) on the
months the job wrote (the 5.3× in "Choosing a layout" is against their
pre-rebuild size), and watch for a drop from your own first reading: it
should hold steady as months are added, and a drop usually means a month was
written with different properties (check `zfs get recordsize,compression`,
or the mount options on btrfs) — or, on btrfs, that a move ran under heavy
load and left short extents (3.4–4.1×), which `btrfs filesystem defragment
-r -czstd -L 9` repairs.

## Why not …

- **`ALTER TABLE … SET TABLESPACE`.** It takes an ACCESS EXCLUSIVE lock on
  the partition for the *entire* rewrite — minutes to hours for a multi-GB
  month — and every query through the parent that cannot prune that month
  waits with it. The job's copy-then-swap holds only SHARE during the copy
  and ACCESS EXCLUSIVE for the milliseconds of the swap.
- **Citus columnar.** Real compression of the heap, but indexes and
  per-stripe metadata stay uncompressed, filtered queries (anything the Logs
  page does — by node, by topic, by packet id) regressed 10–90× in testing
  because a column store has to scan stripes, and it needs a patched Postgres
  build instead of the stock `postgres:18` image.
- **TimescaleDB / Hydra.** Same story with their own extension builds: not
  stock Postgres, and compressed chunks are read-mostly with their own rules
  for indexes and updates. ZFS gives most of the win with zero schema impact.
- **btrfs under the whole cluster.** Fine for the write-once cold months,
  not for a live cluster that rewrites pages in place — see "Choosing a
  layout".
- **One dataset only.** Perfectly fine, and the first thing to do. Cold
  months just leave compression on the table, because the ratio at 16K is
  bounded by the 4 KiB rounding described above and the hot codec is chosen
  for write cost, not ratio. The second dataset exists so the bulk of the
  archive can sit at 128K / zstd-9 without taxing live writes.
- **Keeping old months as `pg_dump` files.** Smaller still, but no longer
  queryable — the Logs page, node histories and the API all stop at the cut.

## Measurements

The numbers below come from the benchmark run on a copy of a production
archive with `scripts/zfs_estimate.py` (run it against your own database for
an estimate before committing to a layout — see its `--help`). They are
filled in by the release process; an empty table means this build has not
been benchmarked yet.

<!-- BENCH:START -->

Lab: PostgreSQL 18.4, a synthetic six-month archive calibrated to production
(1.5 M canonical packets at 753 B per heap row, 6.25 M receptions, 3.12 GB
including indexes), `scripts/synth_history.py --seed 1`. Full write-up, raw
data and reproduction scripts: [`benchmarks/zfs-tiering-2026-11-04/`](benchmarks/zfs-tiering-2026-11-04/README.md).

### Whole-database compression by codec and record size

Measured on btrfs (`compress-force`, 128 KiB extents ≈ a 128K ZFS record) with
`compsize`, and modelled for ZFS record sizes with `scripts/zfs_estimate.py`
over the real relation files (compressed only when it saves ≥ 12.5 %, rounded
up to 4 KiB, zero records are holes):

| codec | recordsize | logical | physical | ratio | notes |
|---|---|---:|---:|---:|---|
| zstd-3 | 128K (btrfs `zstd:3`) | 3.12 GB | 622 MB | **5.02×** | measured; heap 4.75×, B-tree 5.20×, trigram GIN 7.82× |
| zstd-9 | 128K (btrfs `zstd:9`) | 3.12 GB | 593 MB | **5.27×** | measured; heap 4.82×, B-tree 5.81×, GIN 8.22× |
| lzo | 128K (btrfs `lzo`) | 3.12 GB | 1.25 GB | 2.50× | measured |
| zstd-3 | 8K / 16K / 32K / 64K / 128K | 3.15 GB | | 1.99× / 2.98× / 3.52× / 4.36× / 5.01× | ZFS model; 128K reproduces the btrfs figure |
| zstd-9 | 8K / 16K / 32K / 64K / 128K | 3.15 GB | | 1.99× / 2.99× / 4.26× / 5.04× / 5.26× | ZFS model |
| lz4 | 16K / 128K | 3.15 GB | | 2.19× / 3.28× | ZFS model |
| gzip-6 | 16K / 128K | 3.15 GB | | 2.97× / 4.92× | ZFS model |

Record size dominates: an 8 KiB record (one PostgreSQL page) can only ever
shrink to 4 KiB, so every codec sits at 2× there; at 16 KiB the 4 KiB rounding
still decides (zstd-3 and zstd-9 are within 1 % of each other, hence zstd-3 for
the hot dataset); at 128 KiB the codec gets sixteen pages of similar JSON and
sorted keys to work with. Warm query latency is identical to ext4; cold reads
pay 10–40 ms per page query for extent decompression; plans do not change.

### Tiered projection (hot 16K/zstd-3 + cold 128K/zstd-9)

Production inventory of 29.08 GB (`pg_database_size` on 2026-11-01 — heap
and indexes together), `cold_after_months = 1`, the lab's heap ratios (hot
2.92×, cold 4.82×) applied to the whole size; the heap is the class that
compresses least (B-trees 3.07× / 5.81×, GIN 3.00× / 8.19× in the lab), so
this errs on the large side. The hot share is two months of the history, so
the gain grows as history accumulates. "Conservative" adds 25 % to the
compressed size for payload entropy the synthetic data cannot reproduce. The
cold-only rows (`docker-compose.cold.yml`, ZFS or btrfs) leave the hot share
uncompressed on the Docker volume.

| layout | 12 months of history | 18 months | 24 months |
|---|---:|---:|---:|
| one 16K/zstd-3 dataset | 9.95 GB | 9.95 GB | 9.95 GB |
| … conservative | 12.4 GB | 12.4 GB | 12.4 GB |
| tiered (full ZFS) | 6.69 GB | 6.47 GB | 6.36 GB |
| tiered, conservative | 8.36 GB | 8.08 GB | 7.95 GB |
| cold-only (hot untouched, cold 128K/zstd-9) | 9.87 GB | 8.59 GB | 7.95 GB |
| cold-only, conservative | 12.3 GB | 10.7 GB | 9.94 GB |

The reference figures for the same inventory were 9.6 GB (one dataset) and
5.9 GB (tiered); the Citus-columnar branch reached 21.2 GB with filtered-query
regressions of 10–90×. `scripts/zfs_estimate.py` on the live volume is the
authoritative figure for an installation.

### Move timing

`tier_partitions.py run --apply --all --deep-verify` over the six months
(12 partitions, 7.75 M rows, 2.69 GB after the rebuild), onto the zstd-9
tablespace:

| partition | rows | bytes before → after | quiet (s) | under load (s) | swap attempts |
|---|---:|---:|---:|---:|---:|
| `mqtt_messages_2026_06` (190 MB heap, 9 indexes) | 250,000 | 263 MB → 263 MB | 3.7 | 5.5 | 1 |
| `packet_receptions_2026_06` (2 indexes) | 1,041,096 | 185 MB → 185 MB | 2.5 | 4.6 | 1 |
| all twelve | 7,749,000 | 2.69 GB → 2.69 GB | 38 | 62 | 1 each |

"Under load" = 6 readers running the Logs page, node page, topic filter,
cold-month page, permalink and stats queries plus 2 writers ingesting into the
current month for the whole run: 13,233 requests, **0 errors**, p50 1.5 ms,
p99 193 ms, maxima of 1–1.3 s at the twelve swaps (the ACCESS EXCLUSIVE wait
for readers in flight; three earlier runs: 62–80 s, p99 58–393 ms, maxima
1.1–3.0 s, 0 errors every time). Whole-row digests of every month were
identical before and after, `plan` reported nothing left, and `--tablespace
pg_default` moved everything back (55 s) with the digests identical again. The first
rebuild of freshly ingested months packs the indexes by a third (3.11 GB →
2.69 GB logical); on a compressing filesystem that is a logical gain only — the
dense indexes compress less per byte and the on-disk size stays ~588 MB.

The swap stall bound (benchmark README, section 4b): with a client holding the
parent for 4–7 s every 12 s on top of the same load and the default
`wal_level = replica`, the probe postponed the three attempts that would have
met a scan, no attempt timed out, the longest wait behind a swap was 0.8 s
and the longest request 1.87 s (0 of 14,319 over 3 s, 0 errors); the swap's
own hold is 33 ms for a 263 MB month. An earlier measurement under
`wal_level = minimal` gave 2.51 s under the shipped 2.5 s timeout against
5.7 s under the previous 20 s one.

<!-- BENCH:END -->
