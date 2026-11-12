#!/usr/bin/env bash
# Runs the lab suite for scripts/setup-cold-storage.sh in a privileged container (loop
# devices, mounts, a Docker daemon of its own): that container is the "host" under test.
#   tests/cold_storage_lab/run.sh                 # everything
#   tests/cold_storage_lab/run.sh image device    # only those sections of suite.sh
#   KEEP=1 tests/cold_storage_lab/run.sh          # leave the container for a look around
# Needs privileged Docker (overlay storage) with btrfs in its kernel; ZFS runs on stand-ins (stubs/), and on a
# real pool where that kernel has ZFS. Loop devices and pools are the kernel's: removing the container mid-run
# leaves them behind (zpool destroy coldlab<time>, losetup -d for files under /lab/disks).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="${COLDLAB_NAME:-meshinfo-coldlab}"
IMAGE="${COLDLAB_IMAGE:-meshinfo-coldlab:latest}"
SUITE=/opt/meshinfo/tests/cold_storage_lab/suite.sh
context="$HERE"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    export MSYS_NO_PATHCONV=1
    context="$(cygpath -w "$HERE")" ;;
esac

# The server image is the one docker-compose.yml names; nothing here pins it.
POSTGRES_IMAGE="$(sed -n 's/^ *image: *\(postgres:[^ ]*\) *$/\1/p' "$REPO/docker-compose.yml" | head -n 1)"
[ -n "$POSTGRES_IMAGE" ] || { echo "no postgres image found in docker-compose.yml" >&2; exit 1; }

docker build -q -t "$IMAGE" "$context" >/dev/null
docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1 || docker pull -q "$POSTGRES_IMAGE" >/dev/null
# A container kept from an earlier run may still hold loop devices and pools, or a
# running suite: those are the kernel's, so they go before the container does.
docker exec "$NAME" bash "$SUITE" cleanup >/dev/null 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$NAME-docker" >/dev/null 2>&1 || true
docker run -d --privileged --name "$NAME" -v "$NAME-docker:/var/lib/docker" "$IMAGE" >/dev/null

finish() {
  # Loop devices belong to the kernel, not to the container: have the suite
  # unmount and detach what it attached before the container goes.
  docker exec "$NAME" bash "$SUITE" cleanup >/dev/null 2>&1 || true
  if [ "${KEEP:-0}" = 1 ]; then
    echo "left running: docker exec -it $NAME bash   (to remove: docker exec $NAME bash $SUITE cleanup; docker rm -f $NAME; docker volume rm $NAME-docker)"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$NAME-docker" >/dev/null 2>&1 || true
  fi
}
trap finish EXIT

# The checkout as it is now (tracked and new files, never ignored ones), with
# the executable bits git records.
(cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) \
  | docker exec -i "$NAME" bash -c 'mkdir -p /opt/meshinfo && tar -xf - -C /opt/meshinfo'
(cd "$REPO" && git ls-files -s | awk -F'\t' '$1 ~ /^100755 / { print $2 }') \
  | docker exec -i "$NAME" bash -c 'cd /opt/meshinfo && xargs -r -d "\n" chmod +x'

# Start the inner Docker daemon, then give it the images the stack runs from.
docker exec "$NAME" bash "$SUITE" bootstrap
docker save "$POSTGRES_IMAGE" "$IMAGE" | docker exec -i "$NAME" docker load >/dev/null
docker exec "$NAME" bash "$SUITE" "$@"
