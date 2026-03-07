import json
import tomllib
from pathlib import Path

def test_config_toml_sample_is_valid():
    repo_root = Path(__file__).resolve().parents[1]
    p = repo_root / "config.toml.sample"

    assert p.exists(), "config.toml.sample missing"
    with open(p, "rb") as f:
        tomllib.load(f)

def test_config_json_sample_is_valid():
    """Legacy JSON sample should remain valid while we support both formats."""
    repo_root = Path(__file__).resolve().parents[1]
    p = repo_root / "config.json.sample"

    assert p.exists(), "config.json.sample missing"
    json.loads(p.read_text(encoding="utf-8"))
