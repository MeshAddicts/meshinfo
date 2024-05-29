CREATE TABLE nodes (
    id VARCHAR(20) PRIMARY KEY,
    active BOOLEAN,
    hardware JSONB,
    last_seen TIMESTAMP,
    longname VARCHAR(255),
    neighborinfo JSONB,
    position JSONB,
    shortname VARCHAR(20),
    telemetry JSONB
);

CREATE TABLE channels (
    id TEXT PRIMARY KEY
);

CREATE TABLE chat_messages (
    id BIGINT PRIMARY KEY,
    channel_id TEXT REFERENCES channels(id),
    from_node_id TEXT REFERENCES nodes(id),
    sender_node_id TEXT REFERENCES nodes(id),
    to_node_id TEXT REFERENCES nodes(node_id),
    hops_away INT,
    rssi INT,
    snr FLOAT,
    text TEXT,
    timestamp BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
