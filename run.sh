#!/usr/bin/env bash

# Initialize PostgreSQL schema if enabled
python -c "
import asyncio
from config import Config
from storage.db.postgres import PostgresStorage

async def init_schema():
    try:
        config = Config.load()
        pg = PostgresStorage(config)
        if pg.enabled:
            connected = await pg.connect()
            if connected:
                await pg.ensure_schema()
                await pg.close()
                print('PostgreSQL schema initialized')
    except Exception as e:
        print(f'Schema init skipped: {e}')

asyncio.run(init_schema())
"

# Start the main application
python main.py