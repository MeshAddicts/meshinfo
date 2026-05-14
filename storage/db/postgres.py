#!/usr/bin/env python3
"""
PostgreSQL storage backend for MeshInfo.

This module provides real-time write capabilities to PostgreSQL while maintaining
the exact same data structure as JSON files for API compatibility.
"""

import asyncpg
import datetime
import json
import logging
import base64
from typing import Any, Dict, Optional, List, Tuple
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)


class PostgresStorage:
    """PostgreSQL storage backend with connection pooling and error handling."""

    # Maps telemetry payload field names to their Postgres column names in
    # node_telemetry_current. Used by _write_node_telemetry_current to build
    # partial updates so that a device_metrics message never NULLs out
    # environment_metrics columns and vice versa.
    TELEMETRY_COLUMNS = {
        # device_metrics fields
        "battery_level": "battery_level",
        "voltage": "voltage",
        "channel_utilization": "channel_utilization",
        "air_util_tx": "air_util_tx",
        "uptime_seconds": "uptime_seconds",
        # environment_metrics fields
        "temperature": "temperature",
        "relative_humidity": "relative_humidity",
        "barometric_pressure": "barometric_pressure",
        "gas_resistance": "gas_resistance",
        "iaq": "iaq",
        "distance": "distance",
        "lux": "lux",
        "white_lux": "white_lux",
        "ir_lux": "ir_lux",
        "uv_lux": "uv_lux",
        "wind_direction": "wind_direction",
        "wind_speed": "wind_speed",
        "weight": "weight",
        "current": "current",
        "wind_gust": "wind_gust",
        "wind_lull": "wind_lull",
        "radiation": "radiation",
        "rainfall_1h": "rainfall_1h",
        "rainfall_24h": "rainfall_24h",
        "soil_moisture": "soil_moisture",
        "soil_temperature": "soil_temperature",
    }

    # Telemetry variant names (from protobuf WhichOneof) that are stored as
    # JSONB columns on node_telemetry_current rather than as individual typed
    # columns. The dict value is the Postgres column name.
    TELEMETRY_JSONB_VARIANTS = {
        "power_metrics": "power_metrics",
        "air_quality_metrics": "air_quality_metrics",
        "local_stats": "local_stats",
        "health_metrics": "health_metrics",
        "host_metrics": "host_metrics",
        "traffic_management_stats": "traffic_management_stats",
    }

    # All typed telemetry field names used in read queries. Derived directly
    # from TELEMETRY_COLUMNS to stay in sync — adding a new field to
    # TELEMETRY_COLUMNS automatically includes it here.
    _TYPED_TELEMETRY_FIELDS = list(TELEMETRY_COLUMNS.values())

    def __init__(self, config: Dict[str, Any]):
        """Initialize Postgres storage with configuration."""
        self.config = config
        self.pg_config = config.get("storage", {}).get("postgres", {})
        self.enabled = self.pg_config.get("enabled", False)
        self.pool: Optional[asyncpg.Pool] = None
        self.timezone = config["server"]["timezone"]

        # Optional: enable to make migrations "honest" (fail fast / count failures correctly)
        self.raise_on_write_error = bool(self.pg_config.get("raise_on_write_error", False))

    async def connect(self) -> bool:
        """
        Establish connection pool to PostgreSQL.

        Returns:
            bool: True if connection successful, False otherwise
        """
        if not self.enabled:
            logger.info("PostgreSQL storage is disabled in config")
            return False

        # Idempotent: don't recreate the pool if we already have one.
        if self.pool is not None:
            return True

        try:
            self.pool = await asyncpg.create_pool(
                host=self.pg_config.get("host", "postgres"),
                port=self.pg_config.get("port", 5432),
                database=self.pg_config.get("database", "meshinfo"),
                user=self.pg_config.get("username", "postgres"),
                password=self.pg_config.get("password", "password"),
                min_size=self.pg_config.get("min_pool_size", 5),
                max_size=self.pg_config.get("max_pool_size", 20),
                command_timeout=10,
            )
            logger.info("PostgreSQL connection pool established")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to PostgreSQL: {e}")
            # Disable postgres mode to prevent repeated attempts elsewhere
            self.enabled = False
            self.pool = None
            return False

    async def close(self):
        """Close the connection pool."""
        if self.pool is not None:
            try:
                await self.pool.close()
            finally:
                self.pool = None
            logger.info("PostgreSQL connection pool closed")

    async def ensure_schema(self):
        """Ensure database schema is created."""
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                # Read and execute schema file
                with open("postgres/sql/schema.sql", "r") as f:
                    schema_sql = f.read()
                await conn.execute(schema_sql)
                logger.info("PostgreSQL schema verified/created")
        except Exception as e:
            logger.error(f"Failed to ensure schema: {e}")
            if self.raise_on_write_error:
                raise

        # Migrations — idempotent column additions for existing databases.
        # Run independently so they succeed even if schema.sql execution fails.
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    ALTER TABLE nodes ADD COLUMN IF NOT EXISTS gateway VARCHAR(8);
                    ALTER TABLE mqtt_messages ADD COLUMN IF NOT EXISTS from_node_id VARCHAR(8);
                    ALTER TABLE mqtt_messages ADD COLUMN IF NOT EXISTS to_node_id VARCHAR(8);
                """)
                await conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_mqtt_messages_from_node_id
                        ON mqtt_messages(from_node_id, created_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_mqtt_messages_to_node_id
                        ON mqtt_messages(to_node_id, created_at DESC);
                """)
                # Partial index so the backfill query can quickly find
                # un-processed rows instead of seq-scanning millions.
                # Use a longer timeout — initial creation scans the whole table.
                await conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_mqtt_messages_backfill
                        ON mqtt_messages(id)
                        WHERE from_node_id IS NULL;
                """, timeout=300)
        except Exception as e:
            logger.error(f"Failed to run migrations: {e}")
            if self.raise_on_write_error:
                raise

        # Mqtt node-ID trigger + backfill — run independently so a failure here
        # does not prevent the core schema from being applied.
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    CREATE OR REPLACE FUNCTION mqtt_messages_extract_node_ids()
                    RETURNS TRIGGER AS $fn$
                    DECLARE
                        v_from TEXT;
                        v_to TEXT;
                    BEGIN
                        IF (NEW.from_node_id IS NULL OR NEW.to_node_id IS NULL) AND NEW.payload IS NOT NULL AND NEW.payload ~ '^\\s*\\{' THEN
                            BEGIN
                                v_from := NEW.payload::jsonb ->> 'from';
                                v_to   := NEW.payload::jsonb ->> 'to';
                                IF NEW.from_node_id IS NULL AND v_from IS NOT NULL THEN
                                    IF v_from ~ '^[0-9]+$' THEN
                                        NEW.from_node_id := lpad(to_hex(v_from::bigint), 8, '0');
                                    ELSE
                                        NEW.from_node_id := left(regexp_replace(v_from, '^!', ''), 8);
                                    END IF;
                                END IF;
                                IF NEW.to_node_id IS NULL AND v_to IS NOT NULL THEN
                                    IF v_to ~ '^[0-9]+$' THEN
                                        NEW.to_node_id := lpad(to_hex(v_to::bigint), 8, '0');
                                    ELSE
                                        NEW.to_node_id := left(regexp_replace(v_to, '^!', ''), 8);
                                    END IF;
                                END IF;
                            EXCEPTION WHEN OTHERS THEN
                                NULL;
                            END;
                        END IF;
                        RETURN NEW;
                    END;
                    $fn$ LANGUAGE plpgsql;
                """)
                await conn.execute("""
                    DROP TRIGGER IF EXISTS trg_mqtt_messages_extract_node_ids ON mqtt_messages;
                """)
                await conn.execute("""
                    CREATE TRIGGER trg_mqtt_messages_extract_node_ids
                        BEFORE INSERT ON mqtt_messages
                        FOR EACH ROW
                        EXECUTE FUNCTION mqtt_messages_extract_node_ids();
                """)
                logger.info("MQTT node-ID trigger installed")
        except Exception as e:
            logger.warning(f"MQTT node-ID trigger setup skipped: {e}")

        # Backfill existing rows in the background — don't block startup
        import asyncio
        asyncio.ensure_future(self._backfill_mqtt_node_ids())

    async def _backfill_mqtt_node_ids(self):
        """Backfill from_node_id/to_node_id for existing mqtt_messages rows in batches."""
        BATCH = 5000
        total = 0
        try:
            while True:
                async with self.pool.acquire() as conn:
                    # Override the pool-level command_timeout (10s) — backfill
                    # batches can take longer on large tables.
                    await conn.execute("SET statement_timeout = '120s'", timeout=120)
                    # Fetch candidate IDs and parse in Python to skip bad payloads
                    rows = await conn.fetch("""
                        SELECT id, payload
                        FROM mqtt_messages
                        WHERE from_node_id IS NULL
                          AND payload IS NOT NULL
                          AND payload ~ '^\\s*\\{'
                        LIMIT $1
                    """, BATCH, timeout=120)
                    if not rows:
                        break
                    updates = []
                    for row in rows:
                        try:
                            j = json.loads(row["payload"])
                        except Exception:
                            # Mark as processed with empty node IDs so we don't retry
                            updates.append((row["id"], "", ""))
                            continue
                        fid = self._normalize_node_id(j.get("from")) or ""
                        tid = self._normalize_node_id(j.get("to")) or ""
                        updates.append((row["id"], fid, tid))
                    if updates:
                        await conn.executemany("""
                            UPDATE mqtt_messages
                            SET from_node_id = $2, to_node_id = $3
                            WHERE id = $1
                        """, updates, timeout=120)
                    total += len(updates)
                    if len(updates) < BATCH:
                        break
            if total > 0:
                logger.info(f"MQTT node-ID backfill complete: {total} rows updated")
            else:
                logger.info("MQTT node-ID backfill: nothing to do")
        except Exception as e:
            logger.warning(f"MQTT node-ID backfill failed after {total} rows: {type(e).__name__}: {e}")

    # --------------------------- readiness helper ---------------------------

    def _ready(self, op: str) -> bool:
        """
        Return True if Postgres is enabled and the pool is initialized.
        Logs a warning when Postgres is enabled but connect() hasn't run yet.
        """
        if not self.enabled:
            return False
        if self.pool is None:
            logger.warning(
                "%s: Postgres enabled but pool is not initialized (connect() not called yet). Dropping operation.",
                op,
            )
            return False
        return True

    def _normalize_node_id(self, value: Any) -> Optional[str]:
        """
        Normalize node ids to the 8-char lowercase hex string used by the schema.
        Accepts int (uint32), decimal strings, hex strings, and strings with leading '!'.
        Rejects hex strings longer than 8 chars (avoids silent truncation/collisions).
        """
        if value is None:
            return None

        if isinstance(value, int):
            return f"{value & 0xFFFFFFFF:08x}"

        if isinstance(value, str):
            v = value.strip()
            if not v:
                return None

            if v.startswith("!"):
                v = v[1:].strip()
                if not v:
                    return None

            if v.startswith(("0x", "0X")):
                try:
                    return f"{int(v, 16) & 0xFFFFFFFF:08x}"
                except ValueError:
                    return None

            v = v.lower()
            if all(c in "0123456789abcdef" for c in v):
                if len(v) < 8:
                    return v.zfill(8)
                if len(v) == 8:
                    return v
                # Explicit: too long to be a uint32 / schema node id
                return None

        return None

    async def _ensure_node_stub(self, conn: asyncpg.Connection, node_id: Any) -> Optional[str]:
        """
        Ensure a node row exists for FK constraints. Creates a stub if missing.
        Returns normalized node_id (or None if not representable).
        """
        nid = self._normalize_node_id(node_id)
        if not nid:
            return None

        await conn.execute(
            """
            INSERT INTO nodes (id, active)
            VALUES ($1, FALSE)
            ON CONFLICT (id) DO NOTHING
            """,
            nid,
        )
        return nid

    def _ts_to_dt(self, ts: Any) -> Optional[datetime.datetime]:
        if ts is None:
            return None
        try:
            t = int(ts)
        except (TypeError, ValueError):
            return None

        # Heuristic: milliseconds are ~1.7e12 today; seconds are ~1.7e9
        if t > 10_000_000_000:
            t = t / 1000.0

        return datetime.datetime.fromtimestamp(t, tz=ZoneInfo(self.timezone))

    def _jsonb(self, v: Any, default):
        """
        Safe JSONB reader:
        - asyncpg may return json/jsonb as str OR as dict/list depending on codecs.
        """
        if v is None:
            return default
        if isinstance(v, (dict, list)):
            return v
        if isinstance(v, str):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return default
        return default

    # --------------------------- telemetry read helper ---------------------------

    def _build_telemetry_dict_from_row(self, row) -> Optional[Dict[str, Any]]:
        """
        Build a telemetry dict from a node_telemetry_current row.
        Merges typed columns and JSONB variant columns into a single dict.
        Used by load_nodes() and query_nodes_filtered() to avoid duplication.

        If a JSONB variant field collides with an already-populated typed column
        key, the existing value is kept and a debug warning is logged. This
        mirrors the protobuf oneof guarantee (no real collisions expected) but
        guards against malformed data silently overwriting values.
        """
        telemetry: Dict[str, Any] = {}

        # Typed columns (device_metrics + environment_metrics fields)
        for field in self._TYPED_TELEMETRY_FIELDS:
            val = row.get(field)
            if val is not None:
                telemetry[field] = val

        # JSONB variant columns — merge their fields into the flat dict
        # so the API response stays compatible with the in-memory structure.
        # If a field name collides with an existing key, keep the original
        # value and log a debug warning to avoid silent overwrites.
        for variant_name, col_name in self.TELEMETRY_JSONB_VARIANTS.items():
            variant_data = self._jsonb(row.get(col_name), None)
            if variant_data and isinstance(variant_data, dict):
                for key, value in variant_data.items():
                    if key in telemetry:
                        logger.debug(
                            "Telemetry key collision for '%s' in variant '%s'; keeping existing value.",
                            key,
                            variant_name,
                        )
                        continue
                    telemetry[key] = value

        return telemetry if telemetry else None

    # ============================================================================
    # WRITE OPERATIONS - Real-time writes for dual-write pattern
    # ============================================================================

    async def write_node(self, node_id: str, node_data: Dict[str, Any]):
        """
        Write/update a node to PostgreSQL in real-time.

        Args:
            node_id: node id (any supported form; will be normalized)
            node_data: Complete node data dictionary
        """
        if not self._ready("write_node"):
            return

        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    node_id_norm = await self._ensure_node_stub(conn, node_id)
                    if not node_id_norm:
                        logger.warning(f"write_node: could not normalize node_id={node_id!r}, skipping")
                        return

                    last_seen = node_data.get("last_seen")
                    if isinstance(last_seen, str):
                        try:
                            last_seen_ts = datetime.datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                        except Exception:
                            last_seen_ts = None
                    elif isinstance(last_seen, datetime.datetime):
                        last_seen_ts = last_seen
                    else:
                        last_seen_ts = None

                    since = node_data.get("since")
                    since_seconds = since.total_seconds() if since else None

                    longname = node_data.get("longname")
                    if longname is not None and not isinstance(longname, str):
                        longname = str(longname)

                    shortname = node_data.get("shortname")
                    if shortname is not None and not isinstance(shortname, str):
                        shortname = str(shortname)

                    hardware = node_data.get("hardware")
                    if hardware is not None and not isinstance(hardware, str):
                        hardware = str(hardware)

                    role = node_data.get("role")
                    role_raw = role
                    if isinstance(role, str):
                        role = int(role) if role.isdigit() else None
                    elif role is not None and not isinstance(role, int):
                        try:
                            role = int(role)
                        except (TypeError, ValueError):
                            role = None

                    if role is None and role_raw not in (None, "", 0):
                        logger.debug("Invalid role %r for node %s; storing NULL", role_raw, node_id_norm)

                    last_channel = node_data.get("last_channel")
                    if last_channel is not None:
                        last_channel = str(last_channel)

                    await conn.execute(
                        """
                        INSERT INTO nodes (id, longname, shortname, hardware, role, active, tc2_bbs, gateway, last_seen, since_seconds, last_channel)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (id) DO UPDATE SET
                            longname = EXCLUDED.longname,
                            shortname = EXCLUDED.shortname,
                            hardware = EXCLUDED.hardware,
                            role = EXCLUDED.role,
                            active = EXCLUDED.active,
                            tc2_bbs = EXCLUDED.tc2_bbs,
                            gateway = COALESCE(EXCLUDED.gateway, nodes.gateway),
                            last_seen = EXCLUDED.last_seen,
                            since_seconds = EXCLUDED.since_seconds,
                            last_channel = COALESCE(EXCLUDED.last_channel, nodes.last_channel),
                            updated_at = NOW()
                        """,
                        node_id_norm,
                        longname,
                        shortname,
                        hardware,
                        role,
                        node_data.get("active", False),
                        node_data.get("tc2_bbs", False),
                        self._normalize_node_id(node_data.get("gateway")),
                        last_seen_ts,
                        since_seconds,
                        last_channel,
                    )

                    if node_data.get("position"):
                        await self._write_node_position(conn, node_id_norm, node_data["position"])

                    if node_data.get("neighborinfo"):
                        await self._write_node_neighborinfo(conn, node_id_norm, node_data["neighborinfo"])

                    if node_data.get("telemetry"):
                        await self._write_node_telemetry_current(conn, node_id_norm, node_data["telemetry"])

        except Exception as e:
            logger.error(f"Failed to write node to PostgreSQL: {e}")
            if self.raise_on_write_error:
                raise

    async def _write_node_position(self, conn, node_id: str, position: Dict[str, Any]):
        """Write/replace node position data (latest only)."""
        geocoded = json.dumps(position.get("geocoded")) if position.get("geocoded") else None

        last_geocoding = position.get("last_geocoding")
        if isinstance(last_geocoding, str):
            try:
                last_geocoding = datetime.datetime.fromisoformat(last_geocoding.replace("Z", "+00:00"))
            except Exception:
                last_geocoding = None

        pos_time = position.get("time")
        if isinstance(pos_time, str):
            try:
                pos_time = int(pos_time)
            except Exception:
                pos_time = None
        elif pos_time is not None and not isinstance(pos_time, int):
            try:
                pos_time = int(pos_time)
            except Exception:
                pos_time = None

        await conn.execute(
            """
            INSERT INTO node_positions (
                node_id, latitude_i, longitude_i, altitude, time, precision_bits, geocoded, last_geocoding
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
            ON CONFLICT (node_id) DO UPDATE SET
                latitude_i = EXCLUDED.latitude_i,
                longitude_i = EXCLUDED.longitude_i,
                altitude = EXCLUDED.altitude,
                time = EXCLUDED.time,
                precision_bits = EXCLUDED.precision_bits,
                geocoded = EXCLUDED.geocoded,
                last_geocoding = EXCLUDED.last_geocoding
            WHERE
                -- normal case: only accept newer-or-equal timestamps
                (EXCLUDED.time IS NOT NULL AND (node_positions.time IS NULL OR EXCLUDED.time >= node_positions.time))
                OR
                -- if both are NULL, allow the update
                (EXCLUDED.time IS NULL AND node_positions.time IS NULL)
            """,
            node_id,
            position.get("latitude_i"),
            position.get("longitude_i"),
            position.get("altitude"),
            pos_time,
            position.get("precision_bits"),
            geocoded,
            last_geocoding,
        )

    async def _write_node_neighborinfo(self, conn, node_id: str, neighborinfo: Dict[str, Any]):
        """Write node neighborinfo data (latest snapshot per node) + optional history snapshots."""
        neighbors_json = json.dumps(neighborinfo.get("neighbors", []), ensure_ascii=False)

        await conn.execute(
            """
            WITH upsert AS (
                INSERT INTO node_neighborinfo (node_id, node_broadcast_interval_secs, neighbors)
                VALUES ($1, $2, $3::jsonb)
                ON CONFLICT (node_id) DO UPDATE SET
                    node_broadcast_interval_secs = EXCLUDED.node_broadcast_interval_secs,
                    neighbors = EXCLUDED.neighbors
                WHERE
                    node_neighborinfo.node_broadcast_interval_secs IS DISTINCT FROM EXCLUDED.node_broadcast_interval_secs
                    OR node_neighborinfo.neighbors IS DISTINCT FROM EXCLUDED.neighbors
                RETURNING 1
            )
            INSERT INTO node_neighborinfo_history (node_id, neighbors)
            SELECT $1, $3::jsonb
            WHERE EXISTS (SELECT 1 FROM upsert);
            """,
            node_id,
            neighborinfo.get("node_broadcast_interval_secs"),
            neighbors_json,
        )

    async def _write_node_telemetry_current(self, conn, node_id: str, telemetry: Dict[str, Any],
                                             telemetry_type: Optional[str] = None):
        """
        Write current node telemetry state (latest snapshot per node).

        Uses a partial update strategy: only columns whose keys are present
        in the incoming telemetry dict are written. This prevents a
        device_metrics message from NULLing out environment_metrics columns
        and vice versa.

        For JSONB variant types (power_metrics, air_quality_metrics, etc.),
        the entire payload is stored as a JSONB blob in the corresponding column.
        """
        # Normalize + ensure FK target exists
        node_norm = await self._ensure_node_stub(conn, node_id)
        if not node_norm:
            logger.warning("_write_node_telemetry_current: could not normalize node_id=%r; skipping", node_id)
            return

        # Check if this is a JSONB variant type
        if telemetry_type and telemetry_type in self.TELEMETRY_JSONB_VARIANTS:
            col_name = self.TELEMETRY_JSONB_VARIANTS[telemetry_type]
            payload_json = json.dumps(telemetry, ensure_ascii=False)

            sql = f"""
                INSERT INTO node_telemetry_current (node_id, {col_name})
                VALUES ($1, $2::jsonb)
                ON CONFLICT (node_id) DO UPDATE SET
                    {col_name} = EXCLUDED.{col_name},
                    updated_at = NOW()
                WHERE
                    node_telemetry_current.{col_name} IS DISTINCT FROM EXCLUDED.{col_name}
            """
            await conn.execute(sql, node_norm, payload_json)
            return

        # Otherwise, handle typed columns (device_metrics / environment_metrics)
        # Collect only the columns that are actually present in this payload.
        # We intentionally include keys whose value is None — that means the
        # protobuf explicitly sent a zero/null for that field, which we should
        # store. But we skip keys that aren't in the payload at all.
        present: Dict[str, Any] = {}
        for payload_key, col_name in self.TELEMETRY_COLUMNS.items():
            if payload_key in telemetry:
                present[col_name] = telemetry[payload_key]

        if not present:
            logger.debug("_write_node_telemetry_current: no recognized telemetry fields for node %s; skipping", node_norm)
            return

        # Build dynamic SQL for the partial upsert.
        # INSERT creates the row with only the present columns (others default to NULL).
        # ON CONFLICT updates only the present columns, leaving the rest untouched.
        col_names = list(present.keys())
        col_values = list(present.values())

        # Parameter numbers: $1 = node_id, $2.. = column values
        insert_cols = ["node_id"] + col_names
        insert_placeholders = ", ".join(f"${i}" for i in range(1, len(insert_cols) + 1))
        insert_cols_str = ", ".join(insert_cols)

        # Build SET clause for ON CONFLICT: only update the present columns
        set_parts = []
        where_parts = []
        for col in col_names:
            set_parts.append(f"{col} = EXCLUDED.{col}")
            where_parts.append(f"node_telemetry_current.{col} IS DISTINCT FROM EXCLUDED.{col}")

        set_parts.append("updated_at = NOW()")
        set_clause = ", ".join(set_parts)
        where_clause = " OR ".join(where_parts)

        sql = f"""
            INSERT INTO node_telemetry_current ({insert_cols_str})
            VALUES ({insert_placeholders})
            ON CONFLICT (node_id) DO UPDATE SET
                {set_clause}
            WHERE
                {where_clause}
        """

        await conn.execute(sql, node_norm, *col_values)

    async def write_telemetry(self, node_id: str, telemetry_msg: Dict[str, Any]) -> None:
        """
        Write telemetry message to history table.

        Args:
            node_id: from-node id (any supported form; will be normalized)
            telemetry_msg: Telemetry message dictionary (now includes 'telemetry_type')
        """
        if not self._ready("write_telemetry"):
            return

        if not isinstance(node_id, str) or not node_id:
            raise ValueError("write_telemetry: node_id must be a non-empty string")
        if not isinstance(telemetry_msg, dict):
            raise ValueError("write_telemetry: telemetry_msg must be a dict")

        try:
            async with self.pool.acquire() as conn:
                # Canonical: explicit node_id is authoritative for from_node_id
                from_id = await self._ensure_node_stub(conn, node_id)
                if not from_id:
                    logger.warning(f"write_telemetry: could not normalize node_id={node_id!r}, skipping")
                    return

                msg_from = telemetry_msg.get("from")
                if msg_from is not None:
                    msg_from_norm = await self._ensure_node_stub(conn, msg_from)
                    if msg_from_norm and msg_from_norm != from_id:
                        logger.debug(
                            "write_telemetry: msg['from']=%r (norm=%s) != explicit node_id=%r (norm=%s); using explicit",
                            msg_from,
                            msg_from_norm,
                            node_id,
                            from_id,
                        )

                sender_id = await self._ensure_node_stub(conn, telemetry_msg.get("sender"))
                to_id = await self._ensure_node_stub(conn, telemetry_msg.get("to"))

                payload_json = json.dumps(telemetry_msg.get("payload", {}))

                rx_time = self._ts_to_dt(telemetry_msg.get("timestamp"))

                # telemetry_type: "device_metrics", "environment_metrics", etc.
                telemetry_type = telemetry_msg.get("telemetry_type")

                msg_id = telemetry_msg.get("id")
                if msg_id is None:
                    logger.warning("write_telemetry: missing telemetry_msg['id']; skipping insert")
                    return
                try:
                    msg_id = int(msg_id)
                except (TypeError, ValueError):
                    logger.warning("write_telemetry: invalid telemetry_msg['id']=%r; skipping insert", msg_id)
                    return

                await conn.execute(
                    """
                    INSERT INTO telemetry (
                        from_node_id, to_node_id, sender_node_id, message_id, channel,
                        packet_id, hops_away, rssi, snr, timestamp, rx_time,
                        telemetry_type, payload
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
                    ON CONFLICT (from_node_id, message_id) DO NOTHING
                    """,
                    from_id,
                    to_id,
                    sender_id,
                    msg_id,
                    telemetry_msg.get("channel"),
                    telemetry_msg.get("packet_id"),
                    telemetry_msg.get("hops_away"),
                    telemetry_msg.get("rssi"),
                    telemetry_msg.get("snr"),
                    telemetry_msg.get("timestamp"),
                    rx_time,
                    telemetry_type,
                    payload_json,
                )

        except Exception as e:
            logger.error(f"Failed to write telemetry to PostgreSQL: {e}")
            if self.raise_on_write_error:
                raise

    async def write_chat_message(self, node_id: str, chat_msg: Dict[str, Any]) -> None:
        """
        Write chat message to PostgreSQL.

        Args:
            node_id: from-node id (any supported form; will be normalized)
            chat_msg: Chat message dictionary
        """
        if not self._ready("write_chat_message"):
            return

        if not isinstance(node_id, str) or not node_id:
            raise ValueError("write_chat_message: node_id must be a non-empty string")
        if not isinstance(chat_msg, dict):
            raise ValueError("write_chat_message: chat_msg must be a dict")

        if chat_msg.get("id") is None:
            logger.warning("write_chat_message: missing id in chat_msg; skipping insert")
            return

        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    # Canonical: explicit node_id is authoritative for from_node_id
                    from_id = await self._ensure_node_stub(conn, node_id)
                    if not from_id:
                        logger.warning(f"write_chat_message: could not normalize node_id={node_id!r}, skipping")
                        return

                    msg_from = chat_msg.get("from")
                    if msg_from is not None:
                        msg_from_norm = await self._ensure_node_stub(conn, msg_from)
                        if msg_from_norm and msg_from_norm != from_id:
                            logger.debug(
                                "write_chat_message: msg['from']=%r (norm=%s) != explicit node_id=%r (norm=%s); using explicit",
                                msg_from,
                                msg_from_norm,
                                node_id,
                                from_id,
                            )

                    sender_id = await self._ensure_node_stub(conn, chat_msg.get("sender"))
                    to_id = await self._ensure_node_stub(conn, chat_msg.get("to"))

                    # Ensure channel exists
                    channel_id = str(chat_msg.get("channel", "0"))
                    channel_name = f"Channel {channel_id}" if channel_id != "0" else "General"

                    await conn.execute(
                        """
                        INSERT INTO chat_channels (id, name)
                        VALUES ($1, $2)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        channel_id,
                        channel_name,
                    )

                    rx_time = self._ts_to_dt(chat_msg.get("timestamp"))

                    await conn.execute(
                        """
                        INSERT INTO chat_messages (
                            id, from_node_id, to_node_id, sender_node_id, channel_id,
                            text, timestamp, rx_time, hops_away, rssi, snr
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        chat_msg.get("id"),
                        from_id,
                        to_id,
                        sender_id,
                        channel_id,
                        chat_msg.get("text"),
                        chat_msg.get("timestamp"),
                        rx_time,
                        chat_msg.get("hops_away"),
                        chat_msg.get("rssi"),
                        chat_msg.get("snr"),
                    )

        except Exception as e:
            logger.error(f"Failed to write chat message to PostgreSQL: {e}")
            if self.raise_on_write_error:
                raise

    async def write_traceroute(self, node_id: str, traceroute_msg: Dict[str, Any]) -> None:
        """
        Write traceroute to PostgreSQL.

        Args:
            node_id: from-node id (any supported form; will be normalized)
            traceroute_msg: Traceroute message dictionary
        """
        if not self._ready("write_traceroute"):
            return

        if not isinstance(node_id, str) or not node_id:
            raise ValueError("write_traceroute: node_id must be a non-empty string")
        if not isinstance(traceroute_msg, dict):
            raise ValueError("write_traceroute: traceroute_msg must be a dict")

        try:
            async with self.pool.acquire() as conn:
                # Canonical: explicit node_id is authoritative for from_node_id
                from_id = await self._ensure_node_stub(conn, node_id)
                if not from_id:
                    logger.warning(f"write_traceroute: could not normalize node_id={node_id!r}, skipping")
                    return

                msg_from = traceroute_msg.get("from")
                if msg_from is not None:
                    msg_from_norm = await self._ensure_node_stub(conn, msg_from)
                    if msg_from_norm and msg_from_norm != from_id:
                        logger.debug(
                            "write_traceroute: msg['from']=%r (norm=%s) != explicit node_id=%r (norm=%s); using explicit",
                            msg_from,
                            msg_from_norm,
                            node_id,
                            from_id,
                        )

                # Prefer stubs (safer if schema uses FKs); allow NULL if missing/invalid
                to_id = (
                    await self._ensure_node_stub(conn, traceroute_msg.get("to"))
                    if traceroute_msg.get("to")
                    else None
                )
                sender_id = (
                    await self._ensure_node_stub(conn, traceroute_msg.get("sender"))
                    if traceroute_msg.get("sender")
                    else None
                )

                payload_json = json.dumps(traceroute_msg.get("payload", {}))
                route_json = json.dumps(traceroute_msg.get("route", []))
                route_ids_json = json.dumps(traceroute_msg.get("route_ids", []))

                rx_time = self._ts_to_dt(traceroute_msg.get("timestamp"))

                msg_id = traceroute_msg.get("id")
                if msg_id is None:
                    logger.warning("write_traceroute: missing traceroute_msg['id']; skipping insert")
                    return
                try:
                    msg_id = int(msg_id)
                except (TypeError, ValueError):
                    logger.warning("write_traceroute: invalid traceroute_msg['id']=%r; skipping insert", msg_id)
                    return

                await conn.execute(
                    """
                    INSERT INTO traceroutes (
                        from_node_id, to_node_id, sender_node_id, message_id, channel,
                        packet_id, hops_away, rssi, snr, timestamp, rx_time,
                        route, route_ids, payload
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb)
                    ON CONFLICT (from_node_id, message_id) DO NOTHING
                    """,
                    from_id,
                    to_id,
                    sender_id,
                    msg_id,
                    traceroute_msg.get("channel"),
                    traceroute_msg.get("packet_id"),
                    traceroute_msg.get("hops_away"),
                    traceroute_msg.get("rssi"),
                    traceroute_msg.get("snr"),
                    traceroute_msg.get("timestamp"),
                    rx_time,
                    route_json,
                    route_ids_json,
                    payload_json,
                )

        except Exception as e:
            logger.error(f"Failed to write traceroute to PostgreSQL: {e}")
            if self.raise_on_write_error:
                raise

    def _coerce_mqtt_payload_text(self, value: Any) -> Optional[str]:
        """
        Convert MQTT payload/message content into a text blob suitable for mqtt_messages.payload.

        - dict/list -> JSON string
        - bytes -> utf-8 if possible, else base64 with "b64:" prefix
        - str -> as-is
        - other -> str(...)
        """
        if value is None:
            return None

        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False, default=str)

        if isinstance(value, (bytes, bytearray, memoryview)):
            b = bytes(value)
            try:
                return b.decode("utf-8")
            except UnicodeDecodeError:
                return "b64:" + base64.b64encode(b).decode("ascii")

        if isinstance(value, str):
            return value

        return str(value)

    async def write_mqtt_message(self, mqtt_msg: Any) -> None:
        """
        Write a raw MQTT message (or decoded/log dict) into mqtt_messages.

        Expected table columns:
          topic (text), payload (text), qos (int), retain (bool), timestamp (bigint), created_at (timestamptz default now())
        """
        if not self._ready("write_mqtt_message"):
            return

        if isinstance(mqtt_msg, dict):
            topic = mqtt_msg.get("topic")
            qos = mqtt_msg.get("qos")
            retain = mqtt_msg.get("retain")
            ts = mqtt_msg.get("timestamp")

            clean = dict(mqtt_msg)
            clean.pop("decoded", None)
            clean.pop("encrypted", None)
            payload_text = self._coerce_mqtt_payload_text(clean)
        else:
            topic_obj = getattr(mqtt_msg, "topic", None)
            topic = getattr(topic_obj, "value", None) if topic_obj is not None else None
            if topic is None and topic_obj is not None:
                topic = str(topic_obj)

            qos = getattr(mqtt_msg, "qos", None)
            retain = getattr(mqtt_msg, "retain", None)
            ts = getattr(mqtt_msg, "timestamp", None)
            payload_text = self._coerce_mqtt_payload_text(getattr(mqtt_msg, "payload", None))

        if topic is not None and not isinstance(topic, str):
            topic = str(topic)

        try:
            qos_i = int(qos) if qos is not None else None
        except (TypeError, ValueError):
            qos_i = None

        retain_b = bool(retain) if retain is not None else None

        try:
            ts_i = int(ts) if ts is not None else None
        except (TypeError, ValueError):
            ts_i = None

        # Extract from/to node IDs for indexed filtering
        from_node_id = None
        to_node_id = None
        if isinstance(mqtt_msg, dict):
            from_node_id = self._normalize_node_id(mqtt_msg.get("from"))
            to_node_id = self._normalize_node_id(mqtt_msg.get("to"))

        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO mqtt_messages (topic, payload, qos, retain, timestamp, from_node_id, to_node_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    topic,
                    payload_text,
                    qos_i,
                    retain_b,
                    ts_i,
                    from_node_id,
                    to_node_id,
                )
        except Exception as e:
            logger.error(f"Failed to write mqtt message to PostgreSQL: {e}")
            if self.raise_on_write_error:
                raise

    async def query_mqtt_messages(
        self,
        limit: int = 1000,
        search: str | None = None,
        range_seconds: int | None = None,
    ) -> list:
        """Query mqtt_messages from PostgreSQL, returning parsed message dicts.

        Args:
            limit: Max messages to return.
            search: Optional search term to filter by topic or payload content.
            range_seconds: If provided, only include messages with
                        timestamp >= (now_unix - range_seconds).
        """
        if not self._ready("query_mqtt_messages"):
            return []
        try:
            import time
            async with self.pool.acquire() as conn:
                conditions = []
                params: list = []
                idx = 1

                if range_seconds is not None:
                    threshold = int(time.time()) - range_seconds
                    conditions.append(f"timestamp >= ${idx}")
                    params.append(threshold)
                    idx += 1

                if search:
                    conditions.append(
                        f"(topic ILIKE '%' || ${idx} || '%'"
                        f" OR payload ILIKE '%' || ${idx} || '%')"
                    )
                    params.append(search)
                    idx += 1

                where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
                params.append(limit)

                rows = await conn.fetch(
                    f"""SELECT topic, payload, qos, retain, timestamp, created_at
                        FROM mqtt_messages
                        {where}
                        ORDER BY created_at DESC LIMIT ${idx}""",
                    *params,
                )

            results = []
            for row in rows:
                payload_text = row["payload"]
                if payload_text:
                    try:
                        msg = json.loads(payload_text)
                    except (json.JSONDecodeError, TypeError):
                        msg = {"raw": payload_text}
                else:
                    msg = {}
                # Ensure top-level fields are present
                if "topic" not in msg:
                    msg["topic"] = row["topic"]
                if "timestamp" not in msg:
                    msg["timestamp"] = row["timestamp"]
                results.append(msg)
            return results
        except Exception as e:
            logger.error("Failed to query mqtt_messages: %s", e)
            return []

    async def query_node_mqtt_messages(self, node_id: str, limit: int = 50) -> list:
        """Query mqtt_messages for a specific node (as sender or recipient)."""
        if not self._ready("query_node_mqtt_messages"):
            return []
        node_id = self._normalize_node_id(node_id) or node_id
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """SELECT topic, payload, qos, retain, timestamp, created_at
                       FROM mqtt_messages
                       WHERE from_node_id = $1 OR to_node_id = $1
                       ORDER BY created_at DESC LIMIT $2""",
                    node_id, limit,
                )

            results = []
            for row in rows:
                payload_text = row["payload"]
                if payload_text:
                    try:
                        msg = json.loads(payload_text)
                    except (json.JSONDecodeError, TypeError):
                        msg = {"raw": payload_text}
                else:
                    msg = {}
                if "topic" not in msg:
                    msg["topic"] = row["topic"]
                if "timestamp" not in msg:
                    msg["timestamp"] = row["timestamp"]
                results.append(msg)
            return results
        except Exception as e:
            logger.error("Failed to query node mqtt_messages: %s", e)
            return []

    # ============================================================================
    # READ OPERATIONS - Load data from PostgreSQL matching JSON structure
    # ============================================================================

    async def load_nodes(self) -> Dict[str, Any]:
        """
        Load all nodes from PostgreSQL in JSON-compatible format.

        Returns:
            Dict mapping node_id to node data (same structure as JSON)
        """
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                # Load nodes
                nodes = {}
                rows = await conn.fetch("SELECT * FROM nodes")

                for row in rows:
                    node_id = row["id"]
                    nodes[node_id] = {
                        "id": node_id,
                        "longname": row["longname"],
                        "shortname": row["shortname"],
                        "hardware": row["hardware"],
                        "role": row["role"],
                        "active": row["active"],
                        "tc2_bbs": row["tc2_bbs"],
                        "gateway": row["gateway"] if "gateway" in row.keys() else None,
                        "last_channel": row["last_channel"] if "last_channel" in row.keys() else None,
                        "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
                        "since": datetime.timedelta(seconds=row["since_seconds"]) if row["since_seconds"] else None,
                        "position": None,
                        "neighborinfo": None,
                        "telemetry": None,
                    }

                # Load positions (most recent per node)
                position_rows = await conn.fetch(
                    """
                    SELECT DISTINCT ON (node_id) *
                    FROM node_positions
                    ORDER BY node_id, created_at DESC
                    """
                )

                for row in position_rows:
                    node_id = row["node_id"]
                    if node_id in nodes:
                        nodes[node_id]["position"] = {
                            "latitude_i": row["latitude_i"],
                            "longitude_i": row["longitude_i"],
                            "altitude": row["altitude"],
                            "time": row["time"],
                            "precision_bits": row["precision_bits"],
                            "geocoded": self._jsonb(row["geocoded"], None),
                            "last_geocoding": row["last_geocoding"].isoformat() if row["last_geocoding"] else None,
                        }

                # Load neighborinfo (most recent per node)
                neighbor_rows = await conn.fetch(
                    """
                    SELECT DISTINCT ON (node_id) *
                    FROM node_neighborinfo
                    ORDER BY node_id, created_at DESC
                    """
                )

                for row in neighbor_rows:
                    node_id = row["node_id"]
                    if node_id in nodes:
                        nodes[node_id]["neighborinfo"] = {
                            "node_broadcast_interval_secs": row["node_broadcast_interval_secs"],
                            "neighbors": self._jsonb(row["neighbors"], []),
                        }

                # Load current telemetry
                telemetry_rows = await conn.fetch("SELECT * FROM node_telemetry_current")

                for row in telemetry_rows:
                    node_id = row["node_id"]
                    if node_id in nodes:
                        nodes[node_id]["telemetry"] = self._build_telemetry_dict_from_row(row)

                logger.info(f"Loaded {len(nodes)} nodes from PostgreSQL")
                return nodes

        except Exception as e:
            logger.error(f"Failed to load nodes from PostgreSQL: {e}")
            return {}

    async def load_chat(self) -> Dict[str, Any]:
        """
        Load chat data from PostgreSQL in JSON-compatible format.

        Returns:
            Chat structure matching JSON format
        """
        if not self.enabled or not self.pool:
            return {"channels": {"0": {"name": "General", "messages": []}}}

        try:
            async with self.pool.acquire() as conn:
                chat = {"channels": {}}

                # Load channels
                channel_rows = await conn.fetch("SELECT * FROM chat_channels ORDER BY id")
                for row in channel_rows:
                    chat["channels"][row["id"]] = {"name": row["name"], "messages": []}

                # Load messages (most recent first)
                message_rows = await conn.fetch(
                    """
                    SELECT * FROM chat_messages
                    ORDER BY created_at DESC
                    LIMIT 10000
                    """
                )

                for row in message_rows:
                    channel_id = row["channel_id"] or "0"
                    if channel_id not in chat["channels"]:
                        chat["channels"][channel_id] = {"name": f"Channel {channel_id}", "messages": []}

                    chat["channels"][channel_id]["messages"].append(
                        {
                            "id": row["id"],
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "channel": channel_id,
                            "text": row["text"],
                            "timestamp": row["timestamp"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                        }
                    )

                logger.info(f"Loaded {len(message_rows)} chat messages from PostgreSQL")
                return chat

        except Exception as e:
            logger.error(f"Failed to load chat from PostgreSQL: {e}")
            return {"channels": {"0": {"name": "General", "messages": []}}}

    async def load_telemetry(self) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """
        Load telemetry data from PostgreSQL.

        Returns:
            Tuple of (telemetry_list, telemetry_by_node)
        """
        if not self.enabled or not self.pool:
            return [], {}

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM telemetry
                    ORDER BY created_at DESC
                    LIMIT 10000
                    """
                )

                telemetry = []
                telemetry_by_node = {}

                for row in rows:
                    msg = {
                        "from": row["from_node_id"],
                        "to": row["to_node_id"],
                        "sender": row["sender_node_id"],
                        "id": row["message_id"],
                        "channel": row["channel"],
                        "packet_id": row["packet_id"],
                        "hops_away": row["hops_away"],
                        "rssi": row["rssi"],
                        "snr": row["snr"],
                        "timestamp": row["timestamp"],
                        "telemetry_type": row.get("telemetry_type"),
                        "payload": self._jsonb(row["payload"], {}),
                    }

                    telemetry.append(msg)

                    node_id = row["from_node_id"]
                    if node_id not in telemetry_by_node:
                        telemetry_by_node[node_id] = []
                    telemetry_by_node[node_id].append(msg)

                logger.info(f"Loaded {len(telemetry)} telemetry records from PostgreSQL")
                return telemetry, telemetry_by_node

        except Exception as e:
            logger.error(f"Failed to load telemetry from PostgreSQL: {e}")
            return [], {}

    async def load_traceroutes(self) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """
        Load traceroute data from PostgreSQL.

        Returns:
            Tuple of (traceroutes_list, traceroutes_by_node)
        """
        if not self.enabled or not self.pool:
            return [], {}

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM traceroutes
                    ORDER BY created_at DESC
                    LIMIT 10000
                    """
                )

                traceroutes = []
                traceroutes_by_node = {}

                for row in rows:
                    msg = {
                        "from": row["from_node_id"],
                        "to": row["to_node_id"],
                        "sender": row["sender_node_id"],
                        "id": row["message_id"],
                        "channel": row["channel"],
                        "packet_id": row["packet_id"],
                        "hops_away": row["hops_away"],
                        "rssi": row["rssi"],
                        "snr": row["snr"],
                        "timestamp": row["timestamp"],
                        "route": self._jsonb(row["route"], []),
                        "route_ids": self._jsonb(row["route_ids"], []),
                        "payload": self._jsonb(row["payload"], {}),
                    }

                    traceroutes.append(msg)

                    node_id = row["from_node_id"]
                    if node_id not in traceroutes_by_node:
                        traceroutes_by_node[node_id] = []
                    traceroutes_by_node[node_id].append(msg)

                logger.info(f"Loaded {len(traceroutes)} traceroutes from PostgreSQL")
                return traceroutes, traceroutes_by_node

        except Exception as e:
            logger.error(f"Failed to load traceroutes from PostgreSQL: {e}")
            return [], {}

    # ============================================================================
    # DIRECT QUERY OPERATIONS - For API endpoints when reading from Postgres
    # ============================================================================

    async def query_nodes_filtered(
        self,
        days_limit: int = 7,
        node_ids: Optional[List[str]] = None,
        longname_filter: Optional[str] = None,
        shortname_filter: Optional[str] = None,
        status_filter: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Query nodes with filters directly from PostgreSQL.

        Args:
            days_limit: Only return nodes seen within this many days
            node_ids: Filter by specific node IDs
            longname_filter: Filter by longname substring (case-insensitive)
            shortname_filter: Filter by shortname substring (case-insensitive)
            status_filter: Filter by status ("online" or "offline")

        Returns:
            Dict mapping node_id to node data
        """
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                # Build WHERE clause
                where_parts = []
                params = []
                param_num = 1

                # Days filter
                if days_limit is not None:
                    try:
                        days_int = int(days_limit)
                    except (TypeError, ValueError):
                        logger.warning("Invalid days_limit value %r provided; ignoring days filter.", days_limit)
                    else:
                        if days_int > 0:
                            where_parts.append(f"last_seen >= NOW() - ${param_num} * INTERVAL '1 day'")
                            params.append(days_int)
                            param_num += 1
                        # days_int <= 0 => treat as "no days filter"

                # Node IDs filter
                if node_ids:
                    placeholders = ",".join([f"${i}" for i in range(param_num, param_num + len(node_ids))])
                    where_parts.append(f"id IN ({placeholders})")
                    params.extend(node_ids)
                    param_num += len(node_ids)

                # Longname filter
                if longname_filter:
                    where_parts.append(f"LOWER(longname) LIKE ${param_num}")
                    params.append(f"%{longname_filter.lower()}%")
                    param_num += 1

                # Shortname filter
                if shortname_filter:
                    where_parts.append(f"LOWER(shortname) LIKE ${param_num}")
                    params.append(f"%{shortname_filter.lower()}%")
                    param_num += 1

                # Status filter
                if status_filter == "online":
                    where_parts.append("active = TRUE")
                elif status_filter == "offline":
                    where_parts.append("active = FALSE")

                where_clause = " AND ".join(where_parts) if where_parts else "TRUE"

                # Query nodes — most recently seen first so name collisions
                # return the active node rather than a stale duplicate
                nodes = {}
                query = f"SELECT * FROM nodes WHERE {where_clause} ORDER BY last_seen DESC NULLS LAST"
                rows = await conn.fetch(query, *params)

                for row in rows:
                    node_id = row["id"]
                    nodes[node_id] = {
                        "id": node_id,
                        "longname": row["longname"],
                        "shortname": row["shortname"],
                        "hardware": row["hardware"],
                        "role": row["role"],
                        "active": row["active"],
                        "tc2_bbs": row["tc2_bbs"] if "tc2_bbs" in row else False,
                        "gateway": row["gateway"] if "gateway" in row.keys() else None,
                        "last_channel": row["last_channel"] if "last_channel" in row.keys() else None,
                        "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
                        "since": datetime.timedelta(seconds=row["since_seconds"]) if row["since_seconds"] else None,
                        "position": None,
                        "neighborinfo": None,
                        "telemetry": None,
                    }

                # Load related data for returned nodes
                if nodes:
                    node_ids_list = list(nodes.keys())

                    # Load positions
                    position_query = """
                        SELECT DISTINCT ON (node_id) *
                        FROM node_positions
                        WHERE node_id = ANY($1)
                        ORDER BY node_id, created_at DESC
                    """
                    position_rows = await conn.fetch(position_query, node_ids_list)

                    for row in position_rows:
                        node_id = row["node_id"]
                        if node_id in nodes:
                            nodes[node_id]["position"] = {
                                "latitude_i": row["latitude_i"],
                                "longitude_i": row["longitude_i"],
                                "altitude": row["altitude"],
                                "time": row["time"],
                                "precision_bits": row["precision_bits"],
                                "geocoded": self._jsonb(row["geocoded"], None),
                                "last_geocoding": row["last_geocoding"].isoformat() if row["last_geocoding"] else None,
                            }

                    # Load neighborinfo
                    neighbor_query = """
                        SELECT DISTINCT ON (node_id) *
                        FROM node_neighborinfo
                        WHERE node_id = ANY($1)
                        ORDER BY node_id, created_at DESC
                    """
                    neighbor_rows = await conn.fetch(neighbor_query, node_ids_list)

                    for row in neighbor_rows:
                        node_id = row["node_id"]
                        if node_id in nodes:
                            nodes[node_id]["neighborinfo"] = {
                                "node_broadcast_interval_secs": row["node_broadcast_interval_secs"],
                                "neighbors": self._jsonb(row["neighbors"], []),
                            }

                    # Load current telemetry
                    telemetry_query = "SELECT * FROM node_telemetry_current WHERE node_id = ANY($1)"
                    telemetry_rows = await conn.fetch(telemetry_query, node_ids_list)

                    for row in telemetry_rows:
                        node_id = row["node_id"]
                        if node_id in nodes:
                            nodes[node_id]["telemetry"] = self._build_telemetry_dict_from_row(row)

                return nodes

        except Exception as e:
            logger.error(f"Failed to query nodes from PostgreSQL: {e}")
            return {}

    async def query_node_by_id(self, node_id: str) -> Optional[Dict[str, Any]]:
        """Query a single node by ID directly from PostgreSQL."""
        nodes = await self.query_nodes_filtered(days_limit=None, node_ids=[node_id])
        return nodes.get(node_id)

    async def query_node_telemetry(self, node_id: str, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query telemetry for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM telemetry
                    WHERE from_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT $2
                    """,
                    node_id,
                    limit,
                )

                telemetry = []
                for row in rows:
                    telemetry.append(
                        {
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "id": row["message_id"],
                            "channel": row["channel"],
                            "packet_id": row["packet_id"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                            "timestamp": row["timestamp"],
                            "telemetry_type": row.get("telemetry_type"),
                            "payload": self._jsonb(row["payload"], {}),
                        }
                    )

                return telemetry

        except Exception as e:
            logger.error(f"Failed to query telemetry from PostgreSQL: {e}")
            return []

    async def query_node_texts(self, node_id: str) -> List[Dict[str, Any]]:
        """Query text messages for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM chat_messages
                    WHERE from_node_id = $1 OR to_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1000
                    """,
                    node_id,
                )

                texts = []
                for row in rows:
                    texts.append(
                        {
                            "id": row["id"],
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "channel": row["channel_id"] or "0",
                            "text": row["text"],
                            "timestamp": row["timestamp"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                        }
                    )

                return texts

        except Exception as e:
            logger.error(f"Failed to query texts from PostgreSQL: {e}")
            return []

    async def query_node_traceroutes(self, node_id: str) -> List[Dict[str, Any]]:
        """Query traceroutes for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM traceroutes
                    WHERE from_node_id = $1 OR to_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1000
                    """,
                    node_id,
                )

                traceroutes = []
                for row in rows:
                    traceroutes.append(
                        {
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "id": row["message_id"],
                            "channel": row["channel"],
                            "packet_id": row["packet_id"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                            "timestamp": row["timestamp"],
                            "route": self._jsonb(row["route"], []),
                            "route_ids": self._jsonb(row["route_ids"], []),
                            "payload": self._jsonb(row["payload"], {}),
                        }
                    )

                return traceroutes

        except Exception as e:
            logger.error(f"Failed to query traceroutes from PostgreSQL: {e}")
            return []

    async def query_all_chat(self, limit: int = 10000) -> Dict[str, Any]:
        """Query all chat channels and messages."""
        if not self.enabled or not self.pool:
            return {"channels": {"0": {"name": "General", "messages": []}}}

        try:
            async with self.pool.acquire() as conn:
                chat = {"channels": {}}

                # Load channels
                channel_rows = await conn.fetch("SELECT * FROM chat_channels ORDER BY id")
                for row in channel_rows:
                    chat["channels"][row["id"]] = {"name": row["name"], "messages": []}

                # Load messages
                message_rows = await conn.fetch(
                    """
                    SELECT * FROM chat_messages
                    ORDER BY created_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

                for row in message_rows:
                    channel_id = row["channel_id"] or "0"
                    if channel_id not in chat["channels"]:
                        chat["channels"][channel_id] = {"name": f"Channel {channel_id}", "messages": []}

                    chat["channels"][channel_id]["messages"].append(
                        {
                            "id": row["id"],
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "channel": channel_id,
                            "text": row["text"],
                            "timestamp": row["timestamp"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                        }
                    )

                return chat

        except Exception as e:
            logger.error(f"Failed to query chat from PostgreSQL: {e}")
            return {"channels": {"0": {"name": "General", "messages": []}}}

    async def query_chat_filtered(
        self,
        channel_id: Optional[str] = None,
        range_seconds: Optional[int] = None,
        limit: int = 10000,
    ) -> Dict[str, Any]:
        """
        Query chat channels with optional filtering by channel and time range.

        Always returns all channels with totalMessages counts (for UI pills).
        Only populates the messages array for the requested channel.

        Args:
            channel_id: Only include messages for this channel (defaults to "0"
                        at the API layer). Other channels get empty messages arrays.
            range_seconds: If provided, only include messages with
                        timestamp >= (now_unix - range_seconds).
            limit: Max messages to return.

        Returns:
            Chat structure: { channels: { "<id>": { name, totalMessages, messages[] } } }
        """
        if not self.enabled or not self.pool:
            return {"channels": {"0": {"name": "General", "totalMessages": 0, "messages": []}}}

        try:
            async with self.pool.acquire() as conn:
                chat: Dict[str, Any] = {"channels": {}}

                # ── 1. Load ALL channels with their total message counts ──
                channel_rows = await conn.fetch(
                    """
                    SELECT cc.id, cc.name, COUNT(cm.id) AS total_messages
                    FROM chat_channels cc
                    LEFT JOIN chat_messages cm ON cc.id = cm.channel_id
                    GROUP BY cc.id, cc.name
                    ORDER BY cc.id
                    """
                )

                for row in channel_rows:
                    chat["channels"][row["id"]] = {
                        "name": row["name"],
                        "totalMessages": row["total_messages"],
                        "messages": [],
                    }

                # ── 2. Load messages for the target channel(s) ──
                where_parts = []
                params: list = []
                param_num = 1

                if channel_id is not None:
                    where_parts.append(f"channel_id = ${param_num}")
                    params.append(channel_id)
                    param_num += 1

                if range_seconds is not None:
                    import time
                    threshold = int(time.time()) - range_seconds
                    where_parts.append(f"timestamp >= ${param_num}")
                    params.append(threshold)
                    param_num += 1

                where_clause = " AND ".join(where_parts) if where_parts else "TRUE"

                params.append(limit)
                limit_param = f"${param_num}"

                message_rows = await conn.fetch(
                    f"""
                    SELECT * FROM chat_messages
                    WHERE {where_clause}
                    ORDER BY timestamp DESC
                    LIMIT {limit_param}
                    """,
                    *params,
                )

                for row in message_rows:
                    ch_id = row["channel_id"] or "0"
                    if ch_id not in chat["channels"]:
                        chat["channels"][ch_id] = {
                            "name": f"Channel {ch_id}",
                            "totalMessages": 0,
                            "messages": [],
                        }

                    chat["channels"][ch_id]["messages"].append(
                        {
                            "id": row["id"],
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "channel": ch_id,
                            "text": row["text"],
                            "timestamp": row["timestamp"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                        }
                    )

                return chat

        except Exception as e:
            logger.error(f"Failed to query filtered chat from PostgreSQL: {e}")
            return {"channels": {"0": {"name": "General", "totalMessages": 0, "messages": []}}}

    async def query_all_telemetry(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query all telemetry records."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM telemetry
                    ORDER BY created_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

                telemetry = []
                for row in rows:
                    telemetry.append(
                        {
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "id": row["message_id"],
                            "channel": row["channel"],
                            "packet_id": row["packet_id"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                            "timestamp": row["timestamp"],
                            "telemetry_type": row.get("telemetry_type"),
                            "payload": self._jsonb(row["payload"], {}),
                        }
                    )

                return telemetry

        except Exception as e:
            logger.error(f"Failed to query telemetry from PostgreSQL: {e}")
            return []

    async def query_all_traceroutes(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query all traceroutes."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT * FROM traceroutes
                    ORDER BY created_at DESC
                    LIMIT $1
                    """,
                    limit,
                )

                traceroutes = []
                for row in rows:
                    traceroutes.append(
                        {
                            "from": row["from_node_id"],
                            "to": row["to_node_id"],
                            "sender": row["sender_node_id"],
                            "id": row["message_id"],
                            "channel": row["channel"],
                            "packet_id": row["packet_id"],
                            "hops_away": row["hops_away"],
                            "rssi": row["rssi"],
                            "snr": row["snr"],
                            "timestamp": row["timestamp"],
                            "route": self._jsonb(row["route"], []),
                            "route_ids": self._jsonb(row["route_ids"], []),
                            "payload": self._jsonb(row["payload"], {}),
                        }
                    )

                return traceroutes

        except Exception as e:
            logger.error(f"Failed to query traceroutes from PostgreSQL: {e}")
            return []

    async def query_stats(self) -> Dict[str, int]:
        """Query statistics from PostgreSQL."""
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                stats = {}

                # Count nodes
                stats["total_nodes"] = await conn.fetchval("SELECT COUNT(*) FROM nodes")
                stats["active_nodes"] = await conn.fetchval("SELECT COUNT(*) FROM nodes WHERE active = TRUE")

                # Count messages
                stats["total_chat"] = await conn.fetchval("SELECT COUNT(*) FROM chat_messages WHERE channel_id = '0'")
                stats["total_telemetry"] = await conn.fetchval("SELECT COUNT(*) FROM telemetry")
                stats["total_traceroutes"] = await conn.fetchval("SELECT COUNT(*) FROM traceroutes")

                # mqtt_messages can be huge and is under constant write load — an exact
                # COUNT(*) can be slow enough to hit statement_timeout. The planner
                # estimate is instant and accurate to within a few percent, which is
                # plenty for a stats counter. Isolate so a failure here can't blank
                # the rest of the response.
                try:
                    approx = await conn.fetchval(
                        "SELECT reltuples::bigint FROM pg_class WHERE relname = 'mqtt_messages'"
                    )
                    mqtt_count = max(0, int(approx or 0))
                except Exception as e:
                    logger.warning("Failed to estimate mqtt_messages count: %s", e, exc_info=True)
                    mqtt_count = 0
                stats["total_messages"] = mqtt_count
                stats["total_mqtt_messages"] = mqtt_count

                return stats

        except Exception as e:
            logger.error("Failed to query stats from PostgreSQL: %s", e, exc_info=True)
            return {}

    # ───────────────────────────────────────────────────────────────────
    # Discord bridge helpers
    # ───────────────────────────────────────────────────────────────────

    async def link_node(self, node_id: str, discord_user_id: str) -> str:
        """Link a mesh node to a Discord user.

        Returns:
            "ok" on success,
            "already_yours" if already linked to this user,
            "taken" if linked to another user,
            "error" on failure.
        """
        if not self._ready("link_node"):
            return "error"
        try:
            async with self.pool.acquire() as conn:
                existing = await conn.fetchval(
                    "SELECT discord_user_id FROM discord_node_links WHERE node_id = $1",
                    node_id,
                )
                if existing == discord_user_id:
                    return "already_yours"
                if existing is not None:
                    return "taken"
                await conn.execute(
                    "INSERT INTO discord_node_links (node_id, discord_user_id) VALUES ($1, $2)",
                    node_id, discord_user_id,
                )
            return "ok"
        except Exception as e:
            logger.error("Failed to link node %s to Discord user %s: %s", node_id, discord_user_id, e)
            return "error"

    async def unlink_node(self, node_id: str, discord_user_id: str) -> bool:
        """Unlink a mesh node from a Discord user. Returns True if a row was deleted."""
        if not self._ready("unlink_node"):
            return False
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    "DELETE FROM discord_node_links WHERE node_id = $1 AND discord_user_id = $2",
                    node_id, discord_user_id,
                )
            return result == "DELETE 1"
        except Exception as e:
            logger.error("Failed to unlink node %s from Discord user %s: %s", node_id, discord_user_id, e)
            return False

    async def force_unlink_node(self, node_id: str) -> Optional[str]:
        """Force unlink a node regardless of owner. Returns the previous owner's Discord ID, or None."""
        if not self._ready("force_unlink_node"):
            return None
        try:
            async with self.pool.acquire() as conn:
                owner = await conn.fetchval(
                    "SELECT discord_user_id FROM discord_node_links WHERE node_id = $1",
                    node_id,
                )
                if owner:
                    await conn.execute(
                        "DELETE FROM discord_node_links WHERE node_id = $1",
                        node_id,
                    )
                return owner
        except Exception as e:
            logger.error("Failed to force unlink node %s: %s", node_id, e)
            return None

    async def get_linked_nodes(self, discord_user_id: str) -> List[str]:
        """Return all node IDs linked to a Discord user."""
        if not self._ready("get_linked_nodes"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id FROM discord_node_links WHERE discord_user_id = $1",
                    discord_user_id,
                )
            return [r["node_id"] for r in rows]
        except Exception as e:
            logger.error("Failed to get linked nodes for Discord user %s: %s", discord_user_id, e)
            return []

    async def watch_node(self, node_id: str, discord_user_id: str) -> str:
        """Watch a node for online/offline alerts. Returns 'ok', 'already', or 'error'."""
        if not self._ready("watch_node"):
            return "error"
        try:
            async with self.pool.acquire() as conn:
                existing = await conn.fetchval(
                    "SELECT 1 FROM discord_watched_nodes WHERE node_id = $1 AND discord_user_id = $2",
                    node_id, discord_user_id,
                )
                if existing:
                    return "already"
                await conn.execute(
                    "INSERT INTO discord_watched_nodes (node_id, discord_user_id) VALUES ($1, $2)",
                    node_id, discord_user_id,
                )
            return "ok"
        except Exception as e:
            logger.error("Failed to watch node %s for user %s: %s", node_id, discord_user_id, e)
            return "error"

    async def unwatch_node(self, node_id: str, discord_user_id: str) -> bool:
        """Stop watching a node. Returns True if a row was deleted."""
        if not self._ready("unwatch_node"):
            return False
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    "DELETE FROM discord_watched_nodes WHERE node_id = $1 AND discord_user_id = $2",
                    node_id, discord_user_id,
                )
            return result == "DELETE 1"
        except Exception as e:
            logger.error("Failed to unwatch node %s for user %s: %s", node_id, discord_user_id, e)
            return False

    async def get_watched_nodes(self, discord_user_id: str) -> list[str]:
        """Return all node IDs watched by a Discord user."""
        if not self._ready("get_watched_nodes"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id FROM discord_watched_nodes WHERE discord_user_id = $1",
                    discord_user_id,
                )
            return [r["node_id"] for r in rows]
        except Exception as e:
            logger.error("Failed to get watched nodes for user %s: %s", discord_user_id, e)
            return []

    async def get_all_watched_nodes(self) -> list[dict]:
        """Return all watch entries: [{node_id, discord_user_id}, ...]."""
        if not self._ready("get_all_watched_nodes"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id, discord_user_id FROM discord_watched_nodes",
                )
                return [dict(r) for r in rows]
        except Exception as e:
            logger.error("Failed to get all watched nodes: %s", e)
            return []

    async def get_all_linked_nodes(self) -> list[dict]:
        """Return all node links: [{node_id, discord_user_id}, ...]."""
        if not self._ready("get_all_linked_nodes"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id, discord_user_id FROM discord_node_links",
                )
                return [dict(r) for r in rows]
        except Exception as e:
            logger.error("Failed to get all linked nodes: %s", e)
            return []

    async def get_node_owner(self, node_id: str) -> Optional[str]:
        """Return the Discord user ID linked to a node, or None."""
        if not self._ready("get_node_owner"):
            return None
        try:
            async with self.pool.acquire() as conn:
                return await conn.fetchval(
                    "SELECT discord_user_id FROM discord_node_links WHERE node_id = $1 LIMIT 1",
                    node_id,
                )
        except Exception as e:
            logger.error("Failed to get owner of node %s: %s", node_id, e)
            return None

    async def ban_node(self, node_id: str, banned_by: str, reason: str = "") -> bool:
        """Ban a node from the Discord bridge."""
        if not self._ready("ban_node"):
            return False
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO discord_banned_nodes (node_id, banned_by, reason)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (node_id) DO UPDATE SET banned_by = $2, reason = $3""",
                    node_id, banned_by, reason,
                )
            return True
        except Exception as e:
            logger.error("Failed to ban node %s: %s", node_id, e)
            return False

    async def unban_node(self, node_id: str) -> bool:
        """Unban a node from the Discord bridge."""
        if not self._ready("unban_node"):
            return False
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    "DELETE FROM discord_banned_nodes WHERE node_id = $1", node_id,
                )
            return result == "DELETE 1"
        except Exception as e:
            logger.error("Failed to unban node %s: %s", node_id, e)
            return False

    async def is_node_banned(self, node_id: str) -> bool:
        """Check if a node is banned."""
        if not self._ready("is_node_banned"):
            return False
        try:
            async with self.pool.acquire() as conn:
                return await conn.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM discord_banned_nodes WHERE node_id = $1)",
                    node_id,
                ) or False
        except Exception as e:
            logger.error("Failed to check ban for node %s: %s", node_id, e)
            return False

    async def add_tracker(self, node_id: str, track_type: str, added_by: str) -> bool:
        """Add a node to position tracking."""
        if not self._ready("add_tracker"):
            return False
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO discord_tracked_nodes (node_id, track_type, added_by)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (node_id) DO UPDATE SET track_type = $2, added_by = $3""",
                    node_id, track_type, added_by,
                )
            return True
        except Exception as e:
            logger.error("Failed to add tracker for node %s: %s", node_id, e)
            return False

    async def remove_tracker(self, node_id: str) -> bool:
        """Remove a node from position tracking."""
        if not self._ready("remove_tracker"):
            return False
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute(
                    "DELETE FROM discord_tracked_nodes WHERE node_id = $1", node_id,
                )
            return result == "DELETE 1"
        except Exception as e:
            logger.error("Failed to remove tracker for node %s: %s", node_id, e)
            return False

    async def is_node_tracked(self, node_id: str) -> bool:
        """Check if a node has position tracking enabled."""
        if not self._ready("is_node_tracked"):
            return False
        try:
            async with self.pool.acquire() as conn:
                return await conn.fetchval(
                    "SELECT EXISTS(SELECT 1 FROM discord_tracked_nodes WHERE node_id = $1)",
                    node_id,
                ) or False
        except Exception as e:
            logger.error("Failed to check tracker for node %s: %s", node_id, e)
            return False

    async def get_tracker_type(self, node_id: str) -> Optional[str]:
        """Return the tracker type for a node, or None if not tracked."""
        if not self._ready("get_tracker_type"):
            return None
        try:
            async with self.pool.acquire() as conn:
                return await conn.fetchval(
                    "SELECT track_type FROM discord_tracked_nodes WHERE node_id = $1",
                    node_id,
                )
        except Exception as e:
            logger.error("Failed to get tracker type for node %s: %s", node_id, e)
            return None

    async def list_trackers(self) -> list[dict]:
        """List all tracked nodes with their type and who added them."""
        if not self._ready("list_trackers"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id, track_type, added_by, created_at FROM discord_tracked_nodes ORDER BY created_at",
                )
                return [dict(row) for row in rows]
        except Exception as e:
            logger.error("Failed to list trackers: %s", e)
            return []

    async def list_bans(self) -> list[dict]:
        """List all banned nodes with reason and who banned them."""
        if not self._ready("list_bans"):
            return []
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id, banned_by, reason, created_at FROM discord_banned_nodes ORDER BY created_at",
                )
                return [dict(row) for row in rows]
        except Exception as e:
            logger.error("Failed to list bans: %s", e)
            return []

    async def query_top_nodes(self, hours: int = 24, limit: int = 5, channel_id: Optional[str] = None) -> dict:
        """Query leaderboard stats for the mesh. Returns dict of categories.
        If channel_id is provided, chat-based stats are scoped to that channel,
        and node-based categories (such as iron_man) are scoped via nodes.last_channel."""
        if not self._ready("query_top_nodes"):
            return {}

        # Compute cutoff timestamp in Python to avoid asyncpg interval issues
        cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
        results = {}

        # Build optional channel filter for chat_messages queries
        ch_filter = ""
        ch_params: list = []
        if channel_id is not None:
            ch_filter = " AND channel_id = $3"
            ch_params = [channel_id]

        try:
            async with self.pool.acquire() as conn:
                # Chatterbox — most messages sent
                rows = await conn.fetch(
                    f"""SELECT from_node_id AS node_id, COUNT(*) AS count
                       FROM chat_messages
                       WHERE created_at >= $1{ch_filter}
                       GROUP BY from_node_id ORDER BY count DESC LIMIT $2""",
                    cutoff, limit, *ch_params,
                )
                results["chatterbox"] = [dict(r) for r in rows]

                # Iron Man — longest uptime (active nodes with oldest created_at)
                if channel_id is not None:
                    rows = await conn.fetch(
                        """SELECT id AS node_id,
                                  EXTRACT(EPOCH FROM (NOW() - created_at)) AS uptime_seconds
                           FROM nodes
                           WHERE active = TRUE AND created_at IS NOT NULL AND last_channel = $2
                           ORDER BY created_at ASC LIMIT $1""",
                        limit, channel_id,
                    )
                else:
                    rows = await conn.fetch(
                        """SELECT id AS node_id,
                                  EXTRACT(EPOCH FROM (NOW() - created_at)) AS uptime_seconds
                           FROM nodes
                           WHERE active = TRUE AND created_at IS NOT NULL
                           ORDER BY created_at ASC LIMIT $1""",
                        limit,
                    )
                results["iron_man"] = [dict(r) for r in rows]

                # Here I Am — disabled: requires position history table (not yet implemented)

                # Loudest Signal — best average SNR
                rows = await conn.fetch(
                    f"""SELECT from_node_id AS node_id, ROUND(AVG(snr)::numeric, 1) AS avg_snr
                       FROM chat_messages
                       WHERE created_at >= $1 AND snr IS NOT NULL{ch_filter}
                       GROUP BY from_node_id
                       HAVING COUNT(*) >= 3
                       ORDER BY avg_snr DESC LIMIT $2""",
                    cutoff, limit, *ch_params,
                )
                results["loudest_signal"] = [dict(r) for r in rows]

                # Gateway MVP — most messages relayed (nodes appearing as sender_node_id)
                rows = await conn.fetch(
                    f"""SELECT sender_node_id AS node_id, COUNT(*) AS count
                       FROM chat_messages
                       WHERE created_at >= $1
                         AND sender_node_id IS NOT NULL
                         AND sender_node_id != from_node_id{ch_filter}
                       GROUP BY sender_node_id ORDER BY count DESC LIMIT $2""",
                    cutoff, limit, *ch_params,
                )
                results["gateway_mvp"] = [dict(r) for r in rows]

        except Exception as e:
            logger.error("Failed to query top nodes: %s", e)

        return results