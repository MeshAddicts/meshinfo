-- Initial Housekeeping for setting up a new database
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
SET default_tablespace = '';
SET default_table_access_method = heap;

-- Create the postgis extension needed for the cool geospatial stuff
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';

CREATE TABLE public.mesh_packets (
    source bigint NOT NULL,
    dest bigint,
    packet_id bigint NOT NULL,
    rx_snr integer,
    rx_rssi integer,
    hop_limit integer,
    hop_start integer,
    portnum character varying,
    toi timestamp with time zone,
    channel_id character varying,
    gateway_id bigint NOT NULL
);

CREATE TABLE public.node_infos (
  id bigserial NOT NULL PRIMARY KEY,
  node_id bigint NOT NULL,
  long_name character varying(100),
  short_name character varying(10),
  mac_addr character varying(20),
  hw_model character varying(20),
  role character varying,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.node_positions (
  id bigint NOT NULL,
  node_id bigint NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  altitude double precision,
  geom public.geometry(PointZ,4326),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_position_pkey1 PRIMARY KEY (id, longitude, latitude);

CREATE TABLE public.text_messages (
  id BIGINT PRIMARY KEY,
  channel_id TEXT,
  from_node_id BIGINT not null,
  sender_node_id BIGINT not null,
  to_node_id bigint not null,
  text TEXT,
  timestamp BIGINT,
  created_at TIMESTAMP with time zone DEFAULT now()
);

CREATE TABLE public.channels (
  id BIGINT PRIMARY KEY,
  name TEXT,
  created_at TIMESTAMP with time zone DEFAULT now()
);

CREATE TABLE public.mqtt_messages (
  id BIGINT PRIMARY KEY,
  topic TEXT,
  payload TEXT,
  qos INT,
  retain BOOLEAN,
  timestamp BIGINT,
  created_at TIMESTAMP with time zone DEFAULT now()
);

CREATE TABLE public.messages (
  id BIGINT PRIMARY KEY,
  mqtt_message_id BIGINT,
  channel_id BIGINT,
  from_node_id BIGINT,
  sender_node_id BIGINT,
  to_node_id BIGINT,
  type varchar(20),
  hops_away INT,
  rssi INT,
  snr FLOAT,
  text TEXT,
  timestamp BIGINT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE public.neighbor_info (
    id bigint NOT NULL,
    neighbor_id bigint NOT NULL,
    update_time timestamp with time zone DEFAULT now() NOT NULL,
    snr double precision
);

-- this view shows us the most recent position of every node we've
-- gotten a position for

CREATE VIEW public.last_position AS
 SELECT DISTINCT ON (id) id,
    updated_at,
    geom
   FROM public.node_positions
  ORDER BY id, updated_at DESC;

CREATE VIEW public.current_nodes AS
  SELECT DISTINCT ON (node_id) node_id, long_name, short_name, mac_addr, hw_model, role, latitude, longitude, altitude, geom
  FROM (
    SELECT
      n.source AS node_id,
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
    FROM mesh_packets n
    JOIN node_infos ni ON n.source = ni.node_id
    JOIN node_positions np ON n.source = np.node_id
    ORDER BY n.source, np.created_at DESC
  ) AS current_nodes;

-- This view uses the neighbor info packets to create a table
-- showing all known linkages in a network

CREATE VIEW public.neighbor_map AS
 SELECT DISTINCT to_hex(i.id) AS id,
    i.update_time,
    i.neighbor_id,
    i.snr,
    l.geom
   FROM public.last_position l,
    public.neighbor_info i
  WHERE (i.id = l.id)
  ORDER BY (to_hex(i.id));

CREATE INDEX idx_neighbor_info_id ON public.neighbor_info USING btree (id);
CREATE INDEX idx_neighbor_info_neighbor_id ON public.neighbor_info USING btree (neighbor_id);
CREATE INDEX idx_neighbor_info_pair ON public.neighbor_info USING btree (id, neighbor_id);
CREATE INDEX idx_nodes_pk ON public.mesh_packets USING btree (source, packet_id);
CREATE INDEX node_position_geom_idx ON public.node_positions USING gist (geom);

-- This function is tied to a trigger, to create the Geometry
-- when a new position with latitude, longitude and altitude is inserted

CREATE FUNCTION public.fn_add_geom_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
UPDATE node_positions SET geom=ST_MakePoint(NEW.longitude / 10000000, NEW.latitude/ 10000000, 0) where node_id=NEW.node_id;
RETURN NULL;
END;
$$;
CREATE TRIGGER geom_inserted AFTER INSERT ON public.node_positions FOR EACH ROW EXECUTE FUNCTION public.fn_add_geom_update();
