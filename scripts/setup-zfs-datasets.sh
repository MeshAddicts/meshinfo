#!/usr/bin/env bash
#
# setup-zfs-datasets.sh — create the ZFS dataset(s) MeshInfo's tiered cold
# storage expects (see ZFS.md), with the properties the benchmarks were run at.
#
# Full ZFS layout (the cluster itself on ZFS), two datasets under one parent:
#   <parent>/pgdata   hot  — cluster, WAL, live months
#                     recordsize=16K  compression=zstd-3  logbias=latency
#   <parent>/pgcold   cold — closed months (the meshinfo_cold tablespace)
#                     recordsize=128K compression=zstd-9  logbias=throughput
#
# Cold-only layout (--cold-only; the cluster stays on its Docker volume):
#   <dataset>         cold — the same cold properties, mounted at <mountpoint>
#
# Every dataset gets atime=off and xattr=sa, and its mountpoint is chowned to
# the postgres user of the official image (999:999). Idempotent: datasets that
# already exist are left in place and only their properties are (re)applied,
# which is a no-op when nothing changed. Changing recordsize/compression on an
# existing dataset affects newly written blocks only — see ZFS.md.
#
# Usage:
#   sudo scripts/setup-zfs-datasets.sh <parent-dataset> [--uid 999] [--gid 999] [--dry-run]
#   sudo scripts/setup-zfs-datasets.sh --cold-only <dataset> <mountpoint> [--uid 999] [--gid 999] [--dry-run]
#
#   sudo scripts/setup-zfs-datasets.sh tank/meshinfo              # creates tank/meshinfo if missing
#   scripts/setup-zfs-datasets.sh tank/meshinfo --dry-run         # print the commands, touch nothing
#   sudo scripts/setup-zfs-datasets.sh --cold-only tank/meshinfo-cold /srv/meshinfo/pgcold
#
# Dataset arguments are ZFS dataset names (pool/path), not mountpoints, and
# <dataset> in cold-only mode is a dataset below a pool, never the pool
# itself (its properties would be inherited by every child). In the full
# layout the datasets mount at the pool's default location (/<dataset-name>)
# unless the pool is configured otherwise — the script prints where they
# ended up; pass those paths to docker-compose.zfs.yml via MESHINFO_ZFS_HOT /
# MESHINFO_ZFS_COLD. In the cold-only layout the dataset is mounted at the
# <mountpoint> you give; pass that path to docker-compose.cold.yml via
# MESHINFO_PGCOLD_DIR.
#
set -euo pipefail

HOT_PROPS=(recordsize=16K compression=zstd-3 atime=off xattr=sa logbias=latency)
COLD_PROPS=(recordsize=128K compression=zstd-9 atime=off xattr=sa logbias=throughput)

COLD_ONLY=0
POSITIONAL=()
OWNER_UID=999
OWNER_GID=999
DRY_RUN=0

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
usage() {
  cat <<EOF
Usage: $(basename "$0") <parent-dataset> [--uid UID] [--gid GID] [--dry-run]
       $(basename "$0") --cold-only <dataset> <mountpoint> [--uid UID] [--gid GID] [--dry-run]

Full ZFS layout: creates <parent-dataset>/pgdata (hot) and <parent-dataset>/pgcold
(cold) with the recordsize/compression properties MeshInfo's tiered storage
expects. Cold-only layout (--cold-only): creates just <dataset> — a dataset
below a pool (pool/name), never the pool itself — with the cold properties and
mounts it at <mountpoint>. Either way the mountpoints are chowned to UID:GID
(default 999:999, the postgres user of the official postgres image). Safe to
re-run.

  --cold-only  one cold dataset at the given mountpoint; the cluster stays on
               its Docker volume (docker-compose.cold.yml)
  --uid UID    owner of the mountpoints (default 999)
  --gid GID    group of the mountpoints (default 999)
  --dry-run    print the zfs/chown commands instead of running them
               (works without zfs installed)
EOF
}

# --- Arguments ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --cold-only) COLD_ONLY=1; shift ;;
    --uid)     [ $# -ge 2 ] || { err "--uid needs a value"; exit 2; }; OWNER_UID="$2"; shift 2 ;;
    --uid=*)   OWNER_UID="${1#--uid=}"; shift ;;
    --gid)     [ $# -ge 2 ] || { err "--gid needs a value"; exit 2; }; OWNER_GID="$2"; shift 2 ;;
    --gid=*)   OWNER_GID="${1#--gid=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        err "unknown option: $1"; usage >&2; exit 2 ;;
    *)         POSITIONAL+=("$1"); shift ;;
  esac
done

if [ "$COLD_ONLY" -eq 1 ]; then
  if [ "${#POSITIONAL[@]}" -ne 2 ]; then
    err "--cold-only needs exactly two arguments: <dataset> <mountpoint>"
    usage >&2
    exit 2
  fi
  COLD="${POSITIONAL[0]}"
  COLD_MP="${POSITIONAL[1]}"
  HOT=""
  case "$COLD" in
    /*)  err "'$COLD' looks like a mountpoint — the first argument is the dataset name (e.g. tank/meshinfo-cold)"; exit 2 ;;
    */)  err "'$COLD' must not end with '/'"; exit 2 ;;
    */*) ;;
    *)   err "'$COLD' is a pool, not a dataset on it — name one (e.g. ${COLD}/meshinfo-cold): the pool's root dataset passes its mountpoint and compression on to every dataset that inherits them"; exit 2 ;;
  esac
  case "$COLD_MP" in
    /)   err "the mountpoint must not be /"; exit 2 ;;
    /*)  ;;
    *)   err "'$COLD_MP' is not an absolute path — the second argument is the mountpoint (e.g. /srv/meshinfo/pgcold)"; exit 2 ;;
  esac
else
  if [ "${#POSITIONAL[@]}" -ne 1 ]; then
    if [ "${#POSITIONAL[@]}" -gt 1 ]; then
      err "unexpected argument: ${POSITIONAL[1]} (parent dataset already given as '${POSITIONAL[0]}')"
    fi
    usage >&2
    exit 2
  fi
  PARENT="${POSITIONAL[0]}"
  case "$PARENT" in
    /*)  err "'$PARENT' looks like a mountpoint — pass the dataset name (e.g. tank/meshinfo)"; exit 2 ;;
    */)  err "'$PARENT' must not end with '/'"; exit 2 ;;
  esac
  HOT="${PARENT}/pgdata"
  COLD="${PARENT}/pgcold"
  COLD_MP=""
fi
for v in "$OWNER_UID" "$OWNER_GID"; do
  case "$v" in
    ''|*[!0-9]*) err "--uid/--gid must be numeric (got '$v')"; exit 2 ;;
  esac
done

# --- Pre-flight --------------------------------------------------------------
HAVE_ZFS=0
command -v zfs >/dev/null 2>&1 && HAVE_ZFS=1

if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$HAVE_ZFS" -eq 0 ]; then
    err "zfs not found on PATH — run this on the ZFS host (or use --dry-run to preview)."
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    err "zfs create/set and chown need root — re-run with sudo."
    exit 1
  fi
else
  log "DRY RUN — printing commands only, nothing is changed."
  [ "$HAVE_ZFS" -eq 1 ] || warn "zfs is not on PATH; existence checks are skipped and mountpoints are assumed to be /<dataset>."
fi

# run CMD...: execute, or print with a '+' prefix under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

# dataset_exists NAME: 0 if the dataset exists, 1 if not, 2 if unknown (no zfs).
dataset_exists() {
  [ "$HAVE_ZFS" -eq 1 ] || return 2
  zfs list -H -o name "$1" >/dev/null 2>&1
}

# mountpoint_of NAME: the dataset's mountpoint, or the ZFS default when unknown.
mountpoint_of() {
  local mp=""
  if [ "$HAVE_ZFS" -eq 1 ]; then
    mp="$(zfs get -H -o value mountpoint "$1" 2>/dev/null || true)"
  fi
  case "$mp" in
    /*) printf '%s\n' "$mp" ;;
    *)  printf '/%s\n' "$1" ;;      # default layout, or dataset not created yet (dry run)
  esac
}

# ensure_dataset NAME PROP...: create when missing, then (re)apply every property.
ensure_dataset() {
  local name="$1"; shift
  local rc=0
  dataset_exists "$name" || rc=$?
  case "$rc" in
    0) log "Dataset $name exists — leaving it in place, applying properties." ;;
    1) log "Creating dataset $name"
       run zfs create -p "$name" ;;
    *) log "Would create dataset $name (if it does not exist yet)"
       run zfs create -p "$name" ;;
  esac
  local prop
  for prop in "$@"; do
    run zfs set "$prop" "$name"
  done
}

# --- Datasets ----------------------------------------------------------------
# `zfs create -p` also creates a missing parent (with inherited properties).
if [ "$COLD_ONLY" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    # Never mount over something: a directory that already holds files (a
    # tablespace on a plain directory, a btrfs cold filesystem being switched
    # to ZFS) would be hidden underneath the dataset — overlay=on is the Linux
    # default — unless it is this very dataset already mounted there.
    if [ -d "$COLD_MP" ] && [ -n "$(ls -A -- "$COLD_MP")" ] \
       && [ "$(findmnt -rn -M "$COLD_MP" -o SOURCE 2>/dev/null || true)" != "$COLD" ]; then
      err "$COLD_MP is not empty and is not $COLD mounted there — mounting the dataset over it would hide its contents; roll the months back (tier_partitions.py --tablespace pg_default run --apply --all) or move them aside first."
      exit 1
    fi
  fi
  # The mountpoint is a property like the others: setting it on an existing
  # dataset moves the mount, which is what asking for that mountpoint means.
  ensure_dataset "$COLD" "mountpoint=${COLD_MP}" "${COLD_PROPS[@]}"
  if [ "$DRY_RUN" -eq 0 ]; then
    COLD_MP="$(mountpoint_of "$COLD")"
    # `zfs set mountpoint=` succeeds without mounting when canmount=noauto/off
    # or an encryption key is not loaded; chowning the bare directory then
    # would be exactly the mistake ZFS.md step 4 warns about.
    if [ "$(zfs get -H -o value mounted "$COLD" 2>/dev/null || true)" != yes ] \
       || [ "$(findmnt -rn -M "$COLD_MP" -o SOURCE,FSTYPE 2>/dev/null || true)" != "$COLD zfs" ]; then
      err "$COLD is not mounted at $COLD_MP (canmount=noauto/off, or an encryption key not loaded?) — zfs mount $COLD, then re-run."
      exit 1
    fi
  fi
  MOUNTPOINTS=("$COLD_MP")
else
  ensure_dataset "$HOT"  "${HOT_PROPS[@]}"
  ensure_dataset "$COLD" "${COLD_PROPS[@]}"
  HOT_MP="$(mountpoint_of "$HOT")"
  COLD_MP="$(mountpoint_of "$COLD")"
  MOUNTPOINTS=("$HOT_MP" "$COLD_MP")
fi

# Ownership of the mountpoints only (not recursive): the postgres image runs
# as 999:999 and must own /var/lib/postgresql and the tablespace directory.
# Data copied in later (rsync -a from the old volume) carries its own owner.
log "Setting ownership ${OWNER_UID}:${OWNER_GID} on the mountpoints"
run chown "${OWNER_UID}:${OWNER_GID}" "${MOUNTPOINTS[@]}"
run chmod 0750 "${MOUNTPOINTS[@]}"

# --- Summary -----------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "$HAVE_ZFS" -eq 1 ]; then
  echo
  if [ "$COLD_ONLY" -eq 1 ]; then
    zfs list -o name,used,avail,recordsize,compression,atime,xattr,logbias,mountpoint "$COLD"
  else
    zfs list -o name,used,avail,recordsize,compression,atime,xattr,logbias,mountpoint "$HOT" "$COLD"
  fi
fi

if [ "$COLD_ONLY" -eq 1 ]; then
  cat <<EOF

Dataset ready:
  cold : ${COLD}  ->  ${COLD_MP}

Next steps (details in ZFS.md, "Cold-only setup"):
  1. Put the mountpoint and the overlay in .env next to the compose files:
       COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
       MESHINFO_PGCOLD_DIR=${COLD_MP}
     (list docker-compose.override.yml before the overlay if you use one — naming
     the files switches off its automatic loading)
  2. Restart the stack with the overlay — nothing to migrate, the cluster stays
     on its Docker volume:
       docker compose config | grep -B2 'target: /var/lib/postgresql/cold'
       docker compose up -d
  3. Enable the job in config.toml ([storage.tiering] enabled = true,
     cold_filesystem = "/mnt/meshinfo-cold") and restart meshinfo: its first
     cycle creates the meshinfo_cold tablespace at /var/lib/postgresql/cold
     (ZFS.md step 4). To manage it by hand instead, set
     cold_tablespace_location = "" and run once:
       docker compose exec postgres psql -U postgres -d meshinfo \\
         -c "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
EOF
else
  cat <<EOF

Datasets ready:
  hot  : ${HOT}  ->  ${HOT_MP}
  cold : ${COLD}  ->  ${COLD_MP}

Next steps (details in ZFS.md):
  1. If the mountpoints differ from the overlay defaults (/tank/meshinfo/pgdata,
     /tank/meshinfo/pgcold), put them in .env next to the compose files:
       MESHINFO_ZFS_HOT=${HOT_MP}
       MESHINFO_ZFS_COLD=${COLD_MP}
     (with COMPOSE_FILE=docker-compose.yml:docker-compose.zfs.yml; list
     docker-compose.override.yml before the overlay if you use one — naming the
     files switches off its automatic loading)
  2. Existing install: stop the stack and copy the current Docker volume onto the
     hot dataset (ZFS.md, "Switching an existing Docker volume").
  3. Start with the overlay:
       docker compose -f docker-compose.yml -f docker-compose.zfs.yml up -d
  4. Enable the job in config.toml ([storage.tiering] enabled = true,
     cold_filesystem = "/mnt/meshinfo-cold") and restart meshinfo: its first
     cycle creates the meshinfo_cold tablespace at /var/lib/postgresql/cold
     (ZFS.md step 4). To manage it by hand instead, set
     cold_tablespace_location = "" and run once:
       docker compose exec postgres psql -U postgres -d meshinfo \\
         -c "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
EOF
fi
