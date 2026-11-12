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
| 29 | pg-semantics | medium | `tiering.py` `_swap` | C/C/C | each swap attempt queued every read and insert on the parent for up to 20 s, six times, behind any long ACCESS SHARE holder | **FIXED-NOW** — the `pg_locks` long-holder probe was applied earlier; the stall bound itself is this close-out: `lock_timeout` 2.5 s per attempt, 10 attempts, pauses 1/2/4/8/16/20 s (+ jitter); first measured at 2.51 s vs 5.7 s, re-measured after the second pass — longest wait behind a swap 0.8 s, no timeouts (README section 4b) |
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
| Bound the swap stall | `SWAP_LOCK_TIMEOUT` 20 s → **2.5 s** per attempt, `SWAP_ATTEMPTS` 6 → **10**, pauses 1/2/4/8/16/20 s plus up to 1 s jitter (`swap_pause_seconds`), the long-holder probe window 5 s → 3 s (just above the timeout); worst case documented in ZFS.md ("What a move does", step 5 and the paragraph after the list) | unit `TestSwapBound`; integration `test_swap_attempt_never_stalls_other_sessions_longer_than_the_lock_timeout` (a probe query queued behind the swap returns within the timeout); lab `lab-stall.sh`: first run (`wal_level = minimal`) longest ordinary request 2.51 s (shipped) vs 5.70 s (previous); re-run after the second pass (`wal_level = replica`, wall-clock probe): three attempts postponed, none timed out, longest wait behind a swap 0.8 s, longest request 1.87 s, the swap's own hold 33 ms; 0 errors and identical digests both times |
| 51 GB double count | the 29.08 GB production figure is `pg_database_size` and already contains the indexes; the "heap + indexes / 51 GB" scope, the 17.1 GB / 10–12 GB claims and `projection-full-*.json` are withdrawn from the benchmark README, ZFS.md and the PR body; `project_production.py` now takes `--database-gb` and applies the heap ratios to the whole size (per-class split as an optional cross-check: 9.80 / 6.21 GB at 18 months) | regenerated `projection-m12/18/24.json`, `projection-m18-n3.json`, `projection-split-m18.json` |
| Reception calibration note | README "Synthetic archive": synthetic reception heap rows are 105 B against 176 B in production (about 40 % under-sized), receptions are about a third of the real database, and `scripts/zfs_estimate.py` on the live volume is the authoritative number | — |
| Operator path: mount + flip | new `[storage.tiering] cold_tablespace_location` (default `/var/lib/postgresql/cold`, the overlay's mount point; `""` = never create); `ensure_cold_tablespace()` creates the tablespace on the first enabled cycle and on `run --apply`, with actionable refusals for a missing directory (dataset not mounted), a directory not owned by the postgres user or read-only, a directory already holding a tablespace, a non-superuser role, a relative location; `check_cold_filesystem()` reads `/proc/mounts` and warns every cycle when `cold_filesystem` is not on zfs/btrfs ("months will move but not compress"); ZFS.md step 4/5, config.toml.sample, POSTGRES.md | unit `TestEnsureColdTablespace` (every refusal path against a stub connection raising the server's errors: 58P01 missing directory, 42501 not writable, 55006 already a tablespace, 42P17 / 42602 rejected location, 42710 and 23505 created concurrently → False, non-superuser and mount-check refusals before any DDL, in-transaction → programming error, relative and empty location, the successful CREATE and its logged server warnings), `TestCheckColdFilesystem`, `TestMountFstype`, `TestColdTablespaceLocation`, run_tiering contract tests; integration `test_cold_tablespace_creation_against_the_server` (an existing tablespace left alone; a missing directory, an empty location, a failed mount check and a non-superuser role — `SET ROLE pg_read_all_data` — refused with nothing created; it does not perform a creation, since a test cannot prepare an empty postgres-owned directory inside the container); every error path and the real creation (twice) were additionally exercised by hand against PostgreSQL 18.4 with a throwaway script that is not committed (missing dir, root-owned dir, dir already a tablespace, non-superuser, relative, empty, inside a transaction) |
| UPGRADING.md | new entry "Tiered cold storage on ZFS (opt-in)": the section is off by default, restores use `pg_restore --no-tablespaces` or recreate the tablespace, link to ZFS.md | — |

## Second-pass review of the follow-up delta (2026-11-07)

<!-- SECOND-PASS:START -->
The follow-up delta (the five close-out commits: review fixes, swap bound,
operator path, docs/projection correction, upgrading notes) was reviewed by
the same six lenses — correctness, concurrency/locking, failure recovery,
security/injection, operability/docs, performance/benchmarks — with two
independent skeptics per finding, each told to refute it and to reproduce it
against a disposable PostgreSQL 18.4 (never against the lab or production).
32 raw findings, 28 after deduplication: 20 confirmed by both skeptics, 6
contested (one skeptic refuted), 2 rejected (both refuted). Votes are
skeptic 1 / skeptic 2 (C confirmed, R refuted); the rule of the brief applies
— correctness, data-safety and locking issues fixed now, cosmetic and
speculative items deferred — and every contested item turned out cheap
enough to fix rather than argue. The fixes are the commit "second-pass
review fixes", the re-measurement the commit "re-measure the stall bound".

| # | sev | where | votes | finding | status |
|---|---|---|---|---|---|
| 1 | medium | `_LONG_HOLDER_SQL` | C/C | the long-holder probe compared `xact_start` with `now()`, which is frozen at the move's BEGIN (before the copy), so a holder that began during the copy was never flagged; and `pg_stat_activity` is cached per transaction, so later probes saw the first one's view | **FIXED-NOW** — `clock_timestamp()`, and `pg_stat_clear_snapshot()` before each probe; unit guard on the SQL; integration `test_long_holder_probe_measures_on_the_wall_clock_and_watches_the_partition` (a holder that starts after the move's BEGIN is flagged once older than the window, and not before) |
| 2 | medium→low | `TieringPolicy.validate` | R/C | a relative `cold_tablespace_location` failed the bare `validate()` that `run_cycle` and every CLI command gate on, so tiering stopped even with the tablespace present, while the message spoke only of creation | **FIXED-NOW** (contested: one skeptic called it the delta's design; the cheaper behaviour is the consistent one) — the check is a config-time warning (`validate(raw=…)`) that says tiering still runs once the tablespace exists; `ensure_cold_tablespace` still refuses to create there |
| 3 | low | `ensure_cold_tablespace` | R/C | the 22023 branch was unreachable: PostgreSQL raises 42P17 for a relative or over-long location, and the unit fixture fed an error the server never sends | **FIXED-NOW** — the branch catches 42P17 `InvalidObjectDefinitionError` and 42602 `InvalidNameError` (a single quote in the location); fixtures match the server |
| 4 | low | `ensure_cold_tablespace` | R/C | the server's WARNING for a location inside the data directory was dropped (asyncpg delivers NOTICE/WARNING only to a listener) | **FIXED-NOW** — a log listener around the CREATE logs every server message at WARNING next to the "created tablespace" line; unit test |
| 5 | low | `ensure_cold_tablespace` | C/C | non-superuser vs not-writable (both 42501) was told apart by English message text, which `lc_messages` translates: a localized server told a non-superuser to chown the dataset | **FIXED-NOW** — `current_setting('is_superuser')` decides before any DDL; the 42501 handler is the directory case only, no text matching; a German-text unit case; integration `SET ROLE pg_read_all_data` |
| 6 | low | ZFS.md worst case; `move_partition` | C/C | `ATTACH PARTITION` validates a non-empty DEFAULT partition with a full scan under the parent's ACCESS EXCLUSIVE lock, which no timeout bounds; the documented bound silently assumed empty DEFAULT partitions | **FIXED-NOW** — `move_partition` refuses (before the copy) while the parent's DEFAULT partition holds rows, with the way out named; ZFS.md step 5 and the worst-case paragraph state the assumption; integration `test_refused_while_the_default_partition_holds_rows` |
| 7 | medium | `_swap` / `_swap_blocker` | C/C | `lock_timeout` applies per lock acquisition and DETACH takes ACCESS EXCLUSIVE on the parent, then the DEFAULT partition, then the partition: a holder of the partition alone (a cursor over the month, the compaction script) made every attempt hold the parent while waiting a full timeout for the partition, and the probe watched only the parent | **FIXED-NOW** — `statement_timeout = SWAP_LOCK_TIMEOUT` on the DETACH (one timeout for all three acquisitions; 57014 is retried like 55P03, a cancel request is not), the probe watches parent, DEFAULT partition and partition (`ANY($1::oid[])`); docs; the wall-clock probe above is what makes the postponement effective |
| 8 | medium | `_swap` | C/C | a writer through the parent queued on the copy's SHARE lock (the node-id backfill's UPDATE, statement_timeout 120 s) was detected — and then slept through the whole 1/2/4/8/16/20 s schedule (~2 min) while it stayed blocked, long enough to kill the backfill; it can never finish before the move's transaction ends | **FIXED-NOW** — `_swap_blocker` returns `(kind, reason)`; a "waiter" raises `TieringBusy` at once, no pause, copy discarded, the writer completes; unit `test_deadlock_waiter_gives_the_copy_up_at_once`; integration `test_deadlock_waiter_is_detected_and_released_at_once` against the real lock graph |
| 9 | low | `ensure_cold_tablespace` | C/C | two concurrent CREATE TABLESPACE (the CLI and the hourly job on first enable): the loser gets 23505 on `pg_tablespace_spcname_index`, not 42710, and was reported as a refusal although the tablespace exists | **FIXED-NOW** — `UniqueViolationError` caught, `tablespace_exists` re-checked, False returned; unit test parametrized over both errors |
| 10 | low | `ensure_cold_tablespace` | C/C | same race, reported independently | **FIXED-NOW** — same fix |
| 11 | low | `lab-stall.sh` | R/R | the reset to `pg_default` is never checked and an exit-2 run would abort the script before the move back, "leaving the lab months on the cold tablespace" | **REJECTED** — the reset precedes every leg and an exit-2 run moves nothing, so nothing is stranded; the published run was clean (both resets, both legs 12 moved / 0 busy / 0 failed) |
| 12 | low | UPGRADING.md | C/C | "either way every partition lands on `pg_default`" is false for the "create the tablespace first" path: stock dumps record the tablespace, so `pg_restore` puts the cold months straight back onto it | **FIXED-NOW** — the entry describes both paths as they are |
| 13 | medium→low | `ensure_cold_tablespace` | C/C | the localized-42501 finding, reported independently | **FIXED-NOW** — see #5 |
| 14 | low | `IDENT_RE` | C/C | `$` matches before a trailing newline, so a TOML `"meshinfo_cold\n"` passed validation and the new creation path would have created a tablespace whose name ends in a newline | **FIXED-NOW** — `\Z` (also on `_MONTH_SUFFIX_RE`); unit tests |
| 15 | low | `lab-stall.sh` | R/R | `CONFIGS` values are unvalidated; a quote in one would break the heredocs "with the harness left running" | **REJECTED** — the harness is stopped and reaped before the first heredoc, so an abort never leaves it running; `CONFIGS` is an undocumented knob, and the "old" leg's banner names its constants |
| 16 | low | `tier_with_constants.py` | R/C | a unit-less `--swap-lock-timeout` is milliseconds to PostgreSQL, so a typo would silently measure a 20 ms timeout | **FIXED-NOW** — refused without a unit; the banner prints the parsed seconds |
| 17 | medium→low | config.toml.sample | C/C | the section header still said the tablespace "must already exist", eight lines above "created by the job if missing" | **FIXED-NOW** |
| 18 | medium | `ensure_cold_tablespace`; ZFS.md step 4 | C/C | with the overlay the directory always exists (Compose creates the host path), so an unmounted cold dataset surfaced as the "not writable — chown 999:999" refusal; following that advice on the bare mountpoint would put the tablespace on the root filesystem, and the moved months would vanish once the dataset mounts over it | **FIXED-NOW** — the 42501 refusal names the unmounted case first and warns against chowning the bare directory; the docstring and ZFS.md step 4 say which line each situation produces; and, beyond the brief, `ensure_cold_tablespace(fs_warning=…)` creates nothing while `cold_filesystem` fails the zfs/btrfs check (the job and `run --apply` pass the warning through), so with the documented overlay config the dangerous creation cannot happen |
| 19 | low | UPGRADING.md | C/C | the restore-path sentence, reported independently | **FIXED-NOW** — see #12 |
| 20 | low | `setup-zfs-datasets.sh` | C/C | the printed "next steps" still told the operator to CREATE TABLESPACE by hand as step 4 | **FIXED-NOW** — step 4 is "enable the job; it creates the tablespace", with the by-hand command as the opt-out |
| 21 | low | `TieringPolicy.validate` | C/C | a non-string `cold_tablespace_location` was reported as "ignored" but coerced to `""`, the never-create mode (the same mismatch as #2 of the first pass) | **FIXED-NOW** — the warning says the job will not create the tablespace; the CLI hint names the empty location |
| 22 | low | REVIEW.md | C/C | the operator-path row cited a scratchpad script as verification and let the integration test's name suggest a real creation | **FIXED-NOW** — the cell says what the unit and integration tests cover and that the by-hand script is not committed |
| 23 | low | docker-compose.zfs.yml and four other places | C/C | `cold_filesystem` was still described as the free-space guard alone, although it also gates the hourly mount warning (and now the creation guard) | **FIXED-NOW** — overlay header, config.py, config.toml.sample, POSTGRES.md, ZFS.md |
| 24 | low | README | C/C | "section 4b" was a level-3 heading appended after section 5 | **FIXED-NOW** — moved under section 4 |
| 25 | medium | README setup, 4b; ZFS.md | C/C | the lab ran with an undocumented `wal_level = minimal`: the copy skips WAL and `COMMIT` fsyncs the rebuilt files under the parent lock, so the lab's swap held the parent ~0.8 s, not "milliseconds", and the e2e maxima were misattributed | **FIXED-NOW** — the setup table lists the lab's real settings; the bound is stated as the timeout plus the swap's hold (DETACH→COMMIT); 4b re-measured under the default `wal_level = replica` (`lab-setup.sh` now sets it) with the hold reported; the e2e paragraph corrected |
| 26 | medium→low | README 4b | C/C | the aggregate p99 (529 vs 229 ms) read as a regression but was a threshold artefact of the stalled-request population (~1 % of requests) | **FIXED-NOW** — 4b reports the stalled-request count next to p50/p99 and says why the aggregate p99 is not comparable between legs |
| 27 | low | `lab-stall.sh` | R/C | the two legs did not start from identical partitions (the first copied the generator's never-rebuilt months), so the wall times were not a controlled pair | **FIXED-NOW** — the script primes the months onto the cold tablespace once, so both legs start from just-rebuilt partitions; the README says wall times are for scale only |
| 28 | low | README projection; `project_production.py` | R/C | "conservative inflates the compressed heap by 25 %" — the headline mode inflates the whole compressed size, indexes included | **FIXED-NOW** — wording in the README, the script's docstring and print, and the PR body; the numbers stand (the whole-size haircut is the more conservative) |
<!-- SECOND-PASS:END -->

## Third pass: the cold-only layout and the default (2026-11-07)

The cold-only layout (`docker-compose.cold.yml`, `setup-zfs-datasets.sh
--cold-only`, ZFS.md "Choosing a layout" and "Cold-only setup", the
migrate script's cold-directory mount) and the default `cold_after_months =
1` were reviewed the same way: six lenses — the compose overlays, the shell
scripts and the shell the docs tell operators to run, documentation
accuracy, the default change, genericity, operator safety — and two
skeptics per finding, reproducing against a disposable PostgreSQL 18.4, the
lab's btrfs mounts and Docker Compose. 32 raw findings, 30 after
deduplication: 25 confirmed, 4 contested, 1 rejected. Every confirmed and
contested item is fixed in the two commits themselves (they were rebuilt
with the fixes folded in, so the shape stays "layout / overlay / docs" then
"the default").

| # | sev | where | votes | finding | status |
|---|---|---|---|---|---|
| 1 | medium→low | ZFS.md cold-only step b, `.env.sample`, overlay headers | C/C | `COMPOSE_FILE` switches off Compose's automatic loading of `docker-compose.override.yml`, which docker-compose.yml itself suggests for the port map; the recommendation never said so | **FIXED-NOW** — both setups, `.env.sample`, both overlay headers and the setup script's next steps say to list the override file before the overlay |
| 2 | medium | ZFS.md step 4; `ensure_cold_tablespace` 42501 message | C/C | "mount it" is not enough for a running stack: Docker binds are private, a mount made on the host afterwards stays invisible inside the containers | **FIXED-NOW** — "mount it, then `docker compose restart postgres meshinfo`" in the message, the fs-check refusal, step 4, the cold-only setup and the Upgrades check (`up -d` alone recreates nothing) |
| 3 | medium | ZFS.md cold-only rollback | C/C | the rollback never switched the scheduler off, so the hourly tick re-tiers months the CLI has just brought back (reproduced); nothing coordinates the two | **FIXED-NOW** — an ordered procedure: scheduler off, move back, `plan --all` empty, `DROP TABLESPACE`, then the overlay and the fstab line |
| 4 | low | ZFS.md step 4 | C/C | "the last line belongs to a stack without an overlay" is wrong once the cold overlay has run: Docker leaves the root-owned mount point inside the named volume, so a stack that lost the overlay shows the first line (reproduced) | **FIXED-NOW** — the paragraph names that case and the `docker compose config` check that tells it apart; the 42501 message says to check the overlay is part of the invocation |
| 5 | low | ZFS.md "already on a pool" note | C/C | `findmnt <directory>` prints nothing for a btrfs subvolume (not a mount point) — the very case the note covers | **FIXED-NOW** — `findmnt -no FSTYPE -T` there and as the subvolume variant in the cold-only setup; plain `findmnt` stays where "nothing" is the intended unmounted signal |
| 6 | medium | `setup-zfs-datasets.sh --cold-only` | C/C | a bare pool name was accepted, and the cold properties and mountpoint would have been set on the pool's root dataset — inherited by every child | **FIXED-NOW** — a name without `/` is refused before pre-flight (`--dry-run` too) |
| 7 | low | `setup-zfs-datasets.sh --cold-only` | C/C | the script chowned and reported "Dataset ready" without checking the dataset is mounted (`canmount=noauto`, an unloaded key) and would mount over a non-empty directory (`overlay=on` is the Linux default) | **FIXED-NOW** — real mode refuses a non-empty mountpoint that is not already this dataset's mount, and verifies `mounted = yes` plus `findmnt` before the chown |
| 8 | low | ZFS.md cold-only setup | C/C | the same `findmnt` point for the "already on btrfs" bullet of the setup | **FIXED-NOW** — see #5 |
| 9 | low | ZFS.md step 4 | C/C | the restart point, reported independently | **FIXED-NOW** — see #2 |
| 10 | low | ZFS.md "already on a pool" note | C/C | `btrfs property set … compression zstd:9` is accepted but the level is ignored, and the property is heuristic-gated rather than forced; the 5.3× quoted beside it was measured with `compress-force` | **FIXED-NOW** — the note says the property selects the codec only, to expect the `zstd:3` figure (5.0×) from it and 5.3× only from `compress-force=zstd:9` in the mount options |
| 11 | low→medium | ZFS.md loop image | C/C | a sparse (`truncate`) image reserves nothing on the backing filesystem, and the free-space guard only sees the btrfs inside the image | **FIXED-NOW** — `fallocate -l` (preallocated, fails now if the room is not there), `nodiscard` so freed extents are not punched back out, and a sentence on what the guard sees |
| 12 | low | `migrate-postgres.sh`; ZFS.md step 4 and Upgrades | C/C | after a major upgrade the old `PG_<old>_…` copy of every cold month stays in the cold directory and counts against the free-space guard; the completion message never mentioned it, and step 4 claimed a leftover directory is refused (only the same major version's is) | **FIXED-NOW** — the script prints the leftover and the `rm -rf` line when a cold directory is bound; Upgrades gives the command; step 4 states the real rule |
| 13 | medium | ZFS.md "Choosing a layout" | C/C | the 4.6× → 3.5× drop was attributed to readers setting hint bits and the freeze presented as the cure; the lab's record is 3.4–4.1× from a move under load, with the freeze on, because the copy's pages were written back piecemeal | **FIXED-NOW** — the paragraph, step 6 and the `_post_move` docstring state what section 4 of the benchmark README measured |
| 14 | medium | ZFS.md rollback | C/C | the scheduler-off omission, reported independently | **FIXED-NOW** — see #3 |
| 15 | low | ZFS.md and benchmark README projection tables | C/C | the 12-month cold-only conservative figure read 12.4 GB (copied from the row above); the JSON says 12.34 | **FIXED-NOW** — 12.3 GB in both tables and the PR body |
| 16 | low | ZFS.md layout table, Monitoring | C/C | "5.3× … measured with `compsize`" is the ratio of the original files; on months the job has rebuilt `compsize` reads ≈ 4.6× (same bytes, indexes packed by a third), so the documented check would read as a problem | **FIXED-NOW** — both ratios stated, in the table cells and in Monitoring ("expect ≈ 4.6× on the months the job wrote") |
| 17 | low | ZFS.md "Choosing a layout" | R/C | `logbias=latency` is ZFS's default, so it was no example of a tuned hot dataset | **FIXED-NOW** — `zstd-3` instead |
| 18 | low | ZFS.md "The btrfs equivalent" | C/C | "the lab measured both" — the ZFS side is the model; the lab has no ZFS | **FIXED-NOW** — measured on btrfs, modelled for ZFS, within 0.2 % |
| 19 | low | ZFS.md intro | R/C | "the two Linux filesystems that compress transparently" — the job accepts two; Linux has more | **FIXED-NOW** — "the two compressing filesystems the tiering job's mount check accepts" |
| 20 | low | ZFS.md "already on a pool" note | C/C | the by-hand `zfs create` variant omitted the `chown 999:999` every other variant has; a root-owned mountpoint makes `CREATE TABLESPACE` fail as "not writable" (reproduced) | **FIXED-NOW** — the ownership clause covers both variants |
| 21 | low | UPGRADING.md | R/C | the commit message said the dial trade-off is documented there; it was not | **FIXED-NOW** — one sentence after the config block |
| 22 | medium→low | ZFS.md, PR body | C/C | `btrfs filesystem defragment -czstd` without `-r` rewrites no file (reproduced: 0 s, extents unchanged) | **FIXED-NOW** — `-r -czstd -L 9` with the kernel/btrfs-progs caveat, everywhere the command appears |
| 23 | low | ZFS.md "Choosing a layout" | C/C | the 3.5× figure matched neither the benchmark README nor the PR body | **FIXED-NOW** — see #13 |
| 24 | low | `scripts/zfs_estimate.py` usage example | R/C | the example `--pgdata` path named a Docker volume this stack never creates (a context line of the edited hunk) | **FIXED-NOW** — `docker volume inspect` of the real volume, as ZFS.md shows it |
| 25 | high→medium | ZFS.md cold-only fstab lines | C/C | without `nofail` a dead cold disk or a missing loop image fails `local-fs.target` and drops the host into emergency mode — no Docker, no ssh — to protect compressed copies of closed months (reproduced with systemd-fstab-generator) | **FIXED-NOW** — `nofail,x-systemd.device-timeout=30s,x-systemd.before=docker.service` (the mount attempt still precedes the Docker daemon), the reasoning spelled out, a ZFS dataset needs neither, and a check after every reboot |
| 26 | medium | ZFS.md rollback | C/C | the rollback left the tablespace in the catalog: once the filesystem is gone, a later enabled cycle skips `CREATE TABLESPACE` and fails with `could not create directory` (reproduced); and the move back is not free-space-guarded | **FIXED-NOW** — see #3: `DROP TABLESPACE` while still mounted, the space note, the consequence stated |
| 27 | medium | `ensure_cold_tablespace` 42501 message, ZFS.md | C/C | the restart point against the code's own message, reported independently (reproduced with nested daemons: the running container keeps the bare directory, `restart` fixes it, `up -d` does not) | **FIXED-NOW** — see #2 |
| 28 | medium→low | ZFS.md loop image | R/R | a sparse image larger than the root filesystem's free space "can fill the root and PANIC the live cluster" | **REJECTED** — when the cluster's volume shares the filesystem each move frees about five times what it writes into the image, so the image cannot outrun the archive it replaces; the guard's blind spot itself is #11 and is fixed there |
| 29 | medium | `migrate-postgres.sh` | C/C | a cold-only major-version migration (reachable only since the delta mounted the cold directory into the dump container) restores the whole archive uncompressed onto the Docker volume after deleting the old one, with no capacity check | **FIXED-NOW** — before the dump, with a cold directory bound: `pg_database_size` against the free space of the filesystem behind the volume plus what removing the old volume frees (`SKIP_SPACE_CHECK=1` overrides); Upgrades says so |
| 30 | low | ZFS.md, PR body | C/C | the defragment command's missing `-r` and the level: on kernels ≥ 6.15 a bare `-czstd` recompresses at zstd level 3, below the mount's `zstd:9` (reproduced) | **FIXED-NOW** — see #22 |

## Verification of this close-out

<!-- VERIFY:START -->
- `python -m pytest -q tests`: 628 passed, 36 skipped (the integration
  scenarios skip without the environment variables).
- `tests/test_tiering_integration.py` against a disposable PostgreSQL 18.4
  (`postgres:18`, the real schema from the lab's `schema_full.sql`; the
  `meshinfo_cold` tablespace was created by `ensure_cold_tablespace()`
  itself): 18 passed — the first pass's 15 plus the wall-clock probe, the
  deadlock waiter and the DEFAULT-partition guard.
- `ensure_cold_tablespace()` exercised on that server for every refusal
  path: missing directory, root-owned directory, relative and empty
  location, a directory already holding a tablespace, a non-superuser role
  (`SET ROLE pg_read_all_data`, in the committed integration test), a failed
  mount check, inside a transaction; then the real creation, twice (second
  call: exists).
- CLI: `plan` and a dry `run` report the missing tablespace with the hint and
  exit 2; `run --apply` creates it and continues; `--json` stdout stays pure
  JSON (the creation line goes to stderr).
- pyflakes clean on every changed Python file; `bash -n` on the shell
  scripts; `git diff --check` clean.
- Lab (`lab/lab-stall.sh`, README section 4b), re-run after the second pass
  under `wal_level = replica`: shipped constants — 12 moves, three attempts
  postponed by the probe behind the slow client's scans, none timed out,
  longest wait behind a swap 0.8 s, longest request 1.87 s, none over 3 s,
  0 errors in 14,319 requests, digests identical; the swap's own hold alone
  (`lab/hold_probe.py`) 33 ms to the cold tablespace and 27 ms back for a
  263 MB month. The first run (`wal_level = minimal`): 2.51 s vs 5.70 s.
- Commits: the five close-out commits (review fixes, swap bound, operator
  path, docs/projection correction, upgrading notes — each pyflakes-clean
  and green on the unit suite, the split rehearsed in a scratch worktree
  before it was committed), then "second-pass review fixes" and the
  re-measurement.
<!-- VERIFY:END -->

## Deferred

Left open when `scripts/setup-cold-storage.sh` was wrapped up (2026-11-12);
one line each, none of them blocks the script's use.

- Eleven findings of the last review of the script were fixed but never checked by a second reader, because that pass was cut short: a tablespace in a directory below the top of the cold directory, an fstab line for a dataset that is not made yet, the "unknown" fstab class in `status`, a ZFS without zstd, and seven about the lab (stand-in defaults, fstab lines left by an interrupted run, a pool recorded before it is made, loop-device bookkeeping, the comparison of other pools, the stand-in's way out, four checks that pinned nothing).
- The final tree ran on real pools with OpenZFS 2.3.9 only; 2.2.11 and 2.4.4 ran an earlier revision, natively on Alpine.
- No test reboots a host: `zpool export`/`import` and `mount` stand in for it, and `systemctl daemon-reload` runs only against a stand-in.
- `setup-zfs-datasets.sh` still creates a dataset and then sets its properties one by one; a single `zfs create -o …` would leave nothing behind when a property is refused, and no empty `/POOL/NAME` directory.
- The dry-run plan prints nothing under "what that script runs" when the delegated script refuses its arguments; it should show that script's own message.
- Mount advice for an fstab line of a dataset whose mountpoint is another path names two ways out; the third (remove the line and use the dataset where it is, with `--mountpoint`) is not named.
- That a copy's key is not loaded is said in `status` only; the two warnings of setup and ZFS.md still speak of "zfs mount -a at boot unless its canmount is noauto".
- A received copy is told from the cold dataset by where its `mountpoint` property comes from; a cold dataset restored from a backup is "received" too, and a copy given its mountpoint by hand is "local", so it is a hint, and the messages say so only by naming both datasets.
- `status` does not ask the database which reading applies when an unmounted dataset has a bare cold directory that is not empty; it gives the mount command and says to look into the directory first.
- ZFS.md says the script names "the ZFS dataset that has the path and is not mounted" as what to bring back; the message now adds "if it is the cold dataset" and a second reading for a copy.
- The lab suite does not retry a `docker compose exec` that the runtime could not start (seen once, exit 126, in the nested Docker of an emulated guest).
