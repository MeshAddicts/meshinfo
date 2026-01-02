#!/usr/bin/env python3
"""
PostgreSQL storage backend for MeshInfo.

This module provides real-time write capabilities to PostgreSQL while maintaining
the exact same data structure as JSON files for API compatibility.
"""

import asyncpg
import datetime
import json
import logging
from typing import Optional, Dict, List, Any
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)


class PostgresStorage:
    """PostgreSQL storage backend with connection pooling and error handling."""

    def __init__(self, config: Dict[str, Any]):
        """Initialize Postgres storage with configuration."""
        self.config = config
        self.pg_config = config.get('storage', {}).get('postgres', {})
        self.enabled = self.pg_config.get('enabled', False)
        self.pool: Optional[asyncpg.Pool] = None
        self.timezone = config['server']['timezone']

    async def connect(self) -> bool:
        """
        Establish connection pool to PostgreSQL.
        
        Returns:
            bool: True if connection successful, False otherwise
        """
        if not self.enabled:
            logger.info("PostgreSQL storage is disabled in config")
            return False

        try:
            self.pool = await asyncpg.create_pool(
                host=self.pg_config.get('host', 'postgres'),
                port=self.pg_config.get('port', 5432),
                database=self.pg_config.get('database', 'meshinfo'),
                user=self.pg_config.get('username', 'postgres'),
                password=self.pg_config.get('password', 'password'),
                min_size=self.pg_config.get('min_pool_size', 5),
                max_size=self.pg_config.get('max_pool_size', 20),
                command_timeout=10
            )
            logger.info("PostgreSQL connection pool established")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to PostgreSQL: {e}")
            self.enabled = False
            return False

    async def close(self):
        """Close the connection pool."""
        if self.pool:
            await self.pool.close()
            logger.info("PostgreSQL connection pool closed")

    async def ensure_schema(self):
        """Ensure database schema is created."""
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                # Read and execute schema file
                with open('postgres/sql/schema.sql', 'r') as f:
                    schema_sql = f.read()
                await conn.execute(schema_sql)
                logger.info("PostgreSQL schema verified/created")
        except Exception as e:
            logger.error(f"Failed to ensure schema: {e}")

    # ============================================================================
    # WRITE OPERATIONS - Real-time writes for dual-write pattern
    # ============================================================================

    async def write_node(self, node_id: str, node_data: Dict[str, Any]):
        """
        Write/update a node to PostgreSQL in real-time.
        
        Args:
            node_id: 8-character hex node ID
            node_data: Complete node data dictionary
        """
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    # Upsert main node data
                    last_seen = node_data.get('last_seen')
                    if isinstance(last_seen, str):
                        last_seen_ts = datetime.datetime.fromisoformat(last_seen)
                    elif isinstance(last_seen, datetime.datetime):
                        last_seen_ts = last_seen
                    else:
                        last_seen_ts = None

                    since = node_data.get('since')
                    since_seconds = since.total_seconds() if since else None

                    await conn.execute("""
                        INSERT INTO nodes (id, longname, shortname, hardware, role, active, tc2_bbs, last_seen, since_seconds)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (id) DO UPDATE SET
                            longname = EXCLUDED.longname,
                            shortname = EXCLUDED.shortname,
                            hardware = EXCLUDED.hardware,
                            role = EXCLUDED.role,
                            active = EXCLUDED.active,
                            tc2_bbs = EXCLUDED.tc2_bbs,
                            last_seen = EXCLUDED.last_seen,
                            since_seconds = EXCLUDED.since_seconds,
                            updated_at = NOW()
                    """, node_id, node_data.get('longname'), node_data.get('shortname'),
                         node_data.get('hardware'), node_data.get('role', 0),
                         node_data.get('active', False), node_data.get('tc2_bbs', False),
                         last_seen_ts, since_seconds)

                    # Handle position data
                    if node_data.get('position'):
                        await self._write_node_position(conn, node_id, node_data['position'])

                    # Handle neighborinfo
                    if node_data.get('neighborinfo'):
                        await self._write_node_neighborinfo(conn, node_id, node_data['neighborinfo'])

                    # Handle telemetry (current state only)
                    if node_data.get('telemetry'):
                        await self._write_node_telemetry_current(conn, node_id, node_data['telemetry'])

        except Exception as e:
            logger.error(f"Failed to write node {node_id} to PostgreSQL: {e}")

    async def _write_node_position(self, conn, node_id: str, position: Dict[str, Any]):
        """Write node position data."""
        geocoded = json.dumps(position.get('geocoded')) if position.get('geocoded') else None
        last_geocoding = position.get('last_geocoding')
        if isinstance(last_geocoding, str):
            last_geocoding = datetime.datetime.fromisoformat(last_geocoding)

        await conn.execute("""
            INSERT INTO node_positions (node_id, latitude_i, longitude_i, altitude, time, precision_bits, geocoded, last_geocoding)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """, node_id, position.get('latitude_i'), position.get('longitude_i'),
             position.get('altitude'), position.get('time'), position.get('precision_bits'),
             geocoded, last_geocoding)

    async def _write_node_neighborinfo(self, conn, node_id: str, neighborinfo: Dict[str, Any]):
        """Write node neighborinfo data."""
        neighbors_json = json.dumps(neighborinfo.get('neighbors', []))
        
        await conn.execute("""
            INSERT INTO node_neighborinfo (node_id, node_broadcast_interval_secs, neighbors)
            VALUES ($1, $2, $3)
        """, node_id, neighborinfo.get('node_broadcast_interval_secs'), neighbors_json)

    async def _write_node_telemetry_current(self, conn, node_id: str, telemetry: Dict[str, Any]):
        """Write current node telemetry state."""
        await conn.execute("""
            INSERT INTO node_telemetry_current (
                node_id, battery_level, voltage, channel_utilization, air_util_tx,
                uptime_seconds, temperature, relative_humidity, barometric_pressure,
                gas_resistance, iaq, distance, lux, white_lux, ir_lux, uv_lux,
                wind_direction, wind_speed, weight
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (node_id) DO UPDATE SET
                battery_level = EXCLUDED.battery_level,
                voltage = EXCLUDED.voltage,
                channel_utilization = EXCLUDED.channel_utilization,
                air_util_tx = EXCLUDED.air_util_tx,
                uptime_seconds = EXCLUDED.uptime_seconds,
                temperature = EXCLUDED.temperature,
                relative_humidity = EXCLUDED.relative_humidity,
                barometric_pressure = EXCLUDED.barometric_pressure,
                gas_resistance = EXCLUDED.gas_resistance,
                iaq = EXCLUDED.iaq,
                distance = EXCLUDED.distance,
                lux = EXCLUDED.lux,
                white_lux = EXCLUDED.white_lux,
                ir_lux = EXCLUDED.ir_lux,
                uv_lux = EXCLUDED.uv_lux,
                wind_direction = EXCLUDED.wind_direction,
                wind_speed = EXCLUDED.wind_speed,
                weight = EXCLUDED.weight,
                updated_at = NOW()
        """, node_id, telemetry.get('battery_level'), telemetry.get('voltage'),
             telemetry.get('channel_utilization'), telemetry.get('air_util_tx'),
             telemetry.get('uptime_seconds'), telemetry.get('temperature'),
             telemetry.get('relative_humidity'), telemetry.get('barometric_pressure'),
             telemetry.get('gas_resistance'), telemetry.get('iaq'),
             telemetry.get('distance'), telemetry.get('lux'), telemetry.get('white_lux'),
             telemetry.get('ir_lux'), telemetry.get('uv_lux'),
             telemetry.get('wind_direction'), telemetry.get('wind_speed'),
             telemetry.get('weight'))

    async def write_telemetry(self, telemetry_msg: Dict[str, Any]):
        """
        Write telemetry message to history table.
        
        Args:
            telemetry_msg: Complete telemetry message from MQTT
        """
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                payload_json = json.dumps(telemetry_msg.get('payload', {}))
                rx_time = None
                if 'timestamp' in telemetry_msg:
                    rx_time = datetime.datetime.fromtimestamp(
                        telemetry_msg['timestamp'] / 1000,
                        tz=ZoneInfo(self.timezone)
                    )

                await conn.execute("""
                    INSERT INTO telemetry (
                        from_node_id, to_node_id, sender_node_id, message_id, channel,
                        packet_id, hops_away, rssi, snr, timestamp, rx_time, payload
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """, telemetry_msg.get('from'), telemetry_msg.get('to'),
                     telemetry_msg.get('sender'), telemetry_msg.get('id'),
                     telemetry_msg.get('channel'), telemetry_msg.get('packet_id'),
                     telemetry_msg.get('hops_away'), telemetry_msg.get('rssi'),
                     telemetry_msg.get('snr'), telemetry_msg.get('timestamp'),
                     rx_time, payload_json)

        except Exception as e:
            logger.error(f"Failed to write telemetry to PostgreSQL: {e}")

    async def write_chat_message(self, chat_msg: Dict[str, Any]):
        """
        Write chat message to PostgreSQL.
        
        Args:
            chat_msg: Chat message dictionary
        """
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                async with conn.transaction():
                    # Ensure channel exists
                    channel_id = str(chat_msg.get('channel', '0'))
                    channel_name = f"Channel {channel_id}" if channel_id != '0' else 'General'
                    
                    await conn.execute("""
                        INSERT INTO chat_channels (id, name)
                        VALUES ($1, $2)
                        ON CONFLICT (id) DO NOTHING
                    """, channel_id, channel_name)

                    # Insert message
                    rx_time = None
                    if 'timestamp' in chat_msg:
                        rx_time = datetime.datetime.fromtimestamp(
                            chat_msg['timestamp'] / 1000,
                            tz=ZoneInfo(self.timezone)
                        )

                    await conn.execute("""
                        INSERT INTO chat_messages (
                            id, from_node_id, to_node_id, sender_node_id, channel_id,
                            text, timestamp, rx_time, hops_away, rssi, snr
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (id) DO NOTHING
                    """, chat_msg.get('id'), chat_msg.get('from'), chat_msg.get('to'),
                         chat_msg.get('sender'), channel_id, chat_msg.get('text'),
                         chat_msg.get('timestamp'), rx_time, chat_msg.get('hops_away'),
                         chat_msg.get('rssi'), chat_msg.get('snr'))

        except Exception as e:
            logger.error(f"Failed to write chat message to PostgreSQL: {e}")

    async def write_traceroute(self, traceroute_msg: Dict[str, Any]):
        """
        Write traceroute to PostgreSQL.
        
        Args:
            traceroute_msg: Traceroute message dictionary
        """
        if not self.enabled or not self.pool:
            return

        try:
            async with self.pool.acquire() as conn:
                payload_json = json.dumps(traceroute_msg.get('payload', {}))
                route_json = json.dumps(traceroute_msg.get('route', []))
                route_ids_json = json.dumps(traceroute_msg.get('route_ids', []))
                
                rx_time = None
                if 'timestamp' in traceroute_msg:
                    rx_time = datetime.datetime.fromtimestamp(
                        traceroute_msg['timestamp'] / 1000,
                        tz=ZoneInfo(self.timezone)
                    )

                await conn.execute("""
                    INSERT INTO traceroutes (
                        from_node_id, to_node_id, sender_node_id, message_id, channel,
                        packet_id, hops_away, rssi, snr, timestamp, rx_time,
                        route, route_ids, payload
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                """, traceroute_msg.get('from'), traceroute_msg.get('to'),
                     traceroute_msg.get('sender'), traceroute_msg.get('id'),
                     traceroute_msg.get('channel'), traceroute_msg.get('packet_id'),
                     traceroute_msg.get('hops_away'), traceroute_msg.get('rssi'),
                     traceroute_msg.get('snr'), traceroute_msg.get('timestamp'),
                     rx_time, route_json, route_ids_json, payload_json)

        except Exception as e:
            logger.error(f"Failed to write traceroute to PostgreSQL: {e}")

    # ============================================================================
    # READ OPERATIONS - Load data from PostgreSQL matching JSON structure
    # ============================================================================

    async def load_nodes(self) -> Dict[str, Any]:
        """
        Load all nodes from PostgreSQL in JSON-compatible format.
        
        Returns:
            Dict mapping node_id to node data (same structure as JSON)
        """
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                # Load nodes
                nodes = {}
                rows = await conn.fetch("SELECT * FROM nodes")
                
                for row in rows:
                    node_id = row['id']
                    nodes[node_id] = {
                        'id': node_id,
                        'longname': row['longname'],
                        'shortname': row['shortname'],
                        'hardware': row['hardware'],
                        'role': row['role'],
                        'active': row['active'],
                        'tc2_bbs': row.get('tc2_bbs', False),
                        'last_seen': row['last_seen'].isoformat() if row['last_seen'] else None,
                        'since': datetime.timedelta(seconds=row['since_seconds']) if row['since_seconds'] else None,
                        'position': None,
                        'neighborinfo': None,
                        'telemetry': None
                    }

                # Load positions (most recent per node)
                position_rows = await conn.fetch("""
                    SELECT DISTINCT ON (node_id) *
                    FROM node_positions
                    ORDER BY node_id, created_at DESC
                """)
                
                for row in position_rows:
                    node_id = row['node_id']
                    if node_id in nodes:
                        nodes[node_id]['position'] = {
                            'latitude_i': row['latitude_i'],
                            'longitude_i': row['longitude_i'],
                            'altitude': row['altitude'],
                            'time': row['time'],
                            'precision_bits': row['precision_bits'],
                            'geocoded': json.loads(row['geocoded']) if row['geocoded'] else None,
                            'last_geocoding': row['last_geocoding'].isoformat() if row['last_geocoding'] else None
                        }

                # Load neighborinfo (most recent per node)
                neighbor_rows = await conn.fetch("""
                    SELECT DISTINCT ON (node_id) *
                    FROM node_neighborinfo
                    ORDER BY node_id, created_at DESC
                """)
                
                for row in neighbor_rows:
                    node_id = row['node_id']
                    if node_id in nodes:
                        nodes[node_id]['neighborinfo'] = {
                            'node_broadcast_interval_secs': row['node_broadcast_interval_secs'],
                            'neighbors': json.loads(row['neighbors']) if row['neighbors'] else []
                        }

                # Load current telemetry
                telemetry_rows = await conn.fetch("SELECT * FROM node_telemetry_current")
                
                for row in telemetry_rows:
                    node_id = row['node_id']
                    if node_id in nodes:
                        telemetry = {}
                        for field in ['battery_level', 'voltage', 'channel_utilization', 'air_util_tx',
                                    'uptime_seconds', 'temperature', 'relative_humidity', 
                                    'barometric_pressure', 'gas_resistance', 'iaq', 'distance',
                                    'lux', 'white_lux', 'ir_lux', 'uv_lux', 'wind_direction',
                                    'wind_speed', 'weight']:
                            if row[field] is not None:
                                telemetry[field] = row[field]
                        nodes[node_id]['telemetry'] = telemetry if telemetry else None

                logger.info(f"Loaded {len(nodes)} nodes from PostgreSQL")
                return nodes

        except Exception as e:
            logger.error(f"Failed to load nodes from PostgreSQL: {e}")
            return {}

    async def load_chat(self) -> Dict[str, Any]:
        """
        Load chat data from PostgreSQL in JSON-compatible format.
        
        Returns:
            Chat structure matching JSON format
        """
        if not self.enabled or not self.pool:
            return {'channels': {'0': {'name': 'General', 'messages': []}}}

        try:
            async with self.pool.acquire() as conn:
                chat = {'channels': {}}

                # Load channels
                channel_rows = await conn.fetch("SELECT * FROM chat_channels ORDER BY id")
                for row in channel_rows:
                    chat['channels'][row['id']] = {
                        'name': row['name'],
                        'messages': []
                    }

                # Load messages (most recent first)
                message_rows = await conn.fetch("""
                    SELECT * FROM chat_messages
                    ORDER BY created_at DESC
                    LIMIT 10000
                """)

                for row in message_rows:
                    channel_id = row['channel_id'] or '0'
                    if channel_id not in chat['channels']:
                        chat['channels'][channel_id] = {
                            'name': f'Channel {channel_id}',
                            'messages': []
                        }
                    
                    chat['channels'][channel_id]['messages'].append({
                        'id': row['id'],
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'channel': channel_id,
                        'text': row['text'],
                        'timestamp': row['timestamp'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr']
                    })

                logger.info(f"Loaded {len(message_rows)} chat messages from PostgreSQL")
                return chat

        except Exception as e:
            logger.error(f"Failed to load chat from PostgreSQL: {e}")
            return {'channels': {'0': {'name': 'General', 'messages': []}}}

    async def load_telemetry(self) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """
        Load telemetry data from PostgreSQL.
        
        Returns:
            Tuple of (telemetry_list, telemetry_by_node)
        """
        if not self.enabled or not self.pool:
            return [], {}

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM telemetry
                    ORDER BY created_at DESC
                    LIMIT 10000
                """)

                telemetry = []
                telemetry_by_node = {}

                for row in rows:
                    msg = {
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    }
                    
                    telemetry.append(msg)
                    
                    node_id = row['from_node_id']
                    if node_id not in telemetry_by_node:
                        telemetry_by_node[node_id] = []
                    telemetry_by_node[node_id].append(msg)

                logger.info(f"Loaded {len(telemetry)} telemetry records from PostgreSQL")
                return telemetry, telemetry_by_node

        except Exception as e:
            logger.error(f"Failed to load telemetry from PostgreSQL: {e}")
            return [], {}

    async def load_traceroutes(self) -> tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """
        Load traceroute data from PostgreSQL.
        
        Returns:
            Tuple of (traceroutes_list, traceroutes_by_node)
        """
        if not self.enabled or not self.pool:
            return [], {}

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM traceroutes
                    ORDER BY created_at DESC
                    LIMIT 10000
                """)

                traceroutes = []
                traceroutes_by_node = {}

                for row in rows:
                    msg = {
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'route': json.loads(row['route']) if row['route'] else [],
                        'route_ids': json.loads(row['route_ids']) if row['route_ids'] else [],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    }
                    
                    traceroutes.append(msg)
                    
                    node_id = row['from_node_id']
                    if node_id not in traceroutes_by_node:
                        traceroutes_by_node[node_id] = []
                    traceroutes_by_node[node_id].append(msg)

                logger.info(f"Loaded {len(traceroutes)} traceroutes from PostgreSQL")
                return traceroutes, traceroutes_by_node

        except Exception as e:
            logger.error(f"Failed to load traceroutes from PostgreSQL: {e}")
            return [], {}

    # ============================================================================
    # DIRECT QUERY OPERATIONS - For API endpoints when reading from Postgres
    # ============================================================================

    async def query_nodes_filtered(
        self, 
        days_limit: int = 7,
        node_ids: Optional[List[str]] = None,
        longname_filter: Optional[str] = None,
        shortname_filter: Optional[str] = None,
        status_filter: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Query nodes with filters directly from PostgreSQL.
        
        Args:
            days_limit: Only return nodes seen within this many days
            node_ids: Filter by specific node IDs
            longname_filter: Filter by longname substring (case-insensitive)
            shortname_filter: Filter by shortname substring (case-insensitive)
            status_filter: Filter by status ("online" or "offline")
        
        Returns:
            Dict mapping node_id to node data
        """
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                # Build WHERE clause
                where_parts = []
                params = []
                param_num = 1

                # Days filter
                if days_limit:
                    where_parts.append(f"last_seen >= NOW() - INTERVAL '{days_limit} days'")

                # Node IDs filter
                if node_ids:
                    placeholders = ','.join([f'${i}' for i in range(param_num, param_num + len(node_ids))])
                    where_parts.append(f"id IN ({placeholders})")
                    params.extend(node_ids)
                    param_num += len(node_ids)

                # Longname filter
                if longname_filter:
                    where_parts.append(f"LOWER(longname) LIKE ${param_num}")
                    params.append(f"%{longname_filter.lower()}%")
                    param_num += 1

                # Shortname filter
                if shortname_filter:
                    where_parts.append(f"LOWER(shortname) LIKE ${param_num}")
                    params.append(f"%{shortname_filter.lower()}%")
                    param_num += 1

                # Status filter
                if status_filter == "online":
                    where_parts.append("active = TRUE")
                elif status_filter == "offline":
                    where_parts.append("active = FALSE")

                where_clause = " AND ".join(where_parts) if where_parts else "TRUE"
                
                # Query nodes
                nodes = {}
                query = f"SELECT * FROM nodes WHERE {where_clause}"
                rows = await conn.fetch(query, *params)
                
                for row in rows:
                    node_id = row['id']
                    nodes[node_id] = {
                        'id': node_id,
                        'longname': row['longname'],
                        'shortname': row['shortname'],
                        'hardware': row['hardware'],
                        'role': row['role'],
                        'active': row['active'],
                        'tc2_bbs': row.get('tc2_bbs', False),
                        'last_seen': row['last_seen'].isoformat() if row['last_seen'] else None,
                        'since': datetime.timedelta(seconds=row['since_seconds']) if row['since_seconds'] else None,
                        'position': None,
                        'neighborinfo': None,
                        'telemetry': None
                    }

                # Load related data for returned nodes
                if nodes:
                    node_ids_list = list(nodes.keys())
                    
                    # Load positions
                    position_query = """
                        SELECT DISTINCT ON (node_id) *
                        FROM node_positions
                        WHERE node_id = ANY($1)
                        ORDER BY node_id, created_at DESC
                    """
                    position_rows = await conn.fetch(position_query, node_ids_list)
                    
                    for row in position_rows:
                        node_id = row['node_id']
                        if node_id in nodes:
                            nodes[node_id]['position'] = {
                                'latitude_i': row['latitude_i'],
                                'longitude_i': row['longitude_i'],
                                'altitude': row['altitude'],
                                'time': row['time'],
                                'precision_bits': row['precision_bits'],
                                'geocoded': json.loads(row['geocoded']) if row['geocoded'] else None,
                                'last_geocoding': row['last_geocoding'].isoformat() if row['last_geocoding'] else None
                            }

                    # Load neighborinfo
                    neighbor_query = """
                        SELECT DISTINCT ON (node_id) *
                        FROM node_neighborinfo
                        WHERE node_id = ANY($1)
                        ORDER BY node_id, created_at DESC
                    """
                    neighbor_rows = await conn.fetch(neighbor_query, node_ids_list)
                    
                    for row in neighbor_rows:
                        node_id = row['node_id']
                        if node_id in nodes:
                            nodes[node_id]['neighborinfo'] = {
                                'node_broadcast_interval_secs': row['node_broadcast_interval_secs'],
                                'neighbors': json.loads(row['neighbors']) if row['neighbors'] else []
                            }

                    # Load current telemetry
                    telemetry_query = "SELECT * FROM node_telemetry_current WHERE node_id = ANY($1)"
                    telemetry_rows = await conn.fetch(telemetry_query, node_ids_list)
                    
                    for row in telemetry_rows:
                        node_id = row['node_id']
                        if node_id in nodes:
                            telemetry = {}
                            for field in ['battery_level', 'voltage', 'channel_utilization', 'air_util_tx',
                                        'uptime_seconds', 'temperature', 'relative_humidity', 
                                        'barometric_pressure', 'gas_resistance', 'iaq', 'distance',
                                        'lux', 'white_lux', 'ir_lux', 'uv_lux', 'wind_direction',
                                        'wind_speed', 'weight']:
                                if row[field] is not None:
                                    telemetry[field] = row[field]
                            nodes[node_id]['telemetry'] = telemetry if telemetry else None

                return nodes

        except Exception as e:
            logger.error(f"Failed to query nodes from PostgreSQL: {e}")
            return {}

    async def query_node_by_id(self, node_id: str) -> Optional[Dict[str, Any]]:
        """Query a single node by ID directly from PostgreSQL."""
        nodes = await self.query_nodes_filtered(days_limit=None, node_ids=[node_id])
        return nodes.get(node_id)

    async def query_node_telemetry(self, node_id: str, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query telemetry for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM telemetry
                    WHERE from_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT $2
                """, node_id, limit)

                telemetry = []
                for row in rows:
                    telemetry.append({
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    })
                
                return telemetry

        except Exception as e:
            logger.error(f"Failed to query telemetry from PostgreSQL: {e}")
            return []

    async def query_node_texts(self, node_id: str) -> List[Dict[str, Any]]:
        """Query text messages for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM chat_messages
                    WHERE from_node_id = $1 OR to_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1000
                """, node_id)

                texts = []
                for row in rows:
                    texts.append({
                        'id': row['id'],
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'channel': row['channel_id'] or '0',
                        'text': row['text'],
                        'timestamp': row['timestamp'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr']
                    })
                
                return texts

        except Exception as e:
            logger.error(f"Failed to query texts from PostgreSQL: {e}")
            return []

    async def query_node_traceroutes(self, node_id: str) -> List[Dict[str, Any]]:
        """Query traceroutes for a specific node."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM traceroutes
                    WHERE from_node_id = $1 OR to_node_id = $1
                    ORDER BY created_at DESC
                    LIMIT 1000
                """, node_id)

                traceroutes = []
                for row in rows:
                    traceroutes.append({
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'route': json.loads(row['route']) if row['route'] else [],
                        'route_ids': json.loads(row['route_ids']) if row['route_ids'] else [],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    })
                
                return traceroutes

        except Exception as e:
            logger.error(f"Failed to query traceroutes from PostgreSQL: {e}")
            return []

    async def query_all_chat(self, limit: int = 10000) -> Dict[str, Any]:
        """Query all chat channels and messages."""
        if not self.enabled or not self.pool:
            return {'channels': {'0': {'name': 'General', 'messages': []}}}

        try:
            async with self.pool.acquire() as conn:
                chat = {'channels': {}}

                # Load channels
                channel_rows = await conn.fetch("SELECT * FROM chat_channels ORDER BY id")
                for row in channel_rows:
                    chat['channels'][row['id']] = {
                        'name': row['name'],
                        'messages': []
                    }

                # Load messages
                message_rows = await conn.fetch("""
                    SELECT * FROM chat_messages
                    ORDER BY created_at DESC
                    LIMIT $1
                """, limit)

                for row in message_rows:
                    channel_id = row['channel_id'] or '0'
                    if channel_id not in chat['channels']:
                        chat['channels'][channel_id] = {
                            'name': f'Channel {channel_id}',
                            'messages': []
                        }
                    
                    chat['channels'][channel_id]['messages'].append({
                        'id': row['id'],
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'channel': channel_id,
                        'text': row['text'],
                        'timestamp': row['timestamp'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr']
                    })

                return chat

        except Exception as e:
            logger.error(f"Failed to query chat from PostgreSQL: {e}")
            return {'channels': {'0': {'name': 'General', 'messages': []}}}

    async def query_all_telemetry(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query all telemetry records."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM telemetry
                    ORDER BY created_at DESC
                    LIMIT $1
                """, limit)

                telemetry = []
                for row in rows:
                    telemetry.append({
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    })
                
                return telemetry

        except Exception as e:
            logger.error(f"Failed to query telemetry from PostgreSQL: {e}")
            return []

    async def query_all_traceroutes(self, limit: int = 1000) -> List[Dict[str, Any]]:
        """Query all traceroutes."""
        if not self.enabled or not self.pool:
            return []

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT * FROM traceroutes
                    ORDER BY created_at DESC
                    LIMIT $1
                """, limit)

                traceroutes = []
                for row in rows:
                    traceroutes.append({
                        'from': row['from_node_id'],
                        'to': row['to_node_id'],
                        'sender': row['sender_node_id'],
                        'id': row['message_id'],
                        'channel': row['channel'],
                        'packet_id': row['packet_id'],
                        'hops_away': row['hops_away'],
                        'rssi': row['rssi'],
                        'snr': row['snr'],
                        'timestamp': row['timestamp'],
                        'route': json.loads(row['route']) if row['route'] else [],
                        'route_ids': json.loads(row['route_ids']) if row['route_ids'] else [],
                        'payload': json.loads(row['payload']) if row['payload'] else {}
                    })
                
                return traceroutes

        except Exception as e:
            logger.error(f"Failed to query traceroutes from PostgreSQL: {e}")
            return []

    async def query_stats(self) -> Dict[str, int]:
        """Query statistics from PostgreSQL."""
        if not self.enabled or not self.pool:
            return {}

        try:
            async with self.pool.acquire() as conn:
                stats = {}
                
                # Count nodes
                stats['total_nodes'] = await conn.fetchval("SELECT COUNT(*) FROM nodes")
                stats['active_nodes'] = await conn.fetchval("SELECT COUNT(*) FROM nodes WHERE active = TRUE")
                
                # Count messages
                stats['total_chat'] = await conn.fetchval("SELECT COUNT(*) FROM chat_messages WHERE channel_id = '0'")
                stats['total_telemetry'] = await conn.fetchval("SELECT COUNT(*) FROM telemetry")
                stats['total_traceroutes'] = await conn.fetchval("SELECT COUNT(*) FROM traceroutes")
                
                # Messages and MQTT messages not stored in Postgres (in-memory only)
                stats['total_messages'] = 0
                stats['total_mqtt_messages'] = 0
                
                return stats

        except Exception as e:
            logger.error(f"Failed to query stats from PostgreSQL: {e}")
            return {}
