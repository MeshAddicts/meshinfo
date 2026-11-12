"""Python-version tripwire: the images, CI and .tool-versions stay on one Python minor,
so the tests run on the Python the image ships. Dependency-free: it must never be skipped."""
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CI_WORKFLOW = ".github/workflows/tests.yml"

_FROM_PYTHON = r"^FROM python:(\d+\.\d+)"
DOCKERFILES = sorted(
    path.name
    for path in REPO_ROOT.glob("Dockerfile*")
    if re.search(_FROM_PYTHON, path.read_text(encoding="utf-8"), re.MULTILINE)
)


def _minor(path: str, pattern: str) -> str:
    match = re.search(pattern, (REPO_ROOT / path).read_text(encoding="utf-8"), re.MULTILINE)
    assert match, f"{path}: no Python X.Y version found"
    return match.group(1)


def _ci_python() -> str:
    return _minor(CI_WORKFLOW, r"""python-version:\s*["']?(\d+\.\d+)""")


def test_the_app_image_is_covered():
    assert "Dockerfile" in DOCKERFILES


@pytest.mark.parametrize("dockerfile", DOCKERFILES)
def test_image_python_is_the_ci_python(dockerfile):
    image, ci = _minor(dockerfile, _FROM_PYTHON), _ci_python()
    assert image == ci, (
        f"{dockerfile} builds on Python {image} but CI tests on {ci}: "
        f"change python-version in {CI_WORKFLOW} in the same pull request"
    )


def test_tool_versions_python_is_the_ci_python():
    local, ci = _minor(".tool-versions", r"^python (\d+\.\d+)"), _ci_python()
    assert local == ci, f".tool-versions has Python {local} but CI tests on {ci}"
