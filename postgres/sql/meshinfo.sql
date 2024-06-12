CREATE TABLE nodes (
  id bigint NOT NULL PRIMARY KEY,
  first_heard_at timestamp with time zone DEFAULT now() NOT NULL,
  last_heard_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE node_infos (
  id bigint NOT NULL PRIMARY KEY,
  node_id bigint NOT NULL,
  long_name character varying(100),
  short_name character varying(10),
  mac_addr character varying(20),
  hw_model character varying(20),
  role character varying,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE node_positions (
  id bigint NOT NULL PRIMARY KEY,
  node_id bigint NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  altitude double precision,
  geom public.geometry(PointZ,4326),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE VIEW current_nodes AS
  SELECT DISTINCT ON (node_id) node_id, long_name, short_name, mac_addr, hw_model, role, latitude, longitude, altitude, geom
  FROM (
    SELECT
      n.id AS node_id,
      ni.long_name,
      ni.short_name,
      ni.mac_addr,
      ni.hw_model,
      ni.role,
      np.latitude,
      np.longitude,
      np.altitude,
      np.geom,
      np.created_at
    FROM nodes n
    JOIN node_infos ni ON n.id = ni.node_id
    JOIN node_positions np ON n.id = np.node_id
    ORDER BY n.id, np.created_at DESC
  ) AS current_nodes;

CREATE TABLE text_messages (
  id BIGINT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(id),
  from_node_id BIGINT REFERENCES nodes(id),
  sender_node_id BIGINT REFERENCES nodes(id),
  to_node_id TEXT REFERENCES nodes(node_id),
  hops_away INT,
  rssi INT,
  snr FLOAT,
  text TEXT,
  timestamp BIGINT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE channels (
  id BIGINT PRIMARY KEY,
  name TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE messages (
  id BIGINT PRIMARY KEY,
  mqtt_message_id BIGINT REFERENCES mqtt_messages(id),
  channel_id BIGINT REFERENCES channels(id),
  from_node_id BIGINT REFERENCES nodes(id),
  sender_node_id BIGINT REFERENCES nodes(id),
  to_node_id BIGINT REFERENCES nodes(id),
  type varying character(20),
  hops_away INT,
  rssi INT,
  snr FLOAT,
  text TEXT,
  timestamp BIGINT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE mqtt_messages (
  id BIGINT PRIMARY KEY,
  topic TEXT,
  payload TEXT,
  qos INT,
  retain BOOLEAN,
  timestamp BIGINT,
  created_at TIMESTAMP DEFAULT now()
);
