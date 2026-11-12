# The lab "host" for scripts/setup-cold-storage.sh (see run.sh): a Debian system
# with its own Docker daemon, loop devices and btrfs, run as a privileged
# container. The same image doubles as the stand-in for the meshinfo service in
# the nested compose stack (python3, asyncpg and requests: enough for
# scripts/tier_partitions.py and scripts/synth_history.py).
FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates docker.io docker-cli docker-compose iptables kmod procps \
      util-linux mount fdisk dmsetup e2fsprogs xfsprogs btrfs-progs btrfs-compsize \
      shellcheck python3 python3-asyncpg python3-requests python3-pytest \
 && rm -rf /var/lib/apt/lists/*
# zpool and zfs, for the section of the suite that runs the ZFS layout on a
# real pool where the kernel these containers run on has ZFS. They are moved
# off PATH: pools belong to the kernel, not to a container, and with the two
# on PATH every run of the script in the lab would see — and, where there is
# exactly one, take — a pool of the machine the lab runs on. Only that
# section puts /opt/zfs/sbin on PATH, for a pool it made itself.
RUN sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends zfsutils-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/zfs/sbin \
 && mv "$(command -v zpool)" "$(command -v zfs)" /opt/zfs/sbin/
# dockerd keeps its images on a real filesystem, not on the container's overlay.
VOLUME /var/lib/docker
CMD ["sleep", "infinity"]
