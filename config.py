"""
Config loading, validation, and defaults for MeshInfo.

- Validates all config fields at startup
- Provides sensible defaults for optional fields
- Logs warnings for missing or invalid values
- Fails fast (with clear error messages) only for truly required fields
- Requires PostgreSQL
"""

import datetime
import json
import logging
import os
import tomllib
import uuid
from copy import deepcopy
from typing import Any

from utils import normalize_node_id

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default configuration
# ---------------------------------------------------------------------------
# Every key that MeshInfo might read should appear here.  When a user's
# config.toml is loaded, it is deep-merged on top of these defaults so that
# any missing keys automatically get a safe value.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "mesh": {
        "name": "My Mesh Network",
        "shortname": "MESH",
        "description": "",
        "url": "",
        "contact": "",
        "country": "US",
        "region": "",
        "metro": "",
        "latitude": 0.0,
        "longitude": 0.0,
        "zoom": 10,
        "altitude": 0,
        "timezone": "UTC",
        "announce": {
            "enabled": False,
            "interval": 60,
        },
        "tools": [],
        "elsewhere_links": [],
    },
    "broker": {
        "enabled": True,
        "host": "mqtt.meshtastic.org",
        "port": 1883,
        "username": "meshdev",
        "password": "large4cats",
        "client_id_prefix": "meshinfo",
        "topics": [],
        "topic_tags": [],
        "decoders": {
            "protobuf": {"enabled": True},
            "json": {"enabled": True},
        },
        "channels": {
            "encryption": [],
            # Display only — ingest stores every channel. `meta` applies in all modes.
            # presets = stock preset channels | all = + named | manual = display/views lists
            "mode": "presets",
            # mode = "manual" only. Ids are (name, PSK) hashes — no default fits every mesh.
            "display": [],
            "meta": {},
            "views": [],
        },
    },
    "server": {
        "node_id": "",
        "base_url": "",
        "log_level": "INFO",
        "node_activity_prune_threshold": 259200,
        "timezone": "UTC",
        "intervals": {
            "data_save": 300,  # seconds between graph rebuilds
        },
        "enrich": {
            "enabled": False,
            "interval": 900,
            # Meshview bulk dicts or MeshInfo URL templates; see config.toml.sample.
            "providers": [],
        },
        "graph": {
            "enabled": True,
            "max_depth": 10,
        },
    },
    "integrations": {
        "discord": {
            "enabled": False,
            "token": "",
            "guild": "",
            "bridge": {
                "enabled": False,
                "aggregate_seconds": 5,
                "channels": {},
                "position_channels": {},
                "maps": {
                    "provider": "none",
                    "mapbox": {
                        "access_token": "",
                        "style": "mapbox/dark-v11",
                    },
                },
            },
        },
        "geocoding": {
            "enabled": False,
            "provider": "geocode.maps.co",
            "geocode.maps.co": {
                "api_key": "",
            },
        },
    },
    # Daily-snapshot backups. The app schedules these itself (maintenance loop,
    # applied on startup — no host cron needed); scripts/backup_db.sh reads the
    # same section for manual/host-cron runs.
    "backups": {
        # off | daily | weekly | monthly — how often the app takes a pg_dump.
        "schedule": "daily",
        "keep_days": 4,
        # Relative paths resolve against the repo root (mounted at /app in Docker).
        "dir": "backups",
        # Optional rsync destination for off-box copies, e.g. "user@host:/backups/meshinfo".
        # Honored by scripts/backup_db.sh (host-side, where SSH keys live).
        "remote_target": "",
    },
    "storage": {
        # Uplink dedup (#526): store one canonical mqtt_messages row per mesh
        # packet and every per-gateway copy as a packet_receptions row (lossless).
        # Disable to restore the legacy one-row-per-copy firehose.
        "dedup_uplinks": True,
        # How long copies of one (from, packet id) keep merging into the same
        # canonical row; also bounds the restart-recovery DB lookup.
        "dedup_window_seconds": 900,
        # Packets without a packet id (MapReport) dedup by content inside this
        # shorter window — real re-publications are minutes apart.
        "content_dedup_window_seconds": 120,
        # Per-node flood guard: at most this many new archive rows per
        # originating node per minute / per hour (dedup'd copies don't count;
        # needs dedup_uplinks). 0 disables a tier.
        "max_packets_per_node_per_minute": 60,
        "max_packets_per_node_per_hour": 600,
        # Node ids (hex) whose packets — as origin or uplinking gateway — are
        # dropped at the decoder entirely.
        "ingest_denylist": [],
        "postgres": {
            "enabled": False,
            "host": "postgres",
            "port": 5432,
            "database": "meshinfo",
            "username": "postgres",
            "password": "password",
            "min_pool_size": 1,
            "max_pool_size": 5,
        },
    },
    # Per-pixel land-cover clutter for coverage / scan (see RF-MODEL.md).
    # Tiles are pre-baked via scripts/landcover_tiles.py; absent tile_dir → frontend
    # falls back to a default class everywhere.
    "landcover": {
        "enabled": True,
        "tile_dir": "output/landcover",
        "source": "USGS NLCD 2024",
    },
    # Per-pixel measured canopy heights for the P.833 vegetation loss loop.
    # Tiles are pre-baked via scripts/canopy_tiles.py; absent tile_dir → frontend
    # falls back to class-nominal heights.
    "canopy": {
        "enabled": True,
        "tile_dir": "output/canopy",
        "source": "ETH Global Canopy Height 2020",
    },
    # Per-pixel measured building heights for P.452 endpoint clutter and the
    # ITM DSM. Tiles are pre-baked via scripts/building_tiles.py; absent
    # tile_dir → frontend falls back to class-nominal heights.
    "buildings": {
        "enabled": True,
        "tile_dir": "output/buildings",
        "source": "JRC GHS-BUILT-H R2023A",
    },
    # Live network-coverage tiles, baked by the coverage-worker into tile_dir and
    # served at /tiles/coverage. Off by default (needs the coverage-worker container).
    "coverage": {
        "enabled": False,
        "tile_dir": "output/coverage",
        "lookup_url": "http://coverage-worker:9301",
    },
    "debug": False,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _deep_merge(defaults: dict, overrides: dict) -> dict:
    """
    Recursively merge *overrides* on top of *defaults*.

    - If both sides have a dict for the same key, recurse.
    - Otherwise the override wins.
    - Keys in defaults that are absent from overrides are kept.
    """
    result = deepcopy(defaults)
    for key, value in overrides.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def _get_nested(d: dict, *keys: str, default: Any = None) -> Any:
    """Safely traverse nested dicts: _get_nested(cfg, 'broker', 'host')."""
    current = d
    for k in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(k, default)
    return current


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class ConfigValidationError(Exception):
    """Raised when a *required* config value is missing or fatally invalid."""
    pass


def _validate_type(
    config: dict,
    path: str,
    expected_type: type | tuple[type, ...],
    *,
    required: bool = False,
) -> str | None:
    """
    Check that the value at *path* (dot-separated) is the expected type.
    Returns a warning message string if invalid, None if valid.
    If *required* is True, raises ConfigValidationError instead.
    """
    keys = path.split(".")
    value = _get_nested(config, *keys)

    if value is None and not required:
        return None  # missing optional field is fine (defaults already merged)

    if value is None and required:
        raise ConfigValidationError(f"Required config field '{path}' is missing")

    if not isinstance(value, expected_type):
        if isinstance(expected_type, tuple):
            type_name = " or ".join(t.__name__ for t in expected_type)
        else:
            type_name = expected_type.__name__
        msg = (
            f"Config field '{path}' expected {type_name}, "
            f"got {type(value).__name__} ({value!r})"
        )
        if required:
            raise ConfigValidationError(msg)
        return msg

    return None


def _validate_one_of(
    config: dict,
    path: str,
    allowed: list[Any],
    *,
    required: bool = False,
) -> str | None:
    """Check that the value at *path* is one of the *allowed* values.
    Returns a warning message string if invalid, None if valid."""
    keys = path.split(".")
    value = _get_nested(config, *keys)

    if value is None:
        if required:
            raise ConfigValidationError(f"Required config field '{path}' is missing")
        return None

    if value not in allowed:
        msg = f"Config field '{path}' has invalid value {value!r}; expected one of {allowed}"
        if required:
            raise ConfigValidationError(msg)
        return msg

    return None


def _validate_port(config: dict, path: str) -> str | None:
    """Validate that a port number is in the valid range.
    Returns a warning message string if invalid, None if valid."""
    keys = path.split(".")
    value = _get_nested(config, *keys)
    if value is not None and (not isinstance(value, int) or value < 1 or value > 65535):
        return f"Config field '{path}' has invalid port {value!r}; expected 1-65535"
    return None


def _validate_positive_number(config: dict, path: str) -> str | None:
    """Validate that a number is positive.
    Returns a warning message string if invalid, None if valid."""
    keys = path.split(".")
    value = _get_nested(config, *keys)
    if value is not None and (not isinstance(value, (int, float)) or value <= 0):
        return f"Config field '{path}' must be a positive number, got {value!r}"
    return None


def _warn_placeholder(config: dict, path: str, placeholders: list[str]) -> str | None:
    """Warn if a field still has a placeholder value from the sample config.
    Returns a warning message string if placeholder found, None otherwise."""
    keys = path.split(".")
    value = _get_nested(config, *keys)
    if value and isinstance(value, str) and any(p in value for p in placeholders):
        return (
            f"Config field '{path}' appears to still have a placeholder value: {value!r}. "
            f"Please update it with your actual value."
        )
    return None


def _warn_stale_channel_lists(user_config: dict) -> None:
    """Warn pre-`mode` configs whose display/views lists would silently stop applying.
    An explicit mode alongside the lists is deliberate — stay quiet then."""
    try:
        uc = user_config.get("broker", {}).get("channels", {})
    except AttributeError:
        return
    if not isinstance(uc, dict) or "mode" in uc:
        return
    if uc.get("display") or uc.get("views"):
        logger.warning(
            "broker.channels display/views are configured but broker.channels.mode "
            'is not set; they are now only honored when mode = "manual". The Chat '
            'page currently shows automatic preset pills instead. Set mode = '
            '"manual" to keep your curated tabs, or delete the lists.'
        )


def validate(config: dict) -> list[str]:
    """
    Validate the merged config and return a list of warning messages.

    Raises ConfigValidationError only for truly fatal problems.
    Everything else is logged as a warning and collected in the return list.
    """
    warnings: list[str] = []

    def warn(msg: str) -> None:
        logger.warning(msg)
        warnings.append(msg)

    def check(result: str | None) -> None:
        """If a validator returned a warning message, collect it."""
        if result is not None:
            warn(result)

    # ── mesh section ──────────────────────────────────────────────────
    _validate_type(config, "mesh", dict, required=True)
    check(_validate_type(config, "mesh.name", str))
    check(_validate_type(config, "mesh.shortname", str))
    check(_validate_type(config, "mesh.latitude", (int, float)))
    check(_validate_type(config, "mesh.longitude", (int, float)))
    check(_validate_type(config, "mesh.timezone", str))
    check(_validate_type(config, "mesh.announce", dict))
    check(_validate_type(config, "mesh.announce.enabled", bool))
    check(_validate_positive_number(config, "mesh.announce.interval"))
    check(_validate_type(config, "mesh.tools", list))
    check(_validate_type(config, "mesh.elsewhere_links", list))
    elsewhere_links = _get_nested(config, "mesh", "elsewhere_links") or []
    if isinstance(elsewhere_links, list):
        for i, item in enumerate(elsewhere_links):
            if not isinstance(item, dict):
                warn(f"Config field 'mesh.elsewhere_links[{i}]' must be a dict, got {type(item).__name__}")
            else:
                for key in ("name", "url"):
                    if key not in item:
                        warn(f"Config field 'mesh.elsewhere_links[{i}]' is missing required key '{key}'")
                    elif not isinstance(item[key], str):
                        warn(f"Config field 'mesh.elsewhere_links[{i}].{key}' must be a str, got {type(item[key]).__name__}")

    # ── broker section ────────────────────────────────────────────────
    _validate_type(config, "broker", dict, required=True)
    check(_validate_type(config, "broker.enabled", bool))
    check(_validate_type(config, "broker.host", str))
    check(_validate_port(config, "broker.port"))
    check(_validate_type(config, "broker.client_id_prefix", str))
    check(_validate_type(config, "broker.topics", list))

    if config.get("broker", {}).get("enabled") and not config.get("broker", {}).get("topics"):
        warn("MQTT broker is enabled but no topics are configured. No messages will be received.")

    if config.get("broker", {}).get("enabled") and not config.get("broker", {}).get("host"):
        warn("MQTT broker is enabled but no host is configured.")

    check(_validate_type(config, "broker.decoders", dict))
    check(_validate_type(config, "broker.channels", dict))

    # A wrong-shaped broker.channels already warned above; don't crash the deeper checks.
    channels = config.get("broker", {}).get("channels", {})
    if isinstance(channels, dict):
        check(_validate_type(config, "broker.channels.display", list))
        check(_validate_type(config, "broker.channels.views", list))
        # A single-bracket typo ([...] not [[...]]) makes this a dict —
        # decryption then silently finds no keys.
        check(_validate_type(config, "broker.channels.encryption", list))
        check(
            _validate_one_of(
                config, "broker.channels.mode", ["presets", "all", "manual"]
            )
        )
        # Pre-release key names a stale working copy might still carry.
        for old_key in ("show", "custom_views"):
            if old_key in channels:
                warn(
                    f"broker.channels.{old_key} is not a setting; use "
                    f'broker.channels.mode = "presets" | "all" | "manual".'
                )
        if isinstance(channels.get("display"), list) and not all(
            isinstance(x, str) for x in channels["display"]
        ):
            warn(
                "broker.channels.display should hold quoted strings "
                '(e.g. ["8", "31"]); unquoted numbers never match a channel id.'
            )

    # ── server section ────────────────────────────────────────────────
    _validate_type(config, "server", dict, required=True)
    check(_validate_type(config, "server.node_id", str))
    check(_validate_one_of(config, "server.log_level", ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]))
    _validate_type(config, "server.timezone", str, required=True)
    check(_validate_positive_number(config, "server.node_activity_prune_threshold"))
    check(_validate_type(config, "server.intervals", dict))
    check(_validate_positive_number(config, "server.intervals.data_save"))
    check(_validate_type(config, "server.enrich", dict))
    check(_validate_type(config, "server.enrich.enabled", bool))
    check(_validate_positive_number(config, "server.enrich.interval"))
    # Accept either the new 'providers' list or the legacy 'provider' string.
    # Runtime resolver picks providers when present; legacy string is back-compat only.
    enrich_cfg = config.get("server", {}).get("enrich", {}) or {}
    if "providers" in enrich_cfg:
        check(_validate_type(config, "server.enrich.providers", list))
    if "provider" in enrich_cfg:
        check(_validate_type(config, "server.enrich.provider", str))
    check(_validate_type(config, "server.graph", dict))
    check(_validate_type(config, "server.graph.enabled", bool))
    check(_validate_positive_number(config, "server.graph.max_depth"))

    check(_warn_placeholder(config, "server.base_url", ["REPLACE_WITH"]))

    if not config.get("server", {}).get("node_id"):
        warn("Config field 'server.node_id' is empty. Some features may not work correctly.")

    # ── integrations section ──────────────────────────────────────────
    check(_validate_type(config, "integrations", dict))
    check(_validate_type(config, "integrations.discord", dict))
    check(_validate_type(config, "integrations.discord.enabled", bool))

    discord_cfg = _get_nested(config, "integrations", "discord") or {}
    if discord_cfg.get("enabled"):
        token = discord_cfg.get("token") or ""
        if not token or "REPLACE_WITH" in str(token):
            warn("Discord is enabled but token is missing or still a placeholder.")
        guild = discord_cfg.get("guild") or ""
        if not guild or "REPLACE_WITH" in str(guild):
            warn("Discord is enabled but guild ID is missing or still a placeholder.")

        bridge_cfg = discord_cfg.get("bridge", {})
        if bridge_cfg.get("enabled"):
            check(_validate_type(config, "integrations.discord.bridge.aggregate_seconds", (int, float)))
            check(_validate_type(config, "integrations.discord.bridge.channels", dict))
            check(_validate_type(config, "integrations.discord.bridge.position_channels", dict))
            if not bridge_cfg.get("channels"):
                warn("Discord bridge is enabled but no channel mappings are configured. No messages will be forwarded.")

            maps_cfg = bridge_cfg.get("maps", {})
            maps_provider = maps_cfg.get("provider", "none")
            check(_validate_one_of(config, "integrations.discord.bridge.maps.provider", ["none", "osm", "mapbox"]))
            if maps_provider == "mapbox":
                mapbox_token = maps_cfg.get("mapbox", {}).get("access_token", "")
                if not mapbox_token or "REPLACE_WITH" in str(mapbox_token):
                    warn(
                        "Discord bridge maps provider is 'mapbox' but no access token is configured. "
                        "Position embeds will not include map thumbnails. "
                        "Set access_token under [integrations.discord.bridge.maps.mapbox] in your config.toml."
                    )

    check(_validate_type(config, "integrations.geocoding", dict))
    geocoding_cfg = _get_nested(config, "integrations", "geocoding") or {}
    if geocoding_cfg.get("enabled"):
        provider = geocoding_cfg.get("provider", "")
        provider_cfg = geocoding_cfg.get(provider, {})
        api_key = provider_cfg.get("api_key") or ""
        if not api_key or "REPLACE_WITH" in str(api_key):
            warn(f"Geocoding is enabled (provider: {provider}) but API key is missing or still a placeholder.")

    # ── storage section ───────────────────────────────────────────────
    check(_validate_type(config, "storage", dict))

    storage_cfg = config.get("storage", {})

    # ── PostgreSQL required ────────────────────────────────────────────
    pg_cfg = storage_cfg.get("postgres", {})
    if not pg_cfg.get("enabled"):
        raise ConfigValidationError(
            "PostgreSQL is required but not enabled in your config.\n"
            "\n"
            "Set enabled = true under [storage.postgres] in your config.toml:\n"
            "\n"
            "  [storage.postgres]\n"
            "  enabled = true\n"
            '  host = "postgres"\n'
            "  port = 5432\n"
            '  database = "meshinfo"\n'
            '  username = "postgres"\n'
            '  password = "your_password"\n'
            "\n"
            "See config.toml.sample for the full example configuration.\n"
        )

    # ── Postgres config validation ────────────────────────────────────
    check(_validate_type(config, "storage.postgres.host", str))
    check(_validate_port(config, "storage.postgres.port"))
    check(_validate_type(config, "storage.postgres.database", str))
    check(_validate_positive_number(config, "storage.postgres.min_pool_size"))
    check(_validate_positive_number(config, "storage.postgres.max_pool_size"))

    min_pool = pg_cfg.get("min_pool_size", 1)
    max_pool = pg_cfg.get("max_pool_size", 5)
    if isinstance(min_pool, int) and isinstance(max_pool, int) and min_pool > max_pool:
        warn(
            f"Postgres min_pool_size ({min_pool}) is greater than max_pool_size ({max_pool}). "
            "This will likely cause connection errors."
        )

    # ── uplink dedup (#526) ───────────────────────────────────────────
    check(_validate_type(config, "storage.dedup_uplinks", bool))
    check(_validate_positive_number(config, "storage.dedup_window_seconds"))

    # ── per-node flood guard ──────────────────────────────────────────
    check(_validate_positive_number(config, "storage.content_dedup_window_seconds"))
    for tier in ("max_packets_per_node_per_minute", "max_packets_per_node_per_hour"):
        rate = storage_cfg.get(tier)
        if rate is not None and (isinstance(rate, bool) or not isinstance(rate, int) or rate < 0):
            warn(f"Config field 'storage.{tier}' must be an integer >= 0 (0 disables), got {rate!r}")
    if storage_cfg.get("dedup_uplinks") is False and (
        storage_cfg.get("max_packets_per_node_per_minute", 60) or storage_cfg.get("max_packets_per_node_per_hour", 600)
    ):
        warn("storage.dedup_uplinks = false: content dedup for id-less packets is off and the "
             "per-node flood guard (max_packets_per_node_*) is disabled — without dedup every "
             "uplink copy is a row and the caps would clip busy nodes. Enable dedup_uplinks, "
             "or set both caps to 0 to silence this and rely on ingest_denylist.")
    denylist = storage_cfg.get("ingest_denylist")
    if denylist is not None:
        if not isinstance(denylist, list) or not all(isinstance(n, str) for n in denylist):
            warn(f"Config field 'storage.ingest_denylist' must be a list of node id strings, got {denylist!r}")
        else:
            for n in denylist:
                if normalize_node_id(n) is None:
                    warn(f"Config field 'storage.ingest_denylist' has an invalid node id {n!r} (expected hex like \"eba3d8e8\")")

    # ── backups ───────────────────────────────────────────────────────
    check(_validate_one_of(config, "backups.schedule", ["off", "daily", "weekly", "monthly"]))
    check(_validate_positive_number(config, "backups.keep_days"))
    check(_validate_type(config, "backups.dir", str))
    check(_validate_type(config, "backups.remote_target", str))

    # ── debug ─────────────────────────────────────────────────────────
    check(_validate_type(config, "debug", bool))

    # ── summary ───────────────────────────────────────────────────────
    if warnings:
        logger.warning("Config validation completed with %d warning(s)", len(warnings))
    else:
        logger.info("Config validation passed with no warnings")

    return warnings


# ---------------------------------------------------------------------------
# Config class
# ---------------------------------------------------------------------------

class Config:
    @classmethod
    def load(cls) -> dict:
        """
        Load config.toml, merge with defaults, validate, and return the final config dict.
        """
        if os.path.isfile("config.toml"):
            user_config = cls._load_toml("config.toml")
        else:
            raise ConfigValidationError(
                "No config file found. "
                "Copy config.toml.sample to config.toml and edit it for your deployment."
            )

        _warn_stale_channel_lists(user_config)

        # Merge: defaults first, user overrides on top
        config = _deep_merge(DEFAULT_CONFIG, user_config)

        # Validate (logs warnings, raises on fatal errors)
        validate(config)

        # Runtime-generated values
        random_uuid = str(uuid.uuid4())
        client_id_prefix = config["broker"].get("client_id_prefix", "meshinfo")
        config["broker"]["client_id"] = f"{client_id_prefix}-{random_uuid}"
        config["server"]["start_time"] = datetime.datetime.now(
            datetime.timezone.utc
        ).astimezone()

        # Version info (optional, best-effort)
        try:
            version_info = cls._load_json("version-info.json")
            if version_info is not None:
                config["server"]["version_info"] = version_info
        except (ConfigValidationError, FileNotFoundError, json.JSONDecodeError):
            pass

        logger.info(
            "Config loaded: mesh=%r, broker_enabled=%s",
            config["mesh"]["name"],
            config["broker"]["enabled"],
        )

        return config

    @classmethod
    def _load_toml(cls, path: str) -> dict:
        """Load and parse a TOML file, with a clear error on failure."""
        try:
            with open(path, "rb") as f:
                return tomllib.load(f)
        except FileNotFoundError:
            raise ConfigValidationError(
                f"Config file '{path}' not found. "
                f"Copy config.toml.sample to config.toml and edit it for your deployment."
            )
        except tomllib.TOMLDecodeError as e:
            raise ConfigValidationError(
                f"Config file '{path}' contains invalid TOML: {e}"
            )

    @classmethod
    def _load_json(cls, path: str) -> dict:
        """Load and parse a JSON file."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            raise ConfigValidationError(
                f"Config file '{path}' not found."
            )
        except json.JSONDecodeError as e:
            raise ConfigValidationError(
                f"Config file '{path}' contains invalid JSON: {e}"
            )

    @classmethod
    def load_from_file(cls, path: str) -> dict:
        """Load a config file by extension (TOML or JSON)."""
        from pathlib import Path
        if Path(path).suffix == ".toml":
            return cls._load_toml(path)
        return cls._load_json(path)

    @classmethod
    def cleanse(cls, config: dict) -> dict:
        """Return a copy of config with sensitive fields removed."""
        config_clean = deepcopy(config)

        # Paths to sensitive fields that should be redacted
        sensitive_paths = [
            ("broker", "password"),
            ("broker", "username"),
            ("integrations", "discord", "token"),
            ("integrations", "discord", "bridge", "maps", "mapbox", "access_token"),
            ("integrations", "geocoding", "geocode.maps.co", "api_key"),
            ("storage", "postgres", "password"),
            ("storage", "postgres", "username"),
        ]

        for path in sensitive_paths:
            d = config_clean
            for key in path[:-1]:
                if not isinstance(d, dict):
                    d = None
                    break
                d = d.get(key)
                if d is None:
                    break
            # redact sensitive keys in dicts
            if isinstance(d, dict) and path[-1] in d:
                d[path[-1]] = "***REDACTED***"

        # PSKs sit in a list of tables the path walk can't reach, and
        # /v1/server/config is unauthenticated. Dict shape (bracket typo) must not leak either.
        try:
            enc = config_clean["broker"]["channels"]["encryption"]
            entries = (
                list(enc.values()) + [enc] if isinstance(enc, dict)
                else enc if isinstance(enc, list) else []
            )
            for entry in entries:
                if isinstance(entry, dict) and "key" in entry:
                    entry["key"] = "***REDACTED***"
        except (KeyError, TypeError):
            pass

        return config_clean
