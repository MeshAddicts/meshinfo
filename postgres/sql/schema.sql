-- Postgres schema for MeshInfo. Postgres is the sole storage backend.

-- Nodes table - stores basic node information
CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(8) PRIMARY KEY,  -- 8 hex character node ID
    longname VARCHAR(255),
    shortname VARCHAR(10),
    hardware VARCHAR(50),
    role INTEGER,
    active BOOLEAN DEFAULT TRUE,
    tc2_bbs BOOLEAN DEFAULT FALSE,
    gateway VARCHAR(8),
    last_seen TIMESTAMP WITH TIME ZONE,
    since_seconds REAL,  -- Duration in seconds since last seen
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nodes_active ON nodes(active);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen);
CREATE INDEX IF NOT EXISTS idx_nodes_shortname_lower ON nodes(LOWER(shortname));
CREATE INDEX IF NOT EXISTS idx_nodes_longname_lower ON nodes(LOWER(longname));

-- Node positions table - stores ONLY the most recent position per node (latest-only)
CREATE TABLE IF NOT EXISTS node_positions (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    latitude_i INTEGER,  -- Latitude in integer format (degrees * 10000000)
    longitude_i INTEGER, -- Longitude in integer format (degrees * 10000000)
    altitude INTEGER,
    time INTEGER,
    precision_bits INTEGER,
    geocoded JSONB,  -- Geocoded address information
    last_geocoding TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT node_positions_node_id_unique UNIQUE (node_id)
);

-- With UNIQUE(node_id), Postgres creates a unique index automatically.
CREATE INDEX IF NOT EXISTS idx_node_positions_updated_at ON node_positions(updated_at DESC);

-- Node neighbor info table - stores neighbor relationships (latest-only per node)
CREATE TABLE IF NOT EXISTS node_neighborinfo (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    node_broadcast_interval_secs INTEGER,
    neighbors JSONB,  -- Array of neighbor objects
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT node_neighborinfo_node_id_key UNIQUE (node_id)
);

-- Node telemetry current - stores the most recent telemetry per node
-- Device metrics and environment metrics have dedicated typed columns.
-- Other telemetry variants (power, air quality, local stats, health,
-- host metrics, traffic management) are stored as JSONB columns.
CREATE TABLE IF NOT EXISTS node_telemetry_current (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    -- device_metrics fields
    battery_level INTEGER,
    voltage REAL,
    channel_utilization REAL,
    air_util_tx REAL,
    uptime_seconds INTEGER,
    -- environment_metrics fields
    temperature REAL,
    relative_humidity REAL,
    barometric_pressure REAL,
    gas_resistance REAL,
    iaq INTEGER,
    distance REAL,
    lux REAL,
    white_lux REAL,
    ir_lux REAL,
    uv_lux REAL,
    wind_direction INTEGER,
    wind_speed REAL,
    weight REAL,
    current REAL,               -- current measured (A)
    wind_gust REAL,             -- wind gust in m/s
    wind_lull REAL,             -- wind lull in m/s
    radiation REAL,             -- radiation in µR/h
    rainfall_1h REAL,           -- rainfall last hour in mm
    rainfall_24h REAL,          -- rainfall last 24h in mm
    soil_moisture INTEGER,      -- soil moisture % (1-100)
    soil_temperature REAL,      -- soil temperature in °C
    -- JSONB columns for other telemetry variants (latest snapshot per node)
    power_metrics JSONB,                -- PowerMetrics (multi-channel voltage/current)
    air_quality_metrics JSONB,          -- AirQualityMetrics (PM, CO2, particles, etc.)
    local_stats JSONB,                  -- LocalStats (mesh statistics)
    health_metrics JSONB,               -- HealthMetrics (heart rate, SpO2, temp)
    host_metrics JSONB,                 -- HostMetrics (Linux host system metrics)
    traffic_management_stats JSONB,     -- TrafficManagementStats
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(node_id)
);

-- Telemetry history table - stores all telemetry messages
CREATE TABLE IF NOT EXISTS telemetry (
    id BIGSERIAL PRIMARY KEY,
    from_node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    sender_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    message_id BIGINT NOT NULL,
    channel INTEGER,
    packet_id BIGINT,
    hops_away INTEGER,
    rssi INTEGER,
    snr REAL,
    timestamp BIGINT,
    rx_time TIMESTAMP WITH TIME ZONE,
    telemetry_type TEXT,
    payload JSONB,  -- Complete telemetry payload
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT telemetry_from_node_id_message_id_key UNIQUE (from_node_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_from_node_id ON telemetry(from_node_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_created_at ON telemetry(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_rx_time ON telemetry(rx_time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry(telemetry_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_node_type ON telemetry(from_node_id, telemetry_type);

-- Chat channels table
CREATE TABLE IF NOT EXISTS chat_channels (
    id VARCHAR(10) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default channel
INSERT INTO chat_channels (id, name) VALUES ('0', 'General') ON CONFLICT (id) DO NOTHING;

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT PRIMARY KEY,
    from_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    to_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    sender_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    channel_id VARCHAR(10) REFERENCES chat_channels(id),
    text TEXT,
    timestamp BIGINT,
    rx_time TIMESTAMP WITH TIME ZONE,
    hops_away INTEGER,
    rssi INTEGER,
    snr REAL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_id ON chat_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_from_node_id ON chat_messages(from_node_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp DESC);

-- Traceroutes table
CREATE TABLE IF NOT EXISTS traceroutes (
    id BIGSERIAL PRIMARY KEY,
    from_node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    sender_node_id VARCHAR(8) REFERENCES nodes(id) ON DELETE SET NULL,
    message_id BIGINT NOT NULL,
    channel INTEGER,
    packet_id BIGINT,
    hops_away INTEGER,
    rssi INTEGER,
    snr REAL,
    timestamp BIGINT,
    rx_time TIMESTAMP WITH TIME ZONE,
    route JSONB,  -- Array of route node IDs
    route_ids JSONB,  -- Array of resolved route IDs
    payload JSONB,  -- Complete traceroute payload
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT traceroutes_from_node_id_message_id_key UNIQUE (from_node_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_traceroutes_from_node_id ON traceroutes(from_node_id);
CREATE INDEX IF NOT EXISTS idx_traceroutes_to_node_id ON traceroutes(to_node_id);
CREATE INDEX IF NOT EXISTS idx_traceroutes_created_at ON traceroutes(created_at DESC);

-- Resolved return-path hop ids (reply rows only; NULL on rows written before
-- the column existed — consumers must treat absence as "not resolved", the
-- verbatim RouteDiscovery route_back still lives in payload).
-- NOTE: fresh-install copies. Existing databases get these from the
-- migrations block in ensure_schema (storage/db/postgres.py), which runs
-- with a long timeout — this file executes as one short-timeout transaction,
-- where a full-table index build could roll everything back.
ALTER TABLE traceroutes ADD COLUMN IF NOT EXISTS route_back_ids JSONB;
CREATE INDEX IF NOT EXISTS idx_traceroutes_sender_node_id ON traceroutes(sender_node_id);
-- Containment lookups for "traceroutes involving node X as a relay"
-- (route_ids @> jsonb_build_array(id)); jsonb_path_ops is @>-only and small.
CREATE INDEX IF NOT EXISTS idx_traceroutes_route_ids_gin
    ON traceroutes USING gin (route_ids jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_traceroutes_route_back_ids_gin
    ON traceroutes USING gin (route_back_ids jsonb_path_ops);

-- MQTT messages: the raw packet archive. Partitioned by month on created_at
-- so it stays manageable as it grows. This block only fires on a fresh install
-- (the table does not yet exist); existing non-partitioned installs are
-- converted by scripts/migrate-mqtt-partitioning.sh and are left untouched here.
-- The app (ensure_mqtt_partitions) creates the real monthly partitions.
DO $mqtt$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'mqtt_messages' AND relnamespace = 'public'::regnamespace
    ) THEN
        CREATE TABLE mqtt_messages (
            id           BIGSERIAL,
            topic        TEXT,
            payload      TEXT COMPRESSION lz4,
            qos          INTEGER,
            retain       BOOLEAN,
            timestamp    BIGINT,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            from_node_id VARCHAR(8),
            to_node_id   VARCHAR(8),
            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);
        -- Safety net so an insert never fails for a missing month.
        CREATE TABLE mqtt_messages_default PARTITION OF mqtt_messages DEFAULT;
    END IF;
END $mqtt$;

CREATE INDEX IF NOT EXISTS idx_mqtt_messages_created_at ON mqtt_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_messages_timestamp ON mqtt_messages(timestamp DESC);

-- Node ID columns for filtered packet queries (managed via ensure_schema migrations)
ALTER TABLE mqtt_messages ADD COLUMN IF NOT EXISTS from_node_id VARCHAR(8);
ALTER TABLE mqtt_messages ADD COLUMN IF NOT EXISTS to_node_id VARCHAR(8);
CREATE INDEX IF NOT EXISTS idx_mqtt_messages_from_node_id ON mqtt_messages(from_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_messages_to_node_id ON mqtt_messages(to_node_id, created_at DESC);

-- Uplink dedup (#526): mqtt_messages keeps one canonical row per logical mesh
-- packet (keyed from_node_id + packet_id within the ingest dedup window); every
-- per-gateway uplink copy is recorded in packet_receptions instead. packet_id
-- is populated by the app (trigger fallback for direct SQL inserts); its lookup
-- index backs the ingest cache-miss fallback and is created by ensure_schema
-- (initial build on a large archive needs a long timeout).
ALTER TABLE mqtt_messages ADD COLUMN IF NOT EXISTS packet_id BIGINT;

-- Interned uplink topics: a handful of distinct topic strings repeat across
-- millions of receptions, so receptions store a small topic_id instead.
CREATE TABLE IF NOT EXISTS mqtt_topics (
    id    SERIAL PRIMARY KEY,
    topic TEXT NOT NULL UNIQUE
);

-- One row per uplink copy (including the canonical/first one): the per-gateway
-- RF envelope plus a sparse `extras` patch so each original copy is exactly
-- reconstructible from canonical payload + this row (storage/db/uplink_dedup.py).
-- Partitioned monthly like mqtt_messages; the app rolls partitions forward.
DO $recv$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'packet_receptions' AND relnamespace = 'public'::regnamespace
    ) THEN
        CREATE TABLE packet_receptions (
            mqtt_row_id BIGINT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            gateway     VARCHAR(8),
            topic_id    INTEGER,
            rx_rssi     SMALLINT,
            rx_snr      DOUBLE PRECISION,
            rx_time     BIGINT,
            hop_limit   SMALLINT,
            hops_away   SMALLINT,
            relay_node  INTEGER,
            transport   SMALLINT,
            extras      JSONB
        ) PARTITION BY RANGE (created_at);
        -- Safety net so an insert never fails for a missing month.
        CREATE TABLE packet_receptions_default PARTITION OF packet_receptions DEFAULT;
    END IF;
END $recv$;

CREATE INDEX IF NOT EXISTS idx_packet_receptions_row
    ON packet_receptions(mqtt_row_id, created_at);
CREATE INDEX IF NOT EXISTS idx_packet_receptions_gateway
    ON packet_receptions(gateway, created_at DESC);

-- Neighbor snapshot history table (currently unused, for time-lapse update later on)
CREATE TABLE IF NOT EXISTS node_neighborinfo_history (
  id BIGSERIAL PRIMARY KEY,
  node_id VARCHAR(8) NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rx_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  neighbors JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_neighborinfo_hist_node_time
  ON node_neighborinfo_history (node_id, rx_time DESC);

CREATE INDEX IF NOT EXISTS idx_neighborinfo_hist_rx_time
  ON node_neighborinfo_history (rx_time DESC);

-- Optional: pinned for later scheduling
CREATE OR REPLACE FUNCTION prune_neighborinfo_history(p_days INT DEFAULT 30)
RETURNS VOID AS $$
  DELETE FROM node_neighborinfo_history
  WHERE rx_time < NOW() - (p_days || ' days')::INTERVAL;
$$ LANGUAGE sql;

-- Create a function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at (idempotent)

DROP TRIGGER IF EXISTS update_nodes_updated_at ON nodes;
CREATE TRIGGER update_nodes_updated_at
BEFORE UPDATE ON nodes
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_node_positions_updated_at ON node_positions;
CREATE TRIGGER update_node_positions_updated_at
BEFORE UPDATE ON node_positions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_node_neighborinfo_updated_at ON node_neighborinfo;
CREATE TRIGGER update_node_neighborinfo_updated_at
BEFORE UPDATE ON node_neighborinfo
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_node_telemetry_current_updated_at ON node_telemetry_current;
CREATE TRIGGER update_node_telemetry_current_updated_at
BEFORE UPDATE ON node_telemetry_current
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_timestamp
ON chat_messages (channel_id, timestamp DESC);

-- Idempotent migrations: add columns introduced after initial schema deployment.
-- Safe to run on any existing database; no-ops on fresh installs.
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS current REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS wind_gust REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS wind_lull REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS radiation REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS rainfall_1h REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS rainfall_24h REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS soil_moisture INTEGER;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS soil_temperature REAL;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS power_metrics JSONB;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS air_quality_metrics JSONB;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS local_stats JSONB;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS health_metrics JSONB;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS host_metrics JSONB;
ALTER TABLE node_telemetry_current ADD COLUMN IF NOT EXISTS traffic_management_stats JSONB;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_channel VARCHAR(10);

-- Position datum/provenance: lets the frontend normalize HAE→MSL and flag manual/barometric readings.
ALTER TABLE node_positions ADD COLUMN IF NOT EXISTS altitude_hae INTEGER;
ALTER TABLE node_positions ADD COLUMN IF NOT EXISTS altitude_geoidal_separation INTEGER;
ALTER TABLE node_positions ADD COLUMN IF NOT EXISTS location_source SMALLINT;
ALTER TABLE node_positions ADD COLUMN IF NOT EXISTS altitude_source SMALLINT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Discord bridge tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Links between mesh nodes and Discord users
CREATE TABLE IF NOT EXISTS discord_node_links (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(8) NOT NULL,
    discord_user_id VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT discord_node_links_unique UNIQUE (node_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_node_links_node_id ON discord_node_links(node_id);
CREATE INDEX IF NOT EXISTS idx_discord_node_links_discord_user_id ON discord_node_links(discord_user_id);

-- Banned nodes (messages suppressed from Discord bridge)
CREATE TABLE IF NOT EXISTS discord_banned_nodes (
    node_id VARCHAR(8) PRIMARY KEY,
    banned_by VARCHAR(20),  -- Discord user ID who banned
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Watched nodes (online/offline alerts sent to Discord)
CREATE TABLE IF NOT EXISTS discord_watched_nodes (
    id SERIAL PRIMARY KEY,
    node_id VARCHAR(8) NOT NULL,
    discord_user_id VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT discord_watched_nodes_unique UNIQUE (node_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_watched_nodes_node_id ON discord_watched_nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_discord_watched_nodes_discord_user_id ON discord_watched_nodes(discord_user_id);

-- Tracked nodes (position updates forwarded to Discord)
CREATE TABLE IF NOT EXISTS discord_tracked_nodes (
    node_id VARCHAR(8) PRIMARY KEY,
    track_type VARCHAR(20) NOT NULL DEFAULT 'tracker',  -- 'tracker' or 'balloon'
    added_by VARCHAR(20),  -- Discord user ID who added
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);