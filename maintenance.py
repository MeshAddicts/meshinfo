#!/usr/bin/env python3
"""
In-app scheduled maintenance (#526): pg_dump snapshot backups driven by
config.toml's [backups] section.

main.maintenance_loop enforces the schedule, so a config change takes effect
on the next restart — no host cron required. scripts/backup_db.sh remains the
host-side alternative (and the only path that pushes to remote_target, since
SSH keys live on the host). One-time compaction of pre-dedup history is a
separate manual step: scripts/compact_mqtt_partitions.py.
"""

import asyncio
import datetime
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent
BACKUP_GLOB = "meshinfo-pg-*.dump"
BACKUP_INTERVAL_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}

# Failure backoff so a broken pg_dump doesn't retry every maintenance tick.
_next_backup_attempt_monotonic = 0.0


def backup_dir(config: Dict[str, Any]) -> Path:
    d = Path(config.get("backups", {}).get("dir") or "backups")
    return d if d.is_absolute() else REPO_ROOT / d


def latest_backup_age_days(dir_path: Path, now: Optional[float] = None) -> Optional[float]:
    """Age in days of the newest finished dump, or None if there is none."""
    now = time.time() if now is None else now
    mtimes = [p.stat().st_mtime for p in dir_path.glob(BACKUP_GLOB) if p.is_file()]
    if not mtimes:
        return None
    return (now - max(mtimes)) / 86400.0


def backup_due(config: Dict[str, Any], now: Optional[float] = None) -> bool:
    interval = BACKUP_INTERVAL_DAYS.get(config.get("backups", {}).get("schedule", "off"))
    if not interval:
        return False
    if time.monotonic() < _next_backup_attempt_monotonic:
        return False
    age = latest_backup_age_days(backup_dir(config), now)
    return age is None or age >= interval


async def run_backup(config: Dict[str, Any]) -> Optional[Path]:
    """One pg_dump -Fc snapshot: dump, validate, promote, prune. Returns the
    written path, or None on failure (with a 1h retry backoff)."""
    global _next_backup_attempt_monotonic
    _next_backup_attempt_monotonic = time.monotonic() + 3600

    pg = config.get("storage", {}).get("postgres", {})
    out_dir = backup_dir(config)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = out_dir / f"meshinfo-pg-{stamp}.dump"
    tmp = out.with_suffix(".dump.tmp")

    async def run(*cmd: str) -> int:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            env={**os.environ, "PGPASSWORD": str(pg.get("password", ""))},
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            logger.error("Backup step %s failed (rc %s): %s",
                         cmd[0], proc.returncode, err.decode(errors="replace").strip())
        return proc.returncode

    try:
        rc = await run(
            "pg_dump",
            "-h", str(pg.get("host", "postgres")),
            "-p", str(pg.get("port", 5432)),
            "-U", str(pg.get("username", "postgres")),
            "-Fc", "--no-owner", "--no-privileges",
            "-f", str(tmp),
            str(pg.get("database", "meshinfo")),
        )
        # pg_restore --list proves the archive is readable before we trust it.
        if rc == 0:
            rc = await run("pg_restore", "--list", str(tmp))
        if rc != 0:
            tmp.unlink(missing_ok=True)
            return None
        tmp.rename(out)
    except FileNotFoundError as e:
        logger.error("Backup skipped: %s not available in this image", e.filename)
        tmp.unlink(missing_ok=True)
        return None

    size_mb = out.stat().st_size / 1e6
    logger.info("Backup ok: %s (%.0f MB)", out, size_mb)

    keep_days = float(config.get("backups", {}).get("keep_days", 4))
    cutoff = time.time() - keep_days * 86400
    for p in list(out_dir.glob(BACKUP_GLOB)) + list(out_dir.glob(BACKUP_GLOB + ".tmp")):
        if p != out and p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)
            logger.info("Pruned old backup %s", p.name)

    if config.get("backups", {}).get("remote_target"):
        logger.info("remote_target is set — off-box pushes are done by "
                    "scripts/backup_db.sh on the host (SSH keys live there)")
    return out
