from datetime import datetime
from api.db import insert_mesh_message

def test_insert():
    payload = {
        "example": True,
        "note": "This is a test message inserted from the meshinfo container via helper.",
        "when": datetime.utcnow().isoformat() + "Z",
    }

    new_id = insert_mesh_message(
        mqtt_topic="test/topic",
        from_node_id="0x123abc",
        to_node_id=None,
        message_type="test_message",
        port_num=1,
        hop_count=0,
        rx_rssi=-42.0,
        rx_snr=5.5,
        payload_json=payload,
    )

    print("Inserted test mesh_message with ID:", new_id)

if __name__ == "__main__":
    test_insert()