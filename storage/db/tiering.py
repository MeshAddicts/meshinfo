"""
Tiered cold storage for the partitioned archive tables (see ZFS.md).

Closed monthly partitions of mqtt_messages / packet_receptions are relocated
between tablespaces (hot pool <-> compressed cold pool) by rebuilding each
partition as a new table on the target tablespace and swapping it in:

    SET LOCAL lock_timeout / statement_timeout / default_tablespace
    LOCK TABLE <part> IN SHARE MODE            -- readers continue, writers wait
    CREATE TABLE <part>_tiering (LIKE <part> ...) TABLESPACE <target>
    INSERT INTO <part>_tiering SELECT * FROM <part>
    <clone every index onto the target tablespace under scratch names>
    <transient range CHECK so ATTACH can skip its validation scan>
    <count and optional deep-hash verification>
    DETACH <part>; rename the original and its indexes aside; rename the copy
    and its indexes into place; ATTACH with the original bound; drop the
    CHECK; drop the original (unless keep_original) — retried under a
    SAVEPOINT whenever the swap hits lock_timeout or a deadlock, and skipped
    while pg_locks shows a certain deadlock or a long-standing holder of the
    parent (so requests never queue behind a hopeless ACCESS EXCLUSIVE)
    COMMIT; then VACUUM (FREEZE, ANALYZE) <part> outside the transaction

`ALTER TABLE ... SET TABLESPACE` would hold ACCESS EXCLUSIVE for the whole
rewrite; this dance needs it only for the sub-second swap at the end. One
transaction per partition: any failure rolls back and leaves the original
untouched. Everything that talks to the catalog lives here — maintenance.py
(scheduler) and scripts/tier_partitions.py (CLI) are thin callers.

Connections must be dedicated `asyncpg.connect(..., command_timeout=None)`
sessions (the app pool's 10 s command timeout would kill the copy); call
`set_session()` once per connection so partition-bound text is stable.
"""

import asyncio
import dataclasses
import datetime
import hashlib
import logging
import os
import re
import shutil
import time
from collections import Counter
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import quote as _url_quote

import asyncpg

logger = logging.getLogger(__name__)

TIERABLE_TABLES = ("mqtt_messages", "packet_receptions")  # canonical order (mqtt first)
IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")  # plain, unquoted-safe identifier
MAX_IDENT = 63
SCRATCH_SUFFIX = "_tiering"  # replacement table / cloned index scratch names
OLD_SUFFIX = "_tiering_old"  # detached original (kept only with keep_original)
RANGE_SUFFIX = "_tiering_range"  # transient CHECK on the replacement
SWAP_ATTEMPTS = 6
COPY_LOCK_TIMEOUT = "5s"
SWAP_LOCK_TIMEOUT = "20s"
POST_MOVE_LOCK_TIMEOUT = "30s"  # VACUUM (FREEZE, ANALYZE) after the swap is best effort

UTC = datetime.timezone.utc

# Exactly the predicate PostgresStorage._backfill_mqtt_node_ids updates: rows with
# non-JSON payloads keep from_node_id NULL forever and must NOT count as pending.
BACKFILL_PENDING_PREDICATE = r"from_node_id IS NULL AND payload IS NOT NULL AND payload ~ '^\s*\{'"

MoveStatus = str  # "moved" | "dry-run" | "skipped" | "refused" | "busy" | "verify-failed" | "failed"


class TieringError(Exception):
    """Base class for tiering failures."""


class TieringRefused(TieringError):
    """A precondition was not met; nothing was changed."""


class TieringBusy(TieringRefused):
    """lock_timeout hit (sqlstate 55P03); nothing was changed — retry later."""


class TieringVerifyError(TieringError):
    """Row count / digest mismatch between original and copy; transaction rolled back."""


# ----------------------------------------------------------------------------
# Pure helpers (no I/O)
# ----------------------------------------------------------------------------

def quote_ident(name: str) -> str:
    """Double-quote an SQL identifier, doubling embedded double quotes."""
    return '"' + str(name).replace('"', '""') + '"'


def quote_literal(text: str) -> str:
    """Single-quote an SQL string literal, doubling embedded single quotes."""
    return "'" + str(text).replace("'", "''") + "'"


def safe_name(base: str, suffix: str) -> str:
    """base + suffix when that fits PostgreSQL's 63-byte identifier limit;
    otherwise a truncated base plus a 4-hex sha1 tag so distinct long bases
    (e.g. two 59-char per-partition index names) never collapse onto the same
    silently-truncated scratch name."""
    if len(base) + len(suffix) <= MAX_IDENT:
        return base + suffix
    keep = MAX_IDENT - len(suffix) - 5
    digest = hashlib.sha1(base.encode("utf-8")).hexdigest()[:4]
    return f"{base[:keep]}_{digest}{suffix}"


_MONTH_SUFFIX_RE = re.compile(r"^(\d{4})_(\d{2})$")


def partition_month(name: str, table: str) -> Optional[datetime.date]:
    """'<table>_YYYY_MM' -> date(YYYY, MM, 1); anything else -> None."""
    if not isinstance(name, str) or not isinstance(table, str):
        return None
    prefix = table + "_"
    if not name.startswith(prefix):
        return None
    m = _MONTH_SUFFIX_RE.match(name[len(prefix):])
    if not m:
        return None
    year, month = int(m.group(1)), int(m.group(2))
    if not 1 <= month <= 12:
        return None
    try:
        return datetime.date(year, month, 1)
    except ValueError:
        return None


def add_months(month: datetime.date, n: int) -> datetime.date:
    """First-of-month arithmetic; n may be negative."""
    total = month.year * 12 + (month.month - 1) + int(n)
    return datetime.date(total // 12, total % 12 + 1, 1)


def month_bounds(month: datetime.date) -> Tuple[datetime.datetime, datetime.datetime]:
    """Half-open [lo, hi) aware-UTC bounds of month."""
    start = month.replace(day=1)
    lo = datetime.datetime(start.year, start.month, 1, tzinfo=UTC)
    nxt = add_months(start, 1)
    hi = datetime.datetime(nxt.year, nxt.month, 1, tzinfo=UTC)
    return lo, hi


def month_label(month: datetime.date) -> str:
    """date(2026, 7, 1) -> '2026_07' (the partition-name suffix)."""
    return f"{month.year:04d}_{month.month:02d}"


def _month_of(now: Any) -> datetime.date:
    """First day of now's month; aware datetimes are read in UTC."""
    if isinstance(now, datetime.datetime):
        if now.tzinfo is not None:
            now = now.astimezone(UTC)
        return datetime.date(now.year, now.month, 1)
    if isinstance(now, datetime.date):
        return now.replace(day=1)
    raise TypeError(f"now must be a date or datetime, not {type(now).__name__}")


def cold_cutoff(now: Any, cold_after_months: int) -> datetime.date:
    """First day of (now's month - max(1, cold_after_months)); months STRICTLY
    before it are cold. (2026-11-03, 3) -> 2026-08-01: July cold, August hot."""
    try:
        n = int(cold_after_months)
    except (TypeError, ValueError):
        n = 1
    return add_months(_month_of(now), -max(1, n))


def is_cold(month: datetime.date, now: Any, cold_after_months: int) -> bool:
    """True when month lies strictly before cold_cutoff(now, cold_after_months)."""
    return month.replace(day=1) < cold_cutoff(now, cold_after_months)


_BOUND_RE = re.compile(
    r"^\s*FOR\s+VALUES\s+FROM\s*\(\s*(?:TIMESTAMPTZ\s+)?'([^']*)'\s*\)\s*"
    r"TO\s*\(\s*(?:TIMESTAMPTZ\s+)?'([^']*)'\s*\)\s*$",
    re.IGNORECASE,
)
_TS_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})"
    r"(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6})\d*)?)?)?"
    r"\s*(Z|[+-]\d{2}(?::?\d{2})?)?$",
    re.IGNORECASE,
)


def _parse_timestamp(text: str) -> Optional[datetime.datetime]:
    """'2025-01-01 00:00:00+00' / '+00:00' / 'Z' / fractional seconds -> aware UTC."""
    m = _TS_RE.match(text.strip())
    if not m:
        return None
    year, mon, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    hour = int(m.group(4) or 0)
    minute = int(m.group(5) or 0)
    second = int(m.group(6) or 0)
    micro = int((m.group(7) or "0").ljust(6, "0"))
    tz_text = m.group(8)
    offset = datetime.timedelta(0)
    if tz_text and tz_text.upper() != "Z":
        sign = -1 if tz_text[0] == "-" else 1
        digits = tz_text[1:].replace(":", "")
        hours = int(digits[:2])
        minutes = int(digits[2:4]) if len(digits) >= 4 else 0
        offset = sign * datetime.timedelta(hours=hours, minutes=minutes)
    try:
        local = datetime.datetime(year, mon, day, hour, minute, second, micro, tzinfo=UTC)
    except ValueError:
        return None
    return local - offset


def parse_bounds(bound_expr: str) -> Optional[Tuple[datetime.datetime, datetime.datetime]]:
    """pg_get_expr(relpartbound) text -> (lo, hi) aware UTC datetimes.
    'DEFAULT', MINVALUE/MAXVALUE bounds and anything unparsable -> None."""
    if not isinstance(bound_expr, str):
        return None
    m = _BOUND_RE.match(bound_expr)
    if not m:
        return None
    lo = _parse_timestamp(m.group(1))
    hi = _parse_timestamp(m.group(2))
    if lo is None or hi is None:
        return None
    return lo, hi


_INDEXDEF_RE = re.compile(r"^CREATE (UNIQUE )?INDEX (\S+) ON (\S+) (USING .+)$", re.DOTALL)


def _predicate_offset(rest: str) -> int:
    """Offset of the top-level ` WHERE ` (the partial-index predicate) in the
    tail of a pg_get_indexdef definition, or -1. Skips anything inside
    parentheses, single-quoted literals and double-quoted identifiers, so a
    ' WHERE ' inside an index expression or a literal is never mistaken for
    the predicate."""
    depth = 0
    i = 0
    n = len(rest)
    while i < n:
        ch = rest[i]
        if ch == "'":
            j = rest.find("'", i + 1)
            while j != -1 and j + 1 < n and rest[j + 1] == "'":  # doubled quote inside a literal
                j = rest.find("'", j + 2)
            i = n if j == -1 else j + 1
            continue
        if ch == '"':
            j = rest.find('"', i + 1)
            while j != -1 and j + 1 < n and rest[j + 1] == '"':
                j = rest.find('"', j + 2)
            i = n if j == -1 else j + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and rest.startswith(" WHERE ", i):
            return i
        i += 1
    return -1


def clone_index_sql(indexdef: str, *, new_index: str, new_table: str, tablespace: str) -> str:
    """Rewrite pg_get_indexdef output for a clone: new (quoted) index name, new
    (unqualified, quoted) table, and TABLESPACE inserted before the trailing
    WHERE predicate (grammar order) or appended. UNIQUE, USING, the column
    list and INCLUDE/WITH clauses are kept verbatim."""
    m = _INDEXDEF_RE.match(indexdef.strip())
    if not m:
        raise ValueError(f"unrecognised index definition: {indexdef!r}")
    unique, _old_index, _old_table, rest = m.groups()
    ts_clause = f" TABLESPACE {quote_ident(tablespace)}"
    pos = _predicate_offset(rest)
    if pos >= 0:
        rest = rest[:pos] + ts_clause + rest[pos:]
    else:
        rest = rest + ts_clause
    return f"CREATE {unique or ''}INDEX {quote_ident(new_index)} ON {quote_ident(new_table)} {rest}"


_CONSTRAINT_CHARACTERISTICS_RE = re.compile(
    r"\s(?:NOT\s+DEFERRABLE|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|NOT\s+VALID|NO\s+INHERIT)\b"
)


def constraint_index_sql(table: str, conname: str, condef: str, tablespace: str) -> str:
    """ADD CONSTRAINT for a PK/UNIQUE constraint whose backing index lands on
    tablespace. USING INDEX TABLESPACE must precede the constraint
    characteristics (DEFERRABLE / INITIALLY ...) in the grammar, so a
    pg_get_constraintdef that carries them is split there."""
    m = _CONSTRAINT_CHARACTERISTICS_RE.search(condef)
    head, tail = (condef[:m.start()], condef[m.start():]) if m else (condef, "")
    return (
        f"ALTER TABLE {quote_ident(table)} ADD CONSTRAINT {quote_ident(conname)} "
        f"{head} USING INDEX TABLESPACE {quote_ident(tablespace)}{tail}"
    )


def _ts_literal(dt: datetime.datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S+00")


def range_check_sql(table: str, conname: str, lo: datetime.datetime, hi: datetime.datetime) -> str:
    """CHECK (created_at in [lo, hi)) so ATTACH PARTITION skips its validation scan."""
    return (
        f"ALTER TABLE {quote_ident(table)} ADD CONSTRAINT {quote_ident(conname)} "
        f"CHECK (created_at >= TIMESTAMPTZ '{_ts_literal(lo)}' "
        f"AND created_at < TIMESTAMPTZ '{_ts_literal(hi)}')"
    )


def _pg_section(config: dict) -> dict:
    try:
        pg = config.get("storage", {}).get("postgres", {})
    except AttributeError:
        pg = {}
    return pg if isinstance(pg, dict) else {}


def _port(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 5432


def connect_kwargs(config: dict) -> dict:
    """asyncpg.connect(**kwargs) for a dedicated maintenance session: no command
    timeout (the app pool's 10 s would kill the copy), 30 s connect timeout."""
    pg = _pg_section(config)
    return {
        "host": str(pg.get("host", "postgres")),
        "port": _port(pg.get("port", 5432)),
        "user": str(pg.get("username", "postgres")),
        "password": str(pg.get("password", "password")),
        "database": str(pg.get("database", "meshinfo")),
        "command_timeout": None,
        "timeout": 30,
    }


def dsn_from_config(config: dict) -> str:
    """postgresql://user:pass@host:port/db from [storage.postgres] (user/pass URL-quoted)."""
    pg = _pg_section(config)
    user = _url_quote(str(pg.get("username", "postgres")), safe="")
    password = _url_quote(str(pg.get("password", "password")), safe="")
    return (
        f"postgresql://{user}:{password}@{pg.get('host', 'postgres')}:"
        f"{_port(pg.get('port', 5432))}/{pg.get('database', 'meshinfo')}"
    )


def human_bytes(n: int) -> str:
    """'1.29 GB' style (SI units, 2 decimals); whole bytes below 1 kB."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n)
    sign = "-" if n < 0 else ""
    value = float(abs(n))
    if value < 1000:
        return f"{sign}{int(value)} B"
    for unit in ("kB", "MB", "GB", "TB", "PB", "EB"):
        value /= 1000.0
        if value < 1000 or unit == "EB":
            return f"{sign}{value:.2f} {unit}"
    return f"{sign}{value:.2f} EB"  # unreachable; keeps the type checker calm


# ----------------------------------------------------------------------------
# Policy ([storage.tiering] in config.toml)
# ----------------------------------------------------------------------------

def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclasses.dataclass(frozen=True)
class TieringPolicy:
    enabled: bool = False
    cold_after_months: int = 3
    cold_tablespace: str = "meshinfo_cold"
    tables: Tuple[str, ...] = TIERABLE_TABLES
    max_partitions_per_cycle: int = 1
    cold_filesystem: str = ""
    min_free_mb: int = 2048

    @classmethod
    def from_config(cls, config: dict) -> "TieringPolicy":
        """Build from config["storage"]["tiering"] (missing -> defaults), coercing
        every value defensively. Never raises; validate(raw=...) reports what
        was ignored or clamped."""
        section: Any = {}
        try:
            if isinstance(config, dict):
                storage = config.get("storage", {})
                if isinstance(storage, dict):
                    section = storage.get("tiering", {})
        except Exception:
            section = {}
        if not isinstance(section, dict):
            section = {}

        enabled = section.get("enabled", cls.enabled)
        enabled = enabled if isinstance(enabled, bool) else False

        cold_after = section.get("cold_after_months", cls.cold_after_months)
        cold_after = max(1, cold_after) if _is_int(cold_after) else cls.cold_after_months

        tablespace = section.get("cold_tablespace", cls.cold_tablespace)
        tablespace = tablespace if isinstance(tablespace, str) else ""

        tables_raw = section.get("tables", list(TIERABLE_TABLES))
        if isinstance(tables_raw, (list, tuple)):
            tables = tuple(t for t in TIERABLE_TABLES if t in tables_raw)
        else:
            tables = TIERABLE_TABLES

        per_cycle = section.get("max_partitions_per_cycle", cls.max_partitions_per_cycle)
        per_cycle = per_cycle if _is_int(per_cycle) and per_cycle >= 1 else 1

        cold_fs = section.get("cold_filesystem", cls.cold_filesystem)
        cold_fs = cold_fs if isinstance(cold_fs, str) else ""

        min_free = section.get("min_free_mb", cls.min_free_mb)
        min_free = min_free if _is_int(min_free) and min_free >= 0 else cls.min_free_mb

        return cls(
            enabled=enabled,
            cold_after_months=cold_after,
            cold_tablespace=tablespace,
            tables=tables,
            max_partitions_per_cycle=per_cycle,
            cold_filesystem=cold_fs,
            min_free_mb=min_free,
        )

    def validate(self, raw: Optional[dict] = None) -> List[str]:
        """Warnings (never exceptions). With the raw [storage.tiering] dict, also
        report every entry from_config ignored or clamped."""
        warnings: List[str] = []
        if not IDENT_RE.match(self.cold_tablespace or ""):
            warnings.append(
                f"storage.tiering.cold_tablespace {self.cold_tablespace!r} is not a plain "
                "identifier (lowercase letters, digits, underscore; at most 63 characters)"
            )
        if not self.tables:
            warnings.append(
                "storage.tiering.tables is empty — nothing to tier "
                f"(allowed: {', '.join(TIERABLE_TABLES)})"
            )
        if isinstance(raw, dict):
            allowed = ", ".join(TIERABLE_TABLES)
            if "enabled" in raw and not isinstance(raw["enabled"], bool):
                warnings.append(
                    f"storage.tiering.enabled must be true or false (got {raw['enabled']!r}); "
                    "tiering stays disabled"
                )
            for key, default in (
                ("cold_after_months", TieringPolicy.cold_after_months),
                ("max_partitions_per_cycle", TieringPolicy.max_partitions_per_cycle),
                ("min_free_mb", TieringPolicy.min_free_mb),
            ):
                if key in raw and not _is_int(raw[key]):
                    warnings.append(
                        f"storage.tiering.{key} must be an integer (got {raw[key]!r}); "
                        f"using {default}"
                    )
            if _is_int(raw.get("cold_after_months")) and raw["cold_after_months"] < 1:
                warnings.append(
                    f"storage.tiering.cold_after_months = {raw['cold_after_months']} clamped to 1"
                )
            if _is_int(raw.get("max_partitions_per_cycle")) and raw["max_partitions_per_cycle"] < 1:
                warnings.append(
                    f"storage.tiering.max_partitions_per_cycle = {raw['max_partitions_per_cycle']} "
                    "clamped to 1"
                )
            if _is_int(raw.get("min_free_mb")) and raw["min_free_mb"] < 0:
                warnings.append(
                    f"storage.tiering.min_free_mb = {raw['min_free_mb']} is negative; using "
                    f"{TieringPolicy.min_free_mb}"
                )
            for key in ("cold_filesystem", "cold_tablespace"):
                if key in raw and not isinstance(raw[key], str):
                    warnings.append(
                        f"storage.tiering.{key} must be a string (got {raw[key]!r}); ignored"
                    )
            tables_raw = raw.get("tables")
            if "tables" in raw and not isinstance(tables_raw, (list, tuple)):
                warnings.append(
                    f"storage.tiering.tables must be a list of table names (got {tables_raw!r}); "
                    f"using the default ({allowed})"
                )
            elif isinstance(tables_raw, (list, tuple)):
                for entry in tables_raw:
                    if entry not in TIERABLE_TABLES:
                        warnings.append(
                            f"storage.tiering.tables entry {entry!r} is not tierable "
                            f"(allowed: {allowed}); ignored"
                        )
        return warnings

    def with_overrides(self, *, cold_after_months: Optional[int] = None,
                       cold_tablespace: Optional[str] = None) -> "TieringPolicy":
        """Copy with CLI overrides applied (None = keep)."""
        changes: Dict[str, Any] = {}
        if cold_after_months is not None:
            changes["cold_after_months"] = max(1, int(cold_after_months))
        if cold_tablespace is not None:
            changes["cold_tablespace"] = str(cold_tablespace)
        return dataclasses.replace(self, **changes) if changes else self


# ----------------------------------------------------------------------------
# Catalog model and queries
# ----------------------------------------------------------------------------

@dataclasses.dataclass
class PartitionInfo:
    table: str  # parent name
    name: str  # partition relname
    oid: int
    bound: str  # verbatim pg_get_expr text (reused for ATTACH)
    month: Optional[datetime.date]  # from the name, None if not <table>_YYYY_MM
    lo: Optional[datetime.datetime]  # from parse_bounds
    hi: Optional[datetime.datetime]
    tablespace: str  # table's tablespace, default resolved to its real name
    index_tablespaces: Dict[str, str]  # index relname -> tablespace (resolved)
    table_bytes: int  # pg_table_size
    index_bytes: int  # pg_indexes_size
    total_bytes: int  # pg_total_relation_size
    reltuples: float

    def tablespaces(self) -> Set[str]:
        return {self.tablespace} | set(self.index_tablespaces.values())

    def partial(self) -> bool:
        """Split across tablespaces (an interrupted manual move, or a mixed layout)."""
        return len(self.tablespaces()) > 1

    def on_tablespace(self, ts: str) -> bool:
        return self.tablespaces() == {ts}

    def is_monthly(self) -> bool:
        """Named <table>_YYYY_MM and bounded exactly by that month."""
        return self.month is not None and (self.lo, self.hi) == month_bounds(self.month)

    def label(self) -> str:
        return month_label(self.month) if self.month is not None else self.name

    def as_dict(self) -> dict:
        """JSON-friendly view (dates -> ISO strings)."""
        return {
            "table": self.table,
            "name": self.name,
            "oid": self.oid,
            "bound": self.bound,
            "month": self.month.isoformat() if self.month is not None else None,
            "label": self.label(),
            "lo": self.lo.isoformat() if self.lo is not None else None,
            "hi": self.hi.isoformat() if self.hi is not None else None,
            "monthly": self.is_monthly(),
            "tablespace": self.tablespace,
            "index_tablespaces": dict(self.index_tablespaces),
            "tablespaces": sorted(self.tablespaces()),
            "partial": self.partial(),
            "table_bytes": self.table_bytes,
            "index_bytes": self.index_bytes,
            "total_bytes": self.total_bytes,
            "reltuples": self.reltuples,
        }


async def set_session(conn: asyncpg.Connection) -> None:
    """Pin the session to UTC so pg_get_expr(relpartbound) text is stable. Once per connection."""
    await conn.execute("SET TIME ZONE 'UTC'")


async def db_now(conn: asyncpg.Connection) -> datetime.datetime:
    """The database clock (aware)."""
    return await conn.fetchval("SELECT now()")


async def default_tablespace(conn: asyncpg.Connection) -> str:
    """Name of the current database's default tablespace (what reltablespace = 0 means)."""
    return await conn.fetchval(
        "SELECT spcname FROM pg_tablespace WHERE oid = "
        "(SELECT dattablespace FROM pg_database WHERE datname = current_database())"
    )


async def tablespace_exists(conn: asyncpg.Connection, name: str) -> bool:
    return bool(await conn.fetchval("SELECT 1 FROM pg_tablespace WHERE spcname = $1", name))


_PARTITIONS_SQL = """
SELECT c.oid::bigint AS oid, c.relname,
       pg_get_expr(c.relpartbound, c.oid) AS bound,
       ts.spcname AS tablespace,
       c.reltuples::float8 AS reltuples,
       pg_table_size(c.oid) AS table_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
WHERE i.inhparent = to_regclass($1)
ORDER BY c.relname
"""

_INDEX_TABLESPACES_SQL = """
SELECT ix.indrelid::bigint AS table_oid, ic.relname, ts.spcname AS tablespace
FROM pg_index ix
JOIN pg_class ic ON ic.oid = ix.indexrelid
LEFT JOIN pg_tablespace ts ON ts.oid = ic.reltablespace
WHERE ix.indrelid = ANY($1::oid[])
ORDER BY ic.relname
"""

# Indexes of one partition with the PK/UNIQUE constraint (if any) each one backs.
_PARTITION_INDEXES_SQL = """
SELECT ic.relname, pg_get_indexdef(ix.indexrelid) AS indexdef,
       ix.indisprimary, ix.indisunique,
       con.conname, pg_get_constraintdef(con.oid) AS condef
FROM pg_index ix
JOIN pg_class ic ON ic.oid = ix.indexrelid
LEFT JOIN pg_constraint con
       ON con.conindid = ix.indexrelid AND con.conrelid = ix.indrelid
      AND con.contype IN ('p', 'u')
WHERE ix.indrelid = $1::oid
ORDER BY ic.relname
"""


def _partition_sort_key(p: "PartitionInfo") -> tuple:
    return (p.month is None, p.month or datetime.date.max, p.name)


async def _fetch_partition_rows(conn: asyncpg.Connection, table: str) -> Tuple[list, list]:
    """Partition + index catalog rows. pg_total_relation_size() takes ACCESS SHARE,
    so a concurrent ACCESS EXCLUSIVE holder (a move's swap, a DROP) would block us
    indefinitely; outside a caller transaction we bound the wait with lock_timeout
    and surface it as TieringBusy."""
    async def run() -> Tuple[list, list]:
        parts = await conn.fetch(_PARTITIONS_SQL, table)
        oids = [int(r["oid"]) for r in parts]
        indexes = await conn.fetch(_INDEX_TABLESPACES_SQL, oids) if oids else []
        return parts, indexes

    if conn.is_in_transaction():
        return await run()
    try:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL lock_timeout = {quote_literal(COPY_LOCK_TIMEOUT)}")
            return await run()
    except asyncpg.exceptions.LockNotAvailableError as e:
        raise TieringBusy(
            f"listing partitions of {table} blocked by a concurrent lock for {COPY_LOCK_TIMEOUT}"
        ) from e


async def list_partitions(conn: asyncpg.Connection, table: str, *,
                          default_ts: Optional[str] = None) -> List[PartitionInfo]:
    """Every partition of table with resolved tablespaces and sizes; monthly ones
    first (by month), then the rest by name."""
    if default_ts is None:
        default_ts = await default_tablespace(conn)
    parts, index_rows = await _fetch_partition_rows(conn, table)
    index_ts: Dict[int, Dict[str, str]] = {}
    for r in index_rows:
        index_ts.setdefault(int(r["table_oid"]), {})[r["relname"]] = r["tablespace"] or default_ts
    out: List[PartitionInfo] = []
    for r in parts:
        bound = r["bound"] or ""
        parsed = parse_bounds(bound)
        oid = int(r["oid"])
        out.append(PartitionInfo(
            table=table,
            name=r["relname"],
            oid=oid,
            bound=bound,
            month=partition_month(r["relname"], table),
            lo=parsed[0] if parsed else None,
            hi=parsed[1] if parsed else None,
            tablespace=r["tablespace"] or default_ts,
            index_tablespaces=index_ts.get(oid, {}),
            table_bytes=int(r["table_bytes"] or 0),
            index_bytes=int(r["index_bytes"] or 0),
            total_bytes=int(r["total_bytes"] or 0),
            reltuples=float(r["reltuples"] if r["reltuples"] is not None else -1.0),
        ))
    out.sort(key=_partition_sort_key)
    return out


def _table_rank(table: str) -> int:
    return TIERABLE_TABLES.index(table) if table in TIERABLE_TABLES else len(TIERABLE_TABLES)


async def list_all_partitions(conn: asyncpg.Connection, tables: Iterable[str]) -> List[PartitionInfo]:
    """Partitions across tables, sorted by (month or date.max, canonical table order, name)."""
    default_ts = await default_tablespace(conn)
    out: List[PartitionInfo] = []
    for table in tables:
        out.extend(await list_partitions(conn, table, default_ts=default_ts))
    out.sort(key=lambda p: (p.month or datetime.date.max, _table_rank(p.table), p.name))
    return out


# ----------------------------------------------------------------------------
# Planning
# ----------------------------------------------------------------------------

@dataclasses.dataclass
class PlanItem:
    partition: PartitionInfo
    target: str
    reason: str

    def as_dict(self) -> dict:
        return {"partition": self.partition.as_dict(), "target": self.target, "reason": self.reason}


def _layout_reason(p: PartitionInfo, head: str) -> str:
    if p.partial():
        groups = Counter(p.index_tablespaces.values())
        detail = ", ".join(f"{n} index(es) on {ts}" for ts, n in sorted(groups.items()))
        return f"{head}, partial: table on {p.tablespace}, {detail}"
    return f"{head}, on {p.tablespace}"


async def plan(conn: asyncpg.Connection, policy: TieringPolicy, *, target: Optional[str] = None,
               now: Any = None, only: Optional[Iterable[str]] = None,
               limit: Optional[int] = None) -> List[PlanItem]:
    """Monthly partitions of policy.tables that a cycle would move to target
    (default policy.cold_tablespace), oldest first. A closed month may always
    move to the database default tablespace (that is how months move back);
    moving to any other tablespace requires the month to be cold by policy."""
    target = target or policy.cold_tablespace
    if now is None:
        now = await db_now(conn)
    current = _month_of(now)
    cutoff = cold_cutoff(now, policy.cold_after_months)
    default_ts = await default_tablespace(conn)
    wanted = set(only) if only is not None else None
    items: List[PlanItem] = []
    for p in await list_all_partitions(conn, policy.tables):
        if wanted is not None and p.name not in wanted:
            continue
        if not p.is_monthly() or p.month >= current or p.on_tablespace(target):
            continue
        cold = p.month < cutoff
        if target != default_ts and not cold:
            continue
        head = f"cold (< {cutoff:%Y-%m})" if cold else "closed"
        items.append(PlanItem(partition=p, target=target, reason=_layout_reason(p, head)))
    if limit is not None:
        items = items[:max(0, int(limit))]
    return items


# ----------------------------------------------------------------------------
# The move
# ----------------------------------------------------------------------------

@dataclasses.dataclass
class MoveResult:
    partition: str
    table: str
    month: Optional[datetime.date]
    target: str
    status: MoveStatus  # "moved" | "dry-run" | "skipped" | "refused" | "busy" | "verify-failed" | "failed"
    reason: str = ""
    rows: int = 0
    bytes_before: int = 0  # pg_total_relation_size
    bytes_after: int = 0
    seconds: float = 0.0
    indexes: int = 0  # indexes cloned (incl. constraint-backed)
    deep_verified: bool = False
    kept_original: Optional[str] = None  # <part>_tiering_old when keep_original
    swap_attempts: int = 0
    vacuumed: bool = False  # VACUUM (FREEZE, ANALYZE) ran after the swap (else ANALYZE only)

    def as_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["month"] = self.month.isoformat() if self.month is not None else None
        return d


def _free_bytes(path: str) -> int:
    """Free bytes for an unprivileged writer on the filesystem holding path.
    os.statvfs where it exists (Linux containers); shutil.disk_usage reports the
    same f_bavail * f_frsize figure on platforms without it."""
    statvfs = getattr(os, "statvfs", None)
    if statvfs is not None:
        st = statvfs(path)
        return int(st.f_bavail) * int(st.f_frsize)
    return int(shutil.disk_usage(path).free)


def _rows_from_tag(tag: str) -> int:
    """'INSERT 0 N' -> N."""
    try:
        return int(str(tag).split()[-1])
    except (ValueError, IndexError):
        raise TieringVerifyError(f"unexpected INSERT command tag {tag!r}")


async def _rollback_quietly(tr: Any, part: str) -> None:
    try:
        await tr.rollback()
    except Exception as e:  # the original error is what the caller sees
        logger.warning("tiering: rollback after a failed move of %s raised %s: %s",
                       part, type(e).__name__, e)


_DEADLOCK_WAITER_SQL = """
SELECT w.pid FROM pg_locks w JOIN pg_locks h ON h.pid = w.pid
WHERE w.locktype = 'relation' AND w.relation = $1::oid AND NOT w.granted
  AND h.locktype = 'relation' AND h.relation = $2::oid AND h.granted
  AND w.pid <> pg_backend_pid()
LIMIT 1
"""
_LONG_HOLDER_SQL = """
SELECT l.pid, a.xact_start, a.state, left(a.query, 60) AS query
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'relation' AND l.relation = $1::oid AND l.granted
  AND l.pid <> pg_backend_pid()
  AND a.xact_start < now() - make_interval(secs => $2)
ORDER BY a.xact_start
LIMIT 1
"""
LONG_HOLDER_SECONDS = 5.0


async def _swap_blocker(conn: asyncpg.Connection, parent_oid: int, part_oid: int) -> Optional[str]:
    """Why an ACCESS EXCLUSIVE request on the parent would be pointless right
    now, or None. (1) A session waiting for OUR partition (blocked by the SHARE
    lock) while holding a lock on the parent — e.g. the node-id backfill's
    UPDATE through the parent — makes DETACH a certain deadlock. (2) A session
    that has held a lock on the parent for a while (pg_dump, a long stats
    query, an idle-in-transaction psql) will not release it within our lock
    timeout, and every request that arrives meanwhile would queue behind us."""
    if await conn.fetchval(_DEADLOCK_WAITER_SQL, part_oid, parent_oid) is not None:
        return "a session holding the parent is waiting for this partition (would deadlock)"
    row = await conn.fetchrow(_LONG_HOLDER_SQL, parent_oid, LONG_HOLDER_SECONDS)
    if row is not None:
        return (f"pid {row['pid']} ({row['state']}) has held a lock on the parent since "
                f"{row['xact_start']:%H:%M:%S}: {row['query']!r}")
    return None


async def _swap(conn: asyncpg.Connection, *, parent: str, part: str, rep: str, old: str,
                bound: str, original_indexes: List[str], scratch_to_final: Dict[str, str],
                range_con: str, keep_original: bool, parent_oid: int, part_oid: int) -> int:
    """Detach the original, rename it (and its indexes) aside, rename the copy
    (and its indexes) into place, re-attach with the verbatim bound. Each attempt
    runs under a SAVEPOINT with a 20 s lock_timeout; lock_timeout and a deadlock
    roll the attempt back and retry. A deadlock arises when a parent-first
    writer (the node-id backfill's UPDATE through the parent) is queued on our
    SHARE lock while we ask for ACCESS EXCLUSIVE on the parent; PostgreSQL then
    aborts whichever side's deadlock_timeout check sees the cycle first —
    normally us, because the writer queued during the long copy, but a writer
    that queued within deadlock_timeout of the DETACH is aborted instead. The
    _swap_blocker probe exists to avoid both: an attempt is skipped (counted,
    slept through) while it sees such a waiter or a long-standing holder of the
    parent, so the queue of requests behind a pending ACCESS EXCLUSIVE stays
    short. Returns the number of attempts used."""
    q = quote_ident
    attempts = int(SWAP_ATTEMPTS)
    for attempt in range(1, attempts + 1):
        blocker = await _swap_blocker(conn, parent_oid, part_oid)
        if blocker is not None:
            logger.warning("tiering: swap of %s postponed (attempt %d/%d): %s",
                           part, attempt, attempts, blocker)
            if attempt >= attempts:
                raise TieringBusy(f"{part}: parent table busy after {attempts} attempts "
                                  f"({blocker}); copy discarded, original untouched")
            await asyncio.sleep(min(5, attempt))
            continue
        await conn.execute("SAVEPOINT tiering_swap")
        try:
            await conn.execute(f"SET LOCAL lock_timeout = {quote_literal(SWAP_LOCK_TIMEOUT)}")
            await conn.execute(f"ALTER TABLE {q(parent)} DETACH PARTITION {q(part)}")
            await conn.execute(f"ALTER TABLE {q(part)} RENAME TO {q(old)}")
            for idx in original_indexes:
                await conn.execute(f"ALTER INDEX {q(idx)} RENAME TO {q(safe_name(idx, OLD_SUFFIX))}")
            await conn.execute(f"ALTER TABLE {q(rep)} RENAME TO {q(part)}")
            for scratch, final in scratch_to_final.items():
                await conn.execute(f"ALTER INDEX {q(scratch)} RENAME TO {q(final)}")
            await conn.execute(f"ALTER TABLE {q(parent)} ATTACH PARTITION {q(part)} {bound}")
            await conn.execute(f"ALTER TABLE {q(part)} DROP CONSTRAINT {q(range_con)}")
            if not keep_original:
                await conn.execute(f"DROP TABLE {q(old)}")
        except (asyncpg.exceptions.LockNotAvailableError,
                asyncpg.exceptions.DeadlockDetectedError) as e:
            await conn.execute("ROLLBACK TO SAVEPOINT tiering_swap")
            why = "deadlock" if isinstance(e, asyncpg.exceptions.DeadlockDetectedError) \
                else f"lock_timeout ({SWAP_LOCK_TIMEOUT})"
            logger.warning("tiering: swap of %s hit %s on attempt %d/%d", part, why, attempt, attempts)
            if attempt >= attempts:
                raise TieringBusy(
                    f"{part}: could not complete the swap ({why}) after {attempts} attempts; "
                    f"copy discarded, original untouched"
                ) from e
            await asyncio.sleep(min(5, attempt))
            continue
        await conn.execute("RELEASE SAVEPOINT tiering_swap")
        return attempt
    raise TieringBusy(f"{part}: swap not attempted (SWAP_ATTEMPTS={attempts})")


async def _post_move(conn: asyncpg.Connection, part: str) -> Tuple[bool, int]:
    """After the commit: VACUUM (FREEZE, ANALYZE) the rebuilt partition while
    its pages are still cached, then read its new size. One sequential pass
    sets hint bits, the visibility map (index-only scans work again at once)
    and all-frozen, so readers never dirty the cold pages later and a
    copy-on-write filesystem never has to re-fragment them one 8 KiB page at
    a time (measured: the cold tablespace compressed 3.5x instead of 4.6x when
    concurrent readers set the hint bits instead). It also does what ANALYZE
    alone would. Takes SHARE UPDATE EXCLUSIVE only — readers and writers
    continue. Best effort and bounded by a lock_timeout: the move is already
    committed, so a lock timeout or error degrades to ANALYZE and then to a
    warning (autovacuum catches up eventually). Returns (vacuumed, bytes)."""
    q = quote_ident
    vacuumed = False
    bytes_after = 0
    try:
        try:
            await conn.execute(f"SET lock_timeout = {quote_literal(POST_MOVE_LOCK_TIMEOUT)}")
        except Exception as e:  # noqa: BLE001 — never fail a committed move
            logger.warning("tiering: post-move VACUUM of %s skipped (%s: %s)", part, type(e).__name__, e)
            return vacuumed, bytes_after
        try:
            await conn.execute(f"VACUUM (FREEZE, ANALYZE) {q(part)}")
            vacuumed = True
        except asyncpg.exceptions.LockNotAvailableError as e:
            # ANALYZE needs the same lock — don't queue a second time behind it.
            logger.warning("tiering: VACUUM (FREEZE, ANALYZE) of %s skipped (%s); autovacuum will "
                           "vacuum and analyze it later", part, e)
        except Exception as e:  # noqa: BLE001
            logger.warning("tiering: VACUUM (FREEZE, ANALYZE) of %s skipped (%s: %s); falling back "
                           "to ANALYZE — autovacuum will set the visibility map later",
                           part, type(e).__name__, e)
            try:
                await conn.execute(f"ANALYZE {q(part)}")
            except Exception as e2:  # noqa: BLE001
                logger.warning("tiering: ANALYZE of %s skipped (%s: %s)", part, type(e2).__name__, e2)
        try:
            bytes_after = int(await conn.fetchval(
                "SELECT pg_total_relation_size(to_regclass($1))", q(part)) or 0)
        except Exception as e:  # noqa: BLE001 — size is informational
            logger.warning("tiering: size of %s not read (%s: %s)", part, type(e).__name__, e)
    finally:
        try:
            await conn.execute("RESET lock_timeout")
        except Exception:  # noqa: BLE001 — connection may be gone; nothing to reset then
            pass
    return vacuumed, bytes_after


async def move_partition(conn: asyncpg.Connection, part: PartitionInfo, target: str, *,
                         policy: TieringPolicy, dry_run: bool = False, keep_original: bool = False,
                         deep_verify: bool = False,
                         now: Optional[datetime.datetime] = None) -> MoveResult:
    """Rebuild one closed monthly partition on tablespace target and swap it in
    (one transaction; see the module docstring). Raises TieringRefused (nothing
    changed), TieringBusy (lock_timeout; nothing changed), TieringVerifyError
    (count/digest mismatch; rolled back); any other exception also rolls back.
    Returns status "skipped" when already on target, "dry-run" when dry_run.
    The passed PartitionInfo is stale after a successful move (new oid/tablespace)."""
    started = time.monotonic()
    q = quote_ident

    def refuse(reason: str) -> None:
        logger.warning("tiering: refusing to move %s to %s: %s", part.name, target, reason)
        raise TieringRefused(f"{part.name}: {reason}")

    def finish(status: MoveStatus, **fields: Any) -> MoveResult:
        return MoveResult(partition=part.name, table=part.table, month=part.month, target=target,
                          status=status, seconds=round(time.monotonic() - started, 3), **fields)

    # ── preconditions (nothing touched) ──────────────────────────────────
    if not isinstance(target, str) or not target:
        refuse("no target tablespace given")
    if part.bound.strip().upper() == "DEFAULT":
        refuse("the DEFAULT partition is never moved")
    if not part.is_monthly():
        refuse("not a monthly partition (<table>_YYYY_MM bounded exactly by that month)")
    month: datetime.date = part.month  # type: ignore[assignment]
    if now is None:
        now = await db_now(conn)
    current = _month_of(now)
    if month >= current:
        refuse(f"month {month_label(month)} is not closed yet (current month {month_label(current)})")
    default_ts = await default_tablespace(conn)
    if target != default_ts and not is_cold(month, now, policy.cold_after_months):
        cutoff = cold_cutoff(now, policy.cold_after_months)
        refuse(f"month {month_label(month)} is not cold yet "
               f"(cold_after_months={policy.cold_after_months}: months before {cutoff:%Y-%m} are cold); "
               f"only the database default tablespace {default_ts} accepts any closed month")
    if not await tablespace_exists(conn, target):
        refuse(f"tablespace {target!r} does not exist")
    if part.on_tablespace(target):
        logger.info("tiering: %s already on %s — skipped", part.name, target)
        return finish("skipped", reason=f"already on {target}",
                      bytes_before=part.total_bytes, bytes_after=part.total_bytes)
    # The free-space guard protects the cold dataset; a move back to the
    # database default tablespace leaves it and is never guarded by it.
    if policy.cold_filesystem and target == policy.cold_tablespace and target != default_ts:
        try:
            free = _free_bytes(policy.cold_filesystem)
        except (OSError, ValueError) as e:
            refuse(f"cannot stat cold_filesystem {policy.cold_filesystem}: {e}")
        need = part.total_bytes + policy.min_free_mb * 2 ** 20
        if free < need:
            refuse(f"insufficient free space on {policy.cold_filesystem}: {human_bytes(free)} free, "
                   f"need {human_bytes(need)} ({human_bytes(part.total_bytes)} uncompressed "
                   f"+ min_free_mb {policy.min_free_mb})")

    parent = part.table
    rep = safe_name(part.name, SCRATCH_SUFFIX)
    old = safe_name(part.name, OLD_SUFFIX)
    range_con = safe_name(part.name, RANGE_SUFFIX)
    for leftover in (rep, old):
        if await conn.fetchval("SELECT to_regclass($1)", q(leftover)) is not None:
            refuse(f"leftover relation {leftover} exists — review it and DROP it first")
    if conn.is_in_transaction():
        raise TieringError("move_partition needs a connection with no open transaction")

    lo, hi = part.lo, part.hi
    tr = conn.transaction()
    await tr.start()
    try:
        await conn.execute(f"SET LOCAL lock_timeout = {quote_literal(COPY_LOCK_TIMEOUT)}")
        await conn.execute("SET LOCAL statement_timeout = 0")
        await conn.execute(f"SET LOCAL default_tablespace = {quote_literal(target)}")
        try:
            await conn.execute(f"LOCK TABLE {q(part.name)} IN SHARE MODE")
        except asyncpg.exceptions.LockNotAvailableError as e:
            logger.warning("tiering: %s is locked by another session (waited %s) — busy",
                           part.name, COPY_LOCK_TIMEOUT)
            raise TieringBusy(
                f"{part.name}: could not take a SHARE lock within {COPY_LOCK_TIMEOUT}; retry later"
            ) from e

        # A stale PartitionInfo (listed before an earlier move) would clone nothing.
        live = await conn.fetchrow(
            "SELECT c.oid::bigint AS oid, i.inhparent::bigint AS parent_oid "
            "FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
            "WHERE c.oid = to_regclass($1) AND i.inhparent = to_regclass($2)",
            q(part.name), q(parent))
        if live is None or int(live["oid"]) != part.oid:
            refuse("partition changed since it was listed (dropped, detached or already "
                   "rebuilt); list it again")
        parent_oid = live["parent_oid"]

        if part.table == "mqtt_messages":
            pending = await conn.fetchval(
                f"SELECT 1 FROM {q(part.name)} WHERE {BACKFILL_PENDING_PREDICATE} LIMIT 1")
            if pending is not None:
                refuse("node-id backfill still pending (rows with from_node_id IS NULL and a JSON "
                       "payload); let the app's startup backfill finish first")

        indexes = await conn.fetch(_PARTITION_INDEXES_SQL, part.oid)
        src_count = int(await conn.fetchval(f"SELECT count(*) FROM {q(part.name)}"))
        bytes_before = int(await conn.fetchval("SELECT pg_total_relation_size($1::oid)", part.oid) or 0)

        if dry_run:
            await tr.rollback()
            logger.info("tiering: dry run — would move %s (%d rows, %s, %d indexes) to %s",
                        part.name, src_count, human_bytes(bytes_before), len(indexes), target)
            return finish("dry-run", reason=f"would move to {target}", rows=src_count,
                          bytes_before=bytes_before, bytes_after=bytes_before, indexes=len(indexes))

        logger.info("tiering: moving %s (%d rows, %s, %d indexes) to %s",
                    part.name, src_count, human_bytes(bytes_before), len(indexes), target)
        await conn.execute(
            f"CREATE TABLE {q(rep)} (LIKE {q(part.name)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS "
            f"INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING COMMENTS) "
            f"TABLESPACE {q(target)}")
        # LIKE copies neither storage parameters nor ownership: carry both over
        # so autovacuum settings/fillfactor and grants survive the rebuild.
        meta = await conn.fetchrow(
            "SELECT array_to_string(c.reloptions, ', ') AS reloptions, "
            "pg_get_userbyid(c.relowner) AS owner, current_user AS me "
            "FROM pg_class c WHERE c.oid = $1::oid", part.oid)
        if meta is not None and meta["reloptions"]:
            await conn.execute(f"ALTER TABLE {q(rep)} SET ({meta['reloptions']})")
        if meta is not None and meta["owner"] and meta["owner"] != meta["me"]:
            await conn.execute(f"ALTER TABLE {q(rep)} OWNER TO {q(meta['owner'])}")
        tag = await conn.execute(f"INSERT INTO {q(rep)} SELECT * FROM {q(part.name)}")
        rows_copied = _rows_from_tag(tag)

        # Clone every index under a 63-byte-safe scratch name; remember the final name.
        scratch_to_final: Dict[str, str] = {}
        original_indexes: List[str] = []
        for ix in indexes:
            original_indexes.append(ix["relname"])
            if ix["conname"]:
                scratch = safe_name(ix["conname"], SCRATCH_SUFFIX)
                await conn.execute(constraint_index_sql(rep, scratch, ix["condef"], target))
            else:
                scratch = safe_name(ix["relname"], SCRATCH_SUFFIX)
                await conn.execute(clone_index_sql(ix["indexdef"], new_index=scratch,
                                                   new_table=rep, tablespace=target))
            scratch_to_final[scratch] = ix["relname"]
        await conn.execute(range_check_sql(rep, range_con, lo, hi))

        # Verify. The SHARE lock pins the source, so its count cannot have moved.
        rep_count = int(await conn.fetchval(f"SELECT count(*) FROM {q(rep)}"))
        if not (src_count == rows_copied == rep_count):
            logger.error("tiering: verify failed for %s: source %d rows, copied %d, replacement %d",
                         part.name, src_count, rows_copied, rep_count)
            raise TieringVerifyError(
                f"{part.name}: row count mismatch (source {src_count}, copied {rows_copied}, "
                f"replacement {rep_count}); rolled back")
        if deep_verify:
            digest_sql = "SELECT sum(hashtextextended(t::text, 0)) FROM {} t"
            src_digest = await conn.fetchval(digest_sql.format(q(part.name)))
            rep_digest = await conn.fetchval(digest_sql.format(q(rep)))
            if src_digest != rep_digest:
                logger.error("tiering: deep verify failed for %s: digest %s vs %s",
                             part.name, src_digest, rep_digest)
                raise TieringVerifyError(
                    f"{part.name}: row digest mismatch between original and copy; rolled back")

        swap_attempts = await _swap(
            conn, parent=parent, part=part.name, rep=rep, old=old, bound=part.bound,
            original_indexes=original_indexes, scratch_to_final=scratch_to_final,
            range_con=range_con, keep_original=keep_original,
            parent_oid=int(parent_oid), part_oid=int(part.oid))
    except asyncpg.exceptions.LockNotAvailableError as e:
        # Any other lock_timeout inside the transaction (e.g. the CLI and the
        # scheduler racing for the same month) is "busy", not a failure.
        await _rollback_quietly(tr, part.name)
        logger.warning("tiering: %s: lock_timeout while building the copy — busy", part.name)
        raise TieringBusy(f"{part.name}: lock_timeout ({COPY_LOCK_TIMEOUT}) while building the "
                          f"copy; retry later") from e
    except BaseException:
        await _rollback_quietly(tr, part.name)
        raise
    else:
        await tr.commit()

    # ── outside the transaction ──────────────────────────────────────────
    vacuumed, bytes_after = await _post_move(conn, part.name)
    result = finish("moved", reason=f"moved to {target}", rows=src_count,
                    bytes_before=bytes_before, bytes_after=bytes_after, indexes=len(indexes),
                    deep_verified=bool(deep_verify), kept_original=old if keep_original else None,
                    swap_attempts=swap_attempts, vacuumed=vacuumed)
    logger.info("tiering: moved %s to %s: %d rows, %s -> %s, %d indexes, %.1fs (swap attempts %d)%s",
                part.name, target, src_count, human_bytes(bytes_before), human_bytes(bytes_after),
                len(indexes), result.seconds, swap_attempts,
                f"; original kept as {old}" if keep_original else "")
    return result


# ----------------------------------------------------------------------------
# Cycle
# ----------------------------------------------------------------------------

@dataclasses.dataclass
class CycleResult:
    results: List[MoveResult]
    target: str
    dry_run: bool

    def _count(self, *statuses: str) -> int:
        return sum(1 for r in self.results if r.status in statuses)

    @property
    def moved(self) -> int:
        return self._count("moved")

    @property
    def planned(self) -> int:
        """Dry-run results ("would move")."""
        return self._count("dry-run")

    @property
    def skipped(self) -> int:
        return self._count("skipped")

    @property
    def refused(self) -> int:
        return self._count("refused")

    @property
    def busy(self) -> int:
        return self._count("busy")

    @property
    def failed(self) -> int:
        """Hard failures: "failed" and "verify-failed"."""
        return self._count("failed", "verify-failed")

    def as_dict(self) -> dict:
        return {
            "target": self.target,
            "dry_run": self.dry_run,
            "moved": self.moved,
            "planned": self.planned,
            "skipped": self.skipped,
            "refused": self.refused,
            "busy": self.busy,
            "failed": self.failed,
            "results": [r.as_dict() for r in self.results],
        }

    def summary(self) -> str:
        kind = "tiering dry run" if self.dry_run else "tiering cycle"
        if not self.results:
            return f"{kind} -> {self.target}: nothing to do"
        done = [r for r in self.results if r.status in ("moved", "dry-run")]
        rows = sum(r.rows for r in done)
        before = sum(r.bytes_before for r in done)
        after = sum(r.bytes_after for r in done)
        if self.dry_run:
            head = f"{self.planned} would move ({rows} rows, {human_bytes(before)})"
        else:
            head = f"{self.moved} moved ({rows} rows, {human_bytes(before)} -> {human_bytes(after)})"
        return (f"{kind} -> {self.target}: {head}, {self.skipped} skipped, {self.refused} refused, "
                f"{self.busy} busy, {self.failed} failed")


def _unmoved(part: PartitionInfo, target: str, status: MoveStatus, reason: str) -> MoveResult:
    return MoveResult(partition=part.name, table=part.table, month=part.month, target=target,
                      status=status, reason=reason, bytes_before=part.total_bytes)


async def run_cycle(conn: asyncpg.Connection, policy: TieringPolicy, *, target: Optional[str] = None,
                    only: Optional[Iterable[str]] = None, dry_run: bool = False,
                    keep_original: bool = False, deep_verify: bool = False,
                    max_partitions: Optional[int] = None, now: Any = None,
                    on_result: Optional[Callable[[MoveResult], None]] = None) -> CycleResult:
    """One tiering pass. Targeted (`only` = partition names) or planned (oldest
    eligible first). Only "moved"/"dry-run" count toward max_partitions (None =
    policy.max_partitions_per_cycle, 0 = unlimited). Busy, verify failures and
    unexpected errors stop the cycle; refusals are recorded and skipped over."""
    await set_session(conn)
    problems = policy.validate()
    if problems:
        raise TieringRefused("tiering policy is invalid: " + "; ".join(problems))
    target = target or policy.cold_tablespace
    if not isinstance(target, str) or not target:
        raise TieringRefused("no target tablespace")
    cap: Optional[int] = policy.max_partitions_per_cycle if max_partitions is None else int(max_partitions)
    if cap is not None and cap <= 0:
        cap = None
    if now is None:
        now = await db_now(conn)

    queue: List[Tuple[str, Optional[PartitionInfo]]] = []
    if only is not None:
        by_name = {p.name: p for p in await list_all_partitions(conn, policy.tables)}
        for name in dict.fromkeys(only):
            queue.append((name, by_name.get(name)))
    else:
        for item in await plan(conn, policy, target=target, now=now):
            queue.append((item.partition.name, item.partition))

    cycle = CycleResult(results=[], target=target, dry_run=dry_run)
    logger.info("tiering: %s -> %s: %d candidate(s), cap %s",
                "dry run" if dry_run else "cycle", target, len(queue), cap or "none")
    done = 0
    for name, part in queue:
        if cap is not None and done >= cap:
            break
        stop = False
        if part is None:
            table = next((t for t in policy.tables if name.startswith(t + "_")), "")
            reason = f"not a partition of {', '.join(policy.tables) or 'any tierable table'}"
            logger.warning("tiering: %s: %s", name, reason)
            res = MoveResult(partition=name, table=table, month=None, target=target,
                             status="refused", reason=reason)
        else:
            try:
                res = await move_partition(conn, part, target, policy=policy, dry_run=dry_run,
                                           keep_original=keep_original, deep_verify=deep_verify,
                                           now=now)
            except TieringBusy as e:
                res = _unmoved(part, target, "busy", str(e))
                stop = True
            except TieringRefused as e:
                res = _unmoved(part, target, "refused", str(e))
            except TieringVerifyError as e:
                res = _unmoved(part, target, "verify-failed", str(e))
                stop = True
            except Exception as e:
                logger.exception("tiering: moving %s to %s failed", part.name, target)
                res = _unmoved(part, target, "failed", f"{type(e).__name__}: {e}")
                stop = True
        cycle.results.append(res)
        if on_result is not None:
            on_result(res)
        if res.status in ("moved", "dry-run"):
            done += 1
        if stop:
            break
    return cycle
