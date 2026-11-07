#!/usr/bin/env python3
"""Run scripts/tier_partitions.py with other swap constants, for A/B
measurements of the swap stall bound (lab-stall.sh):

    python3 tier_with_constants.py --swap-lock-timeout 20s --swap-attempts 6 \
        --long-holder-seconds 5 --old-pauses -- --dsn ... run --apply --all

Everything after `--` goes to the CLI unchanged. --old-pauses restores the
pre-follow-up pause of min(5, attempt) seconds between attempts.
"""
import argparse
import importlib.util
import os
import re
import sys
from pathlib import Path

REPO = Path(os.environ.get("REPO", "/repo"))
sys.path.insert(0, str(REPO))

import storage.db.tiering as tiering  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--swap-lock-timeout", default=None)
    ap.add_argument("--swap-attempts", type=int, default=None)
    ap.add_argument("--long-holder-seconds", type=float, default=None)
    ap.add_argument("--old-pauses", action="store_true")
    ap.add_argument("cli", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    if a.swap_lock_timeout:
        secs = tiering.timeout_seconds(a.swap_lock_timeout)  # ValueError on garbage
        if not re.search(r"[a-zA-Z]", a.swap_lock_timeout):
            ap.error(f"--swap-lock-timeout {a.swap_lock_timeout!r} has no unit: PostgreSQL reads a bare "
                     f"number as milliseconds ({secs:g} s); write e.g. 20s or 2500ms")
        tiering.SWAP_LOCK_TIMEOUT = a.swap_lock_timeout
    if a.swap_attempts:
        tiering.SWAP_ATTEMPTS = a.swap_attempts
    if a.long_holder_seconds is not None:
        tiering.LONG_HOLDER_SECONDS = a.long_holder_seconds
    if a.old_pauses:
        tiering.swap_pause_seconds = lambda attempt, jitter=None: float(min(5, attempt))
    print(f"tier_with_constants: SWAP_LOCK_TIMEOUT={tiering.SWAP_LOCK_TIMEOUT} "
          f"({tiering.timeout_seconds(tiering.SWAP_LOCK_TIMEOUT):g} s) SWAP_ATTEMPTS={tiering.SWAP_ATTEMPTS} "
          f"LONG_HOLDER_SECONDS={tiering.LONG_HOLDER_SECONDS} old_pauses={a.old_pauses}", file=sys.stderr)
    spec = importlib.util.spec_from_file_location("tier_partitions", REPO / "scripts" / "tier_partitions.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    argv = a.cli[1:] if a.cli[:1] == ["--"] else a.cli
    sys.argv = ["tier_partitions.py", *argv]
    return module._main()


if __name__ == "__main__":
    raise SystemExit(main())
