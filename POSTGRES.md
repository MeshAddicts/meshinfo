# PostgreSQL Integration for MeshInfo

This document describes the PostgreSQL dual-write implementation for MeshInfo.

## Overview

MeshInfo now supports PostgreSQL as an alternative storage backend alongside JSON files. The implementation follows a **dual-write pattern** where:

1. All writes go to **both** JSON files and PostgreSQL (when enabled)
2. Reads can come from **either** JSON or PostgreSQL (configurable)
3. JSON files remain authoritative during the transition period
4. PostgreSQL failures never block JSON operations

## Configuration

Add the following to your `config.toml`:

```toml
[storage]
read_from = "json"
write_to = ["json", "postgres"]

[storage.postgres]
enabled = false
host = "postgres"
port = 5432
database = "meshinfo"
username = "postgres"
password = "password"
min_pool_size = 5
max_pool_size = 20
```

### Configuration Options

- **`read_from`**: `"json"` or `"postgres"` - Controls where data is loaded from on startup
- **`write_to`**: Array of `["json", "postgres"]` - Controls which backends receive writes
- **`postgres.enabled`**: `true` or `false` - Master switch for PostgreSQL functionality
- **`postgres.host`**: Database server hostname
- **`postgres.port`**: Database server port (default: 5432)
- **`postgres.database`**: Database name
- **`postgres.username`**: Database user
- **`postgres.password`**: Database password
- **`postgres.min_pool_size`**: Minimum connection pool size (default: 5)
- **`postgres.max_pool_size`**: Maximum connection pool size (default: 20)

## Database Schema

The PostgreSQL schema stores data in a relational structure while maintaining compatibility with the JSON format. Key tables include:

- **`nodes`**: Core node information (ID, name, hardware, status)
- **`node_positions`**: Historical position data
- **`node_neighborinfo`**: Neighbor relationships (JSONB)
- **`node_telemetry_current`**: Most recent telemetry per node
- **`telemetry`**: Complete telemetry history (JSONB payloads)
- **`chat_channels`**: Chat channel metadata
- **`chat_messages`**: All chat messages
- **`traceroutes`**: Complete traceroute history (JSONB payloads)

The schema is automatically created on first run when PostgreSQL is enabled.

## Migration

To migrate existing JSON data to PostgreSQL:

### Step 1: Enable PostgreSQL

Update `config.toml`:
```toml
[storage.postgres]
enabled = true
```

### Step 2: Start PostgreSQL

If using Docker Compose, PostgreSQL should already be running. Otherwise, start it:

```bash
docker-compose up -d postgres
```

### Step 3: Run Migration Script

```bash
python scripts/migrate_json_to_postgres.py
```

The script will:
- Connect to PostgreSQL
- Create the database schema if needed
- Import all nodes, chat messages, telemetry, and traceroutes from JSON files
- Preserve all historical data
- Report progress and any errors

### Step 4: Enable Dual-Write

Update `config.toml` to write to both backends:
```toml
[storage]
read_from = "json"
write_to = ["json", "postgres"]

[storage.postgres]
enabled = true
```

### Step 5: Verify Data Consistency

- Monitor logs for any PostgreSQL write errors
- Spot-check the API to ensure data is identical
- Compare record counts between JSON and PostgreSQL

### Step 6: Switch to PostgreSQL Reads

Once confident in data consistency, switch to direct PostgreSQL queries:
```toml
[storage]
read_from = "postgres"
write_to = ["json", "postgres"]
```

**Important**: When `read_from: "postgres"`, the API queries PostgreSQL directly without loading data into memory. This provides:
- Lower memory footprint
- Always up-to-date data from the database
- Better scalability for large datasets

## Architecture

### Write Flow

1. MQTT message received
2. Data stored in memory (MemoryDataStore) for internal use
3. **Real-time write to PostgreSQL** (non-blocking, errors logged)
4. Periodic write to JSON files (every 300 seconds by default)

### Read Flow (JSON mode)

1. Application starts
2. Data loaded from JSON files into memory
3. API serves from in-memory data structures
4. Fast response times with full dataset in RAM

### Read Flow (PostgreSQL mode)

1. Application starts
2. PostgreSQL connection established (no data loaded into memory)
3. **API queries PostgreSQL directly** for each request
4. Lower memory footprint, always current data
5. Efficient queries with proper indexing

### Error Handling

- PostgreSQL write failures are logged but **never block** application execution
- If PostgreSQL reads fail, the system automatically falls back to JSON
- Connection pool handles transient network issues
- Failed writes are logged for manual investigation

## Data Retention

- **JSON files**: Limited history (configurable via file-based rotation)
- **PostgreSQL**: Unlimited history (all records preserved indefinitely)

## Performance Considerations

### Real-time Writes

All writes to PostgreSQL happen in real-time as data arrives from MQTT. This ensures:
- Minimal data loss in case of application crash
- Up-to-date data in PostgreSQL at all times
- No batch write delays

### Connection Pooling

The implementation uses asyncpg connection pooling (5-20 connections by default) to handle concurrent writes efficiently.

### Indexing

Key indexes are created on:
- Node IDs
- Timestamps
- Foreign key relationships

This ensures fast queries even with large datasets.

## Backwards Compatibility

The implementation fully supports:

1. **Running without PostgreSQL**: Simply don't enable it in config
2. **Downgrading to JSON-only**: Set `postgres.enabled: false` and restart
3. **JSON as authoritative source**: Keep `read_from: "json"` during transition

## Monitoring

PostgreSQL operations are logged at INFO and ERROR levels:

```
INFO: PostgreSQL connection pool established
INFO: Loaded 1234 nodes from PostgreSQL
ERROR: Failed to write node abc123 to PostgreSQL: connection timeout
```

Monitor these logs to ensure healthy operation.

## Troubleshooting

### Connection Failures

If PostgreSQL connection fails:
1. Check that PostgreSQL container is running
2. Verify connection settings in config.toml
3. Check network connectivity
4. Review PostgreSQL logs

The application will continue running with JSON-only mode.

### Data Inconsistencies

To verify data consistency:

1. **Count records**:
   ```sql
   SELECT COUNT(*) FROM nodes;
   SELECT COUNT(*) FROM chat_messages;
   SELECT COUNT(*) FROM telemetry;
   SELECT COUNT(*) FROM traceroutes;
   ```

2. **Compare with JSON** via API endpoints

3. **Check for write errors** in application logs

### Migration Issues

If migration fails:
1. Check PostgreSQL logs for errors
2. Verify JSON files are valid and readable
3. Ensure sufficient disk space
4. Try migrating data types individually (modify script)

## Future Enhancements

Potential future improvements:
- Write-ahead log for failed PostgreSQL writes
- Automatic retry logic with exponential backoff
- Data validation and integrity checks
- Performance metrics and monitoring
- Support for read replicas
- Automatic failover between backends

## Security

- Use strong passwords for PostgreSQL
- Consider using SSL/TLS for database connections in production
- Restrict database access via network policies
- Regular backups of PostgreSQL data
- Keep PostgreSQL updated with security patches

## Support

For issues or questions:
- Open an issue on GitHub
- Join #meshinfo on SacValleyMesh Discord
- Review application logs for detailed error messages
