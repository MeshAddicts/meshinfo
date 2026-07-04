# PostgreSQL Storage

MeshInfo uses PostgreSQL as its storage backend. This document covers configuration, schema, and operational guidance.

## Configuration

Add the following to your `config.toml`:

```toml
[storage.postgres]
enabled = true
host = "postgres"
port = 5432
database = "meshinfo"
username = "postgres"
password = "your_password"
min_pool_size = 1
max_pool_size = 5
```

### Configuration Options

- **`postgres.enabled`**: Must be `true`
- **`postgres.host`**: Database server hostname (use `"localhost"` if not using Docker)
- **`postgres.port`**: Database server port (default: 5432)
- **`postgres.database`**: Database name
- **`postgres.username`**: Database user
- **`postgres.password`**: Database password
- **`postgres.min_pool_size`**: Minimum connection pool size (default: 1)
- **`postgres.max_pool_size`**: Maximum connection pool size (default: 5)

## Database Schema

The schema is automatically created on first run. Key tables:

- **`nodes`**: Core node information (ID, name, hardware, status)
- **`node_positions`**: Historical position data
- **`node_neighborinfo`**: Neighbor relationships (JSONB)
- **`node_telemetry_current`**: Most recent telemetry per node
- **`telemetry`**: Complete telemetry history (JSONB payloads)
- **`chat_channels`**: Chat channel metadata
- **`chat_messages`**: All chat messages
- **`traceroutes`**: Complete traceroute history (JSONB payloads)

## Architecture

### Write Flow

1. MQTT message received
2. Handler reads existing node via `pg_storage.get_node_cached` (LRU + DB)
3. Handler merges incoming fields into the node
4. `data.update_node` writes the merged node to PostgreSQL and refreshes the cache

### Read Flow

1. Application starts
2. PostgreSQL connection established
3. API queries PostgreSQL directly for each request (node lookups hit the LRU cache first)

### Error Handling

- PostgreSQL write failures are logged but **never block** application execution
- Connection pool handles transient network issues
- Failed writes are logged for manual investigation

## Performance Considerations

### Memory tuning

The `postgres` service in both compose files sets a few core memory
parameters via its `command:`. The defaults are deliberately conservative so
the stack runs on a small host, but they are already well above the stock
`postgres` image defaults (`shared_buffers` 128 MB, `work_mem` 4 MB).

Size them to your host: copy `.env.sample` to `.env` next to the compose file
(Docker Compose reads it automatically) and set any of:

| Variable                   | Default | What it does                                  |
|----------------------------|---------|-----------------------------------------------|
| `PG_SHARED_BUFFERS`        | `256MB` | Dedicated PG page cache (real RAM allocation). |
| `PG_WORK_MEM`              | `8MB`   | Per-sort/hash memory; multiplied by concurrency. |
| `PG_MAINTENANCE_WORK_MEM`  | `64MB`  | VACUUM / CREATE INDEX working memory.          |
| `PG_EFFECTIVE_CACHE_SIZE`  | `1GB`   | Planner hint for OS+PG cache (not an allocation). |

Suggested starting points by **total host RAM** (assuming Postgres shares the
box with the rest of the MeshInfo stack — give it less than a dedicated DB
host would get):

| Host RAM | `PG_SHARED_BUFFERS` | `PG_WORK_MEM` | `PG_MAINTENANCE_WORK_MEM` | `PG_EFFECTIVE_CACHE_SIZE` |
|----------|---------------------|---------------|---------------------------|---------------------------|
| 4 GB     | `512MB`             | `16MB`        | `128MB`                   | `2GB`                     |
| 8 GB     | `1GB`               | `32MB`        | `256MB`                   | `4GB`                     |
| 16 GB    | `2GB`               | `64MB`        | `512MB`                   | `10GB`                    |

Example `.env`:

```
PG_SHARED_BUFFERS=512MB
PG_WORK_MEM=16MB
PG_MAINTENANCE_WORK_MEM=128MB
PG_EFFECTIVE_CACHE_SIZE=2GB
```

Recreate the container to apply: `docker compose up -d postgres`.

### Real-time Writes

All writes happen in real-time as data arrives from MQTT, ensuring minimal data loss on crash.

### Connection Pooling

asyncpg connection pooling handles concurrent writes efficiently. Tune `min_pool_size` and `max_pool_size` based on your load.

### Indexing

Key indexes are maintained on node IDs, timestamps, and foreign key relationships for fast queries even with large datasets.

## Monitoring

PostgreSQL operations are logged at INFO and ERROR levels:

```
INFO: PostgreSQL mode: Data will be queried directly from database
ERROR: Failed to write node abc123 to Postgres: connection timeout
```

Monitor these logs to ensure healthy operation.

## Troubleshooting

### Connection Failures

If PostgreSQL connection fails on startup, MeshInfo will log the error and exit. Check:

1. PostgreSQL container/service is running
2. Connection settings in `config.toml` are correct (`host`, `port`, `username`, `password`)
3. Network connectivity between MeshInfo and the database

### Data Inconsistencies

To verify record counts:

```sql
SELECT COUNT(*) FROM nodes;
SELECT COUNT(*) FROM chat_messages;
SELECT COUNT(*) FROM telemetry;
SELECT COUNT(*) FROM traceroutes;
```

### Migrating from JSON Storage

Very old deployments used JSON file storage. The one-time migration script
(`scripts/migrate_json_to_postgres.py`) was removed after the JSON store was
retired — it required the legacy `[paths]` config section that no longer
exists. If you still need it, run the copy from a pre-removal release
(check out a tag from before July 2026) against your legacy deployment,
then upgrade.

## Upgrading PostgreSQL major versions

PostgreSQL major versions (16 → 18, etc.) use **incompatible on-disk storage
formats**. A newer `postgres` container will refuse to start against a data
volume initialised by an older one, failing with:

```
FATAL: database files are incompatible with server
DETAIL: The data directory was initialized by PostgreSQL version 16,
        which is not compatible with this version 18.x.
```

When a MeshInfo release bumps the `postgres` image major version, run the
included migration script once. It dumps the database with a temporary
container of the *old* version, recreates the volume, and restores into the
*new* version — using only official `postgres` images.

```sh
git pull
docker compose pull               # fetch the new postgres image
bash scripts/migrate-postgres.sh  # one-time: dump old → restore new
docker compose up -d
```

For a development stack, point the script at the dev compose file:

```sh
COMPOSE_FILE=docker-compose-dev.yml bash scripts/migrate-postgres.sh
```

Notes:

- The script writes a compressed SQL dump to `backups/` and **verifies it
  before** recreating the volume — that file is your recovery artifact.
- It is a no-op on fresh installs and when the volume is already current, so
  it is safe to run unconditionally as part of an update.
- On Windows, run it from **Git Bash** (bundled with Git) — `bash
  scripts/migrate-postgres.sh`. The script is MSYS-path-safe, so the single
  bash version covers every platform.
- Set `KEEP_VOLUME_BACKUP=1` to also snapshot the old data volume to
  `<volume>_oldpg_backup` for an instant rollback (uses extra disk; delete it
  once the upgrade is verified).
- To roll back from the SQL dump: set the `postgres` image (and volume mount)
  in your compose file back to the old version, remove the data volume so it
  re-initialises empty, `docker compose up -d postgres`, then restore —
  `gzip -dc backups/<dump>.sql.gz | docker compose exec -T postgres psql -U postgres -d meshinfo`.

## Partitioning the mqtt_messages archive

`mqtt_messages` is the raw packet firehose and dominates the database — it
typically holds 98%+ of all rows. Fresh installs since this change get a
**partitioned table** (RANGE partitioned by month on `created_at`), so the
table stays operationally manageable as it grows: each date-range query
prunes to the relevant month(s) instead of scanning everything, and
maintenance runs at partition scale, not table scale. The app
(`ensure_mqtt_partitions`) keeps next month's partition created ahead of
the rollover.

Databases created before partitioning landed need a **one-time conversion**:

```sh
bash scripts/migrate-mqtt-partitioning.sh
# dev stack:  COMPOSE_FILE=docker-compose-dev.yml bash scripts/migrate-mqtt-partitioning.sh
```

What it does, inside a **single atomic transaction**:

1. Renames the existing table to `mqtt_messages_old`.
2. Creates a new month-partitioned `mqtt_messages` (with the `payload`
   column `lz4`-compressed).
3. Creates one partition per month spanned by the data, copies every row,
   and verifies the row count matches before committing.
4. Rebuilds indexes, re-homes the `id` sequence, reinstalls the trigger.

Any failure rolls the whole thing back — `mqtt_messages` is untouched.
The script stops `meshinfo` for the duration and restarts it on success.

Notes:

- **Requires lz4:** the partitioned `mqtt_messages` `payload` column uses
  `COMPRESSION lz4`, so Postgres must be built with lz4 support (PG 14+ — the
  official `postgres:18` image this stack ships with includes it). A self-hosted
  Postgres compiled without lz4 will reject both the fresh-install schema and the
  migration with `compression method lz4 not supported`.
- **Disk:** the migration needs ~3× the current `mqtt_messages` size free
  on the data volume transiently (new copy + WAL + headroom). The pre-flight
  check aborts with a clear message if there's not enough. Expand the data
  volume first if you're short.
- **Rollback safety:** the original data is kept as `mqtt_messages_old`
  until you drop it. Disk is not reclaimed until then. Once you've
  confirmed the app + Logs page look right, run:
  ```sh
  docker compose exec postgres psql -U postgres -d meshinfo \
    -c 'DROP TABLE mqtt_messages_old;'
  ```
- **Idempotent**: re-running the script when the table is already
  partitioned (or doesn't exist yet) is a no-op.
- **On Windows**, run from Git Bash, like `migrate-postgres.sh`.
- Partitioning does not shrink disk — it makes a huge table manageable.
  Complete-history retention still implies the data volume must be
  allowed to grow.

## Security

- Use strong passwords for PostgreSQL
- Consider SSL/TLS for database connections in production
- Restrict database access via network policies
- Set up regular PostgreSQL backups (e.g., `pg_dump`)
- Keep PostgreSQL updated with security patches

## Support

For issues or questions:
- Open an issue on GitHub
- Join #meshinfo on SacValleyMesh Discord
- Review application logs for detailed error messages
