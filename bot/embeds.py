"""
Rich Discord embed builders for Meshtastic mesh messages.

Inspired by RATM 2.0's presentation layer — gateway grouping by hop count,
SNR/RSSI display, and static map thumbnails for position packets.
"""

import datetime
import logging
import math
from typing import Optional

import discord

import utils

logger = logging.getLogger(__name__)

# Discord embed limits. TOTAL applies to one embed AND to the sum of all
# embeds in one message; a message carries at most MESSAGE_EMBED_LIMIT embeds.
EMBED_TOTAL_LIMIT = 6000
EMBED_DESC_LIMIT = 4096
EMBED_FIELD_VALUE_LIMIT = 1024
EMBED_AUTHOR_LIMIT = 256
MESSAGE_EMBED_LIMIT = 10
_TRUNCATED_NOTE = " — list truncated; full receptions via the packet link above"


def _author_name(display_name: str, short_name: str) -> str:
    """'display [short]' clamped to the embed author limit, keeping the suffix."""
    suffix = f" [{short_name}]"
    if len(display_name) + len(suffix) <= EMBED_AUTHOR_LIMIT:
        return f"{display_name}{suffix}"
    return display_name[: EMBED_AUTHOR_LIMIT - len(suffix) - 1] + "…" + suffix


def _packet_timestamp(*epochs) -> datetime.datetime:
    """Embed timestamp from the packet's own clock — stable across edits
    (utcnow would shift the displayed time every straggler edit)."""
    for e in epochs:
        try:
            if e:
                return datetime.datetime.fromtimestamp(int(e), datetime.timezone.utc)
        except (TypeError, ValueError, OverflowError, OSError):
            continue
    return discord.utils.utcnow()


def _safe_truncate(text: str, limit: int = EMBED_FIELD_VALUE_LIMIT) -> str:
    """Truncate text at the last complete line within the limit.

    Avoids cutting markdown links in half which leaves broken URLs visible.
    """
    if len(text) <= limit:
        return text
    # Find the last newline within the limit
    truncated = text[: limit - 3]
    last_newline = truncated.rfind("\n")
    if last_newline > 0:
        return truncated[:last_newline] + "\n..."
    return truncated + "..."

def _map_thumbnail_url(lat: float, lon: float, base_url: str, maps_cfg: dict) -> str | None:
    """Build a self-hosted static map thumbnail URL.

    Points to the MeshInfo /v1/static-map endpoint, which renders tiles
    from OSM or Mapbox server-side. Returns None if provider is "none".
    """
    provider = maps_cfg.get("provider", "none")
    if provider == "none" or not base_url:
        return None

    return f"{base_url.rstrip('/')}/v1/static-map?lat={lat:.6f}&lon={lon:.6f}&zoom=12&width=400&height=300"


def _map_link_url(base_url: str, node_id: str) -> str | None:
    """Build a clickable link to the node on the MeshInfo map page."""
    if not base_url:
        return None
    return f"{base_url.rstrip('/')}/map?node={node_id}"


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
        # If longname contains a URL, use shortname as link text instead
        # URLs inside markdown link text break Discord rendering
        if "http://" in name or "https://" in name:
            short = _node_short_name(node, node_id)
            return f"[{short}]({url})"
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
        hop_str = "Direct" if hops_away == 0 else f"{hops_away} hops"
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


def _snr_color(gateway_entries: Optional[list], msg: dict) -> discord.Color:
    """Return a soft embed color based on best gateway SNR."""
    best_snr = None

    if gateway_entries:
        for gw in gateway_entries:
            snr = gw.get("snr")
            if snr is not None:
                if best_snr is None or snr > best_snr:
                    best_snr = snr
    else:
        snr = msg.get("snr")
        if snr is not None:
            best_snr = snr

    if best_snr is None:
        return discord.Color.from_rgb(134, 148, 159)  # soft grey — no data

    if best_snr > 10:
        return discord.Color.from_rgb(87, 187, 138)    # soft green — excellent
    if best_snr > 5:
        return discord.Color.from_rgb(69, 179, 186)    # teal — good
    if best_snr > 0:
        return discord.Color.from_rgb(219, 196, 104)   # soft yellow — fair
    if best_snr > -5:
        return discord.Color.from_rgb(217, 158, 87)    # soft orange — weak
    return discord.Color.from_rgb(194, 108, 108)       # muted red — poor


def resolve_channel_name(channel_hash: str, config: dict) -> str:
    """Resolve a channel hash to its meta label, else "Channel <hash>".
    `or`, not .get(default): an empty label must fall through."""
    meta = config.get("broker", {}).get("channels", {}).get("meta", {})
    channel_meta = meta.get(channel_hash) or {}
    return channel_meta.get("label") or f"Channel {channel_hash}"


# Back-compat alias for any external callers of the old private name.
_resolve_channel_name = resolve_channel_name


def build_text_embed(
    msg: dict,
    chat: dict,
    nodes: dict,
    base_url: str,
    config: dict,
    owner_id: Optional[str] = None,
    gateway_entries: Optional[list] = None,
) -> tuple[discord.Embed, bool]:
    """
    Build a rich embed for a text message from the mesh.

    Returns (embed, was_truncated) — was_truncated indicates if gateway
    data was cut short and a "View All Gateways" button should be shown.
    """
    from_id = chat.get("from", msg.get("from", "unknown"))
    node = nodes.get(from_id)
    display_name = _node_display_name(node, from_id)
    short_name = _node_short_name(node, from_id)
    text = chat.get("text", "")

    # Build embed — everything in description for consistent top-to-bottom layout
    node_link = _node_url(base_url, from_id)

    desc_parts = []

    # Message text
    if text:
        desc_parts.append(text)

    # Packet info header — two lines for clean layout
    packet_id = msg.get("id")
    label_line = []
    value_line = []

    if packet_id:
        logs_url = f"{base_url.rstrip('/')}/logs?q={packet_id}" if base_url else None
        pid_display = f"[{packet_id}]({logs_url})" if logs_url else str(packet_id)
        label_line.append("**Packet**")
        value_line.append(pid_display)

    if gateway_entries and len(gateway_entries) > 0:
        hop_limit = msg.get("hop_start") or msg.get("hop_limit")
        if hop_limit is not None:
            label_line.append("**Hop Limit**")
            value_line.append(str(hop_limit))
        label_line.append("**Gateways**")
        value_line.append(str(len(gateway_entries)))

    if label_line:
        # Two-line header with tab-like spacing
        sep = "\u2003\u2003\u2003"  # 3 em spaces between columns
        top = sep.join(label_line)
        # Right-pad values with figure spaces to align columns
        pad_char = "\u2007"  # figure space — same width as a digit
        padded = []
        for label, value in zip(label_line, value_line):
            clean = label.replace("**", "")
            # Pad to match label width, shifted left
            padded_value = value + pad_char * max(0, len(clean) - len(value) - 2)
            padded.append(padded_value)
        bottom = sep.join(padded)
        desc_parts.append(f"{top}\n{bottom}")

    # Gateway info
    if gateway_entries and len(gateway_entries) > 0:
        gw_text = _format_gateway_list(gateway_entries, nodes, base_url)
        if gw_text:
            desc_parts.append(gw_text)
    else:
        gw_info = _format_gateway_info(msg, nodes, base_url)
        if gw_info:
            desc_parts.append(gw_info)

    description = "\n\n".join(desc_parts)
    was_truncated = len(description) > EMBED_DESC_LIMIT
    if was_truncated:
        description = _safe_truncate(description, EMBED_DESC_LIMIT)

    embed = discord.Embed(
        description=description,
        color=_snr_color(gateway_entries, msg),
        timestamp=_packet_timestamp(chat.get("timestamp"), msg.get("timestamp")),
    )

    # Author = sender node (linked to node page)
    avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={from_id}"
    embed.set_author(name=_author_name(display_name, short_name), url=node_link, icon_url=avatar_url)

    # Owner mention
    if owner_id:
        embed.add_field(name="Owner", value=f"<@{owner_id}>", inline=True)

    embed.set_footer(text=f"Node: !{from_id}")

    return embed, was_truncated


def _split_oversized(sections: list) -> list:
    """Split any section past the description limit on line boundaries, so the
    chunking loop (which owns the truncation decision) sees fitting pieces."""
    out = []
    for section in sections:
        if len(section) <= EMBED_DESC_LIMIT:
            out.append(section)
            continue
        piece = ""
        for line in section.split("\n"):
            line = line if len(line) <= EMBED_DESC_LIMIT else _safe_truncate(line, EMBED_DESC_LIMIT)
            joined = f"{piece}\n{line}" if piece else line
            if len(joined) <= EMBED_DESC_LIMIT:
                piece = joined
            else:
                out.append(piece)
                piece = line
        if piece:
            out.append(piece)
    return out


def build_gateway_detail_embed(
    msg: dict,
    nodes: dict,
    base_url: str,
    gateway_entries: list,
) -> list[discord.Embed]:
    """
    Build one or more embeds showing the full gateway breakdown for a packet.

    Used when a user clicks the "View Gateways" button. Returns a list of
    embeds to handle very large gateway lists that exceed a single embed.
    """
    from_id = msg.get("from", "unknown")
    packet_id = msg.get("id", "?")
    hop_limit = msg.get("hop_start") or msg.get("hop_limit")

    gw_text = _format_gateway_list(gateway_entries, nodes, base_url)
    if not gw_text:
        return []

    logs_url = f"{base_url.rstrip('/')}/logs?q={packet_id}" if base_url else None
    pid_display = f"[{packet_id}]({logs_url})" if logs_url else str(packet_id)
    header = f"**Packet** {pid_display} \u2014 **{len(gateway_entries)}** gateways"
    if hop_limit is not None:
        header += f" \u2014 hop limit {hop_limit}"

    # Split into description-sized chunks; one message holds at most
    # MESSAGE_EMBED_LIMIT embeds and EMBED_TOTAL_LIMIT chars across them all.
    footer = f"Node: !{from_id}"
    budget = EMBED_TOTAL_LIMIT - len(footer) - len(_TRUNCATED_NOTE)
    chunks: list[str] = []
    truncated = False
    current = header
    for section in _split_oversized(gw_text.split("\n\n")):
        joined = f"{current}\n\n{section}" if current else section
        if len(joined) <= EMBED_DESC_LIMIT:
            current = joined
        else:
            chunks.append(current)
            current = section
    if current:
        chunks.append(current)

    embeds = []
    used = 0
    for i, chunk in enumerate(chunks):
        if len(embeds) >= MESSAGE_EMBED_LIMIT or used + len(chunk) > budget:
            truncated = True
            room = budget - used
            if len(embeds) < MESSAGE_EMBED_LIMIT and room >= 64:
                partial = _safe_truncate(chunk, room)
                embeds.append(discord.Embed(
                    description=partial,
                    color=discord.Color.from_rgb(69, 179, 186),
                ))
            break
        embeds.append(discord.Embed(
            description=chunk,
            color=discord.Color.from_rgb(69, 179, 186),
        ))
        used += len(chunk)

    if embeds:
        embeds[-1].set_footer(text=(footer + _TRUNCATED_NOTE) if truncated else footer)

    return embeds


def build_position_embed(
    msg: dict,
    node_id: str,
    nodes: dict,
    base_url: str,
    config: dict,
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
    map_link = _map_link_url(base_url, node_id)
    node_link = _node_url(base_url, node_id)
    embed = discord.Embed(
        title=f"{label} Position Update",
        url=map_link or node_link,
        color=discord.Color.orange() if track_type == "balloon" else discord.Color.blue(),
        timestamp=_packet_timestamp(msg.get("timestamp")),
    )

    avatar_url = f"https://api.dicebear.com/9.x/bottts-neutral/png?seed={node_id}"
    embed.set_author(name=_author_name(display_name, short_name), url=node_link, icon_url=avatar_url)

    # Position fields
    lat_i = payload.get("latitude_i")
    lon_i = payload.get("longitude_i")
    alt = payload.get("altitude")

    maps_cfg = config.get("integrations", {}).get("discord", {}).get("bridge", {}).get("maps", {})

    if lat_i is not None and lon_i is not None:
        lat = lat_i / 1e7
        lon = lon_i / 1e7

        # Clickable coordinates linking to MeshInfo map
        coord_text = f"[{lat:.6f}, {lon:.6f}]({map_link})" if map_link else f"{lat:.6f}, {lon:.6f}"
        embed.add_field(name="Position", value=coord_text, inline=True)
        # Numeric only — payload junk (strings, bools, NaN) must not render.
        if isinstance(alt, (int, float)) and not isinstance(alt, bool) and math.isfinite(alt):
            embed.add_field(name="Altitude", value=f"{alt:.0f}m", inline=True)

        # Static map thumbnail (self-hosted, provider from config)
        thumbnail_url = _map_thumbnail_url(lat, lon, base_url, maps_cfg)
        if thumbnail_url:
            embed.set_image(url=thumbnail_url)

    # Gateway info with linked names
    if gateway_entries and len(gateway_entries) > 0:
        gw_text = _format_gateway_list(gateway_entries, nodes, base_url)
        if gw_text:
            gw_text = _safe_truncate(gw_text)
            embed.add_field(name="Gateways", value=gw_text, inline=False)
    else:
        gw_info = _format_gateway_info(msg, nodes, base_url)
        if gw_info:
            gw_info = _safe_truncate(gw_info)
            embed.add_field(name="Reception", value=gw_info, inline=False)

    if owner_id:
        embed.add_field(name="Owner", value=f"<@{owner_id}>", inline=True)

    embed.set_footer(text=f"Node: !{node_id}")

    return embed


def _node_short_linked_name(node: Optional[dict], node_id: str, base_url: str) -> str:
    """Return a markdown-linked short name for compact gateway display."""
    short = _node_short_name(node, node_id)
    url = _node_url(base_url, node_id)
    if url:
        return f"[{short}]({url})"
    return short


def _format_gateway_list(gateway_entries: list, nodes: dict, base_url: str) -> str:
    """
    Format a list of gateway reception reports grouped by hop count.

    Single gateway per hop group: full name with RSSI/SNR details.
    Multiple gateways per hop group: compact shortnames separated by |.
    Hop groups are separated by blank lines for readability.
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

    sections = []
    for hops in sorted(by_hops.keys()):
        lines = []
        if hops == 0:
            header = "**Direct**"
        else:
            header = f"**{hops} hops**"
        lines.append(header)

        gateways = by_hops[hops]
        if len(gateways) == 1:
            # Single gateway — show full details with SNR/RSSI
            gw = gateways[0]
            gw_id = gw.get("gateway_id", "unknown")
            gw_node = nodes.get(gw_id)
            gw_name = _node_linked_name(gw_node, gw_id, base_url)
            parts = [gw_name]
            rssi = gw.get("rssi")
            snr = gw.get("snr")
            if rssi is not None:
                parts.append(f"RSSI: {rssi}")
            if snr is not None:
                parts.append(f"SNR: {snr}")
            lines.append(" | ".join(parts))
        else:
            # Multiple gateways — compact shortnames
            names = []
            for gw in gateways:
                gw_id = gw.get("gateway_id", "unknown")
                gw_node = nodes.get(gw_id)
                names.append(_node_short_linked_name(gw_node, gw_id, base_url))
            for i in range(0, len(names), 10):
                chunk = names[i:i + 10]
                lines.append(" | ".join(chunk))

        sections.append("\n".join(lines))

    return "\n\n".join(sections)
