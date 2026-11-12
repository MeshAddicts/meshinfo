#!/usr/bin/env bash
#
# The lab suite for scripts/setup-cold-storage.sh. It runs INSIDE the
# privileged lab container that run.sh starts, as root, and exercises the
# script for real: loop devices, mkfs, mounts, /etc/fstab, .env, and a Docker
# daemon of its own that runs the stack from the real compose files.
# Everything it makes lives in that container, except what is the kernel's:
# the loop devices and, where the kernel has ZFS, the pools of the zfs_real
# section. It records each one it makes, and detaches and destroys them again.
# Do not run it anywhere else: it formats loop devices and rewrites /etc/fstab.
#
#   suite.sh            every section
#   suite.sh NAME...    only those sections (see SECTIONS below)
#   suite.sh bootstrap  only prepare the container (loop nodes, Docker, disks)
#   suite.sh cleanup    only undo that: stop a suite that is still running
#                       here, unmount, destroy the lab's pools, detach the
#                       loop devices
#
set -uo pipefail

REPO="${REPO:-/opt/meshinfo}"
SCRIPT="$REPO/scripts/setup-cold-storage.sh"
HERE="$REPO/tests/cold_storage_lab"
LAB=/lab
OUT="$LAB/last-output.txt"
DEVICE_LIST="$LAB/devices"
POOL_LIST="$LAB/pools"
PID_FILE="$LAB/suite.pid"
MP=/srv/meshinfo/pgcold
DEFAULT_IMAGE=/var/lib/meshinfo-cold.img
# The lab image's own zpool and zfs. They are kept off PATH (see the
# Dockerfile): pools belong to the kernel, and with them on PATH every run of
# the script here would see the pools of the machine the lab runs on.
ZFS_TOOLS=/opt/zfs/sbin
MIB=$((1024 * 1024))
GIB=$((1024 * MIB))
SECTIONS=(static arguments environment refusals dry_runs image default device subvolume existing zfs_stub zfs_real stack pytest)

PASS=0
FAIL=0
FAILURES=()
NOT_RUN=()   # what a section could not exercise here, said again at the end
RC=0
DISK=""
PART=""
PROJ=""
LINKED=""
DEVICES=()   # the loop devices this run attached
POOLS=()     # the ZFS pools this run created
PREFIX=()    # put in front of the script by setup(), e.g. env PATH=...

# --- Reporting ---------------------------------------------------------------------

section() { printf '\n=== %s\n' "$*"; }
note() { printf '  note  %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '        %s\n' "$2"; fi
  if [ -s "$OUT" ]; then tail -n 30 "$OUT" | sed 's/^/        | /'; fi
}

# run COMMAND...: output to $OUT, exit status to RC. No terminal on stdin.
run() { "$@" >"$OUT" 2>&1 </dev/null; RC=$?; return 0; }
# setup ARGS...: the script under test.
setup() { run "${PREFIX[@]}" "$SCRIPT" "$@"; }

ok() { if [ "$RC" -eq 0 ]; then pass "$1"; else fail "$1" "exit $RC"; fi; }
exits() { if [ "$RC" -eq "$2" ]; then pass "$1"; else fail "$1" "exit $RC, expected $2"; fi; }
said() { if grep -Eq -- "$2" "$OUT"; then pass "$1"; else fail "$1" "the output does not match /$2/"; fi; }
silent_on() { if grep -Eq -- "$2" "$OUT"; then fail "$1" "the output matches /$2/"; else pass "$1"; fi; }
is() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got '$2', expected '$3'"; fi; }
holds() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name" "failed: $*"; fi
}

# human BYTES: as the script prints sizes ("20.0 GiB"), written a second time.
human() {
  python3 -c '
import sys
value, units = float(sys.argv[1]), ["B", "KiB", "MiB", "GiB", "TiB"]
index = 0
while value >= 1024 and index < len(units) - 1:
    value /= 1024
    index += 1
print("%d B" % value if index == 0 else "%.1f %s" % (value, units[index]))' "$1"
}

allocated_bytes() { echo $(($(stat -c %b "$1") * 512)); }

# own_loops: the loop devices whose file is a file of this container, with
# that file. The kernel's list holds those of the whole machine — of other
# containers, of the machine itself — which come and go without the script
# having done anything; a device is the lab's when the path it names leads,
# here, to the very file the kernel has (same inode on the same filesystem).
own_loops() {
  local name inode device file
  while read -r name inode device file; do
    file="${file% (deleted)}"
    if [ -n "$file" ] && [ "$(stat -c '%i %Hd:%Ld' "$file" 2>/dev/null)" = "$inode $device" ]; then echo "$name $file"; fi
  done < <(losetup -l -n --raw -O NAME,BACK-INO,BACK-MAJ:MIN,BACK-FILE 2>/dev/null)
}

# lab_disk_loop DEVICE: the loop device is on one of this container's disk
# files — also on one that was deleted since. The path alone does not say
# so: another lab container on the machine has a /lab/disks too. The
# filesystem does: the kernel names the one a backing file is on, and this
# container's /lab/disks is on one of its own.
lab_disk_loop() {
  local where file ours
  read -r where file < <(losetup -n --raw -O BACK-MAJ:MIN,BACK-FILE "$1" 2>/dev/null) || return 1
  case "$file" in
    "$LAB"/disks/*) ;;
    *) return 1 ;;
  esac
  ours="$(stat -c '%Hd:%Ld' "$LAB"/disks/* 2>/dev/null | head -n 1)"
  if [ -z "$ours" ]; then ours="$(stat -c '%Hd:%Ld' "$LAB/disks" 2>/dev/null)"; fi
  [ "$where" = "$ours" ]
}

# fingerprint: everything the script could change, as one hash.
fingerprint() {
  {
    cat /etc/fstab
    find /etc -maxdepth 1 -name 'fstab*' | sort
    findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS | grep -Ev '^/(proc|sys|dev|run|var/lib/docker)(/| )' | sort
    own_loops | sort
    find "$DEFAULT_IMAGE" "$LAB/disks" /srv /hostfs /smallfs /btrfshost /btrfszstd /tank \
      -maxdepth 3 -printf '%p %y %s %u:%g %m\n' 2>/dev/null | sort
    for device in "${DEVICES[@]}"; do blkid -p "$device" 2>&1; done
    # .env, its backups and config.toml, in the checkout and in every scratch project
    find "$REPO" "$LAB/proj" -maxdepth 2 \( -name '.env*' -o -name 'config.toml' \) -printf '%p %s %u:%g %m\n' 2>/dev/null | sort
    cat "$REPO/.env" "$REPO/config.toml" "$LAB"/proj/*/.env "$LAB"/proj/*/config.toml 2>/dev/null
    if [ -n "${ZFS_STUB_STATE:-}" ]; then cat "$ZFS_STUB_STATE"/datasets/* 2>/dev/null; fi
    if [ "${#POOLS[@]}" -gt 0 ]; then
      "$ZFS_TOOLS/zfs" list -H -r -o name,mountpoint,mounted,canmount,recordsize,compression,atime,xattr,logbias "${POOLS[@]}" 2>&1
    fi
  } | sha256sum | cut -d' ' -f1
}

# refuses NAME PATTERN ARGS...: the script exits non-zero, says PATTERN, and
# nothing was changed.
refuses() {
  local name="$1" pattern="$2" before
  shift 2
  before="$(fingerprint)"
  setup "$@"
  if [ "$RC" -eq 0 ]; then
    fail "$name" "expected a refusal, got exit 0"
  elif ! grep -Eq -- "$pattern" "$OUT"; then
    fail "$name" "exit $RC, but the message does not match /$pattern/"
  elif [ "$(fingerprint)" != "$before" ]; then
    fail "$name" "refused, but something was changed"
  else
    pass "$name"
  fi
}

# usage_error NAME PATTERN ARGS...: exit status 2 and PATTERN.
usage_error() {
  local name="$1" pattern="$2"
  shift 2
  setup "$@"
  if [ "$RC" -eq 2 ] && grep -Eq -- "$pattern" "$OUT"; then
    pass "$name"
  else
    fail "$name" "exit $RC (expected 2), or the message does not match /$pattern/"
  fi
}

# changes_nothing NAME ARGS...: the script exits 0 and nothing was changed.
changes_nothing() {
  local name="$1" before
  shift
  before="$(fingerprint)"
  setup "$@"
  if [ "$RC" -ne 0 ]; then
    fail "$name" "exit $RC"
  elif [ "$(fingerprint)" != "$before" ]; then
    fail "$name" "exit 0, but something was changed"
  else
    pass "$name"
  fi
}

# ends_with_the_two_steps NAME: after "Cold storage is ready", the output has
# the heading, the two config lines and the compose command, in that order.
ends_with_the_two_steps() {
  if awk '
      /^==> Cold storage is ready/ { stage = 1 }
      stage == 1 && /^Two steps remain:$/ { stage = 2 }
      stage == 2 && /^ +enabled = true$/ { stage = 3 }
      stage == 3 && /^ +cold_filesystem = "\/mnt\/meshinfo-cold"$/ { stage = 4 }
      stage == 4 && /^ +docker compose up -d$/ { stage = 5 }
      END { exit stage != 5 }' "$OUT"; then
    pass "$1"
  else
    fail "$1" "the closing lines are not there, or not in that order"
  fi
}

# --- Fixtures ------------------------------------------------------------------------

# attach FILE [LOSETUP-OPTIONS]: a loop device for FILE; sets DISK and records
# the device, so that cleanup can detach it whatever happens.
attach() {
  local file="$1"
  shift
  DISK="$(losetup -f --show "$@" "$file")" || { echo "cannot attach a loop device for $file" >&2; exit 1; }
  DEVICES+=("$DISK")
  echo "$DISK" >> "$DEVICE_LIST"
}

# make_disk NAME SIZE: a sparse file on a loop device, to play a block device.
make_disk() {
  local file="$LAB/disks/$1.img"
  rm -f "$file"
  truncate -s "$2" "$file"
  attach "$file"
}

# make_partition NAME SIZE: such a file with one partition in it, on a loop
# device that shows its partitions; sets DISK and PART. Status 1 when the lab
# cannot get at the partition.
make_partition() {
  local file="$LAB/disks/$1.img"
  rm -f "$file"
  truncate -s "$2" "$file"
  printf 'label: gpt\n,\n' | sfdisk -q "$file" >/dev/null 2>&1
  attach "$file" -P
  PART="${DISK}p1"
  partition_node
}

# partition_node: the device node for PART, the first partition of DISK. A
# container's /dev does not follow the kernel, so the node is made by hand —
# every time, from the numbers the kernel gives this partition now. A node
# that is there already, left over from an earlier run, is never taken over:
# its numbers may belong to another device of the machine by now.
partition_node() {
  local numbers="" sys
  sys="/sys/block/${DISK##*/}/${DISK##*/}p1/dev"
  if [ -r "$sys" ]; then read -r numbers < "$sys" || true; fi
  rm -f "$PART"
  case "$numbers" in
    *:*) mknod "$PART" b "${numbers%%:*}" "${numbers##*:}" || return 1 ;;
    *)   return 1 ;;
  esac
  [ "$(stat -c '%Hr:%Lr' "$PART" 2>/dev/null)" = "$numbers" ]
}

# real_pool NAME SIZE [ZPOOL-CREATE-OPTIONS]: a ZFS pool of the lab's own, on
# a partition of a loop device (the kernel opens a vdev by its path in the
# /dev of the machine, where a file inside this container does not exist;
# and given a whole loop device, zpool would partition it and wait for nodes
# that nothing makes here). No -f: the partition is new and holds nothing, so
# a zpool that finds something on it is looking at a device that is not the
# lab's. The pool is recorded, so that cleanup destroys it.
real_pool() {
  local name="$1" size="$2"
  shift 2
  make_partition "$name" "$size" || { echo "no partition device for $DISK" > "$OUT"; return 1; }
  # Recorded before it is made: a suite that is stopped inside zpool create
  # leaves a pool that cleanup has to know (a name that is no pool is passed over).
  echo "$name" >> "$POOL_LIST"
  "$ZFS_TOOLS/zpool" create -o cachefile=none "$@" "$name" "$PART" > "$OUT" 2>&1 || return 1
  POOLS+=("$name")
}

# foreign_datasets POOL: every dataset that is not on the lab's pool POOL or
# on its second pool POOLb, with its mountpoint and canmount: what the lab
# must leave exactly as it finds it.
foreign_datasets() {
  "$ZFS_TOOLS/zfs" list -H -t filesystem,volume -o name,mountpoint,canmount 2>/dev/null |
    awk -F'\t' -v pool="$1" '{ split($1, part, "/"); if (part[1] != pool && part[1] != pool "b") print }'
}

# drop_pool NAME: destroy one of the lab's pools and forget it. The loop
# device it was on goes with it (the section makes several pools in a row),
# when it is one of the lab's own disk files.
drop_pool() {
  local pool device
  local -a kept=()
  device="$("$ZFS_TOOLS/zpool" status -P "$1" 2>/dev/null | grep -oE '/dev/loop[0-9]+p1' | head -n 1)"
  "$ZFS_TOOLS/zpool" destroy -f "$1" >/dev/null 2>&1
  if [ -n "$device" ] && ! "$ZFS_TOOLS/zpool" list -H -o name "$1" >/dev/null 2>&1 && lab_disk_loop "${device%p1}"; then
    rm -f "$device"
    if losetup -d "${device%p1}" 2>/dev/null; then
      # no longer the lab's: the number is free for any device of the machine
      for pool in "${DEVICES[@]}"; do
        if [ "$pool" != "${device%p1}" ]; then kept+=("$pool"); fi
      done
      DEVICES=("${kept[@]}")
      kept=()
      sed -i "\\|^${device%p1}\$|d" "$DEVICE_LIST"
    fi
  fi
  for pool in "${POOLS[@]}"; do
    if [ "$pool" != "$1" ]; then kept+=("$pool"); fi
  done
  POOLS=("${kept[@]}")
}

# make_fs TYPE NAME SIZE MOUNTPOINT [OPTIONS]: a filesystem on such a device,
# mounted, to play one of the host's own filesystems.
make_fs() {
  make_disk "$2" "$3"
  case "$1" in
    ext4)  mkfs.ext4 -q -F "$DISK" ;;
    btrfs) mkfs.btrfs -q -f "$DISK" ;;
  esac
  mkdir -p "$4"
  mount ${5:+-o "$5"} "$DISK" "$4" || { echo "cannot mount $DISK at $4" >&2; exit 1; }
}

# new_project NAME: a directory with the stack's compose files and nothing
# else, for --project-dir. Sets PROJ.
new_project() {
  PROJ="$LAB/proj/$1"
  rm -rf "$PROJ"
  mkdir -p "$PROJ"
  cp "$REPO/docker-compose.yml" "$REPO/docker-compose.cold.yml" "$REPO/docker-compose.zfs.yml" "$PROJ/"
}

# forget_cold MOUNTPOINT: undo a setup there (the mount, the fstab line, the
# directory), so that the next scenario starts clean. What backed it stays.
forget_cold() {
  local mp="$1"
  case "$mp" in
    /srv/*|/btrfshost/*|/btrfszstd/*|/hostfs/*) ;;
    *) echo "forget_cold: refusing to touch $mp" >&2; return 1 ;;
  esac
  if findmnt -rn -M "$mp" >/dev/null 2>&1; then umount "$mp"; fi
  sed -i -e "\\|[[:space:]]${mp}[[:space:]]|d" -e '/^# MeshInfo cold storage/d' /etc/fstab
  rm -f /etc/fstab.bak-meshinfo-*
  if [ -d "$mp" ]; then
    if btrfs subvolume show "$mp" >/dev/null 2>&1; then
      btrfs subvolume delete "$mp" >/dev/null
    else
      rm -rf "$mp"
    fi
  fi
}

# documented_fstab_line device|image: the line ZFS.md tells operators to add.
documented_fstab_line() {
  local lines
  lines="$(sed -n "s/^ *echo '\\(.*\\)' | sudo tee -a \\/etc\\/fstab\$/\\1/p" "$REPO/ZFS.md")"
  case "$1" in
    image)  grep -F 'loop,' <<<"$lines" ;;
    device) grep -F 'LABEL=' <<<"$lines" ;;
  esac
}

# hidden TOOL...: binds for with_binds that put a file which cannot be run
# over each TOOL, wherever PATH — or the sbin directories the script adds to
# it — would find it.
hidden() {
  local tool dir
  : > "$LAB/not-a-tool"
  for tool in "$@"; do
    for dir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
      if [ ! -L "$dir" ] && [ -e "$dir/$tool" ]; then echo "$LAB/not-a-tool=$dir/$tool"; fi
    done
  done
}

# stand_in NAME TOOL BODY: a PATH directory with one tool in it, a shell
# script with that body. Sets LINKED.
stand_in() {
  LINKED="$LAB/path/$1"
  rm -rf "$LINKED"
  mkdir -p "$LINKED"
  printf '#!/bin/sh\n%s\n' "$3" > "$LINKED/$2"
  chmod +x "$LINKED/$2"
}

# failing_tool NAME TOOL: a PATH directory whose TOOL fails.
failing_tool() { stand_in "$1" "$2" "echo \"$2: made to fail by the lab\" >&2; exit 1"; }

# at_a_terminal ANSWER ARGS...: the script with a terminal on stdin, where
# ANSWER is typed at its question.
at_a_terminal() {
  local answer="$1" command
  shift
  printf -v command '%q ' "$SCRIPT" "$@"
  printf '%s\n' "$answer" | script -qec "$command" /dev/null >"$OUT" 2>&1
  RC=$?
}

# os_release ID [ID_LIKE]: a file to bind over /etc/os-release. Prints its path.
os_release() {
  local file="$LAB/os-release.$1"
  printf 'PRETTY_NAME="Lab %s"\nID=%s\n' "$1" "$1" > "$file"
  if [ -n "${2:-}" ]; then printf 'ID_LIKE="%s"\n' "$2" >> "$file"; fi
  echo "$file"
}

# with_binds "SOURCE=TARGET"... -- COMMAND...: run the command in a mount
# namespace of its own in which each SOURCE file is bound over TARGET.
with_binds() {
  local -a binds=()
  while [ "$1" != -- ]; do binds+=("$1"); shift; done
  shift
  # shellcheck disable=SC2016  # expanded by the inner shell
  unshare -m -- bash -c 'while [ "$1" != -- ]; do mount --bind "${1%%=*}" "${1#*=}" || exit 97; shift; done; shift; exec "$@"' \
    bash "${binds[@]}" -- "$@"
}

# wait_for_postgres PROJECT_DIR: until the stack's database answers (seconds
# on a real machine; minutes where the lab itself runs under emulation).
wait_for_postgres() {
  local _
  for _ in $(seq 300); do
    # The image initialises a new cluster under a temporary server, which
    # answers pg_isready and is then shut down again. Only the server that is
    # process 1 of the container is the one that stays.
    # shellcheck disable=SC2016  # expanded by the shell inside the container
    if (cd "$1" && docker compose exec -T postgres sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -q -U postgres -d meshinfo') >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

psql_at() { (cd "$REPO" && docker compose exec -T postgres psql -X -U postgres -d meshinfo -At -F ' ' -c "$1"); }

# subvolume_id DIR: the id btrfs gave the subvolume at DIR; never used twice.
subvolume_id() { btrfs subvolume show "$1" 2>/dev/null | sed -n 's/^[[:space:]]*Subvolume ID:[[:space:]]*//p'; }

# months_ago N: the month N months before this one, as YYYY-MM.
months_ago() { date -u -d "$(date -u +%Y-%m-01) -$1 months" +%Y-%m; }

bootstrap() {
  local number
  mkdir -p "$LAB/disks" "$LAB/proj" "$LAB/path" "$LAB/mnt"
  : > "$OUT"
  touch "$DEVICE_LIST"
  # A container's /dev is a snapshot: nodes for loop devices the kernel makes
  # later are missing unless they are made here.
  for number in $(seq 0 63); do
    if [ ! -e "/dev/loop$number" ]; then mknod -m 0660 "/dev/loop$number" b 7 "$number"; fi
  done
  grep -qw btrfs /proc/filesystems || { echo "btrfs is not available in the kernel these containers run on: load the module there (modprobe btrfs on the Docker host, or inside its VM)" >&2; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
      # cgroup v2: leave the root cgroup so that controllers can be handed to
      # the containers of the daemon started below (as the dind image does).
      mkdir -p /sys/fs/cgroup/init
      xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
      sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
    fi
    (dockerd > "$LAB/dockerd.log" 2>&1 &)
    for number in $(seq 60); do
      if docker info >/dev/null 2>&1; then break; fi
      sleep 1
    done
  fi
  docker info >/dev/null 2>&1 || { echo "the Docker daemon inside the lab did not start, see $LAB/dockerd.log" >&2; exit 1; }
  if ! findmnt -rn -M /hostfs >/dev/null 2>&1; then
    make_fs ext4 hostfs 60G /hostfs                         # an ordinary host filesystem
    make_fs ext4 smallfs 8G /smallfs                        # ... and one that is nearly full for a 6 GiB image
    make_fs btrfs btrfshost 12G /btrfshost                  # a host already on btrfs, no compression
    make_fs btrfs btrfszstd 6G /btrfszstd compress=zstd:3   # ... and one mounted with compression
  fi
}

# descendants PID: every process below PID.
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}

# stop_running_suite: a suite that is still running in this container is
# stopped, with everything it started, before anything is cleaned up beside
# it. That happens after Ctrl-C at run.sh: the interrupt ends the docker
# client, not what docker exec started, and the suite would go on making
# loop devices and pools while they are being taken away. Only the cleanup
# command does this; the suite's own trap never signals itself.
stop_running_suite() {
  local pid _
  local -a tree=()
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$pid" = "$$" ] || ! tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'suite\.sh'; then
    rm -f "$PID_FILE"
    return 0
  fi
  kill -STOP "$pid" 2>/dev/null   # it starts nothing new from here on
  for _ in 1 2 3; do
    mapfile -t tree < <(descendants "$pid")
    [ "${#tree[@]}" -gt 0 ] || break
    kill -TERM "${tree[@]}" 2>/dev/null
    sleep 1
    kill -KILL "${tree[@]}" 2>/dev/null
  done
  kill -KILL "$pid" 2>/dev/null
  for _ in $(seq 40); do
    # gone — or only waiting for its parent to collect it, which is as good
    if [ ! -e "/proc/$pid" ] || grep -q '^State:[[:space:]]*Z' "/proc/$pid/status" 2>/dev/null; then break; fi
    sleep 0.25
  done
  rm -f "$PID_FILE"
  echo "stopped the suite that was still running here (process $pid)"
}

# cleanup: stop what the suite started, unmount what it mounted, destroy the
# pools it made and detach every loop device it attached — in this run or an
# earlier one.
cleanup() {
  local device target project pool
  (cd "$REPO" && docker compose down -v --remove-orphans) >/dev/null 2>&1
  for project in "$LAB"/proj/*/; do
    if [ -f "$project/docker-compose.yml" ]; then (cd "$project" && docker compose down -v --remove-orphans) >/dev/null 2>&1; fi
  done
  dmsetup remove coldlab-holder >/dev/null 2>&1
  # Pools are the kernel's too. Only the lab's own, by the name it gave them
  # and only where their device is one of the lab's disk files.
  if [ -f "$POOL_LIST" ] && [ -x "$ZFS_TOOLS/zpool" ]; then
    while read -r pool; do
      case "$pool" in
        coldlab[0-9]*)
          device="$("$ZFS_TOOLS/zpool" status -P "$pool" 2>/dev/null | grep -oE '/dev/loop[0-9]+p1' | head -n 1)"
          if [ -n "$device" ] && lab_disk_loop "${device%p1}"; then "$ZFS_TOOLS/zpool" destroy -f "$pool" 2>/dev/null; fi ;;
      esac
    done < "$POOL_LIST"
    : > "$POOL_LIST"
  fi
  while read -r target; do
    if [ -n "$target" ]; then umount "$target" 2>/dev/null; fi
  done < <(findmnt -rn -o TARGET | grep -E '^/(srv|hostfs|smallfs|btrfshost|btrfszstd|lab)(/|$)' | sort -r)
  if [ -f "$DEVICE_LIST" ]; then
    while read -r device; do
      # only what is still on one of this container's disk files
      if lab_disk_loop "$device"; then
        losetup -d "$device" 2>/dev/null
        # ... and the node the lab made for its partition goes with it: its
        # numbers are free for another device of the machine from here on
        rm -f "${device}p1"
      fi
    done < "$DEVICE_LIST"
    : > "$DEVICE_LIST"
  fi
  # ... and whatever else the kernel still has on one of this container's
  # disk files: a device attached in the moment a suite was stopped is in no list
  while read -r device target; do
    case "$target" in
      "$LAB"/disks/*)
        losetup -d "$device" 2>/dev/null
        rm -f "${device}p1" ;;
    esac
  done < <(own_loops)
  return 0
}

# --- Sections ------------------------------------------------------------------------

t_static() {
  local flag flags missing="" before device
  section "static checks"
  run bash -n "$SCRIPT"; ok "bash -n"
  run env LC_ALL=C.UTF-8 shellcheck "$SCRIPT" "$REPO/scripts/setup-zfs-datasets.sh" "$HERE/suite.sh" "$HERE/run.sh" "$HERE/stubs/zpool" "$HERE/stubs/zfs" "$HERE/stubs/findmnt"
  ok "shellcheck: the script, the script it delegates to, and the lab's own scripts"
  setup --help; ok "--help exits 0"
  # every option the parser knows, taken from the parser itself
  flags="$(sed -n '/^set_option() {/,/^}/p; /^parse_args() {/,/^}/p' "$SCRIPT" | grep -oE -- '--[a-z]+(-[a-z]+)*' | sort -u | tr '\n' ' ')"
  for flag in $flags setup status grow; do
    grep -q -- "$flag" "$OUT" || missing="$missing $flag"
  done
  is "--help names every option the parser takes ($(wc -w <<<"$flags") of them) and the subcommands" "$missing" ""

  # The lab's own eyes: "nothing was changed" is only worth something when a
  # loop device the script attached would show, and one that another
  # container of the machine attaches meanwhile would not.
  is "(the lab finds its own loop devices among the kernel's)" "$(own_loops | grep -c " $LAB/disks/hostfs.img\$")" 1
  before="$(fingerprint)"
  truncate -s 8M /tmp/lab-loop.img
  device="$(losetup -f --show /tmp/lab-loop.img)"
  if [ "$(fingerprint)" != "$before" ]; then
    pass "(a loop device on a file of this container changes the fingerprint)"
  else
    fail "(a loop device on a file of this container changes the fingerprint)" "the fingerprint is the same with $device attached"
  fi
  # the same path now leads to another file, as it does for a loop device
  # that belongs to another container: the kernel's file is not one of ours
  rm -f /tmp/lab-loop.img
  truncate -s 8M /tmp/lab-loop.img
  is "(... and one whose file is not a file of this container does not)" "$(fingerprint)" "$before"
  losetup -d "$device"
  rm -f /tmp/lab-loop.img
}

t_arguments() {
  section "arguments (usage errors exit 2, and none of them needs root: run as nobody)"
  PREFIX=(setpriv --reuid=65534 --regid=65534 --clear-groups)
  usage_error "an unknown argument" 'unknown argument: --bogus' --bogus
  usage_error "two layouts at once" 'different layouts' --image /hostfs/a.img --device /dev/loop63
  usage_error "--size with a device" 'does not apply to --device' --device /dev/loop63 --size 4G
  usage_error "--force without --device" 'only applies to --device' --force
  usage_error "a size that is not one" '--size 12Q' --size 12Q
  usage_error "a size in decimal gigabytes" '--size 20GB' --size 20GB
  usage_error "a relative mountpoint" 'must be an absolute path' --mountpoint srv/cold
  usage_error "a mountpoint with a space" 'must be an absolute path made of' --mountpoint '/srv/cold storage'
  usage_error "a mountpoint with a colon" 'must be an absolute path made of' --mountpoint /srv/cold:1
  usage_error "a mountpoint with .. in it" 'must be an absolute path made of' --mountpoint /srv/../etc/cold
  usage_error "an image path with a space" 'image path' --image '/hostfs/my image.img'
  usage_error "--existing with another --mountpoint" 'leave --mountpoint out' --existing /btrfszstd/a --mountpoint /srv/b
  usage_error "a value is missing" '--mountpoint needs a value' --mountpoint
  usage_error "--to without grow" 'belongs to the grow subcommand' --to 8G
  usage_error "grow without --to" 'grow needs --to' grow
  usage_error "grow --to nonsense" '--to lots' grow --to lots
  usage_error "grow with a layout flag" 'grow takes' grow --to 8G --image /hostfs/a.img
  usage_error "status with --yes" 'status takes' status --yes
  usage_error "a bare pool for --zfs" 'names a pool, not a dataset' --zfs tank --no-env
  usage_error "a path for --zfs" 'takes a dataset name \(pool/name\), not a path' --zfs /tank/cold --no-env
  usage_error "a dataset name ending with a slash" 'must not end with /' --zfs tank/cold/ --no-env
  setup setup --mountpoint=/srv/x --image=/hostfs/a.img --size=4G --project-dir=/lab -n -y
  exits "the word setup, --option=value and -n -y all parse (only root is missing then)" 1
  said "... as the message shows" 'needs root'
  PREFIX=()
}

t_environment() {
  local fake_fs saved_path="$PATH"
  local -a an_image=(--image /hostfs/x.img --size 4G --mountpoint /srv/envtest --no-env --yes) gone=()
  section "the host: not root, missing tools, no btrfs in the kernel, no loop devices, systemd, docker unusable"
  new_project environment

  PREFIX=(setpriv --reuid=65534 --regid=65534 --clear-groups)
  refuses "not root: setup" 'needs root' "${an_image[@]}"
  refuses "not root: status" 'needs root' status
  refuses "not root: grow" 'needs root' grow --to 8G

  mapfile -t gone < <(hidden btrfs mkfs.btrfs)
  PREFIX=(with_binds "${gone[@]}" --)
  refuses "btrfs-progs missing: Debian family" 'not found on this host: btrfs mkfs\.btrfs — apt-get install btrfs-progs' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release fedora)=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: Fedora" 'dnf install btrfs-progs' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release opensuse-leap 'suse opensuse')=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: SUSE family" 'zypper install btrfsprogs' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release arch)=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: Arch family" 'pacman -S btrfs-progs' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release alpine)=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: Alpine" 'apk add btrfs-progs' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release rocky 'rhel centos fedora')=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: RHEL family" 'RHEL family ships neither btrfs-progs nor btrfs in its kernel' "${an_image[@]}"
  PREFIX=(with_binds "$(os_release labos)=/etc/os-release" "${gone[@]}" --)
  refuses "btrfs-progs missing: an unknown distribution" 'install the btrfs-progs package with your package manager' "${an_image[@]}"

  mapfile -t gone < <(hidden losetup)
  PREFIX=(with_binds "${gone[@]}" --)
  refuses "a util-linux tool missing" 'not found on this host: losetup — apt-get install util-linux mount' "${an_image[@]}"
  mkdir -p "$LAB/bb" "$LAB/path/applets"
  cp /usr/bin/true "$LAB/bb/busybox"
  ln -sf "$LAB/bb/busybox" "$LAB/path/applets/losetup"
  PREFIX=(with_binds "$(os_release alpine)=/etc/os-release" -- env "PATH=$LAB/path/applets:$PATH")
  refuses "a busybox applet does not count as the tool" 'not found on this host: losetup — apk add util-linux' "${an_image[@]}"

  PREFIX=()
  refuses "the zfs commands missing" 'not found on this host: zpool zfs — apt-get install zfsutils-linux' --zfs tank/cold --no-env --yes

  fake_fs="$LAB/filesystems"
  grep -vw btrfs /proc/filesystems > "$fake_fs"
  stand_in nomodule modprobe 'exit 1'
  printf '#!/bin/sh\nexit 1\n' > "$LINKED/modinfo"
  chmod +x "$LINKED/modinfo"
  PREFIX=(with_binds "$fake_fs=/proc/filesystems" -- env "PATH=$LINKED:$saved_path")
  refuses "no btrfs in the kernel" 'this kernel has no btrfs \(it is not in /proc/filesystems and there is no module for it\)' "${an_image[@]}"
  PREFIX=(with_binds "$fake_fs=/proc/filesystems" "$(os_release rocky 'rhel centos fedora')=/etc/os-release" -- env "PATH=$LINKED:$saved_path")
  refuses "no btrfs in the kernel: RHEL family" 'this kernel has no btrfs — the RHEL family' "${an_image[@]}"

  # btrfs as a module that is not loaded, with a modprobe that has no -n
  # (busybox) and then cannot load it either
  # shellcheck disable=SC2016  # the stand-in's own text
  stand_in busymodprobe modprobe 'case "$*" in *-n*) echo "modprobe: unrecognized option: n" >&2; exit 1 ;; esac; exit 0'
  printf '#!/bin/sh\nexit 0\n' > "$LINKED/modinfo"
  chmod +x "$LINKED/modinfo"
  PREFIX=(with_binds "$fake_fs=/proc/filesystems" -- env "PATH=$LINKED:$saved_path")
  changes_nothing "btrfs only as a module, modprobe without -n: found through modinfo (dry run)" --image /hostfs/x.img --size 4G --mountpoint /srv/envtest --no-env --dry-run
  said "... the host is described so" 'btrfs in kernel +as a module, not loaded yet'
  said "... and the plan starts with loading it" '1\. modprobe btrfs +# the kernel has btrfs as a module'
  refuses "... and when it does not load, nothing else is done" 'could not load the btrfs kernel module' "${an_image[@]}"

  : > "$LAB/empty"
  PREFIX=(with_binds "$LAB/empty=/dev/loop-control" --)
  refuses "no /dev/loop-control: an image is not attempted" 'has no /dev/loop-control, so it cannot make loop devices' "${an_image[@]}"

  # a systemd host: fstab is read into mount units
  mkdir -p /run/systemd/system
  : > "$LAB/systemctl.log"
  stand_in systemd systemctl "echo \"systemctl \$*\" >> $LAB/systemctl.log"
  PREFIX=(env "PATH=$LINKED:$saved_path")
  setup --image /hostfs/sysd.img --size 4G --mountpoint /srv/sysd --no-env --yes
  ok "on a systemd host"
  said "... the plan names the reload" 'systemctl daemon-reload +# systemd turns fstab into mount units'
  is "... and it runs, once" "$(cat "$LAB/systemctl.log")" "systemctl daemon-reload"
  PREFIX=()
  forget_cold /srv/sysd
  rm -f /hostfs/sysd.img
  rmdir /run/systemd/system

  mapfile -t gone < <(hidden docker)
  PREFIX=(with_binds "${gone[@]}" --)
  changes_nothing "docker unusable: the plan is still made" --dry-run --project-dir "$PROJ"
  said "docker unusable: says why the size is the default" '20\.0 GiB: the default, because docker is not usable here'

  # su and cron give root a PATH without the sbin directories; an exported
  # CDPATH makes cd print where it went
  PREFIX=(env PATH=/usr/bin:/bin)
  changes_nothing "a PATH without the sbin directories (su, cron): the tools are still found" "${an_image[@]}" --dry-run
  said "... down to the plan" "mkfs.btrfs -L meshinfo-cold /hostfs/x.img"
  PREFIX=()
  run bash -c 'cd "$1" && CDPATH=.:/root exec scripts/setup-cold-storage.sh --dry-run --project-dir "$2"' sh "$REPO" "$PROJ"
  ok "an exported CDPATH and the script called by its relative path"
  said "... the project directory is still found" "stack +$PROJ: "
}

t_refusals() {
  local -a go=(--no-env --yes) gone=()
  local blank part
  section "refusals (each must leave everything as it was)"

  refuses "a size no move could ever fit in" '2\.0 GiB is too small to ever take a month: .* The smallest that makes sense here is 3\.0 GiB' --image /hostfs/a.img --size 2G --mountpoint /srv/r0 "${go[@]}"
  refuses "... nor 500 MiB" '500\.0 MiB is too small to ever take a month' --image /hostfs/a.img --size 500M --mountpoint /srv/r0 "${go[@]}"
  mkdir -p /srv/busy && touch /srv/busy/file
  refuses "a non-empty mountpoint that is not ours" '/srv/busy is not empty and is not the cold filesystem' --image /hostfs/a.img --size 4G --mountpoint /srv/busy "${go[@]}"
  touch /srv/afile
  refuses "a mountpoint that is a file" '/srv/afile exists and is not a directory' --image /hostfs/a.img --size 4G --mountpoint /srv/afile "${go[@]}"
  mkdir -p /srv/tmpfsmp && mount -t tmpfs tmpfs /srv/tmpfsmp
  refuses "a mountpoint where something else is mounted" 'already a mount point of something else \(tmpfs, tmpfs\)' --image /hostfs/a.img --size 4G --mountpoint /srv/tmpfsmp "${go[@]}"
  umount /srv/tmpfsmp
  echo '/dev/null /srv/conflict ext4 defaults 0 0' >> /etc/fstab
  refuses "an fstab entry for the mountpoint that is not the script's" '/etc/fstab already has an entry for /srv/conflict that this script did not write' --mountpoint /srv/conflict "${go[@]}"
  refuses "... and with the layout named" '/etc/fstab already has another entry for /srv/conflict' --image /hostfs/a.img --size 4G --mountpoint /srv/conflict "${go[@]}"
  sed -i '\|/srv/conflict|d' /etc/fstab

  refuses "the image's directory does not exist" '/nowhere, the directory for the image, does not exist' --image /nowhere/x.img --size 4G --mountpoint /srv/r1 "${go[@]}"
  refuses "an image path on btrfs" '/btrfshost is on btrfs: an image there' --image /btrfshost/x.img --size 4G --mountpoint /srv/r1 "${go[@]}"
  mkdir -p "$LAB/mnt/ram" && mount -t tmpfs tmpfs "$LAB/mnt/ram"
  refuses "an image path in memory (tmpfs)" "$LAB/mnt/ram is on tmpfs, which lives in memory: the image, and every month moved into it, would be gone after a reboot" --image "$LAB/mnt/ram/x.img" --size 4G --mountpoint /srv/r1 "${go[@]}"
  umount "$LAB/mnt/ram"
  # what a symlink leads to goes into fstab too
  mkdir -p "/hostfs/big disk/srv"
  ln -s "/hostfs/big disk/srv" /srv/spaced
  ln -s "/hostfs/big disk" /hostfs/imgs
  refuses "a cold directory that a symlink resolves to a path with a space" "the cold directory \\(from --mountpoint\\) resolves to '/hostfs/big disk/srv/pgcold'" --mountpoint /srv/spaced/pgcold --image /hostfs/a.img --size 4G "${go[@]}"
  refuses "an image path that a symlink resolves to one with a space" "the image path resolves to '/hostfs/big disk/c.img'" --image /hostfs/imgs/c.img --size 4G --mountpoint /srv/r1 "${go[@]}"
  rm -f /srv/spaced /hostfs/imgs
  rm -rf "/hostfs/big disk"
  truncate -s 4G /hostfs/zeros.img
  refuses "an existing file that holds no filesystem" 'is not a btrfs image labelled meshinfo-cold \(found: no filesystem\)' --image /hostfs/zeros.img --mountpoint /srv/r1 "${go[@]}"
  truncate -s 4G /hostfs/ext4.img && mkfs.ext4 -q -F /hostfs/ext4.img
  refuses "an existing ext4 image" 'is not a btrfs image labelled meshinfo-cold \(found: ext4\)' --image /hostfs/ext4.img --mountpoint /srv/r1 "${go[@]}"
  truncate -s 4G /hostfs/other.img && mkfs.btrfs -q -L other /hostfs/other.img
  refuses "an existing btrfs image with another label" 'found: btrfs, label other' --image /hostfs/other.img --mountpoint /srv/r1 "${go[@]}"
  truncate -s 4G /hostfs/sparse.img && mkfs.btrfs -q -L meshinfo-cold /hostfs/sparse.img
  refuses "an existing image of ours that is sparse" '/hostfs/sparse.img is sparse' --image /hostfs/sparse.img --mountpoint /srv/r1 "${go[@]}"
  rm -f /hostfs/zeros.img /hostfs/ext4.img /hostfs/other.img /hostfs/sparse.img
  mkdir -p /hostfs/adir
  refuses "an image path that is a directory" '/hostfs/adir exists and is not a regular file' --image /hostfs/adir --mountpoint /srv/r1 "${go[@]}"
  refuses "not enough room for the image: the numbers" 'not enough room for the image: /smallfs \(ext4\) has [0-9.]+ GiB free, and a 6\.0 GiB image plus 3\.0 GiB left for the host needs 9\.0 GiB\. .* \(at least 3\.0 GiB\)' --image /smallfs/cold.img --size 6G --mountpoint /srv/r1 "${go[@]}"

  make_disk blank 4G; blank="$DISK"
  refuses "a device that is a regular file" 'is not a block device' --device "$LAB/disks/blank.img" --mountpoint /srv/r2 "${go[@]}"
  make_disk sig-ext4 4G; mkfs.ext4 -q -F "$DISK"
  refuses "a device with a filesystem signature" "$DISK carries a signature \\(ext4 filesystem\\)" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  mapfile -t gone < <(hidden wipefs)
  PREFIX=(with_binds "${gone[@]}" --)
  refuses "... with --force but no wipefs" 'not found on this host: wipefs' --device "$DISK" --force --mountpoint /srv/r2 "${go[@]}"
  PREFIX=()
  # ext4 at 1 KiB and a btrfs superblock at 64 KiB: blkid cannot say which,
  # and names neither (older versions exit 8, newer ones as for a blank device)
  rm -f "$LAB/disks/donor.img"
  truncate -s 1G "$LAB/disks/donor.img" && mkfs.btrfs -q "$LAB/disks/donor.img"
  dd if="$LAB/disks/donor.img" of="$DISK" bs=4096 skip=16 seek=16 count=1 conv=notrunc status=none
  holds "(two signatures on one device: blkid -p names no filesystem)" bash -c "! blkid -p -o export $DISK | grep -q '^TYPE='"
  refuses "a device with two signatures, which blkid does not name" "$DISK carries a signature \\((signatures that blkid cannot tell apart|more than one signature, which blkid does not name: btrfs ext4)" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  # one signature that blkid does not accept (a byte of the superblock changed,
  # so its checksum fails): still a signature, and called what it is
  make_disk sig-damaged 4G; mkfs.ext4 -q -F "$DISK"
  printf 'X' | dd of="$DISK" bs=1 seek=$((1024 + 120)) conv=notrunc status=none
  holds "(a damaged ext4 superblock: blkid -p names no filesystem)" bash -c "! blkid -p -o export $DISK | grep -q '^TYPE='"
  refuses "a device with one signature that blkid does not accept" "$DISK carries a signature \\(a signature that blkid does not accept \\(damaged\\?\\): ext4\\)" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  changes_nothing "... with --force, the plan says what it erases (dry run)" --device "$DISK" --force --mountpoint /srv/r2 --no-env --dry-run
  said "... one signature, not several" "wipefs -a $DISK +# --force: erases a signature that blkid does not accept \\(damaged\\?\\): ext4"
  make_disk sig-gpt 4G; printf 'label: gpt\n' | sfdisk -q "$DISK" >/dev/null 2>&1
  refuses "a device with a partition table" "$DISK carries a signature \\(gpt partition table\\)" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  make_disk in-use 4G; mkfs.ext4 -q -F "$DISK"; mkdir -p "$LAB/mnt/in-use"; mount "$DISK" "$LAB/mnt/in-use"
  refuses "a device that is mounted" "is mounted at $LAB/mnt/in-use — it is in use" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  refuses "a device that is mounted, even with --force" "is mounted at $LAB/mnt/in-use — it is in use" --device "$DISK" --force --mountpoint /srv/r2 "${go[@]}"
  umount "$LAB/mnt/in-use"
  make_disk small 512M
  refuses "a device no move could ever fit on" "$DISK: 512\\.0 MiB is too small to ever take a month" --device "$DISK" --mountpoint /srv/r2 "${go[@]}"
  make_disk twin 4G; mkfs.btrfs -q -L meshinfo-cold "$DISK"
  refuses "a second filesystem with the label" "another filesystem labelled meshinfo-cold exists on $DISK" --device "$blank" --mountpoint /srv/r2 "${go[@]}"
  wipefs -a -q "$DISK"
  { head -n 1 /proc/swaps; grep -v '^Filename' /proc/swaps; printf '%s partition 1048572 0 -2\n' "$blank"; } > "$LAB/swaps"
  PREFIX=(with_binds "$LAB/swaps=/proc/swaps" --)
  refuses "a device that is active swap" "$blank (is in use as swap|\\(or a partition on it\\) is mounted at \\[SWAP\\])" --device "$blank" --mountpoint /srv/r2 "${go[@]}"
  stand_in quietlsblk lsblk 'exit 0'
  PREFIX=(with_binds "$LAB/swaps=/proc/swaps" -- env "PATH=$LINKED:$PATH")
  refuses "... also when lsblk does not show it" "$blank is in use as swap, not spare" --device "$blank" --mountpoint /srv/r2 "${go[@]}"
  PREFIX=()
  if dmsetup create coldlab-holder --table "0 $(blockdev --getsz "$blank") linear $blank 0" >/dev/null 2>&1; then
    refuses "a device another device is built on (device-mapper)" "$blank is in use by another device \\(dm-[0-9]+" --device "$blank" --mountpoint /srv/r2 "${go[@]}"
    refuses "... even with --force" "$blank is in use by another device" --device "$blank" --force --mountpoint /srv/r2 "${go[@]}"
    dmsetup remove coldlab-holder
  else
    fail "a device another device is built on (device-mapper)" "dmsetup could not make a mapping in this lab, so the refusal was not exercised"
  fi

  mkdir -p /btrfszstd/adopt
  new_project env-other; echo 'MESHINFO_PGCOLD_DIR=/elsewhere' > "$PROJ/.env"
  refuses ".env already names another cold directory" 'already sets MESHINFO_PGCOLD_DIR=/elsewhere, not /btrfszstd/adopt' --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  new_project env-zfs; echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.zfs.yml' > "$PROJ/.env"
  refuses ".env runs the full ZFS overlay" 'docker-compose.zfs.yml \(the full ZFS layout\)' --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  new_project env-zfs-vars; echo 'MESHINFO_ZFS_HOT=/tank/meshinfo/pgdata' > "$PROJ/.env"
  refuses ".env carries a variable only the full ZFS overlay reads" 'sets MESHINFO_ZFS_HOT, which only docker-compose.zfs.yml reads: this stack is set up for the full ZFS layout' --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  new_project env-badpath; echo 'MESHINFO_PGCOLD_DIR=/srv/cold storage' > "$PROJ/.env"
  refuses ".env names a cold directory that cannot go into fstab" "the cold directory '/srv/cold storage' \\(from MESHINFO_PGCOLD_DIR in .env\\) must be an absolute path made of" --project-dir "$PROJ" --yes
  mkdir -p "$LAB/proj/empty"
  refuses "a project directory without the compose files" 'has no docker-compose.yml and docker-compose.cold.yml' --existing /btrfszstd/adopt --project-dir "$LAB/proj/empty" --yes
  refuses "a project directory that does not exist" '--project-dir /nowhere/at/all is not a directory' --existing /btrfszstd/adopt --project-dir /nowhere/at/all --yes

  # a directory that was a cold directory before is never built over
  new_project named; echo 'MESHINFO_PGCOLD_DIR=/srv/named' > "$PROJ/.env"
  changes_nothing ".env names a directory that is not there yet: a fresh host (dry run)" --project-dir "$PROJ" --dry-run
  said "... which gets its image" 'Layout: btrfs in a preallocated loop image'
  mkdir -p /srv/named
  refuses ".env names it, it exists, nothing is mounted: no second store on top" '/srv/named is what \.env names as the cold directory, and it exists, but nothing is mounted there' --project-dir "$PROJ" --yes
  mkdir -p /srv/named/PG_18_202506291
  refuses "a tablespace on a filesystem that does not compress" '/srv/named holds a PostgreSQL tablespace \(a PG_\.\.\. directory\) but is on overlay without compression' --project-dir "$PROJ" --yes
  refuses "... with the layout named: never told to empty it" '/srv/named holds a PostgreSQL tablespace \(a PG_\.\.\. directory\) and is not the cold filesystem: .* do not empty it' --image /hostfs/a.img --size 4G --mountpoint /srv/named "${go[@]}"
  rm -rf /srv/named
  printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml\nMESHINFO_PGCOLD_DIR=/srv/named\n' > "$PROJ/.env"
  refuses ".env names it with the overlay (a setup that was completed) and the directory is gone: nothing is made in its place" '/srv/named is what \.env names as the cold directory, with docker-compose.cold.yml in COMPOSE_FILE, but the directory is not there' --project-dir "$PROJ" --yes
  changes_nothing "... naming the layout is the way through (dry run)" --image /hostfs/a.img --size 4G --project-dir "$PROJ" --dry-run

  refuses "--existing: no such directory" '/srv/not-there is not a directory' --existing /srv/not-there "${go[@]}"
  mkdir -p /hostfs/plain
  refuses "--existing: a directory on ext4" '/hostfs/plain is on ext4: closed months would move there but not compress' --existing /hostfs/plain "${go[@]}"
  mkdir -p /btrfshost/plain
  refuses "--existing: btrfs with compression off" 'compression is off for /btrfshost/plain \(btrfs\): there is neither a compress mount option nor a compression property; set one: btrfs property set /btrfshost/plain compression zstd' --existing /btrfshost/plain "${go[@]}"
  mkdir -p /btrfszstd/nocow && chattr +C /btrfszstd/nocow
  refuses "--existing: a No_COW directory, which btrfs never compresses" 'compression is off for /btrfszstd/nocow \(btrfs\): the directory has the No_COW attribute' --existing /btrfszstd/nocow "${go[@]}"
  mkdir -p /btrfszstd/full && touch /btrfszstd/full/notes.txt
  refuses "--existing: a directory with other files" '/btrfszstd/full holds something other than a tablespace \(notes.txt\)' --existing /btrfszstd/full "${go[@]}"
  mkdir -p /btrfszstd/bare
  echo 'UUID=0000-0000 /btrfszstd/bare btrfs defaults 0 0' >> /etc/fstab
  refuses "--existing: the bare mountpoint of something fstab mounts" '/etc/fstab has an entry for /btrfszstd/bare, but it is not mounted' --existing /btrfszstd/bare "${go[@]}"
  refuses "... and with no flag" '/etc/fstab already has an entry for /btrfszstd/bare that this script did not write, and it is not mounted' --mountpoint /btrfszstd/bare "${go[@]}"
  sed -i '\|/btrfszstd/bare|d' /etc/fstab
  rmdir /btrfszstd/bare
  make_fs btrfs foreign 4G /srv/foreign compress=zstd:3
  refuses "a btrfs somebody else mounted there, no layout flag" "/srv/foreign is already a btrfs mount point \\($DISK\\) that this script did not make — to use it as it is, pass --existing /srv/foreign" --mountpoint /srv/foreign "${go[@]}"
  setup --existing /srv/foreign "${go[@]}"
  ok "... which --existing adopts"
  is "... owner and mode set, still the same mount" "$(stat -c '%u:%g %a' /srv/foreign) $(findmnt -rn -M /srv/foreign -o SOURCE)" "999:999 750 $DISK"
  setup status --mountpoint /srv/foreign --project-dir "$LAB/proj/empty"
  ok "... and status does not ask for an fstab line of the script's"
  said "... it says whose mount it is" 'layout +a btrfs mounted from .* not made by this script'
  umount /srv/foreign && rmdir /srv/foreign

  refuses "--subvolume where the filesystem is not btrfs" '/hostfs is on ext4, not btrfs' --subvolume --mountpoint /hostfs/sv "${go[@]}"
  mkdir -p /btrfshost/busy && touch /btrfshost/busy/file
  refuses "--subvolume: a directory with files in the way" '/btrfshost/busy is not empty and is not a subvolume' --subvolume --mountpoint /btrfshost/busy "${go[@]}"
  touch /btrfshost/afile
  refuses "--subvolume: a file in the way" '/btrfshost/afile exists and is not a directory' --subvolume --mountpoint /btrfshost/afile "${go[@]}"
  btrfs subvolume create /btrfshost/rawsv >/dev/null
  refuses "--subvolume: a subvolume without the property" '/btrfshost/rawsv is a subvolume already, with no compression property — this script makes it with compression=zstd' --subvolume --mountpoint /btrfshost/rawsv "${go[@]}"
  btrfs property set /btrfshost/rawsv compression lzo
  refuses "--subvolume: a subvolume with another codec" '/btrfshost/rawsv is a subvolume already, with compression=lzo' --mountpoint /btrfshost/rawsv "${go[@]}"
  btrfs property set /btrfshost/rawsv compression zstd
  touch /btrfshost/rawsv/somebodys-file
  refuses "--subvolume: somebody's subvolume with files in it, no flag either" '/btrfshost/rawsv holds something other than a tablespace \(somebodys-file\)' --mountpoint /btrfshost/rawsv "${go[@]}"
  echo '/dev/null /btrfshost/fst ext4 defaults 0 0' >> /etc/fstab
  refuses "--subvolume where fstab mounts something" '/etc/fstab has an entry for /btrfshost/fst' --subvolume --mountpoint /btrfshost/fst "${go[@]}"
  sed -i '\|/btrfshost/fst|d' /etc/fstab

  refuses "grow: nothing is mounted there" 'there is no loop image mounted at /srv/nothing' grow --to 8G --mountpoint /srv/nothing --yes
  refuses "no terminal and no --yes" 'standard input is not a terminal' --image /hostfs/a.img --size 4G --mountpoint /srv/r3 --no-env

  # the final verification, on its own: on directories that fail one check each
  verify() { run bash -c 'source "$1"; KIND=existing; MOUNTPOINT="$2"; verify_cold_directory' sourced "$SCRIPT" "$1"; }
  verify /hostfs/plain
  said "verification: not btrfs or zfs" "verification failed: findmnt -no FSTYPE -T /hostfs/plain prints 'ext4', not btrfs or zfs"
  verify /btrfshost/plain
  said "verification: compression off" 'verification failed: compression is not on for /btrfshost/plain'
  mkdir -p /btrfszstd/rootowned
  verify /btrfszstd/rootowned
  said "verification: owner and mode" 'verification failed: /btrfszstd/rootowned is 0:0 mode 755, not 999:999 mode 750'

  # paths
  changes_nothing "doubled slashes and ./ in --mountpoint are folded (dry run)" --mountpoint /srv//slashes/./pgcold/ --image /hostfs/a.img --size 4G --no-env --dry-run
  said "... as the report shows" 'cold directory +/srv/slashes/pgcold \(from --mountpoint\)'

  # a change to .env that breaks compose is taken back
  new_project env-broken
  echo 'PG_SHARED_BUFFERS=512MB' > "$PROJ/.env"
  printf 'services:\n  postgres:\n    volumes: [\n' > "$PROJ/docker-compose.cold.yml"
  setup --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  exits "a .env change that breaks docker compose config is taken back: exit 1" 1
  said "... and says so" 'docker compose config fails with the new .env, so the previous one was put back'
  is "... .env is as it was" "$(cat "$PROJ/.env")" 'PG_SHARED_BUFFERS=512MB'
  rm -f "$PROJ/.env" "$PROJ"/.env.bak-*
  setup --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  exits "the same when there was no .env: exit 1" 1
  holds "... and none is left behind" test ! -e "$PROJ/.env"
  chown 0:0 /btrfszstd/adopt; chmod 755 /btrfszstd/adopt

  # failures halfway
  failing_tool nofallocate fallocate
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup --image /hostfs/failed.img --size 4G --mountpoint /srv/r4 "${go[@]}"
  exits "fallocate fails: exit 1" 1
  said "... says so" 'fallocate could not preallocate /hostfs/failed.img'
  holds "... and leaves no image behind" test ! -e /hostfs/failed.img
  is "... nor an fstab line" "$(grep -c /srv/r4 /etc/fstab)" 0
  failing_tool nomount mount
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup --image /hostfs/halfway.img --size 4G --mountpoint /srv/r5 "${go[@]}"
  exits "mount fails after the image and the fstab line were made: exit 1" 1
  said "... says what stays and how to back out" 'mount /srv/r5 failed \(its message is above\)\. The fstab line stays in place.* To back out instead: .*/etc/fstab\.bak-meshinfo-.* and delete /hostfs/halfway.img'
  PREFIX=()
  setup --image /hostfs/halfway.img --size 4G --mountpoint /srv/r5 "${go[@]}"
  ok "... and a second run finishes the job"
  said "... planning only what was missing" '1\. mount /srv/r5'
  silent_on "... not the image again" 'fallocate -l'
  is "... mounted, owned and moded" "$(findmnt -no FSTYPE -T /srv/r5) $(stat -c '%u:%g %a' /srv/r5)" "btrfs 999:999 750"
  # A mount that fails on a later run (after a reboot, say): this run made
  # neither the fstab line nor the image, and the image may hold the months.
  umount /srv/r5
  PREFIX=(env "PATH=$LINKED:$PATH")
  refuses "mount fails on a later run: the image that was there before is not what to delete" 'mount /srv/r5 failed \(its message is above\)\. The fstab line and /hostfs/halfway.img were there before this run and stay as they are' --mountpoint /srv/r5 "${go[@]}"
  said "... it may hold the months" 'Do not delete the image to start over unless this is still the first setup: once months were moved, it is their only copy'
  silent_on "... and backing out by deleting it is not offered" 'To back out instead|and delete /hostfs/halfway.img'
  PREFIX=()
  forget_cold /srv/r5
  # the image is there (made by hand, or by a run that did not get as far as
  # fstab) and this run adds the fstab line: only the line is the run's own
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup --image /hostfs/halfway.img --mountpoint /srv/r5 "${go[@]}"
  exits "mount fails with the image there before and the fstab line new: exit 1" 1
  said "... backing out is taking the lines out, not deleting the image" 'To back out instead: take the two lines this script added out of /etc/fstab \(the file as it was: /etc/fstab\.bak-meshinfo-[0-9-]+\)\. /hostfs/halfway.img was there before this run and stays as it is: once months were moved, it is their only copy'
  holds "... and the image is still there" test -f /hostfs/halfway.img
  PREFIX=()
  forget_cold /srv/r5
  rm -f /hostfs/halfway.img
  # with nofail in the fstab line, mount can return 0 without mounting
  stand_in quietmount mount 'exit 0'
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup --image /hostfs/quiet.img --size 4G --mountpoint /srv/r7 "${go[@]}"
  exits "mount returns 0 without mounting anything: exit 1" 1
  said "... says so" 'mount /srv/r7 returned without mounting anything'
  is "... and the bare directory was not handed to postgres" "$(stat -c '%u:%g %a' /srv/r7)" "0:0 755"
  PREFIX=()
  forget_cold /srv/r7
  rm -f /hostfs/quiet.img

  # the question
  at_a_terminal n --image /hostfs/asked.img --size 4G --mountpoint /srv/r6 --no-env
  exits "at a terminal, answering n: exit 1" 1
  said "... the question was asked" 'Go ahead\? \[y/N\]'
  said "... and nothing was done" 'stopped; nothing was changed'
  holds "... really nothing" test ! -e /hostfs/asked.img -a ! -e /srv/r6
  at_a_terminal y --existing /btrfszstd/adopt --no-env
  ok "at a terminal, answering y: it goes ahead"
  is "... and did the work" "$(stat -c '%u:%g %a' /btrfszstd/adopt)" "999:999 750"
  chown 0:0 /btrfszstd/adopt; chmod 755 /btrfszstd/adopt

  # a blank partition is the documented --device case: it must not need --force
  if make_partition parted 5G; then
    part="$PART"
    # A node at the partition's name with other numbers — what an earlier run
    # in a kept container leaves behind — is never taken over. (No device
    # has major 4000: whoever took this node over would open nothing.)
    rm -f "$part"
    mknod "$part" b 4000 9
    partition_node
    is "(a partition node left over from an earlier run is made anew, with the numbers the kernel gives the partition now)" "$(stat -c '%Hr:%Lr' "$part")" "$(cat "/sys/block/${DISK##*/}/${DISK##*/}p1/dev")"
    refuses "the whole disk around it is still refused" "$DISK carries a signature \\(gpt partition table\\)" --device "$DISK" --mountpoint /srv/part "${go[@]}"
    setup --device "$part" --mountpoint /srv/part "${go[@]}"
    ok "a blank partition is taken without --force"
    silent_on "... nothing is erased" 'wipefs'
    is "... and is the cold btrfs" "$(blkid -p -o value -s TYPE "$part") $(blkid -p -o value -s LABEL "$part") $(findmnt -rn -M /srv/part -o SOURCE)" "btrfs meshinfo-cold $part"
    changes_nothing "... re-run" --device "$part" --mountpoint /srv/part "${go[@]}"
    forget_cold /srv/part
    wipefs -a -q "$part"
  else
    fail "a blank partition is taken without --force" "the lab could not get a partition device for $DISK"
  fi
}

t_dry_runs() {
  section "--dry-run changes nothing"
  new_project dry
  changes_nothing "dry run: no arguments (an image, the default path)" --dry-run --project-dir "$PROJ"
  said "what it found: the host" 'host +Debian GNU/Linux .* \(debian family\)'
  said "what it found: btrfs" 'btrfs in kernel +yes'
  said "what it found: ZFS" 'ZFS pools +none'
  said "what it found: the cold directory" "cold directory +$MP \\(from the default\\): not there yet; /srv(/meshinfo)? is on overlay"
  said "what it found: the stack" "stack +$PROJ: no \\.env yet; the stack is not running"
  said "... prints the plan" "fallocate -l $((20 * GIB)) $DEFAULT_IMAGE"
  said "... and why the size" '20\.0 GiB: the default, because the stack in .* is not running'
  said "... and says nothing was changed" 'Dry run: nothing was changed'
  make_disk dry 4G
  changes_nothing "dry run: a device" --device "$DISK" --dry-run --project-dir "$PROJ"
  said "... prints the plan" "mkfs.btrfs -L meshinfo-cold $DISK"
  changes_nothing "dry run: already btrfs" --mountpoint /btrfshost/dry/pgcold --dry-run --project-dir "$PROJ"
  said "... prints the plan" 'btrfs subvolume create /btrfshost/dry/pgcold'
  mkdir -p /btrfszstd/adopt   # (there already when the sections before this one ran)
  chown 0:0 /btrfszstd/adopt; chmod 755 /btrfszstd/adopt
  changes_nothing "dry run: an existing directory" --existing /btrfszstd/adopt -n --project-dir "$PROJ"
  said "... prints the plan" 'chown 999:999 /btrfszstd/adopt && chmod 750 /btrfszstd/adopt'
  # a system that keeps /etc in memory loses the fstab line at the next boot
  mkdir -p "$LAB/mnt/etc-in-ram" && mount -t tmpfs tmpfs "$LAB/mnt/etc-in-ram"
  cp /etc/fstab "$LAB/mnt/etc-in-ram/fstab"
  PREFIX=(with_binds "$LAB/mnt/etc-in-ram/fstab=/etc/fstab" --)
  changes_nothing "dry run where /etc/fstab is on tmpfs" --dry-run --project-dir "$PROJ"
  said "... warns that the line will not survive a reboot" '/etc/fstab is on a filesystem that lives in memory'
  PREFIX=()
  umount "$LAB/mnt/etc-in-ram"
}

t_image() {
  local image=/hostfs/meshinfo-cold.img source options sum want
  section "an image on ext4"
  new_project image
  setup --image="$image" --size=4G --project-dir "$PROJ" -y
  ok "setup"
  said "the layout and why" 'Layout: btrfs in a preallocated loop image, /hostfs/meshinfo-cold.img — asked for with --image'
  ends_with_the_two_steps "ends with the two steps that remain, in order"
  is "the image: 4 GiB, mode 600, root's" "$(stat -c '%s %a %u' "$image")" "$((4 * GIB)) 600 0"
  holds "the image is fully allocated" test "$(allocated_bytes "$image")" -ge "$((4 * GIB))"
  is "the image holds a btrfs labelled meshinfo-cold" "$(blkid -p -o value -s TYPE "$image") $(blkid -p -o value -s LABEL "$image")" "btrfs meshinfo-cold"
  want="$(documented_fstab_line image | sed "s|/var/lib/meshinfo-cold.img|$image|")"
  is "the fstab line is the one ZFS.md documents" "$(grep -F " $MP " /etc/fstab)" "$want"
  holds "a copy of fstab was kept" bash -c 'ls /etc/fstab.bak-meshinfo-*'
  source="$(findmnt -rn -M "$MP" -o SOURCE)"
  options="$(findmnt -rn -M "$MP" -o OPTIONS)"
  is "mounted from the image" "$(losetup -n -O BACK-FILE "$source" | sed 's/ *$//')" "$image"
  holds "mounted with compress-force=zstd:9 and noatime" grep -Eq '(^|,)noatime,.*compress-force=zstd:9(,|$)' <<<"$options"
  holds "mounted without discard" bash -c "! grep -q discard <<<'$options'"
  is "findmnt -no FSTYPE -T prints btrfs" "$(findmnt -no FSTYPE -T "$MP")" btrfs
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' "$MP")" "999:999 750"
  is ".env, no file before: the two lines" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$MP"

  changes_nothing "re-run with the same arguments" --image "$image" --size 4G --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "re-run with no layout flag" --project-dir "$PROJ" --yes
  said "... recognises the image" 'it is mounted there already'
  changes_nothing "re-run with the word setup" setup --project-dir "$PROJ" --yes
  refuses "a larger --size for the image that is there" 'already exists with 4\.0 GiB, smaller than the 9\.0 GiB asked with --size — to enlarge it: .* grow --to 9G' --image "$image" --size 9G --project-dir "$PROJ" --yes
  refuses "another image for the same mountpoint" 'already the mount of another image, /hostfs/meshinfo-cold.img' --image /hostfs/second.img --size 4G --project-dir "$PROJ" --yes
  refuses "the same image for another mountpoint" "/etc/fstab already mounts $image at $MP: it is that cold directory's filesystem" --image "$image" --mountpoint /srv/second --no-env --yes
  make_disk rival 4G
  refuses "another layout for the same mountpoint" 'which is not that layout' --device "$DISK" --project-dir "$PROJ" --yes

  setpriv --reuid=999 --regid=999 --clear-groups bash -c "yes 'a closed month of packets, as repetitive as archives are' | head -c 300M > $MP/blob"
  sync
  sum="$(sha256sum < "$MP/blob")"
  holds "what uid 999 writes there is compressed at least 5x" bash -c "compsize -b $MP | awk '\$1 == \"TOTAL\" { exit !(\$4 / \$3 >= 5) }'"
  setup status --project-dir "$PROJ"
  ok "status"
  said "status: what is set up" 'layout +btrfs in a loop image: /hostfs/meshinfo-cold.img on /dev/loop'
  said "status: the image" 'image +4\.0 GiB, fully allocated'
  said "status: size, used, free" 'space +4\.0 GiB in all, [0-9.]+ [KMG]iB used, [0-9.]+ GiB free'
  said "status: the compression ratio" 'compression +[0-9.]+x \(300\.0 MiB stored in'
  said "status: the fstab entry" "fstab +$image +$MP +btrfs"
  said "status: .env" '\.env +MESHINFO_PGCOLD_DIR=/srv/meshinfo/pgcold, COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml'
  said "status: the containers" 'postgres: not running'

  # the periodic fstrim would hand the preallocation back; the fstab line keeps it away
  run fstrim --listed-in /etc/fstab:/proc/self/mountinfo --verbose
  silent_on "what the fstrim timer runs skips the cold mount" "$MP"
  holds "... and the image stays fully allocated" test "$(allocated_bytes "$image")" -ge "$((4 * GIB))"
  fstrim "$MP"; sync
  holds "(an fstrim of the mount by hand does punch the preallocation out)" test "$(allocated_bytes "$image")" -lt "$((2 * GIB))"
  setup status --project-dir "$PROJ"
  exits "status of an image that is no longer fully allocated: exit 1" 1
  said "... says what happened and how to put it back" "of which only [0-9.]+ [KMG]iB is ALLOCATED: .* fallocate -l $((4 * GIB)) $image"
  refuses "... and setup refuses it the same way" "$image is sparse .* fallocate -l $((4 * GIB)) $image" --project-dir "$PROJ" --yes
  fallocate -l "$((4 * GIB))" "$image"
  setup status --project-dir "$PROJ"
  ok "... after that fallocate, status is clean again"
  is "... and the data is intact" "$(sha256sum < "$MP/blob")" "$sum"

  # a filesystem that went read-only (btrfs does that after an error) takes no move
  mount -o remount,ro "$MP"
  setup status --project-dir "$PROJ"
  exits "the cold filesystem is mounted read-only: status exits 1" 1
  said "... and says so" 'the filesystem is mounted READ-ONLY'
  mount -o remount,rw "$MP"
  setup status --project-dir "$PROJ"
  ok "... read-write again, status is clean"

  umount "$MP"
  setup status --project-dir "$PROJ"
  exits "status of an unmounted image: exit 1" 1
  said "... says so" 'NOT MOUNTED'
  refuses "grow while unmounted" "$MP is not mounted — mount it first" grow --to 6G --yes --project-dir "$PROJ"
  refuses "the unmounted image for another mountpoint: fstab still names it" "/etc/fstab already mounts $image at $MP" --image "$image" --mountpoint /srv/second --no-env --yes
  mount -o loop,noatime "$image" "$MP"
  refuses "mounted by hand without compression: verification fails" "verification failed: $MP is mounted with .* without compress-force=zstd:9" --project-dir "$PROJ" --yes
  umount "$MP"
  setup --project-dir "$PROJ" --yes
  ok "re-run while unmounted"
  said "... finds the layout in fstab" '/etc/fstab already has it for this directory'
  holds "... and mounts it" findmnt -rn -M "$MP"
  umount "$MP" && mount -a
  holds "mount -a (a reboot) mounts it from the fstab line" findmnt -rn -M "$MP"

  changes_nothing "grow --dry-run" grow --to 6G --dry-run --project-dir "$PROJ"
  setup grow --to 6G --yes --project-dir "$PROJ"
  ok "grow --to 6G, online"
  is "grow: the image is 6 GiB" "$(stat -c %s "$image")" "$((6 * GIB))"
  holds "grow: fully allocated" test "$(allocated_bytes "$image")" -ge "$((6 * GIB))"
  is "grow: the filesystem is 6 GiB" "$(($(stat -f -c '%b * %S' "$MP")))" "$((6 * GIB))"
  is "grow: still the same mount" "$(findmnt -rn -M "$MP" -o SOURCE)" "$source"
  is "grow: the data is intact" "$(sha256sum < "$MP/blob")" "$sum"
  refuses "grow to a smaller size" 'is not larger — grow only enlarges' grow --to 5G --yes --project-dir "$PROJ"
  refuses "grow to the size it has" 'is 6\.0 GiB already; --to 6G \(6\.0 GiB\) is not larger' grow --to 6G --yes --project-dir "$PROJ"
  refuses "grow beyond what the host has: the numbers" 'not enough room: growing /hostfs/meshinfo-cold.img from 6\.0 GiB to 100\.0 GiB takes 94\.0 GiB more, plus 3\.0 GiB left for the host — 97\.0 GiB in all' grow --to 100G --yes --project-dir "$PROJ"
  changes_nothing "re-run after grow" --project-dir "$PROJ" --yes
  changes_nothing "re-run after grow with the --size it was made with" --image "$image" --size 4G --project-dir "$PROJ" --yes
  failing_tool nofallocate fallocate
  PREFIX=(env "PATH=$LINKED:$PATH")
  refuses "grow when fallocate fails" 'fallocate could not extend /hostfs/meshinfo-cold.img; the filesystem inside is unchanged' grow --to 7G --yes --project-dir "$PROJ"
  # a grow that stops after fallocate can be finished by asking again
  # shellcheck disable=SC2016  # the stand-in's own text
  stand_in noresize btrfs 'if [ "$1 $2" = "filesystem resize" ]; then echo "btrfs: resize made to fail by the lab" >&2; exit 1; fi; exec /usr/bin/btrfs "$@"'
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup grow --to 7G --yes --project-dir "$PROJ"
  exits "grow that stops at the resize: exit 1" 1
  said "... says how to finish" 'the image itself is 7\.0 GiB now; to finish: .* grow --to 7G'
  PREFIX=()
  setup status --project-dir "$PROJ"
  exits "... status sees the unfinished grow: exit 1" 1
  said "... and names the command" 'the filesystem is SMALLER than its image \(7\.0 GiB\): a grow was not finished\. Finish it: .* grow --to 7168M'
  setup grow --to 7G --yes --project-dir "$PROJ"
  ok "... asking again finishes it"
  said "... without allocating again" 'Finishing an earlier grow'
  is "... the filesystem is 7 GiB" "$(($(stat -f -c '%b * %S' "$MP")))" "$((7 * GIB))"
  is "... the data is intact" "$(sha256sum < "$MP/blob")" "$sum"
  # ... also when the step is small: 32 MiB on 7 GiB, under half a percent
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup grow --to 7200M --yes --project-dir "$PROJ"
  exits "a small grow that stops at the resize: exit 1" 1
  said "... says how to finish" 'to finish: .* grow --to 7200M'
  PREFIX=()
  setup status --project-dir "$PROJ"
  exits "... status sees it as well: exit 1" 1
  said "... and names the command" 'a grow was not finished\. Finish it: .* grow --to 7200M'
  setup grow --to 7200M --yes --project-dir "$PROJ"
  ok "... and that command finishes it"
  said "... without allocating again" 'Finishing an earlier grow'
  is "... the filesystem is 7200 MiB" "$(($(stat -f -c '%b * %S' "$MP")))" "$((7200 * MIB))"
  refuses "... after which asking for that size again is refused as before" 'is not larger — grow only enlarges' grow --to 7200M --yes --project-dir "$PROJ"
  setup status --project-dir "$PROJ"
  ok "... and status is clean"
  # ... and when it is the smallest step that can be asked for: one MiB
  PREFIX=(env "PATH=$LINKED:$PATH")
  setup grow --to 7201M --yes --project-dir "$PROJ"
  exits "a grow by one MiB that stops at the resize: exit 1" 1
  PREFIX=()
  setup status --project-dir "$PROJ"
  exits "... status sees that one too: exit 1" 1
  said "... and names the command" 'a grow was not finished\. Finish it: .* grow --to 7201M'
  setup grow --to 7201M --yes --project-dir "$PROJ"
  ok "... which finishes it"
  said "... without allocating again" 'Finishing an earlier grow'
  is "... the filesystem is 7201 MiB" "$(($(stat -f -c '%b * %S' "$MP")))" "$((7201 * MIB))"
  # ... and an image that somebody enlarged by hand to a size that is not a
  # whole number of MiB, without the two steps after it: --to counts in MiB
  fallocate -l "$((7201 * MIB + 600 * 1024))" "$image"
  setup status --project-dir "$PROJ"
  exits "an image enlarged by hand to 7201 MiB and 600 KiB: status exits 1" 1
  said "... and names the size just below as the command" 'a grow was not finished\. Finish it: .* grow --to 7201M'
  setup grow --to 7201M --yes --project-dir "$PROJ"
  ok "... which finishes it, although the image is a little larger than that"
  said "... without allocating again" 'Finishing an earlier grow'
  silent_on "... and without asking for room that a finish does not need" 'not enough room'
  setup status --project-dir "$PROJ"
  ok "... and status is clean"
  refuses "... after which that size is refused as before" 'is not larger — grow only enlarges' grow --to 7201M --yes --project-dir "$PROJ"

  rm -f "$image"
  refuses "the image deleted while mounted: setup" "$MP is mounted from $image, but that file is gone" --project-dir "$PROJ" --yes
  refuses "the image deleted while mounted: grow" "$image, the image behind /dev/loop[0-9]+, is not there any more" grow --to 8G --yes --project-dir "$PROJ"
  setup status --project-dir "$PROJ"
  exits "the image deleted while mounted: status exits 1" 1
  said "... and says so" 'IS GONE \(deleted, or replaced at its path, while mounted\)'
  # another file at that path (a restore, rsync without --inplace) is not the image the mount uses
  truncate -s 1G "$image"
  refuses "another file put at the path of the mounted image: setup is not taken in" "$MP is mounted from $image, but that file is gone" --project-dir "$PROJ" --yes
  refuses "... nor is grow, which leaves that file alone" "$image, the image behind /dev/loop[0-9]+, is not there any more" grow --to 8G --yes --project-dir "$PROJ"
  setup status --project-dir "$PROJ"
  said "... and status says the same" 'IS GONE \(deleted, or replaced at its path, while mounted\)'
  rm -f "$image"
  umount "$MP"
  refuses "fstab names an image that is not there (its filesystem not mounted?): none is made in its place" "/etc/fstab mounts $image at $MP, but that file is not there" --project-dir "$PROJ" --yes
  forget_cold "$MP"

  # ZFS.md's commands, by hand: the script must find nothing left to do
  fallocate -l 4G /hostfs/byhand.img
  chmod 600 /hostfs/byhand.img
  mkfs.btrfs -q -L meshinfo-cold /hostfs/byhand.img
  mkdir -p /srv/byhand
  documented_fstab_line image | sed -e 's|/var/lib/meshinfo-cold.img|/hostfs/byhand.img|' -e 's|/srv/meshinfo/pgcold|/srv/byhand|' >> /etc/fstab
  mount /srv/byhand
  chown 999:999 /srv/byhand && chmod 750 /srv/byhand
  changes_nothing "a host set up by hand with ZFS.md's commands: nothing to change" --mountpoint /srv/byhand --no-env --yes
  said "... recognised as the image layout" 'Layout: btrfs in a preallocated loop image, /hostfs/byhand.img — it is mounted there already'
  said "... with nothing in the plan" 'nothing to change'
  forget_cold /srv/byhand
  mkdir -p /srv/byhand2 && mount -o loop,compress-force=zstd:9 /hostfs/byhand.img /srv/byhand2
  refuses "an image that is mounted somewhere, with no fstab line: not given a second mountpoint" "/hostfs/byhand.img is already mounted at /srv/byhand2: it is that cold directory's filesystem" --image /hostfs/byhand.img --mountpoint /srv/byhand --no-env --yes
  umount /srv/byhand2 && rmdir /srv/byhand2
  chmod 644 /hostfs/byhand.img
  setup --image /hostfs/byhand.img --mountpoint /srv/byhand --no-env --yes
  ok "an image made by hand without chmod 600"
  said "... the plan closes it" 'chmod 600 /hostfs/byhand.img'
  is "... and it is 600 afterwards" "$(stat -c %a /hostfs/byhand.img)" 600
  forget_cold /srv/byhand
  rm -f /hostfs/byhand.img

  # a cold directory reached through a symlink, named in .env as it was typed
  mkdir -p /hostfs/realsrv
  ln -s /hostfs/realsrv /srv/link
  new_project symlinked
  echo 'MESHINFO_PGCOLD_DIR=/srv/link/pgcold' > "$PROJ/.env"
  setup --image /hostfs/sym.img --size 4G --project-dir "$PROJ" --yes
  ok "a cold directory behind a symlink, taken from .env"
  is "... mounted at the real path" "$(findmnt -rn -M /hostfs/realsrv/pgcold -o FSTYPE)" btrfs
  is "... .env keeps the name as typed and gains the overlay" "$(cat "$PROJ/.env")" "MESHINFO_PGCOLD_DIR=/srv/link/pgcold
COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml"
  changes_nothing "... the re-run does not trip over its own .env" --project-dir "$PROJ" --yes
  setup status --project-dir "$PROJ"
  ok "... nor does status"
  # the same line as somebody would write it by hand: through the symlink
  sed -i 's|  /hostfs/realsrv/pgcold  |  /srv/link/pgcold  |' /etc/fstab
  holds "(the fstab line now names the mountpoint through the symlink)" grep -q '  /srv/link/pgcold  btrfs' /etc/fstab
  changes_nothing "... an fstab line that spells the mountpoint through the symlink is the same line" --project-dir "$PROJ" --yes
  said "... nothing to add" 'nothing to change'
  changes_nothing "... also with the layout named" --image /hostfs/sym.img --project-dir "$PROJ" --yes
  setup status --project-dir "$PROJ"
  ok "... and status finds it"
  sed -i '\|/srv/link/pgcold|d' /etc/fstab
  forget_cold /hostfs/realsrv/pgcold
  rm -f /hostfs/sym.img /srv/link
  rmdir /hostfs/realsrv
}

t_default() {
  section "no arguments, stack not running: the default image, 20 GiB"
  new_project default
  setup --project-dir "$PROJ" --yes
  ok "setup"
  said "the layout and why" "Layout: btrfs in a preallocated loop image, $DEFAULT_IMAGE — no ZFS pool, and /srv(/meshinfo)? is on overlay"
  said "the size and why" '20\.0 GiB: the default, because the stack in .* is not running'
  said "what stays free on the host" '/var/lib \(overlay\) has [0-9.]+ GiB free; [0-9.]+ GiB stay free afterwards'
  is "the image is 20 GiB" "$(stat -c %s "$DEFAULT_IMAGE")" "$((20 * GIB))"
  holds "... fully allocated" test "$(allocated_bytes "$DEFAULT_IMAGE")" -ge "$((20 * GIB))"
  is "mounted at the default mountpoint, btrfs" "$(findmnt -no FSTYPE -T "$MP")" btrfs
  is "the fstab line is the one ZFS.md documents, to the letter" "$(grep -F " $MP " /etc/fstab)" "$(documented_fstab_line image)"
  changes_nothing "re-run" --project-dir "$PROJ" --yes
  forget_cold "$MP"
  rm -f "$DEFAULT_IMAGE"
}

t_device() {
  local device used
  section "a spare block device (a loop device)"
  new_project device
  make_disk spare 6G; device="$DISK"
  setup --device "$device" --project-dir "$PROJ" --yes
  ok "setup"
  is "btrfs labelled meshinfo-cold" "$(blkid -p -o value -s TYPE "$device") $(blkid -p -o value -s LABEL "$device")" "btrfs meshinfo-cold"
  is "the fstab line is the one ZFS.md documents, to the letter" "$(grep -F " $MP " /etc/fstab)" "$(documented_fstab_line device)"
  is "mounted from the device" "$(findmnt -rn -M "$MP" -o SOURCE)" "$device"
  holds "mounted with compress-force=zstd:9" bash -c "findmnt -rn -M $MP -o OPTIONS | grep -q 'compress-force=zstd:9'"
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' "$MP")" "999:999 750"
  is ".env" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$MP"
  changes_nothing "re-run with the same arguments" --device "$device" --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "re-run with no layout flag" --project-dir "$PROJ" --yes
  changes_nothing "re-run with --force: still not reformatted" --device "$device" --force --project-dir "$PROJ" --yes
  umount "$MP" && mount -a
  is "mount -a (a reboot) mounts it by label" "$(findmnt -rn -M "$MP" -o SOURCE)" "$device"
  setup status --project-dir "$PROJ"
  ok "status"
  said "status: what is set up" "layout +btrfs on the block device $device"
  refuses "grow on a device: says what to do instead" "Enlarge the partition or volume underneath .* btrfs filesystem resize max $MP" grow --to 10G --yes --project-dir "$PROJ"
  make_disk other 4G
  refuses "another device for the same mountpoint" "$MP is already the mount of another device, $device" --device "$DISK" --project-dir "$PROJ" --yes
  refuses "the same device for another mountpoint" "$device already holds the meshinfo-cold filesystem, mounted at $MP and not at /srv/elsewhere" --device "$device" --mountpoint /srv/elsewhere --no-env --yes
  umount "$MP"
  failing_tool nomount mount
  PREFIX=(env "PATH=$LINKED:$PATH")
  refuses "mount fails on a later run: the filesystem on the device may hold the months" "mount $MP failed \\(its message is above\\)\\. The fstab line was there before this run and stays as it is.* Once months were moved, the filesystem on $device is their only copy" --project-dir "$PROJ" --yes
  silent_on "... and no backing out is offered" 'To back out instead'
  PREFIX=()
  wipefs -a -q "$device"
  refuses "fstab mounts by label, but the device is gone" "/etc/fstab mounts LABEL=meshinfo-cold at $MP, but no device carries that label now" --project-dir "$PROJ" --yes
  forget_cold "$MP"

  make_disk used 4G; used="$DISK"; mkfs.ext4 -q -F "$used"
  new_project device-force
  refuses "a used device without --force" "$used carries a signature \\(ext4 filesystem\\)" --device "$used" --project-dir "$PROJ" --yes
  setup --device "$used" --force --project-dir "$PROJ" --yes
  ok "the same device with --force"
  said "... the plan says what it erases" "wipefs -a $used +# --force: erases ext4 filesystem"
  is "... and it is the cold btrfs now" "$(blkid -p -o value -s TYPE "$used") $(blkid -p -o value -s LABEL "$used") $(findmnt -rn -M "$MP" -o SOURCE)" "btrfs meshinfo-cold $used"
  forget_cold "$MP"
  wipefs -a -q "$used"
}

t_subvolume() {
  local sv=/btrfshost/meshinfo/pgcold fstab id
  section "the host is already on btrfs: a subvolume"
  new_project subvolume
  fstab="$(sha256sum < /etc/fstab)"
  setup --mountpoint "$sv" --project-dir "$PROJ" --yes
  ok "setup, no layout flag"
  said "the layout and why" 'Layout: a btrfs subvolume with the compression property — /btrfshost, which will hold the cold directory, is already on btrfs'
  holds "it is a subvolume" btrfs subvolume show "$sv"
  is "with the compression property" "$(btrfs property get "$sv" compression)" "compression=zstd"
  is "findmnt -no FSTYPE -T prints btrfs" "$(findmnt -no FSTYPE -T "$sv")" btrfs
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' "$sv")" "999:999 750"
  is "fstab is not touched" "$(sha256sum < /etc/fstab)" "$fstab"
  is ".env" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$sv"
  setpriv --reuid=999 --regid=999 --clear-groups bash -c "yes 'a closed month of packets, as repetitive as archives are' | head -c 200M > $sv/blob"
  sync
  holds "what uid 999 writes there is compressed at least 5x" bash -c "compsize -b $sv | awk '\$1 == \"TOTAL\" { exit !(\$4 / \$3 >= 5) }'"
  rm -f "$sv/blob"
  # the fingerprint cannot tell an empty subvolume from one made anew in its
  # place: the plan and the subvolume's own id can
  id="$(subvolume_id "$sv")"
  holds "(the subvolume has an id: $id)" test -n "$id"
  changes_nothing "re-run with the same arguments" --mountpoint "$sv" --project-dir "$PROJ" --yes
  said "... recognises the subvolume" 'it is there already'
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "re-run with --subvolume" --subvolume --mountpoint "$sv" --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "re-run with no arguments but the project" --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  is "... and it is still the subvolume that was made, not a new one in its place" "$(subvolume_id "$sv")" "$id"
  changes_nothing "--size where the layout is a subvolume: not used, and said so (dry run)" --size 40G --dry-run --mountpoint /btrfshost/sized/pgcold --no-env
  said "... in so many words" 'warn: --size 40G is not used: it is the size of a new loop image, and the layout here is a btrfs subvolume with the compression property — a subvolume shares the room of its filesystem'
  setup status --project-dir "$PROJ"
  ok "status"
  said "status: what is set up" 'layout +a btrfs subvolume'
  said "status: compression" 'filesystem +btrfs, compression on \(btrfs property compression=zstd\)'
  said "status: the space is shared" 'shared with the rest of that filesystem'
  said "status: no fstab entry is needed" 'fstab +none \(this layout needs none\)'
  echo "/dev/null $sv ext4 defaults 0 0" >> /etc/fstab
  setup status --project-dir "$PROJ"
  exits "status with an fstab entry that would mount over the subvolume: exit 1" 1
  said "... flags it" 'fstab +UNEXPECTED entry for this directory'
  sed -i "\\|/dev/null ${sv} |d" /etc/fstab
  refuses "grow on a subvolume: says what to do instead" 'is a btrfs subvolume: it shares its filesystem' grow --to 10G --yes --project-dir "$PROJ"
  forget_cold "$sv"

  mkdir -p /btrfshost/second
  setup --subvolume --mountpoint /btrfshost/second --no-env --yes
  ok "--subvolume with an empty directory in the way"
  said "... the plan replaces it" 'rmdir /btrfshost/second'
  holds "... by a subvolume" btrfs subvolume show /btrfshost/second
  said "--no-env: the first line to add by hand" 'COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml'
  said "--no-env: the second" 'MESHINFO_PGCOLD_DIR=/btrfshost/second'
  forget_cold /btrfshost/second
}

t_existing() {
  local adopt=/btrfszstd/adopt original fstab
  section "--existing, and what happens to .env"
  mkdir -p "$adopt"
  chown 0:0 "$adopt"; chmod 755 "$adopt"

  new_project env-none
  chown 1234:1234 "$PROJ"
  fstab="$(sha256sum < /etc/fstab)"
  setup --existing "$adopt" --project-dir "$PROJ" --yes
  ok "adopt a directory on btrfs mounted with compression"
  said "the layout" 'Layout: an existing directory, adopted as it is — asked for with --existing'
  said "how compression is on" 'compression is on: mount option compress=zstd:3'
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' "$adopt")" "999:999 750"
  is "nothing was created: fstab is as it was" "$(sha256sum < /etc/fstab)" "$fstab"
  is ".env, no file before: the two lines" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$adopt"
  is ".env, no file before: owned like the project directory, mode 644" "$(stat -c '%u:%g %a' "$PROJ/.env")" "1234:1234 644"
  holds ".env: docker compose config shows the bind" bash -c "cd $PROJ && docker compose config | grep -A1 'source: $adopt' | grep -q 'target: /var/lib/postgresql/cold'"
  changes_nothing "re-run" --existing "$adopt" --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  is "... and makes no backup of a file it did not change" "$(find "$PROJ" -name '.env.bak-*' | wc -l)" 0
  changes_nothing "re-run without the flag: .env names the directory" --project-dir "$PROJ" --yes
  said "... and it is taken as it is, not built over" 'Layout: an existing directory, adopted as it is — \.env already names it as the cold directory, and it is on btrfs with compression on'
  mkdir "$adopt/PG_18_202506291" && chown 999:999 "$adopt/PG_18_202506291"
  changes_nothing "re-run once the tablespace is in it" --existing "$adopt" --project-dir "$PROJ" --yes
  chmod 700 "$adopt"
  changes_nothing "re-run once PostgreSQL has made it 700" --project-dir "$PROJ" --yes
  chmod 750 "$adopt"
  rmdir "$adopt/PG_18_202506291"
  setup status --mountpoint "$adopt" --project-dir "$PROJ"
  ok "status"
  said "status: what is there" 'layout +a directory on btrfs'

  # .env names a directory on a compressing filesystem that nobody has handed
  # to postgres yet: it could as well be the bare mountpoint of a filesystem
  # that is away, so it takes --existing to say that the directory is meant
  new_project env-ahead
  mkdir -p /btrfszstd/named-only
  echo 'MESHINFO_PGCOLD_DIR=/btrfszstd/named-only' > "$PROJ/.env"
  refuses ".env names a root-owned directory on a compressing filesystem, no flag, no database to ask" '/btrfszstd/named-only is what \.env names as the cold directory\. It is on btrfs with compression on, but it is not a filesystem of its own and does not belong to 999:999 yet' --project-dir "$PROJ" --yes
  setup --existing /btrfszstd/named-only --project-dir "$PROJ" --yes
  ok "... --existing says that this directory is meant"
  changes_nothing "... and after that the plain re-run knows it" --project-dir "$PROJ" --yes
  rmdir /btrfszstd/named-only

  new_project env-existing
  cp "$REPO/.env.sample" "$PROJ/.env"
  printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml\nPG_SHARED_BUFFERS=1GB\n' >> "$PROJ/.env"
  echo 'services: {}' > "$PROJ/docker-compose.override.yml"
  chown 4321:4321 "$PROJ/.env"; chmod 600 "$PROJ/.env"
  original="$(cat "$PROJ/.env")"
  setup --existing "$adopt" --project-dir "$PROJ" --yes
  ok ".env with COMPOSE_FILE and an override file"
  is "... COMPOSE_FILE keeps its value and gains the overlay" "$(grep '^COMPOSE_FILE=' "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml"
  is "... MESHINFO_PGCOLD_DIR is added" "$(grep '^MESHINFO_PGCOLD_DIR=' "$PROJ/.env")" "MESHINFO_PGCOLD_DIR=$adopt"
  is "... every other line is as it was" "$(grep -v -e '^COMPOSE_FILE=' -e '^MESHINFO_PGCOLD_DIR=' "$PROJ/.env")" "$(grep -v '^COMPOSE_FILE=' <<<"$original")"
  is "... owner and mode are kept" "$(stat -c '%u:%g %a' "$PROJ/.env")" "4321:4321 600"
  is "... the backup is the file as it was" "$(cat "$PROJ"/.env.bak-*)" "$original"
  holds "... docker compose config has the bind" bash -c "cd $PROJ && docker compose config | grep -q 'target: /var/lib/postgresql/cold'"

  new_project env-override
  cp "$REPO/.env.sample" "$PROJ/.env"
  echo 'services: {}' > "$PROJ/docker-compose.override.yml"
  setup --existing "$adopt" --project-dir "$PROJ" --yes
  ok ".env without COMPOSE_FILE, with docker-compose.override.yml"
  is "... the override file is listed before the overlay" "$(grep '^COMPOSE_FILE=' "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml"
  is "... the sample's commented lines are untouched" "$(grep -c '^#COMPOSE_FILE=' "$PROJ/.env")" 2

  # the other names Compose loads by itself, in the order it prefers them
  new_project env-compose-override
  printf 'services:\n  postgres:\n    environment:\n      FROM_OVERRIDE: compose-override\n' > "$PROJ/compose.override.yaml"
  echo 'services: {}' > "$PROJ/docker-compose.override.yml"
  setup --existing "$adopt" --project-dir "$PROJ" --yes
  ok ".env with compose.override.yaml beside docker-compose.override.yml"
  is "... the one Compose was using is the one listed" "$(grep '^COMPOSE_FILE=' "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:compose.override.yaml:docker-compose.cold.yml"
  holds "... and its settings are still in the merged configuration" bash -c "cd $PROJ && docker compose config | grep -q 'FROM_OVERRIDE: compose-override'"

  new_project env-quoted
  printf 'COMPOSE_FILE="docker-compose.yml"   # the "main" file\r\n' > "$PROJ/.env"
  setup --existing "$adopt" --project-dir "$PROJ" --yes
  ok ".env with a quoted value, a comment with quotes in it, and CRLF line ends"
  is "... the value inside the quotes gains the overlay; the comment and the line end are kept" "$(grep '^COMPOSE_FILE=' "$PROJ/.env" | od -An -c | tr -d ' \n')" 'COMPOSE_FILE="docker-compose.yml:docker-compose.cold.yml"#the"main"file\r\n'
  holds "... which Compose reads as intended" bash -c "cd $PROJ && docker compose config | grep -q 'target: /var/lib/postgresql/cold'"

  new_project env-skip
  cp "$REPO/.env.sample" "$PROJ/.env"
  original="$(sha256sum < "$PROJ/.env")"
  setup --existing "$adopt" --project-dir "$PROJ" --no-env --yes
  ok "--no-env"
  is "... .env is untouched" "$(sha256sum < "$PROJ/.env")" "$original"
  said "... the first line to add is printed" 'COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml'
  said "... and the second" "MESHINFO_PGCOLD_DIR=$adopt"

  mkdir -p /btrfshost/adopt-prop
  btrfs property set /btrfshost/adopt-prop compression zstd
  setup --existing /btrfshost/adopt-prop --no-env --yes
  ok "adopt a directory whose compression is a btrfs property"
  said "... how compression is on" 'compression is on: btrfs property compression=zstd'
  # with --no-env nothing names the directory afterwards: it is known by what it has
  changes_nothing "re-run for it with no flag and no .env: not replaced by a subvolume" --mountpoint /btrfshost/adopt-prop --no-env --yes
  said "... it is taken as it is" 'Layout: an existing directory, adopted as it is — it is on btrfs with compression on and already belongs to 999:999'
  rmdir /btrfshost/adopt-prop

  # a directory made inside a setgid share keeps the bit through chmod 750
  mkdir -p /btrfszstd/share && chmod 2775 /btrfszstd/share
  mkdir /btrfszstd/share/cold
  is "(a directory made in a setgid share has the bit)" "$(stat -c %a /btrfszstd/share/cold)" 2755
  setup --existing /btrfszstd/share/cold --no-env --yes
  ok "adopt a setgid directory"
  is "... it ends as plain 750" "$(stat -c '%u:%g %a' /btrfszstd/share/cold)" "999:999 750"
  rm -rf /btrfszstd/share
}

t_zfs_stub() {
  local state="$LAB/zfs" dataset_file bare
  section "ZFS — with stand-ins for zpool, zfs and findmnt, NOT on real ZFS"
  note "the stand-ins play what a pool cannot be made to do on demand; the zfs_real section runs the layout on a real pool where this kernel has ZFS"
  rm -rf "$state" /tank /srv/zcold /srv/zother /srv/zauto /srv/zlegacy /srv/zv23
  # ... and the fstab lines a run that was stopped half-way left for the section's directories
  sed -i -E '\|[[:space:]]/srv/z[a-z0-9]*[[:space:]]|d' /etc/fstab
  mkdir -p "$state/datasets"
  : > "$state/calls.log"
  export ZFS_STUB_STATE="$state"
  PREFIX=(env "PATH=$HERE/stubs:$PATH")
  new_project zfs-bare; bare="$PROJ"   # a checkout without .env, for status of other directories
  new_project zfs

  echo tank > "$state/pools"
  is "(the stand-in answers for a pool that was imported the plain way)" "$("$HERE/stubs/zpool" get -H -o value altroot tank) $("$HERE/stubs/zpool" get -H -o value feature@zstd_compress tank)" "- active"
  changes_nothing "one pool: detected, dry run" --dry-run --mountpoint /srv/zcold --project-dir "$PROJ"
  said "... the layout and why" 'Layout: the ZFS dataset tank/meshinfo-cold — this host has a ZFS pool, tank'
  said "... the delegated command" 'scripts/setup-zfs-datasets.sh --cold-only tank/meshinfo-cold /srv/zcold'
  said "... what it runs: create" 'zfs create -p tank/meshinfo-cold'
  said "... what it runs: the mountpoint" 'zfs set mountpoint=/srv/zcold tank/meshinfo-cold'
  said "... what it runs: compression" 'zfs set compression=zstd-9 tank/meshinfo-cold'
  is "... and zfs was not asked to change anything" "$(grep -Ec '^zfs (create|set)' "$state/calls.log")" 0
  changes_nothing "one pool and --size: a dataset has no size, and the script says that the size is not used (dry run)" --size 40G --dry-run --mountpoint /srv/zcold --project-dir "$PROJ"
  said "... in so many words" 'warn: --size 40G is not used: it is the size of a new loop image, and the layout here is the ZFS dataset tank/meshinfo-cold — a dataset takes its room from the pool'
  changes_nothing "one pool, and the cold directory's filesystem is btrfs: ZFS comes first (dry run)" --dry-run --mountpoint /btrfshost/zprec/pgcold --no-env
  said "... as the layout line says" 'Layout: the ZFS dataset tank/meshinfo-cold'
  setup --mountpoint /srv/zauto --no-env --yes
  ok "one pool, no --zfs: the dataset is made"
  is "... through the delegated script" "$(grep -c '^zfs create -p tank/meshinfo-cold$' "$state/calls.log")" 1
  rm -f "$state/datasets/tank%meshinfo-cold"
  rm -rf /srv/zauto /tank
  : > "$state/calls.log"

  printf 'tank\nbackup\n' > "$state/pools"
  refuses "two pools: asks which one" 'this host has 2 ZFS pools \(tank, backup\): say which one takes the cold dataset — the one with room for the cold months, e.g. --zfs tank/meshinfo-cold' --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  refuses "a pool that does not exist" 'there is no ZFS pool named nope' --zfs nope/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  refuses "a dataset whose parent does not exist: zfs create -p would mount that one somewhere too" 'the parent dataset backup/deep does not exist' --zfs backup/deep/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  usage_error "the pool root is never used" 'names a pool, not a dataset on it' --zfs backup --mountpoint /srv/zcold --project-dir "$PROJ" --yes

  setup --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  ok "two pools, --zfs backup/cold: setup"
  is "the delegated script created the dataset" "$(grep -c '^zfs create -p backup/cold$' "$state/calls.log")" 1
  is "... with the cold properties and the mountpoint" "$(grep -E '^zfs set ' "$state/calls.log" | sort | tr '\n' ' ')" "zfs set atime=off backup/cold zfs set compression=zstd-9 backup/cold zfs set logbias=throughput backup/cold zfs set mountpoint=/srv/zcold backup/cold zfs set recordsize=128K backup/cold zfs set xattr=sa backup/cold "
  said "verified as ZFS" 'findmnt -no FSTYPE -T /srv/zcold prints zfs'
  said "verified compression" 'compression is on: ZFS property compression=zstd-9'
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' /srv/zcold)" "999:999 750"
  is ".env" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=/srv/zcold"
  silent_on "the delegated script's own next steps are left out" 'Next steps'
  ends_with_the_two_steps "ends with the two steps that remain, in order"

  : > "$state/calls.log"
  changes_nothing "re-run with the same arguments" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  is "... and zfs was not asked to change anything" "$(grep -Ec '^zfs (create|set)' "$state/calls.log")" 0
  changes_nothing "re-run with no layout flag, two pools or not" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... recognises the dataset" 'Layout: the ZFS dataset backup/cold — it is mounted there already'

  refuses "the dataset exists with another mountpoint" 'the dataset backup/cold exists with mountpoint /srv/zcold, not /srv/zother' --zfs backup/cold --mountpoint /srv/zother --no-env --yes
  dataset_file="$state/datasets/backup%cold"
  sed -i 's/^compression=.*/compression=lz4/' "$dataset_file"
  refuses "the dataset exists with other properties" 'exists with other properties: compression=lz4 \(the cold layout has zstd-9\).* pass --existing /srv/zcold' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  sed -i 's/^compression=.*/compression=zstd-9/' "$dataset_file"

  # OpenZFS 2.3 prints xattr=sa as "on" (on came to mean sa there): what this
  # script made must not look like a dataset with other properties
  echo 2.3.9 > "$state/version"
  is "(the stand-in plays OpenZFS 2.3: zfs version)" "$("$HERE/stubs/zfs" version | head -n 1)" zfs-2.3.9-1
  is "(... where xattr=sa reads back as on)" "$("$HERE/stubs/zfs" get -H -o value xattr backup/cold)" on
  changes_nothing "OpenZFS 2.3: the re-run takes the on it reads for the sa it set" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... and reports nothing to change" 'nothing to change'
  changes_nothing "... also with no layout flag" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  sed -i 's/^xattr=.*/xattr=dir/' "$dataset_file"
  refuses "... while xattr=dir is another property there too" 'exists with other properties: xattr=dir \(the cold layout has sa\)' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  sed -i 's/^xattr=.*/xattr=sa/' "$dataset_file"
  setup --zfs backup/v23 --mountpoint /srv/zv23 --no-env --yes
  ok "OpenZFS 2.3: a first setup"
  changes_nothing "... and its re-run" --zfs backup/v23 --mountpoint /srv/zv23 --no-env --yes
  said "... reports nothing to change" 'nothing to change'
  rm -f "$state/datasets/backup%v23" "$state/version"
  rm -rf /srv/zv23
  # ... and before 2.3 on meant dir, which is not the cold property
  sed -i 's/^xattr=.*/xattr=on/' "$dataset_file"
  refuses "OpenZFS before 2.3: xattr=on is dir there, and is refused" 'exists with other properties: xattr=on \(the cold layout has sa\)' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  sed -i 's/^xattr=.*/xattr=sa/' "$dataset_file"
  # zfs built against musl (Alpine) reads "atime" into the mount option
  # "noatime": for a mounted dataset with atime=off it prints atime=on, with
  # the source "temporary". The mount is what counts then.
  sed -i 's/^atime=.*/atime=on/' "$dataset_file"
  printf 'atime.source=temporary\nmountoptions=rw,noatime,xattr,posixacl\n' >> "$dataset_file"
  is "(the stand-in plays zfs on musl: atime=off reads back as on, from the mount)" "$("$HERE/stubs/zfs" get -H -o value,source atime backup/cold | tr '\t' ' ')" "on temporary"
  changes_nothing "zfs get takes atime=on from a mount that is noatime: the mount is asked, and nothing is to change" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... as the plan says" 'nothing to change'
  sed -i 's/^mountoptions=.*/mountoptions=rw,relatime,xattr,posixacl/' "$dataset_file"
  refuses "... while a mount that really has atime on is another property" 'exists with other properties: atime=on, as it is mounted \(the cold layout has off\)' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  sed -i -e '/^atime\.source=/d' -e '/^mountoptions=/d' -e 's/^atime=.*/atime=off/' "$dataset_file"
  changes_nothing "... and with the property as it was, nothing to change again" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes

  refuses "another dataset for the same mountpoint" '/srv/zcold is already the mountpoint of another dataset, backup/cold' --zfs backup/second --mountpoint /srv/zcold --no-env --yes
  echo '/dev/null /srv/zcold ext4 defaults 0 0' >> /etc/fstab
  refuses "an fstab entry that would mount over the dataset" '/etc/fstab has an entry for /srv/zcold' --zfs backup/cold --mountpoint /srv/zcold --no-env --yes
  said "... for what it is" 'At boot it would mount another filesystem over this layout'
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... status flags it too: exit 1" 1
  said "... by name" 'fstab +UNEXPECTED entry for this directory'
  sed -i '\|/dev/null /srv/zcold |d' /etc/fstab
  # an fstab line for the dataset itself is not "another filesystem"
  echo 'backup/cold /srv/zcold zfs defaults 0 0' >> /etc/fstab
  refuses "an fstab line for the dataset itself, which mount would turn down" '/etc/fstab has a line for the dataset backup/cold itself' --zfs backup/cold --mountpoint /srv/zcold --no-env --yes
  said "... and why it has to go" 'mount turns down an fstab line without the zfsutil option for a dataset whose mountpoint is not legacy'
  silent_on "... not as another filesystem" 'another filesystem over this layout'
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... status flags that line: exit 1" 1
  said "... for what it is" 'fstab +UNEXPECTED entry for this dataset, which ZFS mounts itself'
  sed -i 's|^backup/cold /srv/zcold zfs defaults 0 0$|backup/cold /srv/zcold zfs zfsutil,nofail 0 0|' /etc/fstab
  changes_nothing "... with zfsutil it is the mount ZFS makes itself: the re-run goes through" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  changes_nothing "... also with no layout flag" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  ok "... and status prints the line without complaint"
  said "... as the entry" 'fstab +backup/cold /srv/zcold zfs zfsutil,nofail 0 0'
  sed -i '\|^backup/cold /srv/zcold |d' /etc/fstab
  # ... and for a dataset that cannot be asked, nothing is said about its
  # mountpoint property: without its pool, the pool is what is missing
  echo 'gone/cold /srv/zgone zfs defaults,nofail 0 0' >> /etc/fstab
  refuses "an fstab line for a dataset whose pool is not there: the pool is what is reported" 'there is no ZFS pool named gone' --zfs gone/cold --mountpoint /srv/zgone --no-env --yes
  silent_on "... not a property that could not be read" 'mountpoint property'
  silent_on "... and the line that may be what mounts it is not to be removed" 'Remove the entry'
  sed -i '\|^gone/cold /srv/zgone |d' /etc/fstab
  echo 'backup/notyet /srv/znotyet zfs defaults 0 0' >> /etc/fstab
  refuses "an fstab line for a dataset that is not there, on a pool that is: the line would be in the way of the dataset this script makes" '/etc/fstab has a line for the dataset backup/notyet, which is not there' --zfs backup/notyet --mountpoint /srv/znotyet --no-env --yes
  sed -i '\|^backup/notyet /srv/znotyet |d' /etc/fstab

  # Another dataset with the same mountpoint that is not mounted (a copy
  # received from another pool): a cold directory in use is not refused for
  # it, and mounting the copy is never the advice.
  printf 'mountpoint=/srv/zcold\nmountpoint.source=received\ncompression=zstd-9\ncanmount=noauto\nmounted=no\n' > "$state/datasets/tank%replica"
  changes_nothing "an unmounted copy has the same mountpoint: the re-run goes through" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... with a warning" 'warn: the ZFS dataset tank/replica also has /srv/zcold as its mountpoint and is not mounted\. Leave it unmounted'
  silent_on "... and mounting it is not the advice" 'zfs mount (-l )?tank/replica'
  changes_nothing "... also with no layout flag" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  changes_nothing "... and with --existing" --existing /srv/zcold --project-dir "$PROJ" --yes
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  ok "... status with the copy at canmount=noauto: mentioned, nothing to attend to"
  said "... by name" 'also +the ZFS dataset tank/replica has this directory as its mountpoint too and is not mounted \(canmount=noauto\)'
  sed -i 's/^canmount=.*/canmount=on/' "$state/datasets/tank%replica"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... status with the copy at canmount=on: the next boot would mount it over this one: exit 1" 1
  said "... as it says" 'tank/replica has this directory as its mountpoint too and is NOT MOUNTED: at the next boot, or with zfs mount -a, it would cover what is here\. Give it another mountpoint'
  # ... a copy whose key is not loaded is passed over by zfs mount -a — only
  # until the key is loaded, which a boot may do: it stays something to attend to
  echo 'keystatus=unavailable' >> "$state/datasets/tank%replica"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... status with a copy whose key is not loaded: still exit 1" 1
  said "... with what holds it back for now" 'tank/replica has this directory as its mountpoint too and is NOT MOUNTED\. Its key is not loaded, and zfs mount -a passes over it until it is'
  sed -i '/^keystatus=/d' "$state/datasets/tank%replica"
  # ... a copy that nothing marks as one (made by hand: its mountpoint is as
  # local as the cold dataset's): the script does not say which of the two is it
  sed -i '/^mountpoint\.source=/d' "$state/datasets/tank%replica"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... a second dataset that nothing marks as the copy: status exits 1" 1
  said "... and gives both readings" 'tank/replica has this directory as its mountpoint too and is NOT MOUNTED: .* Only one of the two is the cold dataset\. If it is backup/cold, which is mounted here: give tank/replica another mountpoint, or set canmount=off on it\. If it is tank/replica: stop the stack'
  changes_nothing "... the re-run goes through" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... with both readings in its warning" 'warn: the ZFS dataset tank/replica also has /srv/zcold as its mountpoint and is not mounted\. Only one of the two is the cold dataset'
  echo 'mountpoint.source=received' >> "$state/datasets/tank%replica"
  sed -i 's/^canmount=.*/canmount=off/' "$state/datasets/tank%replica"
  changes_nothing "... a dataset that can never be mounted (canmount=off) claims nothing" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  silent_on "... and is not mentioned" 'tank/replica'
  rm -f "$state/datasets/tank%replica"
  mkdir -p /srv/zbusy && touch /srv/zbusy/file
  refuses "a dataset over a directory with files in it" '/srv/zbusy is not empty and is not backup/third' --zfs backup/third --mountpoint /srv/zbusy --no-env --yes
  rm -rf /srv/zbusy

  # datasets that are there but not mounted, or not mountable at a path
  touch "$state/no-mount"
  "$HERE/stubs/zfs" create -p backup/away
  "$HERE/stubs/zfs" set mountpoint=/srv/zaway backup/away
  rm -f "$state/no-mount"
  refuses "a dataset has the path but is not mounted: an image is not put there" 'the ZFS dataset backup/away has /srv/zaway as its mountpoint but is not mounted' --image /hostfs/z.img --size 4G --mountpoint /srv/zaway --no-env --yes
  said "... both ways out are named" 'If it is the cold dataset, mount it \(zfs mount -l backup/away; -l loads the key of one that is encrypted\) and run this again\. If it is not meant for this path'
  refuses "... nor is --existing given the bare directory" 'the ZFS dataset backup/away has /srv/zaway as its mountpoint but is not mounted' --existing /srv/zaway --no-env --yes
  setup status --mountpoint /srv/zaway --project-dir "$bare"
  exits "... and status says that the dataset is not mounted: exit 1" 1
  said "... by name" 'layout +NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: backup/away'
  # ... a marker file in the bare mountpoint does not make it a cold directory in use
  touch /srv/zaway/NOT_MOUNTED
  setup status --mountpoint /srv/zaway --project-dir "$bare"
  exits "... with a marker file in the bare directory: still the dataset that is not mounted, exit 1" 1
  said "... still by name, with a word about the directory" 'layout +NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: backup/away\. .* The directory underneath is not empty'
  silent_on "... and the dataset is not something to keep from mounting" 'Give it another mountpoint'
  refuses "... nor does setup take the directory for one in use" 'is the bare directory underneath \(it is not empty' --existing /srv/zaway --no-env --yes
  rm -f /srv/zaway/NOT_MOUNTED
  printf 'mountpoint=/srv/zaway\ncompression=zstd-9\ncanmount=noauto\nmounted=no\n' > "$state/datasets/tank%away-copy"
  refuses "two datasets have the path, neither is mounted: the one that is meant has to be mounted" 'the ZFS datasets backup/away, tank/away-copy have /srv/zaway as their mountpoint but are not mounted' --existing /srv/zaway --no-env --yes
  said "... with the command that also loads a key" 'Mount the one that is the cold dataset \(zfs mount -l NAME\) and give the others another mountpoint or canmount=off'
  rm -f "$state/datasets/backup%away" "$state/datasets/tank%away-copy"
  rm -rf /srv/zaway
  touch "$state/no-mount"
  setup --zfs backup/fourth --mountpoint /srv/zfourth --no-env --yes
  exits "the delegated script fails (the dataset does not mount): exit 1" 1
  said "... its own message is shown" 'backup/fourth is not mounted at /srv/zfourth'
  said "... with the command that also loads a key" 'zfs mount -l backup/fourth \(-l loads the key; with canmount=off, zfs set canmount=on backup/fourth first\)'
  said "... and this script stops there" 'setup-zfs-datasets.sh did not finish'
  rm -f "$state/no-mount" "$state/datasets/backup%fourth"
  rm -rf /srv/zfourth
  "$HERE/stubs/zfs" create -p backup/legacy
  "$HERE/stubs/zfs" set mountpoint=legacy backup/legacy
  refuses "a dataset with mountpoint=legacy" 'the dataset backup/legacy exists with mountpoint=legacy, so ZFS does not mount it at a path itself' --zfs backup/legacy --mountpoint /srv/zlegacy --no-env --yes
  # ... and one that its own fstab line mounts at the cold directory: that
  # line is the dataset's mount, not another filesystem over it
  printf 'mountpoint=legacy\nmountedat=/srv/zlegacy\ncompression=zstd-9\ncompressratio=1.00x\ncanmount=on\nmounted=yes\n' > "$state/datasets/backup%legacy"
  mkdir -p /srv/zlegacy
  echo 'backup/legacy /srv/zlegacy zfs defaults,nofail 0 0' >> /etc/fstab
  refuses "a legacy dataset mounted by its own fstab line, no layout flag" 'the dataset backup/legacy has mountpoint=legacy, and /etc/fstab is what mounts it at /srv/zlegacy' --mountpoint /srv/zlegacy --no-env --yes
  said "... is pointed to --existing" 'To use it as it is, pass --existing /srv/zlegacy'
  silent_on "... and is not told to remove the line that mounts it" 'Remove the entry'
  refuses "... the same with --zfs" 'the dataset backup/legacy has mountpoint=legacy, and /etc/fstab is what mounts it at /srv/zlegacy' --zfs backup/legacy --mountpoint /srv/zlegacy --no-env --yes
  setup --existing /srv/zlegacy --no-env --yes
  ok "... and --existing adopts it"
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  ok "... status takes the line for what it is"
  said "... and prints it as the entry" 'fstab +backup/legacy /srv/zlegacy zfs defaults,nofail 0 0'
  silent_on "... not as an entry that mounts something else" 'UNEXPECTED'
  # ... also where the dataset cannot be asked (no zfs command on PATH)
  mkdir -p "$LAB/path/findmnt-only"
  ln -sf "$HERE/stubs/findmnt" "$LAB/path/findmnt-only/findmnt"
  PREFIX=(env "PATH=$LAB/path/findmnt-only:$PATH")
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  said "... where the dataset cannot be asked, the line is printed all the same" 'fstab +backup/legacy /srv/zlegacy zfs defaults,nofail 0 0'
  silent_on "... and not suspected" 'UNEXPECTED'
  PREFIX=(env "PATH=$HERE/stubs:$PATH")
  # ... and --existing says what the dataset lacks once the line is gone
  sed -i '\|^backup/legacy /srv/zlegacy |d' /etc/fstab
  changes_nothing "a legacy dataset mounted by hand, no fstab line: --existing goes through" --existing /srv/zlegacy --no-env --yes
  said "... with a warning: nothing mounts it after a reboot" 'warn: the dataset backup/legacy has mountpoint=legacy and /etc/fstab has no line for it'
  echo 'backup/legacy /srv/zlegacy zfs defaults,nofail 0 0' >> /etc/fstab
  sed -i '\|^backup/legacy /srv/zlegacy |d' /etc/fstab
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  exits "a legacy dataset mounted by hand, with no fstab line: status exits 1" 1
  said "... it would not be mounted after a reboot" 'fstab +NO ENTRY — the dataset has mountpoint=legacy'
  rm -f "$state/datasets/backup%legacy"
  rm -rf /srv/zlegacy
  printf 'mountpoint=/srv/zroot\ncompression=lz4\nmounted=yes\n' > "$state/datasets/backup"
  mkdir -p /srv/zroot
  refuses "the root dataset of a pool is mounted there, no layout flag" '/srv/zroot is the mountpoint of backup, the root dataset of a pool, which this script never sets up as cold storage' --mountpoint /srv/zroot --no-env --yes
  refuses "... and with a dataset named: the advice is not a --zfs that this script turns down" '/srv/zroot is already the mountpoint of another dataset, backup — pass --existing /srv/zroot to keep using it as it is' --zfs backup/new --mountpoint /srv/zroot --no-env --yes
  rm -f "$state/datasets/backup"
  rmdir /srv/zroot
  mkdir -p "$LAB/alone"
  cp "$SCRIPT" "$LAB/alone/"
  run env "PATH=$HERE/stubs:$PATH" "$LAB/alone/setup-cold-storage.sh" --zfs backup/fifth --mountpoint /srv/zfifth --no-env --yes
  exits "the script it delegates to is missing: exit 1" 1
  said "... says so" 'setup-zfs-datasets.sh, which creates the dataset, is not next to this script'

  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  ok "status"
  said "status: what is set up" 'layout +the ZFS dataset backup/cold'
  said "status: compression" 'filesystem +zfs, compression on \(ZFS property compression=zstd-9\)'
  said "status: the ratio ZFS reports" 'compression +1\.00x'
  refuses "grow on ZFS: says what to do instead" 'a dataset has no size of its own, it shares the pool' grow --to 10G --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  refuses "an image path on ZFS" '/srv/zcold is on ZFS: an image there' --image /srv/zcold/x.img --size 4G --mountpoint /srv/zimage --no-env --yes

  "$HERE/stubs/zfs" create -p tank/plain
  refuses "--existing: ZFS with compression off" 'compression is off for /tank/plain \(zfs\): the dataset tank/plain has compression=off; turn it on: zfs set compression=zstd-9 tank/plain' --existing /tank/plain --no-env --yes
  mkdir -p "$LAB/path/findmnt-only"
  ln -sf "$HERE/stubs/findmnt" "$LAB/path/findmnt-only/findmnt"
  PREFIX=(env "PATH=$LAB/path/findmnt-only:$PATH")
  refuses "--existing on ZFS without the zfs command: it cannot be told" 'cannot tell whether compression is on for /tank/plain \(zfs\): the zfs command is missing — apt-get install zfsutils-linux' --existing /tank/plain --no-env --yes
  PREFIX=(env "PATH=$HERE/stubs:$PATH")
  "$HERE/stubs/zfs" set compression=lz4 tank/plain
  setup --existing /tank/plain --no-env --yes
  ok "--existing: a ZFS dataset made elsewhere, with compression on"
  said "... how compression is on" 'compression is on: ZFS property compression=lz4'
  # a cold directory in use that is no mount point of its own (a directory
  # inside that dataset, holding the tablespace), and a stray dataset that
  # has its path: mounted, the stray one would hide the tablespace
  mkdir -p /tank/plain/cold/PG_18_202506291
  printf 'mountpoint=/tank/plain/cold\ncompression=off\ncanmount=on\nmounted=no\n' > "$state/datasets/tank%stray"
  setup --existing /tank/plain/cold --no-env --yes
  ok "a cold directory in use inside a dataset, and a stray dataset with its path: adopted"
  said "... with the warning" 'warn: the ZFS dataset tank/stray also has /tank/plain/cold as its mountpoint and is not mounted\. Leave it unmounted'
  silent_on "... and never the advice to mount it" 'zfs mount (-l )?tank/stray'
  setup status --mountpoint /tank/plain/cold --project-dir "$bare"
  exits "... status in that state: exit 1, for the dataset that would be mounted over it at the next boot" 1
  said "... the layout is the directory that is in use, not a dataset to mount" 'layout +a directory on zfs'
  said "... the stray dataset is what needs attention" 'also +the ZFS dataset tank/stray has this directory as its mountpoint too and is NOT MOUNTED'
  silent_on "... and mounting it is not the advice here either" 'zfs mount -l'
  rm -f "$state/datasets/tank%stray"
  rm -rf /tank/plain/cold

  # --- What real pools showed, played here so that every machine holds it ---
  # A snapshot directory that is visible (snapdir=visible): ZFS's own .zfs at
  # the root of a dataset is not something the cold directory holds.
  mkdir -p /tank/plain/.zfs
  changes_nothing "--existing: a dataset that shows its .zfs directory is taken as empty" --existing /tank/plain --no-env --yes
  mkdir -p /tank/plain/PG_18_202506291
  changes_nothing "... also beside the tablespace" --existing /tank/plain --no-env --yes
  rmdir /tank/plain/PG_18_202506291
  mkdir -p /tank/plain/sub/.zfs
  refuses "... while a .zfs anywhere else is something other than a tablespace" '/tank/plain/sub holds something other than a tablespace \(\.zfs\)' --existing /tank/plain/sub --no-env --yes
  rm -rf /tank/plain/.zfs /tank/plain/sub

  # The cold directory is a directory inside a dataset, and a copy of that
  # dataset has the same mountpoint: the same trouble, one level up.
  mkdir -p /tank/plain/cold/PG_18_202506291
  printf 'mountpoint=/tank/plain\ncompression=lz4\ncompressratio=1.00x\ncanmount=on\nmounted=no\n' > "$state/datasets/backup%plain"
  setup --existing /tank/plain/cold --no-env --yes
  ok "a cold directory inside a dataset, and an unmounted copy of that dataset with the same mountpoint: adopted"
  said "... with a warning for the copy" 'warn: the ZFS dataset backup/plain has /tank/plain as its mountpoint, a directory above the cold directory, and is not mounted'
  setup status --mountpoint /tank/plain/cold --project-dir "$bare"
  exits "... status: exit 1, the next boot would mount the copy over the dataset" 1
  said "... as it says" 'also +the ZFS dataset backup/plain has /tank/plain, a directory above this one, as its mountpoint and is NOT MOUNTED'
  sed -i 's/^canmount=.*/canmount=noauto/' "$state/datasets/backup%plain"
  setup status --mountpoint /tank/plain/cold --project-dir "$bare"
  ok "... a copy that is kept from mounting by itself (canmount=noauto) needs no attention"
  sed -i 's/^canmount=.*/canmount=on/' "$state/datasets/backup%plain"
  "$HERE/stubs/zfs" mount -a
  setup status --mountpoint /tank/plain/cold --project-dir "$bare"
  exits "... the copy mounted over the dataset: status exits 1" 1
  said "... names both, and where" 'stacked +MORE THAN ONE FILESYSTEM is mounted at /tank/plain, where the filesystem that holds /tank/plain/cold is mounted, one over the other: tank/plain, backup/plain'
  refuses "... and setup does not call that ready" 'more than one filesystem is mounted at /tank/plain, where the filesystem that holds /tank/plain/cold is mounted' --existing /tank/plain/cold --no-env --yes
  said "... the way out names that directory" 'umount /tank/plain, once for each'
  rm -f "$state/datasets/backup%plain"
  rm -rf /tank/plain/cold

  # Two datasets mounted at the cold directory, one over the other: a copy
  # with the same mountpoint that zfs mount -a, or a boot, mounted as well.
  printf 'mountpoint=/srv/zcold\nmountpoint.source=received\nrecordsize=128K\ncompression=zstd-9\natime=off\nxattr=sa\nlogbias=throughput\ncompressratio=1.00x\ncanmount=on\nmounted=no\n' > "$state/datasets/tank%replica"
  "$HERE/stubs/zfs" mount -a
  is "(a copy is mounted over the cold dataset: findmnt has a line for each, the one on top last)" "$("$HERE/stubs/findmnt" -rn -M /srv/zcold -o SOURCE,FSTYPE | tr '\n' ' ')" "backup/cold zfs tank/replica zfs "
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "two datasets are mounted at the cold directory: status exits 1" 1
  said "... names both, and which is on top" 'stacked +MORE THAN ONE FILESYSTEM is mounted here, one over the other: backup/cold, tank/replica — the last is on top'
  refuses "... the re-run does not take the one on top for the cold dataset" 'more than one filesystem is mounted at /srv/zcold, one over the other: backup/cold, tank/replica' --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... the way out starts with unmounting the directory" 'umount /srv/zcold, once for each'
  silent_on "... and is never zfs unmount or zfs set canmount by name, which take off whatever is on top" 'zfs unmount|zfs set canmount'
  refuses "... nor with the cold dataset named" 'more than one filesystem is mounted at /srv/zcold' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  silent_on "... and the copy is not offered as the dataset to keep using" 'pass --zfs tank/replica'
  refuses "... nor with --existing" 'more than one filesystem is mounted at /srv/zcold' --existing /srv/zcold --project-dir "$PROJ" --yes
  refuses "... and grow stops at it too" 'more than one filesystem is mounted at /srv/zcold' grow --to 10G --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  # which of the two ends on top is not fixed (another boot: the other order)
  sed -i 's/^mountorder=.*/mountorder=1/' "$state/datasets/tank%replica"
  sed -i 's/^mountorder=.*/mountorder=2/' "$dataset_file"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "... with the cold dataset on top it is the same problem: exit 1" 1
  said "... named in that order" 'one over the other: tank/replica, backup/cold — the last is on top'
  # the way out as the message gives it: the directory unmounted until nothing
  # is mounted there (umount /srv/zcold, twice), canmount=off on the copy, the
  # cold dataset mounted again
  sed -i 's/^mounted=.*/mounted=no/' "$dataset_file" "$state/datasets/tank%replica"
  "$HERE/stubs/zfs" set canmount=off tank/replica
  "$HERE/stubs/zfs" mount -l backup/cold
  changes_nothing "... after the way out the re-run goes through" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  ok "... and status has nothing to say"

  # The copy alone is mounted and the cold dataset is not: its key was not
  # loaded at a boot, zfs mount -a passed over it and mounted the copy. What
  # is mounted has its mountpoint from a zfs receive; the other one has not.
  sed -i 's/^mounted=.*/mounted=no/' "$dataset_file"
  echo 'keystatus=unavailable' >> "$dataset_file"
  "$HERE/stubs/zfs" set canmount=on tank/replica
  "$HERE/stubs/zfs" mount -a
  is "(zfs mount -a passed over the cold dataset and mounted the copy)" "$("$HERE/stubs/findmnt" -rn -M /srv/zcold -o SOURCE | tr '\n' ' ')" "tank/replica "
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "the copy is mounted in the cold dataset's place: status exits 1" 1
  said "... and says what it looks like, and the way to swap them" "also +the ZFS dataset backup/cold has this directory as its mountpoint too and is NOT MOUNTED, while tank/replica, which is mounted here, has its mountpoint from a zfs receive: it looks as if a copy is mounted in the cold dataset's place\\. To put backup/cold here: stop the stack"
  silent_on "... the cold dataset is never what to keep from mounting" 'canmount=off backup/cold|give backup/cold another mountpoint'
  refuses "... the re-run without a flag does not take the copy for the cold dataset" 'tank/replica, which is mounted at /srv/zcold, has its mountpoint from a zfs receive — it is a copy — and backup/cold, which has the same mountpoint, is not mounted' --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... the way to swap them is given" 'To put backup/cold there: stop the stack \(docker compose stop postgres meshinfo\), unmount the directory \(umount /srv/zcold\), keep tank/replica from mounting there again \(zfs set canmount=off tank/replica, or give it another mountpoint\), mount backup/cold \(zfs mount -l backup/cold\)'
  refuses "... naming the cold dataset: the copy is in its place, and is not offered to --zfs" 'tank/replica is mounted at /srv/zcold in the place of backup/cold, which has the same mountpoint and is not mounted' --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  silent_on "... " 'pass --zfs tank/replica'
  changes_nothing "... the copy named with --zfs is taken, as asked" --zfs tank/replica --mountpoint /srv/zcold --no-env --yes
  said "... with what speaks against it" 'warn: tank/replica, which is mounted at /srv/zcold, has its mountpoint from a zfs receive — it is a copy .* tank/replica is taken because it was named'
  # the swap as the message gives it
  sed -i 's/^mounted=.*/mounted=no/' "$state/datasets/tank%replica"
  "$HERE/stubs/zfs" set canmount=off tank/replica
  "$HERE/stubs/zfs" mount -l backup/cold
  changes_nothing "... after the swap the re-run goes through" --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... on the cold dataset" 'Layout: the ZFS dataset backup/cold — it is mounted there already'
  rm -f "$state/datasets/tank%replica"

  # a dataset that is read-only takes no move
  echo 'mountoptions=ro,noatime,xattr,posixacl' >> "$dataset_file"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "the cold dataset is mounted read-only: status exits 1" 1
  said "... and says so" 'the filesystem is mounted READ-ONLY'
  sed -i '/^mountoptions=/d' "$dataset_file"

  # canmount=noauto on the cold dataset itself: mounted now, not after a reboot
  sed -i 's/^canmount=.*/canmount=noauto/' "$dataset_file"
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  exits "the cold dataset has canmount=noauto and nothing in fstab mounts it: status exits 1" 1
  said "... it would not be mounted after a reboot" 'fstab +NO ENTRY — the dataset has canmount=noauto'
  changes_nothing "... the re-run goes through" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... with a warning" 'warn: the dataset backup/cold has canmount=noauto: ZFS does not mount it at boot'
  changes_nothing "... and so does --existing, which is where a dataset made by hand is sent" --existing /srv/zcold --project-dir "$PROJ" --yes
  said "... with the same warning" 'warn: the dataset backup/cold has canmount=noauto: ZFS does not mount it at boot'
  echo 'backup/cold /srv/zcold zfs zfsutil,nofail 0 0' >> /etc/fstab
  setup status --mountpoint /srv/zcold --project-dir "$PROJ"
  ok "... with an fstab line that mounts it, status has nothing to say"
  changes_nothing "... and the re-run does not warn" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  silent_on "... about canmount" 'canmount=noauto'
  sed -i '\|^backup/cold /srv/zcold |d' /etc/fstab
  sed -i 's/^canmount=.*/canmount=on/' "$dataset_file"

  # A pool imported with an alternate root: ZFS puts it in front of every
  # mountpoint, so a dataset would not be mounted where the script was told.
  echo 'altroot=/mnt' > "$state/pool.backup"
  : > "$state/calls.log"
  refuses "a pool with an alternate root: no dataset is set up on it" 'the pool backup is imported with an alternate root \(/mnt\)' --zfs backup/alt --mountpoint /srv/zalt --no-env --yes
  said "... --existing is the way on such a host" 'pass --existing with the directory where it is mounted'
  is "... and zfs was not asked to create anything" "$(grep -Ec '^zfs (create|set)' "$state/calls.log")" 0
  refuses "... nor is a dataset of that pool that is mounted here changed" 'the dataset backup/cold is on a pool that is imported with an alternate root \(/mnt\)' --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  said "... it is taken as it is with --existing" 'pass --existing /srv/zcold'
  changes_nothing "... which goes through" --existing /srv/zcold --project-dir "$PROJ" --yes
  # ... while an alternate root of / (zpool import -R /) puts nothing in front
  echo 'altroot=/' > "$state/pool.backup"
  changes_nothing "an alternate root of / changes no mountpoint: the re-run goes through" --zfs backup/cold --mountpoint /srv/zcold --project-dir "$PROJ" --yes
  rm -f "$state/pool.backup"

  # a pool made by an older ZFS and not upgraded: no zstd
  echo 'feature@zstd_compress=disabled' > "$state/pool.backup"
  : > "$state/calls.log"
  refuses "a pool without the zstd feature: refused before anything is created" 'the pool backup does not have the zstd feature' --zfs backup/nozstd --mountpoint /srv/znozstd --no-env --yes
  said "... with what enables that one feature" 'To enable that one feature: zpool set feature@zstd_compress=enabled backup, then run this again'
  is "... and zfs was not asked to create anything" "$(grep -Ec '^zfs (create|set)' "$state/calls.log")" 0
  # ... nor is a dataset that is already there on such a pool sent to the
  # delegated script, which would fail on it again
  printf 'mountpoint=/srv/znozstd\ncompression=on\ncompressratio=1.00x\ncanmount=on\nmounted=yes\n' > "$state/datasets/backup%nozstd"
  mkdir -p /srv/znozstd
  refuses "... a dataset that is already there gets the same answer" 'the pool backup does not have the zstd feature' --zfs backup/nozstd --mountpoint /srv/znozstd --no-env --yes
  silent_on "... not the delegated script, which fails on that pool" 'cold-only backup/nozstd'
  said "... and --existing takes it as it is" 'To use the dataset backup/nozstd as it is, with the compression it has, pass --existing /srv/znozstd'
  rm -f "$state/datasets/backup%nozstd"
  rm -rf /srv/znozstd
  echo 'feature@zstd_compress=enabled' > "$state/pool.backup"
  changes_nothing "... with the feature enabled the plan is made (dry run)" --zfs backup/nozstd --mountpoint /srv/znozstd --no-env --dry-run
  rm -f "$state/pool.backup"

  # a ZFS from before 2.0 knows no zstd: zpool has no answer for the feature
  touch "$state/zfs-before-zstd"
  : > "$state/calls.log"
  refuses "a ZFS that has no zstd at all: refused before anything is created" 'this ZFS has no zstd \(zpool upgrade -v does not list zstd_compress' --zfs backup/old --mountpoint /srv/zold --no-env --yes
  is "... and zfs was not asked to create anything" "$(grep -Ec '^zfs (create|set)' "$state/calls.log")" 0
  rm -f "$state/zfs-before-zstd"

  # --zfs names something that is not a filesystem
  printf 'type=volume\n' > "$state/datasets/backup%vol"
  refuses "--zfs naming a volume" 'backup/vol is a volume, not a filesystem dataset' --zfs backup/vol --mountpoint /srv/zvol --no-env --yes
  rm -f "$state/datasets/backup%vol"

  # ZFS keeps a mountpoint as it was typed — a trailing slash, a symlink on
  # the way — and mounts at the real place
  mkdir -p /srv/zts /srv/zreal
  ln -sfn /srv/zreal /srv/zlink
  printf 'mountpoint=/srv/zts/\ncompression=zstd-9\ncompressratio=1.00x\ncanmount=on\nmounted=no\n' > "$state/datasets/backup%ts"
  printf 'mountpoint=/srv/zlink/cold\ncompression=zstd-9\ncanmount=on\nmounted=no\n' > "$state/datasets/backup%sl"
  refuses "an unmounted dataset whose mountpoint was typed with a trailing slash is still what belongs there" 'the ZFS dataset backup/ts has /srv/zts as its mountpoint but is not mounted' --zfs backup/other --mountpoint /srv/zts --no-env --dry-run
  setup status --mountpoint /srv/zts --project-dir "$bare"
  exits "... status: exit 1" 1
  said "... names it" 'layout +NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: backup/ts'
  refuses "... and so is one whose mountpoint leads through a symlink" 'the ZFS dataset backup/sl has /srv/zreal/cold as its mountpoint but is not mounted' --zfs backup/other --mountpoint /srv/zreal/cold --no-env --dry-run
  sed -i 's/^mounted=.*/mounted=yes/' "$state/datasets/backup%ts"
  setup --existing /srv/zts --no-env --yes
  ok "... mounted, it is adopted at the real place"
  setup status --mountpoint /srv/zts --project-dir "$bare"
  said "... and status knows the dataset" 'layout +the ZFS dataset backup/ts'
  rm -f "$state/datasets/backup%ts" "$state/datasets/backup%sl"
  rm -rf /srv/zts /srv/zreal /srv/zlink

  # a dataset with a space in its name: findmnt -r writes the space as \x20
  mkdir -p /srv/zspace
  printf 'mountpoint=/srv/zspace\ncompression=zstd-9\ncompressratio=1.00x\ncanmount=on\nmounted=yes\n' > "$state/datasets/backup%cold data"
  is "(the stand-in writes the name as findmnt -r does)" "$("$HERE/stubs/findmnt" -rn -M /srv/zspace -o SOURCE,FSTYPE)" 'backup/cold\x20data zfs'
  refuses "a dataset with a space in its name is mounted there: it is not handed to zfs under another name" "/srv/zspace is the mountpoint of the dataset 'backup/cold data', a name this script does not pass on to zfs" --mountpoint /srv/zspace --no-env --yes
  said "... --existing takes it" 'pass --existing /srv/zspace'
  usage_error "... and --zfs does not take such a name" "--zfs 'backup/cold data': this script passes on dataset names made of letters, digits" --zfs 'backup/cold data' --mountpoint /srv/zspace --no-env --yes
  refuses "... nor is it offered to --zfs when another dataset is named for its directory" 'another dataset, backup/cold data — pass --existing /srv/zspace to keep using it as it is' --zfs backup/other --mountpoint /srv/zspace --no-env --yes
  setup --existing /srv/zspace --no-env --yes
  ok "... --existing adopts it"
  setup status --mountpoint /srv/zspace --project-dir "$bare"
  ok "... status"
  said "... prints the name as it is" 'layout +the ZFS dataset backup/cold data$'
  silent_on "... nowhere with the escape" 'x20'
  refuses "... and grow names the dataset as it is, quoted for the shell" "zfs get quota,refquota 'backup/cold data'\\)" grow --to 10G --mountpoint /srv/zspace --project-dir "$bare" --yes
  : > "$state/calls.log"
  run env "PATH=$HERE/stubs:$PATH" bash "$REPO/scripts/setup-zfs-datasets.sh" --cold-only 'backup/cold two' /srv/zspace2
  exits "the script it delegates to does not take such a name either: exit 2" 2
  said "... and says which names it takes" "'backup/cold two' is not a dataset name --cold-only takes"
  is "... before zfs is asked for anything" "$(grep -c '^zfs ' "$state/calls.log")" 0
  rm -f "$state/datasets/backup%cold data"
  rm -rf /srv/zspace
  # ... and one that its own fstab line mounts: fstab writes the space as \040
  printf 'mountpoint=legacy\nmountedat=/srv/zspaceleg\ncompression=zstd-9\ncompressratio=1.00x\ncanmount=on\nmounted=yes\n' > "$state/datasets/backup%leg data"
  mkdir -p /srv/zspaceleg
  printf '%s\n' 'backup/leg\040data /srv/zspaceleg zfs defaults,nofail 0 0' >> /etc/fstab
  setup --existing /srv/zspaceleg --no-env --yes
  ok "a legacy dataset with a space in its name, mounted by its own fstab line: adopted"
  setup status --mountpoint /srv/zspaceleg --project-dir "$bare"
  ok "... status takes the line for the dataset's own"
  silent_on "... not for one that mounts something else" 'UNEXPECTED'
  sed -i '\|^backup/leg\\040data /srv/zspaceleg |d' /etc/fstab
  rm -f "$state/datasets/backup%leg data"
  rm -rf /srv/zspaceleg

  # a pool whose name has a space: the layout the script picks by itself does not hand it on
  cp "$state/pools" "$state/pools.keep"
  echo 'my pool' > "$state/pools"
  refuses "the only pool has a space in its name: refused when the plan is made" "this host has one ZFS pool, 'my pool', a name this script does not pass on to zfs" --mountpoint /srv/zmypool --no-env --dry-run
  said "... --existing is the way" 'pass --existing with the directory where it is mounted'
  printf 'my pool\ntank\n' > "$state/pools"
  refuses "... among several pools the example names one that --zfs takes" 'this host has 2 ZFS pools \(my pool, tank\): say which one takes the cold dataset — the one with room for the cold months, e.g. --zfs tank/meshinfo-cold' --mountpoint /srv/zmypool --no-env --dry-run
  mv "$state/pools.keep" "$state/pools"

  # an automount point under the dataset: findmnt has a line for it, underneath
  printf 'mountpoint=/srv/zauto2\nrecordsize=128K\ncompression=zstd-9\natime=off\nxattr=sa\nlogbias=throughput\ncompressratio=1.00x\ncanmount=on\nmounted=yes\nunder=autofs\n' > "$state/datasets/backup%auto"
  mkdir -p /srv/zauto2
  echo 'backup/auto /srv/zauto2 zfs zfsutil,nofail,x-systemd.automount 0 0' >> /etc/fstab
  is "(the stand-in plays an automount point under the dataset)" "$("$HERE/stubs/findmnt" -rn -M /srv/zauto2 -o SOURCE,FSTYPE | tr '\n' ' ')" "systemd-1 autofs backup/auto zfs "
  setup --zfs backup/auto --mountpoint /srv/zauto2 --no-env --yes
  ok "a dataset mounted over an automount point: the script it delegates to takes what is on top"
  is "... and hands the directory to postgres" "$(stat -c '%u:%g %a' /srv/zauto2)" "999:999 750"
  changes_nothing "... its re-run" --zfs backup/auto --mountpoint /srv/zauto2 --no-env --yes
  sed -i '\|^backup/auto /srv/zauto2 |d' /etc/fstab
  rm -f "$state/datasets/backup%auto"
  rm -rf /srv/zauto2

  # a legacy dataset whose fstab line carries zfsutil: mount turns that line down
  printf 'mountpoint=legacy\nmountedat=/srv/zlegz\ncompression=zstd-9\ncompressratio=1.00x\ncanmount=on\nmounted=yes\n' > "$state/datasets/backup%legz"
  mkdir -p /srv/zlegz
  echo 'backup/legz /srv/zlegz zfs zfsutil,nofail 0 0' >> /etc/fstab
  refuses "a legacy dataset whose fstab line carries zfsutil, no layout flag" 'the dataset backup/legz has mountpoint=legacy, and its line in /etc/fstab carries the zfsutil option' --mountpoint /srv/zlegz --no-env --yes
  said "... what to do with the line" 'Take the option out of the line'
  silent_on "... which is not said to be what mounts the dataset" 'is what mounts it'
  setup --existing /srv/zlegz --no-env --yes
  ok "... --existing adopts the dataset, which is mounted"
  said "... and warns about the line" 'warn: the line in /etc/fstab for backup/legz carries the zfsutil option'
  setup status --mountpoint /srv/zlegz --project-dir "$bare"
  exits "... status: exit 1, nothing mounts it after a reboot" 1
  said "... for what it is" 'fstab +UNEXPECTED zfsutil option in the entry for this dataset, which has mountpoint=legacy'
  sed -i 's/^mounted=.*/mounted=no/' "$state/datasets/backup%legz"
  setup status --mountpoint /srv/zlegz --project-dir "$bare"
  exits "... not mounted: exit 1" 1
  said "... and mount DIR, which that line makes fail, is not the advice" 'layout +NOT MOUNTED — /etc/fstab has an entry for it\. To mount it: take the zfsutil option out of that line'
  refuses "... nor for --existing" 'Mount it \(take the zfsutil option out of that line' --existing /srv/zlegz --no-env --yes
  refuses "... nor from grow" 'mount it first \(take the zfsutil option out of that line' grow --to 10G --mountpoint /srv/zlegz --project-dir "$bare" --yes
  sed -i '\|^backup/legz /srv/zlegz |d' /etc/fstab
  rm -f "$state/datasets/backup%legz"
  rm -rf /srv/zlegz
  # ... and the other way round: a dataset that ZFS mounts itself, with a line
  # that does not carry zfsutil, not mounted
  printf 'mountpoint=/srv/zown\ncompression=zstd-9\ncanmount=on\nmounted=no\n' > "$state/datasets/backup%own"
  mkdir -p /srv/zown
  echo 'backup/own /srv/zown zfs defaults 0 0' >> /etc/fstab
  setup status --mountpoint /srv/zown --project-dir "$bare"
  exits "a dataset ZFS mounts itself, with an fstab line that mount turns down, not mounted: status exits 1" 1
  said "... the advice is zfs mount, not mount DIR" 'layout +NOT MOUNTED — /etc/fstab has an entry for it\. To mount it: zfs mount -l backup/own — ZFS mounts that dataset itself'
  refuses "... the same from setup" 'Mount it \(zfs mount -l backup/own' --mountpoint /srv/zown --no-env --yes
  # ... a dataset whose mountpoint is another path gets no "zfs mount", which
  # would put it there, not here
  sed -i 's|^mountpoint=.*|mountpoint=/srv/zelsewhere|' "$state/datasets/backup%own"
  setup status --mountpoint /srv/zown --project-dir "$bare"
  said "a line for a dataset whose mountpoint is another path: what to change is said" 'To mount it: the dataset backup/own has mountpoint=/srv/zelsewhere, not this directory, and mount turns down a line without the zfsutil option for it: to have it here, give it this path \(zfs set mountpoint=/srv/zown backup/own — that takes it from where it is now; then zfs mount -l backup/own if it did not mount\) and remove the line'
  silent_on "... and zfs mount by itself is not the advice" 'To mount it: zfs mount -l backup/own'
  sed -i 's|^mountpoint=.*|mountpoint=/srv/zown|' "$state/datasets/backup%own"
  # ... mounted, --existing adopts it and says what the line will do at boot
  "$HERE/stubs/zfs" mount backup/own
  setup --existing /srv/zown --no-env --yes
  ok "... mounted by ZFS itself, --existing adopts it"
  said "... and warns about the line that mount turns down" 'warn: /etc/fstab has a line without the zfsutil option for backup/own, a dataset whose mountpoint is not legacy: mount turns that line down'
  sed -i '\|^backup/own /srv/zown |d' /etc/fstab
  rm -f "$state/datasets/backup%own"
  rm -rf /srv/zown

  # an encrypted dataset whose key is not loaded: zfs mount NAME does not mount it
  printf 'mountpoint=/srv/zenc\ncompression=zstd-9\ncanmount=on\nkeystatus=unavailable\nmounted=no\n' > "$state/datasets/backup%enc"
  mkdir -p /srv/zenc
  run "$HERE/stubs/zfs" mount backup/enc
  exits "(the stand-in: zfs mount does not mount a dataset whose key is not loaded)" 1
  setup status --mountpoint /srv/zenc --project-dir "$bare"
  exits "a dataset that is not mounted, its key not loaded: status exits 1" 1
  said "... and the command it gives loads the key" 'If it is the cold dataset: zfs mount -l backup/enc \(-l loads the key of one that is encrypted\)'
  run "$HERE/stubs/zfs" mount -l backup/enc
  ok "(... which mounts it)"
  rm -f "$state/datasets/backup%enc"
  rm -rf /srv/zenc

  PREFIX=()
  unset ZFS_STUB_STATE
  rm -rf /srv/zcold /srv/zother /srv/zlegacy /srv/zalt /srv/znozstd /srv/zvol /tank
}

# The ZFS layout on a pool of the lab's own — where one can be created: the
# kernel these containers run on must have ZFS (the lab cannot load a module).
# Elsewhere the section says that it did not run, and why. Pools belong to
# the kernel, not to this container: the lab's are named coldlab<time>, sit
# on the lab's own loop devices and are destroyed again. Any other pool is
# only ever listed: with one present the dataset is always named with --zfs,
# the two refusals that count the pools are dry runs (a script that failed
# to refuse would otherwise have a pool of the machine to work on), and the
# datasets of the other pools are compared before and after.
t_zfs_real() {
  local pool second mp=/srv/zreal dataset others why="" minor ratio bare property
  local month before json moved files due foreign changed
  local -a zfs=("$ZFS_TOOLS/zfs") zpool=("$ZFS_TOOLS/zpool") named=()
  section "ZFS — on a real pool"
  pool="coldlab$(date +%s)"   # a name no run before this one has used
  second="${pool}b"
  dataset="$pool/meshinfo-cold"
  if [ ! -x "$ZFS_TOOLS/zpool" ] || [ ! -x "$ZFS_TOOLS/zfs" ]; then
    why="the lab image has no zpool and zfs in $ZFS_TOOLS"
  elif ! grep -qw zfs /proc/filesystems; then
    why="this kernel has no ZFS (it is not in /proc/filesystems; where there is a module for it, load it on the machine the containers run on: modprobe zfs)"
  else
    if [ ! -e /dev/zfs ]; then
      minor="$(awk '$2 == "zfs" { print $1 }' /proc/misc)"
      if [ -n "$minor" ]; then mknod -m 0600 /dev/zfs c 10 "$minor"; fi
    fi
    rm -rf "$mp" /srv/zother /srv/zhand /srv/zplain /srv/zlegacy /srv/zroot /srv/znew /srv/zvis /srv/zts /srv/zspace /srv/zenc /srv/zalt
    # ... and what a run that was stopped half-way left behind for them
    sed -i -E '\|[[:space:]]/srv/z[a-z0-9]*[[:space:]]|d' /etc/fstab
    rm -f /hostfs/zreal.img
    if ! real_pool "$pool" 4G -O mountpoint=none -O canmount=off; then
      why="no pool could be created here ($(tail -n 1 "$OUT"))"
    fi
  fi
  if [ -n "$why" ]; then
    note "NOT RUN: $why"
    note "the ZFS layout ran against the stand-ins only"
    NOT_RUN+=("the ZFS layout on a real pool: $why")
    return 0
  fi
  note "$("${zfs[@]}" version 2>&1 | tr '\n' ' ')"
  PREFIX=(env "PATH=$ZFS_TOOLS:$PATH")
  new_project zfs-real-bare; bare="$PROJ"   # a checkout without .env, for status of other directories
  new_project zfs-real

  others="$("${zpool[@]}" list -H -o name | grep -vxF "$pool" | tr '\n' ' ')"
  foreign="$(foreign_datasets "$pool")"
  if [ -z "$others" ]; then
    changes_nothing "one pool: detected, dry run" --dry-run --mountpoint "$mp" --project-dir "$PROJ"
    said "... the layout and why" "Layout: the ZFS dataset $dataset — this host has a ZFS pool, $pool"
    said "... what the delegated script runs" "zfs set mountpoint=$mp $dataset"
  else
    note "this kernel has other pools (${others% }): they are only listed; where the script could reach them it is run with --dry-run, and the dataset is named with --zfs"
    refuses "several pools: asks which one (a dry run: a script that did not refuse would have a pool of the machine to go on)" 'this host has [0-9]+ ZFS pools \(.*\): say which one takes the cold dataset' --mountpoint "$mp" --project-dir "$PROJ" --dry-run
    named=(--zfs "$dataset")
  fi
  setup "${named[@]}" --mountpoint "$mp" --project-dir "$PROJ" --yes
  ok "setup"
  said "verified as ZFS" "findmnt -no FSTYPE -T $mp prints zfs"
  said "verified compression" 'compression is on: ZFS property compression=zstd-9'
  silent_on "the delegated script's own next steps are left out" 'Next steps'
  ends_with_the_two_steps "ends with the two steps that remain, in order"
  is "the dataset is mounted at the cold directory" "$("${zfs[@]}" get -H -o value mounted "$dataset") $("${zfs[@]}" get -H -o value mountpoint "$dataset")" "yes $mp"
  is "findmnt -no FSTYPE -T prints zfs" "$(findmnt -no FSTYPE -T "$mp")" zfs
  is "... and the dataset is its source" "$(findmnt -rn -M "$mp" -o SOURCE)" "$dataset"
  is "the cold properties" "$(for property in recordsize compression atime logbias; do "${zfs[@]}" get -H -o value "$property" "$dataset"; done | tr '\n' ' ')" "128K zstd-9 off throughput "
  holds "xattr is sa (which OpenZFS 2.3 prints as on)" bash -c "case \"\$($ZFS_TOOLS/zfs get -H -o value xattr $dataset)\" in sa|on) exit 0 ;; esac; exit 1"
  is "owner 999:999, mode 750" "$(stat -c '%u:%g %a' "$mp")" "999:999 750"
  is ".env" "$(cat "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$mp"

  changes_nothing "re-run with the same arguments" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "re-run with no layout flag" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... recognises the dataset" "Layout: the ZFS dataset $dataset — it is mounted there already"
  said "... reports nothing to change" 'nothing to change'
  changes_nothing "--size where the layout is a dataset: not used, and said so (dry run)" --size 40G --dry-run --mountpoint "$mp" --project-dir "$PROJ"
  said "... in so many words" "warn: --size 40G is not used: it is the size of a new loop image, and the layout here is the ZFS dataset $dataset"

  setpriv --reuid=999 --regid=999 --clear-groups bash -c "yes 'a closed month of packets, as repetitive as archives are' | head -c 200M > $mp/blob"
  "${zpool[@]}" sync "$pool"
  ratio="$("${zfs[@]}" get -H -o value compressratio "$dataset")"
  holds "what uid 999 writes there is compressed at least 5x (ZFS says $ratio)" awk -v ratio="${ratio%x}" 'BEGIN { exit !(ratio >= 5) }'
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  ok "status"
  said "status: what is set up" "layout +the ZFS dataset $dataset"
  said "status: compression" 'filesystem +zfs, compression on \(ZFS property compression=zstd-9\)'
  said "status: the ratio ZFS reports" "compression +${ratio//./\\.}"
  said "status: no fstab entry is needed" 'fstab +none \(this layout needs none\)'
  rm -f "$mp/blob"

  refuses "grow on ZFS: says what to do instead" 'a dataset has no size of its own, it shares the pool' grow --to 10G --mountpoint "$mp" --project-dir "$PROJ" --yes
  refuses "a pool that does not exist" "there is no ZFS pool named nopool$$" --zfs "nopool$$/cold" --mountpoint /srv/zother --no-env --yes
  refuses "a dataset whose parent does not exist" "the parent dataset $pool/deep does not exist" --zfs "$pool/deep/cold" --mountpoint /srv/zother --no-env --yes
  refuses "the dataset exists with another mountpoint" "the dataset $dataset exists with mountpoint $mp, not /srv/zother" --zfs "$dataset" --mountpoint /srv/zother --no-env --yes
  refuses "another dataset for the same mountpoint" "$mp is already the mountpoint of another dataset, $dataset" --zfs "$pool/second" --mountpoint "$mp" --no-env --yes
  refuses "an image path on ZFS" "$mp is on ZFS: an image there" --image "$mp/x.img" --size 4G --mountpoint /srv/zimage --no-env --yes
  "${zfs[@]}" set compression=lz4 "$dataset"
  refuses "the dataset exists with other properties" 'exists with other properties: compression=lz4 \(the cold layout has zstd-9\)' --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  "${zfs[@]}" set compression=zstd-9 "$dataset"
  "${zfs[@]}" set xattr=dir "$dataset"
  refuses "... xattr=dir is one, whatever this OpenZFS calls sa" 'exists with other properties: xattr=dir \(the cold layout has sa\)' --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  "${zfs[@]}" set xattr=sa "$dataset"
  changes_nothing "... and with the cold properties back there is nothing to change" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes

  # fstab lines for the cold directory of a dataset
  echo "/dev/null $mp ext4 defaults 0 0" >> /etc/fstab
  refuses "an fstab entry that would mount over the dataset" 'At boot it would mount another filesystem over this layout' --zfs "$dataset" --mountpoint "$mp" --no-env --yes
  sed -i "\\|^/dev/null $mp |d" /etc/fstab
  echo "$dataset $mp zfs defaults 0 0" >> /etc/fstab
  refuses "an fstab line for the dataset itself, which mount turns down" "/etc/fstab has a line for the dataset $dataset itself" --zfs "$dataset" --mountpoint "$mp" --no-env --yes
  run mount "$mp"
  if [ "$RC" -ne 0 ]; then pass "(... as mount itself shows: it does not take that line)"; else fail "(mount does not take that line)" "mount $mp went through"; fi
  said "(... and says why)" "cannot be mounted using 'mount'"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "... status flags the line: exit 1" 1
  said "... for what it is" 'fstab +UNEXPECTED entry for this dataset, which ZFS mounts itself'
  sed -i "\\|^$dataset $mp |d" /etc/fstab

  # another dataset with the same mountpoint that is not mounted: made by
  # hand, so nothing marks it as a copy (its mountpoint is as local as the
  # cold dataset's)
  "${zfs[@]}" create -o canmount=noauto -o mountpoint="$mp" "$pool/copy"
  is "(a second dataset with the cold directory as its mountpoint, not mounted)" "$("${zfs[@]}" get -H -o value mounted "$pool/copy")" no
  changes_nothing "an unmounted second dataset has the same mountpoint: the re-run goes through" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... with a warning that does not say which of the two is the copy" "warn: the ZFS dataset $pool/copy also has $mp as its mountpoint and is not mounted\\. Only one of the two is the cold dataset\\. If it is $dataset, which is mounted there: leave $pool/copy unmounted"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  ok "... status with the copy at canmount=noauto: mentioned, nothing to attend to"
  said "... by name" "also +the ZFS dataset $pool/copy has this directory as its mountpoint too and is not mounted \\(canmount=noauto\\)"
  "${zfs[@]}" set canmount=off "$pool/copy"
  changes_nothing "... a dataset that can never be mounted (canmount=off) claims nothing" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  silent_on "... and is not mentioned" "$pool/copy"
  "${zfs[@]}" destroy "$pool/copy"

  # Two datasets mounted at the cold directory, one over the other: a copy
  # made the usual way (send -p | receive -u keeps the mountpoint), then
  # mounted as zfs mount -a or a boot would mount it. Only the lab's own
  # dataset is named: zfs mount -a would reach the machine's other pools.
  "${zfs[@]}" snapshot "$dataset@copy"
  "${zfs[@]}" send -p "$dataset@copy" | "${zfs[@]}" receive -u "$pool/copy"
  is "(a received copy: the same mountpoint, canmount=on, not mounted)" "$(for property in mountpoint canmount mounted; do "${zfs[@]}" get -H -o value "$property" "$pool/copy"; done | tr '\n' ' ')" "$mp on no "
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "an unmounted copy that the next boot would mount over the cold dataset: status exits 1" 1
  said "... as it says" "$pool/copy has this directory as its mountpoint too and is NOT MOUNTED: at the next boot, or with zfs mount -a, it would cover what is here\\. Give it another mountpoint"
  changes_nothing "... the re-run goes through" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... and knows the received copy for one: leave it unmounted" "warn: the ZFS dataset $pool/copy also has $mp as its mountpoint and is not mounted\\. Leave it unmounted"
  silent_on "... mounting it is not the advice" "zfs mount (-l )?$pool/copy"
  "${zfs[@]}" mount "$pool/copy"
  is "(mounted: both are at the cold directory, the copy on top)" "$(findmnt -rn -M "$mp" -o SOURCE | tr '\n' ' ')" "$dataset $pool/copy "
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "two datasets are mounted at the cold directory: status exits 1" 1
  said "... names both, and which is on top" "stacked +MORE THAN ONE FILESYSTEM is mounted here, one over the other: $dataset, $pool/copy — the last is on top"
  refuses "... the re-run does not take the copy for the cold dataset" "more than one filesystem is mounted at $mp, one over the other: $dataset, $pool/copy" --mountpoint "$mp" --project-dir "$PROJ" --yes
  refuses "... nor with the cold dataset named" "more than one filesystem is mounted at $mp" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  silent_on "... and the copy is not offered as the dataset to keep using" "pass --zfs $pool/copy"
  refuses "... nor with --existing" "more than one filesystem is mounted at $mp" --existing "$mp" --project-dir "$PROJ" --yes
  # the way out as the message gives it
  umount "$mp"
  umount "$mp"
  "${zfs[@]}" set canmount=off "$pool/copy"
  "${zfs[@]}" mount -l "$dataset"
  is "(the way out: the directory unmounted twice, canmount=off on the copy, the cold dataset mounted again)" "$(findmnt -rn -M "$mp" -o SOURCE,FSTYPE)" "$dataset zfs"
  changes_nothing "... after it the re-run goes through" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  ok "... and status has nothing to say"

  # The copy alone is mounted and the cold dataset is not, as after a boot
  # at which the cold dataset did not mount (its key not loaded, its pool
  # late) and the copy did.
  umount "$mp"
  "${zfs[@]}" set canmount=on "$pool/copy"
  "${zfs[@]}" mount "$pool/copy" 2>/dev/null
  is "(only the copy is mounted at the cold directory)" "$(findmnt -rn -M "$mp" -o SOURCE | tr '\n' ' ')" "$pool/copy "
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "the copy is mounted in the cold dataset's place: status exits 1" 1
  said "... and says what it looks like" "also +the ZFS dataset $dataset has this directory as its mountpoint too and is NOT MOUNTED, while $pool/copy, which is mounted here, has its mountpoint from a zfs receive: it looks as if a copy is mounted in the cold dataset's place"
  silent_on "... the cold dataset is never what to keep from mounting" "canmount=off $dataset|give $dataset another mountpoint"
  refuses "... the re-run without a flag does not take the copy for the cold dataset" "$pool/copy, which is mounted at $mp, has its mountpoint from a zfs receive — it is a copy — and $dataset, which has the same mountpoint, is not mounted" --mountpoint "$mp" --project-dir "$PROJ" --yes
  refuses "... naming the cold dataset: the copy is in its place, and is not offered to --zfs" "$pool/copy is mounted at $mp in the place of $dataset, which has the same mountpoint and is not mounted" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  silent_on "... " "pass --zfs $pool/copy"
  # the swap as the message gives it
  umount "$mp"
  "${zfs[@]}" set canmount=off "$pool/copy"
  "${zfs[@]}" mount -l "$dataset"
  is "(the swap: the directory unmounted, canmount=off on the copy, the cold dataset mounted)" "$(findmnt -rn -M "$mp" -o SOURCE,FSTYPE)" "$dataset zfs"
  changes_nothing "... after it the re-run goes through" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... on the cold dataset" "Layout: the ZFS dataset $dataset — it is mounted there already"
  "${zfs[@]}" destroy -r "$pool/copy"
  "${zfs[@]}" destroy "$dataset@copy"

  # canmount=noauto on the cold dataset: mounted now, but not after a reboot
  "${zfs[@]}" set canmount=noauto "$dataset"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "the cold dataset has canmount=noauto and nothing in fstab mounts it: status exits 1" 1
  said "... it would not be mounted after a reboot" 'fstab +NO ENTRY — the dataset has canmount=noauto'
  changes_nothing "... the re-run goes through" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  said "... with a warning" "warn: the dataset $dataset has canmount=noauto"
  "${zfs[@]}" set canmount=on "$dataset"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  ok "... with canmount=on again, status has nothing to say"

  # readonly=on: the dataset takes no move
  "${zfs[@]}" set readonly=on "$dataset"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "the cold dataset with readonly=on: status exits 1" 1
  said "... and says so" 'the filesystem is mounted READ-ONLY'
  "${zfs[@]}" inherit readonly "$dataset"
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  ok "... read-write again, status has nothing to say"

  # snapdir=visible: a dataset shows ZFS's own .zfs directory at its root
  "${zfs[@]}" set snapdir=visible "$dataset"
  changes_nothing "the cold dataset with snapdir=visible: the re-run goes through" --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  "${zfs[@]}" inherit snapdir "$dataset"
  "${zfs[@]}" create -o compression=zstd-9 -o snapdir=visible -o mountpoint=/srv/zvis "$pool/vis"
  is "(ls -A of that empty dataset shows .zfs)" "$(ls -A /srv/zvis)" .zfs
  setup --existing /srv/zvis --no-env --yes
  ok "--existing: a dataset whose snapshot directory is visible is taken as empty"
  "${zfs[@]}" destroy "$pool/vis"

  # ZFS keeps a mountpoint as it was typed and mounts at the real place
  "${zfs[@]}" create -o compression=zstd-9 -o mountpoint=/srv/zts/ "$pool/ts"
  is "(the property keeps the trailing slash; the mount is at the directory)" "$("${zfs[@]}" get -H -o value mountpoint "$pool/ts") $(findmnt -rn -M /srv/zts -o SOURCE)" "/srv/zts/ $pool/ts"
  "${zfs[@]}" unmount "$pool/ts"
  refuses "an unmounted dataset whose mountpoint was typed with a trailing slash: no second dataset is planned for its directory" "the ZFS dataset $pool/ts has /srv/zts as its mountpoint but is not mounted" --zfs "$pool/other" --mountpoint /srv/zts --no-env --dry-run
  setup status --mountpoint /srv/zts --project-dir "$bare"
  exits "... status: exit 1" 1
  said "... names it" "layout +NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: $pool/ts"
  "${zfs[@]}" destroy "$pool/ts"

  # a dataset with a space in its name, which findmnt -r writes as \x20
  "${zfs[@]}" create -o compression=zstd-9 -o mountpoint=/srv/zspace "$pool/cold data"
  is "(findmnt -r writes the space as an escape)" "$(findmnt -rn -M /srv/zspace -o SOURCE)" "$pool/cold\\x20data"
  refuses "a dataset with a space in its name is mounted there: it is not handed to zfs under another name" "/srv/zspace is the mountpoint of the dataset '$pool/cold data', a name this script does not pass on to zfs" --mountpoint /srv/zspace --no-env --yes
  usage_error "... and --zfs does not take such a name" "--zfs '$pool/cold data'" --zfs "$pool/cold data" --mountpoint /srv/zspace --no-env --yes
  setup --existing /srv/zspace --no-env --yes
  ok "... --existing adopts it"
  setup status --mountpoint /srv/zspace --project-dir "$bare"
  ok "... status"
  said "... prints the name as it is" "layout +the ZFS dataset $pool/cold data\$"
  "${zfs[@]}" destroy "$pool/cold data"

  # an encrypted dataset whose key is not loaded: the advice has to load it
  echo 'a passphrase for the lab' > "$LAB/zkey"
  if "${zfs[@]}" create -o encryption=on -o keyformat=passphrase -o "keylocation=file://$LAB/zkey" -o compression=zstd-9 -o mountpoint=/srv/zenc "$pool/enc" > "$OUT" 2>&1; then
    setup --existing /srv/zenc --no-env --yes
    ok "--existing: an encrypted dataset"
    "${zfs[@]}" unmount "$pool/enc"
    "${zfs[@]}" unload-key "$pool/enc"
    setup status --mountpoint /srv/zenc --project-dir "$bare"
    exits "... unmounted, its key not loaded: status exits 1" 1
    said "... and the command it gives loads the key" "If it is the cold dataset: zfs mount -l $pool/enc"
    run "${zfs[@]}" mount "$pool/enc"
    if [ "$RC" -ne 0 ]; then pass "(... zfs mount without -l does not mount it)"; else fail "(zfs mount without -l fails while the key is not loaded)" "it went through"; fi
    run "${zfs[@]}" mount -l "$pool/enc"
    ok "(... the zfs mount -l that status gives does)"
    setup status --mountpoint /srv/zenc --project-dir "$bare"
    ok "... and status has nothing to say again"
    "${zfs[@]}" destroy "$pool/enc"
  else
    fail "an encrypted dataset for the lab" "$(tail -n 1 "$OUT")"
  fi
  rm -f "$LAB/zkey"

  # the cold dataset itself not mounted: what is at the path is the bare directory
  "${zfs[@]}" unmount "$dataset"
  refuses "the dataset is not mounted: an image is not put on the bare directory" "the ZFS dataset $dataset has $mp as its mountpoint but is not mounted" --image /hostfs/zreal.img --size 4G --mountpoint "$mp" --no-env --yes
  refuses "... nor is --existing given it" "the ZFS dataset $dataset has $mp as its mountpoint but is not mounted" --existing "$mp" --no-env --yes
  setup status --mountpoint "$mp" --project-dir "$PROJ"
  exits "... status: exit 1" 1
  said "... says that the dataset is not mounted" "layout +NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: $dataset"
  setup --zfs "$dataset" --mountpoint "$mp" --project-dir "$PROJ" --yes
  ok "... naming the dataset mounts it again"
  is "... at the cold directory" "$(findmnt -rn -M "$mp" -o SOURCE,FSTYPE)" "$dataset zfs"

  # a dataset with mountpoint=legacy, mounted by its own fstab line
  "${zfs[@]}" create -o mountpoint=legacy -o compression=zstd-9 "$pool/legacy"
  mkdir -p /srv/zlegacy
  echo "$pool/legacy /srv/zlegacy zfs defaults,nofail 0 0" >> /etc/fstab
  run mount /srv/zlegacy
  ok "(a dataset with mountpoint=legacy, mounted by its own fstab line)"
  refuses "a legacy dataset mounted by its own fstab line, no layout flag" "the dataset $pool/legacy has mountpoint=legacy, and /etc/fstab is what mounts it at /srv/zlegacy" --mountpoint /srv/zlegacy --no-env --yes
  said "... is pointed to --existing" 'To use it as it is, pass --existing /srv/zlegacy'
  setup --existing /srv/zlegacy --no-env --yes
  ok "... and --existing adopts it"
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  ok "... status takes the line for what it is"
  said "... and prints it as the entry" "fstab +$pool/legacy /srv/zlegacy zfs defaults,nofail 0 0"
  sed -i "\\|^$pool/legacy /srv/zlegacy |d" /etc/fstab
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  exits "... without the line, status says that it would not be mounted after a reboot: exit 1" 1
  said "... in so many words" 'fstab +NO ENTRY — the dataset has mountpoint=legacy'
  # ... and with a line that carries zfsutil, which mount turns down for a legacy dataset
  echo "$pool/legacy /srv/zlegacy zfs zfsutil,nofail 0 0" >> /etc/fstab
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  exits "a legacy dataset whose fstab line carries zfsutil: status exits 1" 1
  said "... for what it is" 'fstab +UNEXPECTED zfsutil option in the entry for this dataset, which has mountpoint=legacy'
  refuses "... and setup says what to do with the line" "the dataset $pool/legacy has mountpoint=legacy, and its line in /etc/fstab carries the zfsutil option" --mountpoint /srv/zlegacy --no-env --yes
  umount /srv/zlegacy
  run mount /srv/zlegacy
  if [ "$RC" -ne 0 ]; then pass "(... as mount itself shows: it does not take that line)"; else fail "(mount does not take a zfsutil line for a legacy dataset)" "mount /srv/zlegacy went through"; fi
  setup status --mountpoint /srv/zlegacy --project-dir "$bare"
  exits "... not mounted: status exits 1" 1
  said "... and the advice is not the mount that has just failed" 'layout +NOT MOUNTED — /etc/fstab has an entry for it\. To mount it: take the zfsutil option out of that line'
  sed -i "\\|^$pool/legacy /srv/zlegacy |d" /etc/fstab
  "${zfs[@]}" destroy "$pool/legacy"
  rmdir /srv/zlegacy

  # --existing: a dataset made elsewhere
  "${zfs[@]}" create -o compression=off -o mountpoint=/srv/zplain "$pool/plain"
  refuses "--existing: a dataset with compression off" "compression is off for /srv/zplain \\(zfs\\): the dataset $pool/plain has compression=off" --existing /srv/zplain --no-env --yes
  "${zfs[@]}" set compression=lz4 "$pool/plain"
  setup --existing /srv/zplain --no-env --yes
  ok "--existing: a dataset made elsewhere, with compression on"
  said "... how compression is on" 'compression is on: ZFS property compression=lz4'
  "${zfs[@]}" destroy "$pool/plain"

  # ZFS.md's own command for a dataset made by hand
  "${zfs[@]}" create -o recordsize=128K -o compression=zstd-9 -o atime=off -o xattr=sa -o logbias=throughput -o mountpoint=/srv/zhand "$pool/hand"
  setup --zfs "$pool/hand" --mountpoint /srv/zhand --no-env --yes
  ok "a dataset made by hand with ZFS.md's command: taken, not refused for its properties"
  is "... and handed to postgres" "$(stat -c '%u:%g %a' /srv/zhand)" "999:999 750"
  changes_nothing "... its re-run" --zfs "$pool/hand" --mountpoint /srv/zhand --no-env --yes
  said "... reports nothing to change" 'nothing to change'
  "${zfs[@]}" destroy "$pool/hand"

  # a second pool, whose root dataset is mounted
  if real_pool "$second" 1G -m /srv/zroot; then
    refuses "the root dataset of a pool is mounted at the cold directory" "/srv/zroot is the mountpoint of $second, the root dataset of a pool, which this script never sets up as cold storage" --mountpoint /srv/zroot --no-env --yes
    refuses "several pools: asks which one (a dry run, for the sake of the machine's own pools)" 'this host has [0-9]+ ZFS pools \(.*\): say which one takes the cold dataset' --mountpoint /srv/znew --no-env --dry-run
    drop_pool "$second"
  else
    fail "a second pool for the lab" "$(tail -n 1 "$OUT")"
  fi

  # a pool imported with an alternate root, as storage appliances import theirs
  if real_pool "$second" 1G -R /srv/zalt -O canmount=off; then
    refuses "a pool with an alternate root: no dataset is set up on it" "the pool $second is imported with an alternate root \\(/srv/zalt\\)" --zfs "$second/cold" --mountpoint /srv/znew --no-env --yes
    is "... and nothing was created on it" "$("${zfs[@]}" list -H -o name -r "$second" | tr '\n' ' ')" "$second "
    # ... a dataset made there in the host's own way is taken with --existing
    "${zfs[@]}" create -o compression=zstd-9 -o mountpoint=/cold "$second/cold"
    is "(ZFS puts the alternate root in front of the mountpoint it is given)" "$(findmnt -rn -M /srv/zalt/cold -o SOURCE)" "$second/cold"
    setup --existing /srv/zalt/cold --no-env --yes
    ok "... --existing takes a dataset made there in the host's own way"
    refuses "... and without a flag that dataset is pointed to --existing, not changed" "the dataset $second/cold is on a pool that is imported with an alternate root" --mountpoint /srv/zalt/cold --no-env --yes
    drop_pool "$second"
  else
    fail "a pool with an alternate root for the lab" "$(tail -n 1 "$OUT")"
  fi

  # a pool without the zstd feature, as an older ZFS made them
  if real_pool "$second" 1G -o feature@zstd_compress=disabled -O mountpoint=none -O canmount=off; then
    refuses "a pool without the zstd feature: refused before anything is created" "the pool $second does not have the zstd feature" --zfs "$second/cold" --mountpoint /srv/znew --no-env --yes
    is "... nothing was created on it" "$("${zfs[@]}" list -H -o name -r "$second" | tr '\n' ' ')" "$second "
    "${zpool[@]}" set feature@zstd_compress=enabled "$second"
    setup --zfs "$second/cold" --mountpoint /srv/znew --no-env --yes
    ok "... with the feature enabled, as the message says, the setup goes through"
    is "... with zstd-9" "$("${zfs[@]}" get -H -o value compression "$second/cold")" zstd-9
    drop_pool "$second"
  else
    fail "a pool without the zstd feature for the lab" "$(tail -n 1 "$OUT")"
  fi

  # End to end on the dataset: the stack from the real compose files, with
  # the lab's stand-in for meshinfo, and the job itself moving a closed month.
  cd "$REPO" || exit 1
  docker compose down -v --remove-orphans >/dev/null 2>&1
  rm -f .env .env.bak-* config.toml
  cp "$HERE/docker-compose.override.yml" docker-compose.override.yml
  cat > config.toml <<'EOF'
[storage.postgres]
enabled = true
host = "postgres"
port = 5432
database = "meshinfo"
username = "postgres"
password = "password"

[storage.tiering]
enabled = true
cold_filesystem = "/mnt/meshinfo-cold"
EOF
  setup --zfs "$dataset" --mountpoint "$mp" --yes
  ok "the one command for the checkout the stack runs from: the dataset is there, .env is written"
  is "... .env: the override file Compose was loading, then the overlay" "$(cat .env)" "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$mp"
  run docker compose up -d postgres meshinfo
  ok "docker compose up -d, with the dataset bound through the cold overlay"
  holds "postgres is ready" wait_for_postgres "$REPO"
  run bash -c "docker compose exec -T postgres psql -X -q -U postgres -d meshinfo -v ON_ERROR_STOP=1 -f - < benchmarks/zfs-tiering-2026-11-04/lab/schema_full.sql"
  ok "the schema is loaded"
  month="$(months_ago 3)"
  run docker compose exec -T meshinfo python3 scripts/synth_history.py --dsn postgresql://postgres:password@postgres:5432/meshinfo --from "$month" --to "$month" --packets-per-month 9000
  ok "synthetic history for $month (9000 packets)"
  psql_at "CHECKPOINT" >/dev/null
  before="$(psql_at "SELECT (SELECT count(*) FROM mqtt_messages), (SELECT count(*) FROM packet_receptions)")"
  # what the script itself counts as due to move, for the job to be held against
  due="$(bash -c 'source "$1"; db_cold_partitions "$2" 1 meshinfo_cold mqtt_messages,packet_receptions' sourced "$SCRIPT" "$(docker compose ps -q postgres)" | wc -l)"
  holds "the closed month is due to move ($due partitions, as the script counts them)" test "$due" -ge 2
  setup status --mountpoint "$mp"
  ok "status with the stack running"
  said "status: postgres sees the dataset" 'postgres: sees the cold filesystem at /var/lib/postgresql/cold'
  said "status: meshinfo sees the dataset" 'meshinfo: sees the cold filesystem at /mnt/meshinfo-cold'
  json="$LAB/zfs-tier-run.json"
  docker compose exec -T meshinfo python3 scripts/tier_partitions.py run --apply --all --json > "$json" 2>"$OUT"
  RC=$?
  ok "tier_partitions.py run --apply --all, in the meshinfo container: the tablespace is made on the dataset, the month moves"
  moved="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['moved'], d['refused'], d['busy'], d['failed'])" "$json" 2>&1)"
  is "every partition that was due moved; none refused by the free-space guard, busy or failed" "$moved" "$due 0 0 0"
  is "... and they are on the meshinfo_cold tablespace" "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE t.spcname = 'meshinfo_cold' AND c.relkind = 'r'")" "$due"
  run docker compose exec -T meshinfo python3 scripts/tier_partitions.py plan --all --json
  is "nothing is left to move" "$(python3 -c "import json,sys; print(len(json.load(sys.stdin)))" < "$OUT")" 0
  is "the tablespace is where the overlay binds the dataset" "$(psql_at "SELECT pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname = 'meshinfo_cold'")" /var/lib/postgresql/cold
  files="$(find "$mp" -type f | wc -l)"
  holds "its files are on the dataset ($files files under $mp)" test "$files" -gt 4
  is "no row was lost or gained" "$(psql_at "SELECT (SELECT count(*) FROM mqtt_messages), (SELECT count(*) FROM packet_receptions)")" "$before"
  is "the month reads from the dataset" "$(psql_at "SELECT count(*) > 0 FROM mqtt_messages_${month/-/_}")" t
  psql_at "CHECKPOINT" >/dev/null
  "${zpool[@]}" sync "$pool"
  ratio="$("${zfs[@]}" get -H -o value compressratio "$dataset")"
  holds "ZFS compressed the month at least 2x (it says $ratio)" awk -v ratio="${ratio%x}" 'BEGIN { exit !(ratio >= 2) }'
  setup status --mountpoint "$mp"
  ok "status after the move"
  said "status: the ratio ZFS reports" "compression +${ratio//./\\.}"
  said "status: the tablespace's own mode is accepted" 'owner +999:999, mode 700 \(PostgreSQL set that'
  changes_nothing "the one command again, everything done" --yes
  said "... recognises the dataset" "Layout: the ZFS dataset $dataset — it is mounted there already"
  said "... and finds nothing left to do" 'Nothing remains to do\. The two steps this script leaves to you are done'
  docker compose down -v --remove-orphans >/dev/null 2>&1
  rm -f .env .env.bak-* config.toml docker-compose.override.yml
  cd / || exit 1

  PREFIX=()
  # What the script could have done to a pool of the machine: a dataset that
  # is new or changed, named as the cold dataset or mounted where this
  # section works. Anything else that changed there, the machine did itself.
  changed="$(comm -13 <(sort <<<"$foreign") <(foreign_datasets "$pool" | sort))"
  is "nothing on another pool is new or changed that this section could have made (a meshinfo-cold dataset, a mountpoint under /srv)" "$(awk -F'\t' '$1 ~ /\/meshinfo-cold$/ || $2 ~ /^\/srv(\/|$)/' <<<"$changed")" ""
  if [ -n "$changed" ]; then note "other pools changed while the section ran: $(tr '\n\t' '; ' <<<"$changed")"; fi
  drop_pool "$pool"
  holds "the lab's pools are gone again" bash -c "! $ZFS_TOOLS/zpool list -H -o name | grep -q '^$pool'"
  rm -rf "$mp" /srv/zother /srv/zhand /srv/zplain /srv/zlegacy /srv/zroot /srv/znew /srv/zvis /srv/zts /srv/zspace /srv/zenc /srv/zalt
}

t_stack() {
  local month want needed tight tight_bytes tight_inside count got image_bytes cold total before after moved json packets
  local script_order job_order config_before first adopted
  section "the stack, running in the lab's own Docker daemon from the real compose files"
  cd "$REPO" || exit 1
  docker compose down -v --remove-orphans >/dev/null 2>&1
  rm -f .env .env.bak-* config.toml
  cp "$HERE/docker-compose.override.yml" docker-compose.override.yml
  cat > config.toml <<'EOF'
[storage.postgres]
enabled = true
host = "postgres"
port = 5432
database = "meshinfo"
username = "postgres"
password = "password"

[storage.tiering]
min_free_mb = 6000
EOF
  run docker compose up -d postgres meshinfo
  ok "docker compose up (docker-compose.yml + the lab's override; no overlay yet)"
  holds "postgres is ready" wait_for_postgres "$REPO"
  run bash -c "docker compose exec -T postgres psql -X -q -U postgres -d meshinfo -v ON_ERROR_STOP=1 -f - < benchmarks/zfs-tiering-2026-11-04/lab/schema_full.sql"
  ok "the schema is loaded"
  # four closed months of different sizes, so that the order of the moves shows
  for packets in 5:14000 4:4000 3:9000 2:6000; do
    month="$(months_ago "${packets%%:*}")"
    run docker compose exec -T meshinfo python3 scripts/synth_history.py --dsn postgresql://postgres:password@postgres:5432/meshinfo --from "$month" --to "$month" --packets-per-month "${packets##*:}"
    ok "synthetic history for $month (${packets##*:} packets)"
  done
  first="$(months_ago 5)"
  psql_at "VACUUM ANALYZE" >/dev/null
  psql_at "CHECKPOINT" >/dev/null

  month="$(psql_at "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')")"
  partitions() { psql_at "SELECT c.relname, pg_total_relation_size(c.oid) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent IN ('mqtt_messages'::regclass, 'packet_receptions'::regclass)"; }
  script_order="$(bash -c 'source "$1"; db_cold_partitions "$2" 1 meshinfo_cold mqtt_messages,packet_receptions' sourced "$SCRIPT" "$(docker compose ps -q postgres)" | awk '{ print $1 }' | tr '\n' ' ')"
  read -r want needed tight tight_bytes tight_inside count < <(partitions | python3 "$HERE/expected_size.py" "$month" 1 6000)
  changes_nothing "dry run with the stack running" --dry-run
  got="$(sed -n 's/.*fallocate -l \([0-9]*\) .*/\1/p' "$OUT")"
  is "the image size is worked out from the database (min_free_mb = 6000)" "$got" "$want"
  holds "... and is above the 4 GiB minimum" test "$want" -gt "$((4 * GIB))"
  said "... the reasoning names the settings" 'worked out from the running database \(cold_after_months = 1, min_free_mb = 6000\)'
  said "... how many partitions are due" "$count partitions are due to move"
  said "... and the tightest move, with what is inside by then at a quarter" "tightest: $tight \\($(human "$tight_bytes")\\) with $(human "$tight_inside") already inside"
  is "(eight partitions are due)" "$count" 8
  sed -i 's/^min_free_mb = 6000$/cold_after_months = 3/' config.toml
  read -r image_bytes _ < <(partitions | python3 "$HERE/expected_size.py" "$month" 3 2048)
  setup --dry-run
  got="$(sed -n 's/.*fallocate -l \([0-9]*\) .*/\1/p' "$OUT")"
  is "with the default min_free_mb the 4 GiB minimum applies" "$got $image_bytes" "$((4 * GIB)) $((4 * GIB))"
  said "... cold_after_months from config.toml is honoured" '4 partitions are due to move'
  setup --size 3G --dry-run
  said "a --size below what the database calls for is said to be" 'NOTE: that is less than the 4\.0 GiB the running database calls for'
  sed -i 's/^cold_after_months = 3$/min_free_mb = "6000"/' config.toml
  setup --dry-run
  said "a quoted number is a string, which the job ignores: the default is used" 'min_free_mb = 2048\)'
  sed -i 's/^min_free_mb = "6000"$/min_free_mb = 6_000\ntables = ["mqtt_messages"]/' config.toml
  read -r image_bytes _ _ _ _ count < <(partitions | python3 "$HERE/expected_size.py" "$month" 1 6000 mqtt_messages)
  setup --dry-run
  got="$(sed -n 's/.*fallocate -l \([0-9]*\) .*/\1/p' "$OUT")"
  is "tables = [\"mqtt_messages\"]: only that table is counted (and 6_000 reads as 6000)" "$got" "$image_bytes"
  said "... as the reasoning says" 'only mqtt_messages is counted'
  said "... four partitions then" "$count partitions are due to move"
  sed -i 's/^tables = .*/tables = "mqtt_messages"/' config.toml
  setup --dry-run
  got="$(sed -n 's/.*fallocate -l \([0-9]*\) .*/\1/p' "$OUT")"
  is "tables = \"mqtt_messages\" is a string, not a list: the job tiers both tables, and both are counted" "$got" "$want"
  sed -i -e '/^tables = /d' -e 's/^min_free_mb = 6_000$/min_free_mb = 6000/' config.toml
  refuses "the smallest size follows config.toml: with min_free_mb = 6000 a 4 GiB image could never take a month" '4\.0 GiB is too small to ever take a month: before a move the job wants min_free_mb \(6000 MiB\) free .* The smallest that makes sense here is 8\.0 GiB' --size 4G --yes

  config_before="$(sha256sum < config.toml)"
  setup --yes
  ok "the one command: no arguments, the stack running"
  is "the image has the size worked out" "$(stat -c %s "$DEFAULT_IMAGE")" "$want"
  holds "the new filesystem really has the room the guard will ask for" test "$(($(stat -f -c '%a * %S' "$MP")))" -ge "$needed"
  is ".env: the files the stack runs with are kept, then the overlay" "$(cat .env)" "COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml
MESHINFO_PGCOLD_DIR=$MP"
  is "config.toml is not touched" "$(sha256sum < config.toml)" "$config_before"
  said "the running containers do not have the bind yet" 'postgres: NOTHING is bound at /var/lib/postgresql/cold'
  ends_with_the_two_steps "ends with the two steps that remain, in order"
  silent_on "... without the hint for containers that already have the bind" 'docker compose restart'

  printf 'enabled = true\ncold_filesystem = "/mnt/meshinfo-cold"\n' >> config.toml
  run docker compose up -d postgres meshinfo
  ok "the two steps: the printed lines into config.toml, docker compose up -d"
  holds "postgres is ready" wait_for_postgres "$REPO"
  setup status
  ok "status: all is well"
  said "status: postgres sees the mount" 'postgres: sees the cold filesystem at /var/lib/postgresql/cold'
  said "status: meshinfo sees the mount" 'meshinfo: sees the cold filesystem at /mnt/meshinfo-cold'

  before="$(psql_at "SELECT (SELECT count(*) FROM mqtt_messages), (SELECT count(*) FROM packet_receptions)")"
  docker compose exec -T meshinfo python3 scripts/tier_partitions.py run --apply --max 1 --json > "$LAB/tier-first.json" 2>"$OUT"
  RC=$?
  ok "tier_partitions.py run --apply --max 1, in the meshinfo container: the tablespace is made, the first partition moves"
  docker compose exec -T meshinfo python3 scripts/tier_partitions.py plan --all --json > "$LAB/tier-plan.json" 2>"$OUT"
  job_order="$(python3 -c '
import json, sys
first = json.load(open(sys.argv[1]))["results"][0]["partition"]
rest = [item["partition"]["name"] for item in json.load(open(sys.argv[2]))]
print(" ".join([first] + rest))' "$LAB/tier-first.json" "$LAB/tier-plan.json" 2>&1)"
  is "the script counted the partitions the job moves, in the job's own order" "${script_order% }" "$job_order"
  json="$LAB/tier-run.json"
  docker compose exec -T meshinfo python3 scripts/tier_partitions.py run --apply --all --json > "$json" 2>"$OUT"
  RC=$?
  ok "tier_partitions.py run --apply --all"
  moved="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['moved'], d['refused'], d['busy'], d['failed'])" "$json" 2>&1)"
  is "every other cold partition moved; none refused by the free-space guard, busy or failed" "$moved" "7 0 0 0"
  cold="$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE t.spcname = 'meshinfo_cold' AND c.relkind = 'r'")"
  is "eight partitions are on the meshinfo_cold tablespace" "$cold" 8
  is "the tablespace is where the script put the filesystem" "$(psql_at "SELECT pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname = 'meshinfo_cold'")" /var/lib/postgresql/cold
  total="$(find "$MP" -type f | wc -l)"
  holds "its files are on the image ($total files under $MP)" test "$total" -gt 16
  after="$(psql_at "SELECT (SELECT count(*) FROM mqtt_messages), (SELECT count(*) FROM packet_receptions)")"
  is "no row was lost or gained" "$after" "$before"
  is "PostgreSQL made the directory 700 when it created the tablespace" "$(stat -c '%u:%g %a' "$MP")" "999:999 700"
  run docker compose exec -T meshinfo python3 scripts/tier_partitions.py plan --all --json
  is "nothing is left to move" "$(python3 -c "import json,sys; print(len(json.load(sys.stdin)))" < "$OUT")" 0
  psql_at "CHECKPOINT" >/dev/null; sync
  setup status
  ok "status after the move"
  said "status: the months are compressed on disk" 'compression +[0-9.]+x \('
  said "status: the tablespace's own mode is accepted" 'owner +999:999, mode 700 \(PostgreSQL set that'
  holds "... at least 3x" bash -c "compsize -b $MP | awk '\$1 == \"TOTAL\" { exit !(\$4 / \$3 >= 3) }'"

  setup grow --to "$((want / GIB + 2))G" --yes
  ok "grow by 2 GiB while postgres has the tablespace open"
  is "... a cold month still reads" "$(psql_at "SELECT count(*) > 0 FROM mqtt_messages_${first/-/_}")" t

  changes_nothing "the one command again, everything done" --yes
  said "... finds nothing left to do, and still shows the two lines" 'Nothing remains to do\. The two steps this script leaves to you are done'
  silent_on "... and does not say that two steps remain" 'Two steps remain'
  touch config.toml
  setup --yes
  ok "config.toml changed after meshinfo was started"
  said "... one step is named: meshinfo reads the file only when it starts" 'One step remains: config.toml has the two \[storage.tiering\] lines, but it was'
  docker compose restart meshinfo >/dev/null 2>&1
  setup --yes
  said "... after docker compose restart meshinfo nothing remains" 'Nothing remains to do'
  sed -i 's/^enabled = true$/enabled = "true"/' config.toml
  setup --yes
  said "enabled = \"true\" is a string, which leaves the job off: the two steps are shown again" 'Two steps remain'
  silent_on "... and not as done" 'both lines are there already'
  sed -i 's/^enabled = "true"$/enabled = true/' config.toml

  docker compose pause meshinfo >/dev/null 2>&1
  setup status
  exits "a container that cannot be looked into (paused): status exits 1" 1
  said "... says that, not that the bind is stale" 'meshinfo: COULD NOT look inside the container'
  docker compose unpause meshinfo >/dev/null 2>&1

  docker compose stop postgres meshinfo >/dev/null 2>&1
  umount "$MP"
  docker compose start postgres meshinfo >/dev/null 2>&1
  mount "$MP"
  wait_for_postgres "$REPO"
  setup status
  exits "containers started while the filesystem was unmounted: status exits 1" 1
  said "... postgres shows the bare directory" 'postgres: /var/lib/postgresql/cold shows the bare directory underneath, NOT the filesystem'
  said "... so does meshinfo, and the fix is named" 'meshinfo: /mnt/meshinfo-cold shows the bare directory underneath, NOT the filesystem .* docker compose restart postgres meshinfo'
  setup --yes
  ok "the one command, run in that state"
  said "... says that up -d will not fix it and what will" 'does not recreate it:'
  docker compose restart postgres meshinfo >/dev/null 2>&1
  wait_for_postgres "$REPO"
  setup status
  ok "after docker compose restart postgres meshinfo: status is clean again"
  is "... and the cold month reads again" "$(psql_at "SELECT count(*) > 0 FROM mqtt_messages_${first/-/_}")" t

  cp .env "$LAB/env.keep"
  sed -i 's/:docker-compose.cold.yml//' .env
  docker compose up -d postgres meshinfo >/dev/null 2>&1
  wait_for_postgres "$REPO"
  setup status
  exits "the overlay dropped from COMPOSE_FILE: status exits 1" 1
  said "... .env is named" 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml does NOT list docker-compose.cold.yml'
  said "... and the missing bind" 'postgres: NOTHING is bound at /var/lib/postgresql/cold'
  cat "$LAB/env.keep" > .env
  docker compose up -d postgres meshinfo >/dev/null 2>&1
  wait_for_postgres "$REPO"
  setup status
  ok "the overlay back: status is clean again"

  # the running stack's own cold directory is not replaced by another
  refuses "the running postgres binds this cold directory: another one is refused" "the running postgres container already has $MP bound at /var/lib/postgresql/cold" --existing /btrfszstd/adopt --yes

  # The filesystem away (not mounted, no fstab line) while the database has
  # the tablespace: whatever is asked, no new filesystem takes its place.
  docker compose stop postgres meshinfo >/dev/null 2>&1
  umount "$MP"
  cp /etc/fstab "$LAB/fstab.keep"
  sed -i "\\|[[:space:]]${MP}[[:space:]]|d" /etc/fstab
  docker compose start postgres >/dev/null 2>&1
  holds "(postgres runs while the cold filesystem is away)" wait_for_postgres "$REPO"
  refuses "the filesystem is away and the database has the tablespace: nothing is created, no flag" "the running database already has the tablespace meshinfo_cold, which holds [0-9]+ of its tables and indexes: .* the filesystem that holds them is not at $MP now" --yes
  silent_on "... and dropping a tablespace that is in use is not the advice" 'DROP TABLESPACE'
  refuses "... nor with a layout named" "the running database already has the tablespace meshinfo_cold, which holds [0-9]+ of its tables and indexes: .* the filesystem that holds them is not at $MP now" --image /hostfs/second.img --size 9G --yes
  setup status
  exits "... status in that state: exit 1" 1
  said "... says that the tablespace's files are not here" 'tablespace +the database has meshinfo_cold, which holds [0-9]+ of its tables and indexes, but NO PG_\.\.\. directory is here'
  docker compose stop postgres >/dev/null 2>&1
  cat "$LAB/fstab.keep" > /etc/fstab
  mount "$MP"
  docker compose start postgres meshinfo >/dev/null 2>&1
  wait_for_postgres "$REPO"
  setup status
  ok "the filesystem back: status is clean again"
  is "... and the cold month reads" "$(psql_at "SELECT count(*) > 0 FROM mqtt_messages_${first/-/_}")" t

  # A filesystem is mounted at the cold directory, but it is not the one the
  # tablespace's files are on (played with the same one, the tablespace's
  # directory taken out of it): the re-run does not call that ready.
  docker compose stop postgres meshinfo >/dev/null 2>&1
  mkdir -p /hostfs/aside
  mv "$MP"/PG_* /hostfs/aside/
  docker compose start postgres >/dev/null 2>&1
  holds "(postgres runs while the tablespace's directory is not in the cold filesystem)" wait_for_postgres "$REPO"
  refuses "the cold filesystem is mounted, without the tablespace's directory: the re-run is refused" 'the running database has the tablespace meshinfo_cold, which holds [0-9]+ of its tables and indexes, but its PG_\.\.\. directory is not in' --yes
  said "... before anything is changed" 'Nothing was changed'
  silent_on "... it does not call that ready" 'Cold storage is ready'
  silent_on "... and dropping a tablespace that is in use is not the advice" 'DROP TABLESPACE'
  refuses "... a dry run says the same, not 'nothing to change'" 'but its PG_\.\.\. directory is not in' --dry-run
  setup status
  exits "... status says the same: exit 1" 1
  said "... in its own words" 'tablespace +the database has meshinfo_cold, which holds [0-9]+ of its tables and indexes, but NO PG_\.\.\. directory is here'
  # ... and where the run itself mounts the filesystem first (its own fstab
  # line), the same is found after the mount
  docker compose stop postgres >/dev/null 2>&1
  umount "$MP"
  docker compose start postgres >/dev/null 2>&1
  holds "(postgres runs while the cold filesystem is not mounted)" wait_for_postgres "$REPO"
  setup --yes
  exits "the run mounts the filesystem by its fstab line and finds the tablespace's directory missing: exit 1" 1
  said "... as a failed verification" 'verification failed: the running database has the tablespace meshinfo_cold, which holds [0-9]+ of its tables and indexes, but its PG_\.\.\. directory is not in'
  said "... and says that the mount stays" 'What this run did before \(a mount, the owner\) stays as it is'
  silent_on "... it does not call that ready either" 'Cold storage is ready'
  is "... the filesystem is mounted" "$(findmnt -rn -M "$MP" -o FSTYPE)" btrfs
  docker compose stop postgres >/dev/null 2>&1
  rmdir "$MP"/PG_* 2>/dev/null
  mv /hostfs/aside/PG_* "$MP"/
  rmdir /hostfs/aside
  docker compose start postgres meshinfo >/dev/null 2>&1
  wait_for_postgres "$REPO"
  setup --yes
  ok "the tablespace's directory back in the filesystem: the re-run is content again"
  said "... and has looked" "ok +the running database's tablespace meshinfo_cold has its directory there"
  is "... and the cold month reads" "$(psql_at "SELECT count(*) > 0 FROM mqtt_messages_${first/-/_}")" t

  docker compose down -v --remove-orphans >/dev/null 2>&1
  forget_cold "$MP"
  rm -f "$DEFAULT_IMAGE" .env .env.bak-* config.toml docker-compose.override.yml
  cd / || exit 1

  # stacks that were started with -f: the files they run with decide
  mkdir -p /btrfszstd/adopt
  new_project started-with-f
  printf 'services:\n  postgres:\n    environment:\n      LAB_EXTRA: "yes"\n' > "$PROJ/extra.yml"
  (cd "$PROJ" && docker compose -f docker-compose.yml -f extra.yml up -d postgres) >/dev/null 2>&1
  holds "(a stack started with -f docker-compose.yml -f extra.yml)" wait_for_postgres "$PROJ"
  setup --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  ok "setup beside it"
  is "... COMPOSE_FILE lists the files it runs with, then the overlay" "$(grep '^COMPOSE_FILE=' "$PROJ/.env")" "COMPOSE_FILE=docker-compose.yml:extra.yml:docker-compose.cold.yml"
  (cd "$PROJ" && docker compose down -v --remove-orphans) >/dev/null 2>&1
  chown 0:0 /btrfszstd/adopt; chmod 755 /btrfszstd/adopt

  new_project started-with-zfs
  mkdir -p "$LAB/zfs-hot" "$LAB/zfs-cold"
  (cd "$PROJ" && MESHINFO_ZFS_HOT="$LAB/zfs-hot" MESHINFO_ZFS_COLD="$LAB/zfs-cold" docker compose -f docker-compose.yml -f docker-compose.zfs.yml up -d postgres) >/dev/null 2>&1
  holds "(a stack started with -f docker-compose.yml -f docker-compose.zfs.yml)" bash -c "cd $PROJ && for _ in \$(seq 60); do docker compose -f docker-compose.yml -f docker-compose.zfs.yml exec -T postgres pg_isready -U postgres -d meshinfo >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1"
  refuses "the full ZFS layout is running: the cold-only overlay is not put on top" 'the running stack was started with docker-compose.zfs.yml, the full ZFS layout' --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  (cd "$PROJ" && MESHINFO_ZFS_HOT="$LAB/zfs-hot" MESHINFO_ZFS_COLD="$LAB/zfs-cold" docker compose -f docker-compose.yml -f docker-compose.zfs.yml stop postgres) >/dev/null 2>&1
  refuses "... nor when that stack is stopped" 'the stopped stack was started with docker-compose.zfs.yml, the full ZFS layout' --existing /btrfszstd/adopt --project-dir "$PROJ" --yes
  (cd "$PROJ" && MESHINFO_ZFS_HOT="$LAB/zfs-hot" MESHINFO_ZFS_COLD="$LAB/zfs-cold" docker compose -f docker-compose.yml -f docker-compose.zfs.yml down -v --remove-orphans) >/dev/null 2>&1
  rm -rf "$LAB/zfs-hot" "$LAB/zfs-cold"

  # .env written, and the stack started with the overlay, before the storage
  # was there: Docker made the bare directory. The database has no cold
  # tablespace, so nothing was ever moved and the storage can still be made.
  new_project ahead
  printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml\nMESHINFO_PGCOLD_DIR=/srv/ahead/pgcold\n' > "$PROJ/.env"
  (cd "$PROJ" && docker compose up -d postgres) >/dev/null 2>&1
  holds "(.env and the stack first: postgres runs ...)" wait_for_postgres "$PROJ"
  is "(... with the bare directory Docker made for the bind)" "$(stat -c '%u:%g' /srv/ahead/pgcold 2>&1) $(findmnt -no FSTYPE -T /srv/ahead/pgcold)" "0:0 overlay"
  setup --project-dir "$PROJ" --yes
  ok "the one command after that: the database has no cold tablespace, so the storage is still made"
  said "... as an image" "Layout: btrfs in a preallocated loop image, $DEFAULT_IMAGE"
  said "... sized at the minimum: no month to move yet" 'no month is old enough to move yet, so the minimum applies'
  is "... mounted over the directory Docker made" "$(findmnt -no FSTYPE -T /srv/ahead/pgcold) $(stat -c '%u:%g %a' /srv/ahead/pgcold)" "btrfs 999:999 750"
  said "... and the container that still shows the bare directory is pointed out" 'postgres: /var/lib/postgresql/cold shows the bare directory underneath, NOT the filesystem'
  said "... with what fixes it" 'does not recreate it:'
  (cd "$PROJ" && docker compose down -v --remove-orphans) >/dev/null 2>&1
  forget_cold /srv/ahead/pgcold
  rm -rf /srv/ahead
  rm -f "$DEFAULT_IMAGE"

  # A directory that compresses is not thereby the one the database uses: on
  # a root (here: a filesystem) that compresses too, the bare mountpoint of a
  # cold filesystem that is away passes every check --existing makes of the
  # directory. The database knows: it has the tablespace, and its PG_...
  # directory is not there.
  adopted=/btrfszstd/coldx
  rm -rf "$adopted" /btrfszstd/aside
  mkdir -p "$adopted" /btrfszstd/aside
  new_project adopted-away
  setup --existing "$adopted" --project-dir "$PROJ" --yes
  ok "(a directory on a compressing filesystem, adopted)"
  (cd "$PROJ" && docker compose up -d postgres) >/dev/null 2>&1
  holds "(... and the stack started with it)" wait_for_postgres "$PROJ"
  psql_in() { (cd "$PROJ" && docker compose exec -T postgres psql -X -q -U postgres -d meshinfo -At -v ON_ERROR_STOP=1 -c "$1"); }
  run psql_in "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
  ok "(the tablespace is created, as the job does on its first cycle)"
  holds "(... which puts its PG_ directory into the cold directory)" bash -c "compgen -G '$adopted/PG_*'"
  changes_nothing "the tablespace defined and its directory here: --existing has nothing to object to" --existing "$adopted" --project-dir "$PROJ" --yes
  # The tablespace's directory away while nothing is stored on it yet. That
  # is the ordinary state of a young install — the job creates the tablespace
  # before any month is due — whose filesystem did not come back after a
  # reboot, and also what a rollback leaves that stopped before its last step.
  (cd "$PROJ" && docker compose stop postgres) >/dev/null 2>&1
  mv "$adopted"/PG_* /btrfszstd/aside/
  chown 0:0 "$adopted"; chmod 755 "$adopted"
  (cd "$PROJ" && docker compose start postgres) >/dev/null 2>&1
  holds "(postgres runs with the tablespace's directory away)" wait_for_postgres "$PROJ"
  refuses "the tablespace has nothing on it yet and its directory is away: bringing the filesystem back comes first" "the running database already has the tablespace meshinfo_cold, with nothing stored on it yet: .* the filesystem that holds it is not at $adopted now\\. Bring it back" --existing "$adopted" --project-dir "$PROJ" --yes
  said "... dropping the tablespace comes second, and only for a filesystem that is gone for good" 'Only if that filesystem is gone for good: drop the tablespace \(DROP TABLESPACE meshinfo_cold'
  silent_on "... and it is not called a leftover" 'leftover'
  refuses "... the same with no layout flag" 'with nothing stored on it yet: .* Bring it back' --project-dir "$PROJ" --yes
  # ... and where a ZFS dataset (played by the stand-ins) has the path and is
  # not mounted, that dataset is what to mount
  rm -rf "$LAB/zfs-away"
  mkdir -p "$LAB/zfs-away/datasets"
  echo tank > "$LAB/zfs-away/pools"
  printf 'mountpoint=%s\ncompression=zstd-9\ncanmount=on\nmounted=no\n' "$adopted" > "$LAB/zfs-away/datasets/tank%cold"
  PREFIX=(env "PATH=$HERE/stubs:$PATH" "ZFS_STUB_STATE=$LAB/zfs-away")
  refuses "... with a ZFS dataset that has the path and is not mounted: mounting it is the advice" "and the ZFS dataset tank/cold, which has $adopted as its mountpoint, is not mounted\\. If it is the cold dataset, mount it \\(zfs mount -l tank/cold; -l loads the key of one that is encrypted\\) and run this again" --project-dir "$PROJ" --yes
  silent_on "... not looking for a filesystem elsewhere" 'Bring it back'
  PREFIX=()
  rm -rf "$LAB/zfs-away"
  setup status --project-dir "$PROJ"
  exits "... status in that state: exit 1" 1
  said "... says the same: bring it back first" 'tablespace +the database has meshinfo_cold, with nothing stored on it yet, but NO PG_\.\.\. directory is here: the filesystem it belongs on is not at this path\. Bring that one back'
  # the harmless way: the filesystem is back, and nothing else was needed
  (cd "$PROJ" && docker compose stop postgres) >/dev/null 2>&1
  mv /btrfszstd/aside/PG_* "$adopted"/
  (cd "$PROJ" && docker compose start postgres) >/dev/null 2>&1
  wait_for_postgres "$PROJ"
  setup --existing "$adopted" --project-dir "$PROJ" --yes
  ok "the filesystem back, the tablespace untouched: adopted again, nothing else needed"
  is "... and handed to postgres" "$(stat -c '%u:%g %a' "$adopted")" "999:999 750"
  # the other way: the filesystem is gone for good
  (cd "$PROJ" && docker compose stop postgres) >/dev/null 2>&1
  mv "$adopted"/PG_* /btrfszstd/aside/
  chown 0:0 "$adopted"; chmod 755 "$adopted"
  (cd "$PROJ" && docker compose start postgres) >/dev/null 2>&1
  wait_for_postgres "$PROJ"
  run psql_in "DROP TABLESPACE meshinfo_cold"
  ok "the filesystem gone for good: DROP TABLESPACE, as the advice has it"
  setup --existing "$adopted" --project-dir "$PROJ" --yes
  ok "... after which the directory is adopted"
  is "... and handed to postgres" "$(stat -c '%u:%g %a' "$adopted")" "999:999 750"
  # ... and should that filesystem turn up again later, its old PG_ directory
  # is in the way of the job's CREATE TABLESPACE, as the advice says
  mv /btrfszstd/aside/PG_* "$adopted"/
  run psql_in "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
  if [ "$RC" -ne 0 ]; then pass "(the old PG_ directory back in place: PostgreSQL does not create the tablespace over it)"; else fail "(PostgreSQL refuses a tablespace over an old PG_ directory)" "CREATE TABLESPACE went through"; fi
  said "(... and says why)" 'already in use as a tablespace'
  rm -rf "$adopted"/PG_*
  # the same with a table on the tablespace: now it is storage that is away
  run psql_in "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold'"
  ok "(with that directory removed, the tablespace is created again ...)"
  run psql_in "CREATE TABLE lab_moved (id int) TABLESPACE meshinfo_cold"
  ok "(... with a table on it)"
  psql_in "CHECKPOINT" >/dev/null 2>&1
  (cd "$PROJ" && docker compose stop postgres) >/dev/null 2>&1
  mv "$adopted"/PG_* /btrfszstd/aside/
  chown 0:0 "$adopted"; chmod 755 "$adopted"
  (cd "$PROJ" && docker compose start postgres) >/dev/null 2>&1
  holds "(postgres runs with the tablespace's files away)" wait_for_postgres "$PROJ"
  refuses "--existing for the bare directory while the tablespace's files are elsewhere" "the running database already has the tablespace meshinfo_cold, which holds 1 of its tables and indexes: .* the filesystem that holds them is not at $adopted now" --existing "$adopted" --project-dir "$PROJ" --yes
  silent_on "... dropping the tablespace is not the advice now" 'DROP TABLESPACE'
  is "... and the bare directory was not handed to postgres" "$(stat -c '%u:%g %a' "$adopted")" "0:0 755"
  refuses "... the same with no layout flag" 'which holds 1 of its tables and indexes' --project-dir "$PROJ" --yes
  setup status --project-dir "$PROJ"
  exits "... status in that state: exit 1" 1
  said "... says that the tablespace's files are not here" 'tablespace +the database has meshinfo_cold, which holds 1 of its tables and indexes, but NO PG_\.\.\. directory is here'
  # the files back where they belong: adopted without objection
  (cd "$PROJ" && docker compose stop postgres) >/dev/null 2>&1
  mv /btrfszstd/aside/PG_* "$adopted"/
  (cd "$PROJ" && docker compose start postgres) >/dev/null 2>&1
  wait_for_postgres "$PROJ"
  setup --existing "$adopted" --project-dir "$PROJ" --yes
  ok "the tablespace's directory back in place: --existing adopts it"
  is "... and the table on it reads" "$(psql_in "SELECT count(*) FROM lab_moved" 2>&1)" 0

  # Where the tablespace is, is what the database says — not "a PG_ directory
  # at the top of the cold directory": cold_tablespace_location may name a
  # directory below the bind, or a path the overlay does not bind at all.
  run psql_in "DROP TABLE lab_moved"
  run psql_in "DROP TABLESPACE meshinfo_cold"
  ok "(the tablespace dropped, with nothing on it and its directory in place)"
  mkdir "$adopted/ts" && chown 999:999 "$adopted/ts"
  run psql_in "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/cold/ts'"
  ok "(... and created again in a directory below the bind, as cold_tablespace_location allows)"
  setup status --project-dir "$PROJ"
  silent_on "status with the tablespace below the bind: it is not taken for a filesystem that is away" 'tablespace +the database has'
  run psql_in "DROP TABLESPACE meshinfo_cold"
  rm -rf "$adopted/ts"
  run bash -c "cd $PROJ && docker compose exec -T -u root postgres sh -c 'mkdir -p /var/lib/postgresql/elsewhere && chown postgres:postgres /var/lib/postgresql/elsewhere'"
  run psql_in "CREATE TABLESPACE meshinfo_cold LOCATION '/var/lib/postgresql/elsewhere'"
  ok "(the tablespace at a path the cold overlay does not bind)"
  setup status --project-dir "$PROJ"
  exits "status with the tablespace at a path the overlay does not bind: exit 1" 1
  said "... says where it is, and that the months go there" 'tablespace +the database has meshinfo_cold at /var/lib/postgresql/elsewhere, which is NOT under /var/lib/postgresql/cold'
  refuses "... and setup does not prepare a directory the job would not use" 'already has the tablespace meshinfo_cold at /var/lib/postgresql/elsewhere, which is not under /var/lib/postgresql/cold' --existing "$adopted" --project-dir "$PROJ" --yes
  silent_on "... nor does it speak of bringing a filesystem back" 'Bring it back'
  (cd "$PROJ" && docker compose down -v --remove-orphans) >/dev/null 2>&1
  rm -rf "$adopted" /btrfszstd/aside
}

t_pytest() {
  section "tests/test_setup_cold_storage.py on Linux"
  run python3 -m pytest -q -p no:cacheprovider "$REPO/tests/test_setup_cold_storage.py"
  ok "as root"
  said "... nothing skipped but the not-root check" '[0-9]+ passed, 1 skipped'
  run setpriv --reuid=65534 --regid=65534 --clear-groups env HOME=/tmp python3 -m pytest -q -p no:cacheprovider "$REPO/tests/test_setup_cold_storage.py"
  ok "as an unprivileged user, the way CI runs it"
  said "... nothing skipped" '[0-9]+ passed in'
}

# --- Main --------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || { echo "run this as root inside the lab container (run.sh does)" >&2; exit 1; }
[ -f /.dockerenv ] || { echo "this is not a container: the suite formats loop devices and rewrites /etc/fstab — use run.sh" >&2; exit 1; }
if [ "${1:-}" = cleanup ]; then stop_running_suite; cleanup; exit 0; fi
# Known to the cleanup command from here on, bootstrap included: it attaches
# loop devices too (the daemon it starts is detached, and is left running).
mkdir -p "$LAB"
echo "$$" > "$PID_FILE"
# At the end the record goes — this suite's own only: a bootstrap run by hand
# beside a running suite must not take that suite's record away.
forget_suite() { if [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$$" ]; then rm -f "$PID_FILE"; fi; }
trap forget_suite EXIT
bootstrap
if [ "${1:-}" = bootstrap ]; then exit 0; fi   # run.sh: start the inner daemon before loading its images
trap 'cleanup; forget_suite' EXIT
if [ $# -eq 0 ]; then set -- "${SECTIONS[@]}"; fi
for name in "$@"; do
  case " ${SECTIONS[*]} " in
    *" $name "*) "t_$name" ;;
    *) echo "no such section: $name (sections: ${SECTIONS[*]})" >&2; exit 2 ;;
  esac
done

printf '\n=== %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "${#NOT_RUN[@]}" -gt 0 ]; then
  printf '  NOT RUN here — %s\n' "${NOT_RUN[@]}"
fi
if [ "$FAIL" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILURES[@]}"
  exit 1
fi
