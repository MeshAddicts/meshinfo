#!/usr/bin/env python3
import asyncio
import datetime
import json
import logging
import os
import time
from typing import Tuple
from zoneinfo import ZoneInfo

import discord
from dotenv import load_dotenv

from api import api
from bot import discord as discord_bot
from config import Config
from memory_data_store import MemoryDataStore
from mqtt import MQTT

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def init_runtime() -> Tuple[Config, MemoryDataStore]:
    """Initialize environment, config, and data store.
    
    Returns:
        Tuple[Config, MemoryDataStore]: Configuration and data store objects ready for use
        
    Raises:
        Exception: If initialization fails
    """
    try:
        load_dotenv()
        config = Config.load()
        data = MemoryDataStore(config)
        logger.info("Runtime initialization completed successfully")
        return config, data
    except Exception as e:
        logger.exception("Error during initialization")
        raise


async def main() -> None:
    """Main application entry point."""
    config, data = init_runtime()
    
    # Output app banner from file
    try:
        with open("banner", "r", encoding="utf-8") as f:
            banner = f.read()
        print(banner)
    except FileNotFoundError:
        logger.info("Banner file not found at ./banner, continuing without banner")
    
    # Load version information
    try:
        with open("version.json", "r", encoding="utf-8") as f:
            version = json.load(f)
        logger.info(f"Version: {version['version']} (git sha: {version['git_sha']})")
    except FileNotFoundError:
        logger.info("Version file not found at ./version.json, continuing without version info")
    
    os.makedirs(config["paths"]["output"], exist_ok=True)
    os.makedirs(config["paths"]["data"], exist_ok=True)
    logger.info(f"Ensured directories exist: {config['paths']['output']}, {config['paths']['data']}")
    
    # Set timezone
    os.environ["TZ"] = config["server"]["timezone"]
    # Call tzset() on POSIX systems to apply the TZ change
    if hasattr(time, 'tzset'):
        time.tzset()
    logger.info(f"Set timezone to: {config['server']['timezone']}")
    
    # Load data from disk, then set MQTT connect time, then save
    data.load()
    data.update("mqtt_connect_time", datetime.datetime.now(ZoneInfo(config["server"]["timezone"])))
    await data.save()
    logger.info("Data loaded and MQTT connect time updated")
    
    # Start all services using TaskGroup
    logger.info("Starting application services...")
    async with asyncio.TaskGroup() as tg:
        loop = asyncio.get_running_loop()
        
        # Always start the API server
        api_server = api.API(config, data)
        tg.create_task(api_server.serve(loop))
        logger.info("API server task created")
        
        # Start MQTT if enabled
        if config["broker"]["enabled"]:
            mqtt = MQTT(config, data)
            tg.create_task(mqtt.connect())
            logger.info("MQTT broker task created")
        else:
            logger.info("MQTT broker disabled in config")
        
        # Start Discord bot if enabled
        if config["integrations"]["discord"]["enabled"]:
            bot = discord_bot.DiscordBot(
                command_prefix="!",
                intents=discord.Intents.all(),
                config=config,
                data=data,
            )
            tg.create_task(bot.start_server())
            logger.info("Discord bot task created")
        else:
            logger.info("Discord bot disabled in config")


if __name__ == "__main__":
    try:
        logger.info("Application starting...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Application stopped by user")
    except Exception as e:
        logger.exception("Application crashed")
        raise