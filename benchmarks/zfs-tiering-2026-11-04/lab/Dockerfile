FROM postgres:18
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      btrfs-progs btrfs-compsize e2fsprogs util-linux procps time rsync \
      python3 python3-asyncpg python3-zstandard python3-lz4 python3-requests \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /lab && chown postgres:postgres /lab
WORKDIR /lab
ENTRYPOINT ["/bin/bash", "-c", "sleep infinity"]
