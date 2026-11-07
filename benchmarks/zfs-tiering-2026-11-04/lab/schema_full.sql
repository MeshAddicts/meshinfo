--
-- PostgreSQL database dump
--

\restrict UydS0BiyLe1d75CgIIQFyMDLbzJ3UmnezD0az8KCVrMIRhlClyAaOPi2EJD6PrR

-- Dumped from database version 18.4 (Debian 18.4-1.pgdg13+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: mqtt_messages_extract_node_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mqtt_messages_extract_node_ids() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
                    DECLARE
                        v_from TEXT;
                        v_to TEXT;
                        v_pid TEXT;
                    BEGIN
                        IF (NEW.from_node_id IS NULL OR NEW.to_node_id IS NULL OR NEW.packet_id IS NULL) AND NEW.payload IS NOT NULL AND NEW.payload ~ '^\s*\{' THEN
                            BEGIN
                                v_from := NEW.payload::jsonb ->> 'from';
                                v_to   := NEW.payload::jsonb ->> 'to';
                                v_pid  := NEW.payload::jsonb ->> 'id';
                                IF NEW.packet_id IS NULL AND v_pid ~ '^[0-9]+$' THEN
                                    NEW.packet_id := v_pid::bigint;
                                END IF;
                                IF NEW.from_node_id IS NULL AND v_from IS NOT NULL THEN
                                    IF v_from ~ '^[0-9]+$' THEN
                                        NEW.from_node_id := lpad(to_hex(v_from::bigint), 8, '0');
                                    ELSE
                                        NEW.from_node_id := left(regexp_replace(v_from, '^!', ''), 8);
                                    END IF;
                                END IF;
                                IF NEW.to_node_id IS NULL AND v_to IS NOT NULL THEN
                                    IF v_to ~ '^[0-9]+$' THEN
                                        NEW.to_node_id := lpad(to_hex(v_to::bigint), 8, '0');
                                    ELSE
                                        NEW.to_node_id := left(regexp_replace(v_to, '^!', ''), 8);
                                    END IF;
                                END IF;
                            EXCEPTION WHEN OTHERS THEN
                                NULL;
                            END;
                        END IF;
                        RETURN NEW;
                    END;
                    $_$;


--
-- Name: prune_neighborinfo_history(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_neighborinfo_history(p_days integer DEFAULT 30) RETURNS void
    LANGUAGE sql
    AS $$
  DELETE FROM node_neighborinfo_history
  WHERE rx_time < NOW() - (p_days || ' days')::INTERVAL;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_table_access_method = heap;

--
-- Name: chat_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_channels (
    id character varying(10) NOT NULL,
    name character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    sender_node_id character varying(8),
    channel_id character varying(10),
    channel_name character varying(100),
    text text,
    "timestamp" bigint,
    rx_time timestamp with time zone,
    hops_away integer,
    rssi integer,
    snr real,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discord_banned_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_banned_nodes (
    node_id character varying(8) NOT NULL,
    banned_by character varying(20),
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discord_node_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_node_links (
    id integer NOT NULL,
    node_id character varying(8) NOT NULL,
    discord_user_id character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discord_node_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discord_node_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discord_node_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discord_node_links_id_seq OWNED BY public.discord_node_links.id;


--
-- Name: discord_tracked_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_tracked_nodes (
    node_id character varying(8) NOT NULL,
    track_type character varying(20) DEFAULT 'tracker'::character varying NOT NULL,
    added_by character varying(20),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discord_watched_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discord_watched_nodes (
    id integer NOT NULL,
    node_id character varying(8) NOT NULL,
    discord_user_id character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discord_watched_nodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discord_watched_nodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discord_watched_nodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discord_watched_nodes_id_seq OWNED BY public.discord_watched_nodes.id;


--
-- Name: mqtt_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_messages (
    id bigint NOT NULL,
    topic text,
    payload text,
    qos integer,
    retain boolean,
    "timestamp" bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    packet_id bigint
)
PARTITION BY RANGE (created_at);
ALTER TABLE ONLY public.mqtt_messages ALTER COLUMN payload SET COMPRESSION lz4;


--
-- Name: mqtt_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_messages_id_seq OWNED BY public.mqtt_messages.id;


--
-- Name: mqtt_messages_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_messages_2026_11 (
    id bigint DEFAULT nextval('public.mqtt_messages_id_seq'::regclass) CONSTRAINT mqtt_messages_id_not_null NOT NULL,
    topic text,
    payload text,
    qos integer,
    retain boolean,
    "timestamp" bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT mqtt_messages_created_at_not_null NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    packet_id bigint
);
ALTER TABLE ONLY public.mqtt_messages_2026_11 ALTER COLUMN payload SET COMPRESSION lz4;


--
-- Name: mqtt_messages_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_messages_2026_12 (
    id bigint DEFAULT nextval('public.mqtt_messages_id_seq'::regclass) CONSTRAINT mqtt_messages_id_not_null NOT NULL,
    topic text,
    payload text,
    qos integer,
    retain boolean,
    "timestamp" bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT mqtt_messages_created_at_not_null NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    packet_id bigint
);
ALTER TABLE ONLY public.mqtt_messages_2026_12 ALTER COLUMN payload SET COMPRESSION lz4;


--
-- Name: mqtt_messages_2027_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_messages_2027_01 (
    id bigint DEFAULT nextval('public.mqtt_messages_id_seq'::regclass) CONSTRAINT mqtt_messages_id_not_null NOT NULL,
    topic text,
    payload text,
    qos integer,
    retain boolean,
    "timestamp" bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT mqtt_messages_created_at_not_null NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    packet_id bigint
);
ALTER TABLE ONLY public.mqtt_messages_2027_01 ALTER COLUMN payload SET COMPRESSION lz4;


--
-- Name: mqtt_messages_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_messages_default (
    id bigint DEFAULT nextval('public.mqtt_messages_id_seq'::regclass) CONSTRAINT mqtt_messages_id_not_null NOT NULL,
    topic text,
    payload text,
    qos integer,
    retain boolean,
    "timestamp" bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT mqtt_messages_created_at_not_null NOT NULL,
    from_node_id character varying(8),
    to_node_id character varying(8),
    packet_id bigint
);
ALTER TABLE ONLY public.mqtt_messages_default ALTER COLUMN payload SET COMPRESSION lz4;


--
-- Name: mqtt_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mqtt_topics (
    id integer NOT NULL,
    topic text NOT NULL
);


--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mqtt_topics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mqtt_topics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mqtt_topics_id_seq OWNED BY public.mqtt_topics.id;


--
-- Name: node_neighborinfo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_neighborinfo (
    id integer NOT NULL,
    node_id character varying(8) NOT NULL,
    node_broadcast_interval_secs integer,
    neighbors jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: node_neighborinfo_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_neighborinfo_history (
    id bigint NOT NULL,
    node_id character varying(8) NOT NULL,
    rx_time timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    neighbors jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: node_neighborinfo_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_neighborinfo_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_neighborinfo_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_neighborinfo_history_id_seq OWNED BY public.node_neighborinfo_history.id;


--
-- Name: node_neighborinfo_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_neighborinfo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_neighborinfo_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_neighborinfo_id_seq OWNED BY public.node_neighborinfo.id;


--
-- Name: node_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_positions (
    id integer NOT NULL,
    node_id character varying(8) NOT NULL,
    latitude_i integer,
    longitude_i integer,
    altitude integer,
    "time" integer,
    precision_bits integer,
    geocoded jsonb,
    last_geocoding timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    altitude_hae integer,
    altitude_geoidal_separation integer,
    location_source smallint,
    altitude_source smallint
);


--
-- Name: node_positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_positions_id_seq OWNED BY public.node_positions.id;


--
-- Name: node_telemetry_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_telemetry_current (
    id integer NOT NULL,
    node_id character varying(8) NOT NULL,
    battery_level integer,
    voltage real,
    channel_utilization real,
    air_util_tx real,
    uptime_seconds integer,
    temperature real,
    relative_humidity real,
    barometric_pressure real,
    gas_resistance real,
    iaq integer,
    distance real,
    lux real,
    white_lux real,
    ir_lux real,
    uv_lux real,
    wind_direction integer,
    wind_speed real,
    weight real,
    current real,
    wind_gust real,
    wind_lull real,
    radiation real,
    rainfall_1h real,
    rainfall_24h real,
    soil_moisture integer,
    soil_temperature real,
    power_metrics jsonb,
    air_quality_metrics jsonb,
    local_stats jsonb,
    health_metrics jsonb,
    host_metrics jsonb,
    traffic_management_stats jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: node_telemetry_current_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.node_telemetry_current_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: node_telemetry_current_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.node_telemetry_current_id_seq OWNED BY public.node_telemetry_current.id;


--
-- Name: nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodes (
    id character varying(8) NOT NULL,
    longname character varying(255),
    shortname character varying(10),
    hardware character varying(50),
    role integer,
    active boolean DEFAULT true,
    tc2_bbs boolean DEFAULT false,
    gateway character varying(8),
    last_seen timestamp with time zone,
    since_seconds real,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_channel character varying(10)
);


--
-- Name: packet_receptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packet_receptions (
    mqtt_row_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    gateway character varying(8),
    topic_id integer,
    rx_rssi smallint,
    rx_snr double precision,
    rx_time bigint,
    hop_limit smallint,
    hops_away smallint,
    relay_node integer,
    transport smallint,
    extras jsonb
)
PARTITION BY RANGE (created_at);


--
-- Name: packet_receptions_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packet_receptions_2026_11 (
    mqtt_row_id bigint CONSTRAINT packet_receptions_mqtt_row_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT packet_receptions_created_at_not_null NOT NULL,
    gateway character varying(8),
    topic_id integer,
    rx_rssi smallint,
    rx_snr double precision,
    rx_time bigint,
    hop_limit smallint,
    hops_away smallint,
    relay_node integer,
    transport smallint,
    extras jsonb
);


--
-- Name: packet_receptions_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packet_receptions_2026_12 (
    mqtt_row_id bigint CONSTRAINT packet_receptions_mqtt_row_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT packet_receptions_created_at_not_null NOT NULL,
    gateway character varying(8),
    topic_id integer,
    rx_rssi smallint,
    rx_snr double precision,
    rx_time bigint,
    hop_limit smallint,
    hops_away smallint,
    relay_node integer,
    transport smallint,
    extras jsonb
);


--
-- Name: packet_receptions_2027_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packet_receptions_2027_01 (
    mqtt_row_id bigint CONSTRAINT packet_receptions_mqtt_row_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT packet_receptions_created_at_not_null NOT NULL,
    gateway character varying(8),
    topic_id integer,
    rx_rssi smallint,
    rx_snr double precision,
    rx_time bigint,
    hop_limit smallint,
    hops_away smallint,
    relay_node integer,
    transport smallint,
    extras jsonb
);


--
-- Name: packet_receptions_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.packet_receptions_default (
    mqtt_row_id bigint CONSTRAINT packet_receptions_mqtt_row_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT packet_receptions_created_at_not_null NOT NULL,
    gateway character varying(8),
    topic_id integer,
    rx_rssi smallint,
    rx_snr double precision,
    rx_time bigint,
    hop_limit smallint,
    hops_away smallint,
    relay_node integer,
    transport smallint,
    extras jsonb
);


--
-- Name: telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry (
    id bigint NOT NULL,
    from_node_id character varying(8) NOT NULL,
    to_node_id character varying(8),
    sender_node_id character varying(8),
    message_id bigint NOT NULL,
    channel integer,
    packet_id bigint,
    hops_away integer,
    rssi integer,
    snr real,
    "timestamp" bigint,
    rx_time timestamp with time zone,
    telemetry_type text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: telemetry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.telemetry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telemetry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.telemetry_id_seq OWNED BY public.telemetry.id;


--
-- Name: traceroutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.traceroutes (
    id bigint NOT NULL,
    from_node_id character varying(8) NOT NULL,
    to_node_id character varying(8),
    sender_node_id character varying(8),
    message_id bigint NOT NULL,
    channel integer,
    packet_id bigint,
    hops_away integer,
    rssi integer,
    snr real,
    "timestamp" bigint,
    rx_time timestamp with time zone,
    route jsonb,
    route_ids jsonb,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now(),
    route_back_ids jsonb
);


--
-- Name: traceroutes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.traceroutes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: traceroutes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.traceroutes_id_seq OWNED BY public.traceroutes.id;


--
-- Name: mqtt_messages_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages ATTACH PARTITION public.mqtt_messages_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: mqtt_messages_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages ATTACH PARTITION public.mqtt_messages_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: mqtt_messages_2027_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages ATTACH PARTITION public.mqtt_messages_2027_01 FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');


--
-- Name: mqtt_messages_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages ATTACH PARTITION public.mqtt_messages_default DEFAULT;


--
-- Name: packet_receptions_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packet_receptions ATTACH PARTITION public.packet_receptions_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');


--
-- Name: packet_receptions_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packet_receptions ATTACH PARTITION public.packet_receptions_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');


--
-- Name: packet_receptions_2027_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packet_receptions ATTACH PARTITION public.packet_receptions_2027_01 FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');


--
-- Name: packet_receptions_default; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.packet_receptions ATTACH PARTITION public.packet_receptions_default DEFAULT;


--
-- Name: discord_node_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_node_links ALTER COLUMN id SET DEFAULT nextval('public.discord_node_links_id_seq'::regclass);


--
-- Name: discord_watched_nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_watched_nodes ALTER COLUMN id SET DEFAULT nextval('public.discord_watched_nodes_id_seq'::regclass);


--
-- Name: mqtt_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages ALTER COLUMN id SET DEFAULT nextval('public.mqtt_messages_id_seq'::regclass);


--
-- Name: mqtt_topics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics ALTER COLUMN id SET DEFAULT nextval('public.mqtt_topics_id_seq'::regclass);


--
-- Name: node_neighborinfo id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo ALTER COLUMN id SET DEFAULT nextval('public.node_neighborinfo_id_seq'::regclass);


--
-- Name: node_neighborinfo_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo_history ALTER COLUMN id SET DEFAULT nextval('public.node_neighborinfo_history_id_seq'::regclass);


--
-- Name: node_positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions ALTER COLUMN id SET DEFAULT nextval('public.node_positions_id_seq'::regclass);


--
-- Name: node_telemetry_current id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_telemetry_current ALTER COLUMN id SET DEFAULT nextval('public.node_telemetry_current_id_seq'::regclass);


--
-- Name: telemetry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry ALTER COLUMN id SET DEFAULT nextval('public.telemetry_id_seq'::regclass);


--
-- Name: traceroutes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes ALTER COLUMN id SET DEFAULT nextval('public.traceroutes_id_seq'::regclass);


--
-- Name: chat_channels chat_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_channels
    ADD CONSTRAINT chat_channels_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: discord_banned_nodes discord_banned_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_banned_nodes
    ADD CONSTRAINT discord_banned_nodes_pkey PRIMARY KEY (node_id);


--
-- Name: discord_node_links discord_node_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_node_links
    ADD CONSTRAINT discord_node_links_pkey PRIMARY KEY (id);


--
-- Name: discord_node_links discord_node_links_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_node_links
    ADD CONSTRAINT discord_node_links_unique UNIQUE (node_id);


--
-- Name: discord_tracked_nodes discord_tracked_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_tracked_nodes
    ADD CONSTRAINT discord_tracked_nodes_pkey PRIMARY KEY (node_id);


--
-- Name: discord_watched_nodes discord_watched_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_watched_nodes
    ADD CONSTRAINT discord_watched_nodes_pkey PRIMARY KEY (id);


--
-- Name: discord_watched_nodes discord_watched_nodes_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_watched_nodes
    ADD CONSTRAINT discord_watched_nodes_unique UNIQUE (node_id, discord_user_id);


--
-- Name: mqtt_messages mqtt_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages
    ADD CONSTRAINT mqtt_messages_pkey PRIMARY KEY (id, created_at);


--
-- Name: mqtt_messages_2026_11 mqtt_messages_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages_2026_11
    ADD CONSTRAINT mqtt_messages_2026_11_pkey PRIMARY KEY (id, created_at);


--
-- Name: mqtt_messages_2026_12 mqtt_messages_2026_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages_2026_12
    ADD CONSTRAINT mqtt_messages_2026_12_pkey PRIMARY KEY (id, created_at);


--
-- Name: mqtt_messages_2027_01 mqtt_messages_2027_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages_2027_01
    ADD CONSTRAINT mqtt_messages_2027_01_pkey PRIMARY KEY (id, created_at);


--
-- Name: mqtt_messages_default mqtt_messages_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_messages_default
    ADD CONSTRAINT mqtt_messages_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: mqtt_topics mqtt_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_pkey PRIMARY KEY (id);


--
-- Name: mqtt_topics mqtt_topics_topic_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mqtt_topics
    ADD CONSTRAINT mqtt_topics_topic_key UNIQUE (topic);


--
-- Name: node_neighborinfo_history node_neighborinfo_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo_history
    ADD CONSTRAINT node_neighborinfo_history_pkey PRIMARY KEY (id);


--
-- Name: node_neighborinfo node_neighborinfo_node_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo
    ADD CONSTRAINT node_neighborinfo_node_id_key UNIQUE (node_id);


--
-- Name: node_neighborinfo node_neighborinfo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo
    ADD CONSTRAINT node_neighborinfo_pkey PRIMARY KEY (id);


--
-- Name: node_positions node_positions_node_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_positions_node_id_unique UNIQUE (node_id);


--
-- Name: node_positions node_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_positions_pkey PRIMARY KEY (id);


--
-- Name: node_telemetry_current node_telemetry_current_node_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_telemetry_current
    ADD CONSTRAINT node_telemetry_current_node_id_key UNIQUE (node_id);


--
-- Name: node_telemetry_current node_telemetry_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_telemetry_current
    ADD CONSTRAINT node_telemetry_current_pkey PRIMARY KEY (id);


--
-- Name: nodes nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);


--
-- Name: telemetry telemetry_from_node_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_from_node_id_message_id_key UNIQUE (from_node_id, message_id);


--
-- Name: telemetry telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_pkey PRIMARY KEY (id);


--
-- Name: traceroutes traceroutes_from_node_id_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes
    ADD CONSTRAINT traceroutes_from_node_id_message_id_key UNIQUE (from_node_id, message_id);


--
-- Name: traceroutes traceroutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes
    ADD CONSTRAINT traceroutes_pkey PRIMARY KEY (id);


--
-- Name: idx_chat_messages_channel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_channel_id ON public.chat_messages USING btree (channel_id);


--
-- Name: idx_chat_messages_channel_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_channel_timestamp ON public.chat_messages USING btree (channel_id, "timestamp" DESC);


--
-- Name: idx_chat_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_created_at ON public.chat_messages USING btree (created_at DESC);


--
-- Name: idx_chat_messages_from_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_from_node_id ON public.chat_messages USING btree (from_node_id);


--
-- Name: idx_chat_messages_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_timestamp ON public.chat_messages USING btree ("timestamp" DESC);


--
-- Name: idx_discord_node_links_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_node_links_discord_user_id ON public.discord_node_links USING btree (discord_user_id);


--
-- Name: idx_discord_node_links_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_node_links_node_id ON public.discord_node_links USING btree (node_id);


--
-- Name: idx_discord_watched_nodes_discord_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_watched_nodes_discord_user_id ON public.discord_watched_nodes USING btree (discord_user_id);


--
-- Name: idx_discord_watched_nodes_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discord_watched_nodes_node_id ON public.discord_watched_nodes USING btree (node_id);


--
-- Name: idx_mqtt_messages_backfill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_backfill ON ONLY public.mqtt_messages USING btree (id) WHERE (from_node_id IS NULL);


--
-- Name: idx_mqtt_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_created_at ON ONLY public.mqtt_messages USING btree (created_at DESC);


--
-- Name: idx_mqtt_messages_from_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_from_node_id ON ONLY public.mqtt_messages USING btree (from_node_id, created_at DESC);


--
-- Name: idx_mqtt_messages_packet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_packet ON ONLY public.mqtt_messages USING btree (from_node_id, packet_id, created_at DESC) WHERE (packet_id IS NOT NULL);


--
-- Name: idx_mqtt_messages_preset_split; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_preset_split ON ONLY public.mqtt_messages USING btree (created_at) WHERE (topic ~~ '%/2/e/%/!%'::text);


--
-- Name: idx_mqtt_messages_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_timestamp ON ONLY public.mqtt_messages USING btree ("timestamp" DESC);


--
-- Name: idx_mqtt_messages_to_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_to_node_id ON ONLY public.mqtt_messages USING btree (to_node_id, created_at DESC);


--
-- Name: idx_mqtt_messages_topic_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mqtt_messages_topic_trgm ON ONLY public.mqtt_messages USING gin (topic public.gin_trgm_ops);


--
-- Name: idx_neighborinfo_hist_node_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_neighborinfo_hist_node_time ON public.node_neighborinfo_history USING btree (node_id, rx_time DESC);


--
-- Name: idx_neighborinfo_hist_rx_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_neighborinfo_hist_rx_time ON public.node_neighborinfo_history USING btree (rx_time DESC);


--
-- Name: idx_node_positions_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_positions_updated_at ON public.node_positions USING btree (updated_at DESC);


--
-- Name: idx_nodes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_active ON public.nodes USING btree (active);


--
-- Name: idx_nodes_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_last_seen ON public.nodes USING btree (last_seen);


--
-- Name: idx_nodes_longname_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_longname_lower ON public.nodes USING btree (lower((longname)::text));


--
-- Name: idx_nodes_shortname_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodes_shortname_lower ON public.nodes USING btree (lower((shortname)::text));


--
-- Name: idx_packet_receptions_gateway; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_packet_receptions_gateway ON ONLY public.packet_receptions USING btree (gateway, created_at DESC);


--
-- Name: idx_packet_receptions_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_packet_receptions_row ON ONLY public.packet_receptions USING btree (mqtt_row_id, created_at);


--
-- Name: idx_telemetry_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_created_at ON public.telemetry USING btree (created_at DESC);


--
-- Name: idx_telemetry_from_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_from_node_id ON public.telemetry USING btree (from_node_id);


--
-- Name: idx_telemetry_node_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_node_type ON public.telemetry USING btree (from_node_id, telemetry_type);


--
-- Name: idx_telemetry_rx_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_rx_time ON public.telemetry USING btree (rx_time DESC);


--
-- Name: idx_telemetry_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_type ON public.telemetry USING btree (telemetry_type);


--
-- Name: idx_traceroutes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_created_at ON public.traceroutes USING btree (created_at DESC);


--
-- Name: idx_traceroutes_from_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_from_node_id ON public.traceroutes USING btree (from_node_id);


--
-- Name: idx_traceroutes_route_back_ids_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_route_back_ids_gin ON public.traceroutes USING gin (route_back_ids jsonb_path_ops);


--
-- Name: idx_traceroutes_route_ids_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_route_ids_gin ON public.traceroutes USING gin (route_ids jsonb_path_ops);


--
-- Name: idx_traceroutes_sender_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_sender_node_id ON public.traceroutes USING btree (sender_node_id);


--
-- Name: idx_traceroutes_to_node_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_traceroutes_to_node_id ON public.traceroutes USING btree (to_node_id);


--
-- Name: mqtt_messages_2026_11_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_created_at_idx ON public.mqtt_messages_2026_11 USING btree (created_at DESC);


--
-- Name: mqtt_messages_2026_11_created_at_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_created_at_idx1 ON public.mqtt_messages_2026_11 USING btree (created_at) WHERE (topic ~~ '%/2/e/%/!%'::text);


--
-- Name: mqtt_messages_2026_11_from_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_from_node_id_created_at_idx ON public.mqtt_messages_2026_11 USING btree (from_node_id, created_at DESC);


--
-- Name: mqtt_messages_2026_11_from_node_id_packet_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_from_node_id_packet_id_created_at_idx ON public.mqtt_messages_2026_11 USING btree (from_node_id, packet_id, created_at DESC) WHERE (packet_id IS NOT NULL);


--
-- Name: mqtt_messages_2026_11_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_id_idx ON public.mqtt_messages_2026_11 USING btree (id) WHERE (from_node_id IS NULL);


--
-- Name: mqtt_messages_2026_11_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_timestamp_idx ON public.mqtt_messages_2026_11 USING btree ("timestamp" DESC);


--
-- Name: mqtt_messages_2026_11_to_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_to_node_id_created_at_idx ON public.mqtt_messages_2026_11 USING btree (to_node_id, created_at DESC);


--
-- Name: mqtt_messages_2026_11_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_11_topic_idx ON public.mqtt_messages_2026_11 USING gin (topic public.gin_trgm_ops);


--
-- Name: mqtt_messages_2026_12_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_created_at_idx ON public.mqtt_messages_2026_12 USING btree (created_at DESC);


--
-- Name: mqtt_messages_2026_12_created_at_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_created_at_idx1 ON public.mqtt_messages_2026_12 USING btree (created_at) WHERE (topic ~~ '%/2/e/%/!%'::text);


--
-- Name: mqtt_messages_2026_12_from_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_from_node_id_created_at_idx ON public.mqtt_messages_2026_12 USING btree (from_node_id, created_at DESC);


--
-- Name: mqtt_messages_2026_12_from_node_id_packet_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_from_node_id_packet_id_created_at_idx ON public.mqtt_messages_2026_12 USING btree (from_node_id, packet_id, created_at DESC) WHERE (packet_id IS NOT NULL);


--
-- Name: mqtt_messages_2026_12_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_id_idx ON public.mqtt_messages_2026_12 USING btree (id) WHERE (from_node_id IS NULL);


--
-- Name: mqtt_messages_2026_12_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_timestamp_idx ON public.mqtt_messages_2026_12 USING btree ("timestamp" DESC);


--
-- Name: mqtt_messages_2026_12_to_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_to_node_id_created_at_idx ON public.mqtt_messages_2026_12 USING btree (to_node_id, created_at DESC);


--
-- Name: mqtt_messages_2026_12_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2026_12_topic_idx ON public.mqtt_messages_2026_12 USING gin (topic public.gin_trgm_ops);


--
-- Name: mqtt_messages_2027_01_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_created_at_idx ON public.mqtt_messages_2027_01 USING btree (created_at DESC);


--
-- Name: mqtt_messages_2027_01_created_at_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_created_at_idx1 ON public.mqtt_messages_2027_01 USING btree (created_at) WHERE (topic ~~ '%/2/e/%/!%'::text);


--
-- Name: mqtt_messages_2027_01_from_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_from_node_id_created_at_idx ON public.mqtt_messages_2027_01 USING btree (from_node_id, created_at DESC);


--
-- Name: mqtt_messages_2027_01_from_node_id_packet_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_from_node_id_packet_id_created_at_idx ON public.mqtt_messages_2027_01 USING btree (from_node_id, packet_id, created_at DESC) WHERE (packet_id IS NOT NULL);


--
-- Name: mqtt_messages_2027_01_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_id_idx ON public.mqtt_messages_2027_01 USING btree (id) WHERE (from_node_id IS NULL);


--
-- Name: mqtt_messages_2027_01_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_timestamp_idx ON public.mqtt_messages_2027_01 USING btree ("timestamp" DESC);


--
-- Name: mqtt_messages_2027_01_to_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_to_node_id_created_at_idx ON public.mqtt_messages_2027_01 USING btree (to_node_id, created_at DESC);


--
-- Name: mqtt_messages_2027_01_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_2027_01_topic_idx ON public.mqtt_messages_2027_01 USING gin (topic public.gin_trgm_ops);


--
-- Name: mqtt_messages_default_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_created_at_idx ON public.mqtt_messages_default USING btree (created_at DESC);


--
-- Name: mqtt_messages_default_created_at_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_created_at_idx1 ON public.mqtt_messages_default USING btree (created_at) WHERE (topic ~~ '%/2/e/%/!%'::text);


--
-- Name: mqtt_messages_default_from_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_from_node_id_created_at_idx ON public.mqtt_messages_default USING btree (from_node_id, created_at DESC);


--
-- Name: mqtt_messages_default_from_node_id_packet_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_from_node_id_packet_id_created_at_idx ON public.mqtt_messages_default USING btree (from_node_id, packet_id, created_at DESC) WHERE (packet_id IS NOT NULL);


--
-- Name: mqtt_messages_default_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_id_idx ON public.mqtt_messages_default USING btree (id) WHERE (from_node_id IS NULL);


--
-- Name: mqtt_messages_default_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_timestamp_idx ON public.mqtt_messages_default USING btree ("timestamp" DESC);


--
-- Name: mqtt_messages_default_to_node_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_to_node_id_created_at_idx ON public.mqtt_messages_default USING btree (to_node_id, created_at DESC);


--
-- Name: mqtt_messages_default_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mqtt_messages_default_topic_idx ON public.mqtt_messages_default USING gin (topic public.gin_trgm_ops);


--
-- Name: packet_receptions_2026_11_gateway_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2026_11_gateway_created_at_idx ON public.packet_receptions_2026_11 USING btree (gateway, created_at DESC);


--
-- Name: packet_receptions_2026_11_mqtt_row_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2026_11_mqtt_row_id_created_at_idx ON public.packet_receptions_2026_11 USING btree (mqtt_row_id, created_at);


--
-- Name: packet_receptions_2026_12_gateway_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2026_12_gateway_created_at_idx ON public.packet_receptions_2026_12 USING btree (gateway, created_at DESC);


--
-- Name: packet_receptions_2026_12_mqtt_row_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2026_12_mqtt_row_id_created_at_idx ON public.packet_receptions_2026_12 USING btree (mqtt_row_id, created_at);


--
-- Name: packet_receptions_2027_01_gateway_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2027_01_gateway_created_at_idx ON public.packet_receptions_2027_01 USING btree (gateway, created_at DESC);


--
-- Name: packet_receptions_2027_01_mqtt_row_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_2027_01_mqtt_row_id_created_at_idx ON public.packet_receptions_2027_01 USING btree (mqtt_row_id, created_at);


--
-- Name: packet_receptions_default_gateway_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_default_gateway_created_at_idx ON public.packet_receptions_default USING btree (gateway, created_at DESC);


--
-- Name: packet_receptions_default_mqtt_row_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX packet_receptions_default_mqtt_row_id_created_at_idx ON public.packet_receptions_default USING btree (mqtt_row_id, created_at);


--
-- Name: mqtt_messages_2026_11_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_created_at ATTACH PARTITION public.mqtt_messages_2026_11_created_at_idx;


--
-- Name: mqtt_messages_2026_11_created_at_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_preset_split ATTACH PARTITION public.mqtt_messages_2026_11_created_at_idx1;


--
-- Name: mqtt_messages_2026_11_from_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_from_node_id ATTACH PARTITION public.mqtt_messages_2026_11_from_node_id_created_at_idx;


--
-- Name: mqtt_messages_2026_11_from_node_id_packet_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_packet ATTACH PARTITION public.mqtt_messages_2026_11_from_node_id_packet_id_created_at_idx;


--
-- Name: mqtt_messages_2026_11_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_backfill ATTACH PARTITION public.mqtt_messages_2026_11_id_idx;


--
-- Name: mqtt_messages_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.mqtt_messages_pkey ATTACH PARTITION public.mqtt_messages_2026_11_pkey;


--
-- Name: mqtt_messages_2026_11_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_timestamp ATTACH PARTITION public.mqtt_messages_2026_11_timestamp_idx;


--
-- Name: mqtt_messages_2026_11_to_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_to_node_id ATTACH PARTITION public.mqtt_messages_2026_11_to_node_id_created_at_idx;


--
-- Name: mqtt_messages_2026_11_topic_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_topic_trgm ATTACH PARTITION public.mqtt_messages_2026_11_topic_idx;


--
-- Name: mqtt_messages_2026_12_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_created_at ATTACH PARTITION public.mqtt_messages_2026_12_created_at_idx;


--
-- Name: mqtt_messages_2026_12_created_at_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_preset_split ATTACH PARTITION public.mqtt_messages_2026_12_created_at_idx1;


--
-- Name: mqtt_messages_2026_12_from_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_from_node_id ATTACH PARTITION public.mqtt_messages_2026_12_from_node_id_created_at_idx;


--
-- Name: mqtt_messages_2026_12_from_node_id_packet_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_packet ATTACH PARTITION public.mqtt_messages_2026_12_from_node_id_packet_id_created_at_idx;


--
-- Name: mqtt_messages_2026_12_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_backfill ATTACH PARTITION public.mqtt_messages_2026_12_id_idx;


--
-- Name: mqtt_messages_2026_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.mqtt_messages_pkey ATTACH PARTITION public.mqtt_messages_2026_12_pkey;


--
-- Name: mqtt_messages_2026_12_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_timestamp ATTACH PARTITION public.mqtt_messages_2026_12_timestamp_idx;


--
-- Name: mqtt_messages_2026_12_to_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_to_node_id ATTACH PARTITION public.mqtt_messages_2026_12_to_node_id_created_at_idx;


--
-- Name: mqtt_messages_2026_12_topic_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_topic_trgm ATTACH PARTITION public.mqtt_messages_2026_12_topic_idx;


--
-- Name: mqtt_messages_2027_01_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_created_at ATTACH PARTITION public.mqtt_messages_2027_01_created_at_idx;


--
-- Name: mqtt_messages_2027_01_created_at_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_preset_split ATTACH PARTITION public.mqtt_messages_2027_01_created_at_idx1;


--
-- Name: mqtt_messages_2027_01_from_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_from_node_id ATTACH PARTITION public.mqtt_messages_2027_01_from_node_id_created_at_idx;


--
-- Name: mqtt_messages_2027_01_from_node_id_packet_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_packet ATTACH PARTITION public.mqtt_messages_2027_01_from_node_id_packet_id_created_at_idx;


--
-- Name: mqtt_messages_2027_01_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_backfill ATTACH PARTITION public.mqtt_messages_2027_01_id_idx;


--
-- Name: mqtt_messages_2027_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.mqtt_messages_pkey ATTACH PARTITION public.mqtt_messages_2027_01_pkey;


--
-- Name: mqtt_messages_2027_01_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_timestamp ATTACH PARTITION public.mqtt_messages_2027_01_timestamp_idx;


--
-- Name: mqtt_messages_2027_01_to_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_to_node_id ATTACH PARTITION public.mqtt_messages_2027_01_to_node_id_created_at_idx;


--
-- Name: mqtt_messages_2027_01_topic_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_topic_trgm ATTACH PARTITION public.mqtt_messages_2027_01_topic_idx;


--
-- Name: mqtt_messages_default_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_created_at ATTACH PARTITION public.mqtt_messages_default_created_at_idx;


--
-- Name: mqtt_messages_default_created_at_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_preset_split ATTACH PARTITION public.mqtt_messages_default_created_at_idx1;


--
-- Name: mqtt_messages_default_from_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_from_node_id ATTACH PARTITION public.mqtt_messages_default_from_node_id_created_at_idx;


--
-- Name: mqtt_messages_default_from_node_id_packet_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_packet ATTACH PARTITION public.mqtt_messages_default_from_node_id_packet_id_created_at_idx;


--
-- Name: mqtt_messages_default_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_backfill ATTACH PARTITION public.mqtt_messages_default_id_idx;


--
-- Name: mqtt_messages_default_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.mqtt_messages_pkey ATTACH PARTITION public.mqtt_messages_default_pkey;


--
-- Name: mqtt_messages_default_timestamp_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_timestamp ATTACH PARTITION public.mqtt_messages_default_timestamp_idx;


--
-- Name: mqtt_messages_default_to_node_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_to_node_id ATTACH PARTITION public.mqtt_messages_default_to_node_id_created_at_idx;


--
-- Name: mqtt_messages_default_topic_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_mqtt_messages_topic_trgm ATTACH PARTITION public.mqtt_messages_default_topic_idx;


--
-- Name: packet_receptions_2026_11_gateway_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_gateway ATTACH PARTITION public.packet_receptions_2026_11_gateway_created_at_idx;


--
-- Name: packet_receptions_2026_11_mqtt_row_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_row ATTACH PARTITION public.packet_receptions_2026_11_mqtt_row_id_created_at_idx;


--
-- Name: packet_receptions_2026_12_gateway_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_gateway ATTACH PARTITION public.packet_receptions_2026_12_gateway_created_at_idx;


--
-- Name: packet_receptions_2026_12_mqtt_row_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_row ATTACH PARTITION public.packet_receptions_2026_12_mqtt_row_id_created_at_idx;


--
-- Name: packet_receptions_2027_01_gateway_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_gateway ATTACH PARTITION public.packet_receptions_2027_01_gateway_created_at_idx;


--
-- Name: packet_receptions_2027_01_mqtt_row_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_row ATTACH PARTITION public.packet_receptions_2027_01_mqtt_row_id_created_at_idx;


--
-- Name: packet_receptions_default_gateway_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_gateway ATTACH PARTITION public.packet_receptions_default_gateway_created_at_idx;


--
-- Name: packet_receptions_default_mqtt_row_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_packet_receptions_row ATTACH PARTITION public.packet_receptions_default_mqtt_row_id_created_at_idx;


--
-- Name: mqtt_messages trg_mqtt_messages_extract_node_ids; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mqtt_messages_extract_node_ids BEFORE INSERT ON public.mqtt_messages FOR EACH ROW EXECUTE FUNCTION public.mqtt_messages_extract_node_ids();


--
-- Name: node_neighborinfo update_node_neighborinfo_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_node_neighborinfo_updated_at BEFORE UPDATE ON public.node_neighborinfo FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: node_positions update_node_positions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_node_positions_updated_at BEFORE UPDATE ON public.node_positions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: node_telemetry_current update_node_telemetry_current_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_node_telemetry_current_updated_at BEFORE UPDATE ON public.node_telemetry_current FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: nodes update_nodes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_nodes_updated_at BEFORE UPDATE ON public.nodes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: chat_messages chat_messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.chat_channels(id);


--
-- Name: chat_messages chat_messages_from_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_from_node_id_fkey FOREIGN KEY (from_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_sender_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_sender_node_id_fkey FOREIGN KEY (sender_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_to_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_to_node_id_fkey FOREIGN KEY (to_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: node_neighborinfo_history node_neighborinfo_history_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo_history
    ADD CONSTRAINT node_neighborinfo_history_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: node_neighborinfo node_neighborinfo_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_neighborinfo
    ADD CONSTRAINT node_neighborinfo_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: node_positions node_positions_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_positions
    ADD CONSTRAINT node_positions_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: node_telemetry_current node_telemetry_current_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_telemetry_current
    ADD CONSTRAINT node_telemetry_current_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: telemetry telemetry_from_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_from_node_id_fkey FOREIGN KEY (from_node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: telemetry telemetry_sender_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_sender_node_id_fkey FOREIGN KEY (sender_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: telemetry telemetry_to_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry
    ADD CONSTRAINT telemetry_to_node_id_fkey FOREIGN KEY (to_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: traceroutes traceroutes_from_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes
    ADD CONSTRAINT traceroutes_from_node_id_fkey FOREIGN KEY (from_node_id) REFERENCES public.nodes(id) ON DELETE CASCADE;


--
-- Name: traceroutes traceroutes_sender_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes
    ADD CONSTRAINT traceroutes_sender_node_id_fkey FOREIGN KEY (sender_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- Name: traceroutes traceroutes_to_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.traceroutes
    ADD CONSTRAINT traceroutes_to_node_id_fkey FOREIGN KEY (to_node_id) REFERENCES public.nodes(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict UydS0BiyLe1d75CgIIQFyMDLbzJ3UmnezD0az8KCVrMIRhlClyAaOPi2EJD6PrR

