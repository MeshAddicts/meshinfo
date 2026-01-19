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
from zoneinfo import ZoneInfo

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
        return v.lower()

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
        for node_id, node_data in nodes.items():
            # Clean up node_id
            if node_id.startswith('!'):
                node_id = node_id.replace('!', '')
            if len(node_id) != 8:
                logger.warning(f"Skipping invalid node ID: {node_id}")
                continue
            
            # Ensure required fields
            if 'active' not in node_data or node_data['active'] is None:
                node_data['active'] = False
            if 'last_seen' not in node_data:
                node_data['last_seen'] = None
            if 'since' not in node_data:
                node_data['since'] = None
            
            try:
                await self.pg_storage.write_node(node_id, node_data)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} nodes...")
            except Exception as e:
                logger.error(f"Failed to migrate node {node_id}: {e}")
        
        logger.info(f"Successfully migrated {count} nodes")

    async def migrate_chat(self):
        """Migrate chat.json to PostgreSQL."""
        logger.info("Migrating chat messages...")

        chat_data = self.load_json_file("chat.json")
        if not chat_data:
            logger.warning("No chat.json file found or file is empty")
            return

        # chat.json is known to contain duplicate message ids; dedupe in-memory for cleaner results/logging
        seen_ids = set()
        skipped_dupes = 0

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

                    await self.pg_storage.write_chat_message(from_id, message)
                    count += 1
                    if count % 100 == 0:
                        logger.info(f"Migrated {count} chat messages...")
                except Exception as e:
                    logger.error(f"Failed to migrate chat message {message.get('id')}: {e}")

        logger.info(f"Successfully migrated {count} chat messages (skipped {skipped_dupes} duplicate ids in chat.json)")

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

                await self.pg_storage.write_telemetry(from_id, msg)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} telemetry records...")
            except Exception as e:
                logger.error(f"Failed to migrate telemetry: {e}")

        logger.info(f"Successfully migrated {count} telemetry records (skipped {skipped_dupes} duplicate records in telemetry.json)")

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

                await self.pg_storage.write_traceroute(from_id, msg)
                count += 1
                if count % 100 == 0:
                    logger.info(f"Migrated {count} traceroutes...")
            except Exception as e:
                logger.error(f"Failed to migrate traceroute: {e}")

        logger.info(f"Successfully migrated {count} traceroutes (skipped {skipped_dupes} duplicate records in traceroutes.json)")


async def main():
    """Main migration entry point."""
    logger.info("Loading configuration...")
    
    try:
        config = Config.load()
    except Exception as e:
        logger.error(f"Failed to load config.json: {e}")
        logger.error("Make sure config.json exists and is valid")
        return 1
    
    # Check if PostgreSQL is configured
    pg_config = config.get('storage', {}).get('postgres', {})
    if not pg_config.get('enabled', False):
        logger.error("PostgreSQL is not enabled in config.json")
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
