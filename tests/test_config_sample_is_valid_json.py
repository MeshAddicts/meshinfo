import json
from pathlib import Path

def test_config_sample_is_valid_json():
    repo_root = Path(__file__).resolve().parents[1]
    p = repo_root / "config.json.sample"

    # If some forks rename it, don't hard-fail; but for upstream, it should exist.
    assert p.exists(), "config.json.sample missing"
    json.loads(p.read_text(encoding="utf-8"))
