import compileall
from pathlib import Path

def test_python_files_compile():
    repo_root = Path(__file__).resolve().parents[1]
    ok = compileall.compile_dir(str(repo_root), quiet=1)
    assert ok, "One or more Python files failed to compile"
