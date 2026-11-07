#!/usr/bin/env python3
"""Aggregate `compsize -b` per-file results by PostgreSQL relation class using
the catalog JSON from scripts/zfs_estimate.py dump-catalog.

    python3 compsize_by_class.py --catalog catalog.json --root /mnt/zstd3/base/16384 --label zstd3 [--json out.json]

Every regular file under --root is measured individually (compsize -b FILE),
mapped to its relation through the catalog (filenode from the file name, with
.N segment and _fsm/_vm forks), and summed per class and per relation.
"""
import argparse
import json
import os
import re
import subprocess

SEG = re.compile(r"^(\d+)(?:\.(\d+))?$")
FORK = re.compile(r"^(\d+)_(fsm|vm|init)$")


def classify(info):
    """heap / toast / btree / gin / ... from the catalog's relkind + amname."""
    kind = info.get("relkind")
    if kind in ("r", "p", "m"):
        return "heap"
    if kind == "t":
        return "toast"
    if kind in ("i", "I"):
        return info.get("amname") or "index"
    return "other"


def compsize(path):
    out = subprocess.run(["compsize", "-b", path], capture_output=True, text=True)
    if out.returncode != 0:
        return None
    disk = uncompressed = None
    for line in out.stdout.splitlines():
        if line.startswith("TOTAL"):
            parts = line.split()
            # TOTAL  <perc>  <disk>  <uncompressed>  <referenced>
            disk, uncompressed = int(parts[2]), int(parts[3])
    return disk, uncompressed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--min-bytes", type=int, default=1 << 20, help="per-relation rows kept in JSON")
    a = ap.parse_args()
    with open(a.catalog) as f:
        cat = json.load(f)
    by_node = {}
    for path, info in cat.items():
        node = os.path.basename(path).split(".")[0]
        by_node[node] = info
    classes, rels = {}, {}
    for name in sorted(os.listdir(a.root)):
        p = os.path.join(a.root, name)
        if not os.path.isfile(p):
            continue
        m = SEG.match(name)
        fm = FORK.match(name)
        if m:
            node, cls_override = m.group(1), None
        elif fm:
            node, cls_override = fm.group(1), "fsm/vm"
        else:
            continue
        info = by_node.get(node)
        r = compsize(p)
        if r is None:
            continue
        disk, logical = r
        if info is None:
            cls, rel = "unknown", f"filenode {node}"
        else:
            cls = cls_override or info.get("cls") or classify(info)
            rel = info["relname"]
        c = classes.setdefault(cls, {"disk": 0, "logical": 0, "files": 0})
        c["disk"] += disk
        c["logical"] += logical
        c["files"] += 1
        rr = rels.setdefault(rel, {"cls": cls, "disk": 0, "logical": 0, "month": (info or {}).get("month"),
                                   "parent": (info or {}).get("parent")})
        rr["disk"] += disk
        rr["logical"] += logical
    tot_disk = sum(c["disk"] for c in classes.values())
    tot_log = sum(c["logical"] for c in classes.values())
    print(f"== {a.label} {a.root}")
    print(f"{'class':10s} {'logical':>14s} {'on-disk':>14s} {'ratio':>7s}")
    for cls, c in sorted(classes.items(), key=lambda kv: -kv[1]["logical"]):
        ratio = c["logical"] / c["disk"] if c["disk"] else float("inf")
        print(f"{cls:10s} {c['logical']:14d} {c['disk']:14d} {ratio:7.2f}")
    print(f"{'TOTAL':10s} {tot_log:14d} {tot_disk:14d} {(tot_log / tot_disk) if tot_disk else 0:7.2f}")
    if a.json:
        big = {k: v for k, v in rels.items() if v["logical"] >= a.min_bytes}
        with open(a.json, "w") as f:
            json.dump({"label": a.label, "root": a.root, "classes": classes, "total_disk": tot_disk,
                       "total_logical": tot_log, "relations": big}, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
