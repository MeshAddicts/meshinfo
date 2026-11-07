#!/usr/bin/env bash
#
# setup-zfs-datasets.sh — create the two ZFS datasets MeshInfo's tiered cold
# storage expects (see ZFS.md), with the properties the benchmarks were run at.
#
#   <parent>/pgdata   hot  — cluster, WAL, live months
#                     recordsize=16K  compression=zstd-3  logbias=latency
#   <parent>/pgcold   cold — closed months (the meshinfo_cold tablespace)
#                     recordsize=128K compression=zstd-9  logbias=throughput
#
# Both get atime=off and xattr=sa, and their mountpoints are chowned to the
# postgres user of the official image (999:999). Idempotent: datasets that
# already exist are left in place and only their properties are (re)applied,
# which is a no-op when nothing changed. Changing recordsize/compression on an
# existing dataset affects newly written blocks only — see ZFS.md.
#
# Usage:
#   sudo scripts/setup-zfs-datasets.sh <parent-dataset> [--uid 999] [--gid 999] [--dry-run]
#
#   sudo scripts/setup-zfs-datasets.sh tank/meshinfo              # creates tank/meshinfo if missing
#   scripts/setup-zfs-datasets.sh tank/meshinfo --dry-run         # print the commands, touch nothing
#
# <parent-dataset> is a ZFS dataset name (pool/path), not a mountpoint. The
# datasets mount at the pool's default location (/<dataset-name>) unless the
# pool is configured otherwise — the script prints where they ended up; pass
# those paths to docker-compose.zfs.yml via MESHINFO_ZFS_HOT / MESHINFO_ZFS_COLD.
#
set -euo pipefail

HOT_PROPS=(recordsize=16K compression=zstd-3 atime=off xattr=sa logbias=latency)
COLD_PROPS=(recordsize=128K compression=zstd-9 atime=off xattr=sa logbias=throughput)

PARENT=""
OWNER_UID=999
OWNER_GID=999
DRY_RUN=0

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }
usage() {
  cat <<EOF
Usage: $(basename "$0") <parent-dataset> [--uid UID] [--gid GID] [--dry-run]

Creates <parent-dataset>/pgdata (hot) and <parent-dataset>/pgcold (cold) with
the recordsize/compression properties MeshInfo's tiered storage expects, and
chowns their mountpoints to UID:GID (default 999:999, the postgres user of the
official postgres image). Safe to re-run.

  --uid UID    owner of the mountpoints (default 999)
  --gid GID    group of the mountpoints (default 999)
  --dry-run    print the zfs/chown commands instead of running them
               (works without zfs installed)
EOF
}

# --- Arguments ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --uid)     [ $# -ge 2 ] || { err "--uid needs a value"; exit 2; }; OWNER_UID="$2"; shift 2 ;;
    --uid=*)   OWNER_UID="${1#--uid=}"; shift ;;
    --gid)     [ $# -ge 2 ] || { err "--gid needs a value"; exit 2; }; OWNER_GID="$2"; shift 2 ;;
    --gid=*)   OWNER_GID="${1#--gid=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        err "unknown option: $1"; usage >&2; exit 2 ;;
    *)
      if [ -n "$PARENT" ]; then
        err "unexpected argument: $1 (parent dataset already given as '$PARENT')"
        usage >&2
        exit 2
      fi
      PARENT="$1"; shift ;;
  esac
done

if [ -z "$PARENT" ]; then
  usage >&2
  exit 2
fi
case "$PARENT" in
  /*)  err "'$PARENT' looks like a mountpoint — pass the dataset name (e.g. tank/meshinfo)"; exit 2 ;;
  */)  err "'$PARENT' must not end with '/'"; exit 2 ;;
esac
for v in "$OWNER_UID" "$OWNER_GID"; do
  case "$v" in
    ''|*[!0-9]*) err "--uid/--gid must be numeric (got '$v')"; exit 2 ;;
  esac
done

HOT="${PARENT}/pgdata"
COLD="${PARENT}/pgcold"

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
ensure_dataset "$HOT"  "${HOT_PROPS[@]}"
ensure_dataset "$COLD" "${COLD_PROPS[@]}"

HOT_MP="$(mountpoint_of "$HOT")"
COLD_MP="$(mountpoint_of "$COLD")"

# Ownership of the mountpoints only (not recursive): the postgres image runs
# as 999:999 and must own /var/lib/postgresql and the tablespace directory.
# Data copied in later (rsync -a from the old volume) carries its own owner.
log "Setting ownership ${OWNER_UID}:${OWNER_GID} on the mountpoints"
run chown "${OWNER_UID}:${OWNER_GID}" "$HOT_MP" "$COLD_MP"
run chmod 0750 "$HOT_MP" "$COLD_MP"

# --- Summary -----------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ] && [ "$HAVE_ZFS" -eq 1 ]; then
  echo
  zfs list -o name,used,avail,recordsize,compression,atime,xattr,logbias,mountpoint "$HOT" "$COLD"
fi

cat <<EOF

Datasets ready:
  hot  : ${HOT}  ->  ${HOT_MP}
  cold : ${COLD}  ->  ${COLD_MP}

Next steps (details in ZFS.md):
  1. If the mountpoints differ from the overlay defaults (/tank/meshinfo/pgdata,
     /tank/meshinfo/pgcold), put them in .env next to the compose files:
       MESHINFO_ZFS_HOT=${HOT_MP}
       MESHINFO_ZFS_COLD=${COLD_MP}
  2. Existing install: stop the stack and copy the current Docker volume onto the
     hot dataset (ZFS.md, "Switching an existing Docker volume").
  3. Start with the overlay:
       docker compose -f docker-compose.yml -f docker-compose.zfs.yml up -d
  4. Create the cold tablespace once:
       docker compose exec postgres psql -U postgres -d meshinfo \\
         -c "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
  5. Enable the job in config.toml ([storage.tiering] enabled = true,
     cold_filesystem = "/mnt/meshinfo-cold") and restart meshinfo.
EOF
