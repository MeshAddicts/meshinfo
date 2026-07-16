#!/usr/bin/env python3
import asyncio
import datetime
import json
import logging
import os
import random
import time
from typing import Awaitable, Callable, Tuple
from zoneinfo import ZoneInfo

import discord
from dotenv import load_dotenv

import maintenance
from api import api
from bot import discord as discord_bot
from config import Config, ConfigValidationError
from data_store import DataStore
from mqtt import MQTT

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class _DowngradeSuccessfulGetRequests(logging.Filter):
    """Downgrade successful (2xx) GET request records from INFO to DEBUG.

    Uvicorn access log records have args=(client, method, path, http_version, status_code).
    Non-GET requests and error responses remain at INFO so they stay visible.
    Only visible when log level is set to DEBUG.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if (
            isinstance(record.args, tuple)
            and len(record.args) >= 5
            and record.args[1] == "GET"
            and isinstance(record.args[4], int)
            and 200 <= record.args[4] < 300
        ):
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
            # Suppress unless the logger is accepting DEBUG-level records
            return record.levelno >= logging.getLogger("uvicorn.access").getEffectiveLevel()
        return True


def init_runtime() -> Tuple[Config, DataStore]:
    """Initialize env/config/datastore without making any network connections."""
    load_dotenv()
    config = Config.load()
    data = DataStore(config)
    return config, data


def _read_text_file(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _read_json_file(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


MAINTENANCE_INTERVAL_SEC = 60.0


async def maintenance_loop(config, data, interval_seconds: float = MAINTENANCE_INTERVAL_SEC) -> None:
    """Periodic DB maintenance: mark nodes inactive past the activity threshold,
    keep the archive tables' monthly partitions rolled forward, and enforce the
    config-scheduled backups (applied on every start, so a config.toml change
    needs only a restart — no host cron)."""
    threshold = config['server']['node_activity_prune_threshold']
    tick = 0
    backup_task: asyncio.Task | None = None
    while True:
        try:
            pruned = await data.pg_storage.mark_nodes_inactive_by_age(threshold)
            if pruned:
                logger.debug("Pruned %d node(s) inactive for >= %ds", pruned, threshold)
            # Hourly: create next month's partition ahead of the rollover.
            if tick % 60 == 0:
                await data.pg_storage.ensure_mqtt_partitions()
            # Backups run whenever the newest dump is older than the schedule —
            # a single-flight background task; a multi-GB dump must not stall this loop.
            if (backup_task is None or backup_task.done()) and maintenance.backup_due(config):
                backup_task = asyncio.create_task(maintenance.run_backup(config))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Maintenance loop iteration failed")
        tick += 1
        await asyncio.sleep(interval_seconds)


ENRICHMENT_JITTER_FRAC = 0.1


async def enrichment_loop(config, data) -> None:
    """Periodically backfill node names/hardware from external enrichment APIs.
    ±10% jitter on the sleep so multiple deployments don't hit the same provider in lockstep."""
    interval = float(config['server']['enrich'].get('interval', 600))
    while True:
        try:
            await data.backfill_node_infos()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Enrichment loop iteration failed")
        jitter = random.uniform(-interval * ENRICHMENT_JITTER_FRAC, interval * ENRICHMENT_JITTER_FRAC)
        await asyncio.sleep(max(1.0, interval + jitter))


async def supervise(
    name: str,
    factory: Callable[[], Awaitable[None]],
    *,
    base_delay: float = 5.0,
    max_delay: float = 60.0,
) -> None:
    """
    Run a long-lived service; if it crashes, log and restart with backoff.
    Treat CancelledError as a real shutdown signal.
    """
    attempt = 0
    while True:
        try:
            attempt += 1
            if attempt == 1:
                logger.info("%s starting", name)
            else:
                logger.info("%s restarting (attempt %d)", name, attempt)

            await factory()

            # If it ever returns, treat that as unexpected for "run forever" services.
            logger.warning("%s exited normally; restarting in %.1fs", name, base_delay)
            await asyncio.sleep(base_delay)

        except asyncio.CancelledError:
            logger.info("%s cancelled", name)
            raise

        except Exception:
            delay = min(base_delay * (2 ** max(0, attempt - 1)), max_delay)
            logger.exception("%s crashed; restarting in %.1fs", name, delay)
            await asyncio.sleep(delay)


async def main() -> None:
    config, data = init_runtime()

    # Banner + version: best-effort only, shown first
    # NOTE: Banner intentionally uses print() for clean stdout display
    banner = _read_text_file("banner")
    if banner:
        print(banner)

    version = _read_json_file("version.json")
    if version:
        logger.info(
            "Version: %s (git sha: %s)",
            version.get("version", "unknown"),
            version.get("git_sha", "unknown"),
        )
    else:
        logger.info("Version file not found/invalid; continuing without version info")

    # --- Apply log level from config ---
    log_level_name = config.get("server", {}).get("log_level", "INFO").upper()
    valid_levels = logging.getLevelNamesMapping()
    if log_level_name in valid_levels:
        effective_log_level = valid_levels[log_level_name]
    else:
        logger.warning(
            "Invalid log level '%s' in config; falling back to INFO",
            log_level_name,
        )
        effective_log_level = logging.INFO
    logging.getLogger().setLevel(effective_log_level)
    logging.getLogger("uvicorn.access").addFilter(_DowngradeSuccessfulGetRequests())
    logging.getLogger("uvicorn.access").setLevel(effective_log_level)
    logger.info("Log level set to: %s", logging.getLevelName(effective_log_level))

    # Timezone
    tz = config["server"]["timezone"]
    os.environ["TZ"] = tz
    if hasattr(time, "tzset"):
        time.tzset()
    logger.info("Timezone set to: %s", tz)

    await data.load()
    startup_time = datetime.datetime.now(ZoneInfo(tz))
    data.update("startup_time", startup_time)

    # Placeholder until MQTT connects; MQTT will overwrite on successful connect.
    data.update("mqtt_connect_time", startup_time)

    api_server = api.API(config, data)

    background_tasks: list[asyncio.Task] = []

    # MQTT
    if config["broker"]["enabled"]:
        mqtt = MQTT(config, data)
        background_tasks.append(asyncio.create_task(supervise("MQTT", mqtt.connect)))
    else:
        logger.info("MQTT disabled in config")

    background_tasks.append(
        asyncio.create_task(supervise("Maintenance", lambda: maintenance_loop(config, data)))
    )

    if config['server'].get('enrich', {}).get('enabled'):
        background_tasks.append(
            asyncio.create_task(supervise("Enrichment", lambda: enrichment_loop(config, data)))
        )
    else:
        logger.info("Enrichment disabled in config")

    # Discord
    if config["integrations"]["discord"]["enabled"]:
        intents = discord.Intents.default()
        intents.message_content = True

        def make_discord_bot() -> discord_bot.DiscordBot:
            return discord_bot.DiscordBot(
                command_prefix="!",
                intents=intents,
                config=config,
                data=data,
            )

        async def run_discord() -> None:
            bot = make_discord_bot()
            await bot.start_server()

        background_tasks.append(asyncio.create_task(supervise("Discord", run_discord)))
    else:
        logger.info("Discord disabled in config")

    # API is critical: await it in the foreground.
    try:
        logger.info("API starting (critical)")
        await api_server.serve()
    finally:
        # If API exits or we get cancelled, stop secondaries.
        logger.info("Shutting down background services...")
        for t in background_tasks:
            t.cancel()
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)

        await data.pg_storage.close()

        logger.info("Shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Application stopped by user")
    except ConfigValidationError as e:
        logger.error("=" * 70)
        logger.error("MESHINFO CANNOT START: Configuration error")
        logger.error("=" * 70)
        logger.error(str(e))
        logger.error("=" * 70)
        raise SystemExit(1)