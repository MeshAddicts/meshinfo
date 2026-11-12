# The lab "host" for scripts/setup-cold-storage.sh (see run.sh): Debian with its own Docker daemon, loop devices
# and btrfs, run privileged. It doubles as the meshinfo service in the nested stack (python3, asyncpg, requests).
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates docker.io docker-cli docker-compose iptables kmod procps \
      util-linux mount fdisk dmsetup e2fsprogs xfsprogs btrfs-progs btrfs-compsize \
      shellcheck python3 python3-asyncpg python3-requests python3-pytest \
 && rm -rf /var/lib/apt/lists/*
# zpool and zfs for the real-pool section, moved off PATH: pools belong to the kernel, and on PATH
# every run in the lab would see — and take — a pool of the machine the lab runs on.
RUN sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends zfsutils-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/zfs/sbin \
 && mv "$(command -v zpool)" "$(command -v zfs)" /opt/zfs/sbin/
# dockerd keeps its images on a real filesystem, not on the container's overlay.
VOLUME /var/lib/docker
CMD ["sleep", "infinity"]
