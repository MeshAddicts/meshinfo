"""Tests for data_store._resolve_providers: URL templates, Meshview dicts,
and dead-legacy handling."""


from data_store import _DEAD_LEGACY_PROVIDERS, _PROVIDER_PRESETS, _resolve_providers


def _cfg(enrich):
    """Shape a partial config the way _resolve_providers reads it."""
    return {"server": {"enrich": enrich}}


class TestPresetTable:
    def test_no_presets_currently_shipped(self):
        # If a preset is ever re-introduced, update this assertion.
        assert _PROVIDER_PRESETS == {}


class TestDeadLegacyProviders:
    def test_dead_legacy_bayme_dropped(self):
        assert _resolve_providers(_cfg({"providers": ["bayme"]})) == []

    def test_dead_legacy_world_meshinfo_dropped(self):
        assert _resolve_providers(_cfg({"providers": ["world.meshinfo.network"]})) == []

    def test_dead_legacy_via_singular_provider_key(self):
        assert _resolve_providers(_cfg({"provider": "world.meshinfo.network"})) == []
        assert _resolve_providers(_cfg({"provider": "bayme"})) == []

    def test_dead_legacy_table_has_replacement_hints(self):
        for name, hint in _DEAD_LEGACY_PROVIDERS.items():
            assert isinstance(hint, str) and hint.strip(), name

    def test_dead_legacy_mixed_with_valid_entry(self):
        cfg = _cfg({"providers": [
            "bayme",
            {"kind": "meshview", "url": "https://x/api/nodes", "name": "ok"},
        ]})
        providers = _resolve_providers(cfg)
        assert [p["name"] for p in providers] == ["ok"]


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

    def test_dict_url_without_ids_placeholder_rejected(self):
        cfg = _cfg({"providers": [{"name": "broken", "url": "https://x.example/api"}]})
        assert _resolve_providers(cfg) == []


class TestMeshviewKind:
    def test_meshview_kind_resolves(self):
        cfg = _cfg({"providers": [{
            "kind": "meshview",
            "url": "https://meshview.example/api/nodes",
            "name": "example",
            "days_active": 3,
        }]})
        providers = _resolve_providers(cfg)
        assert len(providers) == 1
        prov = providers[0]
        assert prov["kind"] == "meshview"
        assert prov["name"] == "example"
        assert prov["url"] == "https://meshview.example/api/nodes"
        assert prov["days_active"] == 3

    def test_meshview_kind_defaults_days_active(self):
        cfg = _cfg({"providers": [{"kind": "meshview", "url": "https://x/api/nodes"}]})
        providers = _resolve_providers(cfg)
        assert providers[0]["days_active"] == 7

    def test_meshview_kind_does_not_require_ids_placeholder(self):
        # {ids} requirement only applies to meshinfo kind.
        cfg = _cfg({"providers": [{"kind": "meshview", "url": "https://x/api/nodes"}]})
        assert len(_resolve_providers(cfg)) == 1

    def test_unknown_kind_rejected(self):
        cfg = _cfg({"providers": [{"kind": "made-up", "url": "https://x/api"}]})
        assert _resolve_providers(cfg) == []


class TestMeshviewBulkAdapter:
    """_enrich_via_meshview_bulk: hex-id matching + snake_case→camelCase mapping."""

    def _stub_session(self, payload, status=200):
        class FakeResponse:
            def __init__(self, status, payload):
                self.status = status
                self._payload = payload
            async def json(self):
                return self._payload
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
        class FakeSession:
            def get(self, url):
                return FakeResponse(status, payload)
        return FakeSession()

    def _make_data_store(self, nodes):
        import asyncio
        class FakePg:
            def __init__(self, nodes):
                self._nodes = dict(nodes)
                self.writes = []
            async def get_node_cached(self, nid):
                return self._nodes.get(nid)
            def cache_node_set(self, nid, node):
                self._nodes[nid] = node
            async def write_node(self, nid, node):
                self._nodes[nid] = dict(node)
                self.writes.append((nid, dict(node)))
        class FakeDS:
            def __init__(self):
                self.pg_storage = FakePg(nodes)
                self.discord_event_queue = asyncio.Queue(maxsize=1000)
        return FakeDS()

    def test_bulk_maps_snake_case_to_canonical_id_and_names(self):
        import asyncio
        from data_store import DataStore
        # hex 99005060 = decimal 2566934624; Meshview's node_id is decimal.
        ds = self._make_data_store(nodes={
            "99005060": {"id": "99005060", "longname": "Unknown", "shortname": "UNK"},
        })
        payload = {"nodes": [
            {"node_id": 2566934624, "long_name": "Goblin RX SantaCruz", "short_name": "GOBL"},
        ]}
        session = self._stub_session(payload)
        store = DataStore.__new__(DataStore)
        store.config = {}
        store.pg_storage = ds.pg_storage
        prov = {"name": "test", "kind": "meshview",
                "url": "https://x/api/nodes", "days_active": 1}
        result = asyncio.new_event_loop().run_until_complete(
            store._enrich_via_meshview_bulk(session, prov, {"99005060"})
        )
        assert result["named"] == {"99005060"}
        assert result["succeeded"] == 1
        assert ds.pg_storage._nodes["99005060"]["longname"] == "Goblin RX SantaCruz"
        assert ds.pg_storage._nodes["99005060"]["shortname"] == "GOBL"

    def test_bulk_skips_pending_ids_not_in_response(self):
        import asyncio
        from data_store import DataStore
        ds = self._make_data_store(nodes={
            "deadbeef": {"id": "deadbeef", "longname": "Unknown", "shortname": "UNK"},
        })
        payload = {"nodes": [
            {"node_id": 2566934624, "long_name": "Other Node", "short_name": "OTH"},
        ]}
        session = self._stub_session(payload)
        store = DataStore.__new__(DataStore)
        store.config = {}
        store.pg_storage = ds.pg_storage
        prov = {"name": "test", "kind": "meshview",
                "url": "https://x/api/nodes", "days_active": 1}
        result = asyncio.new_event_loop().run_until_complete(
            store._enrich_via_meshview_bulk(session, prov, {"deadbeef"})
        )
        assert result["named"] == set()
        assert result["succeeded"] == 1
        assert ds.pg_storage._nodes["deadbeef"]["longname"] == "Unknown"

    def test_bulk_reports_failure_on_non_200(self):
        import asyncio
        from data_store import DataStore
        ds = self._make_data_store(nodes={})
        session = self._stub_session(payload={}, status=500)
        store = DataStore.__new__(DataStore)
        store.config = {}
        store.pg_storage = ds.pg_storage
        prov = {"name": "test", "kind": "meshview",
                "url": "https://x/api/nodes", "days_active": 1}
        result = asyncio.new_event_loop().run_until_complete(
            store._enrich_via_meshview_bulk(session, prov, {"abc"})
        )
        assert result["succeeded"] == 0
        assert result["named"] == set()


class TestEmptyOrInvalid:
    def test_no_enrich_section(self):
        assert _resolve_providers({}) == []

    def test_empty_providers_list(self):
        assert _resolve_providers(_cfg({"providers": []})) == []

    def test_unknown_preset_name_skipped(self):
        providers = _resolve_providers(_cfg({"providers": ["gibberish"]}))
        assert providers == []

    def test_unknown_mixed_with_valid_url_keeps_valid(self):
        providers = _resolve_providers(_cfg({"providers": [
            "gibberish",
            "https://ok.example/api?ids={ids}",
        ]}))
        assert [p["name"] for p in providers] == ["https://ok.example/api?ids={ids}"]

    def test_invalid_entry_type_skipped(self):
        providers = _resolve_providers(_cfg({"providers": [
            42,
            "https://ok.example/api?ids={ids}",
        ]}))
        assert [p["name"] for p in providers] == ["https://ok.example/api?ids={ids}"]
