"""
Rich Discord embed builders for Meshtastic mesh messages.

Inspired by RATM 2.0's presentation layer — gateway grouping by hop count,
SNR/RSSI display, static map thumbnails for position packets, and reply
threading support.
"""

import logging
from typing import Optional

import discord

import utils

logger = logging.getLogger(__name__)

# Discord embed limits
EMBED_TOTAL_LIMIT = 6000
EMBED_DESC_LIMIT = 4096
EMBED_FIELD_VALUE_LIMIT = 1024

# Static map API for position embeds
MAP_API_URL = "https://api.smerty.org/staticmap"


def _node_url(base_url: str, node_id: str) -> str | None:
    """Build a deep link URL to a node's detail page."""
    if not base_url:
        return None
    return f"{base_url.rstrip('/')}/nodes?node={node_id}"


def _node_display_name(node: Optional[dict], node_id: str) -> str:
    """Return a human-readable name for a node, falling back to hex ID."""
    if node:
        longname = node.get("longname", "")
        shortname = node.get("shortname", "")
        if longname and longname != "Unknown":
            return longname
        if shortname and shortname != "UNK":
            return shortname
    return f"!{node_id}"


def _node_short_name(node: Optional[dict], node_id: str) -> str:
    """Return the short name for a node."""
    if node and node.get("shortname") and node["shortname"] != "UNK":
        return node["shortname"]
    return node_id[:4]


def _node_linked_name(node: Optional[dict], node_id: str, base_url: str) -> str:
    """Return a markdown-linked node name, e.g. [NodeName](https://...)."""
    name = _node_display_name(node, node_id)
    url = _node_url(base_url, node_id)
    if url:
        return f"[{name}]({url})"
    return name


def _format_gateway_info(msg: dict, nodes: dict, base_url: str) -> str:
    """Format gateway/reception info from the message metadata."""
    parts = []

    # SNR/RSSI from the receiving gateway
    snr = msg.get("snr")
    rssi = msg.get("rssi")
    if snr is not None or rssi is not None:
        signal_parts = []
        if rssi is not None:
            signal_parts.append(f"RSSI: {rssi} dBm")
        if snr is not None:
            signal_parts.append(f"SNR: {snr} dB")
        parts.append(" | ".join(signal_parts))

    # Hop info
    hops_away = msg.get("hops_away")
    hop_limit = msg.get("hop_limit")
    if hops_away is not None:
        hop_str = "Direct" if hops_away == 0 else f"{hops_away} hop(s)"
        if hop_limit is not None:
            hop_str += f" (limit: {hop_limit})"
        parts.append(hop_str)

    # Gateway node
    topic = msg.get("topic", "")
    if topic:
        topic_parts = topic.split("/")
        if topic_parts and topic_parts[-1].startswith("!"):
            gw_id = topic_parts[-1].replace("!", "")
            gw_node = nodes.get(gw_id)
            gw_name = _node_linked_name(gw_node, gw_id, base_url)
            parts.append(f"Gateway: {gw_name}")

    return "\n".join(parts) if parts else ""


def _resolve_channel_name(channel_hash: str, config: dict) -> str:
    """Resolve a channel hash to its label from config, or return the hash."""
    meta = config.get("broker", {}).get("channels", {}).get("meta", {})
    channel_meta = meta.get(channel_hash, {})
    return channel_meta.get("label", f"Channel {channel_hash}")


def build_text_embed(
    msg: dict,
    chat: dict,
    nodes: dict,
    base_url: str,
    config: dict,
    owner_id: Optional[str] = None,
    gateway_entries: Optional[list] = None,
) -> discord.Embed:
    """
    Build a rich embed for a text message from the mesh.
    """
    from_id = chat.get("from", msg.get("from", "unknown"))
    node = nodes.get(from_id)
    display_name = _node_display_name(node, from_id)
    short_name = _node_short_name(node, from_id)
    text = chat.get("text", "")

    # Build embed — title links to the sender's node page
    node_link = _node_url(base_url, from_id)
    embed = discord.Embed(
        description=text[:EMBED_DESC_LIMIT],
        color=discord.Color.green(),
        timestamp=discord.utils.utcnow(),
    )

    # Author = sender node (linked to node page)
    avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={from_id}"
    embed.set_author(name=f"{display_name} [{short_name}]", url=node_link, icon_url=avatar_url)

    # Packet info fields
    packet_id = msg.get("id")
    if packet_id:
        embed.add_field(name="Packet ID", value=str(packet_id), inline=True)

    channel = str(chat.get("channel", "0"))
    channel_label = _resolve_channel_name(channel, config)
    embed.add_field(name="Channel", value=channel_label, inline=True)

    # Gateway info with linked names
    if gateway_entries and len(gateway_entries) > 0:
        gw_text = _format_gateway_list(gateway_entries, nodes, base_url)
        if gw_text:
            if len(gw_text) > EMBED_FIELD_VALUE_LIMIT:
                gw_text = gw_text[: EMBED_FIELD_VALUE_LIMIT - 3] + "..."
            embed.add_field(name="Gateways", value=gw_text, inline=False)
    else:
        gw_info = _format_gateway_info(msg, nodes, base_url)
        if gw_info:
            if len(gw_info) > EMBED_FIELD_VALUE_LIMIT:
                gw_info = gw_info[: EMBED_FIELD_VALUE_LIMIT - 3] + "..."
            embed.add_field(name="Reception", value=gw_info, inline=False)

    # Owner mention
    if owner_id:
        embed.add_field(name="Owner", value=f"<@{owner_id}>", inline=True)

    # Footer with link-friendly node ID
    embed.set_footer(text=f"Node: !{from_id}")

    return embed


def build_position_embed(
    msg: dict,
    node_id: str,
    nodes: dict,
    base_url: str,
    track_type: str = "tracker",
    owner_id: Optional[str] = None,
    gateway_entries: Optional[list] = None,
) -> discord.Embed:
    """
    Build a rich embed for a position update from a tracked node.
    """
    node = nodes.get(node_id)
    display_name = _node_display_name(node, node_id)
    short_name = _node_short_name(node, node_id)
    payload = msg.get("payload", {})

    label = "Balloon" if track_type == "balloon" else "Tracker"
    node_link = _node_url(base_url, node_id)
    embed = discord.Embed(
        title=f"{label} Position Update",
        url=node_link,
        color=discord.Color.orange() if track_type == "balloon" else discord.Color.blue(),
        timestamp=discord.utils.utcnow(),
    )

    avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={node_id}"
    embed.set_author(name=f"{display_name} [{short_name}]", url=node_link, icon_url=avatar_url)

    # Position fields
    lat_i = payload.get("latitude_i")
    lon_i = payload.get("longitude_i")
    alt = payload.get("altitude")

    if lat_i is not None and lon_i is not None:
        lat = lat_i / 1e7
        lon = lon_i / 1e7
        embed.add_field(name="Latitude", value=f"{lat:.6f}", inline=True)
        embed.add_field(name="Longitude", value=f"{lon:.6f}", inline=True)
        if alt is not None:
            embed.add_field(name="Altitude", value=f"{alt}m", inline=True)

        # Static map thumbnail
        map_url = f"{MAP_API_URL}?center={lat},{lon}&zoom=12&size=300x200&markers={lat},{lon}"
        embed.set_thumbnail(url=map_url)

    # Gateway info with linked names
    if gateway_entries and len(gateway_entries) > 0:
        gw_text = _format_gateway_list(gateway_entries, nodes, base_url)
        if gw_text:
            if len(gw_text) > EMBED_FIELD_VALUE_LIMIT:
                gw_text = gw_text[: EMBED_FIELD_VALUE_LIMIT - 3] + "..."
            embed.add_field(name="Gateways", value=gw_text, inline=False)
    else:
        gw_info = _format_gateway_info(msg, nodes, base_url)
        if gw_info:
            if len(gw_info) > EMBED_FIELD_VALUE_LIMIT:
                gw_info = gw_info[: EMBED_FIELD_VALUE_LIMIT - 3] + "..."
            embed.add_field(name="Reception", value=gw_info, inline=False)

    if owner_id:
        embed.add_field(name="Owner", value=f"<@{owner_id}>", inline=True)

    embed.set_footer(text=f"Node: !{node_id}")

    return embed


def _format_gateway_list(gateway_entries: list, nodes: dict, base_url: str) -> str:
    """
    Format a list of gateway reception reports grouped by hop count.
    Gateway names are markdown-linked to their MeshInfo node pages.
    """
    if not gateway_entries:
        return ""

    # Group by hops — treat None/missing as 0 (direct)
    by_hops: dict[int, list] = {}
    for gw in gateway_entries:
        hops = gw.get("hops_away")
        if hops is None:
            hops = 0
        by_hops.setdefault(hops, []).append(gw)

    lines = []
    for hops in sorted(by_hops.keys()):
        if hops == 0:
            header = "**Direct**"
        else:
            header = f"**{hops} hop(s)**"
        lines.append(header)

        for gw in by_hops[hops]:
            gw_id = gw.get("gateway_id", "unknown")
            gw_node = nodes.get(gw_id)
            gw_name = _node_linked_name(gw_node, gw_id, base_url)
            parts = [f"  {gw_name}"]
            rssi = gw.get("rssi")
            snr = gw.get("snr")
            if rssi is not None:
                parts.append(f"RSSI: {rssi}")
            if snr is not None:
                parts.append(f"SNR: {snr}")
            lines.append(" | ".join(parts))

    return "\n".join(lines)
