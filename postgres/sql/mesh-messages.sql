CREATE TABLE IF NOT EXISTS mesh_messages (
    id              BIGSERIAL PRIMARY KEY,

    mqtt_topic      TEXT        NOT NULL,

    -- Node info
    from_node_id    TEXT,
    to_node_id      TEXT,
    gateway_node_id TEXT,

    -- Meshtastic / application-level details
    message_type    TEXT,           -- 'text', 'position', 'telemetry', etc.
    port_num        INTEGER,
    hop_count       INTEGER,

    -- RF metadata
    rx_rssi         REAL,
    rx_snr          REAL,

    -- Payloads
    payload_json    JSONB       NOT NULL,   -- decoded representation
    raw_payload     BYTEA,                  -- optional raw bytes

    -- Timestamps
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_received_at
    ON mesh_messages (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_from_node
    ON mesh_messages (from_node_id);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_to_node
    ON mesh_messages (to_node_id);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_message_type
    ON mesh_messages (message_type);

CREATE INDEX IF NOT EXISTS idx_mesh_messages_mqtt_topic
    ON mesh_messages (mqtt_topic);
