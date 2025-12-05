import json
import psycopg2
import os
from datetime import datetime

def test_insert():
    # Database connection parameters (from docker-compose)
    db_host = os.getenv("POSTGRES_HOST", "postgres")
    db_port = os.getenv("POSTGRES_PORT", "5432")
    db_name = os.getenv("POSTGRES_DB", "postgres")
    db_user = os.getenv("POSTGRES_USER", "postgres")
    db_password = os.getenv("POSTGRES_PASSWORD", "password")

    print("Connecting to Postgres at", db_host, db_port)

    conn = psycopg2.connect(
        host=db_host,
        port=db_port,
        dbname=db_name,
        user=db_user,
        password=db_password
    )
    
    cur = conn.cursor()

    payload = {
        "example": True,
        "note": "This is a test message inserted from the meshinfo container.",
    }

    cur.execute("""
        INSERT INTO mesh_messages (
            mqtt_topic, from_node_id, to_node_id,
            message_type, port_num, hop_count,
            rx_rssi, rx_snr, payload_json
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id;
    """, (
        "test/topic",
        "0x123abc",
        None,
        "test_message",
        1,
        0,
        -42.0,
        5.5,
        json.dumps(payload)
    ))

    new_id = cur.fetchone()[0]
    conn.commit()

    print("Inserted test mesh_message with ID:", new_id)

if __name__ == "__main__":
    test_insert()