from pathlib import Path

def test_required_files_exist():
    repo_root = Path(__file__).resolve().parents[1]

    for rel in ["banner", "version.json", "config.toml.sample"]:
        p = repo_root / rel
        assert p.exists(), f"Missing required file: {rel}"
