import ast
from pathlib import Path

def test_main_py_has_async_main():
    repo_root = Path(__file__).resolve().parents[1]
    main_py = repo_root / "main.py"
    assert main_py.exists(), "main.py missing"

    tree = ast.parse(main_py.read_text(encoding="utf-8"))
    assert any(
        isinstance(n, ast.AsyncFunctionDef) and n.name == "main"
        for n in tree.body
    ), "main.py should define `async def main()`"
