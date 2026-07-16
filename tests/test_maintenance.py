"""
Tests for maintenance.py — the in-app backup scheduler (#526).
Pure helpers only; subprocess/DB paths are exercised on the live stack.
"""

import time

import maintenance
from maintenance import (
    BACKUP_INTERVAL_DAYS,
    backup_dir,
    backup_due,
    latest_backup_age_days,
)


def _cfg(schedule="daily", dir_=None):
    return {"backups": {"schedule": schedule, "dir": dir_ or "backups", "keep_days": 4}}


class TestBackupDue:
    def setup_method(self):
        maintenance._next_backup_attempt_monotonic = 0.0

    def test_off_never_due(self, tmp_path):
        assert backup_due(_cfg("off", str(tmp_path))) is False

    def test_due_when_no_backup_exists(self, tmp_path):
        assert backup_due(_cfg("daily", str(tmp_path))) is True

    def test_not_due_when_fresh(self, tmp_path):
        (tmp_path / "meshinfo-pg-x.dump").write_bytes(b"x")
        assert backup_due(_cfg("daily", str(tmp_path))) is False

    def test_due_when_stale(self, tmp_path):
        p = tmp_path / "meshinfo-pg-x.dump"
        p.write_bytes(b"x")
        stale = time.time() - 1.5 * 86400
        import os
        os.utime(p, (stale, stale))
        assert backup_due(_cfg("daily", str(tmp_path))) is True
        assert backup_due(_cfg("weekly", str(tmp_path))) is False

    def test_failure_backoff_suppresses_retry(self, tmp_path):
        maintenance._next_backup_attempt_monotonic = time.monotonic() + 100
        assert backup_due(_cfg("daily", str(tmp_path))) is False

    def test_tmp_files_ignored(self, tmp_path):
        (tmp_path / "meshinfo-pg-x.dump.tmp").write_bytes(b"x")
        assert latest_backup_age_days(tmp_path) is None

    def test_intervals_cover_all_schedules(self):
        assert set(BACKUP_INTERVAL_DAYS) == {"daily", "weekly", "monthly"}


class TestBackupDir:
    def test_relative_resolves_against_repo_root(self):
        assert backup_dir(_cfg()) == maintenance.REPO_ROOT / "backups"

    def test_absolute_passes_through(self, tmp_path):
        assert backup_dir(_cfg(dir_=str(tmp_path))) == tmp_path
