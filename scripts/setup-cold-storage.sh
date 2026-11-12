#!/usr/bin/env bash
# setup-cold-storage.sh — one command that prepares the compressed filesystem
# MeshInfo's tiered cold storage moves closed months onto (ZFS.md, "Cold-only
# setup"). Run it as root on the Docker host; --help shows the usage. Re-running
# is safe: what is there is verified, never recreated. config.toml is never edited.
set -euo pipefail
export LC_ALL=C
unset CDPATH   # exported, it makes cd print the directory, and $(cd ... && pwd) then holds two lines
# su and cron hand root a PATH without the sbin directories, where losetup,
# blkid, mkfs.btrfs and wipefs live on most distributions.
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZFS_SCRIPT="$SCRIPT_DIR/setup-zfs-datasets.sh"
FSTAB=/etc/fstab
OS_RELEASE=/etc/os-release

LABEL=meshinfo-cold
DEFAULT_MOUNTPOINT=/srv/meshinfo/pgcold
DEFAULT_IMAGE=/var/lib/meshinfo-cold.img
OWNER=999:999          # the postgres user of the official image
DIR_MODE=750
# The fstab options ZFS.md documents (the unit tests compare the two). For an
# image, nodiscard and X-fstrim.notrim keep the preallocation from being punched out.
FSTAB_OPTS_DEVICE='compress-force=zstd:9,noatime,nofail,x-systemd.device-timeout=30s,x-systemd.before=docker.service'
FSTAB_OPTS_IMAGE='loop,nodiscard,X-fstrim.notrim,compress-force=zstd:9,noatime,nofail,x-systemd.before=docker.service'
# The cold properties setup-zfs-datasets.sh gives a dataset (COLD_PROPS there).
ZFS_COLD_PROPS=(recordsize=128K compression=zstd-9 atime=off xattr=sa logbias=throughput)
ZFS_DATASET_NAME=meshinfo-cold
OVERLAY=docker-compose.cold.yml
FULL_ZFS_OVERLAY=docker-compose.zfs.yml
PG_COLD_PATH=/var/lib/postgresql/cold     # where the overlay binds the directory in postgres
APP_COLD_PATH=/mnt/meshinfo-cold          # ... and, read-only, in meshinfo

MIB=$((1024 * 1024))
GIB=$((1024 * MIB))
DEFAULT_IMAGE_BYTES=$((20 * GIB))   # when the database cannot be asked
MIN_IMAGE_BYTES=$((4 * GIB))        # floor of a computed size
HOST_RESERVE_BYTES=$((3 * GIB))     # left free on the filesystem holding an image
ASSUMED_RATIO=4                     # compression assumed for what is already inside
# What a new, empty btrfs does not report as free (first metadata and system
# chunks): 529 MiB up to 50 GiB, 2065 MiB above (btrfs-progs 6.14); rounded up.
BTRFS_OWN_BYTES=$((560 * MIB))
BTRFS_OWN_BYTES_LARGE=$((2100 * MIB))
BTRFS_LARGE_FROM=$((50 * GIB))
DB_TIME_LIMIT=60                    # seconds one question to the database may take
DB_RETRY_PAUSE=2                    # seconds between two tries at asking it
# btrfs rounds its size down to whole sectors (64 KiB at most): a filesystem
# that is smaller than its image by more than this was not grown to the end.
FS_SLACK=$((64 * 1024))
# [storage.tiering] defaults (config.py), used when config.toml does not say.
DEFAULT_MIN_FREE_MB=2048
DEFAULT_COLD_AFTER_MONTHS=1
DEFAULT_COLD_TABLESPACE=meshinfo_cold

if [ -t 1 ]; then C_HEAD=$'\033[1;36m'; C_OFF=$'\033[0m'; else C_HEAD=''; C_OFF=''; fi
if [ -t 2 ]; then C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_EOFF=$'\033[0m'; else C_WARN=''; C_ERR=''; C_EOFF=''; fi
log()  { printf '%s==>%s %s\n' "$C_HEAD" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s warn:%s %s\n' "$C_WARN" "$C_EOFF" "$*" >&2; }
err()  { printf '%sERROR:%s %s\n' "$C_ERR" "$C_EOFF" "$*" >&2; }
die()  { err "$@"; exit 1; }
usage_error() { err "$@"; echo "Try: $(basename "$0") --help" >&2; exit 2; }

usage() {
  cat <<EOF
Usage: sudo scripts/$(basename "$0") [setup] [LAYOUT] [OPTIONS]
       sudo scripts/$(basename "$0") status [--mountpoint DIR] [--project-dir DIR]
       sudo scripts/$(basename "$0") grow --to SIZE [--mountpoint DIR] [--project-dir DIR] [--yes] [--dry-run]

Prepares the compressed filesystem for MeshInfo's cold months (ZFS.md,
"Cold-only setup"): inspects the host, prints what it found and the plan,
asks, does it, verifies, and prints the two steps that remain (or says that
nothing does). Safe to re-run.

Layout: the first that applies, or the one you name:
  --existing DIR       adopt DIR, which is already on btrfs or ZFS with
                       compression on; no storage is created
  --device DEV         btrfs on a spare block device or partition (formats DEV)
  --zfs POOL/DATASET   a ZFS dataset through setup-zfs-datasets.sh --cold-only;
                       chosen by itself when the host has one pool, required
                       when it has several
  --subvolume          a btrfs subvolume with the compression property; chosen
                       by itself when the cold directory's filesystem is btrfs
  --image PATH         btrfs in a preallocated loop image; chosen by itself
                       otherwise (default PATH: $DEFAULT_IMAGE)

Options:
  --mountpoint DIR     the cold directory (default: MESHINFO_PGCOLD_DIR from
                       .env, else $DEFAULT_MOUNTPOINT)
  --size SIZE          size of a new image, e.g. 20G or 20480M (default: worked
                       out from the running database, else 20G). Not taken
                       with --device, --zfs, --subvolume or --existing; where
                       the layout the script picks by itself is not an image,
                       it says that the size is not used
  --force              with --device: format a device that carries a filesystem
                       or partition-table signature
  --project-dir DIR    the checkout the stack runs from, for .env (default: the
                       directory above this script)
  --no-env             leave .env alone
  -y, --yes            do not ask for confirmation
  -n, --dry-run        print what was found and the plan; change nothing
  -h, --help           this text

Subcommands:
  status               what is set up, size and free space, the compression
                       ratio when it can be measured, the fstab entry, and
                       whether the running containers see the mount
  grow --to SIZE       enlarge a loop image online (other layouts: says what to
                       do instead)
EOF
}

# --- Pure helpers (no side effects; the unit tests source this file) ---

# human_bytes N: "20.0 GiB".
human_bytes() {
  awk -v b="$1" 'BEGIN {
    split("B KiB MiB GiB TiB PiB", unit, " "); i = 1
    while (b >= 1024 && i < 6) { b /= 1024; i++ }
    if (i == 1) printf "%d %s\n", b, unit[i]; else printf "%.1f %s\n", b, unit[i]
  }'
}

# parse_size TEXT: bytes for 20, 20G, 20GiB, 20480M, 1T (binary units; a bare
# number is GiB). Status 1 for anything else.
parse_size() {
  local number unit
  [[ "$1" =~ ^([0-9]{1,9})([A-Za-z]*)$ ]] || return 1
  number="$((10#${BASH_REMATCH[1]}))"
  unit="${BASH_REMATCH[2]}"
  case "$unit" in
    ''|G|g|GiB) echo $((number * GIB)) ;;
    M|m|MiB)    echo $((number * MIB)) ;;
    T|t|TiB)    [ "$number" -lt 8388608 ] || return 1   # 8 EiB: beyond shell arithmetic
                echo $((number * 1024 * GIB)) ;;
    *) return 1 ;;
  esac
}

round_up_gib() { echo $(( (($1 + GIB - 1) / GIB) * GIB )); }

# image_bytes_for NEEDED: the image on which NEEDED bytes are free when new
# (plus btrfs's own share), + 10 %, rounded up to a whole GiB, at least the minimum.
image_bytes_for() {
  local with_own sized
  with_own=$(( $1 + BTRFS_OWN_BYTES ))
  sized="$(round_up_gib $(( with_own + (with_own + 9) / 10 )))"
  if [ "$sized" -gt "$BTRFS_LARGE_FROM" ]; then
    with_own=$(( $1 + BTRFS_OWN_BYTES_LARGE ))
    sized="$(round_up_gib $(( with_own + (with_own + 9) / 10 )))"
  fi
  if [ "$sized" -lt "$MIN_IMAGE_BYTES" ]; then sized="$MIN_IMAGE_BYTES"; fi
  echo "$sized"
}

# simulate_guard MIN_FREE_BYTES RATIO < "name bytes" in the job's order; earlier moves count at 1/RATIO of their size.
# Prints: smallest filesystem that passes every move, the partition needing it, its size, the fill then, count, total.
simulate_guard() {
  awk -v minfree="$1" -v ratio="$2" '
    NF >= 2 {
      count++; total += $2
      need = inside + $2 + minfree
      if (need > worst) { worst = need; name = $1; bytes = $2; before = inside }
      inside += $2 / ratio
    }
    END { printf "%.0f %s %.0f %.0f %d %.0f\n", worst + 0, (count ? name : "-"), bytes + 0, before + 0, count + 0, total + 0 }'
}

fstab_line_image()  { printf '%s  %s  btrfs  %s  0 0\n' "$1" "$2" "$FSTAB_OPTS_IMAGE"; }
fstab_line_device() { printf 'LABEL=%s  %s  btrfs  %s  0 0\n' "$LABEL" "$1" "$FSTAB_OPTS_DEVICE"; }

# fstab_entries FILE MOUNTPOINT: the active lines of FILE for that mountpoint,
# compared as written and with symlinks resolved.
fstab_entries() {
  local line source target mounted
  [ -f "$1" ] || return 0
  # Mounted targets are compared as the kernel spells them and never touched: a
  # network mount whose server is away would hang the look.
  mounted="$(findmnt -rn -o TARGET 2>/dev/null || true)"
  while IFS= read -r line || [ -n "$line" ]; do
    read -r source target _ <<<"$line" || true
    case "$source" in
      ''|'#'*) continue ;;
    esac
    case "$target" in
      "$2") printf '%s\n' "$line" ;;
      /*) if grep -qxF -- "$target" <<<"$mounted"; then continue; fi
          if [ "$(canonical_path "$(normalize_path "$target")")" = "$2" ]; then printf '%s\n' "$line"; fi ;;
    esac
  done < "$1"
}

# fstab_key LINES: source, mountpoint, type and options of each, single-spaced,
# with symlinks in the two paths resolved (a hand-written line may spell them differently).
fstab_key() {
  local line source target type options
  while IFS= read -r line; do
    read -r source target type options _ <<<"$line" || true
    [ -n "$source" ] || continue
    case "$source" in /*) source="$(canonical_path "$(normalize_path "$source")")" ;; esac
    case "$target" in /*) target="$(canonical_path "$(normalize_path "$target")")" ;; esac
    printf '%s %s %s %s\n' "$source" "$target" "$type" "$options"
  done <<<"$1"
}

# fstab_targets_of FILE SOURCE: where the active lines of FILE mount the file
# or device SOURCE, compared as written and with symlinks resolved.
fstab_targets_of() {
  local line source target
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    read -r source target _ <<<"$line" || true
    case "$source" in
      "$2") printf '%s\n' "$target" ;;
      /*) if [ "$(canonical_path "$(normalize_path "$source")")" = "$2" ]; then printf '%s\n' "$target"; fi ;;
    esac
  done < "$1"
}

# normalize_path PATH: doubled slashes, "." components and trailing slashes removed.
normalize_path() {
  local path="$1"
  while [[ "$path" == *//* ]]; do path="${path//\/\//\/}"; done
  while [[ "$path" == */./* ]]; do path="${path//\/.\//\/}"; done
  while [[ "$path" == */. ]]; do path="${path%.}"; done
  while [ "${#path}" -gt 1 ] && [ "${path%/}" != "$path" ]; do path="${path%/}"; done
  printf '%s\n' "$path"
}

# plain_path PATH: absolute, no "..", only letters, digits and . _ - /, so it can go into
# /etc/fstab and .env unquoted (a colon would split source from target in the bind).
plain_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]*$ ]] && [ "$1" != / ] && [[ "/$1/" != */../* ]]; }

nearest_existing() {
  local path="$1"
  while [ ! -e "$path" ]; do path="$(dirname "$path")"; done
  printf '%s\n' "$path"
}

# canonical_path PATH: symlinks resolved in the part that exists.
canonical_path() {
  local base rest
  base="$(nearest_existing "$1")"
  if [ "$base" = / ]; then rest="$1"; else rest="${1#"$base"}"; fi
  base="$(readlink -f -- "$base")"
  if [ "$base" = / ]; then base=""; fi
  normalize_path "${base}${rest}"
}

# os_family: debian, fedora, rhel, suse, arch, alpine or unknown, from OS_RELEASE.
os_family() {
  local id="" like=""
  if [ -r "$OS_RELEASE" ]; then
    id="$(sed -n 's/^ID=//p' "$OS_RELEASE" | tr -d "\"'" | head -n 1)"
    like="$(sed -n 's/^ID_LIKE=//p' "$OS_RELEASE" | tr -d "\"'" | head -n 1)"
  fi
  case "$id" in
    debian|ubuntu|raspbian|linuxmint) echo debian; return ;;
    fedora) echo fedora; return ;;
    rhel|centos|rocky|almalinux) echo rhel; return ;;
    opensuse*|sles|sled) echo suse; return ;;
    arch|manjaro) echo arch; return ;;
    alpine) echo alpine; return ;;
  esac
  case " $like " in
    *" debian "*|*" ubuntu "*) echo debian ;;
    *" rhel "*|*" centos "*) echo rhel ;;
    *" fedora "*) echo fedora ;;
    *" suse "*|*" opensuse "*) echo suse ;;
    *" arch "*) echo arch ;;
    *) echo unknown ;;
  esac
}

# install_hint FAMILY WHAT: how to get btrfs | util | zfs | compsize there.
install_hint() {
  case "$2:$1" in
    btrfs:debian)    echo "apt-get install btrfs-progs" ;;
    btrfs:fedora)    echo "dnf install btrfs-progs" ;;
    btrfs:rhel)      echo "the RHEL family ships neither btrfs-progs nor btrfs in its kernel: use ZFS (--zfs POOL/DATASET) or a directory on a compressing filesystem (--existing DIR)" ;;
    btrfs:suse)      echo "zypper install btrfsprogs" ;;
    btrfs:arch)      echo "pacman -S btrfs-progs" ;;
    btrfs:alpine)    echo "apk add btrfs-progs" ;;
    btrfs:*)         echo "install the btrfs-progs package with your package manager" ;;
    util:debian)     echo "apt-get install util-linux mount" ;;
    util:fedora|util:rhel) echo "dnf install util-linux" ;;
    util:suse)       echo "zypper install util-linux" ;;
    util:arch)       echo "pacman -S util-linux" ;;
    util:alpine)     echo "apk add util-linux (the busybox applets of the same name are not enough)" ;;
    util:*)          echo "install the util-linux package with your package manager" ;;
    zfs:debian)      echo "apt-get install zfsutils-linux" ;;
    zfs:alpine)      echo "apk add zfs" ;;
    zfs:*)           echo "install the OpenZFS userland (zpool, zfs) with your package manager" ;;
    compsize:debian) echo "apt-get install btrfs-compsize" ;;
    compsize:fedora) echo "dnf install compsize" ;;
    compsize:suse)   echo "zypper install compsize" ;;
    compsize:arch)   echo "pacman -S compsize" ;;
    compsize:alpine) echo "apk add compsize" ;;
    compsize:*)      echo "install the compsize package" ;;
  esac
}

# env_get FILE KEY: value of the last active KEY=... line, quotes removed; status 1 when none.
# (The awk programs use [ \t], not [[:space:]]: mawk 1.3.3 does not know the class.)
env_get() {
  [ -f "$1" ] || return 1
  awk -v key="$2" '
    { line = $0; sub(/\r$/, "", line) }
    line ~ ("^[ \t]*(export[ \t]+)?" key "[ \t]*=") {
      value = line; sub(/^[^=]*=[ \t]*/, "", value)
      if (value ~ /^"/) { sub(/^"/, "", value); sub(/".*$/, "", value) }
      else if (value ~ /^\047/) { sub(/^\047/, "", value); sub(/\047.*$/, "", value) }
      else { sub(/[ \t]+#.*$/, "", value); sub(/[ \t]+$/, "", value) }
      found = 1
    }
    END { if (!found) exit 1; print value }' "$1"
}

# env_set FILE KEY VALUE: rewrite the last active KEY= line in place (quoting, trailing
# comment and line ending kept) or append one. The file keeps its inode, owner and mode.
env_set() {
  local file="$1" key="$2" new
  # No temporary file: the new text comes back through a pipe (the "." keeps
  # its last newline), and the shell's own printf reports a write that fails.
  new="$(NEW_VALUE="$3" awk -v key="$key" '
    { lines[NR] = $0
      line = $0; sub(/\r$/, "", line)
      if (line ~ ("^[ \t]*(export[ \t]+)?" key "[ \t]*=")) last = NR }
    END {
      value = ENVIRON["NEW_VALUE"]
      for (i = 1; i <= NR; i++) {
        if (i != last) { print lines[i]; continue }
        line = lines[i]; ending = ""
        if (line ~ /\r$/) { ending = "\r"; sub(/\r$/, "", line) }
        head = line; sub(/=.*$/, "=", head)
        rest = line; sub(/^[^=]*=[ \t]*/, "", rest)
        quote = ""; after = ""
        if (rest ~ /^"/) quote = "\""; else if (rest ~ /^\047/) quote = "\047"
        if (quote != "") {
          rest = substr(rest, 2); closing = index(rest, quote)
          if (closing) after = substr(rest, closing + 1)
        } else if (match(rest, /[ \t]+#.*$/)) {
          after = substr(rest, RSTART)
        }
        print head quote value quote after ending
      }
      if (!last) print key "=" value
    }' "$file" && echo .)" || die "could not work out the new text of $file — it was left as it was"
  printf '%s' "${new%.}" > "$file" || die "could not write $file (is its filesystem full?) — the copy made before this change holds what it had"
}

# compose_file_with_overlay CURRENT SEPARATOR OVERRIDE_FILE: COMPOSE_FILE with the cold overlay appended (with no
# CURRENT: docker-compose.yml, an existing override file, the overlay). Status 3: already listed; 4: the ZFS overlay is.
compose_file_with_overlay() {
  local current="$1" sep="$2" override="$3" entry
  local -a entries=()
  if [ -z "$current" ]; then
    current=docker-compose.yml
    if [ -n "$override" ]; then current="${current}${sep}${override}"; fi
    printf '%s%s%s\n' "$current" "$sep" "$OVERLAY"
    return 0
  fi
  IFS="$sep" read -r -a entries <<<"$current"
  for entry in "${entries[@]}"; do
    case "${entry##*/}" in
      "$OVERLAY") printf '%s\n' "$current"; return 3 ;;
      "$FULL_ZFS_OVERLAY") return 4 ;;
    esac
  done
  printf '%s%s%s\n' "$current" "$sep" "$OVERLAY"
}

# tiering_raw FILE KEY: KEY's value in the [storage.tiering] table of a config.toml, as written
# ("key = value" lines only: no dotted keys, no inline tables); status 1 when it is not there.
tiering_raw() {
  [ -f "$1" ] || return 1
  awk -v key="$2" '
    { sub(/\r$/, "") }
    /^[ \t]*\[/ { inside = ($0 ~ /^[ \t]*\[storage\.tiering\][ \t]*(#.*)?$/); next }
    inside && $0 ~ ("^[ \t]*" key "[ \t]*=") {
      value = $0; sub(/^[^=]*=[ \t]*/, "", value)
      if (value ~ /^"/) { if (match(value, /^"[^"]*"/)) value = substr(value, 1, RLENGTH) }
      else if (value ~ /^\047/) { if (match(value, /^\047[^\047]*\047/)) value = substr(value, 1, RLENGTH) }
      else { sub(/[ \t]*#.*$/, "", value); sub(/[ \t]+$/, "", value) }
      print value; found = 1; exit
    }
    END { exit !found }' "$1"
}

# tiering_setting FILE KEY: the same, with the quotes of a string removed.
tiering_setting() {
  local value
  value="$(tiering_raw "$1" "$2")" || return 1
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s\n' "$value"
}

# tiering_unreadable FILE: 0 when FILE sets tiering in a form the helpers above do not
# read (a dotted key, an inline table, quoted keys).
tiering_unreadable() {
  [ -f "$1" ] || return 1
  awk '
    { sub(/\r$/, "") }
    /^[ \t]*#/ { next }
    /^[ \t]*\[/ { inside = ($0 ~ /^[ \t]*\[storage\.tiering\][ \t]*(#.*)?$/); if (inside) header = 1 }
    inside && /^[ \t]*("|\047)/ { quoted = 1 }
    /tiering/ { mentioned = 1 }
    END { exit !((mentioned && !header) || quoted) }' "$1"
}

# --- Host inspection ---

# real_tool NAME: on PATH and not a busybox applet (busybox mount passes x-systemd.* options
# to the kernel, which rejects them; its losetup and blkid lack the options used here).
real_tool() {
  local path
  path="$(command -v "$1" 2>/dev/null)" || return 1
  [ -x "$path" ] || return 1   # bash names a file that cannot be run when PATH has no other
  case "$(readlink -f -- "$path" 2>/dev/null || printf '%s' "$path")" in
    */busybox) return 1 ;;
  esac
  return 0
}

# require_tools WHAT TOOL...: refuse, naming the package, when one is missing.
require_tools() {
  local what="$1" tool
  local -a missing=()
  shift
  for tool in "$@"; do
    real_tool "$tool" || missing+=("$tool")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0
  die "not found on this host: ${missing[*]} — $(install_hint "$(os_family)" "$what")"
}

# btrfs_loadable: the kernel has btrfs, or a module for it that is not loaded
# yet (modprobe -n is not there in busybox, hence the other two looks).
btrfs_loadable() {
  grep -qw btrfs /proc/filesystems 2>/dev/null && return 0
  if command -v modprobe >/dev/null 2>&1 && modprobe -n -q btrfs 2>/dev/null; then return 0; fi
  if command -v modinfo >/dev/null 2>&1 && modinfo btrfs >/dev/null 2>&1; then return 0; fi
  compgen -G "/lib/modules/$(uname -r)/kernel/fs/btrfs/btrfs.ko*" >/dev/null
}

# require_btrfs: refuse when the running kernel cannot mount btrfs. Nothing is
# loaded here; apply_btrfs_module does that once the plan is confirmed.
require_btrfs() {
  btrfs_loadable && return 0
  if [ "$(os_family)" = rhel ]; then
    die "this kernel has no btrfs — $(install_hint rhel btrfs)"
  fi
  die "this kernel has no btrfs (it is not in /proc/filesystems and there is no module for it): install the kernel modules package that carries it, or use ZFS (--zfs POOL/DATASET) or a directory on a compressing filesystem (--existing DIR)"
}

apply_btrfs_module() {
  grep -qw btrfs /proc/filesystems 2>/dev/null && return 0
  modprobe btrfs 2>/dev/null || true
  grep -qw btrfs /proc/filesystems 2>/dev/null || die "could not load the btrfs kernel module (modprobe btrfs)"
}

fstype_of() { findmnt -n -o FSTYPE -T "$(nearest_existing "$1")" 2>/dev/null | tail -n 1 || true; }

# avail_bytes DIR: what an unprivileged writer could still use there.
avail_bytes() {
  local blocks size
  read -r blocks size < <(stat -f -c '%a %S' "$1")
  echo $((blocks * size))
}

is_subvolume() {
  [ -d "$1" ] && [ "$(stat -c %i "$1" 2>/dev/null)" = 256 ] && [ "$(fstype_of "$1")" = btrfs ]
}

# owner_is_right DIR: owned by the postgres user, with mode 750 — or 700 once
# the tablespace is in it: CREATE TABLESPACE sets that mode on its directory.
owner_is_right() {
  local owner="" mode=""
  read -r owner mode < <(stat -c '%u:%g %a' "$1" 2>/dev/null) || return 1
  [ "$owner" = "$OWNER" ] || return 1
  [ "$mode" = "$DIR_MODE" ] || { [ "$mode" = 700 ] && compgen -G "$1/PG_*" >/dev/null; }
}

# owner_note DIR: "owner 999:999, mode 750", saying where a 700 comes from.
owner_note() {
  local mode
  mode="$(stat -c %a "$1" 2>/dev/null)"
  if [ "$mode" = 700 ]; then
    echo "owner $OWNER, mode 700 (PostgreSQL set that when it created the tablespace)"
  else
    echo "owner $OWNER, mode $mode"
  fi
}

# loop_backing_file LOOP_DEVICE: the path of the file behind it.
loop_backing_file() { losetup -n -O BACK-FILE "$1" 2>/dev/null | sed -e 's/[[:space:]]*$//' -e 's/ (deleted)$//' | head -n 1 || true; }

# loop_file_deleted LOOP_DEVICE: the backing file was removed or replaced at its path
# (a restore, rsync without --inplace), and the mount still writes to the file that is gone.
loop_file_deleted() {
  local file
  file="$(losetup -n -O BACK-FILE "$1" 2>/dev/null | sed -e 's/[[:space:]]*$//' | head -n 1 || true)"
  [[ "$file" == *" (deleted)" ]]
}

# same_directory PATH: PATH, as somebody wrote it in .env, is the cold
# directory (symlinks resolved; a relative path never is).
same_directory() {
  case "$1" in
    /*) [ "$(canonical_path "$(normalize_path "$1")")" = "$MOUNTPOINT" ] ;;
    *)  return 1 ;;
  esac
}

# loop_is_image LOOP_DEVICE BACKING_FILE: image layout when fstab mounts the backing file here, device layout when
# it mounts by label (a hand-attached loop passed as --device); without an entry, autoclear (mount -o loop) decides.
loop_is_image() {
  local entry fstab_source
  entry="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
  if [ -n "$entry" ]; then
    fstab_source="$(awk 'NR == 1 { print $1 }' <<<"$entry")"
    case "$fstab_source" in
      /*) [ "$(canonical_path "$fstab_source")" = "$2" ] ;;
      *)  return 1 ;;
    esac
    return
  fi
  [ "$(losetup -n -O AUTOCLEAR "$1" 2>/dev/null | tr -d '[:space:]')" = 1 ]
}

zfs_pools() {
  command -v zpool >/dev/null 2>&1 || return 0
  zpool list -H -o name 2>/dev/null || true
}

# pool_altroot POOL: the pool's altroot (prefixed to its mountpoints), or nothing.
pool_altroot() {
  local value
  value="$(zpool get -H -o value altroot "$1" 2>/dev/null || true)"
  case "$value" in
    /)  ;;   # zpool import -R /: nothing is put in front
    /*) printf '%s\n' "$value" ;;
  esac
}

# shown NAME: a dataset name for a printed command, quoted when it has a space.
shown() {
  if plain_dataset "$1"; then printf '%s\n' "$1"; else printf "'%s'\n" "$1"; fi
}

# unmounted_datasets_here: datasets with the cold directory as mountpoint that are not mounted (canmount=off
# claims nothing), one name a line. ZFS keeps the property as typed, so paths are compared resolved.
unmounted_datasets_here() {
  local name mountpoint mounted canmount
  command -v zfs >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r name mountpoint mounted canmount; do
    if [ "$mounted" = yes ] || [ "$canmount" = off ]; then continue; fi
    case "$mountpoint" in
      "$MOUNTPOINT") ;;
      /*) [ "$(canonical_path "$(normalize_path "$mountpoint")")" = "$MOUNTPOINT" ] || continue ;;
      *)  continue ;;
    esac
    printf '%s\n' "$name"
  done < <(zfs list -H -o name,mountpoint,mounted,canmount 2>/dev/null || true)
}

# unmounted_datasets_above: canmount=on datasets ZFS would mount at CUR_PARENT or between it and the cold
# directory, over what holds it; "name<TAB>mountpoint" a line. noauto ones (boot environments) are left out.
unmounted_datasets_above() {
  local name mountpoint mounted canmount
  [ -n "${CUR_PARENT:-}" ] || return 0
  command -v zfs >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r name mountpoint mounted canmount; do
    if [ "$mounted" = yes ] || [ "$canmount" != on ]; then continue; fi
    case "$mountpoint" in
      /*) mountpoint="$(canonical_path "$(normalize_path "$mountpoint")")" ;;
      *)  continue ;;
    esac
    # at or below where the filesystem is mounted, and above the cold directory
    if [ "$mountpoint" != "$CUR_PARENT" ] && [[ "$mountpoint/" != "$CUR_PARENT"/* ]]; then continue; fi
    if [ "$mountpoint" = "$MOUNTPOINT" ] || [[ "$MOUNTPOINT/" != "$mountpoint"/* ]]; then continue; fi
    printf '%s\t%s\n' "$name" "$mountpoint"
  done < <(zfs list -H -o name,mountpoint,mounted,canmount 2>/dev/null || true)
}

# mountpoint_received DATASET: its mountpoint came with a zfs receive (send -p or -R), so it
# is a copy; one made by this script or by hand has it "local".
mountpoint_received() {
  local source
  source="$(zfs get -H -o source mountpoint "$1" 2>/dev/null || true)"
  [[ "$source" == received* ]]
}

# copy_is_mounted DATASET: another dataset is mounted here whose mountpoint was received while DATASET's was
# not — the copy mounted at boot and the cold dataset did not (key not loaded, noauto, pool late).
copy_is_mounted() {
  [ "$CUR_KIND" = zfs ] && [ "$CUR_SOURCE" != "$1" ] && mountpoint_received "$CUR_SOURCE" && ! mountpoint_received "$1"
}

# swap_note MOUNTED COLD: the way to put the cold dataset where another one is
# mounted in its place. With one dataset mounted, umount takes that one off.
swap_note() {
  echo "stop the stack (docker compose stop postgres meshinfo), unmount the directory (umount $MOUNTPOINT), keep $1 from mounting there again (zfs set canmount=off $(shown "$1"), or give it another mountpoint), mount $2 (zfs mount -l $(shown "$2")) and start the stack (docker compose up -d)"
}

# cold_dir_in_use: something is mounted there, it is a subvolume, or it holds the
# tablespace. A bare mountpoint with a stray file in it is not in use.
cold_dir_in_use() {
  [ "$CUR_MOUNTED" -eq 1 ] || [ "$CUR_KIND" = subvolume ] || compgen -G "$MOUNTPOINT/PG_*" >/dev/null
}

# not_mounted_at_boot DATASET (mounted here, no fstab line): why ZFS will not mount it
# after a reboot either — or nothing, when it will.
not_mounted_at_boot() {
  if [ "$(zfs get -H -o value mountpoint "$1" 2>/dev/null || true)" = legacy ]; then
    echo "the dataset $1 has mountpoint=legacy and $FSTAB has no line for it: it is mounted now, but nothing mounts it after a reboot. Add the line: ${1// /\\040}  $MOUNTPOINT  zfs  defaults,nofail  0 0"
  elif [ "$(zfs get -H -o value canmount "$1" 2>/dev/null || true)" = noauto ]; then
    echo "the dataset $1 has canmount=noauto: ZFS does not mount it at boot, and nothing in $FSTAB does. Unless something of your own mounts it: zfs set canmount=on $(shown "$1")"
  fi
}

# plain_dataset NAME: letters, digits and . _ - : per part, as this script passes names to zfs
# and reads them back from findmnt (ZFS also takes a space, which findmnt writes as \x20).
plain_dataset() { [[ "$1" =~ ^[A-Za-z0-9._:-]+(/[A-Za-z0-9._:-]+)*$ ]]; }

# zfs_on_means_sa: this OpenZFS prints xattr=sa as "on" — the 2.3 series; before, on
# meant dir, and from 2.4 zfs get prints sa again.
zfs_on_means_sa() {
  local version
  version="$(zfs version 2>/dev/null | head -n 1 || true)"
  [[ "$version" == zfs-2.3.* ]]
}

# zfs_has_property DATASET NAME=VALUE; ZFS_FOUND is what was found instead. Not taken at face value: xattr "on" on
# OpenZFS 2.3 (= sa), and a "temporary" atime, which a musl-built zfs misreads from noatime — the mount is asked.
zfs_has_property() {
  local value="" source="" options
  IFS=$'\t' read -r value source < <(zfs get -H -o value,source "${2%%=*}" "$1" 2>/dev/null) || true
  ZFS_FOUND="$value"
  if [ "$value" = "${2#*=}" ]; then return 0; fi
  if [ "$2" = xattr=sa ] && [ "$value" = on ] && zfs_on_means_sa; then return 0; fi
  if [ "$2" = atime=off ] && [ "$source" = temporary ]; then
    options="$(findmnt -rn -S "$1" -o OPTIONS 2>/dev/null | head -n 1 || true)"
    case ",$options," in
      *,noatime,*) return 0 ;;
    esac
    ZFS_FOUND="$value, as it is mounted"
  fi
  return 1
}

# zfs_fstab_entry FSTAB_LINES DATASET: legacy | own (mount takes the line: legacy without zfsutil, own mountpoint with
# it) | legacy-zfsutil | refused (mount turns it down) | unknown (mountpoint unreadable) | other. fstab writes a space as \040.
zfs_fstab_entry() {
  local source type options mountpoint zfsutil=0
  if [ "$(wc -l <<<"$1")" -ne 1 ]; then echo other; return 0; fi
  read -r source _ type options _ <<<"$1" || true
  source="${source//\\040/ }"
  if [ "$source" != "$2" ] || [ "$type" != zfs ]; then echo other; return 0; fi
  case ",$options," in
    *,zfsutil,*) zfsutil=1 ;;
  esac
  mountpoint="$(zfs get -H -o value mountpoint "$2" 2>/dev/null || true)"
  case "$mountpoint:$zfsutil" in
    :*)       echo unknown ;;
    legacy:0) echo legacy ;;
    legacy:1) echo legacy-zfsutil ;;
    *:1)      echo own ;;
    *)        echo refused ;;
  esac
}

# mount_advice FSTAB_LINES: how to mount what the fstab entry names when it is not mounted: "mount DIR",
# unless it is a zfs line that mount turns down or one for a dataset that cannot be asked.
mount_advice() {
  local source type value pool
  read -r source _ type _ <<<"$1" || true
  if [ "$type" = zfs ] && command -v zfs >/dev/null 2>&1; then
    source="${source//\\040/ }"
    pool="${source%%/*}"
    case "$(zfs_fstab_entry "$1" "$source")" in
      legacy-zfsutil)
        echo "take the zfsutil option out of that line (mount turns it down for a dataset with mountpoint=legacy), then mount $MOUNTPOINT"
        return 0 ;;
      refused)
        value="$(zfs get -H -o value mountpoint "$source" 2>/dev/null || true)"
        if [[ "$value" == /* ]] && [ "$(canonical_path "$(normalize_path "$value")")" = "$MOUNTPOINT" ]; then
          echo "zfs mount -l $(shown "$source") — ZFS mounts that dataset itself, and mount turns the fstab line down: remove the line"
        elif [ -n "$(pool_altroot "$pool")" ]; then
          # a path given to zfs set would get the pool's alternate root in front
          echo "the dataset $source has mountpoint=$value, not this directory, and mount turns down a line without the zfsutil option for it: make it legacy (zfs set mountpoint=legacy $(shown "$source")), keep the line, then mount $MOUNTPOINT"
        else
          echo "the dataset $source has mountpoint=$value, not this directory, and mount turns down a line without the zfsutil option for it: to have it here, give it this path (zfs set mountpoint=$MOUNTPOINT $(shown "$source") — that takes it from where it is now; then zfs mount -l $(shown "$source") if it did not mount) and remove the line — or make it legacy (zfs set mountpoint=legacy $(shown "$source")), keep the line, then mount $MOUNTPOINT"
        fi
        return 0 ;;
      unknown)
        if command -v zpool >/dev/null 2>&1 && ! zpool list -H -o name "$pool" >/dev/null 2>&1; then
          echo "zpool import $(shown "$pool") first — the pool of the dataset that line names is not imported — then look again with $(basename "$0") status"
        else
          echo "the dataset $source, which that line names, is not there: correct or remove the line"
        fi
        return 0 ;;
    esac
  fi
  echo "mount $MOUNTPOINT"
}

# bring_back_hint: what brings a cold filesystem back when fstab has no line for it.
# zfs mount -a silently passes over a dataset whose key is not loaded.
bring_back_hint() { echo "for a ZFS dataset zpool import and zfs mount -a, after zfs load-key NAME where it is encrypted; otherwise mount the filesystem that holds it"; }

# compression_of DIR: 0 and how compression is on (mount option, btrfs or ZFS property); 1 and
# why it is off and what turns it on; 2 and why that cannot be told.
compression_of() {
  local dir="$1" options option property dataset value
  case "$(fstype_of "$dir")" in
    btrfs)
      options="$(findmnt -n -o OPTIONS -T "$dir" 2>/dev/null | tail -n 1 || true)"
      case ",$options," in
        *,nodatacow,*)
          echo "the filesystem is mounted nodatacow, and btrfs compresses nothing without copy-on-write; mount it without that option"
          return 1 ;;
      esac
      if command -v lsattr >/dev/null 2>&1 && lsattr -d "$dir" 2>/dev/null | awk '$1 ~ /C/ { found = 1 } END { exit !found }'; then
        echo "the directory has the No_COW attribute (chattr +C), and btrfs compresses nothing that is created in it; use a directory without it"
        return 1
      fi
      option="$(tr ',' '\n' <<<"$options" | grep -E '^compress(-force)?(=|$)' | tail -n 1 || true)"
      case "$option" in
        ''|*=no|*=none) ;;
        *) echo "mount option $option"; return 0 ;;
      esac
      if ! command -v btrfs >/dev/null 2>&1; then
        echo "there is no compress mount option, and without the btrfs command the directory's compression property cannot be read"
        return 2
      fi
      if ! property="$(btrfs property get "$dir" compression 2>/dev/null)"; then
        echo "there is no compress mount option, and btrfs property get fails for $dir"
        return 2
      fi
      property="$(head -n 1 <<<"$property")"
      case "$property" in
        ''|compression=|compression=no|compression=none)
          echo "there is neither a compress mount option nor a compression property; set one: btrfs property set $dir compression zstd (or in your storage UI)"
          return 1 ;;
        compression=*) echo "btrfs property $property"; return 0 ;;
      esac
      echo "btrfs property get printed '$property'"
      return 2 ;;
    zfs)
      if ! command -v zfs >/dev/null 2>&1; then
        echo "the zfs command is missing"
        return 2
      fi
      dataset="$(findmnt -n -o SOURCE -T "$dir" 2>/dev/null | tail -n 1 || true)"
      if ! value="$(zfs get -H -o value compression "$dataset" 2>/dev/null)" || [ -z "$value" ]; then
        echo "zfs get compression ${dataset:-(no dataset found)} fails — the pool cannot be asked from here"
        return 2
      fi
      if [ "$value" = off ]; then
        echo "the dataset $dataset has compression=off; turn it on: zfs set compression=zstd-9 $(shown "$dataset") (or in your storage UI)"
        return 1
      fi
      echo "ZFS property compression=$value"
      return 0 ;;
  esac
  echo "it is not on btrfs or ZFS"
  return 1
}

# detect_current: sets CUR_KIND (image, device, zfs, subvolume, foreign, none), CUR_MOUNTED, CUR_SOURCE, CUR_FSTYPE,
# CUR_IMAGE, CUR_IMAGE_GONE, CUR_STACK (stacked btrfs/ZFS mounts, bottom first), CUR_STACK_AT and CUR_PARENT ("" for /).
detect_current() {
  local line lines target
  CUR_KIND=none; CUR_MOUNTED=0; CUR_SOURCE=""; CUR_FSTYPE=""; CUR_IMAGE=""; CUR_IMAGE_GONE=0; CUR_STACK=""; CUR_STACK_AT=""; CUR_PARENT=""
  lines="$(findmnt -rn -M "$MOUNTPOINT" -o SOURCE,FSTYPE 2>/dev/null || true)"
  line="$(tail -n 1 <<<"$lines")"
  if [ -n "$line" ]; then
    CUR_MOUNTED=1
    CUR_SOURCE="${line%% *}"
    CUR_SOURCE="${CUR_SOURCE%%\[*}"
    CUR_SOURCE="$(printf '%b' "$CUR_SOURCE")"   # findmnt -r writes a space in a name as \x20
    CUR_FSTYPE="${line##* }"
    # The last line is on top. Two datasets with one mountpoint (a received copy) give two lines;
    # a tmpfs or automount point underneath does not count, nor the same filesystem bound over itself.
    CUR_STACK="$(stack_in "$lines")"
    if [ -n "$CUR_STACK" ]; then CUR_STACK_AT="$MOUNTPOINT"; fi
    case "$CUR_FSTYPE" in
      zfs) CUR_KIND=zfs ;;
      btrfs)
        CUR_KIND=device
        if [[ "$CUR_SOURCE" =~ ^/dev/loop[0-9]+$ ]]; then   # a whole loop device, not a partition on one
          require_tools util losetup
          CUR_IMAGE="$(loop_backing_file "$CUR_SOURCE")"
          [ -n "$CUR_IMAGE" ] || die "losetup cannot name the file behind $CUR_SOURCE, which is mounted at $MOUNTPOINT (losetup -l shows what it knows)"
          if loop_is_image "$CUR_SOURCE" "$CUR_IMAGE"; then
            CUR_KIND=image
            if loop_file_deleted "$CUR_SOURCE" || [ ! -f "$CUR_IMAGE" ]; then CUR_IMAGE_GONE=1; fi
          else
            CUR_IMAGE=""
          fi
        fi ;;
      *) CUR_KIND=foreign ;;
    esac
  else
    if is_subvolume "$MOUNTPOINT"; then CUR_KIND=subvolume; CUR_FSTYPE=btrfs; fi
    # The cold directory is a directory of a filesystem that is mounted
    # further up: one mounted over another there is the same trouble.
    target="$(findmnt -rn -o TARGET -T "$(nearest_existing "$MOUNTPOINT")" 2>/dev/null | tail -n 1 || true)"
    case "$target" in
      /?*)
        CUR_PARENT="$target"
        CUR_STACK="$(stack_in "$(findmnt -rn -M "$CUR_PARENT" -o SOURCE,FSTYPE 2>/dev/null || true)")"
        if [ -n "$CUR_STACK" ]; then CUR_STACK_AT="$CUR_PARENT"; fi ;;
    esac
  fi
}

# stack_in LINES (findmnt -rn -M DIR -o SOURCE,FSTYPE): the sources, bottom first, when
# more than one btrfs or ZFS is mounted there; nothing otherwise.
stack_in() {
  if [ "$(awk '$NF == "zfs" || $NF == "btrfs" { print $1 }' <<<"$1" | sort -u | wc -l)" -gt 1 ]; then
    printf '%b\n' "$(awk '$NF == "zfs" || $NF == "btrfs" { printf "%s%s", sep, $1; sep = ", " }' <<<"$1")"
  fi
}

# --- Docker and the database ---

have_docker() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# service_container SERVICE: id of the running container of SERVICE in the
# stack at PROJECT_DIR; status 1 when there is none.
service_container() {
  local id=""
  id="$(cd "$PROJECT_DIR" && docker compose ps -q "$1" 2>/dev/null | head -n 1)" || id=""
  if [ -z "$id" ]; then
    id="$(docker ps -q --filter "label=com.docker.compose.project.working_dir=${PROJECT_DIR}" \
            --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n 1)" || id=""
  fi
  [ -n "$id" ] || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = true ] || return 1
  printf '%s\n' "$id"
}

# running_config_files: the compose files the running stack was started with (from the container
# labels), relative to PROJECT_DIR where inside it, joined with SEPARATOR; nothing when it is not running.
running_config_files() {
  local cid files file out=""
  cid="$(service_container postgres)" || return 0
  files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$cid" 2>/dev/null || true)"
  [ -n "$files" ] || return 0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    out="${out:+$out$1}${file#"$PROJECT_DIR"/}"
  done < <(tr ',' '\n' <<<"$files")
  printf '%s\n' "$out"
}

# stack_container SERVICE: id of the stack's container of SERVICE, running or
# stopped; prints nothing when there is none.
stack_container() {
  local id=""
  id="$(cd "$PROJECT_DIR" && docker compose ps -aq "$1" 2>/dev/null | head -n 1)" || id=""
  if [ -z "$id" ]; then
    id="$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=${PROJECT_DIR}" \
            --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n 1)" || id=""
  fi
  printf '%s\n' "$id"
}

# inspect_running_stack: refuse what would turn the printed "docker compose
# up -d" against a stack that already has a cold directory of another kind.
inspect_running_stack() {
  local cid name bound files state=stopped
  # Only docker-compose.zfs.yml reads these two, so .env speaks for a stack
  # that is stopped or was taken down as well.
  if [ "$NO_ENV" -eq 0 ]; then
    for name in MESHINFO_ZFS_HOT MESHINFO_ZFS_COLD; do
      if env_get "$ENV_FILE" "$name" >/dev/null; then
        die "$ENV_FILE sets $name, which only $FULL_ZFS_OVERLAY reads: this stack is set up for the full ZFS layout, where the cluster and the cold months are on two datasets already. The cold-only overlay does not go on top of that — \"docker compose up -d\" with it would put postgres back on the named volume. Nothing to set up here (ZFS.md, \"Choosing a layout\"); if the line is a leftover, remove it and run this again."
      fi
    done
  fi
  have_docker || return 0
  cid="$(stack_container postgres)"
  [ -n "$cid" ] || return 0
  if [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)" = true ]; then state=running; fi
  files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$cid" 2>/dev/null || true)"
  case ",$files," in
    */"$FULL_ZFS_OVERLAY",*)
      die "the $state stack was started with $FULL_ZFS_OVERLAY, the full ZFS layout: its cluster and its cold months are on the two datasets already, and the cold-only overlay does not go on top of that — \"docker compose up -d\" with it would put postgres back on the named volume. Nothing to set up here (ZFS.md, \"Choosing a layout\")." ;;
  esac
  [ "$state" = running ] || return 0
  bound="$(docker inspect -f '{{range .Mounts}}{{println .Destination .Source}}{{end}}' "$cid" 2>/dev/null |
             awk -v path="$PG_COLD_PATH" '$1 == path { print $2; exit }' || true)"
  if [ -n "$bound" ] && [ "$(canonical_path "$bound")" != "$MOUNTPOINT" ]; then
    die "the running postgres container already has $bound bound at $PG_COLD_PATH: that is the stack's cold directory, not $MOUNTPOINT. To check or finish that one, pass --mountpoint $bound (with --existing if you made it yourself). A second cold directory would take the bind away from the months already moved."
  fi
}

# What a cycle of the tiering job would move, in its order, with the size its free-space guard
# uses. The CASE keeps names that are not monthly (the DEFAULT partition's) from being parsed.
COLD_PARTITIONS_SQL="
SELECT c.relname || ' ' || pg_total_relation_size(c.oid)
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
WHERE p.oid IN (to_regclass('mqtt_messages'), to_regclass('packet_receptions'))
  AND p.relname = ANY (string_to_array(:'tables', ','))
  AND COALESCE(ts.spcname, '') <> :'cold_ts'
  AND CASE WHEN c.relname ~ ('^' || p.relname || '_[0-9]{4}_(0[1-9]|1[0-2])\$')
           THEN to_date(right(c.relname, 7), 'YYYY_MM')
                < (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => GREATEST(1, :cold_after)))::date
           ELSE false END
ORDER BY right(c.relname, 7), CASE p.relname WHEN 'mqtt_messages' THEN 0 ELSE 1 END, c.relname;
"

# db_query CONTAINER COLD_AFTER_MONTHS COLD_TABLESPACE TABLES: runs the SQL on stdin with those as the psql
# variables cold_after, cold_ts, tables. Prints nothing unless the whole query went through.
db_query() {
  local sql out attempt rc started
  # shellcheck disable=SC2016  # expanded by the shell inside the container
  local -a run=(docker exec -i "$1" sh -c
    'exec psql -X -q -At -v ON_ERROR_STOP=1 -v cold_after="$1" -v cold_ts="$2" -v tables="$3" -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'
    sh "$2" "$3" "$4")
  if command -v timeout >/dev/null 2>&1; then run=(timeout "$DB_TIME_LIMIT" "${run[@]}"); fi
  sql="$(cat)"
  # A server that is just starting refuses for a moment (the image's init server answers, then stops): ask up to
  # three times. A query that hit the time limit is not repeated — told by its duration, as timeout's status varies.
  for attempt in 1 2 3; do
    rc=0
    started="$SECONDS"
    out="$(printf '%s\n' "$sql" | "${run[@]}" 2>/dev/null)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ -n "$out" ]; then printf '%s\n' "$out"; fi
      return 0
    fi
    if [ "$rc" -eq 124 ] || [ $((SECONDS - started)) -ge "$DB_TIME_LIMIT" ] || [ "$attempt" -eq 3 ]; then break; fi
    sleep "$DB_RETRY_PAUSE"
  done
  return "$rc"
}

# db_cold_partitions CONTAINER COLD_AFTER_MONTHS COLD_TABLESPACE TABLES: "name
# bytes" lines; fails when the database cannot be asked.
db_cold_partitions() { printf '%s\n' "$COLD_PARTITIONS_SQL" | db_query "$@"; }

# numeric_setting KEY DEFAULT: an integer from [storage.tiering], or DEFAULT.
numeric_setting() {
  local value
  # As the job takes it: an integer (TOML allows 2_048 and +2048); a quoted
  # number is a string, which the job ignores.
  value="$(tiering_raw "$PROJECT_DIR/config.toml" "$1" 2>/dev/null || true)"
  value="${value//_/}"
  value="${value#+}"
  if [[ "$value" =~ ^[0-9]{1,9}$ ]]; then echo "$((10#$value))"; else echo "$2"; fi
}

# cold_tablespace_name: cold_tablespace from [storage.tiering], or its default.
cold_tablespace_name() {
  local name
  name="$(tiering_setting "$PROJECT_DIR/config.toml" cold_tablespace 2>/dev/null || true)"
  [[ "$name" =~ ^[a-z_][a-z0-9_]*$ ]] || name="$DEFAULT_COLD_TABLESPACE"
  printf '%s\n' "$name"
}

# cold_tablespace_in_database: 0 when the running database has the cold tablespace defined, 1 when
# not, 2 when it cannot be asked. Asked once (TABLESPACE_STATE).
cold_tablespace_in_database() {
  local cid answer
  if [ -z "$TABLESPACE_STATE" ]; then
    TABLESPACE_STATE=2
    if have_docker && cid="$(service_container postgres)"; then
      answer="$(printf '%s\n' "SELECT count(*) FROM pg_tablespace WHERE spcname = :'cold_ts';" |
                  db_query "$cid" 1 "$(cold_tablespace_name)" - || true)"
      case "$answer" in
        0) TABLESPACE_STATE=1 ;;
        1) TABLESPACE_STATE=0 ;;
      esac
    fi
  fi
  return "$TABLESPACE_STATE"
}

# cold_tablespace_relations: how many tables and indexes the catalog places on the cold
# tablespace; prints nothing when the database cannot be asked.
cold_tablespace_relations() {
  local cid answer
  have_docker || return 0
  cid="$(service_container postgres)" || return 0
  answer="$(printf '%s\n' "SELECT count(*) FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE t.spcname = :'cold_ts';" |
              db_query "$cid" 1 "$(cold_tablespace_name)" - || true)"
  if [[ "$answer" =~ ^[0-9]+$ ]]; then printf '%s\n' "$answer"; fi
}

# cold_tablespace_place: sets TABLESPACE_PLACE. "here": its PG_... directory is in the cold directory (top, or below
# where cold_tablespace_location says); "away": it belongs here and is not; "elsewhere": at TABLESPACE_LOCATION, not bound.
cold_tablespace_place() {
  local cid sub
  TABLESPACE_PLACE=away; TABLESPACE_LOCATION=""
  if compgen -G "$MOUNTPOINT/PG_*" >/dev/null; then TABLESPACE_PLACE=here; return 0; fi
  if have_docker && cid="$(service_container postgres)"; then
    TABLESPACE_LOCATION="$(printf '%s\n' "SELECT pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname = :'cold_ts';" |
                             db_query "$cid" 1 "$(cold_tablespace_name)" - | head -n 1 || true)"
  fi
  case "$TABLESPACE_LOCATION" in
    ''|"$PG_COLD_PATH") ;;
    "$PG_COLD_PATH"/*)
      sub="${TABLESPACE_LOCATION#"$PG_COLD_PATH"}"
      # the database's own string: never as a pattern, never with .. in it
      if [[ "$sub/" != */../* ]] && [ -d "$MOUNTPOINT$sub" ] && (cd "$MOUNTPOINT$sub" 2>/dev/null && compgen -G 'PG_*' >/dev/null); then
        TABLESPACE_PLACE=here
      fi ;;
    *) TABLESPACE_PLACE=elsewhere ;;
  esac
  return 0
}

# storage_away_note: the refusal when the database has the cold tablespace and its directory is not here. Bring the
# filesystem back first; DROP TABLESPACE only when the catalog places nothing on it (PostgreSQL drops a used one silently).
storage_away_note() {
  local name relations claims has where what=them
  name="$(cold_tablespace_name)"
  relations="$(cold_tablespace_relations)"
  claims="$(unmounted_datasets_here | awk 'NF { printf "%s%s", sep, $0; sep = ", " }')"
  case "$relations" in
    0)  has="the running database already has the tablespace $name, with nothing stored on it yet: its PG_... directory belongs in the cold directory"
        what=it ;;
    '') has="the running database already has the tablespace $name: PostgreSQL expects the files of what was moved onto it in the cold directory" ;;
    *)  has="the running database already has the tablespace $name, which holds $relations of its tables and indexes: PostgreSQL expects their files in the cold directory" ;;
  esac
  case "$claims" in
    '')     where="but the filesystem that holds $what is not at $MOUNTPOINT now. Bring it back ($(bring_back_hint)), or pass the --mountpoint where it is, and run this again." ;;
    *", "*) where="and the ZFS datasets $claims, which have $MOUNTPOINT as their mountpoint, are not mounted. Mount the one that is the cold dataset (zfs mount -l NAME; -l loads the key of one that is encrypted) and run this again. If none of them is it (they are copies), the cold dataset itself is what is away: bring its pool back (zpool import)." ;;
    *)      where="and the ZFS dataset $claims, which has $MOUNTPOINT as its mountpoint, is not mounted. If it is the cold dataset, mount it (zfs mount -l $(shown "$claims"); -l loads the key of one that is encrypted) and run this again. If it is a copy (received from another pool), the cold dataset itself is what is away: give the copy another mountpoint or canmount=off, then bring the cold dataset's pool back (zpool import)." ;;
  esac
  if [ "$relations" = 0 ]; then
    echo "$has — $where Nothing else is needed, and nothing is created or adopted in its place. Only if that filesystem is gone for good: drop the tablespace (DROP TABLESPACE $name; ZFS.md, \"Rolling back\") and run this again — and should the filesystem turn up again later, remove the PG_... directory on it before the job can create the tablespace anew."
  else
    echo "$has — $where Nothing is created or adopted in its place: it would be empty where those files belong."
  fi
}

# storage_elsewhere_note: the refusal when the cold tablespace is at a path the cold overlay does not bind.
storage_elsewhere_note() {
  echo "the running database already has the tablespace $(cold_tablespace_name) at $TABLESPACE_LOCATION, which is not under $PG_COLD_PATH, where the overlay binds the cold directory: the job moves the months there, and what is prepared at $MOUNTPOINT would not be used. To have the cold months here, move them back and drop the tablespace first (ZFS.md, \"Rolling back\"), and leave cold_tablespace_location at its default."
}

# refuse_tablespace_not_here: nothing is created or adopted while the running database's cold tablespace
# is not in the cold directory. Returns when there is no such tablespace, it cannot be asked, or it is here.
refuse_tablespace_not_here() {
  cold_tablespace_in_database || return 0
  cold_tablespace_place
  case "$TABLESPACE_PLACE" in
    away)      die "$(storage_away_note)" ;;
    elsewhere) die "$(storage_elsewhere_note)" ;;
  esac
  return 0
}

# smallest_useful_bytes: below this, no move can ever pass the job's guard on
# a new btrfs: min_free_mb itself, what btrfs keeps to itself, and 10 %.
smallest_useful_bytes() {
  local with_own
  with_own=$(( $(numeric_setting min_free_mb "$DEFAULT_MIN_FREE_MB") * MIB + BTRFS_OWN_BYTES ))
  round_up_gib $((with_own + (with_own + 9) / 10))
}

# too_small_note BYTES FLOOR: why a filesystem of BYTES is of no use.
too_small_note() {
  echo "$(human_bytes "$1") is too small to ever take a month: before a move the job wants min_free_mb ($(numeric_setting min_free_mb "$DEFAULT_MIN_FREE_MB") MiB) free on top of the partition's own size, and a new btrfs keeps about $(human_bytes "$BTRFS_OWN_BYTES") to itself. The smallest that makes sense here is $(human_bytes "$2")"
}

# database_calls_for: asks the running database what the job will move. Sets DB_BYTES (the image size
# that calls for) and DB_REASONING; without a database DB_BYTES stays empty and DB_WHY_NOT says why.
database_calls_for() {
  local cid rows min_free_mb cold_after cold_ts tables raw word needed name bytes before count total
  DB_BYTES=""; DB_REASONING=(); DB_WHY_NOT=""
  if ! have_docker; then DB_WHY_NOT="docker is not usable here"; return 0; fi
  if ! cid="$(service_container postgres)"; then DB_WHY_NOT="the stack in $PROJECT_DIR is not running"; return 0; fi
  min_free_mb="$(numeric_setting min_free_mb "$DEFAULT_MIN_FREE_MB")"
  cold_after="$(numeric_setting cold_after_months "$DEFAULT_COLD_AFTER_MONTHS")"
  if [ "$cold_after" -lt 1 ]; then cold_after=1; fi
  cold_ts="$(cold_tablespace_name)"
  # As the job takes it: tables narrows the archive tables only as a one-line list naming exactly
  # one of them. Everything else counts both, which can only make the image larger than needed.
  tables=""
  raw="$(tiering_raw "$PROJECT_DIR/config.toml" tables 2>/dev/null || true)"
  case "$raw" in
    \[*\])
      while read -r word; do
        case "$word" in
          mqtt_messages|packet_receptions) tables="${tables:+$tables,}$word" ;;
        esac
      done < <(grep -oE '[A-Za-z0-9_]+' <<<"$raw" | sort -u || true) ;;
  esac
  case "$tables" in
    mqtt_messages|packet_receptions) ;;
    *) tables="mqtt_messages,packet_receptions" ;;
  esac
  if ! rows="$(db_cold_partitions "$cid" "$cold_after" "$cold_ts" "$tables")"; then
    DB_WHY_NOT="the database in the postgres container did not answer"
    return 0
  fi
  read -r needed name bytes before count total < <(simulate_guard $((min_free_mb * MIB)) "$ASSUMED_RATIO" <<<"$rows")
  DB_BYTES="$(image_bytes_for "$needed")"
  DB_REASONING+=("worked out from the running database (cold_after_months = $cold_after, min_free_mb = $min_free_mb):")
  if tiering_unreadable "$PROJECT_DIR/config.toml"; then
    DB_REASONING+=("NOTE: config.toml sets tiering in a form this script does not read (a dotted key, an inline table or a quoted key), so the job's defaults were assumed for those two")
  fi
  if [ "$tables" != "mqtt_messages,packet_receptions" ]; then
    DB_REASONING+=("only $tables is counted: config.toml lists no other table to tier")
  fi
  if [ "$count" -eq 0 ]; then
    DB_REASONING+=("no month is old enough to move yet, so the minimum applies")
  else
    DB_REASONING+=("$count partitions are due to move, $(human_bytes "$total") as PostgreSQL counts them")
    DB_REASONING+=("before each move the job wants the partition's uncompressed size + min_free_mb free")
    DB_REASONING+=("tightest: $name ($(human_bytes "$bytes")) with $(human_bytes "$before") already inside (earlier months at an assumed ${ASSUMED_RATIO}x) -> $(human_bytes "$needed")")
    DB_REASONING+=("+ what a new btrfs keeps to itself (about $(human_bytes "$BTRFS_OWN_BYTES"); $(human_bytes "$BTRFS_OWN_BYTES_LARGE") above $(human_bytes "$BTRFS_LARGE_FROM")), + 10 %, rounded up to a whole GiB, at least $(human_bytes "$MIN_IMAGE_BYTES")")
  fi
}

# decide_image_size: sets IMAGE_BYTES and SIZE_REASONING (lines to print).
decide_image_size() {
  local line
  SIZE_REASONING=()
  database_calls_for
  if [ -n "$SIZE_ARG" ]; then
    IMAGE_BYTES="$SIZE_BYTES"
    SIZE_REASONING+=("$(human_bytes "$IMAGE_BYTES"), as asked with --size")
    if [ -n "$DB_BYTES" ] && [ "$IMAGE_BYTES" -lt "$DB_BYTES" ]; then
      SIZE_REASONING+=("NOTE: that is less than the $(human_bytes "$DB_BYTES") the running database calls for; the job will refuse moves until the image is grown. $(human_bytes "$DB_BYTES") is")
      for line in "${DB_REASONING[@]}"; do SIZE_REASONING+=("  $line"); done
    fi
  elif [ -n "$DB_BYTES" ]; then
    IMAGE_BYTES="$DB_BYTES"
    SIZE_REASONING+=("$(human_bytes "$IMAGE_BYTES"), ${DB_REASONING[0]}")
    for line in "${DB_REASONING[@]:1}"; do SIZE_REASONING+=("$line"); done
  else
    IMAGE_BYTES="$DEFAULT_IMAGE_BYTES"
    SIZE_REASONING+=("$(human_bytes "$IMAGE_BYTES"): the default, because $DB_WHY_NOT and the database cannot be asked")
  fi
  SIZE_REASONING+=("the disk holds this size permanently, whatever is inside; later months need more room: grow --to SIZE enlarges it online")
}

# --- Arguments ---

choose() {
  if [ -n "$CHOICE" ] && [ "$CHOICE" != "$1" ]; then
    usage_error "--$CHOICE and --$1 are different layouts: name one"
  fi
  CHOICE="$1"
}

set_option() {
  case "$1" in
    --existing)    choose existing; EXISTING_DIR="$2" ;;
    --device)      choose device; DEVICE="$2" ;;
    --zfs)         choose zfs; ZFS_DATASET="$2" ;;
    --image)       choose image; IMAGE="$2" ;;
    --mountpoint)  MOUNTPOINT="$2" ;;
    --size)        SIZE_ARG="$2" ;;
    --to)          GROW_TO="$2" ;;
    --project-dir) PROJECT_DIR="$2" ;;
  esac
}

parse_args() {
  local value
  CMD=setup
  case "${1:-}" in
    setup|status|grow) CMD="$1"; shift ;;
  esac
  CHOICE=""; EXISTING_DIR=""; DEVICE=""; ZFS_DATASET=""; IMAGE=""; MOUNTPOINT=""
  SIZE_ARG=""; SIZE_BYTES=0; GROW_TO=""; GROW_BYTES=0; PROJECT_DIR=""
  FORCE=0; YES=0; DRY_RUN=0; NO_ENV=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --existing|--device|--zfs|--image|--mountpoint|--size|--to|--project-dir)
        [ $# -ge 2 ] || usage_error "$1 needs a value"
        set_option "$1" "$2"; shift 2 ;;
      --existing=*|--device=*|--zfs=*|--image=*|--mountpoint=*|--size=*|--to=*|--project-dir=*)
        set_option "${1%%=*}" "${1#*=}"; shift ;;
      --subvolume)  choose subvolume; shift ;;
      --force)      FORCE=1; shift ;;
      -y|--yes)     YES=1; shift ;;
      -n|--dry-run) DRY_RUN=1; shift ;;
      --no-env)     NO_ENV=1; shift ;;
      -h|--help)    usage; exit 0 ;;
      *)            usage_error "unknown argument: $1" ;;
    esac
  done
  if [ -n "$EXISTING_DIR" ] && [ -n "$MOUNTPOINT" ] && [ "$(normalize_path "$MOUNTPOINT")" != "$(normalize_path "$EXISTING_DIR")" ]; then
    usage_error "--existing DIR is the cold directory itself; leave --mountpoint out"
  fi
  for value in "$MOUNTPOINT" "$EXISTING_DIR"; do
    if [ -n "$value" ] && ! plain_path "$(normalize_path "$value")"; then
      usage_error "the cold directory '$value' must be an absolute path made of letters, digits and . _ - / (it goes into /etc/fstab and .env unquoted)"
    fi
  done
  if [ -n "$IMAGE" ] && ! plain_path "$(normalize_path "$IMAGE")"; then
    usage_error "the image path '$IMAGE' must be an absolute path made of letters, digits and . _ - / (it goes into /etc/fstab unquoted)"
  fi
  case "$CMD" in
    setup)
      [ -z "$GROW_TO" ] || usage_error "--to belongs to the grow subcommand"
      if [ -n "$SIZE_ARG" ]; then
        case "$CHOICE" in
          ''|image) ;;
          *) usage_error "--size is the size of a new image; it does not apply to --$CHOICE" ;;
        esac
        SIZE_BYTES="$(parse_size "$SIZE_ARG")" || usage_error "--size $SIZE_ARG: give a whole number of GiB, or a number with M, G or T (20G, 20480M)"
      fi
      if [ "$FORCE" -eq 1 ] && [ "$CHOICE" != device ]; then usage_error "--force only applies to --device"; fi
      if [ "$CHOICE" = zfs ]; then
        case "$ZFS_DATASET" in
          /*)  usage_error "--zfs takes a dataset name (pool/name), not a path: $ZFS_DATASET" ;;
          */)  usage_error "--zfs $ZFS_DATASET must not end with /" ;;
          */*) plain_dataset "$ZFS_DATASET" || usage_error "--zfs '$ZFS_DATASET': this script passes on dataset names made of letters, digits and . _ - : only (ZFS also takes a space, which findmnt writes differently). To use such a dataset as it is, pass --existing with the directory where it is mounted" ;;
          *)   usage_error "--zfs $ZFS_DATASET names a pool, not a dataset on it — name one, e.g. $ZFS_DATASET/$ZFS_DATASET_NAME: the pool's root dataset passes its mountpoint and compression on to every dataset below it" ;;
        esac
      fi ;;
    status)
      if [ -n "$CHOICE$SIZE_ARG$GROW_TO" ] || [ "$FORCE$YES$DRY_RUN$NO_ENV" != 0000 ]; then
        usage_error "status takes --mountpoint and --project-dir only"
      fi ;;
    grow)
      if [ -n "$CHOICE$SIZE_ARG" ] || [ "$FORCE$NO_ENV" != 00 ]; then
        usage_error "grow takes --to, --mountpoint, --project-dir, --yes and --dry-run only"
      fi
      [ -n "$GROW_TO" ] || usage_error "grow needs --to SIZE (the new total size, e.g. --to 40G)"
      GROW_BYTES="$(parse_size "$GROW_TO")" || usage_error "--to $GROW_TO: give a whole number of GiB, or a number with M, G or T (40G, 40960M)" ;;
  esac
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "this needs root (mounts, /etc/fstab, ownership of the cold directory) — run it with sudo"
}

resolve_project() {
  local dir="$PROJECT_DIR"
  if [ -z "$dir" ]; then dir="$(dirname "$SCRIPT_DIR")"; fi
  PROJECT_DIR="$(cd "$dir" 2>/dev/null && pwd)" || die "--project-dir $dir is not a directory"
  ENV_FILE="$PROJECT_DIR/.env"
}

resolve_mountpoint() {
  local from_env=""
  if [ "$CHOICE" = existing ]; then
    MOUNTPOINT="$EXISTING_DIR"; MOUNTPOINT_FROM="--existing"
  elif [ -n "$MOUNTPOINT" ]; then
    MOUNTPOINT_FROM="--mountpoint"
  elif from_env="$(env_get "$ENV_FILE" MESHINFO_PGCOLD_DIR)" && [ -n "$from_env" ]; then
    MOUNTPOINT="$from_env"; MOUNTPOINT_FROM="MESHINFO_PGCOLD_DIR in .env"
  else
    MOUNTPOINT="$DEFAULT_MOUNTPOINT"; MOUNTPOINT_FROM="the default"
  fi
  MOUNTPOINT="$(normalize_path "$MOUNTPOINT")"
  plain_path "$MOUNTPOINT" || die "the cold directory '$MOUNTPOINT' (from $MOUNTPOINT_FROM) must be an absolute path made of letters, digits and . _ - / (it goes into /etc/fstab and .env unquoted)"
  MOUNTPOINT="$(canonical_path "$MOUNTPOINT")"
  # ... and so must what the symlinks in it lead to
  plain_path "$MOUNTPOINT" || die "the cold directory (from $MOUNTPOINT_FROM) resolves to '$MOUNTPOINT', which must be made of letters, digits and . _ - / only (it goes into /etc/fstab and .env unquoted) — choose another --mountpoint"
}

# --- Planning ---
# One inspect_* per layout: each refuses what it must and adds the missing steps to PLAN; nothing is changed here.

plan() { PLAN+=("$1"); }

# plan_owner: the chown/chmod step, unless the directory already has both.
plan_owner() {
  NEED_OWNER=0
  if [ "${1:-}" = always ] || ! owner_is_right "$MOUNTPOINT"; then
    NEED_OWNER=1
    plan "chown $OWNER $MOUNTPOINT && chmod $DIR_MODE $MOUNTPOINT"
  fi
}

# plan_btrfs_module: the kernel has btrfs only as a module that is not loaded.
plan_btrfs_module() {
  NEED_MODULE=0
  if ! grep -qw btrfs /proc/filesystems 2>/dev/null; then
    NEED_MODULE=1
    plan "modprobe btrfs   # the kernel has btrfs as a module that is not loaded yet"
  fi
}

# refuse_occupied WHAT WHY: the cold directory has something in it and is not
# the layout being set up. A tablespace in it must never be emptied away.
refuse_occupied() {
  if compgen -G "$MOUNTPOINT/PG_*" >/dev/null; then
    die "$MOUNTPOINT holds a PostgreSQL tablespace (a PG_... directory) and is not $1: it is a cold directory in use, and the months that were moved are in it — do not empty it. To keep using it as it is, pass --existing $MOUNTPOINT; otherwise choose another --mountpoint."
  fi
  # The tablespace may be in a directory below the top (cold_tablespace_location
  # names one under the bind): the database knows.
  if cold_tablespace_in_database; then
    cold_tablespace_place
    if [ "$TABLESPACE_PLACE" = here ]; then
      die "$MOUNTPOINT holds the tablespace $(cold_tablespace_name) of the running database, in a directory below it ($TABLESPACE_LOCATION, as the database names it), and is not $1: the months that were moved are in it — do not empty it. Nothing is created on top of it. Move them back first (ZFS.md, \"Rolling back\"), or choose another --mountpoint."
    fi
  fi
  die "$MOUNTPOINT is not empty and is not $1 — $2. Empty it or choose another --mountpoint."
}

# require_only_tablespace DIR: refuse when DIR holds anything but PostgreSQL's tablespace directories.
require_only_tablespace() {
  local entry
  while read -r entry; do
    case "$entry" in
      ''|PG_*) continue ;;
      .zfs)
        # ZFS's own snapshot directory, which a dataset with snapdir=visible
        # shows at its root: not something the directory holds
        if [ "$(findmnt -rn -M "$1" -o FSTYPE 2>/dev/null | tail -n 1 || true)" = zfs ]; then continue; fi ;;
    esac
    die "$1 holds something other than a tablespace ($entry) — the cold directory must be empty, or already be the tablespace's; give the cold months a directory of their own"
  done < <(ls -A -- "$1")
}

# inspect_mount_target WANTED_FSTAB_LINE: the mountpoint, its fstab line and
# the mount, for a device or an image.
inspect_mount_target() {
  local want="$1" have
  NEED_MKDIR=0; NEED_FSTAB=0; NEED_RELOAD=0; NEED_MOUNT=0
  WANT_FSTAB_LINE="$want"
  if [ "$CUR_MOUNTED" -eq 0 ]; then
    if [ -e "$MOUNTPOINT" ] || [ -L "$MOUNTPOINT" ]; then
      if [ ! -d "$MOUNTPOINT" ] || [ -L "$MOUNTPOINT" ]; then die "$MOUNTPOINT exists and is not a directory"; fi
      if [ -n "$(ls -A -- "$MOUNTPOINT")" ]; then refuse_occupied "the cold filesystem" "mounting over it would hide what is in it"; fi
    else
      NEED_MKDIR=1
      plan "mkdir -p $MOUNTPOINT"
    fi
    NEED_MOUNT=1
  fi
  have="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
  if [ -z "$have" ]; then
    NEED_FSTAB=1
    case "$(fstype_of "$FSTAB")" in
      tmpfs|ramfs|rootfs)
        warn "$FSTAB is on a filesystem that lives in memory: the line added to it, and with it the mount, will be gone after a reboot — keep it the way this system keeps its configuration" ;;
    esac
    plan "add to $FSTAB (a copy of the file is kept):  $want"
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
      NEED_RELOAD=1
      plan "systemctl daemon-reload   # systemd turns fstab into mount units"
    fi
  elif [ "$(fstab_key "$have")" != "$(fstab_key "$want")" ]; then
    die "$FSTAB already has another entry for $MOUNTPOINT:
    $have
  this script would write:
    $want
  Remove or correct the entry, then run this again."
  fi
  if [ "$NEED_MOUNT" -eq 1 ]; then
    plan "mount $MOUNTPOINT"
    plan_owner always
  else
    plan_owner
  fi
}

inspect_image() {
  local dir fs type label allocated avail floor other target in_fstab=0
  require_tools util findmnt losetup fallocate blkid mount
  require_tools btrfs btrfs mkfs.btrfs
  require_btrfs
  dir="$(dirname "$IMAGE")"
  [ -d "$dir" ] || die "$dir, the directory for the image, does not exist — create it or name another --image PATH"
  IMAGE="$(canonical_path "$IMAGE")"
  plain_path "$IMAGE" || die "the image path resolves to '$IMAGE', which must be made of letters, digits and . _ - / only (it goes into /etc/fstab unquoted) — name another --image PATH"
  dir="$(dirname "$IMAGE")"
  fs="$(fstype_of "$dir")"
  case "$fs" in
    btrfs) die "$dir is on btrfs: an image there would be a copy-on-write filesystem inside a copy-on-write filesystem, compressed and snapshotted twice. Use a subvolume on that filesystem instead (--subvolume with --mountpoint under it), or name an --image PATH on ext4 or xfs." ;;
    zfs)   die "$dir is on ZFS: an image there would be compressed and snapshotted twice. Use a dataset instead (--zfs POOL/DATASET), or name an --image PATH on ext4 or xfs." ;;
    tmpfs|ramfs|rootfs|devtmpfs)
           die "$dir is on $fs, which lives in memory: the image, and every month moved into it, would be gone after a reboot. Name an --image PATH on a disk." ;;
  esac
  [ -c /dev/loop-control ] || die "this system has no /dev/loop-control, so it cannot make loop devices (a container that is not allowed them?) and could not mount an image. Use a block device (--device), a ZFS dataset (--zfs) or a directory that is already on a compressing filesystem (--existing)."
  if [ "$CUR_KIND" = image ] && [ "$CUR_IMAGE" != "$IMAGE" ]; then
    die "$MOUNTPOINT is already the mount of another image, $CUR_IMAGE — pass --image $CUR_IMAGE to keep using it, or choose another --mountpoint"
  fi
  if [ "$CUR_KIND" = image ] && [ "$CUR_IMAGE_GONE" -eq 1 ]; then
    die "$MOUNTPOINT is mounted from $IMAGE, but that file is gone (deleted, or replaced at its path, while in use) — the data is only reachable through the mount now, whatever is at that path. Copy what matters out of $MOUNTPOINT, unmount it, and run this again."
  fi
  plan_btrfs_module
  floor="$(smallest_useful_bytes)"
  NEED_FALLOCATE=0; NEED_MKFS=0; NEED_IMAGE_MODE=0
  # Where fstab mounts this image: here (then it is the script's own line),
  # or at another cold directory, whose filesystem it then is.
  while read -r other; do
    case "$other" in
      /*) if same_directory "$other"; then
            in_fstab=1
          else
            die "$FSTAB already mounts $IMAGE at $other: it is that cold directory's filesystem. Pass --mountpoint $other to look at that one, or name another --image PATH for this one."
          fi ;;
    esac
  done < <(fstab_targets_of "$FSTAB" "$IMAGE")
  if [ -e "$IMAGE" ] || [ -L "$IMAGE" ]; then
    if [ ! -f "$IMAGE" ] || [ -L "$IMAGE" ]; then die "$IMAGE exists and is not a regular file"; fi
    type="$(blkid -p -o value -s TYPE "$IMAGE" 2>/dev/null || true)"
    label="$(blkid -p -o value -s LABEL "$IMAGE" 2>/dev/null || true)"
    if [ "$type" != btrfs ] || [ "$label" != "$LABEL" ]; then
      die "$IMAGE exists but is not a btrfs image labelled $LABEL (found: ${type:-no filesystem}${label:+, label $label}). If a run of this script was interrupted while making it, delete it; otherwise it is something else's: name another --image PATH."
    fi
    IMAGE_BYTES="$(stat -c %s "$IMAGE")"
    if [ -n "$SIZE_ARG" ] && [ "$SIZE_BYTES" -gt "$IMAGE_BYTES" ]; then
      die "$IMAGE already exists with $(human_bytes "$IMAGE_BYTES"), smaller than the $(human_bytes "$SIZE_BYTES") asked with --size — to enlarge it: $(basename "$0") grow --to $SIZE_ARG"
    fi
    allocated="$(stat -c '%b %B' "$IMAGE" | awk '{ printf "%.0f\n", $1 * $2 }')"
    if [ "$allocated" -lt "$IMAGE_BYTES" ]; then
      die "$IMAGE is sparse ($(human_bytes "$allocated") of $(human_bytes "$IMAGE_BYTES") allocated): the job's free-space guard would pass while the filesystem underneath fills up. Back it fully: fallocate -l $IMAGE_BYTES $IMAGE — then run this again."
    fi
    while read -r other; do
      [ -n "$other" ] || continue
      while read -r target; do
        if [ -n "$target" ] && [ "$target" != "$MOUNTPOINT" ]; then
          die "$IMAGE is already mounted at $target: it is that cold directory's filesystem. Pass --mountpoint $target to look at that one, or name another --image PATH for this one."
        fi
      done < <(findmnt -rn -S "$other" -o TARGET 2>/dev/null || true)
    done < <(losetup -n -O NAME -j "$IMAGE" 2>/dev/null || true)
    if [ "$(stat -c %a "$IMAGE")" != 600 ]; then
      NEED_IMAGE_MODE=1
      plan "chmod 600 $IMAGE   # it holds the months' data"
    fi
    SIZE_REASONING=("$(human_bytes "$IMAGE_BYTES"): $IMAGE is already there and is kept as it is")
  else
    if [ "$in_fstab" -eq 1 ]; then
      die "$FSTAB mounts $IMAGE at $MOUNTPOINT, but that file is not there — is the filesystem that holds $dir mounted? Mount it and run this again; if the image really is gone, remove the entry first. Nothing is created in its place: a new image would be empty where PostgreSQL expects the months it moved."
    fi
    CREATES=1
    decide_image_size
    [ "$IMAGE_BYTES" -ge "$floor" ] || die "$(too_small_note "$IMAGE_BYTES" "$floor")."
    avail="$(avail_bytes "$dir")"
    if [ "$avail" -lt $((IMAGE_BYTES + HOST_RESERVE_BYTES)) ]; then
      die "not enough room for the image: $dir ($fs) has $(human_bytes "$avail") free, and a $(human_bytes "$IMAGE_BYTES") image plus $(human_bytes "$HOST_RESERVE_BYTES") left for the host needs $(human_bytes $((IMAGE_BYTES + HOST_RESERVE_BYTES))). Free some space, name an --image PATH on a larger filesystem, or pass a smaller --size (at least $(human_bytes "$floor"))."
    fi
    HOST_FREE_NOTE="$dir ($fs) has $(human_bytes "$avail") free; $(human_bytes $((avail - IMAGE_BYTES))) stay free afterwards"
    NEED_FALLOCATE=1; NEED_MKFS=1
    plan "fallocate -l $IMAGE_BYTES $IMAGE   # $(human_bytes "$IMAGE_BYTES"), preallocated, mode 600"
    plan "mkfs.btrfs -L $LABEL $IMAGE"
  fi
  inspect_mount_target "$(fstab_line_image "$IMAGE" "$MOUNTPOINT")"
}

inspect_device() {
  local probe="" probe_rc=0 type label pttype uuid tags mounts signature="" other holders floor size
  require_tools util findmnt blkid lsblk blockdev mount
  require_tools btrfs btrfs mkfs.btrfs
  require_btrfs
  [ -b "$DEVICE" ] || die "$DEVICE is not a block device"
  DEVICE="$(readlink -f -- "$DEVICE")"
  if [ "$CUR_KIND" = device ] && [ "$(readlink -f -- "$CUR_SOURCE")" != "$DEVICE" ]; then
    die "$MOUNTPOINT is already the mount of another device, $CUR_SOURCE — choose another --mountpoint"
  fi
  plan_btrfs_module
  # Low-level probing, never the blkid cache. A partition always answers with PART_ENTRY_* tags,
  # which describe its partition-table entry, not a signature inside it.
  probe="$(blkid -p -o export "$DEVICE" 2>/dev/null)" || probe_rc=$?
  type="$(sed -n 's/^TYPE=//p' <<<"$probe" | head -n 1)"
  label="$(sed -n 's/^LABEL=//p' <<<"$probe" | head -n 1)"
  pttype="$(sed -n 's/^PTTYPE=//p' <<<"$probe" | head -n 1)"
  uuid="$(sed -n 's/^UUID=//p' <<<"$probe" | head -n 1)"
  tags="$(grep -vE '^(DEVNAME|PART_ENTRY_[A-Z_]+)=' <<<"$probe" | sed '/^$/d' | tr '\n' ' ' || true)"
  mounts="$( { lsblk -nro MOUNTPOINT "$DEVICE" 2>/dev/null; findmnt -rn -S "$DEVICE" -o TARGET 2>/dev/null; } | sed '/^$/d' | sort -u | tr '\n' ' ' || true)"
  mounts="${mounts% }"
  NEED_WIPE=0; NEED_MKFS=0
  if [ "$type" = btrfs ] && [ "$label" = "$LABEL" ]; then
    if [ -n "$mounts" ] && [ "$mounts" != "$MOUNTPOINT" ]; then
      die "$DEVICE already holds the $LABEL filesystem, mounted at $mounts and not at $MOUNTPOINT — pass --mountpoint $mounts to keep it there"
    fi
  else
    [ -z "$mounts" ] || die "$DEVICE (or a partition on it) is mounted at $mounts — it is in use, not spare"
    if grep -q "^${DEVICE}[p0-9]*[[:space:]]" /proc/swaps 2>/dev/null; then die "$DEVICE is in use as swap, not spare"; fi
    holders=""
    for other in "/sys/class/block/${DEVICE##*/}/holders"/*; do
      if [ -e "$other" ]; then holders="$holders ${other##*/}"; fi
    done
    [ -z "$holders" ] || die "$DEVICE is in use by another device (${holders# }: a volume group, RAID array or encrypted mapping built on it) — it is not spare"
    if [ "$probe_rc" -ne 0 ] && [ "$probe_rc" -ne 2 ]; then
      signature="signatures that blkid cannot tell apart (blkid -p exits $probe_rc)"
    elif [ -n "$type$pttype" ]; then
      signature="${type}${type:+ filesystem}${type:+${pttype:+ and }}${pttype}${pttype:+ partition table}"
    elif [ -n "$tags" ]; then
      signature="an unidentified signature: ${tags% }"
    elif real_tool wipefs; then
      # blkid names nothing when it finds several filesystem signatures, or one whose superblock
      # it does not accept (a failing checksum); wipefs lists them in both cases.
      other="$(wipefs "$DEVICE" 2>/dev/null | awk 'NR > 1 && NF >= 3 { print $3 }' | sort -u | tr '\n' ' ' || true)"
      other="${other% }"
      case "$other" in
        '')    ;;
        *' '*) signature="more than one signature, which blkid does not name: $other" ;;
        *)     signature="a signature that blkid does not accept (damaged?): $other" ;;
      esac
    fi
    if [ -n "$signature" ]; then
      if [ "$FORCE" -ne 1 ]; then
        die "$DEVICE carries a signature ($signature), so it does not look spare. Make sure it is the right device; --force formats it anyway and destroys what is on it."
      fi
      require_tools util wipefs
      NEED_WIPE=1
      plan "wipefs -a $DEVICE   # --force: erases $signature"
    fi
    NEED_MKFS=1; CREATES=1
    plan "mkfs.btrfs -L $LABEL $DEVICE   # $(human_bytes "$(blockdev --getsize64 "$DEVICE")")"
  fi
  size="$(blockdev --getsize64 "$DEVICE")"
  floor="$(smallest_useful_bytes)"
  [ "$size" -ge "$floor" ] || die "$DEVICE: $(too_small_note "$size" "$floor")."
  while read -r other; do
    [ -n "$other" ] || continue
    other="$(readlink -f -- "$other")"
    [ "$other" != "$DEVICE" ] || continue
    # A second device of the same filesystem (btrfs device add) carries the
    # label too: same filesystem UUID.
    if [ "$type" = btrfs ] && [ "$label" = "$LABEL" ] && [ -n "$uuid" ] \
       && [ "$(blkid -p -o value -s UUID "$other" 2>/dev/null || true)" = "$uuid" ]; then
      continue
    fi
    die "another filesystem labelled $LABEL exists on $other — the fstab line mounts by label and could pick either one. Relabel or remove it (btrfs filesystem label $other NEW-LABEL), then run this again."
  done < <(blkid -t "LABEL=$LABEL" -o device 2>/dev/null || true)
  inspect_mount_target "$(fstab_line_device "$MOUNTPOINT")"
}

inspect_zfs() {
  local pool parent current property value advice
  local -a differing=()
  require_tools zfs zpool zfs
  require_tools util findmnt
  [ -f "$ZFS_SCRIPT" ] || die "$ZFS_SCRIPT, which creates the dataset, is not next to this script"
  pool="${ZFS_DATASET%%/*}"
  plain_dataset "$ZFS_DATASET" || die "'$ZFS_DATASET' is a name this script does not pass on to zfs (it takes letters, digits and . _ - : only) — to use such a dataset, pass --existing with the directory where it is mounted"
  zpool list -H -o name "$pool" >/dev/null 2>&1 || die "there is no ZFS pool named $pool on this host (zpool list: $(zfs_pools | tr '\n' ' '))"
  # ZFS prefixes a pool's altroot to every mountpoint: the dataset would not be mounted
  # where this script was told, and the path it passes on would be wrong in every later run.
  value="$(pool_altroot "$pool")"
  case "$value" in
    '') ;;
    *)
      if [ "$CUR_KIND" = zfs ] && [ "$CUR_SOURCE" = "$ZFS_DATASET" ]; then
        die "the dataset $ZFS_DATASET is on a pool that is imported with an alternate root ($value): ZFS puts that in front of every mountpoint a dataset is given, and this script sets up and changes no dataset on such a pool. To use the dataset as it is, pass --existing $MOUNTPOINT."
      fi
      die "the pool $pool is imported with an alternate root ($value): ZFS puts that in front of every mountpoint a dataset is given, so the mountpoint this script would set is not where the dataset would end up, and it sets none up on such a pool. Make the dataset the way that host makes its datasets (a storage appliance: in its own UI), with compression on, and pass --existing with the directory where it is mounted." ;;
  esac
  if [ "$CUR_KIND" = zfs ] && [ "$CUR_SOURCE" != "$ZFS_DATASET" ]; then
    # the dataset that is named has this very mountpoint and is not mounted:
    # the other one is mounted in its place
    current="$(zfs get -H -o value mountpoint "$ZFS_DATASET" 2>/dev/null || true)"
    if [[ "$current" == /* ]] && [ "$(canonical_path "$(normalize_path "$current")")" = "$MOUNTPOINT" ]; then
      die "$CUR_SOURCE is mounted at $MOUNTPOINT in the place of $ZFS_DATASET, which has the same mountpoint and is not mounted. To put $ZFS_DATASET there: $(swap_note "$CUR_SOURCE" "$ZFS_DATASET") — then run this again."
    fi
    advice="pass --existing $MOUNTPOINT to keep using it as it is"
    if [[ "$CUR_SOURCE" == */* ]] && plain_dataset "$CUR_SOURCE" && [ -z "$(pool_altroot "${CUR_SOURCE%%/*}")" ]; then advice="pass --zfs $CUR_SOURCE to keep using it"; fi
    die "$MOUNTPOINT is already the mountpoint of another dataset, $CUR_SOURCE — $advice, or choose another --mountpoint"
  fi
  # A pool without the zstd feature cannot take compression=zstd-9, and the
  # delegated script would fail after it has created the dataset.
  current="$(zpool get -H -o value feature@zstd_compress "$pool" 2>/dev/null || true)"
  if [ -z "$current" ] && ! zpool upgrade -v 2>/dev/null | grep -q zstd_compress; then
    # zpool does not know the feature at all: OpenZFS before 2.0
    advice="pass --existing with the directory where it is mounted"
    if [ "$CUR_KIND" = zfs ] && [ "$CUR_SOURCE" = "$ZFS_DATASET" ]; then advice="pass --existing $MOUNTPOINT"; fi
    die "this ZFS has no zstd (zpool upgrade -v does not list zstd_compress: OpenZFS before 2.0), and the cold dataset is compressed with zstd-9, so this script sets none up here. Make a dataset with the compression this ZFS has (compression=lz4), or take one that is there, and $advice."
  fi
  if [ "$current" = disabled ]; then
    value="the pool $pool does not have the zstd feature (feature@zstd_compress is disabled, as on a pool made by an older ZFS and not upgraded, one created without it, or one held to a compatibility set), and the cold dataset is compressed with zstd-9."
    current="$(zpool get -H -o value compatibility "$pool" 2>/dev/null || true)"
    case "$current" in
      ''|-|off) ;;
      *) value="$value The pool is held to the feature set $current (its compatibility property), which rules the feature out as long as it stands." ;;
    esac
    advice="zpool set feature@zstd_compress=enabled $pool, then run this again — that cannot be switched off again, and once a dataset uses it, software without zstd can no longer import the pool: not on a pool the boot loader has to read (a boot pool such as bpool, unless that boot loader reads zstd). zpool upgrade $pool would enable every feature the pool lacks at once"
    if [ "$CUR_KIND" = zfs ] && [ "$CUR_SOURCE" = "$ZFS_DATASET" ]; then
      die "$value To use the dataset $ZFS_DATASET as it is, with the compression it has, pass --existing $MOUNTPOINT. To have zstd instead: $advice."
    fi
    die "$value To enable that one feature: $advice. Where the pool is to stay as it is: name another pool with --zfs, or make a dataset with the compression that pool has and pass --existing with its directory."
  fi
  NEED_ZFS=0
  if zfs list -H -o name "$ZFS_DATASET" >/dev/null 2>&1; then
    value="$(zfs get -H -o value type "$ZFS_DATASET" 2>/dev/null || true)"
    case "$value" in
      ''|filesystem) ;;
      *) die "$ZFS_DATASET is a $value, not a filesystem dataset — name a filesystem dataset with --zfs" ;;
    esac
    current="$(zfs get -H -o value mountpoint "$ZFS_DATASET" 2>/dev/null || true)"
    case "$current" in
      /*) if [ "$(canonical_path "$current")" = "$MOUNTPOINT" ]; then current="$MOUNTPOINT"; fi ;;
    esac
    case "$current" in
      "$MOUNTPOINT") ;;
      /*) die "the dataset $ZFS_DATASET exists with mountpoint $current, not $MOUNTPOINT — pass --mountpoint $current to use it where it is, or name another dataset with --zfs" ;;
      *)  die "the dataset $ZFS_DATASET exists with mountpoint=${current:-(unknown)}, so ZFS does not mount it at a path itself — name another dataset with --zfs, or give this one a path (zfs set mountpoint=$MOUNTPOINT $ZFS_DATASET) and run this again" ;;
    esac
    for property in "${ZFS_COLD_PROPS[@]}"; do
      zfs_has_property "$ZFS_DATASET" "$property" || differing+=("${property%%=*}=$ZFS_FOUND (the cold layout has ${property#*=})")
    done
    if [ "${#differing[@]}" -gt 0 ]; then
      die "the dataset $ZFS_DATASET exists with other properties: ${differing[*]}. To give it the cold properties (they apply to blocks written from then on): $ZFS_SCRIPT --cold-only $ZFS_DATASET $MOUNTPOINT — then run this again. Or, to use the dataset as it is, pass --existing $MOUNTPOINT."
    fi
    if [ -z "$(fstab_entries "$FSTAB" "$MOUNTPOINT")" ]; then
      value="$(not_mounted_at_boot "$ZFS_DATASET")"
      if [ -n "$value" ]; then warn "$value"; fi
    fi
    if [ "$CUR_KIND" != zfs ] || ! owner_is_right "$MOUNTPOINT"; then NEED_ZFS=1; fi
  else
    # zfs create -p makes the missing parents too, each mounted at its
    # inherited mountpoint, over whatever directory is there.
    parent="${ZFS_DATASET%/*}"
    zfs list -H -o name "$parent" >/dev/null 2>&1 || die "the parent dataset $parent does not exist: creating $ZFS_DATASET would create it too and mount it at the mountpoint it inherits, over whatever directory is there. Create it yourself first (zfs create $parent), or name a dataset directly below one that exists, e.g. --zfs $pool/$ZFS_DATASET_NAME."
    if [ -d "$MOUNTPOINT" ] && [ -n "$(ls -A -- "$MOUNTPOINT")" ]; then
      refuse_occupied "$ZFS_DATASET" "mounting the dataset over it would hide what is in it"
    fi
    NEED_ZFS=1; CREATES=1
  fi
  if [ "$NEED_ZFS" -eq 1 ]; then
    plan "$ZFS_SCRIPT --cold-only $ZFS_DATASET $MOUNTPOINT   # zfs create, ${ZFS_COLD_PROPS[*]}, mountpoint, chown $OWNER, chmod $DIR_MODE"
  fi
}

inspect_subvolume() {
  local base fs property
  require_tools util findmnt
  require_tools btrfs btrfs
  base="$(nearest_existing "$MOUNTPOINT")"
  fs="$(fstype_of "$MOUNTPOINT")"
  [ "$fs" = btrfs ] || die "$base is on ${fs:-an unknown filesystem}, not btrfs — a subvolume needs the cold directory's filesystem to be btrfs"
  NEED_RMDIR=0; NEED_SUBVOLUME=0
  if [ -e "$MOUNTPOINT" ] || [ -L "$MOUNTPOINT" ]; then
    if [ ! -d "$MOUNTPOINT" ] || [ -L "$MOUNTPOINT" ]; then die "$MOUNTPOINT exists and is not a directory"; fi
    if is_subvolume "$MOUNTPOINT"; then
      property="$(btrfs property get "$MOUNTPOINT" compression 2>/dev/null | head -n 1 || true)"
      case "$property" in
        compression=zstd|compression=zstd:*) ;;
        *) die "$MOUNTPOINT is a subvolume already, with ${property:-no compression property} — this script makes it with compression=zstd. Set that (btrfs property set $MOUNTPOINT compression zstd) and run this again, or pass --existing $MOUNTPOINT to use the subvolume as it is." ;;
      esac
      require_only_tablespace "$MOUNTPOINT"
      plan_owner
      return 0
    fi
    if [ -n "$(ls -A -- "$MOUNTPOINT")" ]; then
      refuse_occupied "a subvolume" "a subvolume cannot take the place of a directory with files in it"
    fi
    NEED_RMDIR=1
    plan "rmdir $MOUNTPOINT   # an empty directory: a subvolume takes its place"
  elif [ ! -d "$(dirname "$MOUNTPOINT")" ]; then
    plan "mkdir -p $(dirname "$MOUNTPOINT")"
  fi
  NEED_SUBVOLUME=1; CREATES=1
  plan "btrfs subvolume create $MOUNTPOINT"
  plan "btrfs property set $MOUNTPOINT compression zstd"
  plan_owner always
}

inspect_existing() {
  local fs note rc=0
  require_tools util findmnt
  if [ ! -d "$MOUNTPOINT" ] || [ -L "$MOUNTPOINT" ]; then
    die "$MOUNTPOINT is not a directory — --existing adopts one that is already there (create the dataset or share in your storage UI first)"
  fi
  fs="$(fstype_of "$MOUNTPOINT")"
  case "$fs" in
    btrfs|zfs) ;;
    *) die "$MOUNTPOINT is on ${fs:-an unknown filesystem}: closed months would move there but not compress. --existing needs a directory on btrfs or ZFS; without one, leave the flag out and this script creates a compressed filesystem." ;;
  esac
  note="$(compression_of "$MOUNTPOINT")" || rc=$?
  case "$rc" in
    1) die "compression is off for $MOUNTPOINT ($fs): $note — then run this again." ;;
    2) die "cannot tell whether compression is on for $MOUNTPOINT ($fs): $note$(if [ "$fs" = zfs ] && ! command -v zfs >/dev/null 2>&1; then echo " — $(install_hint "$(os_family)" zfs)"; fi)" ;;
  esac
  require_only_tablespace "$MOUNTPOINT"
  # A directory that compresses is not yet the one the database uses: with the tablespace defined and
  # its PG_... directory not here, its files are elsewhere (e.g. the bare mountpoint of a pool not imported).
  if [ "$CUR_MOUNTED" -eq 1 ]; then
    if note="$(tablespace_mismatch)"; then die "$note Nothing was changed."; fi
  else
    refuse_tablespace_not_here
  fi
  plan_owner
}

# inspect_env: what .env needs. Sets ENV_SET_DIR and ENV_COMPOSE_FILE.
inspect_env() {
  local current sep cf from_stack override="" name new summary rc=0
  ENV_SET_DIR=0; ENV_COMPOSE_FILE=""
  [ "$NO_ENV" -eq 0 ] || return 0
  if [ ! -f "$PROJECT_DIR/docker-compose.yml" ] || [ ! -f "$PROJECT_DIR/$OVERLAY" ]; then
    die "$PROJECT_DIR has no docker-compose.yml and $OVERLAY — name the checkout the stack runs from with --project-dir DIR, or pass --no-env and edit .env yourself"
  fi
  if current="$(env_get "$ENV_FILE" MESHINFO_PGCOLD_DIR)" && [ -n "$current" ]; then
    same_directory "$current" || die "$ENV_FILE already sets MESHINFO_PGCOLD_DIR=$current, not $MOUNTPOINT — the stack would bind another directory than the one prepared here. Pass --mountpoint $current, change the line, or use --no-env."
  else
    ENV_SET_DIR=1
  fi
  sep="$(env_get "$ENV_FILE" COMPOSE_PATH_SEPARATOR)" || sep=":"
  [ -n "$sep" ] || sep=":"
  cf="$(env_get "$ENV_FILE" COMPOSE_FILE)" || cf=""
  from_stack=""
  if [ -z "$cf" ] && have_docker; then
    # Started with -f or COMPOSE_FILE in the shell: keep exactly those files. A stack that runs from what
    # Compose loads by itself gets what Compose would load now: docker-compose.yml and the override file.
    from_stack="$(running_config_files "$sep")"
    for name in "" compose.override.yml compose.override.yaml docker-compose.override.yml docker-compose.override.yaml; do
      if [ "$from_stack" = "docker-compose.yml${name:+$sep$name}" ]; then from_stack=""; break; fi
    done
    cf="$from_stack"
  fi
  # The override file Compose loads by itself, in its own order of preference.
  for name in compose.override.yml compose.override.yaml docker-compose.override.yml docker-compose.override.yaml; do
    if [ -f "$PROJECT_DIR/$name" ]; then override="$name"; break; fi
  done
  new="$(compose_file_with_overlay "$cf" "$sep" "$override")" || rc=$?
  case "$rc" in
    0) ENV_COMPOSE_FILE="$new" ;;
    3) if [ -n "$from_stack" ]; then ENV_COMPOSE_FILE="$new"; fi ;;   # the overlay came with -f: write the list down
    4) die "$ENV_FILE runs the stack with $FULL_ZFS_OVERLAY (the full ZFS layout), which already binds a cold dataset at $PG_COLD_PATH — the cold-only overlay does not go on top of it. Pass --no-env if this directory is for something else." ;;
  esac
  if [ "$ENV_SET_DIR" -eq 1 ] || [ -n "$ENV_COMPOSE_FILE" ]; then
    summary=".env:"
    if [ -n "$ENV_COMPOSE_FILE" ]; then summary="$summary COMPOSE_FILE=$ENV_COMPOSE_FILE"; fi
    if [ "$ENV_SET_DIR" -eq 1 ]; then summary="$summary MESHINFO_PGCOLD_DIR=$MOUNTPOINT"; fi
    if [ -f "$ENV_FILE" ]; then summary="$summary   # in $ENV_FILE, after a backup copy"; else summary="$summary   # creates $ENV_FILE"; fi
    plan "$summary"
  fi
}

# --- Doing it ---

fstab_add() {
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  FSTAB_BACKUP=""
  if [ -f "$FSTAB" ]; then
    FSTAB_BACKUP="$FSTAB.bak-meshinfo-$stamp"
    cp -p -- "$FSTAB" "$FSTAB_BACKUP"
    if [ -s "$FSTAB" ] && [ "$(tail -c 1 "$FSTAB" | wc -l)" -eq 0 ]; then printf '\n' >> "$FSTAB"; fi
  fi
  printf '# MeshInfo cold storage (scripts/setup-cold-storage.sh)\n%s\n' "$1" >> "$FSTAB"
}

apply_owner() {
  if [ "$NEED_OWNER" -eq 1 ]; then
    chown "$OWNER" "$MOUNTPOINT"
    chmod "$DIR_MODE" "$MOUNTPOINT"
    chmod u-s,g-s "$MOUNTPOINT"   # a numeric mode leaves a directory's setgid bit in place
  fi
}

# mount_failed_note: what a failed mount leaves behind and how to back out of what this run made. An image
# or device that was there before may hold every moved month: deleting it is never the advice then.
mount_failed_note() {
  local note
  if [ "$NEED_FSTAB" -eq 1 ]; then
    note="The fstab line stays in place, so that once the cause is dealt with a second run only has to mount. To back out instead: take the two lines this script added out of $FSTAB${FSTAB_BACKUP:+ (the file as it was: $FSTAB_BACKUP)}"
    if [ "$KIND" = image ] && [ "$NEED_FALLOCATE" -eq 1 ]; then
      note="$note and delete $IMAGE."
    elif [ "$KIND" = image ]; then
      note="$note. $IMAGE was there before this run and stays as it is: once months were moved, it is their only copy."
    else
      note="$note."
    fi
  elif [ "$KIND" = image ]; then
    note="The fstab line and $IMAGE were there before this run and stay as they are, so that once the cause is dealt with a second run only has to mount. Do not delete the image to start over unless this is still the first setup: once months were moved, it is their only copy."
  else
    note="The fstab line was there before this run and stays as it is, so that once the cause is dealt with a second run only has to mount. Once months were moved, the filesystem on $DEVICE is their only copy."
  fi
  printf '%s\n' "$note"
}

apply_mount_target() {
  if [ "$NEED_MKDIR" -eq 1 ]; then mkdir -p -- "$MOUNTPOINT"; fi
  if [ "$NEED_FSTAB" -eq 1 ]; then fstab_add "$WANT_FSTAB_LINE"; fi
  if [ "$NEED_RELOAD" -eq 1 ]; then systemctl daemon-reload || true; fi
  if [ "$NEED_MOUNT" -eq 1 ]; then
    mount "$MOUNTPOINT" || die "mount $MOUNTPOINT failed (its message is above). $(mount_failed_note)"
    # With nofail in the line, mount returns 0 without mounting when the
    # device is not there: never go on to chown the bare directory.
    [ "$(findmnt -rn -M "$MOUNTPOINT" -o FSTYPE 2>/dev/null | tail -n 1 || true)" = btrfs ] || die "mount $MOUNTPOINT returned without mounting anything (nofail keeps it quiet: is what the fstab line names there?). The directory underneath was left as it is; the fstab line stays in place."
  fi
  apply_owner
}

apply_image() {
  if [ "$NEED_MODULE" -eq 1 ]; then apply_btrfs_module; fi
  if [ "$NEED_FALLOCATE" -eq 1 ]; then
    log "Creating $IMAGE ($(human_bytes "$IMAGE_BYTES"), preallocated)"
    # set -C: never write over a file that appeared since the plan was made.
    if ! ( umask 077; set -C; : > "$IMAGE" ) 2>/dev/null; then
      if [ -e "$IMAGE" ]; then die "$IMAGE appeared while this was running — nothing was changed; look at it, then run this again"; fi
      die "cannot create $IMAGE (is $(dirname "$IMAGE") writable?) — nothing was changed"
    fi
    if ! fallocate -l "$IMAGE_BYTES" "$IMAGE"; then
      rm -f -- "$IMAGE"
      die "fallocate could not preallocate $IMAGE (the filesystem there cannot, or the room went away) — nothing was left behind; name another --image PATH"
    fi
  fi
  if [ "$NEED_MKFS" -eq 1 ]; then mkfs.btrfs -q -L "$LABEL" "$IMAGE"; fi
  if [ "$NEED_IMAGE_MODE" -eq 1 ]; then chmod 600 "$IMAGE"; fi
  apply_mount_target
}

apply_device() {
  if [ "$NEED_MODULE" -eq 1 ]; then apply_btrfs_module; fi
  if [ "$NEED_WIPE" -eq 1 ]; then
    log "Erasing the signatures on $DEVICE (--force)"
    wipefs -a -q "$DEVICE"
  fi
  if [ "$NEED_MKFS" -eq 1 ]; then
    log "Formatting $DEVICE as btrfs, label $LABEL"
    mkfs.btrfs -q -L "$LABEL" "$DEVICE"
    if command -v udevadm >/dev/null 2>&1; then udevadm settle 2>/dev/null || true; fi
  fi
  apply_mount_target
}

apply_zfs() {
  if [ "$NEED_ZFS" -eq 1 ]; then
    log "Creating the dataset: $(basename "$ZFS_SCRIPT") --cold-only $ZFS_DATASET $MOUNTPOINT"
    # Its closing "next steps" are about .env, which this script handles itself.
    if ! bash "$ZFS_SCRIPT" --cold-only "$ZFS_DATASET" "$MOUNTPOINT" | sed '/^Dataset ready:/,$d'; then
      die "$(basename "$ZFS_SCRIPT") did not finish — what it reported above has to be fixed first; then run this again"
    fi
    require_dataset_mounted_here
    chmod u-s,g-s "$MOUNTPOINT"   # its numeric chmod leaves a setgid bit in place
  fi
}

# mounted_dataset_here: the ZFS dataset mounted on top at the cold directory, or nothing.
mounted_dataset_here() {
  local line
  line="$(findmnt -rn -M "$MOUNTPOINT" -o SOURCE,FSTYPE 2>/dev/null | tail -n 1 || true)"
  if [ "${line##* }" = zfs ]; then printf '%b\n' "${line%% *}"; fi
}

# require_dataset_mounted_here: the ZFS layout's dataset is what is mounted at the cold directory.
# Nothing is chowned or reported as ready on a path where ZFS did not put it.
require_dataset_mounted_here() {
  local found where
  found="$(mounted_dataset_here)"
  [ "$found" != "$ZFS_DATASET" ] || return 0
  where="$(zfs get -H -o value mountpoint "$ZFS_DATASET" 2>/dev/null || true)"
  die "the dataset $ZFS_DATASET is not what is mounted at $MOUNTPOINT (${found:-no dataset} is; zfs get mountpoint $ZFS_DATASET says ${where:-nothing}). Nothing was changed at $MOUNTPOINT. If the dataset is mounted somewhere else, pass that directory as --mountpoint, or with --existing to use it as it is."
}

apply_subvolume() {
  if [ "$NEED_SUBVOLUME" -eq 1 ]; then
    if [ "$NEED_RMDIR" -eq 1 ]; then rmdir -- "$MOUNTPOINT"; fi
    mkdir -p -- "$(dirname "$MOUNTPOINT")"
    btrfs subvolume create "$MOUNTPOINT" >/dev/null
    btrfs property set "$MOUNTPOINT" compression zstd
  fi
  apply_owner
}

apply_env() {
  local backup="" before_ok=1 output
  if [ "$ENV_SET_DIR" -eq 0 ] && [ -z "$ENV_COMPOSE_FILE" ]; then return 0; fi
  if have_docker && ! (cd "$PROJECT_DIR" && docker compose config -q) >/dev/null 2>&1; then before_ok=0; fi
  if [ -f "$ENV_FILE" ]; then
    backup="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p -- "$ENV_FILE" "$backup"
    if [ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE" | wc -l)" -eq 0 ]; then printf '\n' >> "$ENV_FILE"; fi
  else
    : > "$ENV_FILE"
    chown "$(stat -c '%u:%g' "$PROJECT_DIR")" "$ENV_FILE"
    chmod 644 "$ENV_FILE"
  fi
  if [ -n "$ENV_COMPOSE_FILE" ]; then env_set "$ENV_FILE" COMPOSE_FILE "$ENV_COMPOSE_FILE"; fi
  if [ "$ENV_SET_DIR" -eq 1 ]; then env_set "$ENV_FILE" MESHINFO_PGCOLD_DIR "$MOUNTPOINT"; fi
  log "Updated $ENV_FILE${backup:+ (the previous file is $backup)}"
  if have_docker; then
    if output="$(cd "$PROJECT_DIR" && docker compose config 2>&1)"; then
      grep -q "target: $PG_COLD_PATH" <<<"$output" || warn "docker compose config does not show a bind at $PG_COLD_PATH — check COMPOSE_FILE in $ENV_FILE"
    elif [ "$before_ok" -eq 1 ]; then
      if [ -n "$backup" ]; then cat "$backup" > "$ENV_FILE"; else rm -f -- "$ENV_FILE"; fi
      die "docker compose config fails with the new .env, so the previous one was put back. The cold directory itself is ready; add the two lines by hand (ZFS.md, \"Cold-only setup\"). Compose said:
$output"
    else
      warn "docker compose config fails, as it did before .env was touched: $(tail -n 1 <<<"$output")"
    fi
  fi
}

confirm() {
  local answer=""
  [ "$YES" -eq 0 ] || return 0
  if [ ! -t 0 ]; then
    die "not asking for confirmation because standard input is not a terminal — pass --yes to go ahead, or --dry-run to only look"
  fi
  read -r -p "Go ahead? [y/N] " answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) die "stopped; nothing was changed" ;;
  esac
}

# verify_cold_directory: the checks every layout must pass in the end.
verify_cold_directory() {
  local fs how rc=0 options
  fs="$(findmnt -n -o FSTYPE -T "$MOUNTPOINT" 2>/dev/null | tail -n 1 || true)"
  case "$fs" in
    btrfs|zfs) info "ok  findmnt -no FSTYPE -T $MOUNTPOINT prints $fs" ;;
    *) die "verification failed: findmnt -no FSTYPE -T $MOUNTPOINT prints '${fs}', not btrfs or zfs" ;;
  esac
  case "$KIND" in
    image|device)
      options="$(findmnt -rn -M "$MOUNTPOINT" -o OPTIONS 2>/dev/null | tail -n 1 || true)"
      case ",$options," in
        *,compress-force=zstd:9,*) ;;
        *) die "verification failed: $MOUNTPOINT is mounted with '$options', without compress-force=zstd:9 — unmount it and mount it again from fstab: umount $MOUNTPOINT && mount $MOUNTPOINT" ;;
      esac ;;
    zfs)
      require_dataset_mounted_here
      info "ok  $ZFS_DATASET is what is mounted there" ;;
  esac
  how="$(compression_of "$MOUNTPOINT")" || rc=$?
  case "$rc" in
    0) info "ok  compression is on: $how" ;;
    1) die "verification failed: compression is not on for $MOUNTPOINT: $how" ;;
    *) die "verification failed: cannot tell whether compression is on for $MOUNTPOINT: $how" ;;
  esac
  owner_is_right "$MOUNTPOINT" || die "verification failed: $MOUNTPOINT is $(stat -c '%u:%g mode %a' "$MOUNTPOINT"), not $OWNER mode $DIR_MODE"
  info "ok  $(owner_note "$MOUNTPOINT")"
}

# tablespace_mismatch: the running database keeps its cold tablespace elsewhere than in what is at the cold
# directory now. Prints what to say and returns 0; 1 when there is nothing to say.
tablespace_mismatch() {
  local name relations has
  cold_tablespace_in_database || return 1
  cold_tablespace_place
  name="$(cold_tablespace_name)"
  case "$TABLESPACE_PLACE" in
    here) return 1 ;;
    elsewhere) storage_elsewhere_note; return 0 ;;
  esac
  relations="$(cold_tablespace_relations)"
  case "$relations" in
    0)  has=", with nothing stored on it yet," ;;
    '') has="" ;;
    *)  has=", which holds $relations of its tables and indexes," ;;
  esac
  echo "the running database has the tablespace $name$has but its PG_... directory is not in $MOUNTPOINT: what is there now is not the filesystem that tablespace's files belong on. Take it away and put the right one in its place — never one over the other ($(basename "$0") status shows what is there now)$(if [ "$relations" = 0 ]; then echo "; only if the right one is gone for good: drop the tablespace (DROP TABLESPACE $name; ZFS.md, \"Rolling back\") and run this again"; fi)."
}

# verify_tablespace_here: the last check: the cold directory is not ready
# while the running database keeps its cold tablespace somewhere else.
verify_tablespace_here() {
  local note
  cold_tablespace_in_database || return 0   # no such tablespace, or nobody to ask
  if note="$(tablespace_mismatch)"; then
    die "verification failed: $note What this run did before (a mount, the owner) stays as it is."
  fi
  info "ok  the running database's tablespace $(cold_tablespace_name) has its directory there"
}

# container_view SERVICE PATH: one line on whether the container sees the cold filesystem. Sets VIEW_STATE: sees,
# stale (started before the mount), unbound, elsewhere, unreachable, down. Status 0 for sees, 2 for down, else 1.
container_view() {
  local service="$1" path="$2" cid bound host inside
  VIEW_STATE=down
  if ! cid="$(service_container "$service")"; then
    info "$service: not running"
    return 2
  fi
  bound="$(docker inspect -f '{{range .Mounts}}{{println .Destination .Source}}{{end}}' "$cid" 2>/dev/null |
             awk -v path="$path" '$1 == path { print $2; exit }' || true)"
  if [ -z "$bound" ]; then
    VIEW_STATE=unbound
    info "$service: NOTHING is bound at $path — the overlay is not part of the running stack; with $OVERLAY in COMPOSE_FILE: docker compose up -d"
    return 1
  fi
  if [ "$(canonical_path "$bound")" != "$MOUNTPOINT" ]; then
    VIEW_STATE=elsewhere
    info "$service: $path is bound to $bound, NOT to $MOUNTPOINT"
    return 1
  fi
  host="$(stat -c '%d:%i' "$MOUNTPOINT" 2>/dev/null || true)"
  if ! inside="$(docker exec "$cid" stat -c '%d:%i' "$path" 2>/dev/null)" || [ -z "$inside" ]; then
    VIEW_STATE=unreachable
    info "$service: COULD NOT look inside the container (docker exec fails: is it restarting or paused? docker compose ps, docker compose logs $service)"
    return 1
  fi
  if [ -n "$host" ] && [ "$inside" = "$host" ]; then
    VIEW_STATE=sees
    if [ -n "${CUR_STACK:-}" ]; then
      info "$service: sees what is on top at ${CUR_STACK_AT:-$MOUNTPOINT} now, at $path"
    else
      info "$service: sees the cold filesystem at $path"
    fi
    return 0
  fi
  VIEW_STATE=stale
  if [ -n "${CUR_STACK:-}" ]; then
    # a restart would hand the container whatever is on top
    info "$service: $path shows ANOTHER filesystem than the one that is on top at ${CUR_STACK_AT:-$MOUNTPOINT} now (see \"stacked\" above) — do not restart the containers before that is put right"
    return 1
  fi
  info "$service: $path shows the bare directory underneath, NOT the filesystem — the container was started before it was mounted: docker compose restart postgres meshinfo"
  return 1
}

describe_layout() {
  case "$1" in
    image)     echo "btrfs in a preallocated loop image, $IMAGE" ;;
    device)    echo "btrfs on the block device $DEVICE" ;;
    zfs)       echo "the ZFS dataset $ZFS_DATASET" ;;
    subvolume) echo "a btrfs subvolume with the compression property" ;;
    existing)  echo "an existing directory, adopted as it is" ;;
  esac
}

# pick_layout: sets KIND and LAYOUT_REASON: a flag, else what is already there, else the first case that applies.
# A directory that was a cold directory before (.env, a tablespace) never gets a second filesystem on top.
pick_layout() {
  local pools count have fstab_source named=0 holds=0 value fs="" sep cf rc=0
  if [ "$CUR_KIND" = foreign ] && [ "$CHOICE" != existing ]; then
    die "$MOUNTPOINT is already a mount point of something else ($CUR_SOURCE, $CUR_FSTYPE) — choose another --mountpoint"
  fi
  if [ -n "$CHOICE" ]; then
    KIND="$CHOICE"; LAYOUT_REASON="asked for with --$CHOICE"
    return 0
  fi
  case "$CUR_KIND" in
    image)
      KIND=image; IMAGE="$CUR_IMAGE"; LAYOUT_REASON="it is mounted there already"; return 0 ;;
    device)
      if [ "$(blkid -p -o value -s LABEL "$CUR_SOURCE" 2>/dev/null || true)" != "$LABEL" ]; then
        die "$MOUNTPOINT is already a btrfs mount point ($CUR_SOURCE) that this script did not make — to use it as it is, pass --existing $MOUNTPOINT; otherwise choose another --mountpoint"
      fi
      KIND=device; DEVICE="$CUR_SOURCE"; LAYOUT_REASON="it is mounted there already"; return 0 ;;
    zfs)
      case "$CUR_SOURCE" in
        */*) ;;
        *) die "$MOUNTPOINT is the mountpoint of $CUR_SOURCE, the root dataset of a pool, which this script never sets up as cold storage (its properties pass on to every dataset below it) — to use the directory as it is, pass --existing $MOUNTPOINT; otherwise choose another --mountpoint" ;;
      esac
      plain_dataset "$CUR_SOURCE" || die "$MOUNTPOINT is the mountpoint of the dataset '$CUR_SOURCE', a name this script does not pass on to zfs (it takes letters, digits and . _ - : only) — to use the directory as it is, pass --existing $MOUNTPOINT"
      KIND=zfs; ZFS_DATASET="$CUR_SOURCE"; LAYOUT_REASON="it is mounted there already"; return 0 ;;
    subvolume)
      KIND=subvolume; LAYOUT_REASON="it is there already"; return 0 ;;
  esac
  # Nothing is mounted there.
  have="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
  if [ -n "$have" ]; then
    fstab_source="$(awk 'NR == 1 { print $1 }' <<<"$have")"
    if [ "$(wc -l <<<"$have")" -eq 1 ]; then
      case "$fstab_source" in
        "LABEL=$LABEL")
          DEVICE="$(blkid -L "$LABEL" 2>/dev/null || true)"
          [ -n "$DEVICE" ] || die "$FSTAB mounts LABEL=$LABEL at $MOUNTPOINT, but no device carries that label now — attach the device, or remove the line and run this again"
          KIND=device; LAYOUT_REASON="$FSTAB already has it for this directory"; return 0 ;;
        /*)
          if [ ! -b "$fstab_source" ] && [[ " $(awk 'NR == 1 { print $4 }' <<<"$have" | tr ',' ' ') " == *" loop "* ]]; then
            KIND=image; IMAGE="$fstab_source"; LAYOUT_REASON="$FSTAB already has it for this directory"; return 0
          fi ;;
      esac
    fi
    die "$FSTAB already has an entry for $MOUNTPOINT that this script did not write, and it is not mounted:
    $have
  Mount it ($(mount_advice "$have")) and pass --existing $MOUNTPOINT to use what it mounts, or remove the entry, then run this again."
  fi
  # ... and fstab does not mention it. Was it a cold directory before?
  if value="$(env_get "$ENV_FILE" MESHINFO_PGCOLD_DIR)" && [ -n "$value" ] && same_directory "$value"; then named=1; fi
  if [ -d "$MOUNTPOINT" ]; then
    fs="$(fstype_of "$MOUNTPOINT")"
    if compgen -G "$MOUNTPOINT/PG_*" >/dev/null; then holds=1; fi
    if [ "$named" -eq 1 ] || [ "$holds" -eq 1 ] || owner_is_right "$MOUNTPOINT"; then
      # It has what every layout ends with: taken as it is.
      if { [ "$fs" = btrfs ] || [ "$fs" = zfs ]; } && compression_of "$MOUNTPOINT" >/dev/null; then
        if [ "$holds" -eq 0 ]; then
          # ... unless it is the bare mountpoint of a cold filesystem that is away, on a root that compresses
          # too. The database knows; failing that, the chown of an earlier run is the sign.
          refuse_tablespace_not_here
          cold_tablespace_in_database || rc=$?
          if [ "$rc" -eq 2 ] && ! owner_is_right "$MOUNTPOINT"; then
            die "$MOUNTPOINT is what .env names as the cold directory. It is on $fs with compression on, but it is not a filesystem of its own and does not belong to $OWNER yet. If cold storage was set up here before, its filesystem is not mounted now: mount it ($(bring_back_hint)) and run this again. If this directory itself is to hold the cold months, pass --existing $MOUNTPOINT."
          fi
        fi
        KIND=existing
        if [ "$named" -eq 1 ]; then
          LAYOUT_REASON=".env already names it as the cold directory, and it is on $fs with compression on"
        elif [ "$holds" -eq 1 ]; then
          LAYOUT_REASON="it already holds the tablespace, and it is on $fs with compression on"
        else
          LAYOUT_REASON="it is on $fs with compression on and already belongs to $OWNER"
        fi
        return 0
      fi
    fi
    if [ "$holds" -eq 1 ]; then
      die "$MOUNTPOINT holds a PostgreSQL tablespace (a PG_... directory) but is on ${fs:-an unknown filesystem} without compression: the months that were moved there take their full size. Nothing is created on top of it — that would hide them. Move them back first (ZFS.md, \"Rolling back\": tier_partitions.py --tablespace pg_default run --apply --all, then DROP TABLESPACE), empty the directory, and run this again."
    fi
  fi
  if [ "$named" -eq 1 ]; then
    sep="$(env_get "$ENV_FILE" COMPOSE_PATH_SEPARATOR)" || sep=":"
    cf="$(env_get "$ENV_FILE" COMPOSE_FILE)" || cf=""
    rc=0; compose_file_with_overlay "$cf" "${sep:-:}" "" >/dev/null 2>&1 || rc=$?
    if [ -d "$MOUNTPOINT" ] || [ "$rc" -eq 3 ]; then
      # .env speaks of a completed setup (whose filesystem is not here now) or was written ahead of
      # this script. The database knows which: without the tablespace, nothing was ever moved.
      rc=0; cold_tablespace_in_database || rc=$?
      case "$rc" in
        0) refuse_tablespace_not_here
           # It is here after all — in a directory below the top, where
           # cold_tablespace_location put it — on a filesystem that does not compress.
           die "$MOUNTPOINT holds the tablespace $(cold_tablespace_name) of the running database, in a directory below it ($TABLESPACE_LOCATION, as the database names it), but is on ${fs:-an unknown filesystem} without compression: the months that were moved there take their full size. Nothing is created on top of it — that would hide them. Move them back first (ZFS.md, \"Rolling back\": tier_partitions.py --tablespace pg_default run --apply --all, then DROP TABLESPACE), empty the directory, and run this again." ;;
        2) if [ -d "$MOUNTPOINT" ]; then
             die "$MOUNTPOINT is what .env names as the cold directory, and it exists, but nothing is mounted there and it is on ${fs:-an unknown filesystem}. If cold storage was set up here before, its filesystem is not mounted now: mount it ($(bring_back_hint)) and run this again — a second one on top would hide the months already moved. If it never was, name the layout to create (--image, --device, --zfs, --subvolume), or run this again once the stack is up and its database answers: with the database to ask, this script can tell the two apart."
           fi
           die "$MOUNTPOINT is what .env names as the cold directory, with $OVERLAY in COMPOSE_FILE, but the directory is not there. If cold storage was set up here before, the pool or disk that holds it is not attached now: bring it back (zpool import, or mount what holds it) and run this again — nothing is created in its place. If it never was, name the layout to create (--image, --device, --zfs, --subvolume), or run this again once the stack is up and its database answers: with the database to ask, this script can tell the two apart." ;;
      esac
    fi
  fi
  pools="$(zfs_pools)"
  count="$(sed '/^$/d' <<<"$pools" | wc -l)"
  if [ "$count" -eq 1 ]; then
    plain_dataset "$pools" || die "this host has one ZFS pool, '$pools', a name this script does not pass on to zfs (it takes letters, digits and . _ - : only). Make a dataset on it yourself, with compression on, and pass --existing with the directory where it is mounted — or name another layout (--image, --device, --subvolume)."
    KIND=zfs; ZFS_DATASET="$pools/$ZFS_DATASET_NAME"
    LAYOUT_REASON="this host has a ZFS pool, $pools"
    return 0
  fi
  if [ "$count" -gt 1 ]; then
    # the example names a pool that --zfs takes: the one with the most free room, not a boot pool
    have="$(zpool list -H -p -o name,free 2>/dev/null | awk -F'\t' '$1 ~ /^[A-Za-z0-9._:-]+$/ && (best == "" || $2 + 0 > room) { best = $1; room = $2 + 0 } END { print best }' || true)"
    die "this host has $count ZFS pools ($(awk 'NF { printf "%s%s", sep, $0; sep = ", " }' <<<"$pools")): say which one takes the cold dataset — the one with room for the cold months${have:+, e.g. --zfs $have/$ZFS_DATASET_NAME}"
  fi
  if [ "$(fstype_of "$MOUNTPOINT")" = btrfs ]; then
    KIND=subvolume
    LAYOUT_REASON="$(nearest_existing "$MOUNTPOINT"), which will hold the cold directory, is already on btrfs"
    return 0
  fi
  KIND=image
  if [ -z "$IMAGE" ]; then IMAGE="$DEFAULT_IMAGE"; fi
  LAYOUT_REASON="no ZFS pool, and $(nearest_existing "$MOUNTPOINT") is on $(fstype_of "$MOUNTPOINT")"
}

describe_host() {
  local pretty="" pools kernel_btrfs=no state stack
  if [ -r "$OS_RELEASE" ]; then pretty="$(sed -n 's/^PRETTY_NAME=//p' "$OS_RELEASE" | tr -d '"' | head -n 1)"; fi
  if grep -qw btrfs /proc/filesystems 2>/dev/null; then
    kernel_btrfs=yes
  elif btrfs_loadable; then
    kernel_btrfs="as a module, not loaded yet"
  fi
  pools="$(zfs_pools | tr '\n' ' ')"
  if [ "$CUR_MOUNTED" -eq 1 ]; then
    state="a mount point: $CUR_SOURCE ($CUR_FSTYPE)"
  elif [ "$CUR_KIND" = subvolume ]; then
    state="a btrfs subvolume"
  elif [ -d "$MOUNTPOINT" ]; then
    state="a directory on $(fstype_of "$MOUNTPOINT")"
  else
    state="not there yet; $(nearest_existing "$MOUNTPOINT") is on $(fstype_of "$MOUNTPOINT")"
  fi
  if [ -f "$ENV_FILE" ]; then stack=".env is there"; else stack="no .env yet"; fi
  if have_docker; then
    if service_container postgres >/dev/null; then stack="$stack; the stack is running"; else stack="$stack; the stack is not running"; fi
  else
    stack="$stack; docker is not usable from here"
  fi
  log "Found"
  info "host            ${pretty:-unknown system} ($(os_family) family)"
  info "btrfs in kernel $kernel_btrfs"
  info "ZFS pools       ${pools:-none}"
  info "cold directory  $MOUNTPOINT (from $MOUNTPOINT_FROM): $state"
  info "stack           $PROJECT_DIR: $stack"
}

# config_newer_than_meshinfo: 0 when config.toml changed after the meshinfo container started
# (it reads the file once, at start), 1 when not, 2 when that cannot be told.
config_newer_than_meshinfo() {
  local cid started changed
  cid="$(service_container meshinfo)" || return 2
  started="$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
  # 2026-01-02T03:04:05.123456789Z -> "2026-01-02 03:04:05", which the date
  # of coreutils and the one of busybox both read
  started="${started%%.*}"; started="${started%Z}"; started="${started/T/ }"
  started="$(date -u -d "$started" +%s 2>/dev/null || true)"
  changed="$(stat -c %Y "$PROJECT_DIR/config.toml" 2>/dev/null || true)"
  [[ "$started" =~ ^[0-9]+$ ]] && [[ "$changed" =~ ^[0-9]+$ ]] || return 2
  [ "$changed" -gt "$started" ]
}

print_remaining_steps() {
  local pg_view=down app_view=down config_ready=0 newer=1
  echo
  if [ "$NO_ENV" -eq 1 ]; then
    echo ".env was left alone (--no-env). The stack needs these two lines in $ENV_FILE:"
    echo "    COMPOSE_FILE=docker-compose.yml:$OVERLAY    # keep what COMPOSE_FILE already lists, and an override file, before the overlay"
    echo "    MESHINFO_PGCOLD_DIR=$MOUNTPOINT"
    echo
  fi
  if have_docker && service_container postgres >/dev/null; then
    log "The running containers"
    container_view postgres "$PG_COLD_PATH" || true
    pg_view="$VIEW_STATE"
    container_view meshinfo "$APP_COLD_PATH" || true
    app_view="$VIEW_STATE"
    echo
  fi
  # As the job takes them: a bare true (a quoted "true" is a string, which
  # leaves tiering off) and a properly quoted path.
  if [ "$(tiering_raw "$PROJECT_DIR/config.toml" enabled 2>/dev/null || true)" = true ]; then
    case "$(tiering_raw "$PROJECT_DIR/config.toml" cold_filesystem 2>/dev/null || true)" in
      "\"$APP_COLD_PATH\""|"'$APP_COLD_PATH'") config_ready=1 ;;
    esac
  fi
  if [ "$config_ready" -eq 1 ] && [ "$pg_view" = sees ] && [ "$app_view" = sees ]; then
    newer=0; config_newer_than_meshinfo || newer=$?
  fi
  if [ "$config_ready" -eq 1 ] && [ "$pg_view" = sees ] && [ "$app_view" = sees ] && [ "$newer" -eq 0 ]; then
    cat <<EOF
One step remains: config.toml has the two [storage.tiering] lines, but it was
changed after meshinfo was started, and meshinfo reads it only when it starts:
  docker compose restart meshinfo        (in $PROJECT_DIR)
EOF
  elif [ "$config_ready" -eq 1 ] && [ "$pg_view" = sees ] && [ "$app_view" = sees ]; then
    cat <<EOF
Nothing remains to do. The two steps this script leaves to you are done:
  1. config.toml has, under [storage.tiering]:
       enabled = true
       cold_filesystem = "$APP_COLD_PATH"
  2. docker compose up -d has been run since: postgres and meshinfo both see
     the cold filesystem.
EOF
    if [ "$newer" -eq 2 ]; then
      cat <<EOF
(When meshinfo was last started could not be read. It reads config.toml only
when it starts: if the file was edited since, docker compose restart meshinfo)
EOF
    fi
  else
    cat <<EOF
Two steps remain:
  1. In config.toml, under [storage.tiering]:
       enabled = true
       cold_filesystem = "$APP_COLD_PATH"
EOF
    if [ "$config_ready" -eq 1 ]; then echo "     (both lines are there already)"; fi
    if tiering_unreadable "$PROJECT_DIR/config.toml"; then
      echo "     (config.toml sets tiering as a dotted key, an inline table or with quoted"
      echo "     keys, which this script does not read: put the two settings there in"
      echo "     that same form)"
    fi
    cat <<EOF
  2. In $PROJECT_DIR:
       docker compose up -d
EOF
    if [ "$pg_view" = sees ] && [ "$app_view" = sees ]; then
      cat <<EOF
     (postgres and meshinfo have the bind already, so that recreates nothing;
     meshinfo reads config.toml when it starts: docker compose restart meshinfo)
EOF
    elif [ "$pg_view" = stale ] || [ "$app_view" = stale ]; then
      cat <<EOF
     (a container that was started before the filesystem was mounted keeps
     showing the bare directory, and "up -d" does not recreate it:
     docker compose restart postgres meshinfo)
EOF
    fi
  fi
  cat <<EOF

The job creates the meshinfo_cold tablespace on its first cycle and then
moves the closed months, one partition an hour (ZFS.md, steps 4 and 5). To
look again later:
  sudo scripts/$(basename "$0") status
EOF
}

# size_not_used_note: --size was given and the layout here is not an image.
size_not_used_note() {
  local why
  case "$KIND" in
    zfs)       why="a dataset takes its room from the pool as it fills" ;;
    subvolume) why="a subvolume shares the room of its filesystem" ;;
    device)    why="the filesystem takes the whole device" ;;
    *)         why="no storage is created" ;;
  esac
  echo "--size $SIZE_ARG is not used: it is the size of a new loop image, and the layout here is $(describe_layout "$KIND") — $why"
}

# check_other_claims: other ZFS datasets with the cold directory as mountpoint, not mounted. Refused over a bare
# directory; a warning over one in use (mounting would cover it) — unless the copy is mounted: refused, with the swap.
check_other_claims() {
  local name names="" count=0 above other
  while IFS=$'\t' read -r name above; do
    [ -n "$name" ] || continue
    warn "the ZFS dataset $name has $above as its mountpoint, a directory above the cold directory, and is not mounted. Leave it unmounted: mounted there (by hand, by zfs mount -a, or at boot) it would cover the filesystem that holds $MOUNTPOINT. Give it another mountpoint, or set canmount=off on it."
  done < <(unmounted_datasets_above)
  while read -r name; do
    [ -n "$name" ] || continue
    if [ "$KIND" = zfs ] && [ "$name" = "$ZFS_DATASET" ]; then continue; fi
    if copy_is_mounted "$name"; then
      if [ -z "${CHOICE:-}" ]; then
        other="--existing $MOUNTPOINT"
        die "$CUR_SOURCE, which is mounted at $MOUNTPOINT, has its mountpoint from a zfs receive — it is a copy — and $name, which has the same mountpoint, is not mounted: it looks as if the copy is mounted in the cold dataset's place (the cold dataset's key was not loaded, its canmount is noauto, or its pool came late). Nothing is changed. To put $name there: $(swap_note "$CUR_SOURCE" "$name") — then run this again. If $CUR_SOURCE is the one that is meant after all, say so: $other."
      fi
      # named with --existing or --zfs: taken, with what speaks against it.
      # (Another dataset named with --zfs is refused further on.)
      if [ "$KIND" = existing ] || { [ "$KIND" = zfs ] && [ "$ZFS_DATASET" = "$CUR_SOURCE" ]; }; then
        warn "$CUR_SOURCE, which is mounted at $MOUNTPOINT, has its mountpoint from a zfs receive — it is a copy — and $name, which has the same mountpoint, is not mounted. $CUR_SOURCE is taken because it was named. If $name is the cold dataset: $(swap_note "$CUR_SOURCE" "$name")."
      fi
      continue
    fi
    names="${names:+$names, }$name"; count=$((count + 1))
  done < <(unmounted_datasets_here)
  [ "$count" -gt 0 ] || return 0
  if cold_dir_in_use; then
    if [ "$count" -eq 1 ] && [ "$CUR_KIND" = zfs ] && ! mountpoint_received "$names"; then
      # nothing says which of the two is the copy
      warn "the ZFS dataset $names also has $MOUNTPOINT as its mountpoint and is not mounted. Only one of the two is the cold dataset. If it is $CUR_SOURCE, which is mounted there: leave $names unmounted — mounted there (by hand, or by zfs mount -a at boot unless its canmount is noauto) it would cover the cold directory, which is in use — and give it another mountpoint, or set canmount=off on it. If it is $names: $(swap_note "$CUR_SOURCE" "$names")."
    elif [ "$count" -eq 1 ]; then
      warn "the ZFS dataset $names also has $MOUNTPOINT as its mountpoint and is not mounted. Leave it unmounted: mounted there (by hand, or by zfs mount -a at boot unless its canmount is noauto) it would cover the cold directory, which is in use. Give it another mountpoint, or set canmount=off on it."
    else
      warn "the ZFS datasets $names also have $MOUNTPOINT as their mountpoint and are not mounted. Leave them unmounted: mounted there (by hand, or by zfs mount -a at boot unless their canmount is noauto) they would cover the cold directory, which is in use. Give them another mountpoint, or set canmount=off on them."
    fi
    return 0
  fi
  other=""
  if [ -d "$MOUNTPOINT" ] && [ -n "$(ls -A -- "$MOUNTPOINT")" ]; then other=" (it is not empty: look at what is in it before a dataset is mounted over it)"; fi
  if [ "$count" -eq 1 ]; then
    die "the ZFS dataset $names has $MOUNTPOINT as its mountpoint but is not mounted (the pool came late, a key is not loaded, canmount=noauto?) — what is at that path now is the bare directory underneath$other. If it is the cold dataset, mount it (zfs mount -l $(shown "$names"); -l loads the key of one that is encrypted) and run this again. If it is not meant for this path (a copy received from another pool), give it another mountpoint or set canmount=off on it, then run this again."
  fi
  die "the ZFS datasets $names have $MOUNTPOINT as their mountpoint but are not mounted — what is at that path now is the bare directory underneath$other. Mount the one that is the cold dataset (zfs mount -l NAME) and give the others another mountpoint or canmount=off, then run this again."
}

# stacked_note: several btrfs/ZFS mounted one over the other at the cold directory (CUR_STACK): what it means and
# the way out. Not zfs unmount or canmount=off: they act on whatever is on top, whichever dataset is named.
stacked_where() {
  if [ "${CUR_STACK_AT:-$MOUNTPOINT}" = "$MOUNTPOINT" ]; then
    echo "at $MOUNTPOINT"
  else
    echo "at $CUR_STACK_AT, where the filesystem that holds $MOUNTPOINT is mounted"
  fi
}

stacked_note() {
  echo "one over the other: $CUR_STACK — the last is on top: it is what a container started from now on gets, while one that is running keeps what was on top when it was started. A second ZFS dataset with the same mountpoint (a received copy) that zfs mount -a or a boot mounted as well does this, and which of them ends on top can change from one boot to the next. The way out: stop the stack (docker compose stop postgres meshinfo), unmount the directory until nothing is mounted there (umount ${CUR_STACK_AT:-$MOUNTPOINT}, once for each), give the one that is not the cold filesystem another mountpoint or canmount=off, mount the cold one again (zfs mount -l NAME for a dataset) and start the stack (docker compose up -d)"
}

cmd_setup() {
  local step number=0 entry
  TABLESPACE_STATE=""
  require_root
  resolve_project
  resolve_mountpoint
  if [ -n "$IMAGE" ]; then IMAGE="$(normalize_path "$IMAGE")"; fi
  require_tools util findmnt
  detect_current
  describe_host
  if [ -n "$CUR_STACK" ]; then die "more than one filesystem is mounted $(stacked_where), $(stacked_note) — then run this again."; fi
  pick_layout
  log "Layout: $(describe_layout "$KIND") — $LAYOUT_REASON"
  if [ -n "$SIZE_ARG" ] && [ "$KIND" != image ]; then warn "$(size_not_used_note)"; fi
  if [ "$CUR_MOUNTED" -eq 1 ] && [ "$KIND" != existing ] && [ "$CUR_KIND" != "$KIND" ]; then
    die "$MOUNTPOINT is already a mount point ($CUR_SOURCE, $CUR_FSTYPE), which is not that layout — choose another --mountpoint, or run this without a layout flag to keep what is there"
  fi
  inspect_running_stack
  check_other_claims
  entry="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
  if [ -n "$entry" ]; then
    case "$KIND" in
      zfs)
        case "$(zfs_fstab_entry "$entry" "$ZFS_DATASET")" in
          legacy)
            die "the dataset $ZFS_DATASET has mountpoint=legacy, and $FSTAB is what mounts it at $MOUNTPOINT:
    $entry
  ZFS does not mount such a dataset itself, and this script sets none up that way. To use it as it is, pass --existing $MOUNTPOINT." ;;
          legacy-zfsutil)
            die "the dataset $ZFS_DATASET has mountpoint=legacy, and its line in $FSTAB carries the zfsutil option:
    $entry
  mount turns that line down (zfsutil is for a dataset that ZFS mounts itself), so it mounts nothing at boot. Take the option out of the line; to use the dataset as it is, pass --existing $MOUNTPOINT." ;;
          own) ;;   # the dataset itself, the way ZFS mounts it: nothing goes over it
          refused)
            die "$FSTAB has a line for the dataset $ZFS_DATASET itself:
    $entry
  mount turns down an fstab line without the zfsutil option for a dataset whose mountpoint is not legacy (ZFS mounts such a dataset itself, where its mountpoint property says) — and on a systemd host a line that fails without nofail stops the boot. Remove the entry, then run this again." ;;
          unknown)
            # The dataset cannot be asked (inspect_zfs speaks for a missing pool). A line with zfsutil is
            # what will mount the dataset once made; only one without it is in the way.
            if zpool list -H -o name "${ZFS_DATASET%%/*}" >/dev/null 2>&1 && [[ ",$(awk '{ print $4 }' <<<"$entry")," != *,zfsutil,* ]]; then
              die "$FSTAB has a line for the dataset $ZFS_DATASET, which is not there:
    $entry
  Once this script has made the dataset, ZFS mounts it itself and no fstab line is needed (mount turns down one without the zfsutil option). Remove the entry, then run this again."
            fi ;;
          *)
            die "$FSTAB has an entry for $MOUNTPOINT:
    $entry
  At boot it would mount another filesystem over this layout. Remove the entry (or choose another --mountpoint), then run this again." ;;
        esac ;;
      subvolume)
        die "$FSTAB has an entry for $MOUNTPOINT:
    $entry
  At boot it would mount another filesystem over this layout. Remove the entry (or choose another --mountpoint), then run this again." ;;
      existing)
        [ "$CUR_MOUNTED" -eq 1 ] || die "$FSTAB has an entry for $MOUNTPOINT, but it is not mounted:
    $entry
  What is at that path now is the bare directory underneath, not the filesystem. Mount it ($(mount_advice "$entry")), then run this again."
        # mounted now, by hand: a zfs line that mount turns down will not do it again at boot
        if [ "$CUR_FSTYPE" = zfs ]; then
          case "$(zfs_fstab_entry "$entry" "$CUR_SOURCE")" in
            legacy-zfsutil) warn "the line in $FSTAB for $CUR_SOURCE carries the zfsutil option, which mount turns down for a dataset with mountpoint=legacy: it will not mount the dataset at boot. Take the option out of the line." ;;
            refused)        warn "$FSTAB has a line without the zfsutil option for $CUR_SOURCE, a dataset whose mountpoint is not legacy: mount turns that line down — and on a systemd host a line that fails without nofail stops the boot. Remove the line." ;;
          esac
        fi ;;
    esac
  fi
  # a dataset that is adopted as it is, and that nothing mounts after a reboot
  if [ "$KIND" = existing ] && [ "$CUR_KIND" = zfs ] && [ -z "$entry" ] && command -v zfs >/dev/null 2>&1; then
    step="$(not_mounted_at_boot "$CUR_SOURCE")"
    if [ -n "$step" ]; then warn "$step"; fi
  fi
  PLAN=(); SIZE_REASONING=(); HOST_FREE_NOTE=""; CREATES=0; NEED_FALLOCATE=0; FSTAB_BACKUP=""
  case "$KIND" in
    image)     inspect_image ;;
    device)    inspect_device ;;
    zfs)       inspect_zfs ;;
    subvolume) inspect_subvolume ;;
    existing)  inspect_existing ;;
  esac
  # A new filesystem is never put where the database expects one it already uses, and what is there must hold
  # its tablespace. (What this run mounts first is checked after the mount: verify_tablespace_here.)
  if [ "$CREATES" -eq 1 ]; then
    refuse_tablespace_not_here
  elif [ "$KIND" != existing ] && { [ "$CUR_MOUNTED" -eq 1 ] || [ "$CUR_KIND" = subvolume ]; }; then
    if step="$(tablespace_mismatch)"; then die "$step Nothing was changed."; fi
  fi
  inspect_env
  if [ "$KIND" = image ] && [ "${#SIZE_REASONING[@]}" -gt 0 ]; then
    log "Image size"
    for step in "${SIZE_REASONING[@]}"; do info "$step"; done
    if [ -n "$HOST_FREE_NOTE" ]; then info "$HOST_FREE_NOTE"; fi
  fi
  if [ "${#PLAN[@]}" -eq 0 ]; then
    log "Plan: nothing to change — everything this script sets up is already in place"
  else
    log "Plan"
    for step in "${PLAN[@]}"; do
      number=$((number + 1))
      info "$number. $step"
    done
    if [ "$KIND" = zfs ] && [ "$NEED_ZFS" -eq 1 ]; then
      info "what that script runs:"
      bash "$ZFS_SCRIPT" --cold-only "$ZFS_DATASET" "$MOUNTPOINT" --dry-run 2>&1 | sed -n 's/^+ /        /p' || true
    fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run: nothing was changed"
    return 0
  fi
  if [ "${#PLAN[@]}" -gt 0 ]; then
    confirm
    case "$KIND" in
      image)     apply_image ;;
      device)    apply_device ;;
      zfs)       apply_zfs ;;
      subvolume) apply_subvolume ;;
      existing)  apply_owner ;;
    esac
  fi
  log "Verifying $MOUNTPOINT"
  verify_cold_directory
  verify_tablespace_here
  apply_env
  log "Cold storage is ready: $(describe_layout "$KIND"), at $MOUNTPOINT"
  print_remaining_steps
}

# --- status ---

cmd_status() {
  local problems=0 fs how rc entry dataset total free avail size ratio value cf sep image_bytes="" allocated adopted_mount=0
  local unmounted="" claims="" in_use=0 options
  TABLESPACE_STATE=""
  require_root
  resolve_project
  resolve_mountpoint
  require_tools util findmnt
  detect_current
  log "Cold directory $MOUNTPOINT (from $MOUNTPOINT_FROM)"
  entry="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
  # ZFS datasets with this directory as mountpoint that are not mounted: over a bare
  # directory, what belongs here; over one in use, a dataset that would cover it.
  unmounted="$(unmounted_datasets_here)"
  claims="$(awk 'NF { printf "%s%s", sep, $0; sep = ", " }' <<<"$unmounted")"
  if cold_dir_in_use; then in_use=1; fi
  case "$CUR_KIND" in
    image)
      info "layout       btrfs in a loop image: $CUR_IMAGE on $CUR_SOURCE"
      if [ "$CUR_IMAGE_GONE" -eq 0 ]; then
        image_bytes="$(stat -c %s "$CUR_IMAGE")"
        allocated="$(stat -c '%b %B' "$CUR_IMAGE" | awk '{ printf "%.0f\n", $1 * $2 }')"
        if [ "$allocated" -lt "$image_bytes" ]; then
          info "image        $(human_bytes "$image_bytes"), of which only $(human_bytes "$allocated") is ALLOCATED: something trimmed the filesystem inside (fstrim?) and punched the preallocation out, so the job's free-space guard passes while the disk underneath can fill up. Put it back: fallocate -l $image_bytes $CUR_IMAGE"
          problems=1
        else
          info "image        $(human_bytes "$image_bytes"), fully allocated; $(human_bytes "$(avail_bytes "$(dirname "$CUR_IMAGE")")") free beside it"
        fi
      else
        info "image        $CUR_IMAGE IS GONE (deleted, or replaced at its path, while mounted): the data is only reachable through the mount now"
        problems=1
      fi ;;
    device)
      if [ "$(blkid -p -o value -s LABEL "$CUR_SOURCE" 2>/dev/null || true)" = "$LABEL" ]; then
        info "layout       btrfs on the block device $CUR_SOURCE"
      else
        info "layout       a btrfs mounted from $CUR_SOURCE, not made by this script (adopted with --existing)"
        adopted_mount=1
      fi ;;
    zfs)
      info "layout       the ZFS dataset $CUR_SOURCE" ;;
    subvolume)
      info "layout       a btrfs subvolume" ;;
    foreign)
      info "layout       NOT cold storage: $CUR_SOURCE ($CUR_FSTYPE) is mounted there"
      problems=1 ;;
    none)
      if [ -n "$entry" ]; then
        info "layout       NOT MOUNTED — $FSTAB has an entry for it. To mount it: $(mount_advice "$entry"). Then: docker compose restart postgres meshinfo"
        info "fstab        $entry"
        return 1
      elif [ -n "$claims" ] && [ "$in_use" -eq 0 ]; then
        case "$claims" in
          *", "*) value=NAME ;;
          *)      value="$(shown "$claims")" ;;
        esac
        info "layout       NOT MOUNTED — this directory is the mountpoint of a ZFS dataset that is not mounted: $claims. If it is the cold dataset: zfs mount -l $value (-l loads the key of one that is encrypted), then docker compose restart postgres meshinfo$(if [ -d "$MOUNTPOINT" ] && [ -n "$(ls -A -- "$MOUNTPOINT")" ]; then echo ". The directory underneath is not empty: look at what is in it first"; fi)"
        return 1
      elif [ -d "$MOUNTPOINT" ]; then
        info "layout       a directory on $(fstype_of "$MOUNTPOINT")"
      else
        info "layout       nothing is set up: $MOUNTPOINT does not exist — run this script without a subcommand"
        return 1
      fi ;;
  esac
  if [ -n "$CUR_STACK" ]; then
    info "stacked      MORE THAN ONE FILESYSTEM is mounted $(if [ "${CUR_STACK_AT:-$MOUNTPOINT}" = "$MOUNTPOINT" ]; then echo here; else stacked_where; fi), $(stacked_note)"
    problems=1
  fi
  while read -r dataset; do
    [ -n "$dataset" ] || continue
    if copy_is_mounted "$dataset"; then
      info "also         the ZFS dataset $dataset has this directory as its mountpoint too and is NOT MOUNTED, while $CUR_SOURCE, which is mounted here, has its mountpoint from a zfs receive: it looks as if a copy is mounted in the cold dataset's place. To put $dataset here: $(swap_note "$CUR_SOURCE" "$dataset")"
      problems=1
    elif [ "$(zfs get -H -o value canmount "$dataset" 2>/dev/null || true)" = noauto ]; then
      info "also         the ZFS dataset $dataset has this directory as its mountpoint too and is not mounted (canmount=noauto); leave it unmounted — it would cover what is here"
    elif [ "$(zfs get -H -o value keystatus "$dataset" 2>/dev/null || true)" = unavailable ]; then
      info "also         the ZFS dataset $dataset has this directory as its mountpoint too and is NOT MOUNTED. Its key is not loaded, and zfs mount -a passes over it until it is: once the key is loaded (zfs load-key, zfs mount -l, or a boot that loads keys) it would cover what is here. Give it another mountpoint, or set canmount=off or noauto on it"
      problems=1
    elif [ "$CUR_KIND" = zfs ] && ! mountpoint_received "$dataset"; then
      info "also         the ZFS dataset $dataset has this directory as its mountpoint too and is NOT MOUNTED: at the next boot, or with zfs mount -a, it would cover what is here. Only one of the two is the cold dataset. If it is $CUR_SOURCE, which is mounted here: give $dataset another mountpoint, or set canmount=off on it. If it is $dataset: $(swap_note "$CUR_SOURCE" "$dataset")"
      problems=1
    else
      info "also         the ZFS dataset $dataset has this directory as its mountpoint too and is NOT MOUNTED: at the next boot, or with zfs mount -a, it would cover what is here. Give it another mountpoint, or set canmount=off on it"
      problems=1
    fi
  done <<<"$unmounted"
  while IFS=$'\t' read -r dataset value; do
    [ -n "$dataset" ] || continue
    info "also         the ZFS dataset $dataset has $value, a directory above this one, as its mountpoint and is NOT MOUNTED: at the next boot, or with zfs mount -a, it would cover the filesystem this directory is on. Give it another mountpoint, or set canmount=off on it"
    problems=1
  done < <(unmounted_datasets_above)
  fs="$(fstype_of "$MOUNTPOINT")"
  rc=0; how="$(compression_of "$MOUNTPOINT")" || rc=$?
  case "$fs" in
    btrfs|zfs)
      case "$rc" in
        0) info "filesystem   $fs, compression on ($how)" ;;
        1) info "filesystem   $fs, COMPRESSION IS OFF: $how"
           problems=1 ;;
        *) info "filesystem   $fs, compression CANNOT BE TOLD: $how"
           problems=1 ;;
      esac ;;
    *)
      info "filesystem   ${fs:-unknown}: NOT btrfs or zfs — the job refuses to create the tablespace here"
      problems=1 ;;
  esac
  # A filesystem that is read-only takes no move: a dataset with readonly=on,
  # a btrfs that the kernel set read-only after an error.
  options="$(findmnt -n -o OPTIONS -T "$MOUNTPOINT" 2>/dev/null | tail -n 1 || true)"
  case ",$options," in
    *,ro,*)
      info "             the filesystem is mounted READ-ONLY: the job can move nothing onto it (a ZFS dataset with readonly=on; a btrfs that the kernel set read-only after an error — dmesg says which)"
      problems=1 ;;
  esac
  read -r total free avail size < <(stat -f -c '%b %f %a %S' "$MOUNTPOINT")
  info "space        $(human_bytes $((total * size))) in all, $(human_bytes $(((total - free) * size))) used, $(human_bytes $((avail * size))) free$(case "$CUR_KIND" in subvolume|none) echo " (shared with the rest of that filesystem)" ;; esac)"
  if [ -n "$image_bytes" ] && [ $((total * size)) -lt $((image_bytes - FS_SLACK)) ]; then
    info "             the filesystem is SMALLER than its image ($(human_bytes "$image_bytes")): a grow was not finished. Finish it: $(basename "$0") grow --to $((image_bytes / MIB))M"
    problems=1
  fi
  ratio=""
  case "$fs" in
    btrfs)
      if command -v compsize >/dev/null 2>&1; then
        # TOTAL <percent> <bytes on disk> <uncompressed bytes> <referenced bytes>
        value="$(compsize -b "$MOUNTPOINT" 2>/dev/null | awk '$1 == "TOTAL" && $3 > 0 { printf "%.2f %.0f %.0f\n", $4 / $3, $4, $3 }' || true)"
        if [ -n "$value" ]; then
          read -r ratio total free <<<"$value"
          ratio="${ratio}x ($(human_bytes "$total") stored in $(human_bytes "$free"))"
        else
          ratio="nothing stored yet"
        fi
      else
        ratio="not measured: compsize is not installed — $(install_hint "$(os_family)" compsize)"
      fi ;;
    zfs)
      dataset="$(findmnt -n -o SOURCE -T "$MOUNTPOINT" 2>/dev/null | tail -n 1 || true)"
      value="$(zfs get -H -o value compressratio "$dataset" 2>/dev/null || true)"
      ratio="${value:-not available}" ;;
  esac
  if [ -n "$ratio" ]; then info "compression  $ratio"; fi
  if owner_is_right "$MOUNTPOINT"; then
    info "owner        $(owner_note "$MOUNTPOINT" | sed 's/^owner //')"
  elif [ "$(stat -c '%u:%g' "$MOUNTPOINT")" = "$OWNER" ]; then
    info "owner        $(stat -c '%u:%g, mode %a' "$MOUNTPOINT") — the mode is NOT $DIR_MODE; run this script again to set it"
    problems=1
  else
    info "owner        $(stat -c '%u:%g, mode %a' "$MOUNTPOINT") — NOT $OWNER mode $DIR_MODE: the job's CREATE TABLESPACE fails as \"not writable\""
    problems=1
  fi
  case "$CUR_KIND$adopted_mount" in
    device1)
      info "fstab        ${entry:-none (whatever mounts this filesystem is not in fstab)}" ;;
    image0|device0)
      if [ -n "$entry" ]; then
        info "fstab        $entry"
      else
        info "fstab        NO ENTRY — the filesystem will not be mounted after a reboot; run this script again to add it"
        problems=1
      fi ;;
    zfs0)
      if [ -n "$entry" ]; then
        case "$(zfs_fstab_entry "$entry" "$CUR_SOURCE")" in
          legacy|own|unknown)
            info "fstab        $entry" ;;
          legacy-zfsutil)
            info "fstab        UNEXPECTED zfsutil option in the entry for this dataset, which has mountpoint=legacy: mount turns such a line down, so nothing mounts the dataset after a reboot. Take the option out of the line: $entry"
            problems=1 ;;
          refused)
            info "fstab        UNEXPECTED entry for this dataset, which ZFS mounts itself: mount turns such a line down (it has no zfsutil option), and on a systemd host a line that fails without nofail stops the boot. Remove it: $entry"
            problems=1 ;;
          *)
            info "fstab        UNEXPECTED entry for this directory — at boot it would mount another filesystem over this one: $entry"
            problems=1 ;;
        esac
      elif [ "$(zfs get -H -o value mountpoint "$CUR_SOURCE" 2>/dev/null || true)" = legacy ]; then
        # on a pool with an alternate root a path given to zfs set would not be this one
        if [ -n "$(pool_altroot "${CUR_SOURCE%%/*}")" ]; then
          info "fstab        NO ENTRY — the dataset has mountpoint=legacy, so ZFS does not mount it after a reboot: add an fstab line for it"
        else
          info "fstab        NO ENTRY — the dataset has mountpoint=legacy, so ZFS does not mount it after a reboot: add an fstab line for it, or give it a path (zfs set mountpoint=$MOUNTPOINT $(shown "$CUR_SOURCE"))"
        fi
        problems=1
      elif [ "$(zfs get -H -o value canmount "$CUR_SOURCE" 2>/dev/null || true)" = noauto ]; then
        info "fstab        NO ENTRY — the dataset has canmount=noauto, so ZFS does not mount it after a reboot, and nothing in $FSTAB does: zfs set canmount=on $(shown "$CUR_SOURCE") (or mount it with an fstab line that carries the zfsutil and nofail options, or with a unit of your own)"
        problems=1
      else
        info "fstab        none (this layout needs none)"
      fi ;;
    subvolume0)
      if [ -n "$entry" ]; then
        info "fstab        UNEXPECTED entry for this directory — at boot it would mount another filesystem over this one: $entry"
        problems=1
      else
        info "fstab        none (this layout needs none)"
      fi ;;
    *)
      info "fstab        ${entry:-none (this layout needs none)}" ;;
  esac
  if [ -f "$ENV_FILE" ]; then
    value="$(env_get "$ENV_FILE" MESHINFO_PGCOLD_DIR || true)"
    cf="$(env_get "$ENV_FILE" COMPOSE_FILE || true)"
    sep="$(env_get "$ENV_FILE" COMPOSE_PATH_SEPARATOR || true)"
    rc=0; compose_file_with_overlay "$cf" "${sep:-:}" "" >/dev/null 2>&1 || rc=$?
    if [ -z "$value" ] || ! same_directory "$value"; then
      info ".env         MESHINFO_PGCOLD_DIR=${value:-(not set)} — NOT this directory"
      problems=1
    elif [ "$rc" -ne 3 ]; then
      info ".env         MESHINFO_PGCOLD_DIR=$value, but COMPOSE_FILE=${cf:-(not set)} does NOT list $OVERLAY"
      problems=1
    else
      info ".env         MESHINFO_PGCOLD_DIR=$value, COMPOSE_FILE=$cf"
    fi
  else
    info ".env         $ENV_FILE is not there (the stack must be given the overlay and MESHINFO_PGCOLD_DIR some other way)"
  fi
  if have_docker; then
    log "The running containers"
    rc=0; container_view postgres "$PG_COLD_PATH" || rc=$?
    if [ "$rc" -eq 1 ]; then problems=1; fi
    rc=0; container_view meshinfo "$APP_COLD_PATH" || rc=$?
    if [ "$rc" -eq 1 ]; then problems=1; fi
    # The database knows a cold directory that is in use: with the tablespace
    # defined and its PG_... directory not here, its files are somewhere else.
    if cold_tablespace_in_database; then
      cold_tablespace_place
      case "$TABLESPACE_PLACE" in
        away)
          value="$(cold_tablespace_relations)"
          if [ "$value" = 0 ]; then
            info "tablespace   the database has $(cold_tablespace_name), with nothing stored on it yet, but NO PG_... directory is here: the filesystem it belongs on is not at this path. Bring that one back, then docker compose restart postgres meshinfo; only if it is gone for good, drop the tablespace (ZFS.md, \"Rolling back\")"
          else
            info "tablespace   the database has $(cold_tablespace_name)${value:+, which holds $value of its tables and indexes}, but NO PG_... directory is here: this is not the filesystem their files are on. Bring that one back, then docker compose restart postgres meshinfo"
          fi
          problems=1 ;;
        elsewhere)
          info "tablespace   the database has $(cold_tablespace_name) at $TABLESPACE_LOCATION, which is NOT under $PG_COLD_PATH, where the overlay binds this directory: the job moves the months there, not here"
          problems=1 ;;
      esac
    fi
  else
    info "containers   docker is not usable from here, so they were not checked"
  fi
  if [ "$problems" -ne 0 ]; then
    warn "something above needs attention (the lines in capitals)"
    return 1
  fi
}

# --- grow ---

cmd_grow() {
  local new current delta avail dir size block finishing=0 entry
  require_root
  resolve_project
  resolve_mountpoint
  new="$GROW_BYTES"
  require_tools util findmnt
  detect_current
  if [ -n "$CUR_STACK" ]; then die "more than one filesystem is mounted $(stacked_where), $(stacked_note) — then run this again."; fi
  case "$CUR_KIND" in
    image) ;;
    device)
      die "$MOUNTPOINT is btrfs on the block device $CUR_SOURCE, not an image. Enlarge the partition or volume underneath with your partitioning or volume tool, then: btrfs filesystem resize max $MOUNTPOINT" ;;
    zfs)
      die "$MOUNTPOINT is the ZFS dataset $CUR_SOURCE: a dataset has no size of its own, it shares the pool. Add space to the pool, or raise a quota that limits the dataset (zfs get quota,refquota $(shown "$CUR_SOURCE"))." ;;
    subvolume)
      die "$MOUNTPOINT is a btrfs subvolume: it shares its filesystem's space. Enlarge that filesystem (the device underneath, then btrfs filesystem resize max $MOUNTPOINT)." ;;
    *)
      entry="$(fstab_entries "$FSTAB" "$MOUNTPOINT")"
      if [ -n "$entry" ]; then
        die "$MOUNTPOINT is not mounted — mount it first ($(mount_advice "$entry")): an image is enlarged while it is in use"
      fi
      die "there is no loop image mounted at $MOUNTPOINT — nothing to grow ($(basename "$0") status shows what is there)" ;;
  esac
  require_tools util losetup fallocate
  require_tools btrfs btrfs
  [ "$CUR_IMAGE_GONE" -eq 0 ] || die "$CUR_IMAGE, the image behind $CUR_SOURCE, is not there any more (deleted, or replaced at its path, while mounted): the mount writes to a file that is gone, and growing whatever is at that path would not reach it"
  current="$(stat -c %s "$CUR_IMAGE")"
  read -r size block < <(stat -f -c '%b %S' "$MOUNTPOINT")
  size=$((size * block))
  if [ "$new" -le "$current" ] && [ $((current - new)) -lt "$MIB" ] && [ "$size" -lt $((current - FS_SLACK)) ]; then
    # fallocate went through earlier, the two steps after it did not. --to counts in MiB: for an
    # image that is not a whole number of them, the size status names is the one just below.
    finishing=1
    new="$current"
    log "Finishing an earlier grow: $CUR_IMAGE is $(human_bytes "$current") already, the filesystem inside is $(human_bytes "$size")"
    info "1. losetup -c $CUR_SOURCE"
    info "2. btrfs filesystem resize max $MOUNTPOINT"
  elif [ "$new" -le "$current" ]; then
    die "$CUR_IMAGE is $(human_bytes "$current") already; --to $GROW_TO ($(human_bytes "$new")) is not larger — grow only enlarges"
  else
    delta=$((new - current))
    dir="$(dirname "$CUR_IMAGE")"
    avail="$(avail_bytes "$dir")"
    if [ "$avail" -lt $((delta + HOST_RESERVE_BYTES)) ]; then
      die "not enough room: growing $CUR_IMAGE from $(human_bytes "$current") to $(human_bytes "$new") takes $(human_bytes "$delta") more, plus $(human_bytes "$HOST_RESERVE_BYTES") left for the host — $(human_bytes $((delta + HOST_RESERVE_BYTES))) in all; $dir has $(human_bytes "$avail") free"
    fi
    log "Growing $CUR_IMAGE from $(human_bytes "$current") to $(human_bytes "$new") ($dir has $(human_bytes "$avail") free)"
    info "1. fallocate -l $new $CUR_IMAGE"
    info "2. losetup -c $CUR_SOURCE"
    info "3. btrfs filesystem resize max $MOUNTPOINT"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run: nothing was changed"
    return 0
  fi
  confirm
  if [ "$finishing" -eq 0 ]; then
    fallocate -l "$new" "$CUR_IMAGE" || die "fallocate could not extend $CUR_IMAGE; the filesystem inside is unchanged"
  fi
  losetup -c "$CUR_SOURCE" || die "losetup -c $CUR_SOURCE failed (its message is above); the image itself is $(human_bytes "$new") now; to finish: $(basename "$0") grow --to $GROW_TO"
  btrfs filesystem resize max "$MOUNTPOINT" >/dev/null || die "btrfs filesystem resize failed (its message is above); the image itself is $(human_bytes "$new") now; to finish: $(basename "$0") grow --to $GROW_TO"
  read -r size block < <(stat -f -c '%b %S' "$MOUNTPOINT")
  size=$((size * block))
  if [ "$size" -lt $((new - FS_SLACK)) ]; then
    die "the filesystem at $MOUNTPOINT reports $(human_bytes "$size") after the resize, not $(human_bytes "$new"); the image itself is $(human_bytes "$new") now; to finish: $(basename "$0") grow --to $GROW_TO"
  fi
  log "Done: $MOUNTPOINT is now $(human_bytes "$size"), $(human_bytes "$(avail_bytes "$MOUNTPOINT")") free. Nothing needs restarting."
}

main() {
  parse_args "$@"
  case "$CMD" in
    setup)  cmd_setup ;;
    status) cmd_status ;;
    grow)   cmd_grow ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
