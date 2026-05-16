"""
Tests for data_store._resolve_providers — the config-to-runtime mapping that
backs the Group K multi-provider enrichment refactor. Covers preset lookup,
legacy single-string back-compat, URL templates, and graceful handling of the
dead `world.meshinfo.network` config that's still in many operators' configs.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_store import _PROVIDER_PRESETS, _resolve_providers


def _cfg(enrich):
    """Shape a partial config the way _resolve_providers reads it."""
    return {"server": {"enrich": enrich}}


class TestNamedPresets:
    def test_bayme_preset_loaded(self):
        providers = _resolve_providers(_cfg({"providers": ["bayme"]}))
        assert len(providers) == 1
        prov = providers[0]
        assert prov["name"] == "bayme"
        assert prov["single_id_per_request"] is True
        assert "data.bayme.sh" in prov["url_template"]
        assert "{ids}" in prov["url_template"]

    def test_only_known_presets_in_module_table(self):
        """If this list changes, surface it in the audit/memo before shipping."""
        assert set(_PROVIDER_PRESETS.keys()) == {"bayme"}


class TestLegacyBackCompat:
    def test_legacy_provider_bayme_upgraded(self):
        providers = _resolve_providers(_cfg({"provider": "bayme"}))
        assert len(providers) == 1
        assert providers[0]["name"] == "bayme"

    def test_legacy_world_meshinfo_dropped_silently(self):
        # The upstream URL is dead; resolver downgrades to empty list with a warning.
        providers = _resolve_providers(_cfg({"provider": "world.meshinfo.network"}))
        assert providers == []

    def test_new_providers_list_wins_over_legacy_provider(self):
        cfg = _cfg({"providers": ["bayme"], "provider": "world.meshinfo.network"})
        providers = _resolve_providers(cfg)
        # `providers` is the modern key; legacy is ignored when both are set.
        assert len(providers) == 1
        assert providers[0]["name"] == "bayme"


class TestUrlTemplates:
    def test_url_template_as_bare_string(self):
        url = "https://other.meshinfo.example/api/v1/nodes?ids={ids}"
        providers = _resolve_providers(_cfg({"providers": [url]}))
        assert len(providers) == 1
        prov = providers[0]
        assert prov["url_template"] == url
        # Generic templates default to batched (single call with comma-joined ids).
        assert prov["single_id_per_request"] is False

    def test_url_template_without_ids_placeholder_rejected(self):
        # Without {ids} we'd format nothing — silently broken upstream calls.
        providers = _resolve_providers(_cfg({"providers": ["https://example.com/api"]}))
        assert providers == []

    def test_url_template_as_object_with_overrides(self):
        cfg = _cfg({"providers": [{
            "name": "custom",
            "url": "https://x.example/{ids}",
            "single_id_per_request": True,
        }]})
        providers = _resolve_providers(cfg)
        assert len(providers) == 1
        assert providers[0]["name"] == "custom"
        assert providers[0]["single_id_per_request"] is True


class TestEmptyOrInvalid:
    def test_no_enrich_section(self):
        assert _resolve_providers({}) == []

    def test_empty_providers_list(self):
        assert _resolve_providers(_cfg({"providers": []})) == []

    def test_unknown_preset_name_skipped(self):
        providers = _resolve_providers(_cfg({"providers": ["gibberish"]}))
        assert providers == []

    def test_known_and_unknown_mixed_keeps_known(self):
        providers = _resolve_providers(_cfg({"providers": ["gibberish", "bayme"]}))
        assert [p["name"] for p in providers] == ["bayme"]

    def test_invalid_entry_type_skipped(self):
        # A bare integer isn't a valid provider entry; resolver logs + moves on.
        providers = _resolve_providers(_cfg({"providers": [42, "bayme"]}))
        assert [p["name"] for p in providers] == ["bayme"]
