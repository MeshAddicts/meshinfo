import os
import psycopg2
from psycopg2.extras import RealDictCursor

def get_db_params():
    return {
        "host": os.getenv("POSTGRES_HOST", "postgres"),
        "port": int(os.getenv("POSTGRES_PORT", "5432")),
        "dbname": os.getenv("POSTGRES_DB", "postgres"),
        "user": os.getenv("POSTGRES_USER", "postgres"),
        "password": os.getenv("POSTGRES_PASSWORD", "password"),
    }

def get_connection(cursor_factory=None):
    params = get_db_params()
    return psycopg2.connect(cursor_factory=cursor_factory, **params)

def insert_mesh_message(
    mqtt_topic,
    from_node_id=None,
    to_node_id=None,
    message_type=None,
    port_num=None,
    hop_count=None,
    rx_rssi=None,
    rx_snr=None,
    payload_json=None,
    raw_payload=None,
):
    import json

    if payload_json is None:
        payload_json = {}

    conn = get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO mesh_messages (
                        mqtt_topic,
                        from_node_id,
                        to_node_id,
                        message_type,
                        port_num,
                        hop_count,
                        rx_rssi,
                        rx_snr,
                        payload_json,
                        raw_payload
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    RETURNING id;
                    """,
                    (
                        mqtt_topic,
                        from_node_id,
                        to_node_id,
                        message_type,
                        port_num,
                        hop_count,
                        rx_rssi,
                        rx_snr,
                        json.dumps(payload_json),
                        raw_payload,
                    ),
                )
                new_id = cur.fetchone()[0]
                return new_id
    finally:
        conn.close()
