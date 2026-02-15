"""
Config loading, validation, and defaults for MeshInfo.

Addresses GitHub issue #81: Config parsing and validation.
- Validates all config fields at startup
- Provides sensible defaults for optional fields
- Logs warnings for missing or invalid values
- Fails fast (with clear error messages) only for truly required fields
"""

import datetime
import json
import logging
import uuid
from copy import deepcopy
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default configuration
# ---------------------------------------------------------------------------
# Every key that MeshInfo might read should appear here.  When a user's
# config.json is loaded, it is deep-merged on top of these defaults so that
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
        "altitude": 0,
        "timezone": "UTC",
        "announce": {
            "enabled": False,
            "interval": 60,
        },
        "tools": [],
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
            "display": ["0"],
            "meta": {},
            "views": [],
        },
    },
    "paths": {
        "backups": "output/backups",
        "data": "output/data",
        "output": "output/static-html",
        "templates": "templates",
    },
    "server": {
        "node_id": "",
        "base_url": "",
        "node_activity_prune_threshold": 259200,
        "timezone": "UTC",
        "intervals": {
            "data_save": 300,
            "render": 5,
        },
        "backups": {
            "enabled": True,
            "interval": 86400,
            "max_backups": 7,
        },
        "enrich": {
            "enabled": False,
            "interval": 900,
            "provider": "world.meshinfo.network",
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
        },
        "geocoding": {
            "enabled": False,
            "provider": "geocode.maps.co",
            "geocode.maps.co": {
                "api_key": "",
            },
        },
    },
    "storage": {
        "read_from": "json",
        "write_to": ["json"],
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
        msg = (
            f"Config field '{path}' expected {expected_type.__name__ if isinstance(expected_type, type) else expected_type}, "
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

    # ── paths section ─────────────────────────────────────────────────
    _validate_type(config, "paths", dict, required=True)
    _validate_type(config, "paths.data", str, required=True)
    _validate_type(config, "paths.output", str, required=True)
    check(_validate_type(config, "paths.backups", str))
    check(_validate_type(config, "paths.templates", str))

    # ── server section ────────────────────────────────────────────────
    _validate_type(config, "server", dict, required=True)
    check(_validate_type(config, "server.node_id", str))
    _validate_type(config, "server.timezone", str, required=True)
    check(_validate_positive_number(config, "server.node_activity_prune_threshold"))
    check(_validate_type(config, "server.intervals", dict))
    check(_validate_positive_number(config, "server.intervals.data_save"))
    check(_validate_positive_number(config, "server.intervals.render"))
    check(_validate_type(config, "server.backups", dict))
    check(_validate_type(config, "server.backups.enabled", bool))
    check(_validate_positive_number(config, "server.backups.interval"))
    check(_validate_type(config, "server.enrich", dict))
    check(_validate_type(config, "server.graph", dict))
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
        if not discord_cfg.get("token") or "REPLACE_WITH" in discord_cfg.get("token", ""):
            warn("Discord is enabled but token is missing or still a placeholder.")
        if not discord_cfg.get("guild") or "REPLACE_WITH" in discord_cfg.get("guild", ""):
            warn("Discord is enabled but guild ID is missing or still a placeholder.")

    check(_validate_type(config, "integrations.geocoding", dict))
    geocoding_cfg = _get_nested(config, "integrations", "geocoding") or {}
    if geocoding_cfg.get("enabled"):
        provider = geocoding_cfg.get("provider", "")
        provider_cfg = geocoding_cfg.get(provider, {})
        if not provider_cfg.get("api_key") or "REPLACE_WITH" in provider_cfg.get("api_key", ""):
            warn(f"Geocoding is enabled (provider: {provider}) but API key is missing or still a placeholder.")

    # ── storage section ───────────────────────────────────────────────
    check(_validate_type(config, "storage", dict))
    check(_validate_one_of(config, "storage.read_from", ["json", "postgres"]))
    check(_validate_type(config, "storage.write_to", list))

    storage_cfg = config.get("storage", {})
    write_to = storage_cfg.get("write_to", [])
    read_from = storage_cfg.get("read_from", "json")

    if isinstance(write_to, list):
        for target in write_to:
            if target not in ("json", "postgres"):
                warn(f"Unknown storage write target: {target!r}. Expected 'json' or 'postgres'.")

    # If postgres is being used, validate its config
    needs_postgres = read_from == "postgres" or "postgres" in write_to
    pg_cfg = storage_cfg.get("postgres", {})
    if needs_postgres:
        if not pg_cfg.get("enabled"):
            warn(
                "Postgres is referenced in storage.read_from or storage.write_to, "
                "but storage.postgres.enabled is False. This may cause errors."
            )
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
        Load config.json, merge with defaults, validate, and return
        the final config dict.
        """
        # Load user config
        user_config = cls._load_from_file("config.json")

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
            version_info = cls._load_from_file("version-info.json")
            if version_info is not None:
                config["server"]["version_info"] = version_info
        except (ConfigValidationError, FileNotFoundError, json.JSONDecodeError):
            pass

        logger.info(
            "Config loaded: mesh=%r, broker_enabled=%s, storage_read=%s, storage_write=%s",
            config["mesh"]["name"],
            config["broker"]["enabled"],
            config["storage"]["read_from"],
            config["storage"]["write_to"],
        )

        return config

    @classmethod
    def _load_from_file(cls, path: str) -> dict:
        """Load and parse a JSON file, with a clear error on failure."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            raise ConfigValidationError(
                f"Config file '{path}' not found. "
                f"Copy config.json.sample to config.json and edit it for your deployment."
            )
        except json.JSONDecodeError as e:
            raise ConfigValidationError(
                f"Config file '{path}' contains invalid JSON: {e}"
            )

    @classmethod
    def load_from_file(cls, path: str) -> dict:
        """Public alias for backward compatibility."""
        return cls._load_from_file(path)

    @classmethod
    def cleanse(cls, config: dict) -> dict:
        """Return a copy of config with sensitive fields removed."""
        config_clean = deepcopy(config)

        # Paths to sensitive fields that should be redacted
        sensitive_paths = [
            ("broker", "password"),
            ("broker", "username"),
            ("integrations", "discord", "token"),
            ("integrations", "geocoding", "geocode.maps.co", "api_key"),
            ("storage", "postgres", "password"),
            ("storage", "postgres", "username"),
        ]

        for path in sensitive_paths:
            d = config_clean
            for key in path[:-1]:
                if isinstance(d, dict) and key in d:
                    d = d[key]
                else:
                    break
            else:
                if isinstance(d, dict) and path[-1] in d:
                    d[path[-1]] = "***REDACTED***"

        return config_clean