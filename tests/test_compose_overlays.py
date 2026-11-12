"""The two tiered-storage overlays (ZFS.md): docker-compose.zfs.yml puts the whole
cluster on ZFS datasets, docker-compose.cold.yml binds only the cold directory.
Both must bind it where the job creates the tablespace (postgres) and read-only
where the job checks it (meshinfo)."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

REPO_ROOT = Path(__file__).resolve().parents[1]
COLD_TARGET = "/var/lib/postgresql/cold"
GUARD_TARGET = "/mnt/meshinfo-cold"


def _overlay(name: str) -> dict:
    with open(REPO_ROOT / name, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _binds(service: dict) -> dict:
    """container path -> (host expression, read-only) from short-syntax volumes; only the host part may contain colons."""
    out = {}
    for entry in service["volumes"]:
        read_only = entry.endswith(":ro")
        rest = entry[:-3] if read_only else entry
        host, container = rest.rsplit(":", 1)
        assert container.startswith("/"), entry
        out[container] = (host, read_only)
    return out


@pytest.mark.parametrize("name", ["docker-compose.zfs.yml", "docker-compose.cold.yml"])
def test_overlay_binds_the_cold_directory_for_both_containers(name):
    doc = _overlay(name)
    assert set(doc) == {"services"}  # no top-level volumes: the named volume is docker-compose.yml's
    assert set(doc["services"]) == {"postgres", "meshinfo"}
    pg, app = _binds(doc["services"]["postgres"]), _binds(doc["services"]["meshinfo"])
    assert COLD_TARGET in pg and pg[COLD_TARGET][1] is False
    assert GUARD_TARGET in app and app[GUARD_TARGET][1] is True
    assert pg[COLD_TARGET][0] == app[GUARD_TARGET][0]  # the same host directory


def test_cold_overlay_leaves_the_cluster_on_the_named_volume():
    pg = _binds(_overlay("docker-compose.cold.yml")["services"]["postgres"])
    assert set(pg) == {COLD_TARGET}
    host, _ = pg[COLD_TARGET]
    # Required, with no default: Compose must refuse rather than bind an empty
    # directory on the root filesystem (the job would create the tablespace there).
    assert host.startswith("${MESHINFO_PGCOLD_DIR:?") and host.endswith("}")


def test_zfs_overlay_replaces_the_cluster_volume_and_binds_the_cold_dataset():
    pg = _binds(_overlay("docker-compose.zfs.yml")["services"]["postgres"])
    assert set(pg) == {"/var/lib/postgresql", COLD_TARGET}
    assert pg["/var/lib/postgresql"][0].startswith("${MESHINFO_ZFS_HOT:-")
    assert pg[COLD_TARGET][0].startswith("${MESHINFO_ZFS_COLD:-")
