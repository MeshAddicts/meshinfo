import tomllib
from pathlib import Path

def test_config_toml_sample_is_valid():
    repo_root = Path(__file__).resolve().parents[1]
    p = repo_root / "config.toml.sample"

    assert p.exists(), "config.toml.sample missing"
    with open(p, "rb") as f:
        tomllib.load(f)
