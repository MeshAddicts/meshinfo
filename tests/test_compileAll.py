import compileall
from pathlib import Path

SKIP_DIRS = {
    ".venv",
    "venv",
    ".git",
    "node_modules",
    "frontend",
    "dist",
    "build",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
}

def test_python_files_compile():
    repo_root = Path(__file__).resolve().parents[1]

    # Compile only *.py files that are part of the repo (not virtualenv/deps)
    py_files = [
        p for p in repo_root.rglob("*.py")
        if not any(part in SKIP_DIRS for part in p.parts)
    ]

    assert py_files, "No python files found to compile (unexpected)"

    for p in py_files:
        ok = compileall.compile_file(str(p), quiet=1)
        assert ok, f"Failed to compile: {p}"
