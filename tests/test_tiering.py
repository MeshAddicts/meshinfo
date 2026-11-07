"""
Tests for tiered cold storage (storage/db/tiering.py, the [storage.tiering]
config section and the maintenance.py scheduler gate). Pure helpers only — no
database; the move itself is exercised by tests/test_tiering_integration.py
against a disposable PostgreSQL.
"""

import asyncio
import copy
import dataclasses
import datetime
import hashlib
import json
import logging
import time
import tomllib
from pathlib import Path

import pytest

import config as config_mod
import maintenance
import storage.db.tiering as tiering_mod
from storage.db.tiering import (
    IDENT_RE,
    MAX_IDENT,
    OLD_SUFFIX,
    RANGE_SUFFIX,
    SCRATCH_SUFFIX,
    TIERABLE_TABLES,
    CycleResult,
    MoveResult,
    PartitionInfo,
    TieringPolicy,
    add_months,
    clone_index_sql,
    cold_cutoff,
    connect_kwargs,
    constraint_index_sql,
    dsn_from_config,
    human_bytes,
    is_cold,
    month_bounds,
    month_label,
    parse_bounds,
    partition_month,
    quote_ident,
    quote_literal,
    range_check_sql,
    safe_name,
    run_cycle,
    plan,
    TieringVerifyError,
    TieringRefused,
    TieringBusy,
)

UTC = datetime.timezone.utc
REPO_ROOT = Path(__file__).resolve().parents[1]

PART = "mqtt_messages_2025_01"
REP = "mqtt_messages_2025_01_tiering"
TS = "meshinfo_cold"
# The auto-generated per-partition index name from the contract: 59 characters,
# so "<name>_tiering" (67) and "<name>_tiering_old" (71) both overflow 63 bytes.
LONG_INDEX = "mqtt_messages_2025_01_from_node_id_packet_id_created_at_idx"
# Every index present on a monthly partition (parent index in the contract).
MQTT_INDEXES = (
    "{p}_pkey", "{p}_created_at_idx", "{p}_timestamp_idx", "{p}_from_node_id_created_at_idx",
    "{p}_to_node_id_created_at_idx", "{p}_id_idx", "{p}_from_node_id_packet_id_created_at_idx",
    "{p}_topic_idx", "{p}_created_at_idx1",
)
RECEPTION_INDEXES = ("{p}_mqtt_row_id_created_at_idx", "{p}_gateway_created_at_idx")


def _tiering_cfg(**section):
    """A config carrying only [storage.tiering] (enabled unless overridden)."""
    return {"storage": {"tiering": {"enabled": True, **section}}}


def _validatable_base():
    """DEFAULT_CONFIG made fatal-error-free so validate() runs to completion."""
    base = copy.deepcopy(config_mod.DEFAULT_CONFIG)
    base["storage"]["postgres"]["enabled"] = True
    base.setdefault("mesh", {}).update({"name": "t", "shortname": "t"})
    return base


def _tiering_warnings(cfg):
    return [w for w in config_mod.validate(cfg) if "tiering" in w]


def _bound(month):
    lo, hi = month_bounds(month)
    return f"FOR VALUES FROM ('{lo:%Y-%m-%d %H:%M:%S}+00') TO ('{hi:%Y-%m-%d %H:%M:%S}+00')"


def _part(name=PART, table="mqtt_messages", bound=None, tablespace="pg_default",
          index_tablespaces=None, total_bytes=1000):
    """A PartitionInfo as list_partitions would build it (monthly bound unless given)."""
    month = partition_month(name, table)
    if bound is None:
        bound = _bound(month) if month is not None else "DEFAULT"
    parsed = parse_bounds(bound)
    return PartitionInfo(
        table=table, name=name, oid=1, bound=bound, month=month,
        lo=parsed[0] if parsed else None, hi=parsed[1] if parsed else None,
        tablespace=tablespace, index_tablespaces=dict(index_tablespaces or {}),
        table_bytes=total_bytes // 2, index_bytes=total_bytes - total_bytes // 2,
        total_bytes=total_bytes, reltuples=42.0,
    )


# ── month arithmetic ─────────────────────────────────────────────────────────

class TestMonthArithmetic:
    def test_add_months_forward_and_back(self):
        assert add_months(datetime.date(2026, 7, 1), 1) == datetime.date(2026, 8, 1)
        assert add_months(datetime.date(2026, 7, 1), -1) == datetime.date(2026, 6, 1)
        assert add_months(datetime.date(2026, 7, 1), 0) == datetime.date(2026, 7, 1)
        assert add_months(datetime.date(2026, 7, 15), 1) == datetime.date(2026, 8, 1)  # first-of-month

    def test_add_months_wraps_years(self):
        assert add_months(datetime.date(2026, 11, 1), 2) == datetime.date(2027, 1, 1)
        assert add_months(datetime.date(2026, 12, 1), 1) == datetime.date(2027, 1, 1)
        assert add_months(datetime.date(2026, 1, 1), -1) == datetime.date(2025, 12, 1)
        assert add_months(datetime.date(2026, 1, 1), -3) == datetime.date(2025, 10, 1)
        assert add_months(datetime.date(2026, 3, 1), -27) == datetime.date(2023, 12, 1)
        assert add_months(datetime.date(2026, 3, 1), 24) == datetime.date(2028, 3, 1)

    def test_month_bounds_half_open_aware_utc(self):
        lo, hi = month_bounds(datetime.date(2026, 12, 1))
        assert lo == datetime.datetime(2026, 12, 1, tzinfo=UTC)
        assert hi == datetime.datetime(2027, 1, 1, tzinfo=UTC)
        assert lo.utcoffset() == datetime.timedelta(0) and hi.utcoffset() == datetime.timedelta(0)
        assert month_bounds(datetime.date(2026, 2, 14)) == month_bounds(datetime.date(2026, 2, 1))

    def test_month_label(self):
        assert month_label(datetime.date(2026, 7, 1)) == "2026_07"
        assert month_label(datetime.date(2025, 12, 1)) == "2025_12"


# ── cold semantics ───────────────────────────────────────────────────────────

class TestColdSemantics:
    def test_contract_examples(self):
        assert cold_cutoff(datetime.date(2026, 11, 3), 3) == datetime.date(2026, 8, 1)
        assert cold_cutoff(datetime.date(2026, 11, 3), 1) == datetime.date(2026, 10, 1)
        assert cold_cutoff(datetime.date(2026, 1, 15), 3) == datetime.date(2025, 10, 1)

    def test_three_months_july_cold_august_hot(self):
        now = datetime.date(2026, 11, 3)
        assert is_cold(datetime.date(2026, 7, 1), now, 3) is True
        assert is_cold(datetime.date(2026, 8, 1), now, 3) is False
        assert is_cold(datetime.date(2026, 10, 1), now, 3) is False
        assert is_cold(datetime.date(2026, 11, 1), now, 3) is False
        assert is_cold(datetime.date(2025, 1, 1), now, 3) is True

    def test_one_month_keeps_the_previous_month_hot(self):
        now = datetime.date(2026, 11, 3)
        assert is_cold(datetime.date(2026, 9, 1), now, 1) is True
        assert is_cold(datetime.date(2026, 10, 1), now, 1) is False

    def test_year_wrap(self):
        now = datetime.date(2026, 1, 15)
        assert is_cold(datetime.date(2025, 9, 1), now, 3) is True
        assert is_cold(datetime.date(2025, 10, 1), now, 3) is False
        assert is_cold(datetime.date(2025, 12, 1), now, 3) is False

    def test_clamped_to_at_least_one_month(self):
        now = datetime.date(2026, 11, 3)
        for n in (0, -1, -12):
            assert cold_cutoff(now, n) == cold_cutoff(now, 1) == datetime.date(2026, 10, 1)
        assert is_cold(datetime.date(2026, 10, 1), now, 0) is False
        assert is_cold(datetime.date(2026, 9, 1), now, 0) is True

    def test_accepts_datetimes_and_reads_aware_ones_in_utc(self):
        naive = datetime.datetime(2026, 11, 3, 12, 30)
        aware = datetime.datetime(2026, 11, 3, 12, 30, tzinfo=UTC)
        assert cold_cutoff(naive, 3) == cold_cutoff(aware, 3) == datetime.date(2026, 8, 1)
        # 2026-12-01 00:30 at UTC+1 is still 2026-11-30 23:30 UTC: the UTC clock decides.
        plus_one = datetime.timezone(datetime.timedelta(hours=1))
        edge = datetime.datetime(2026, 12, 1, 0, 30, tzinfo=plus_one)
        assert cold_cutoff(edge, 3) == datetime.date(2026, 8, 1)
        assert is_cold(datetime.date(2026, 8, 1), edge, 3) is False


# ── partition bounds and names ───────────────────────────────────────────────

class TestParseBounds:
    LO = datetime.datetime(2025, 1, 1, tzinfo=UTC)
    HI = datetime.datetime(2025, 2, 1, tzinfo=UTC)

    def test_pg_get_expr_text(self):
        text = "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 00:00:00+00')"
        assert parse_bounds(text) == (self.LO, self.HI)

    def test_result_is_aware_utc(self):
        lo, hi = parse_bounds("FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-02-01 00:00:00+00')")
        assert lo.utcoffset() == datetime.timedelta(0) and hi.utcoffset() == datetime.timedelta(0)
        assert (lo, hi) == month_bounds(datetime.date(2025, 1, 1))

    @pytest.mark.parametrize("lo_text, hi_text", [
        ("2025-01-01 00:00:00+00:00", "2025-02-01 00:00:00+00:00"),
        ("2025-01-01 00:00:00Z", "2025-02-01 00:00:00Z"),
        ("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"),
        ("2025-01-01 00:00:00.000000+00", "2025-02-01 00:00:00.000+00"),
        ("2025-01-01 01:00:00+01", "2025-01-31 19:00:00-05"),  # offsets normalised to UTC
    ])
    def test_timestamp_variants(self, lo_text, hi_text):
        assert parse_bounds(f"FOR VALUES FROM ('{lo_text}') TO ('{hi_text}')") == (self.LO, self.HI)

    def test_fractional_seconds_are_kept(self):
        lo, hi = parse_bounds("FOR VALUES FROM ('2025-01-01 00:00:00.25+00') TO ('2025-02-01 00:00:00.000001+00')")
        assert lo == self.LO + datetime.timedelta(milliseconds=250)
        assert hi == self.HI + datetime.timedelta(microseconds=1)

    @pytest.mark.parametrize("text", [
        "DEFAULT",
        "",
        "FOR VALUES FROM (MINVALUE) TO ('2025-02-01 00:00:00+00')",
        "FOR VALUES FROM ('2025-01-01 00:00:00+00') TO (MAXVALUE)",
        "FOR VALUES IN (1, 2)",
        "FOR VALUES FROM ('2025-02-30 00:00:00+00') TO ('2025-03-01 00:00:00+00')",  # no such day
        "FOR VALUES FROM ('yesterday') TO ('today')",
        "garbage",
    ])
    def test_unparsable_is_none(self, text):
        assert parse_bounds(text) is None

    def test_non_string_is_none(self):
        assert parse_bounds(None) is None


class TestPartitionMonth:
    def test_valid_names(self):
        assert partition_month("mqtt_messages_2026_07", "mqtt_messages") == datetime.date(2026, 7, 1)
        assert partition_month("mqtt_messages_2026_01", "mqtt_messages") == datetime.date(2026, 1, 1)
        assert partition_month("packet_receptions_2025_12", "packet_receptions") == datetime.date(2025, 12, 1)

    @pytest.mark.parametrize("name", [
        "mqtt_messages_default",
        "mqtt_messages_2026_13",
        "mqtt_messages_2026_00",
        "mqtt_messages_2026_7",
        "mqtt_messages_202607",
        "mqtt_messages_2026_07_tiering",
        "mqtt_messages_2026_07_tiering_old",
        "mqtt_messages_2026_07x",
        "xmqtt_messages_2026_07",
        "MQTT_MESSAGES_2026_07",
        "mqtt_messages_",
        "mqtt_messages",
        "",
    ])
    def test_invalid_names(self, name):
        assert partition_month(name, "mqtt_messages") is None

    def test_other_table_prefix_is_not_a_match(self):
        assert partition_month("packet_receptions_2026_07", "mqtt_messages") is None
        assert partition_month("mqtt_messages_2026_07", "packet_receptions") is None

    def test_round_trips_month_label(self):
        month = datetime.date(2026, 7, 1)
        assert partition_month(f"mqtt_messages_{month_label(month)}", "mqtt_messages") == month


# ── identifier helpers ───────────────────────────────────────────────────────

class TestQuoting:
    def test_quote_ident_always_quotes_and_doubles_embedded_quotes(self):
        assert quote_ident("mqtt_messages_2025_01") == '"mqtt_messages_2025_01"'
        assert quote_ident('a"b') == '"a""b"'
        assert quote_ident("Mixed Case") == '"Mixed Case"'

    def test_quote_literal(self):
        assert quote_literal("5s") == "'5s'"
        assert quote_literal("it's") == "'it''s'"


class TestSafeName:
    def test_short_names_unchanged(self):
        assert safe_name(PART, SCRATCH_SUFFIX) == "mqtt_messages_2025_01_tiering"
        assert safe_name(PART, OLD_SUFFIX) == "mqtt_messages_2025_01_tiering_old"
        assert safe_name(PART, RANGE_SUFFIX) == "mqtt_messages_2025_01_tiering_range"
        assert safe_name(f"{PART}_pkey", SCRATCH_SUFFIX) == "mqtt_messages_2025_01_pkey_tiering"

    def test_exactly_63_is_unchanged_one_more_is_hashed(self):
        fits = "x" * (MAX_IDENT - len(SCRATCH_SUFFIX))
        assert safe_name(fits, SCRATCH_SUFFIX) == fits + SCRATCH_SUFFIX
        assert len(safe_name(fits, SCRATCH_SUFFIX)) == 63
        over = fits + "x"
        assert safe_name(over, SCRATCH_SUFFIX) != over + SCRATCH_SUFFIX
        assert len(safe_name(over, SCRATCH_SUFFIX)) == 63

    def test_contract_formula_for_long_names(self):
        assert len(LONG_INDEX) == 59
        tag = hashlib.sha1(LONG_INDEX.encode("utf-8")).hexdigest()[:4]
        expected = LONG_INDEX[:63 - len(SCRATCH_SUFFIX) - 5] + "_" + tag + SCRATCH_SUFFIX
        assert safe_name(LONG_INDEX, SCRATCH_SUFFIX) == expected
        assert expected == "mqtt_messages_2025_01_from_node_id_packet_id_creat_8c2c_tiering"

    def test_long_names_fit_and_keep_the_suffix(self):
        for suffix in (SCRATCH_SUFFIX, OLD_SUFFIX, RANGE_SUFFIX):
            name = safe_name(LONG_INDEX, suffix)
            assert len(name.encode("utf-8")) <= MAX_IDENT
            assert name.endswith(suffix)
            assert name.startswith(LONG_INDEX[:40])  # still recognisably the original
            assert IDENT_RE.match(name)

    def test_contract_59_char_index_scratch_and_old_names_differ(self):
        # PostgreSQL would silently cut both overflowing names to the same 63 bytes.
        assert (LONG_INDEX + SCRATCH_SUFFIX)[:63] == (LONG_INDEX + OLD_SUFFIX)[:63]
        scratch = safe_name(LONG_INDEX, SCRATCH_SUFFIX)
        old = safe_name(LONG_INDEX, OLD_SUFFIX)
        assert scratch != old
        assert len(scratch) == 63 and len(old) == 63

    def test_distinct_long_bases_stay_distinct(self):
        twin = LONG_INDEX + "1"  # the <p>_created_at_idx1 pattern: same first 50 characters
        a, b = safe_name(LONG_INDEX, SCRATCH_SUFFIX), safe_name(twin, SCRATCH_SUFFIX)
        assert a != b
        assert a[:50] == b[:50]  # the hash tag, not the truncated prefix, tells them apart
        assert safe_name(LONG_INDEX, SCRATCH_SUFFIX) == a  # deterministic

    def test_every_partition_index_name_maps_uniquely(self):
        names = []
        for month in range(1, 13):
            names += [t.format(p=f"mqtt_messages_2025_{month:02d}") for t in MQTT_INDEXES]
            names += [t.format(p=f"packet_receptions_2025_{month:02d}") for t in RECEPTION_INDEXES]
        scratch = [safe_name(n, SCRATCH_SUFFIX) for n in names]
        old = [safe_name(n, OLD_SUFFIX) for n in names]
        assert len(set(scratch)) == len(names)
        assert len(set(old)) == len(names)
        assert not set(scratch) & set(old)
        assert all(len(n) <= MAX_IDENT for n in scratch + old)

    def test_never_exceeds_63(self):
        for n in range(0, 200, 7):
            for suffix in (SCRATCH_SUFFIX, OLD_SUFFIX, RANGE_SUFFIX):
                assert len(safe_name("a" * n, suffix)) <= MAX_IDENT


# ── DDL rewriting ────────────────────────────────────────────────────────────

class TestCloneIndexSql:
    def test_plain_btree_appends_tablespace(self):
        sql = clone_index_sql(
            f"CREATE INDEX {PART}_created_at_idx ON public.{PART} USING btree (created_at DESC)",
            new_index=f"{PART}_created_at_idx_tiering", new_table=REP, tablespace=TS)
        assert sql == (f'CREATE INDEX "{PART}_created_at_idx_tiering" ON "{REP}" '
                       f'USING btree (created_at DESC) TABLESPACE "{TS}"')

    def test_partial_index_puts_tablespace_before_where(self):
        sql = clone_index_sql(
            f"CREATE INDEX {PART}_id_idx ON public.{PART} USING btree (id) WHERE (from_node_id IS NULL)",
            new_index="scratch", new_table=REP, tablespace=TS)
        assert sql == (f'CREATE INDEX "scratch" ON "{REP}" USING btree (id) '
                       f'TABLESPACE "{TS}" WHERE (from_node_id IS NULL)')
        assert sql.index("TABLESPACE") < sql.index("WHERE")

    def test_multi_column_partial_index(self):
        sql = clone_index_sql(
            f"CREATE INDEX {LONG_INDEX} ON public.{PART} USING btree (from_node_id, packet_id, created_at) "
            "WHERE (packet_id IS NOT NULL)",
            new_index=safe_name(LONG_INDEX, SCRATCH_SUFFIX), new_table=REP, tablespace=TS)
        assert sql == (f'CREATE INDEX "{safe_name(LONG_INDEX, SCRATCH_SUFFIX)}" ON "{REP}" '
                       f'USING btree (from_node_id, packet_id, created_at) TABLESPACE "{TS}" '
                       "WHERE (packet_id IS NOT NULL)")

    def test_partial_index_with_like_predicate(self):
        indexdef = (f"CREATE INDEX {PART}_created_at_idx1 ON public.{PART} USING btree (created_at) "
                    "WHERE (topic ~~ '%/2/e/%/!%'::text)")
        sql = clone_index_sql(indexdef, new_index="scratch", new_table=REP, tablespace=TS)
        assert sql == (f'CREATE INDEX "scratch" ON "{REP}" USING btree (created_at) '
                       f"TABLESPACE \"{TS}\" WHERE (topic ~~ '%/2/e/%/!%'::text)")

    def test_unique_is_kept(self):
        sql = clone_index_sql(
            f"CREATE UNIQUE INDEX {PART}_pkey ON public.{PART} USING btree (id, created_at)",
            new_index=f"{PART}_pkey_tiering", new_table=REP, tablespace=TS)
        assert sql == (f'CREATE UNIQUE INDEX "{PART}_pkey_tiering" ON "{REP}" '
                       f'USING btree (id, created_at) TABLESPACE "{TS}"')

    def test_gin_with_opclass(self):
        sql = clone_index_sql(
            f"CREATE INDEX {PART}_topic_idx ON public.{PART} USING gin (topic gin_trgm_ops)",
            new_index="scratch", new_table=REP, tablespace=TS)
        assert sql == f'CREATE INDEX "scratch" ON "{REP}" USING gin (topic gin_trgm_ops) TABLESPACE "{TS}"'

    def test_quoted_timestamp_column(self):
        sql = clone_index_sql(
            f'CREATE INDEX {PART}_timestamp_idx ON public.{PART} USING btree ("timestamp" DESC)',
            new_index="scratch", new_table=REP, tablespace=TS)
        assert sql == f'CREATE INDEX "scratch" ON "{REP}" USING btree ("timestamp" DESC) TABLESPACE "{TS}"'

    def test_include_and_with_kept_verbatim(self):
        indexdef = f"CREATE INDEX i ON public.{PART} USING btree (id) INCLUDE (topic) WITH (fillfactor='90')"
        sql = clone_index_sql(indexdef, new_index="s", new_table=REP, tablespace=TS)
        assert sql == (f'CREATE INDEX "s" ON "{REP}" USING btree (id) INCLUDE (topic) '
                       f"WITH (fillfactor='90') TABLESPACE \"{TS}\"")

    def test_table_is_unqualified_and_quoted(self):
        sql = clone_index_sql(f"CREATE INDEX i ON public.{PART} USING btree (id)",
                              new_index="s", new_table=REP, tablespace=TS)
        assert "public." not in sql
        assert f' ON "{REP}" ' in sql
        assert PART + " " not in sql  # the original table name is gone

    def test_identifiers_are_quoted(self):
        sql = clone_index_sql(f"CREATE INDEX i ON public.{PART} USING btree (id)",
                              new_index='we"ird', new_table="t", tablespace="cold space")
        assert 'INDEX "we""ird" ON "t" ' in sql
        assert sql.endswith('TABLESPACE "cold space"')

    @pytest.mark.parametrize("garbage", [
        "",
        "DROP TABLE mqtt_messages",
        "CREATE INDEX foo ON bar (baz)",  # no USING clause
        "CREATE INDEX ON public.t USING btree (id)",  # no name
        "ALTER INDEX x RENAME TO y",
        "create index i on public.t using btree (id)",  # pg_get_indexdef is upper-case
    ])
    def test_garbage_raises_value_error(self, garbage):
        with pytest.raises(ValueError):
            clone_index_sql(garbage, new_index="s", new_table="t", tablespace=TS)


class TestConstraintAndCheckSql:
    def test_constraint_index_sql_primary_key(self):
        sql = constraint_index_sql(REP, f"{PART}_pkey_tiering", "PRIMARY KEY (id, created_at)", TS)
        assert sql == (f'ALTER TABLE "{REP}" ADD CONSTRAINT "{PART}_pkey_tiering" '
                       f'PRIMARY KEY (id, created_at) USING INDEX TABLESPACE "{TS}"')

    def test_constraint_index_sql_unique(self):
        sql = constraint_index_sql("t", "c", "UNIQUE (a, b)", "pg_default")
        assert sql == 'ALTER TABLE "t" ADD CONSTRAINT "c" UNIQUE (a, b) USING INDEX TABLESPACE "pg_default"'

    def test_range_check_sql_renders_utc_literals(self):
        lo, hi = month_bounds(datetime.date(2025, 1, 1))
        sql = range_check_sql(REP, f"{PART}_tiering_range", lo, hi)
        assert sql == (f'ALTER TABLE "{REP}" ADD CONSTRAINT "{PART}_tiering_range" '
                       "CHECK (created_at >= TIMESTAMPTZ '2025-01-01 00:00:00+00' "
                       "AND created_at < TIMESTAMPTZ '2025-02-01 00:00:00+00')")

    def test_range_check_sql_normalises_offsets_to_utc(self):
        plus_one = datetime.timezone(datetime.timedelta(hours=1))
        lo = datetime.datetime(2025, 1, 1, 1, 0, tzinfo=plus_one)  # 2025-01-01 00:00 UTC
        hi = datetime.datetime(2025, 2, 1, 1, 0, tzinfo=plus_one)
        sql = range_check_sql("t", "c", lo, hi)
        assert "TIMESTAMPTZ '2025-01-01 00:00:00+00'" in sql
        assert "TIMESTAMPTZ '2025-02-01 00:00:00+00'" in sql


# ── connection helpers ───────────────────────────────────────────────────────

class TestConnectionHelpers:
    CFG = {"storage": {"postgres": {"host": "db.local", "port": 5433, "username": "mesh",
                                    "password": "p@ss/w:rd", "database": "meshinfo"}}}

    def test_connect_kwargs_dedicated_session(self):
        assert connect_kwargs(self.CFG) == {
            "host": "db.local", "port": 5433, "user": "mesh", "password": "p@ss/w:rd",
            "database": "meshinfo", "command_timeout": None, "timeout": 30,
        }

    def test_connect_kwargs_defaults_without_a_postgres_section(self):
        kw = connect_kwargs({})
        assert set(kw) == {"host", "port", "user", "password", "database", "command_timeout", "timeout"}
        assert kw["command_timeout"] is None and kw["timeout"] == 30
        pg = config_mod.DEFAULT_CONFIG["storage"]["postgres"]
        assert (kw["host"], kw["port"], kw["database"]) == (pg["host"], pg["port"], pg["database"])

    def test_dsn_url_quotes_user_and_password(self):
        assert dsn_from_config(self.CFG) == "postgresql://mesh:p%40ss%2Fw%3Ard@db.local:5433/meshinfo"

    def test_human_bytes_si_two_decimals(self):
        assert human_bytes(0) == "0 B"
        assert human_bytes(999) == "999 B"
        assert human_bytes(1000) == "1.00 kB"
        assert human_bytes(1_500_000) == "1.50 MB"
        assert human_bytes(1_290_000_000) == "1.29 GB"
        assert human_bytes(2_000_000_000_000) == "2.00 TB"


# ── policy ───────────────────────────────────────────────────────────────────

class TestTieringPolicyFromConfig:
    def test_missing_section_gives_defaults(self):
        for cfg in ({}, {"storage": {}}, {"storage": {"tiering": {}}}):
            assert TieringPolicy.from_config(cfg) == TieringPolicy()

    def test_defaults_match_default_config(self):
        policy = TieringPolicy.from_config(config_mod.DEFAULT_CONFIG)
        assert policy == TieringPolicy()
        assert policy.enabled is False
        assert policy.cold_after_months == 3
        assert policy.cold_tablespace == "meshinfo_cold"
        assert policy.tables == TIERABLE_TABLES == ("mqtt_messages", "packet_receptions")
        assert policy.max_partitions_per_cycle == 1
        assert policy.cold_filesystem == ""
        assert policy.min_free_mb == 2048

    def test_reads_every_key(self):
        cfg = _tiering_cfg(cold_after_months=6, cold_tablespace="cold2", tables=["packet_receptions"],
                           max_partitions_per_cycle=4, cold_filesystem="/mnt/meshinfo-cold", min_free_mb=0)
        assert TieringPolicy.from_config(cfg) == TieringPolicy(
            enabled=True, cold_after_months=6, cold_tablespace="cold2", tables=("packet_receptions",),
            max_partitions_per_cycle=4, cold_filesystem="/mnt/meshinfo-cold", min_free_mb=0)

    def test_enabled_accepts_bools_only(self):
        assert TieringPolicy.from_config(_tiering_cfg(enabled=True)).enabled is True
        assert TieringPolicy.from_config(_tiering_cfg(enabled=False)).enabled is False
        for bad in ("yes", "true", 1, 0, None, [True]):
            assert TieringPolicy.from_config(_tiering_cfg(enabled=bad)).enabled is False

    def test_cold_after_months_clamped_and_coerced(self):
        assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=12)).cold_after_months == 12
        assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=1)).cold_after_months == 1
        assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=0)).cold_after_months == 1
        assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=-7)).cold_after_months == 1
        for bad in ("3", 3.5, None, True):
            assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=bad)).cold_after_months == 3

    def test_cold_tablespace_is_taken_verbatim_or_emptied(self):
        assert TieringPolicy.from_config(_tiering_cfg(cold_tablespace="cold2")).cold_tablespace == "cold2"
        # Bad identifiers survive coercion; validate() is what flags them.
        assert TieringPolicy.from_config(_tiering_cfg(cold_tablespace="cold space")).cold_tablespace == "cold space"
        for bad in (5, None, ["meshinfo_cold"]):
            assert TieringPolicy.from_config(_tiering_cfg(cold_tablespace=bad)).cold_tablespace == ""

    def test_tables_canonical_order_deduped_and_filtered(self):
        cfg = _tiering_cfg(tables=["packet_receptions", "nodes", "mqtt_messages", "packet_receptions", 42])
        assert TieringPolicy.from_config(cfg).tables == ("mqtt_messages", "packet_receptions")
        assert TieringPolicy.from_config(_tiering_cfg(tables=["packet_receptions"])).tables == ("packet_receptions",)
        assert TieringPolicy.from_config(_tiering_cfg(tables=("mqtt_messages",))).tables == ("mqtt_messages",)
        assert TieringPolicy.from_config(_tiering_cfg(tables=[])).tables == ()
        assert TieringPolicy.from_config(_tiering_cfg(tables=["nodes"])).tables == ()
        for bad in ("mqtt_messages", None, 3, {"mqtt_messages": True}):
            assert TieringPolicy.from_config(_tiering_cfg(tables=bad)).tables == TIERABLE_TABLES

    def test_max_partitions_per_cycle(self):
        assert TieringPolicy.from_config(_tiering_cfg(max_partitions_per_cycle=3)).max_partitions_per_cycle == 3
        for bad in (0, -1, "2", 2.0, None, True):
            assert TieringPolicy.from_config(_tiering_cfg(max_partitions_per_cycle=bad)).max_partitions_per_cycle == 1

    def test_cold_filesystem(self):
        assert TieringPolicy.from_config(_tiering_cfg(cold_filesystem="/mnt/cold")).cold_filesystem == "/mnt/cold"
        for bad in (None, 7, ["/mnt/cold"]):
            assert TieringPolicy.from_config(_tiering_cfg(cold_filesystem=bad)).cold_filesystem == ""

    def test_min_free_mb(self):
        assert TieringPolicy.from_config(_tiering_cfg(min_free_mb=0)).min_free_mb == 0
        assert TieringPolicy.from_config(_tiering_cfg(min_free_mb=512)).min_free_mb == 512
        for bad in (-1, "2048", 1.5, None, True):
            assert TieringPolicy.from_config(_tiering_cfg(min_free_mb=bad)).min_free_mb == 2048

    def test_never_raises_on_wrong_shapes(self):
        for cfg in (None, 5, "x", [], {"storage": None}, {"storage": "x"}, {"storage": ["tiering"]},
                    {"storage": {"tiering": None}}, {"storage": {"tiering": ["enabled"]}},
                    {"storage": {"tiering": "enabled = true"}}):
            assert TieringPolicy.from_config(cfg) == TieringPolicy()

    def test_frozen(self):
        with pytest.raises(dataclasses.FrozenInstanceError):
            TieringPolicy().enabled = True

    def test_with_overrides(self):
        base = TieringPolicy()
        assert base.with_overrides() == base
        over = base.with_overrides(cold_after_months=6, cold_tablespace="pg_default")
        assert over.cold_after_months == 6 and over.cold_tablespace == "pg_default"
        assert over.tables == base.tables and over.enabled is base.enabled
        assert base == TieringPolicy()  # untouched
        assert base.with_overrides(cold_after_months=6).cold_tablespace == "meshinfo_cold"
        assert base.with_overrides(cold_tablespace="pg_default").cold_after_months == 3


class TestTieringPolicyValidate:
    RAW_DEFAULTS = config_mod.DEFAULT_CONFIG["storage"]["tiering"]

    def test_defaults_are_clean(self):
        assert TieringPolicy().validate() == []
        assert TieringPolicy().validate(raw=self.RAW_DEFAULTS) == []
        assert TieringPolicy.from_config(config_mod.DEFAULT_CONFIG).validate(raw=self.RAW_DEFAULTS) == []

    @pytest.mark.parametrize("bad", ["cold space", "x;drop", "", "Meshinfo_Cold", "1cold", 'cold"', "a" * 64])
    def test_bad_tablespace_identifier(self, bad):
        warns = TieringPolicy(cold_tablespace=bad).validate()
        assert len(warns) == 1
        assert "storage.tiering.cold_tablespace" in warns[0]

    def test_good_tablespace_identifiers(self):
        for good in ("meshinfo_cold", "pg_default", "_x", "cold2", "a" * 63):
            assert TieringPolicy(cold_tablespace=good).validate() == []

    def test_empty_tables(self):
        warns = TieringPolicy(tables=()).validate()
        assert len(warns) == 1 and "storage.tiering.tables" in warns[0]

    def test_raw_unknown_table_entries(self):
        raw = {"tables": ["mqtt_messages", "nodes", "packet_receptions", 7]}
        policy = TieringPolicy.from_config({"storage": {"tiering": raw}})
        assert policy.tables == TIERABLE_TABLES
        warns = policy.validate(raw=raw)
        assert len(warns) == 2
        assert all("storage.tiering.tables" in w for w in warns)
        assert any("'nodes'" in w for w in warns) and any("7" in w for w in warns)

    def test_raw_tables_wrong_shape(self):
        raw = {"tables": "mqtt_messages"}
        warns = TieringPolicy.from_config({"storage": {"tiering": raw}}).validate(raw=raw)
        assert len(warns) == 1 and "storage.tiering.tables" in warns[0]

    def test_raw_clamp_notice(self):
        raw = {"cold_after_months": 0}
        policy = TieringPolicy.from_config({"storage": {"tiering": raw}})
        assert policy.cold_after_months == 1
        warns = policy.validate(raw=raw)
        assert len(warns) == 1
        assert "storage.tiering.cold_after_months" in warns[0] and "clamped to 1" in warns[0]

    def test_raw_negative_values_are_reported(self):
        raw = {"max_partitions_per_cycle": 0, "min_free_mb": -1}
        policy = TieringPolicy.from_config({"storage": {"tiering": raw}})
        assert policy.max_partitions_per_cycle == 1 and policy.min_free_mb == 2048
        warns = policy.validate(raw=raw)
        assert any("storage.tiering.max_partitions_per_cycle" in w for w in warns)
        assert any("storage.tiering.min_free_mb" in w for w in warns)

    def test_raw_type_problems_each_name_their_key(self):
        raw = {"enabled": "yes", "cold_after_months": "3", "max_partitions_per_cycle": 1.5,
               "min_free_mb": True, "cold_filesystem": 7, "cold_tablespace": None}
        policy = TieringPolicy.from_config({"storage": {"tiering": raw}})
        assert policy.enabled is False and policy.cold_tablespace == ""
        warns = policy.validate(raw=raw)
        for key in raw:
            assert any(f"storage.tiering.{key}" in w for w in warns), key

    def test_without_raw_only_the_policy_itself_is_checked(self):
        policy = TieringPolicy.from_config(_tiering_cfg(cold_after_months=0, tables=["nodes"]))
        warns = policy.validate()
        assert len(warns) == 1 and "storage.tiering.tables" in warns[0]  # empty after filtering
        assert TieringPolicy.from_config(_tiering_cfg(cold_after_months=0)).validate() == []


# ── config.validate() ────────────────────────────────────────────────────────

class TestConfigValidateTiering:
    def test_defaults_produce_no_tiering_warnings(self):
        assert _tiering_warnings(_validatable_base()) == []

    @pytest.mark.parametrize("bad", ["cold space", "x;drop"])
    def test_bad_tablespace_identifier(self, bad):
        cfg = _validatable_base()
        cfg["storage"]["tiering"]["cold_tablespace"] = bad
        warns = _tiering_warnings(cfg)
        assert len(warns) == 1
        assert "storage.tiering.cold_tablespace" in warns[0] and repr(bad) in warns[0]

    def test_unknown_table_and_clamp_notice(self):
        cfg = _validatable_base()
        cfg["storage"]["tiering"]["tables"] = ["mqtt_messages", "nodes"]
        cfg["storage"]["tiering"]["cold_after_months"] = 0
        warns = _tiering_warnings(cfg)
        assert len(warns) == 2
        assert any("storage.tiering.tables" in w and "'nodes'" in w for w in warns)
        assert any("storage.tiering.cold_after_months" in w and "clamped to 1" in w for w in warns)

    def test_non_bool_enabled(self):
        cfg = _validatable_base()
        cfg["storage"]["tiering"]["enabled"] = "true"
        warns = _tiering_warnings(cfg)
        assert len(warns) == 1 and "storage.tiering.enabled" in warns[0]
        assert maintenance.tiering_due(cfg) is False

    @pytest.mark.parametrize("wrong", ["enabled = true", ["enabled"], 3])
    def test_section_of_the_wrong_type_warns_without_crashing(self, wrong):
        cfg = _validatable_base()
        cfg["storage"]["tiering"] = wrong
        warns = _tiering_warnings(cfg)
        assert len(warns) == 1
        assert "storage.tiering" in warns[0] and "expected dict" in warns[0]
        assert TieringPolicy.from_config(cfg) == TieringPolicy()

    def test_validate_does_not_raise_for_a_broken_section(self):
        cfg = _validatable_base()
        cfg["storage"]["tiering"].update({"cold_tablespace": "x;drop", "tables": "mqtt_messages",
                                          "min_free_mb": "lots", "cold_filesystem": None})
        warns = _tiering_warnings(cfg)  # must not raise
        for key in ("cold_tablespace", "tables", "min_free_mb", "cold_filesystem"):
            assert any(f"storage.tiering.{key}" in w for w in warns), key


def test_sample_config_tiering_block_matches_defaults():
    with open(REPO_ROOT / "config.toml.sample", "rb") as f:
        sample = tomllib.load(f)
    assert sample["storage"]["tiering"] == config_mod.DEFAULT_CONFIG["storage"]["tiering"]
    assert sample["storage"]["tiering"] == {
        "enabled": False,
        "cold_after_months": 3,
        "cold_tablespace": "meshinfo_cold",
        "tables": ["mqtt_messages", "packet_receptions"],
        "max_partitions_per_cycle": 1,
        "cold_filesystem": "",
        "min_free_mb": 2048,
    }
    policy = TieringPolicy.from_config(sample)
    assert policy == TieringPolicy()
    assert policy.validate(raw=sample["storage"]["tiering"]) == []


# ── catalog model and results (pure parts) ───────────────────────────────────

class TestPartitionInfo:
    def test_monthly_partition(self):
        p = _part()
        assert p.month == datetime.date(2025, 1, 1)
        assert (p.lo, p.hi) == month_bounds(p.month)
        assert p.is_monthly() is True
        assert p.label() == "2025_01"

    def test_default_partition_is_not_monthly(self):
        p = _part(name="mqtt_messages_default", bound="DEFAULT")
        assert p.month is None and p.lo is None and p.hi is None
        assert p.is_monthly() is False
        assert p.label() == "mqtt_messages_default"

    def test_monthly_name_with_other_bounds_is_not_monthly(self):
        p = _part(bound="FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-03-01 00:00:00+00')")
        assert p.month == datetime.date(2025, 1, 1)
        assert p.is_monthly() is False

    def test_tablespaces_partial_and_on_tablespace(self):
        whole = _part(tablespace=TS, index_tablespaces={"a": TS, "b": TS})
        assert whole.tablespaces() == {TS}
        assert whole.partial() is False
        assert whole.on_tablespace(TS) is True and whole.on_tablespace("pg_default") is False
        split = _part(tablespace="pg_default", index_tablespaces={"a": TS, "b": "pg_default"})
        assert split.tablespaces() == {"pg_default", TS}
        assert split.partial() is True
        assert split.on_tablespace("pg_default") is False and split.on_tablespace(TS) is False
        bare = _part(tablespace="pg_default")  # no indexes at all
        assert bare.tablespaces() == {"pg_default"} and bare.on_tablespace("pg_default") is True


class TestResults:
    def test_move_result_as_dict_renders_dates(self):
        r = MoveResult(partition=PART, table="mqtt_messages", month=datetime.date(2025, 1, 1), target=TS,
                       status="moved", reason=f"moved to {TS}", rows=5, bytes_before=10, bytes_after=4,
                       seconds=1.5, indexes=9, deep_verified=True, kept_original=None, swap_attempts=1)
        d = r.as_dict()
        assert d["month"] == "2025-01-01"
        assert d["partition"] == PART and d["status"] == "moved" and d["rows"] == 5 and d["indexes"] == 9
        assert d["deep_verified"] is True and d["kept_original"] is None and d["swap_attempts"] == 1
        json.dumps(d)
        assert MoveResult(partition="x", table="", month=None, target=TS, status="refused").as_dict()["month"] is None

    def test_cycle_result_counts_summary_and_as_dict(self):
        results = [
            MoveResult(PART, "mqtt_messages", datetime.date(2025, 1, 1), TS, "moved",
                       rows=3, bytes_before=3000, bytes_after=1000),
            MoveResult("packet_receptions_2025_01", "packet_receptions", datetime.date(2025, 1, 1), TS, "skipped"),
            MoveResult("mqtt_messages_2025_02", "mqtt_messages", datetime.date(2025, 2, 1), TS, "refused"),
            MoveResult("mqtt_messages_2025_03", "mqtt_messages", datetime.date(2025, 3, 1), TS, "busy"),
            MoveResult("mqtt_messages_2025_04", "mqtt_messages", datetime.date(2025, 4, 1), TS, "verify-failed"),
            MoveResult("mqtt_messages_2025_05", "mqtt_messages", datetime.date(2025, 5, 1), TS, "failed"),
        ]
        cycle = CycleResult(results=results, target=TS, dry_run=False)
        assert (cycle.moved, cycle.skipped, cycle.refused, cycle.busy) == (1, 1, 1, 1)
        assert cycle.failed == 2  # verify failures are hard failures too
        summary = cycle.summary()
        for piece in (TS, "1 moved", "3 rows", "1 skipped", "1 refused", "1 busy", "2 failed"):
            assert piece in summary
        d = cycle.as_dict()
        assert d["target"] == TS and d["dry_run"] is False
        assert [r["status"] for r in d["results"]] == [r.status for r in results]
        json.dumps(d)

    def test_empty_cycle_summary(self):
        cycle = CycleResult(results=[], target=TS, dry_run=True)
        assert (cycle.moved, cycle.skipped, cycle.refused, cycle.busy, cycle.failed) == (0, 0, 0, 0, 0)
        assert "nothing to do" in cycle.summary()


# ── scheduler ────────────────────────────────────────────────────────────────

class TestTieringDue:
    def setup_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def teardown_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def test_disabled_never_due(self):
        assert maintenance.tiering_due(_tiering_cfg(enabled=False)) is False
        assert maintenance.tiering_due({}) is False
        assert maintenance.tiering_due(config_mod.DEFAULT_CONFIG) is False  # shipped default is off

    def test_enabled_is_due(self):
        assert maintenance.tiering_due(_tiering_cfg(enabled=True)) is True

    def test_non_bool_enabled_counts_as_off(self):
        assert maintenance.tiering_due(_tiering_cfg(enabled="true")) is False
        assert maintenance.tiering_due(_tiering_cfg(enabled=1)) is False

    def test_backoff_suppresses_retry(self):
        maintenance._next_tiering_attempt_monotonic = time.monotonic() + 100
        assert maintenance.tiering_due(_tiering_cfg(enabled=True)) is False

    def test_due_again_once_the_backoff_elapsed(self):
        maintenance._next_tiering_attempt_monotonic = time.monotonic() - 1
        assert maintenance.tiering_due(_tiering_cfg(enabled=True)) is True

    def test_cadence_is_hourly(self):
        assert maintenance.TIERING_INTERVAL_SEC == 3600


class TestRunTiering:
    def setup_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def teardown_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def test_unreachable_database_returns_none_and_arms_backoff(self, caplog):
        cfg = {"storage": {"postgres": {"host": "127.0.0.1", "port": 1, "username": "u",
                                        "password": "p", "database": "meshinfo"},
                           "tiering": {"enabled": True}}}
        assert maintenance.tiering_due(cfg) is True
        started = time.monotonic()
        with caplog.at_level(logging.WARNING, logger="maintenance"):
            result = asyncio.run(maintenance.run_tiering(cfg))
        elapsed = time.monotonic() - started
        assert result is None
        assert elapsed < 20  # connection refused, not the 30 s connect timeout
        # The backoff is armed at the START of the run, one interval out.
        nxt = maintenance._next_tiering_attempt_monotonic
        assert started + maintenance.TIERING_INTERVAL_SEC <= nxt <= started + elapsed + maintenance.TIERING_INTERVAL_SEC
        assert maintenance.tiering_due(cfg) is False
        assert any(r.levelno >= logging.WARNING and "tiering" in r.getMessage() for r in caplog.records)


# ── review additions: predicate detection, constraint characteristics ────────

class TestCloneIndexSqlPredicateDetection:
    """The partial-index predicate is the top-level WHERE; a ' WHERE ' inside an
    expression literal or a quoted identifier must never attract TABLESPACE."""

    def test_where_inside_a_literal_is_not_the_predicate(self):
        sql = clone_index_sql(
            f"CREATE INDEX i ON public.{PART} USING btree ((topic || ' WHERE '::text))",
            new_index="s", new_table=REP, tablespace=TS)
        assert sql == f'CREATE INDEX "s" ON "{REP}" USING btree ((topic || \' WHERE \'::text)) TABLESPACE "{TS}"'

    def test_literal_and_real_predicate(self):
        sql = clone_index_sql(
            f"CREATE INDEX i ON public.{PART} USING btree ((topic || ' WHERE '::text)) WHERE (topic IS NOT NULL)",
            new_index="s", new_table=REP, tablespace=TS)
        assert sql.endswith(f'TABLESPACE "{TS}" WHERE (topic IS NOT NULL)')
        assert sql.count("TABLESPACE") == 1
        assert "' WHERE '::text)) TABLESPACE" in sql

    def test_doubled_quote_inside_a_literal(self):
        sql = clone_index_sql(
            f"CREATE INDEX i ON public.{PART} USING btree ((topic || 'it''s WHERE '::text)) WHERE (id > 0)",
            new_index="s", new_table=REP, tablespace=TS)
        assert sql.endswith(f'TABLESPACE "{TS}" WHERE (id > 0)') and sql.count("TABLESPACE") == 1

    def test_where_inside_a_quoted_identifier(self):
        sql = clone_index_sql(
            f'CREATE INDEX i ON public.{PART} USING btree (" WHERE ")',
            new_index="s", new_table=REP, tablespace=TS)
        assert sql == f'CREATE INDEX "s" ON "{REP}" USING btree (" WHERE ") TABLESPACE "{TS}"'


class TestConstraintCharacteristics:
    @pytest.mark.parametrize("tail", [
        "DEFERRABLE", "DEFERRABLE INITIALLY DEFERRED", "NOT DEFERRABLE INITIALLY IMMEDIATE",
    ])
    def test_using_index_tablespace_precedes_the_characteristics(self, tail):
        sql = constraint_index_sql("t", "c", f"PRIMARY KEY (id, created_at) {tail}", TS)
        assert sql == (f'ALTER TABLE "t" ADD CONSTRAINT "c" PRIMARY KEY (id, created_at) '
                       f'USING INDEX TABLESPACE "{TS}" {tail}')

    def test_plain_definition_keeps_the_clause_last(self):
        assert constraint_index_sql("t", "c", "UNIQUE (a)", TS).endswith(f'UNIQUE (a) USING INDEX TABLESPACE "{TS}"')


# ── review additions: planning and cycle semantics without a database ────────

NOW = datetime.datetime(2026, 11, 3, 12, 0, tzinfo=datetime.timezone.utc)


def _fake_catalog(monkeypatch, parts, default_ts="pg_default", now=NOW):
    """plan()/run_cycle() read the catalog through three module functions; stub
    them so the eligibility/ordering logic runs against hand-made PartitionInfos."""
    async def _default(conn):
        return default_ts

    async def _now(conn):
        return now

    async def _list(conn, tables):
        chosen = [p for p in parts if p.table in tuple(tables)]
        chosen.sort(key=lambda p: (p.month or datetime.date.max, TIERABLE_TABLES.index(p.table), p.name))
        return chosen

    async def _session(conn):
        return None

    monkeypatch.setattr(tiering_mod, "default_tablespace", _default)
    monkeypatch.setattr(tiering_mod, "db_now", _now)
    monkeypatch.setattr(tiering_mod, "list_all_partitions", _list)
    monkeypatch.setattr(tiering_mod, "set_session", _session)


def _catalog():
    return [
        _part("mqtt_messages_2026_07"),
        _part("packet_receptions_2026_07", table="packet_receptions"),
        _part("mqtt_messages_2026_08"),                                        # closed, still hot (n=3)
        _part("mqtt_messages_2026_11"),                                        # current month
        _part("mqtt_messages_2026_06", tablespace=TS, index_tablespaces={"i": TS}),  # already cold-tiered
        _part("mqtt_messages_2026_05", index_tablespaces={"i": TS}),          # partial: table hot, index cold
        _part("mqtt_messages_default"),                                        # DEFAULT partition
    ]


class TestPlanSemantics:
    def test_ordering_eligibility_and_reasons(self, monkeypatch):
        _fake_catalog(monkeypatch, _catalog())
        items = asyncio.run(plan(None, TieringPolicy(cold_tablespace=TS, cold_after_months=3)))
        assert [i.partition.name for i in items] == [
            "mqtt_messages_2026_05", "mqtt_messages_2026_07", "packet_receptions_2026_07"]
        assert items[0].reason.startswith("cold") and "partial" in items[0].reason
        assert all(i.target == TS for i in items)

    def test_closed_month_boundary_is_the_utc_month_start(self, monkeypatch):
        on_cold = _part("mqtt_messages_2026_10", tablespace=TS, index_tablespaces={"i": TS})
        on_hot = _part("packet_receptions_2026_10", table="packet_receptions")
        policy = TieringPolicy(cold_tablespace=TS, cold_after_months=1)
        just_before = datetime.datetime(2026, 10, 31, 23, 59, 59, tzinfo=datetime.timezone.utc)
        at_boundary = datetime.datetime(2026, 11, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)
        _fake_catalog(monkeypatch, [on_cold, on_hot], now=just_before)
        assert asyncio.run(plan(None, policy, target="pg_default")) == []            # October not closed
        assert asyncio.run(plan(None, policy)) == []
        _fake_catalog(monkeypatch, [on_cold, on_hot], now=at_boundary)
        assert [i.partition.name for i in asyncio.run(plan(None, policy, target="pg_default"))] == [
            "mqtt_messages_2026_10"]                                                # closed: back to default ok
        assert asyncio.run(plan(None, policy)) == []                                 # closed but not cold (n=1)

    def test_move_back_rule(self, monkeypatch):
        parts = [_part("mqtt_messages_2026_08", tablespace=TS, index_tablespaces={"i": TS})]
        policy = TieringPolicy(cold_tablespace=TS, cold_after_months=3)
        _fake_catalog(monkeypatch, parts)
        back = asyncio.run(plan(None, policy, target="pg_default"))
        assert [(i.partition.name, i.target) for i in back] == [("mqtt_messages_2026_08", "pg_default")]
        assert back[0].reason.startswith("closed")
        # Any other tablespace is a cold-only destination.
        assert asyncio.run(plan(None, policy, target="other_cold")) == []

    def test_limit_and_only(self, monkeypatch):
        _fake_catalog(monkeypatch, _catalog())
        policy = TieringPolicy(cold_tablespace=TS, cold_after_months=3)
        assert asyncio.run(plan(None, policy, limit=0)) == []
        assert [i.partition.name for i in asyncio.run(plan(None, policy, limit=1))] == ["mqtt_messages_2026_05"]
        only = asyncio.run(plan(None, policy, only=["packet_receptions_2026_07", "mqtt_messages_2026_11", "nope"]))
        assert [i.partition.name for i in only] == ["packet_receptions_2026_07"]


class TestRunCycleSemantics:
    """Cap counts only moved/dry-run; refusals continue; busy, verify failures
    and unexpected errors stop the cycle; unknown names are refused."""

    def _cycle(self, monkeypatch, outcomes, **kwargs):
        parts = [_part(name) for name in outcomes]
        _fake_catalog(monkeypatch, parts)
        calls = []

        async def fake_move(conn, part, target, *, policy, dry_run=False, keep_original=False,
                            deep_verify=False, now=None):
            calls.append(part.name)
            outcome = outcomes[part.name]
            if isinstance(outcome, Exception):
                raise outcome
            return MoveResult(partition=part.name, table=part.table, month=part.month, target=target,
                              status=outcome, rows=1)

        monkeypatch.setattr(tiering_mod, "move_partition", fake_move)
        seen = []
        policy = TieringPolicy(cold_tablespace=TS, cold_after_months=3)
        cycle = asyncio.run(run_cycle(None, policy, on_result=seen.append, **kwargs))
        assert [r.partition for r in seen] == [r.partition for r in cycle.results]
        return cycle, calls

    def test_cap_counts_only_moves_and_refusals_continue(self, monkeypatch):
        cycle, calls = self._cycle(monkeypatch, {
            "mqtt_messages_2026_01": TieringRefused("backfill pending"),
            "mqtt_messages_2026_02": "skipped",
            "mqtt_messages_2026_03": "moved",
            "mqtt_messages_2026_04": "moved",
        }, max_partitions=1)
        assert calls == ["mqtt_messages_2026_01", "mqtt_messages_2026_02", "mqtt_messages_2026_03"]
        assert [r.status for r in cycle.results] == ["refused", "skipped", "moved"]
        assert (cycle.refused, cycle.skipped, cycle.moved) == (1, 1, 1)

    def test_busy_stops_the_cycle(self, monkeypatch):
        cycle, calls = self._cycle(monkeypatch, {
            "mqtt_messages_2026_01": TieringBusy("locked"),
            "mqtt_messages_2026_02": "moved",
        }, max_partitions=0)
        assert calls == ["mqtt_messages_2026_01"]
        assert [r.status for r in cycle.results] == ["busy"] and cycle.busy == 1

    def test_verify_failure_and_unexpected_error_stop(self, monkeypatch):
        cycle, calls = self._cycle(monkeypatch, {
            "mqtt_messages_2026_01": TieringVerifyError("digest"),
            "mqtt_messages_2026_02": "moved",
        }, max_partitions=0)
        assert calls == ["mqtt_messages_2026_01"] and [r.status for r in cycle.results] == ["verify-failed"]
        cycle, calls = self._cycle(monkeypatch, {
            "mqtt_messages_2026_01": RuntimeError("boom"),
            "mqtt_messages_2026_02": "moved",
        }, max_partitions=0)
        assert calls == ["mqtt_messages_2026_01"] and [r.status for r in cycle.results] == ["failed"]
        assert "RuntimeError" in cycle.results[0].reason and cycle.failed == 1

    def test_dry_run_counts_toward_the_cap(self, monkeypatch):
        cycle, calls = self._cycle(monkeypatch, {
            "mqtt_messages_2026_01": "dry-run", "mqtt_messages_2026_02": "dry-run",
        }, dry_run=True, max_partitions=1)
        assert calls == ["mqtt_messages_2026_01"] and cycle.planned == 1 and cycle.moved == 0

    def test_unknown_name_in_only_is_refused(self, monkeypatch):
        cycle, calls = self._cycle(monkeypatch, {"mqtt_messages_2026_01": "moved"},
                                   only=["mqtt_messages_2026_09", "mqtt_messages_2026_01"], max_partitions=0)
        assert calls == ["mqtt_messages_2026_01"]
        assert [(r.partition, r.status, r.table) for r in cycle.results] == [
            ("mqtt_messages_2026_09", "refused", "mqtt_messages"), ("mqtt_messages_2026_01", "moved", "mqtt_messages")]


class TestRunTieringContract:
    """run_tiering never raises, always closes its dedicated connection, and
    opens it without a command timeout."""

    def setup_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def teardown_method(self):
        maintenance._next_tiering_attempt_monotonic = 0.0

    def _wire(self, monkeypatch, cycle):
        closed = []

        class FakeConn:
            async def close(self, timeout=None):
                closed.append(timeout)

        async def fake_connect(**kwargs):
            assert kwargs["command_timeout"] is None
            return FakeConn()

        async def fake_cycle(conn, policy):
            if isinstance(cycle, Exception):
                raise cycle
            return cycle

        monkeypatch.setattr(maintenance.asyncpg, "connect", fake_connect)
        monkeypatch.setattr(maintenance, "run_cycle", fake_cycle)
        return closed

    def test_unexpected_error_returns_none_and_closes(self, monkeypatch, caplog):
        closed = self._wire(monkeypatch, RuntimeError("kaboom"))
        cfg = _tiering_cfg(enabled=True)
        with caplog.at_level(logging.WARNING, logger="maintenance"):
            assert asyncio.run(maintenance.run_tiering(cfg)) is None
        assert closed == [10]
        assert maintenance.tiering_due(cfg) is False
        assert any("kaboom" in r.getMessage() or r.exc_info for r in caplog.records)

    def test_success_returns_the_cycle_and_closes(self, monkeypatch):
        result = CycleResult(results=[], target=TS, dry_run=False)
        closed = self._wire(monkeypatch, result)
        assert asyncio.run(maintenance.run_tiering(_tiering_cfg(enabled=True))) is result
        assert closed == [10]
