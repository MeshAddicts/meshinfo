#!/usr/bin/env python3
"""
Migration script to import existing JSON data into PostgreSQL.

This script reads JSON files from output/data/ and imports them into PostgreSQL,
preserving all historical data.

Usage:
    python scripts/migrate_json_to_postgres.py

Requirements:
    - config.json with PostgreSQL settings
    - Existing JSON data files in output/data/
"""

import asyncio
import json
import logging
import os
import sys
import math
from typing import Any, Dict, Optional

# Add parent directory to path to import project modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from config import Config
from encoders import _JSONDecoder
from storage.db.postgres import PostgresStorage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


INT32_MIN = -2**31
INT32_MAX = 2**31 - 1


class JSONToPostgresMigration:
    """Migrate JSON data to PostgreSQL."""

    def __init__(self, config):
        self.config = config
        self.pg_storage = PostgresStorage(config)
        self.data_path = config['paths']['data']

    def load_json_file(self, filename):
        """Load a JSON file with error handling."""
        filepath = os.path.join(self.data_path, filename)
        if os.path.exists(filepath):
            with open(filepath, "r", encoding='utf-8') as f:
                return json.load(f, cls=_JSONDecoder)
        return None

    def _normalize_node_id(self, value):
        """Normalize node ids to 8-char lowercase hex string (strip leading '!')."""
        if not isinstance(value, str):
            return None
        v = value.strip()
        if not v:
            return None
        if v.startswith("!"):
            v = v[1:].strip()
        if len(v) != 8:
            return None
        v = v.lower()
        # ensure hex-like to avoid junk ids slipping through
        if not all(c in "0123456789abcdef" for c in v):
            return None
        return v

    def _as_int(self, value):
        """Convert value to int if it looks like an integer; otherwise None."""
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            s = value.strip()
            if s.isdigit():
                try:
                    return int(s)
                except Exception:
                    return None
        return None

    def _scrub_nans(self, obj: Any) -> Any:
        """
        Recursively convert NaN/Inf values (and their common string forms) to None.
        This prevents asyncpg from rejecting numeric bindings.
        """
        if obj is None:
            return None

        if isinstance(obj, float):
            return None if (math.isnan(obj) or math.isinf(obj)) else obj

        if isinstance(obj, str):
            s = obj.strip().lower()
            if s in ("nan", "inf", "-inf", "infinity", "-infinity"):
                return None
            return obj

        if isinstance(obj, dict):
            return {k: self._scrub_nans(v) for k, v in obj.items()}

        if isinstance(obj, list):
            return [self._scrub_nans(v) for v in obj]

        return obj

    def _clean_role_int32(self, value: Any) -> Optional[int]:
        """
        Convert role to int and ensure it fits in int32. If it doesn't, return None.
        """
        if value is None:
            return None

        v = value
        try:
            if isinstance(v, str):
                s = v.strip()
                if s == "":
                    return None
                # allow "-1" etc
                v = int(s, 10)
            elif not isinstance(v, int):
                v = int(v)
        except (TypeError, ValueError):
            return None

        if v < INT32_MIN or v > INT32_MAX:
            return None
        return v

    async def _ensure_chat_channels(self, channel_ids):
        """
        Ensure chat_channels rows exist for the given channel IDs.
        This prevents FK errors when inserting chat_messages.
        """
        if not self.pg_storage.enabled or not self.pg_storage.pool:
            return

        # Normalize to strings and keep deterministic ordering
        ids = []
        for cid in channel_ids:
            if cid is None:
                continue
            ids.append(str(cid))
        ids = sorted(set(ids))

        if not ids:
            return

        # Can change names if desired
        values = [(cid, "General" if cid == "0" else f"Channel {cid}") for cid in ids]

        try:
            async with self.pg_storage.pool.acquire() as conn:
                await conn.executemany(
                    """
                    INSERT INTO chat_channels (id, name)
                    VALUES ($1, $2)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    values
                )
        except Exception as e:
            logger.warning(f"Failed to ensure chat_channels seed rows: {e}")

    async def migrate(self):
        """Run the complete migration."""
        logger.info("=== Starting JSON to PostgreSQL Migration ===")

        # Connect to PostgreSQL
        logger.info("Connecting to PostgreSQL...")
        connected = await self.pg_storage.connect()
        if not connected:
            logger.error("Failed to connect to PostgreSQL. Aborting migration.")
            return False

        # Ensure schema exists
        logger.info("Ensuring database schema exists...")
        await self.pg_storage.ensure_schema()

        # Migrate nodes
        await self.migrate_nodes()

        # Migrate chat
        await self.migrate_chat()

        # Migrate telemetry
        await self.migrate_telemetry()

        # Migrate traceroutes
        await self.migrate_traceroutes()

        # Close connection
        await self.pg_storage.close()

        logger.info("=== Migration Complete ===")
        return True

    async def migrate_nodes(self):
        """Migrate nodes.json to PostgreSQL."""
        logger.info("Migrating nodes...")

        nodes = self.load_json_file("nodes.json")
        if not nodes:
            logger.warning("No nodes.json file found or file is empty")
            return

        count = 0
        failed = 0

        for node_id, node_data in nodes.items():
            # Normalize and validate node_id
            node_id_norm = self._normalize_node_id(node_id) if isinstance(node_id, str) else None
            if not node_id_norm:
                # preserve prior behavior: strip leading '!' if present
                if isinstance(node_id, str) and node_id.startswith('!'):
                    node_id_norm = self._normalize_node_id(node_id.replace('!', ''))
                if not node_id_norm:
                    logger.warning(f"Skipping invalid node ID: {node_id!r}")
                    continue

            # Ensure required fields (preserve existing behavior)
            if 'active' not in node_data or node_data['active'] is None:
                node_data['active'] = False
            if 'last_seen' not in node_data:
                node_data['last_seen'] = None
            if 'since' not in node_data:
                node_data['since'] = None

            # Scrub NaNs anywhere in nested structures (position / telemetry_current / etc.)
            node_data = self._scrub_nans(node_data)

            # Fix role overflow / bad role values before write_node()
            if 'role' in node_data:
                cleaned_role = self._clean_role_int32(node_data.get('role'))
                if cleaned_role is None and node_data.get('role') not in (None, "", 0):
                    # only log when it was non-trivial junk
                    logger.debug(f"Node {node_id_norm}: role out-of-range/invalid {node_data.get('role')!r}; storing NULL")
                node_data['role'] = cleaned_role

            try:
                await self.pg_storage.write_node(node_id_norm, node_data)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} nodes...")
            except Exception as e:
                failed += 1
                logger.error(f"Failed to migrate node {node_id_norm}: {e}")

        logger.info(f"Successfully migrated {count} nodes (failed {failed})")

    async def migrate_chat(self):
        """Migrate chat.json to PostgreSQL."""
        logger.info("Migrating chat messages...")

        chat_data = self.load_json_file("chat.json")
        if not chat_data:
            logger.warning("No chat.json file found or file is empty")
            return

        # Seed chat_channels based on chat.json channel keys (prevents FK errors)
        channel_ids = list(chat_data.get('channels', {}).keys())
        await self._ensure_chat_channels(channel_ids)

        # chat.json is known to contain duplicate message ids; dedupe in-memory for cleaner results/logging
        seen_ids = set()
        skipped_dupes = 0
        failed = 0

        count = 0
        for channel_id, channel_data in chat_data.get('channels', {}).items():
            for message in channel_data.get('messages', []):
                try:
                    mid = message.get("id")
                    if mid is not None:
                        key = str(mid)
                        if key in seen_ids:
                            skipped_dupes += 1
                            continue
                        seen_ids.add(key)

                    from_id = message.get("from")
                    if not isinstance(from_id, str) or not from_id:
                        logger.warning(f"Skipping chat message {message.get('id')}: missing/invalid from={from_id!r}")
                        continue

                    # Ensure channel id is present in message payload (writer-dependent, but harmless)
                    if message.get("channel_id") is None and message.get("channel") is None:
                        message["channel_id"] = str(channel_id)

                    message = self._scrub_nans(message)

                    await self.pg_storage.write_chat_message(from_id, message)
                    count += 1
                    if count % 100 == 0:
                        logger.info(f"Migrated {count} chat messages...")
                except Exception as e:
                    failed += 1
                    logger.error(f"Failed to migrate chat message {message.get('id')}: {e}")

        logger.info(
            f"Successfully migrated {count} chat messages "
            f"(skipped {skipped_dupes} duplicate ids in chat.json; failed {failed})"
        )

    async def migrate_telemetry(self):
        """Migrate telemetry.json to PostgreSQL."""
        logger.info("Migrating telemetry...")

        telemetry = self.load_json_file("telemetry.json")
        if not telemetry:
            logger.warning("No telemetry.json file found or file is empty")
            return

        # Dedupe within telemetry.json by (from_node_id, message_id). packet_id is a fallback if message_id missing.
        seen = set()
        skipped_dupes = 0
        failed = 0

        count = 0
        for msg in telemetry:
            try:
                from_id = msg.get("from")
                if not isinstance(from_id, str) or not from_id:
                    logger.warning(f"Skipping telemetry record: missing/invalid from={from_id!r}")
                    continue

                from_norm = self._normalize_node_id(from_id)

                # The JSON 'id' maps to DB column telemetry.message_id (bigint)
                message_id = self._as_int(msg.get("id"))

                # Some payloads may have packet_id too; use as fallback key
                packet_id = (
                    self._as_int(msg.get("packet_id"))
                    or self._as_int(msg.get("packetId"))
                    or self._as_int(msg.get("packetID"))
                )

                dedupe_key = None
                if from_norm and message_id is not None:
                    dedupe_key = ("mid", from_norm, message_id)
                elif from_norm and packet_id is not None:
                    dedupe_key = ("pid", from_norm, packet_id)

                if dedupe_key is not None:
                    if dedupe_key in seen:
                        skipped_dupes += 1
                        continue
                    seen.add(dedupe_key)

                msg = self._scrub_nans(msg)

                await self.pg_storage.write_telemetry(from_id, msg)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} telemetry records...")
            except Exception as e:
                failed += 1
                logger.error(f"Failed to migrate telemetry: {e}")

        logger.info(
            f"Successfully migrated {count} telemetry records "
            f"(skipped {skipped_dupes} duplicate records in telemetry.json; failed {failed})"
        )

    async def migrate_traceroutes(self):
        """Migrate traceroutes.json to PostgreSQL."""
        logger.info("Migrating traceroutes...")

        traceroutes = self.load_json_file("traceroutes.json")
        if not traceroutes:
            logger.warning("No traceroutes.json file found or file is empty")
            return

        # Dedupe within traceroutes.json by (from_node_id, message_id). packet_id is a fallback if message_id missing.
        seen = set()
        skipped_dupes = 0
        failed = 0

        count = 0
        for msg in traceroutes:
            try:
                from_id = msg.get("from")
                if not isinstance(from_id, str) or not from_id:
                    logger.warning(f"Skipping traceroute record: missing/invalid from={from_id!r}")
                    continue

                from_norm = self._normalize_node_id(from_id)

                # The JSON 'id' maps to DB column traceroutes.message_id (bigint)
                message_id = self._as_int(msg.get("id"))

                packet_id = (
                    self._as_int(msg.get("packet_id"))
                    or self._as_int(msg.get("packetId"))
                    or self._as_int(msg.get("packetID"))
                )

                dedupe_key = None
                if from_norm and message_id is not None:
                    dedupe_key = ("mid", from_norm, message_id)
                elif from_norm and packet_id is not None:
                    dedupe_key = ("pid", from_norm, packet_id)

                if dedupe_key is not None:
                    if dedupe_key in seen:
                        skipped_dupes += 1
                        continue
                    seen.add(dedupe_key)

                msg = self._scrub_nans(msg)

                await self.pg_storage.write_traceroute(from_id, msg)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} traceroutes...")
            except Exception as e:
                failed += 1
                logger.error(f"Failed to migrate traceroute: {e}")

        logger.info(
            f"Successfully migrated {count} traceroutes "
            f"(skipped {skipped_dupes} duplicate records in traceroutes.json; failed {failed})"
        )


async def main():
    """Main migration entry point."""
    logger.info("Loading configuration...")

    try:
        config = Config.load()
    except Exception as e:
        logger.error(f"Failed to load config: {e}")
        logger.error("Make sure config.toml (or config.json) exists and is valid")
        return 1

    # Check if PostgreSQL is configured
    pg_config = config.get('storage', {}).get('postgres', {})
    if not pg_config.get('enabled', False):
        logger.error("PostgreSQL is not enabled in config")
        logger.error("Set storage.postgres.enabled to true before running migration")
        return 1

    # Check if data directory exists
    data_path = config['paths']['data']
    if not os.path.exists(data_path):
        logger.error(f"Data directory not found: {data_path}")
        logger.error("Make sure JSON data files exist before running migration")
        return 1

    # Run migration
    migration = JSONToPostgresMigration(config)
    success = await migration.migrate()

    return 0 if success else 1


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        logger.info("Migration cancelled by user")
        sys.exit(1)
    except Exception:
        logger.exception("Migration failed with unexpected error")
        sys.exit(1)
