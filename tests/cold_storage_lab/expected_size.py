#!/usr/bin/env python3
"""The image size scripts/setup-cold-storage.sh should work out, computed a
second time from the brief rather than from the script.

stdin: one "partition bytes" line per monthly partition of mqtt_messages and
packet_receptions that is not on the cold tablespace (any order).
argv:  the database's current month (YYYY-MM), cold_after_months, min_free_mb.
stdout: "<image bytes> <bytes the guard needs free at the tightest move> <that
        partition> <its bytes> <bytes assumed inside before it> <partitions>".
argv[4], optional: the only table the job is told to tier.

The job moves the partitions of months older than the cutoff, oldest month
first and mqtt_messages before packet_receptions, and refuses a move unless
the partition's uncompressed size plus min_free_mb is free; what it moved
earlier is assumed to sit inside at a quarter of its size. A new btrfs keeps
about 0.5 GiB to itself (2 GiB above 50 GiB). Then + 10 %, a whole number of
GiB, and never under 4 GiB.
"""
import math
import re
import sys

GIB = 1024 ** 3
MIB = 1024 ** 2


def main() -> int:
    year, month = (int(part) for part in sys.argv[1].split("-"))
    cold_after = max(1, int(sys.argv[2]))
    min_free = int(sys.argv[3]) * MIB
    cutoff = year * 12 + (month - 1) - cold_after  # months since year 0 of the first hot month

    only = sys.argv[4] if len(sys.argv) > 4 else None

    moves = []
    for line in sys.stdin:
        if not line.strip():
            continue
        name, size = line.split()
        match = re.fullmatch(r"(mqtt_messages|packet_receptions)_(\d{4})_(\d{2})", name)
        if match is None or (only is not None and match.group(1) != only):
            continue
        index = int(match.group(2)) * 12 + int(match.group(3)) - 1
        if index < cutoff:
            moves.append((index, 0 if match.group(1) == "mqtt_messages" else 1, name, int(size)))
    moves.sort()

    inside = 0.0
    needed = 0.0
    tightest = ("-", 0, 0.0)
    for _, _, name, size in moves:
        if inside + size + min_free > needed:
            needed = inside + size + min_free
            tightest = (name, size, inside)
        inside += size / 4
    needed = int(needed + 0.5)

    def image(own: int) -> int:
        return math.ceil((needed + own) * 1.1 / GIB) * GIB

    size = image(560 * MIB)
    if size > 50 * GIB:
        size = image(2100 * MIB)
    print(max(size, 4 * GIB), needed, tightest[0], tightest[1], int(tightest[2] + 0.5), len(moves))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
