# Review close-out — `feature/zfs-tiered-cold-storage`

The six-lens adversarial review of 2026-11-04 (PostgreSQL semantics;
failure atomicity, concurrency and resource hygiene; policy, planning and
configuration; CLI behaviour and documentation accuracy; benchmark tooling;
test quality — every finding then judged by up to three independent skeptics:
correctness, impact, reproduction) produced 32 findings. The workflow's fix
stage was cut short, so the confirmed findings were applied by hand on
2026-11-06 and re-verified by a two-agent pass (deadlock path reproduced,
predicate scanner / constraint cloning / reloptions / guard direction checked
against PostgreSQL 18.4). This file closes the list out as of 2026-11-07,
together with the follow-up items of that date and the second-pass review of
the follow-up delta.

Status key — **APPLIED**: fixed on the branch before this close-out
(re-verified against the current tree on 2026-11-07); **FIXED-NOW**: fixed in
this close-out; **DEFERRED**: not fixed, with the reason and the trigger that
would make it worth doing; **REJECTED**: not a defect, with the reason. Votes:
`C` confirmed / `R` refuted by a skeptic, in verifier order; findings 20–27
(test-quality lens) never got verifiers — the workflow ran out of credits
there — and were judged by hand.

## The 32 findings

| # | lens | sev | where | votes | finding | status |
|---|---|---|---|---|---|---|
| 1 | policy-plan | medium | `tiering.py` move_partition | C/C/C | free-space guard also gated moves *back* to `pg_default`, so a tight or unmounted cold dataset blocked the documented escape hatch | **APPLIED** — guard only when `target == policy.cold_tablespace and target != default_ts`; pinned by the integration move-back assertion |
| 2 | policy-plan | low | `TieringPolicy.validate` | C/R/R | non-string `cold_tablespace`: two warnings, and "ignored" misstates the effect (tiering cannot run) | **FIXED-NOW** (the review had rejected it 1/3) — one warning that says tiering cannot run; the identifier check is skipped for a non-string raw value |
| 3 | policy-plan | low | `tests/test_tiering.py` | C/C/C | `plan()`/`run_cycle()` semantics pinned only by the env-gated integration file | **APPLIED** — `TestPlanSemantics`, `TestRunCycleSemantics` against a stubbed catalog |
| 4 | cli-docs | medium | `tier_partitions.py` | C/C/C | `--tablespace` was folded into `policy.cold_tablespace`, so the free-space guard fired on the move-back path | **APPLIED** — the target is separate from the policy; `--tablespace` validated, `pg_global` refused |
| 5 | cli-docs | medium | `ZFS.md` Upgrades | C/C/C | "Postgres refuses to start without the tablespace directory" is false; the real failure is silent | **APPLIED** — rewritten with the real behaviour and post-restart checks |
| 6 | cli-docs | low | `ZFS.md` major-upgrade recipe | C/C/C | `CREATE TABLESPACE` and the restore right after `up -d postgres`, no readiness wait | **APPLIED** — `up -d --wait postgres`, `pg_isready` loop |
| 7 | cli-docs | low | `migrate-postgres.sh` | C/C | on a bind-mounted ZFS install it migrated (and deleted) a stale named volume | **APPLIED** — aborts when the merged compose config binds `/var/lib/postgresql`; ZFS.md says to remove the old volume |
| 8 | cli-docs | low | `ZFS.md` refusals | C/C/C | the refusal list contradicted the move-back rule two lines later | **APPLIED** |
| 9 | cli-docs | low | `tier_partitions.py --config` | C/C/C | a missing explicit `--config` path silently fell back to the built-in defaults | **APPLIED** — exit 2 unless the path is a readable file |
| 10 | atomicity | medium | `tiering.py` `_swap`, `main.py` | C/C/C | the swap deadlocks with the node-id backfill, tiering is the victim, 40P01 unhandled, the first cycle starts next to the backfill | **APPLIED** — `DeadlockDetectedError` retried like a lock timeout, a `pg_locks` waiter probe before each attempt, the scheduler waits for `backfill_running()` |
| 11 | atomicity | medium | `main.py` maintenance_loop | C/C/C | tiering and the in-app `pg_dump` backup ran independently (every swap attempt stalled behind the dump) | **APPLIED** — mutual gating of the two single-flight tasks |
| 12 | atomicity | low | `tiering.py` post-commit | C/R/C/R/C/R † | post-commit ANALYZE and size probe without a `lock_timeout` could park the scheduler's task | **APPLIED** — `_post_move` under `POST_MOVE_LOCK_TIMEOUT`, best effort, `RESET` in `finally` |
| 13 | atomicity | low | `tiering.py` move_partition | C/C/C | a `lock_timeout` anywhere but `LOCK TABLE`/the swap was reported as `failed` with a traceback | **APPLIED** — any `LockNotAvailableError` inside the transaction is `busy` |
| 14 | atomicity | low | `ZFS.md` `--keep-original` | C/R/C | the leftover `<part>_tiering_old` blocks every later move of that month; docs only said it keeps its disk | **APPLIED** — CLI bullet and refusal list say so |
| 15 | bench-tools | medium | `synth_history.py` | C | non-contiguous `--months` spilled receptions into `packet_receptions_default` | **APPLIED** — a spill partition after every requested month |
| 16 | bench-tools | low | `synth_history.py` | C/R/C | mapreports got no `packet_receptions` rows | **APPLIED** — the lab archive now carries 6.58 M receptions (6.25 M before) |
| 17 | bench-tools | low | `zfs_estimate.py --now` | C/C/C | host-local calendar date instead of the UTC/DB clock | **APPLIED** |
| 18 | bench-tools | low | `zfs_estimate.py` pg_tblspc | C/C | an unreachable tablespace link was silently skipped, dropping every cold file | **APPLIED** — loud warning, never yielded as a relation file |
| 19 | bench-tools | low | `zfs_estimate.py --verbose` | C/C/C | silently ignored with `--json` | **APPLIED** |
| 20 | tests | high | `test_tiering_integration.py` | unverified | pre-check/cleanup claimed every `*_2025_*` object: foreign months failed every test and the cleanup dropped partitions the test never created | **APPLIED** — pre-check and cleanup scoped to the names the file creates (`_ours`) |
| 21 | tests | medium | `test_tiering.py` | unverified | no negative `clone_index_sql` case for `' WHERE '` inside a literal or expression (the `rfind` rewrite mangled such an index) | **APPLIED** — top-level predicate scanner `_predicate_offset` + `TestCloneIndexSqlPredicateDetection` |
| 22 | tests | medium | `test_tiering_integration.py` | unverified | the swap retry path (savepoint retry on `lock_timeout`, busy after the last attempt) had no test | **APPLIED** — retry-after-lock-timeout and long-holder scenarios; the stall-bound scenario was added in this close-out |
| 23 | tests | low | `test_tiering_integration.py` | unverified | the busy test could hang forever instead of failing | **APPLIED** — `asyncio.wait_for` around the calls |
| 24 | tests | low | `test_tiering.py` | unverified | `run_cycle` stop/continue/cap semantics had no behavioural test | **APPLIED** — `TestRunCycleSemantics` |
| 25 | tests | low | `test_tiering.py` | unverified | `run_tiering`'s never-raises / always-closes contract tested only for connection refused | **APPLIED** — `TestRunTieringContract` (extended in this close-out for tablespace creation and the mount warning) |
| 26 | tests | low | `test_tiering_integration.py` | unverified | refusal checks ran on *live* partitions without `dry_run` | **APPLIED** — `dry_run=True` on every live-partition call |
| 27 | tests | low | `test_tiering_integration.py` | unverified | the post-move ANALYZE was never asserted | **APPLIED** — asserts `vacuumed`, `reltuples` and `age(relfrozenxid)` |
| 28 | pg-semantics | medium | `tiering.py` `_swap` | C/C/C | DETACH deadlocks with any parent-first multi-partition writer; 40P01 not treated as busy | **APPLIED** — same fix as #10 |
| 29 | pg-semantics | medium | `tiering.py` `_swap` | C/C/C | each swap attempt queued every read and insert on the parent for up to 20 s, six times, behind any long ACCESS SHARE holder | **FIXED-NOW** — the `pg_locks` long-holder probe was applied earlier; the stall bound itself is this close-out: `lock_timeout` 2.5 s per attempt, 10 attempts, pauses 1/2/4/8/16/20 s (+ jitter); measured 2.51 s vs 5.7 s (README section 4b) |
| 30 | pg-semantics | low | `constraint_index_sql` | C/C/C | `USING INDEX TABLESPACE` after `DEFERRABLE` is a syntax error, so such a PK/UNIQUE failed every move | **APPLIED** |
| 31 | pg-semantics | low | move_partition `CREATE TABLE (LIKE …)` | C/R/C | storage parameters, comments and ownership were lost by the rebuild | **APPLIED** — `INCLUDING COMMENTS`, reloptions copied, `OWNER TO` |
| 32 | pg-semantics | low | `tiering.py` post-commit | C/R/C/R/C/R † | ANALYZE only, while ZFS.md promised `VACUUM (FREEZE, ANALYZE)` | **APPLIED** — `VACUUM (FREEZE, ANALYZE)` after the commit (a documented deviation from the brief: without it index-only scans on a rebuilt month cost a heap visit per entry and readers re-dirty the cold pages) |

† #12 and #32 point at the same line, so their six verdicts are recorded
together: three skeptics refuted them as "stale against the working tree"
because the fix had landed while they were being judged, three confirmed the
substance.

No finding is deferred or rejected: every item was either applied before this
close-out or fixed in it.

## Follow-up items (2026-11-07)

| item | what changed | verification |
|---|---|---|
| Bound the swap stall | `SWAP_LOCK_TIMEOUT` 20 s → **2.5 s** per attempt, `SWAP_ATTEMPTS` 6 → **10**, pauses 1/2/4/8/16/20 s plus up to 1 s jitter (`swap_pause_seconds`), the long-holder probe window 5 s → 3 s (just above the timeout); worst case documented in ZFS.md ("What a move does", step 5 and the paragraph after the list) | unit `TestSwapBound`; integration `test_swap_attempt_never_stalls_other_sessions_longer_than_the_lock_timeout` (a probe query queued behind the swap returns within the timeout); lab `lab-stall.sh`: longest ordinary request 2.51 s (shipped) vs 5.70 s (previous), 0 errors, digests identical |
| 51 GB double count | the 29.08 GB production figure is `pg_database_size` and already contains the indexes; the "heap + indexes / 51 GB" scope, the 17.1 GB / 10–12 GB claims and `projection-full-*.json` are withdrawn from the benchmark README, ZFS.md and the PR body; `project_production.py` now takes `--database-gb` and applies the heap ratios to the whole size (per-class split as an optional cross-check: 9.80 / 6.21 GB at 18 months) | regenerated `projection-m12/18/24.json`, `projection-m18-n3.json`, `projection-split-m18.json` |
| Reception calibration note | README "Synthetic archive": synthetic reception heap rows are 105 B against 176 B in production (about 40 % under-sized), receptions are about a third of the real database, and `scripts/zfs_estimate.py` on the live volume is the authoritative number | — |
| Operator path: mount + flip | new `[storage.tiering] cold_tablespace_location` (default `/var/lib/postgresql/cold`, the overlay's mount point; `""` = never create); `ensure_cold_tablespace()` creates the tablespace on the first enabled cycle and on `run --apply`, with actionable refusals for a missing directory (dataset not mounted), a directory not owned by the postgres user or read-only, a directory already holding a tablespace, a non-superuser role, a relative location; `check_cold_filesystem()` reads `/proc/mounts` and warns every cycle when `cold_filesystem` is not on zfs/btrfs ("months will move but not compress"); ZFS.md step 4/5, config.toml.sample, POSTGRES.md | unit `TestEnsureColdTablespace`, `TestCheckColdFilesystem`, `TestMountFstype`, `TestColdTablespaceLocation`, run_tiering contract tests; every error path exercised against PostgreSQL 18.4 (`scratchpad/lab2/check_ensure.py`: missing dir, root-owned dir, dir already a tablespace, non-superuser, relative, empty, inside a transaction, real creation twice); integration `test_cold_tablespace_creation_against_the_server` |
| UPGRADING.md | new entry "Tiered cold storage on ZFS (opt-in)": the section is off by default, restores use `pg_restore --no-tablespaces` or recreate the tablespace, link to ZFS.md | — |

## Second-pass review of the follow-up delta (2026-11-07)

<!-- SECOND-PASS:START -->
Pending: filled in from the delta review workflow.
<!-- SECOND-PASS:END -->

## Verification of this close-out

<!-- VERIFY:START -->
- `python -m pytest -q tests`: 614 passed, 33 skipped (the two new integration
  scenarios skip without the environment variables).
- `tests/test_tiering_integration.py` against a disposable PostgreSQL 18.4
  (`postgres:18`, the real schema from the lab's `schema_full.sql`; the
  `meshinfo_cold` tablespace was created by `ensure_cold_tablespace()` itself):
  15 passed.
- `ensure_cold_tablespace()` exercised on that server for every refusal
  path: missing directory, root-owned directory, relative and empty
  location, a directory already holding a tablespace, a non-superuser role,
  inside a transaction; then the real creation, twice (second call: exists).
- CLI: `plan` and a dry `run` report the missing tablespace with the hint and
  exit 2; `run --apply` creates it and continues; `--json` stdout stays pure
  JSON (the creation line goes to stderr).
- pyflakes clean on every changed Python file; `bash -n` on the shell
  scripts; `docker compose -f docker-compose.yml -f docker-compose.zfs.yml
  config` parses.
- Lab (`lab/lab-stall.sh`, README section 4b): shipped constants — longest
  ordinary request 2.51 s, none over 3 s, 0 errors in 11,260 requests, 12
  partitions moved, digests identical; previous constants — 5.70 s, 8 over
  3 s.
- Every intermediate commit of this close-out is pyflakes-clean and green on
  the unit suite (the per-concern split was rehearsed in a scratch worktree
  before it was committed).
<!-- VERIFY:END -->
