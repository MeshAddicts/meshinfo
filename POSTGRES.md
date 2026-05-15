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

If you are upgrading from an older version that used JSON file storage, a one-time migration script is available. **This script must be run against your legacy deployment before upgrading** — it requires:

- The JSON data files still present on disk (`nodes.json`, `chat.json`, `telemetry.json`, `traceroutes.json`)
- The old `[paths]` section in your config (with `paths.data` pointing to those files)

From that legacy environment, run:

```bash
docker exec -it meshinfo-meshinfo-1 python3 scripts/migrate_json_to_postgres.py
```

This reads your existing JSON data files and imports them into PostgreSQL. Once complete, update your config to the new PostgreSQL-only format (see `config.toml.sample`) and restart.

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
