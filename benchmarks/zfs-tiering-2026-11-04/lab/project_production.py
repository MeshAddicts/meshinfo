#!/usr/bin/env python3
"""Project the lab compression ratios onto the production inventory.

Inputs: ratios.json — per relation class, the logical bytes measured in the
lab and the compression ratio (logical / physical) of that class under the hot
setting (zstd-3 @ 16K) and the cold setting (zstd-9 @ 128K):

    {"classes": {"heap":  {"logical": ..., "hot": 2.92, "cold": 4.82},
                 "btree": {...}, "gin": {...}, "other": {...}}}

and the production size:

    python3 project_production.py --ratios ratios.json --database-gb 29.08 --months 18 --cold-after-months 1

--database-gb is pg_database_size, which already includes every index. By
default the HEAP ratios are applied to the whole of it: the heap is the class
that compresses least (B-trees and the trigram GIN do better), so the result
errs on the large side. With --heap-gb and --index-gb the inventory's own
split is used instead — heap ratios for the heap, B-tree ratios for all
indexes (the GIN share compresses better still), "other" ratios for whatever
is left — as a cross-check. --hot-uncompressed projects the cold-only layouts
(docker-compose.cold.yml: the hot share stays on an ordinary Docker volume at
1x, only the cold share is compressed at the cold ratios).

Assumptions (stated in the benchmark README):
  * every month carries the same volume, so with M months of history and
    cold_after_months = n the cold share is (M - n - 1) / M (current + n closed
    months stay hot);
  * the "haircut" inflates the compressed size of the haircutted rows by the
    given fraction — the whole database (indexes included) in the default mode,
    the heap row only with --heap-gb/--index-gb — to cover payload entropy the
    synthetic archive cannot reproduce.
"""
import argparse
import json

GB = 1e9


def tiered_factor(hot: float, cold: float, cold_frac: float) -> float:
    return (1.0 - cold_frac) / hot + cold_frac / cold


def project(classes, database_gb, months, cold_after, haircut, heap_gb=None, index_gb=None,
            hot_uncompressed=False):
    cold_frac = max(0.0, (months - cold_after - 1) / months)
    if hot_uncompressed:
        classes = {name: {**c, "hot": 1.0} for name, c in classes.items()}
    if heap_gb is None:
        split = [("database, heap ratios", database_gb * GB, classes["heap"], True)]
        mode = "heap ratios on pg_database_size"
    else:
        index_gb = index_gb or 0.0
        other = max(0.0, database_gb - heap_gb - index_gb)
        split = [("heap", heap_gb * GB, classes["heap"], True),
                 ("indexes, B-tree ratios", index_gb * GB, classes["btree"], False),
                 ("other", other * GB, classes.get("other", classes["heap"]), False)]
        mode = "per-class ratios on the inventory split"
    rows = []
    single = tiered = single_hc = tiered_hc = 0.0
    for name, logical, c, haircutted in split:
        s = logical / c["hot"]
        t = logical * tiered_factor(c["hot"], c["cold"], cold_frac)
        hc = 1.0 + haircut if haircutted else 1.0
        single += s
        tiered += t
        single_hc += s * hc
        tiered_hc += t * hc
        rows.append({"class": name, "logical_gb": round(logical / GB, 2),
                     "single_gb": round(s / GB, 2), "tiered_gb": round(t / GB, 2)})
    return {
        "mode": mode,
        "layout": "cold-only (hot share uncompressed)" if hot_uncompressed else "tiered (hot 16K/zstd-3)",
        "production_gb": round(database_gb, 2),
        "cold_fraction": round(cold_frac, 3),
        "single_dataset_gb": round(single / GB, 2),
        "single_dataset_conservative_gb": round(single_hc / GB, 2),
        "tiered_gb": round(tiered / GB, 2),
        "tiered_conservative_gb": round(tiered_hc / GB, 2),
        "classes": rows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratios", required=True)
    ap.add_argument("--database-gb", "--heap-gb-legacy", dest="database_gb", type=float, default=29.08,
                    help="pg_database_size of the production archive in GB (indexes included)")
    ap.add_argument("--heap-gb", type=float, default=None,
                    help="heap bytes of the archive tables (with --index-gb: per-class projection)")
    ap.add_argument("--index-gb", type=float, default=None, help="index bytes of the archive tables")
    ap.add_argument("--months", type=int, default=18, help="months of history in production")
    ap.add_argument("--cold-after-months", type=int, default=1)
    ap.add_argument("--haircut", type=float, default=0.25)
    ap.add_argument("--hot-uncompressed", action="store_true",
                    help="cold-only layout: the hot share stays uncompressed (ratio 1), only the cold "
                         "share is compressed")
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    with open(a.ratios) as f:
        classes = json.load(f)["classes"]
    out = project(classes, a.database_gb, a.months, a.cold_after_months, a.haircut, a.heap_gb, a.index_gb,
                  a.hot_uncompressed)
    out["inputs"] = {"database_gb": a.database_gb, "heap_gb": a.heap_gb, "index_gb": a.index_gb,
                     "months": a.months, "cold_after_months": a.cold_after_months, "haircut": a.haircut,
                     "hot_uncompressed": a.hot_uncompressed}
    print(f"production {a.database_gb} GB (pg_database_size), {out['mode']}, {out['layout']}")
    print(f"cold fraction ({a.months} months, cold_after_months={a.cold_after_months}): {out['cold_fraction']}")
    for c in out["classes"]:
        print(f"  {c['class']:24s} logical {c['logical_gb']:6.2f} GB  single {c['single_gb']:6.2f} GB  "
              f"tiered {c['tiered_gb']:6.2f} GB")
    if a.hot_uncompressed:
        print(f"cold-only (hot untouched, cold 128K/zstd-9): {out['tiered_gb']} GB "
              f"({out['tiered_conservative_gb']} GB conservative)")
    else:
        print(f"single dataset zstd-3@16K: {out['single_dataset_gb']} GB "
              f"({out['single_dataset_conservative_gb']} GB with a {int(a.haircut * 100)}% haircut)")
        print(f"tiered 16K/zstd-3 + 128K/zstd-9: {out['tiered_gb']} GB "
              f"({out['tiered_conservative_gb']} GB conservative)")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
