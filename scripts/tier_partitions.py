#!/usr/bin/env python3
"""
Tier the archive tables' monthly partitions between tablespaces (see ZFS.md).

Closed months of mqtt_messages and packet_receptions that are older than
[storage.tiering] cold_after_months are rebuilt on the cold tablespace (the
compressed ZFS dataset behind `meshinfo_cold`) and swapped in. Readers keep
working during the copy; only the sub-second swap at the end takes an
exclusive lock on the parent, waiting at most 2.5 s per attempt (no request
ever queues behind it for longer), retrying up to 10 times with growing
pauses and giving up at once when a writer through the parent is queued
behind the copy. storage/db/tiering.py does the work — one transaction per partition,
so a failure leaves the original untouched — and this is the operator's
front end.

`run --apply` creates the cold tablespace at [storage.tiering]
cold_tablespace_location when it does not exist yet, exactly like the hourly
job; `plan` and dry runs only report that it is missing.

    status    every monthly partition: HOT/COLD by policy, tablespace(s),
              table/index/total size, "(partial!)" when split across
              tablespaces, estimated rows
    plan      what the next scheduled cycle would move (respects
              max_partitions_per_cycle; --all / --max N look further)
    run       move partitions — a DRY RUN unless --apply is given

Examples (inside the app container, where config.toml is; elsewhere pass --dsn):

    docker compose exec meshinfo python scripts/tier_partitions.py status
    docker compose exec meshinfo python scripts/tier_partitions.py plan --all
    docker compose exec meshinfo python scripts/tier_partitions.py run           # dry run
    docker compose exec meshinfo python scripts/tier_partitions.py run --apply   # policy cap (1/cycle)
    docker compose exec meshinfo python scripts/tier_partitions.py run --apply --all --deep-verify
    docker compose exec meshinfo python scripts/tier_partitions.py run --apply --keep-original \\
        --partition mqtt_messages_2026_03 --partition packet_receptions_2026_03
    # back to the hot pool: any closed month may move to the database default tablespace
    docker compose exec meshinfo python scripts/tier_partitions.py --tablespace pg_default run --apply \\
        --partition mqtt_messages_2026_03 --partition packet_receptions_2026_03
    python scripts/tier_partitions.py --dsn postgresql://postgres:password@localhost:5432/meshinfo \\
        --json status

--cold-after-months N and --tablespace NAME override [storage.tiering] for one
invocation; --json emits a single JSON document and nothing else on stdout
(diagnostics go to stderr). The global options belong before the command but
are accepted after it as well.

The hourly scheduler in maintenance.py only runs when [storage.tiering]
enabled = true; this CLI always works regardless, so an install can be tiered
by hand (and dry-run) before the scheduler is switched on. --keep-original
leaves the detached original behind as <partition>_tiering_old for inspection:
DROP TABLE it to reclaim the space (the next move of that month refuses until
it is gone).

Exit status: 0 on success (refused and skipped partitions do not fail a run),
1 when any partition came back busy, failed or verify-failed, 2 for usage and
config errors (bad partition name, unknown tablespace, unreachable database).
Ctrl-C exits 130 and the partition in progress is rolled back; output piped
into `head` ends quietly.
"""

import argparse
import asyncio
import datetime
import errno
import json
import logging
import os
import sys
import tomllib
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlsplit, urlunsplit

import asyncpg

# Run as `python scripts/...` from the repo root or anywhere else.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage.db.tiering import (  # noqa: E402
    IDENT_RE,
    MoveResult,
    PartitionInfo,
    TieringBusy,
    TieringPolicy,
    TieringRefused,
    check_cold_filesystem,
    cold_cutoff,
    db_now,
    default_tablespace,
    dsn_from_config,
    ensure_cold_tablespace,
    human_bytes,
    is_cold,
    list_all_partitions,
    month_label,
    partition_month,
    plan,
    run_cycle,
    set_session,
    tablespace_exists,
)

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / "config.toml"
DRY_RUN_BANNER = "DRY RUN — nothing changed (add --apply)"
FAILURE_STATUSES = ("busy", "failed", "verify-failed")
EXIT_OK, EXIT_FAILED, EXIT_USAGE = 0, 1, 2


def _err(message: str) -> None:
    print(f"tier_partitions: {message}", file=sys.stderr, flush=True)


def _emit_json(doc: Any) -> None:
    print(json.dumps(doc, separators=(",", ":"), default=str))


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not an integer")
    if value < 1:
        raise argparse.ArgumentTypeError(f"{text!r} must be >= 1")
    return value


def _redact_dsn(dsn: str) -> str:
    """postgresql://user:***@host/db for messages."""
    try:
        u = urlsplit(dsn)
    except ValueError:
        return dsn
    userinfo, at, hostport = u.netloc.rpartition("@")
    if not at or ":" not in userinfo:
        return dsn
    return urlunsplit(u._replace(netloc=f"{userinfo.split(':', 1)[0]}:***@{hostport}"))


# --- Command line ---

def _add_global_options(ap: argparse.ArgumentParser, *, after_command: bool = False) -> None:
    """The global options; each command takes them too, with SUPPRESS defaults so it only overrides what was given there."""
    def default(value: Any) -> Any:
        return argparse.SUPPRESS if after_command else value

    ap.add_argument("--config", default=default(None), metavar="PATH",
                    help="config.toml with [storage.postgres] and [storage.tiering] (default: "
                         f"{str(DEFAULT_CONFIG).replace('%', '%%')}, which may be absent — then "
                         "the built-in defaults apply; an explicitly given path must exist)")
    ap.add_argument("--dsn", default=default(None), metavar="DSN",
                    help="postgresql://user:pass@host:port/db (default: built from --config)")
    ap.add_argument("--cold-after-months", type=_positive_int, default=default(None), metavar="N",
                    help="override storage.tiering.cold_after_months: months strictly before "
                         "(current month - N) are cold")
    ap.add_argument("--tablespace", default=default(None), metavar="NAME",
                    help="target tablespace (default: storage.tiering.cold_tablespace); "
                         "pg_default moves closed months back to the hot pool")
    ap.add_argument("--json", action="store_true", default=default(False),
                    help="emit one JSON document on stdout and nothing else")
    ap.add_argument("--verbose", action="store_true", default=default(False),
                    help="show the tiering library's progress log (INFO) on stderr")


def _add_cap_options(ap: argparse.ArgumentParser, verb: str) -> None:
    group = ap.add_mutually_exclusive_group()
    group.add_argument("--all", action="store_true",
                       help=f"{verb} every eligible partition (no per-cycle cap)")
    group.add_argument("--max", dest="max_partitions", type=_positive_int, metavar="N",
                       help=f"{verb} at most N partitions "
                            "(default: storage.tiering.max_partitions_per_cycle)")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tier_partitions.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    _add_global_options(ap)
    sub = ap.add_subparsers(dest="command", metavar="<command>", required=True)

    st = sub.add_parser("status", help="every monthly partition: temperature, tablespace(s), sizes")
    _add_global_options(st, after_command=True)

    pl = sub.add_parser("plan", help="what the next cycle would move")
    _add_global_options(pl, after_command=True)
    _add_cap_options(pl, "list")

    rn = sub.add_parser("run", help="move partitions (a dry run unless --apply)")
    _add_global_options(rn, after_command=True)
    rn.add_argument("--apply", action="store_true",
                    help="really move partitions; without it nothing is changed")
    _add_cap_options(rn, "move")
    rn.add_argument("--partition", action="append", default=[], metavar="NAME",
                    help="move exactly this partition (repeatable); eligibility is still enforced, "
                         "and the per-cycle cap does not apply unless --max is given")
    rn.add_argument("--keep-original", action="store_true",
                    help="keep the detached original as <partition>_tiering_old for inspection "
                         "(DROP TABLE it yourself to reclaim the space)")
    rn.add_argument("--deep-verify", action="store_true",
                    help="also compare a digest of every row between original and copy before the swap")
    return ap


# --- Output helpers ---

def _print_table(headers: Sequence[str], rows: Sequence[Sequence[str]],
                 right: Sequence[int] = ()) -> None:
    """Aligned columns two spaces apart; `right` lists the right-aligned column indexes."""
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))

    def line(row: Sequence[str]) -> str:
        cells = [f"{c:>{widths[i]}}" if i in right else f"{c:<{widths[i]}}"
                 for i, c in enumerate(row)]
        return "  ".join(cells).rstrip()

    print(line(headers))
    for row in rows:
        print(line(row))


def _current_month(now: datetime.datetime) -> datetime.date:
    return datetime.date(now.year, now.month, 1)


def _rows_estimate(p: PartitionInfo) -> str:
    """reltuples is a planner estimate; -1 means never analyzed."""
    return "?" if p.reltuples < 0 else f"{int(p.reltuples):,}"


def _tablespace_text(p: PartitionInfo) -> str:
    return "+".join(sorted(p.tablespaces()))


def _totals_line(parts: List[PartitionInfo]) -> str:
    groups: Dict[str, List[int]] = {}
    for p in parts:
        key = "split tablespaces" if p.partial() else p.tablespace
        count_bytes = groups.setdefault(key, [0, 0])
        count_bytes[0] += 1
        count_bytes[1] += p.total_bytes
    detail = "; ".join(f"{n} on {ts}: {human_bytes(b)}" for ts, (n, b) in sorted(groups.items()))
    return f"total {human_bytes(sum(p.total_bytes for p in parts))} — {detail}"


def _format_result(res: MoveResult) -> str:
    reason = res.reason
    if reason.startswith(res.partition + ": "):
        reason = reason[len(res.partition) + 2:]
    if res.status == "moved":
        detail = (f"{res.rows:,} rows, {human_bytes(res.bytes_before)} -> "
                  f"{human_bytes(res.bytes_after)}, {res.indexes} index(es), {res.seconds:.1f} s")
        if res.swap_attempts > 1:
            detail += f", {res.swap_attempts} swap attempts"
        if res.deep_verified:
            detail += ", deep-verified"
        if res.kept_original:
            detail += f"; original kept as {res.kept_original}"
    elif res.status == "dry-run":
        detail = f"{reason}: {res.rows:,} rows, {human_bytes(res.bytes_before)}, {res.indexes} index(es)"
    else:
        detail = reason
    return f"{res.status:<13} {res.partition:<27} {detail}"


# --- Commands ---

async def cmd_status(conn: asyncpg.Connection, args: argparse.Namespace, policy: TieringPolicy,
                     now: datetime.datetime) -> int:
    parts = await list_all_partitions(conn, policy.tables)
    monthly = [p for p in parts if p.is_monthly()]
    others = [p for p in parts if not p.is_monthly()]
    current = _current_month(now)
    cutoff = cold_cutoff(now, policy.cold_after_months)
    temperature = {p.name: "COLD" if is_cold(p.month, now, policy.cold_after_months) else "HOT"
                   for p in monthly}

    if args.json:
        _emit_json([dict(p.as_dict(), temperature=temperature[p.name],
                         cold=temperature[p.name] == "COLD", closed=p.month < current)
                    for p in monthly])
        return EXIT_OK

    print(f"tiering status: {len(monthly)} monthly partition(s) of {', '.join(policy.tables)}; "
          f"db clock {now:%Y-%m-%d %H:%M} UTC, current month {month_label(current)}; "
          f"cold = months before {month_label(cutoff)} (cold_after_months={policy.cold_after_months}); "
          f"cold tablespace {policy.cold_tablespace}")
    if not monthly:
        print("no monthly partitions found — is the archive partitioned yet? "
              "(scripts/migrate-mqtt-partitioning.sh)")
    else:
        rows = [[p.name, p.label(), temperature[p.name], _tablespace_text(p),
                 human_bytes(p.table_bytes), human_bytes(p.index_bytes), human_bytes(p.total_bytes),
                 _rows_estimate(p), "(partial!)" if p.partial() else ""]
                for p in monthly]
        _print_table(["PARTITION", "MONTH", "TEMP", "TABLESPACE", "TABLE", "INDEXES", "TOTAL",
                      "ROWS", "NOTE"], rows, right=(4, 5, 6, 7))
        print(_totals_line(monthly))
        print("sizes are pg_table_size / pg_indexes_size / pg_total_relation_size; "
              "rows are the planner's estimate (? = never analyzed)")
    if others:
        print(f"not shown (not monthly): {', '.join(p.name for p in others)}")
    return EXIT_OK


async def cmd_plan(conn: asyncpg.Connection, args: argparse.Namespace, policy: TieringPolicy,
                   target: str, now: datetime.datetime) -> int:
    items = await plan(conn, policy, target=target, now=now)
    cap: Optional[int] = None if args.all else (args.max_partitions or policy.max_partitions_per_cycle)
    shown = items if cap is None else items[:cap]

    if args.json:
        _emit_json([item.as_dict() for item in shown])
        return EXIT_OK

    cutoff = cold_cutoff(now, policy.cold_after_months)
    cap_text = "no cap" if cap is None else f"cap {cap} per cycle"
    print(f"tiering plan -> {target}: {len(shown)} of {len(items)} eligible partition(s), oldest first "
          f"({cap_text}; cold = months before {month_label(cutoff)})")
    if not items:
        if target == await default_tablespace(conn):
            print(f"nothing to move: every closed month is already on {target}")
        else:
            print(f"nothing to move: every cold month is already on {target}")
        return EXIT_OK
    rows = [[item.partition.name, _tablespace_text(item.partition),
             human_bytes(item.partition.total_bytes), _rows_estimate(item.partition), item.reason]
            for item in shown]
    _print_table(["PARTITION", "FROM", "TOTAL", "ROWS", "REASON"], rows, right=(2, 3))
    print(f"total {human_bytes(sum(item.partition.total_bytes for item in shown))} in {len(shown)} partition(s)")
    if len(items) > len(shown):
        print(f"{len(items) - len(shown)} more eligible beyond the cap of {cap} per cycle "
              "(--all or --max N shows them)")
    return EXIT_OK


async def cmd_run(conn: asyncpg.Connection, args: argparse.Namespace, policy: TieringPolicy,
                  target: str, now: datetime.datetime) -> int:
    only: Optional[List[str]] = list(dict.fromkeys(args.partition)) or None
    if only:
        known = {p.name for p in await list_all_partitions(conn, policy.tables)}
        missing = [name for name in only if name not in known]
        if missing:
            _err(f"unknown partition(s) {', '.join(missing)}: not attached to "
                 f"{', '.join(policy.tables)} (see `status`)")
            return EXIT_USAGE

    # A targeted run moves exactly what was named; the per-cycle cap only applies with --max.
    if args.all:
        cap: Optional[int] = 0
    elif args.max_partitions is not None:
        cap = args.max_partitions
    else:
        cap = 0 if only else None
    dry_run = not args.apply
    human = not args.json

    if human:
        if dry_run:
            print(DRY_RUN_BANNER)
        if cap is None:
            cap_text = f"cap {policy.max_partitions_per_cycle} per cycle (policy)"
        else:
            cap_text = "no cap" if cap == 0 else f"cap {cap}"
        print(f"tiering {'dry run' if dry_run else 'run'} -> {target}: "
              f"{'targeted ' + ', '.join(only) if only else 'planned, oldest first'}; {cap_text}; "
              f"deep verify {'on' if args.deep_verify else 'off'}; "
              f"keep original {'yes' if args.keep_original else 'no'}", flush=True)
        print(f"{'STATUS':<13} {'PARTITION':<27} DETAIL", flush=True)

    def on_result(res: MoveResult) -> None:
        if human:
            print(_format_result(res), flush=True)

    cycle = await run_cycle(conn, policy, target=target, only=only, dry_run=dry_run,
                            keep_original=args.keep_original, deep_verify=args.deep_verify,
                            max_partitions=cap, now=now, on_result=on_result)

    if args.json:
        _emit_json(cycle.as_dict())
    else:
        print(cycle.summary())
        for old in (r.kept_original for r in cycle.results if r.kept_original):
            print(f'original kept as {old}; reclaim with: DROP TABLE "{old}";')
        if cycle.busy:
            print("busy: another session held a conflicting lock, the cycle stopped — retry later")
        if dry_run:
            print(DRY_RUN_BANNER)
    return EXIT_FAILED if any(r.status in FAILURE_STATUSES for r in cycle.results) else EXIT_OK


# --- Entry point ---

def _load_config(path: Path) -> dict:
    """Load config.toml when it exists; a missing file means built-in defaults (the CLI also runs with just --dsn)."""
    if not path.is_file():
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def _tiering_section(config: dict) -> Optional[dict]:
    storage = config.get("storage") if isinstance(config, dict) else None
    section = storage.get("tiering") if isinstance(storage, dict) else None
    return section if isinstance(section, dict) else None


def _bad_partition_name(names: Sequence[str], tables: Sequence[str]) -> Optional[str]:
    for name in names:
        if not IDENT_RE.match(name) or not any(partition_month(name, t) for t in tables):
            return (f"bad partition name {name!r}: expected <table>_YYYY_MM with <table> one of "
                    f"{', '.join(tables)}")
    return None


async def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)

    config_path = Path(args.config) if args.config else DEFAULT_CONFIG
    if args.config and not config_path.is_file():
        _err(f"config {config_path} is not a readable file")
        return EXIT_USAGE
    try:
        config = _load_config(config_path)
    except (OSError, tomllib.TOMLDecodeError) as e:
        _err(f"cannot read config {config_path}: {e}")
        return EXIT_USAGE
    # --tablespace is this invocation's destination only: the policy keeps the
    # configured cold tablespace so the free-space guard still knows its target.
    policy = TieringPolicy.from_config(config).with_overrides(cold_after_months=args.cold_after_months)
    if args.tablespace is not None and not IDENT_RE.match(args.tablespace):
        _err(f"--tablespace {args.tablespace!r} is not a plain identifier")
        return EXIT_USAGE
    if args.tablespace == "pg_global":
        _err("--tablespace pg_global holds shared catalogs only; use the cold tablespace or pg_default")
        return EXIT_USAGE
    problems = policy.validate()
    for warning in policy.validate(raw=_tiering_section(config)):
        if warning not in problems:
            _err(f"config warning: {warning}")
    if problems:
        for problem in problems:
            _err(f"config error: {problem}")
        return EXIT_USAGE
    if args.command == "run":
        bad = _bad_partition_name(args.partition, policy.tables)
        if bad:
            _err(bad)
            return EXIT_USAGE

    target = args.tablespace or policy.cold_tablespace
    dsn = args.dsn or dsn_from_config(config)
    try:
        conn = await asyncpg.connect(dsn, command_timeout=None)
    except (OSError, ValueError, asyncpg.PostgresError, asyncpg.InterfaceError) as e:
        _err(f"cannot connect to {_redact_dsn(dsn)}: {e}")
        return EXIT_USAGE
    try:
        await set_session(conn)
        now = (await db_now(conn)).astimezone(datetime.timezone.utc)
        cold_target = target == policy.cold_tablespace
        fs_warning = None
        if cold_target and args.command != "status":
            fs_warning = check_cold_filesystem(policy)
            if fs_warning:
                _err(f"warning: {fs_warning}")
        if args.command != "status" and not await tablespace_exists(conn, target):
            if cold_target and args.command == "run" and args.apply:
                # A real run creates the tablespace like the hourly job does (not while the mount check fails).
                await ensure_cold_tablespace(conn, policy, fs_warning=fs_warning)
                _err(f"created tablespace {target} at {policy.cold_tablespace_location}")
            else:
                if cold_target and policy.cold_tablespace_location:
                    hint = (f"; `run --apply` (or the hourly job) creates it at "
                            f"{policy.cold_tablespace_location} — storage.tiering.cold_tablespace_location")
                elif cold_target:
                    hint = (" (storage.tiering.cold_tablespace_location is empty, so neither `run "
                            "--apply` nor the hourly job creates it: CREATE TABLESPACE ... LOCATION "
                            "'/var/lib/postgresql/cold'; see ZFS.md)")
                else:
                    hint = " (CREATE TABLESPACE ... LOCATION '/var/lib/postgresql/cold'; see ZFS.md)"
                _err(f"tablespace {target!r} does not exist{hint}")
                return EXIT_USAGE
        if args.command == "status":
            return await cmd_status(conn, args, policy, now)
        if args.command == "plan":
            return await cmd_plan(conn, args, policy, target, now)
        return await cmd_run(conn, args, policy, target, now)
    except TieringBusy as e:
        _err(f"busy: {e}")
        return EXIT_FAILED
    except TieringRefused as e:
        _err(f"refused: {e}")
        return EXIT_USAGE
    finally:
        await conn.close()


def _quiet_stdout() -> None:
    """stdout is a closed pipe (| head): point it at devnull so the exit-time flush cannot fail noisily."""
    try:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    except OSError:
        pass


def _main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # an exotic console code page must not kill a run
    try:
        rc = asyncio.run(main())
        sys.stdout.flush()  # surface a closed pipe here, where it is handled
        return rc
    except KeyboardInterrupt:
        _err("interrupted — the partition in progress (if any) was rolled back")
        return 130
    except BrokenPipeError:
        _quiet_stdout()
        return EXIT_OK
    except OSError as e:
        if e.errno not in (errno.EPIPE, errno.EINVAL):  # Windows reports a closed pipe as EINVAL
            raise
        _quiet_stdout()
        return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(_main())
