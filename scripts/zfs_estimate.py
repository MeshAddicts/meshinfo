#!/usr/bin/env python3
"""
Estimate what ZFS would store for a PostgreSQL data directory — without ZFS.

Before committing to the tiered ZFS layout described in ZFS.md (hot dataset
16K/zstd-3, cold dataset 128K/zstd-9) you want numbers from YOUR data, not from
a blog post. This script reads the real relation files of a cluster and models
how ZFS would lay them out for every requested (compression, recordsize)
combination, with the real codecs, so the ratios are what `zfs get
compressratio` would report after the move (within the simplifications below).

Two subcommands, because the catalog lives in the database while the files
live on disk, and those are often reachable from different places:

    # 1. anywhere that reaches the database (uses asyncpg when importable,
    #    otherwise `psql` on PATH — the postgres image ships psql):
    python scripts/zfs_estimate.py dump-catalog \\
        --dsn postgresql://postgres:password@postgres:5432/meshinfo > catalog.json

    # 2. anywhere the data directory is readable (the host, against the
    #    Docker volume's _data directory — usually as root — or a container
    #    that has python3). Only the standard library is required; lz4 and
    #    zstd need `pip install lz4` / `pip install zstandard`, gzip needs
    #    nothing:
    python3 scripts/zfs_estimate.py estimate \\
        --pgdata "$(docker volume inspect -f '{{.Mountpoint}}' meshinfo_meshinfo_pgdata)" \\
        --catalog catalog.json --codec lz4 zstd-3 zstd-9 --recordsize 16K 128K \\
        --hot zstd-3@16K --cold zstd-9@128K --cold-after-months 1 --sample 4

The model
---------
* A file is split into logical records of --recordsize bytes (8K, 16K, 32K,
  64K or 128K). A file smaller than one record is a single record of its own
  length; a multi-record file has every record `recordsize` long, the tail
  zero-padded (ZFS does the same, and the padding compresses away).
* Every record is compressed with the real codec: lz4 (lz4.block, as ZFS's
  LZ4 — plus its 4-byte length header), zstd-N (python-zstandard level N, plus
  ZFS's 8-byte zstd header), gzip-N (zlib level N). ZFS keeps the compressed
  buffer only when it saves at least 12.5 % (psize <= lsize - lsize // 8),
  otherwise the record is stored raw. The physical size rounds UP to 4 KiB
  (ashift=12). An all-zero record is a hole and costs nothing. `off` models
  compression=off (no compression, and no hole detection either).
* --sample K compresses every K-th record of every file and scales the
  result; use it on multi-GB clusters. K=1 (default) is exact.
* Each file is read once in 128 KiB chunks and every requested recordsize is
  evaluated from the same chunk (all supported recordsizes divide 128 KiB).

Not modelled (keep in mind when reading the numbers):
* ZFS's zstd early-abort (it tries LZ4 first and gives up on data LZ4 cannot
  shrink) — the estimate is slightly OPTIMISTIC for incompressible data,
  where real ZFS stores raw a few records this model would compress a little.
* Embedded block pointers (records that compress below ~112 bytes are stored
  inside the pointer at zero cost), indirect blocks, metadata, copies,
  snapshots and the ZIL — the estimate is slightly PESSIMISTIC for near-empty
  records and ignores everything that is not relation data.
* "logical" here is the apparent file size (what `du --apparent-size` says),
  so the ratio differs from `zfs get compressratio` only by the zero padding
  of the last record of each file.

Only relation files are visited (base/, global/, pg_tblspc/ — main fork
segments `<filenode>`, `<filenode>.1`, ... and the `_fsm`, `_vm`, `_init`
forks, reported as class "fsm/vm"). WAL, temp files and the rest of the data
directory are not part of the estimate.

Classification uses the catalog dump: heap, toast, btree, gin, gist, hash and
other (sequences, materialized-view data, spgist/brin, ...) by relkind and
access method; files whose filenode is not in the catalog (another database,
dropped relations, a catalog dumped from a different cluster) are "unknown".

The tiered projection (--hot/--cold) applies the cold setting to every file
of a partition whose month is cold under the tiering rule (first day of the
month `cold_after_months` months before `--now`; months strictly before it are
cold — reimplemented here so the script runs standalone), including the
partition's indexes and TOAST relations, and the hot setting to everything
else.

The catalog is a JSON mapping pg_relation_filepath -> {relname, relkind,
amname, nspname, parent, table, month}. `parent` is the pg_inherits parent
(the parent table for a partition, the partitioned index for an index on a
partition), the owning table for a TOAST table and the TOAST table for its
index; `table` is the heap relation the file ultimately belongs to and
`month` ("YYYY-MM-01") is set for every relation hanging off an
mqtt_messages_YYYY_MM / packet_receptions_YYYY_MM partition.

Runs on Python 3.9+ with the standard library only (plus the optional codec
packages), so it can be copied into any container or host that holds the data
directory.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

CHUNK = 128 * 1024          # read unit; every supported recordsize divides it
SECTOR = 4096               # ashift=12: physical sizes round up to this
RECORDSIZES = {"8K": 8192, "16K": 16384, "32K": 32768, "64K": 65536, "128K": 131072}
LZ4_HEADER = 4              # ZFS stores the compressed length in front of an lz4 block
ZSTD_HEADER = 8             # ZFS stores compressed length + version/level in front of a zstd frame
TIERABLE_TABLES = ("mqtt_messages", "packet_receptions")
CLASSES = ("heap", "toast", "btree", "gin", "gist", "hash", "other", "fsm/vm", "unknown")
TIERS = ("hot", "cold")
FILE_RE = re.compile(r"^(\d+)(?:_(fsm|vm|init))?(?:\.(\d+))?$")
CODEC_RE = re.compile(r"^(lz4|zstd|gzip|off)(?:-(\d{1,2}))?$")

CATALOG_SQL = """
SELECT json_agg(row_to_json(t)) FROM (
    SELECT c.oid::bigint AS oid,
           c.relname,
           c.relkind::text AS relkind,
           am.amname,
           n.nspname,
           pg_relation_filepath(c.oid) AS path,
           c.reltoastrelid::bigint AS toast_oid,
           (SELECT i.inhparent FROM pg_inherits i WHERE i.inhrelid = c.oid
             ORDER BY i.inhseqno LIMIT 1)::bigint AS parent_oid,
           (SELECT ix.indrelid FROM pg_index ix WHERE ix.indexrelid = c.oid)::bigint AS table_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_am am ON am.oid = c.relam
    WHERE c.relkind IN ('r', 'i', 'S', 't', 'm', 'p', 'I')
    ORDER BY c.oid
) t
"""


class UsageError(Exception):
    """Bad arguments or environment; reported on stderr, exit code 2."""


# --- Tiering rule (local copy: this script must not import storage.db.tiering) ---

def partition_month(name: str, table: str) -> Optional[datetime.date]:
    """`<table>_YYYY_MM` -> date(YYYY, MM, 1); anything else -> None."""
    m = re.match(r"^" + re.escape(table) + r"_(\d{4})_(\d{2})$", name)
    if not m:
        return None
    year, month = int(m.group(1)), int(m.group(2))
    if not 1 <= month <= 12:
        return None
    return datetime.date(year, month, 1)


def cold_cutoff(now: datetime.date, cold_after_months: int) -> datetime.date:
    """First day of (now's month - max(1, cold_after_months)); months strictly before it are cold."""
    idx = now.year * 12 + (now.month - 1) - max(1, cold_after_months)
    return datetime.date(idx // 12, idx % 12 + 1, 1)


def is_cold(month: datetime.date, now: datetime.date, cold_after_months: int) -> bool:
    return month < cold_cutoff(now, cold_after_months)


def human_bytes(n: int) -> str:
    """'1.29 GB' style (SI, 2 decimals)."""
    value = float(n)
    unit = "B"
    for unit in ("B", "kB", "MB", "GB", "TB", "PB"):
        if abs(value) < 1000 or unit == "PB":
            break
        value /= 1000
    return f"{n} B" if unit == "B" else f"{value:.2f} {unit}"


# --- Codecs and the per-record ZFS model ---

class Codec:
    """One value of the ZFS `compression` property; compressed_size() includes ZFS's per-block header (None for `off`)."""

    def __init__(self, label: str, fn: Optional[Callable[[bytes], int]]):
        self.label = label
        self.fn = fn

    def compressed_size(self, record: bytes) -> Optional[int]:
        return None if self.fn is None else self.fn(record)


def make_codec(spec: str) -> Codec:
    """Build a Codec from 'lz4', 'zstd[-N]' (default 3), 'gzip[-N]' (default 6) or 'off'."""
    m = CODEC_RE.match(spec.strip().lower())
    if not m:
        raise UsageError(f"unknown codec {spec!r} (expected lz4, zstd-N, gzip-N or off)")
    name, level_text = m.group(1), m.group(2)
    if name == "off":
        if level_text is not None:
            raise UsageError("codec 'off' takes no level")
        return Codec("off", None)
    if name == "lz4":
        if level_text is not None:
            raise UsageError("codec 'lz4' takes no level")
        try:
            import lz4.block  # type: ignore
        except ImportError:
            raise UsageError("codec lz4 needs the 'lz4' package: pip install lz4") from None
        compress = lz4.block.compress
        return Codec("lz4", lambda data: len(compress(data, store_size=False)) + LZ4_HEADER)
    if name == "zstd":
        level = int(level_text) if level_text is not None else 3
        if not 1 <= level <= 19:
            raise UsageError(f"zstd level must be 1..19, got {level}")
        try:
            import zstandard  # type: ignore
        except ImportError:
            raise UsageError("codec zstd needs the 'zstandard' package: pip install zstandard") from None
        cctx = zstandard.ZstdCompressor(level=level)
        return Codec(f"zstd-{level}", lambda data: len(cctx.compress(data)) + ZSTD_HEADER)
    level = int(level_text) if level_text is not None else 6
    if not 1 <= level <= 9:
        raise UsageError(f"gzip level must be 1..9, got {level}")
    return Codec(f"gzip-{level}", lambda data: len(zlib.compress(data, level)))


def parse_recordsize(text: str) -> int:
    """'16K' / '16k' / '16384' -> 16384; only the ZFS sizes that divide 128 KiB are accepted."""
    t = text.strip().upper()
    if t in RECORDSIZES:
        return RECORDSIZES[t]
    if t.isdigit() and int(t) in RECORDSIZES.values():
        return int(t)
    raise UsageError(f"unsupported recordsize {text!r} (use one of {', '.join(RECORDSIZES)})")


def recordsize_label(rs: int) -> str:
    return f"{rs // 1024}K"


def parse_setting(text: str) -> Tuple[str, int]:
    """'zstd-3@16K' -> ('zstd-3', 16384) (codec label canonicalised)."""
    if "@" not in text:
        raise UsageError(f"setting {text!r} must look like codec@recordsize, e.g. zstd-3@16K")
    codec_text, rs_text = text.split("@", 1)
    return make_codec(codec_text).label, parse_recordsize(rs_text)


_ZEROS: Dict[int, bytes] = {}


def _zeros(n: int) -> bytes:
    z = _ZEROS.get(n)
    if z is None:
        z = _ZEROS[n] = bytes(n)
    return z


def _roundup(n: int) -> int:
    return (n + SECTOR - 1) // SECTOR * SECTOR


def model_record(codec: Codec, record: bytes, is_hole: bool) -> Tuple[int, str]:
    """Physical bytes ZFS allocates for one logical record and why ('hole', 'compressed', 'raw')."""
    lsize = len(record)
    if codec.fn is None:
        return _roundup(lsize), "raw"
    if is_hole:
        return 0, "hole"
    psize = codec.fn(record)
    if psize <= lsize - lsize // 8:
        return _roundup(psize), "compressed"
    return _roundup(lsize), "raw"


# --- Accounting ---

class Tally:
    """Byte and record counters for one bucket (a class, a tier, a total)."""

    __slots__ = ("files", "logical", "physical", "records", "sampled", "holes", "compressed", "raw")

    def __init__(self) -> None:
        self.files = 0
        self.logical = 0
        self.physical = 0
        self.records = 0
        self.sampled = 0
        self.holes = 0
        self.compressed = 0
        self.raw = 0

    def add(self, other: "Tally") -> None:
        for slot in self.__slots__:
            setattr(self, slot, getattr(self, slot) + getattr(other, slot))

    @property
    def ratio(self) -> Optional[float]:
        return (self.logical / self.physical) if self.physical else None

    def as_dict(self) -> Dict[str, Any]:
        d = {slot: getattr(self, slot) for slot in self.__slots__}
        d["ratio"] = round(self.ratio, 3) if self.ratio is not None else None
        return d


def _chunk_needed(chunk_index: int, per_chunk: int, sample: int, total_records: int) -> bool:
    """Does chunk `chunk_index` hold a sampled record for a recordsize with `per_chunk` records per chunk?"""
    first = (-(chunk_index * per_chunk)) % sample
    return first < per_chunk and chunk_index * per_chunk + first < total_records


def estimate_file(path: Path, size: int, settings: List[Tuple[Codec, int]],
                  sample: int) -> Dict[Tuple[str, int], Tally]:
    """Model one relation file for every setting in one read; record i is compressed iff i % sample == 0, then scaled."""
    recordsizes = sorted({rs for _, rs in settings})
    by_rs: Dict[int, List[Codec]] = {rs: [c for c, r in settings if r == rs] for rs in recordsizes}
    stats = {(c.label, rs): Tally() for c, rs in settings}
    total = {rs: max(1, -(-size // rs)) for rs in recordsizes}
    for (label, rs), st in stats.items():
        st.files = 1
        st.logical = size
        st.records = total[rs]
    if size == 0:
        return stats

    chunk_index = 0
    with open(path, "rb") as f:
        while chunk_index * CHUNK < size:
            needed = [rs for rs in recordsizes
                      if _chunk_needed(chunk_index, CHUNK // rs, sample, total[rs])]
            if not needed:
                f.seek(CHUNK, os.SEEK_CUR)
                chunk_index += 1
                continue
            chunk = f.read(CHUNK)
            if not chunk:
                break
            for rs in needed:
                per_chunk = CHUNK // rs
                base = chunk_index * per_chunk
                padded = total[rs] > 1
                for j in range(per_chunk):
                    off = j * rs
                    if off >= len(chunk):
                        break
                    if (base + j) % sample:
                        continue
                    rec = chunk[off:off + rs]
                    if padded and len(rec) < rs:
                        rec = rec + _zeros(rs - len(rec))
                    is_hole = rec == _zeros(len(rec))
                    for codec in by_rs[rs]:
                        st = stats[(codec.label, rs)]
                        phys, kind = model_record(codec, rec, is_hole)
                        st.sampled += 1
                        st.physical += phys
                        if kind == "hole":
                            st.holes += 1
                        elif kind == "compressed":
                            st.compressed += 1
                        else:
                            st.raw += 1
            chunk_index += 1
            if len(chunk) < CHUNK:
                break

    if sample > 1:
        for st in stats.values():
            if st.sampled:
                st.physical = int(round(st.physical * st.records / st.sampled))
    return stats


# --- Catalog ---

def classify(entry: Optional[Dict[str, Any]], fork: str) -> str:
    """Storage class of a file from its catalog entry and fork name."""
    if fork != "main":
        return "fsm/vm"
    if entry is None:
        return "unknown"
    relkind = entry.get("relkind")
    am = entry.get("amname")
    if relkind == "t":
        return "toast"
    if relkind in ("r", "m", "p"):
        return "heap" if am in (None, "heap") else "other"
    if relkind in ("i", "I") and am in ("btree", "gin", "gist", "hash"):
        return am
    return "other"


def load_catalog(path: Path) -> Dict[str, Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise UsageError(f"cannot read catalog {path}: {e}")
    if not isinstance(data, dict):
        raise UsageError(f"catalog {path} is not a JSON object (run dump-catalog)")
    return data


def build_catalog(rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Turn the pg_class rows of CATALOG_SQL into the filepath -> entry mapping."""
    by_oid = {int(r["oid"]): r for r in rows}
    toast_owner = {int(r["toast_oid"]): int(r["oid"]) for r in rows if r.get("toast_oid")}

    def owner(oid: int, depth: int = 0) -> Dict[str, Any]:
        """The heap relation a file ultimately belongs to (index -> table, toast -> owner)."""
        r = by_oid[oid]
        if depth < 8:
            if r["relkind"] in ("i", "I") and r.get("table_oid") in by_oid:
                return owner(int(r["table_oid"]), depth + 1)
            if r["relkind"] == "t" and oid in toast_owner:
                return owner(toast_owner[oid], depth + 1)
        return r

    def relname(oid: Optional[int]) -> Optional[str]:
        r = by_oid.get(int(oid)) if oid else None
        return r["relname"] if r else None

    catalog: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        path = r.get("path")
        if not path:
            continue
        oid = int(r["oid"])
        if r["relkind"] == "t":
            parent = relname(toast_owner.get(oid))
        elif r.get("parent_oid"):
            parent = relname(r["parent_oid"])
        elif r["relkind"] == "i" and r.get("table_oid") in by_oid \
                and by_oid[int(r["table_oid"])]["relkind"] == "t":
            parent = relname(r["table_oid"])
        else:
            parent = None
        own = owner(oid)
        month = None
        own_parent = relname(own.get("parent_oid"))
        if own_parent in TIERABLE_TABLES:
            d = partition_month(own["relname"], own_parent)
            month = d.isoformat() if d else None
        catalog[path] = {
            "relname": r["relname"],
            "relkind": r["relkind"],
            "amname": r.get("amname"),
            "nspname": r["nspname"],
            "parent": parent,
            "table": own["relname"],
            "month": month,
        }
    return catalog


def _load_asyncpg() -> Any:
    try:
        import asyncpg  # type: ignore
    except ImportError:
        return None
    return asyncpg


def fetch_catalog_rows(dsn: str) -> List[Dict[str, Any]]:
    """Run CATALOG_SQL through asyncpg when importable, else through `psql` on PATH."""
    asyncpg = _load_asyncpg()
    if asyncpg is not None:
        import asyncio

        async def run() -> Optional[str]:
            conn = await asyncpg.connect(dsn)
            try:
                return await conn.fetchval(CATALOG_SQL)
            finally:
                await conn.close()

        text = asyncio.run(run())
    else:
        psql = shutil.which("psql")
        if psql is None:
            raise UsageError("dump-catalog needs the 'asyncpg' package (pip install asyncpg) or psql on PATH")
        proc = subprocess.run(
            [psql, dsn, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
            input=CATALOG_SQL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
        )
        if proc.returncode != 0:
            raise UsageError(f"psql failed: {proc.stderr.strip()}")
        text = proc.stdout
    if not text or not text.strip():
        return []
    rows = json.loads(text)
    return rows if isinstance(rows, list) else []


# --- The walk ---

def relation_files(pgdata: Path) -> Iterator[Tuple[str, str, int, Path]]:
    """Yield (catalog key, fork, segment, path) per relation file; the key is the main fork's pg_relation_filepath form."""
    for top in ("base", "global", "pg_tblspc"):
        root = pgdata / top
        if not root.is_dir():
            continue
        if top == "pg_tblspc":
            # Each entry is a symlink to a tablespace directory; an unreachable target (a
            # host-side run against the Docker volume) would silently drop every cold file.
            for link in sorted(root.iterdir()):
                if link.is_symlink() and not link.is_dir():
                    try:
                        dest = os.readlink(link)
                    except OSError:
                        dest = "?"
                    print(f"WARNING: tablespace link {link} -> {dest} is not reachable; its files "
                          f"are NOT counted (run inside the container or bind-mount the cold "
                          f"directory at that path)", file=sys.stderr)
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            dirnames.sort()
            rel = Path(dirpath).relative_to(pgdata).as_posix()
            for fn in sorted(filenames):
                m = FILE_RE.match(fn)
                if not m:
                    continue
                yield f"{rel}/{m.group(1)}", m.group(2) or "main", int(m.group(3) or 0), Path(dirpath) / fn


class Report:
    """Aggregated results: settings -> tier -> class -> Tally, plus the tiered projection."""

    def __init__(self, settings: List[Tuple[Codec, int]]):
        self.settings = settings
        self.keys = [(c.label, rs) for c, rs in settings]
        self.buckets: Dict[Tuple[str, int], Dict[str, Dict[str, Tally]]] = {
            key: {tier: {cls: Tally() for cls in CLASSES} for tier in TIERS} for key in self.keys
        }
        self.files = 0
        self.logical = 0
        self.unknown_files = 0

    def add_file(self, stats: Dict[Tuple[str, int], Tally], tier: str, cls: str) -> None:
        self.files += 1
        self.logical += next(iter(stats.values())).logical
        if cls == "unknown":
            self.unknown_files += 1
        for key, st in stats.items():
            self.buckets[key][tier][cls].add(st)

    def total(self, key: Tuple[str, int], tier: Optional[str] = None,
              cls: Optional[str] = None) -> Tally:
        t = Tally()
        for tr in (TIERS if tier is None else (tier,)):
            for cl in (CLASSES if cls is None else (cls,)):
                t.add(self.buckets[key][tr][cl])
        return t

    def tiered(self, hot: Tuple[str, int], cold: Tuple[str, int]) -> Dict[str, Dict[str, Tally]]:
        """tier -> class -> Tally with the hot setting on hot files and the cold setting on cold files."""
        return {"hot": self.buckets[hot]["hot"], "cold": self.buckets[cold]["cold"]}


def _tier_dict(by_class: Dict[str, Tally]) -> Dict[str, Any]:
    total = Tally()
    for t in by_class.values():
        total.add(t)
    d = total.as_dict()
    d["classes"] = {cls: t.as_dict() for cls, t in by_class.items() if t.files}
    return d


def report_json(report: Report, args: argparse.Namespace, meta: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = dict(meta)
    out["files"] = report.files
    out["logical"] = report.logical
    out["unknown_files"] = report.unknown_files
    settings = []
    for key in report.keys:
        d = report.total(key).as_dict()
        d["codec"] = key[0]
        d["recordsize"] = key[1]
        d["classes"] = {cls: report.total(key, cls=cls).as_dict()
                        for cls in CLASSES if report.total(key, cls=cls).files}
        d["tiers"] = {tier: _tier_dict(report.buckets[key][tier]) for tier in TIERS}
        settings.append(d)
    out["settings"] = settings
    tiered = None
    if args.hot:
        by_tier = report.tiered(args.hot, args.cold)
        total = Tally()
        classes = {cls: Tally() for cls in CLASSES}
        for by_class in by_tier.values():
            for cls, t in by_class.items():
                total.add(t)
                classes[cls].add(t)
        tiered = total.as_dict()
        tiered["hot"] = {"codec": args.hot[0], "recordsize": args.hot[1]}
        tiered["cold"] = {"codec": args.cold[0], "recordsize": args.cold[1]}
        tiered["classes"] = {cls: t.as_dict() for cls, t in classes.items() if t.files}
        tiered["tiers"] = {tier: _tier_dict(by_class) for tier, by_class in by_tier.items()}
        tiered["all_hot_physical"] = report.total(args.hot).physical
        tiered["all_cold_physical"] = report.total(args.cold).physical
    out["tiered"] = tiered
    return out


def _ratio_text(t: Tally) -> str:
    return f"{t.ratio:.2f}x" if t.ratio is not None else "-"


def _pct(part: int, whole: int) -> str:
    return f"{100.0 * part / whole:5.1f}" if whole else "    -"


LABEL_WIDTH = 12


def _row(label: str, t: Tally) -> str:
    return (f"  {label:<{LABEL_WIDTH}} {t.files:>7} {human_bytes(t.logical):>12} {human_bytes(t.physical):>12} "
            f"{_ratio_text(t):>8} {_pct(t.holes, t.sampled)} {_pct(t.compressed, t.sampled)} "
            f"{_pct(t.raw, t.sampled)}")


def _header(label: str) -> str:
    return (f"  {label:<{LABEL_WIDTH}} {'files':>7} {'logical':>12} {'physical':>12} {'ratio':>8} "
            f"{'hole%':>5} {'comp%':>5} {' raw%':>5}")


def print_human(report: Report, args: argparse.Namespace, meta: Dict[str, Any]) -> None:
    print(f"ZFS estimate for {meta['pgdata']}")
    print(f"  catalog: {meta['catalog']} ({meta['catalog_entries']} relations, "
          f"{meta['catalog_missing']} without a file on disk)")
    print(f"  files: {report.files} relation files, {human_bytes(report.logical)} logical "
          f"({report.logical} bytes), {report.unknown_files} not in the catalog; "
          f"sample: every {args.sample}{'st' if args.sample == 1 else 'th'} record")
    print(f"  tiering clock: now {meta['now']}, cold_after_months {meta['cold_after_months']} "
          f"-> months before {meta['cold_cutoff'][:7]} are cold")
    for key in report.keys:
        print()
        print(f"== {key[0]} @ {recordsize_label(key[1])} ==")
        print(_header("class"))
        for cls in CLASSES:
            t = report.total(key, cls=cls)
            if t.files:
                print(_row(cls, t))
        print(_row("TOTAL", report.total(key)))
        hot, cold = report.total(key, tier="hot"), report.total(key, tier="cold")
        if cold.files:
            print(f"  (hot files: {human_bytes(hot.logical)} -> {human_bytes(hot.physical)}; "
                  f"cold months: {human_bytes(cold.logical)} -> {human_bytes(cold.physical)})")
    if not args.hot:
        return
    hot_label = f"{args.hot[0]}@{recordsize_label(args.hot[1])}"
    cold_label = f"{args.cold[0]}@{recordsize_label(args.cold[1])}"
    print()
    print(f"== Tiered projection: hot {hot_label}, cold {cold_label} ==")
    print(_header("tier/class"))
    by_tier = report.tiered(args.hot, args.cold)
    total = Tally()
    for tier in TIERS:
        tier_total = Tally()
        for cls in CLASSES:
            t = by_tier[tier][cls]
            if t.files:
                print(_row(f"{tier} {cls}", t))
                tier_total.add(t)
        print(_row(f"{tier.upper()}", tier_total))
        total.add(tier_total)
    print(_row("TOTAL", total))
    all_hot = report.total(args.hot).physical
    all_cold = report.total(args.cold).physical
    print(f"  everything on {hot_label}: {human_bytes(all_hot)}; everything on {cold_label}: "
          f"{human_bytes(all_cold)}; tiered: {human_bytes(total.physical)}")


# --- Commands ---

def cmd_dump_catalog(args: argparse.Namespace) -> int:
    catalog = build_catalog(fetch_catalog_rows(args.dsn))
    text = json.dumps(catalog, separators=(",", ":"), sort_keys=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"wrote {len(catalog)} relations to {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


def cmd_estimate(args: argparse.Namespace) -> int:
    pgdata = Path(args.pgdata)
    if not pgdata.is_dir():
        raise UsageError(f"--pgdata {args.pgdata} is not a directory")
    if not any((pgdata / top).is_dir() for top in ("base", "global", "pg_tblspc")):
        raise UsageError(f"{args.pgdata} has no base/, global/ or pg_tblspc/ directory — is it a data directory?")
    if args.sample < 1:
        raise UsageError("--sample must be >= 1")
    if bool(args.hot) != bool(args.cold):
        raise UsageError("--hot and --cold must be given together")
    catalog = load_catalog(Path(args.catalog))

    # Settings grid: --codec x --recordsize, plus whatever the tiered projection needs.
    codecs: Dict[str, Codec] = {}
    for spec in args.codec:
        c = make_codec(spec)
        codecs.setdefault(c.label, c)
    recordsizes = []
    for text in args.recordsize:
        rs = parse_recordsize(text)
        if rs not in recordsizes:
            recordsizes.append(rs)
    keys: List[Tuple[str, int]] = [(label, rs) for label in codecs for rs in recordsizes]
    if args.hot:
        args.hot = parse_setting(args.hot)
        args.cold = parse_setting(args.cold)
        for label, rs in (args.hot, args.cold):
            if label not in codecs:
                codecs[label] = make_codec(label)
            if (label, rs) not in keys:
                keys.append((label, rs))
    settings = [(codecs[label], rs) for label, rs in keys]

    # UTC, like the tiering job's cold cutoff (the DB clock is UTC).
    now = (datetime.date.fromisoformat(args.now) if args.now
           else datetime.datetime.now(datetime.timezone.utc).date())
    cutoff = cold_cutoff(now, args.cold_after_months)
    cold_months = {path: entry.get("month") for path, entry in catalog.items()}
    months_seen = set()

    report = Report(settings)
    started = time.monotonic()
    last_progress = started
    verbose = args.verbose  # the per-file listing goes to stderr; stdout JSON stays clean
    for key, fork, segment, path in relation_files(pgdata):
        entry = catalog.get(key)
        cls = classify(entry, fork)
        tier = "hot"
        month_text = cold_months.get(key)
        if month_text:
            month = datetime.date.fromisoformat(month_text)
            if month < cutoff:
                tier = "cold"
        try:
            size = path.stat().st_size
            stats = estimate_file(path, size, settings, args.sample)
        except OSError as e:
            print(f"skipping {path}: {e}", file=sys.stderr)
            continue
        months_seen.add(key)
        report.add_file(stats, tier, cls)
        if verbose:
            name = entry["relname"] if entry else "?"
            print(f"{path.relative_to(pgdata).as_posix():<40} {cls:<8} {tier:<4} {size:>12} {name}",
                  file=sys.stderr)
        elif sys.stderr.isatty() and time.monotonic() - last_progress > 5:
            last_progress = time.monotonic()
            print(f"... {report.files} files, {human_bytes(report.logical)} "
                  f"({time.monotonic() - started:.0f}s)", file=sys.stderr)

    missing = sum(1 for p in catalog if p not in months_seen)
    meta = {
        "pgdata": str(pgdata),
        "catalog": str(args.catalog),
        "catalog_entries": len(catalog),
        "catalog_missing": missing,
        "sample": args.sample,
        "now": now.isoformat(),
        "cold_after_months": args.cold_after_months,
        "cold_cutoff": cutoff.isoformat(),
        "seconds": round(time.monotonic() - started, 3),
    }
    if args.json:
        print(json.dumps(report_json(report, args, meta), separators=(",", ":")))
    else:
        print_human(report, args, meta)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", metavar="<command>")
    sub.required = True

    dc = sub.add_parser("dump-catalog", help="print the pg_relation_filepath -> relation JSON mapping")
    dc.add_argument("--dsn", required=True, help="postgresql://user:pass@host:port/db (read-only queries)")
    dc.add_argument("--out", help="write the JSON here instead of stdout")
    dc.set_defaults(func=cmd_dump_catalog)

    es = sub.add_parser("estimate", help="model ZFS storage for a data directory")
    es.add_argument("--pgdata", required=True, help="PostgreSQL data directory (readable copy is fine)")
    es.add_argument("--catalog", required=True, help="JSON from dump-catalog")
    es.add_argument("--codec", nargs="+", default=["lz4", "zstd-3"],
                    help="lz4, zstd-N, gzip-N, off (default: lz4 zstd-3)")
    es.add_argument("--recordsize", nargs="+", default=["16K", "128K"],
                    help="8K 16K 32K 64K 128K (default: 16K 128K)")
    es.add_argument("--sample", type=int, default=1, help="compress every K-th record and scale (default 1)")
    es.add_argument("--json", action="store_true", help="one compact JSON document instead of tables")
    es.add_argument("--hot", help="setting for hot files, e.g. zstd-3@16K (with --cold)")
    es.add_argument("--cold", help="setting for cold partition months, e.g. zstd-9@128K (with --hot)")
    es.add_argument("--cold-after-months", type=int, default=1,
                    help="months before the current one that stay hot (default 1, the job's default)")
    es.add_argument("--now", help="YYYY-MM-DD clock for the cold cutoff (default: today, UTC)")
    es.add_argument("--verbose", action="store_true", help="one line per file on stderr")
    es.set_defaults(func=cmd_estimate)
    return ap


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except UsageError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0


if __name__ == "__main__":
    sys.exit(main())
