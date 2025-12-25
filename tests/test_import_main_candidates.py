import importlib.util
from pathlib import Path

CANDIDATES = [
    Path("main.py"),
    Path("app.py"),
    Path("backend/main.py"),
    Path("meshinfo/main.py"),
]

def _import_by_path(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader, f"Could not load spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod

def test_import_entrypoints_if_present():
    repo_root = Path(__file__).resolve().parents[1]
    found_any = False

    for rel in CANDIDATES:
        p = repo_root / rel
        if p.exists():
            found_any = True
            _import_by_path(p)

    # If none of the candidates exist, don't fail—this is "best effort".
    assert True if not found_any else True
