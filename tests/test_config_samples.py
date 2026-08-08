import tomllib
from pathlib import Path

def test_config_toml_sample_is_valid():
    repo_root = Path(__file__).resolve().parents[1]
    p = repo_root / "config.toml.sample"

    assert p.exists(), "config.toml.sample missing"
    with open(p, "rb") as f:
        tomllib.load(f)


def _validatable_base():
    """DEFAULT_CONFIG made fatal-error-free so validate() runs to completion."""
    import copy

    import config as config_mod

    base = copy.deepcopy(config_mod.DEFAULT_CONFIG)
    base["storage"]["postgres"]["enabled"] = True
    base.setdefault("mesh", {}).update({"name": "t", "shortname": "t"})
    return base


def test_validate_survives_wrong_shaped_channels():
    """Channels as a bare list must warn, not crash validate() with AttributeError."""
    import config as config_mod

    broken = _validatable_base()
    broken["broker"]["channels"] = ["0"]
    warnings = config_mod.validate(broken)  # must not raise
    assert any("broker.channels" in w for w in warnings)


def test_validate_flags_bad_channel_mode_and_stale_lists():
    import config as config_mod

    cfg = _validatable_base()
    cfg["broker"]["channels"]["mode"] = "curated"  # not a valid mode
    warnings = config_mod.validate(cfg)
    assert any("broker.channels.mode" in w for w in warnings)

    cfg = _validatable_base()
    cfg["broker"]["channels"]["show"] = {"presets": True}  # pre-release shape
    warnings = config_mod.validate(cfg)
    assert any("broker.channels.show" in w for w in warnings)


def test_upgrade_warning_for_stale_display_views(caplog):
    """Pre-mode configs with display/views warn (now manual-mode-only); an
    explicit mode alongside them stays quiet."""
    import logging

    import config as config_mod

    with caplog.at_level(logging.WARNING, logger="config"):
        config_mod._warn_stale_channel_lists(
            {"broker": {"channels": {"display": ["8"], "views": []}}}
        )
    assert any('mode = "manual"' in r.message for r in caplog.records)

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="config"):
        config_mod._warn_stale_channel_lists(
            {"broker": {"channels": {"mode": "presets", "display": ["8"]}}}
        )
        config_mod._warn_stale_channel_lists({"broker": {"channels": {}}})
        config_mod._warn_stale_channel_lists({})
    assert not caplog.records


def test_cleanse_redacts_encryption_keys_in_both_shapes():
    """PSKs must never reach /v1/server/config — including the single-bracket
    typo that makes the encryption section a dict instead of a list."""
    import config as config_mod

    as_list = {"broker": {"channels": {"encryption": [{"key": "s1", "key_name": "A"}]}}}
    out = config_mod.Config.cleanse(as_list)
    assert out["broker"]["channels"]["encryption"][0]["key"] == "***REDACTED***"

    as_dict = {"broker": {"channels": {"encryption": {"key": "s2", "key_name": "B"}}}}
    out = config_mod.Config.cleanse(as_dict)
    assert out["broker"]["channels"]["encryption"]["key"] == "***REDACTED***"
