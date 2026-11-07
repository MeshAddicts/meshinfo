#!/usr/bin/env python3
"""Project lab compression ratios onto the production inventory.

Inputs: a ratios JSON with per relation class logical bytes measured in the
lab and the compression ratio (logical / physical) of that class under the hot
setting (zstd-3 @ 16K), the cold setting (zstd-9 @ 128K) and, optionally, a
measured btrfs cross-check:

    {"classes": {"heap":  {"logical": ..., "hot": 4.9, "cold": 5.6},
                 "toast": {...}, "btree": {...}, "gin": {...}, "fsm/vm": {...}}}

Assumptions (stated in the benchmark README):
  * production's index:heap byte proportion equals the lab's (fresh, unbloated
    indexes, so this is optimistic for a bloated production cluster);
  * every month carries the same volume, so with M months of history and
    cold_after_months = n the cold share is (M - n - 1) / M (current + n closed
    months stay hot);
  * the "haircut" inflates the physical size of heap + toast by the given
    fraction to cover payload entropy the synthetic archive cannot reproduce.

    python3 project_production.py --ratios ratios.json --heap-gb 29.08 --months 18 \
        --cold-after-months 1 --haircut 0.25
"""
import argparse
import json

GB = 1e9


def project(classes, heap_gb, months, cold_after, haircut):
    lab_total = sum(c["logical"] for c in classes.values())
    lab_heap = sum(c["logical"] for k, c in classes.items() if k in ("heap", "toast"))
    prod_total = heap_gb * GB * lab_total / lab_heap
    cold_frac = max(0.0, (months - cold_after - 1) / months)
    rows = []
    single = tiered = single_hc = tiered_hc = 0.0
    for name, c in classes.items():
        logical = prod_total * c["logical"] / lab_total
        s = logical / c["hot"]
        t = logical * ((1 - cold_frac) / c["hot"] + cold_frac / c["cold"])
        hc = 1 + haircut if name in ("heap", "toast") else 1.0
        single += s
        tiered += t
        single_hc += s * hc
        tiered_hc += t * hc
        rows.append((name, logical, s, t))
    return {
        "production_logical_gb": round(prod_total / GB, 2),
        "cold_fraction": round(cold_frac, 3),
        "single_dataset_gb": round(single / GB, 2),
        "single_dataset_conservative_gb": round(single_hc / GB, 2),
        "tiered_gb": round(tiered / GB, 2),
        "tiered_conservative_gb": round(tiered_hc / GB, 2),
        "classes": [{"class": n, "logical_gb": round(lg / GB, 2), "single_gb": round(s / GB, 2),
                     "tiered_gb": round(t / GB, 2)} for n, lg, s, t in rows],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratios", required=True)
    ap.add_argument("--heap-gb", type=float, default=29.08)
    ap.add_argument("--months", type=int, default=18, help="months of history in production")
    ap.add_argument("--cold-after-months", type=int, default=1)
    ap.add_argument("--haircut", type=float, default=0.25)
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    with open(a.ratios) as f:
        classes = json.load(f)["classes"]
    out = project(classes, a.heap_gb, a.months, a.cold_after_months, a.haircut)
    out["inputs"] = {"heap_gb": a.heap_gb, "months": a.months, "cold_after_months": a.cold_after_months,
                     "haircut": a.haircut}
    print(f"production logical (heap {a.heap_gb} GB + indexes at lab proportion): {out['production_logical_gb']} GB")
    print(f"cold fraction ({a.months} months, cold_after_months={a.cold_after_months}): {out['cold_fraction']}")
    for c in out["classes"]:
        print(f"  {c['class']:8s} logical {c['logical_gb']:6.2f} GB  single {c['single_gb']:6.2f} GB  tiered {c['tiered_gb']:6.2f} GB")
    print(f"single dataset zstd-3@16K: {out['single_dataset_gb']} GB "
          f"({out['single_dataset_conservative_gb']} GB with a {int(a.haircut * 100)}% heap haircut)")
    print(f"tiered 16K/zstd-3 + 128K/zstd-9: {out['tiered_gb']} GB "
          f"({out['tiered_conservative_gb']} GB conservative)")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
