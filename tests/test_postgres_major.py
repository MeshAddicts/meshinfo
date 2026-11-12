"""PostgreSQL major-version tripwire: every place that pins the server major must agree
with RECORDED_POSTGRES_MAJOR, so an image cannot be bumped without the checklist in
POSTGRES.md, "Before bumping the PostgreSQL major". Deliberately dependency-free
(no YAML parser): it must never be skipped."""
import re
from pathlib import Path
from typing import List, NamedTuple, Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# The PostgreSQL major this repository runs. Changing it is a step of the checklist
# in POSTGRES.md, never the way to make this test pass.
RECORDED_POSTGRES_MAJOR = 18

CHECKLIST_HEADING = "## Before bumping the PostgreSQL major"
CHECKLIST = 'POSTGRES.md, "Before bumping the PostgreSQL major"'
COMPOSE_FILES = ("docker-compose.yml", "docker-compose-dev.yml")

# `image: postgres:18`, `image: "docker.io/library/postgres:18.1-alpine"`,
# `- image: postgres:18@sha256:…`, and the Actions shorthand `container: postgres:18`.
_IMAGE_KEY = re.compile(r"""^\s*(?:-\s*)?(?:image|container):\s*["']?(?P<ref>[^\s"'#]+)""")
# The official image, optionally behind a registry or namespace prefix. Other
# images (postgres-exporter, bitnami/postgresql, ...) are not the server pin.
_POSTGRES_REF = re.compile(
    r"^(?:[A-Za-z0-9.-]+(?::\d+)?/)*postgres"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*))?(?:@sha256:[0-9a-f]{64})?$"
)
_TAG_MAJOR = re.compile(r"^(\d+)")  # 18, 18.1, 18-alpine, 19beta1
# `postgresql-client-18` in the app image: pg_dump refuses a server newer than itself.
_CLIENT_PACKAGE = re.compile(r"\bpostgresql-client-(\d+)\b")


class Pin(NamedTuple):
    path: str  # repo-relative, forward slashes
    line: int
    what: str  # the image reference or package name as written
    major: Optional[int]  # None when no major can be read (no tag, `latest`, a bare digest)


def postgres_image_major(ref: str) -> Optional[int]:
    """The major of an official-postgres image reference (None when it names none); ValueError for any other image."""
    match = _POSTGRES_REF.match(ref)
    if match is None:
        raise ValueError(f"not a postgres image: {ref!r}")
    tag = _TAG_MAJOR.match(match.group("tag") or "")
    return int(tag.group(1)) if tag else None


def _code_lines(path: Path):
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.lstrip().startswith("#"):
            yield number, line


def _image_pins(path: Path, root: Path) -> List[Pin]:
    pins = []
    for number, line in _code_lines(path):
        key = _IMAGE_KEY.match(line)
        if key is None:
            continue
        try:
            major = postgres_image_major(key.group("ref"))
        except ValueError:
            continue
        pins.append(Pin(path.relative_to(root).as_posix(), number, key.group("ref"), major))
    return pins


def _compose_files(root: Path) -> List[Path]:
    """The two stack definitions, then every other compose file at the root: an image set in an overlay must not slip past."""
    named = [root / name for name in COMPOSE_FILES]
    others = sorted(
        path
        for pattern in ("docker-compose*.yml", "docker-compose*.yaml", "compose*.yml", "compose*.yaml")
        for path in root.glob(pattern)
        if path not in named
    )
    return [path for path in named if path.is_file()] + others


def postgres_pins(root: Path = REPO_ROOT) -> List[Pin]:
    """Every pin of the PostgreSQL major under root: compose server images, CI workflow images, the pg_dump client package."""
    pins: List[Pin] = []
    for path in _compose_files(root):
        pins += _image_pins(path, root)
    workflows = root / ".github" / "workflows"
    if workflows.is_dir():
        for path in sorted(workflows.iterdir()):
            if path.suffix in (".yml", ".yaml"):
                pins += _image_pins(path, root)
    dockerfile = root / "Dockerfile"
    if dockerfile.is_file():
        for number, line in _code_lines(dockerfile):
            for package in _CLIENT_PACKAGE.finditer(line):
                pins.append(Pin("Dockerfile", number, package.group(0), int(package.group(1))))
    return pins


def problems(pins: List[Pin], recorded: int = RECORDED_POSTGRES_MAJOR) -> List[str]:
    """Why the pins do not all say `recorded` (empty when they do)."""
    found = []
    for name in COMPOSE_FILES:
        if not any(pin.path == name for pin in pins):
            found.append(f"{name}: no `image: postgres:<major>` line found, so the server major cannot be read")
    for pin in pins:
        if pin.major is None:
            found.append(f"{pin.path}:{pin.line}: `{pin.what}` names no major version (pin one, e.g. postgres:{recorded})")
        elif pin.major != recorded:
            found.append(f"{pin.path}:{pin.line}: `{pin.what}` is PostgreSQL {pin.major}; the recorded major is {recorded}")
    return found


def failure_message(found: List[str], recorded: int = RECORDED_POSTGRES_MAJOR) -> str:
    return (
        "The PostgreSQL major pinned in the repository does not match the recorded one "
        f"(RECORDED_POSTGRES_MAJOR = {recorded} in tests/test_postgres_major.py):\n  "
        + "\n  ".join(found)
        + f"\nA PostgreSQL major bump is deliberate, never incidental: read {CHECKLIST} first. "
        "Updating the recorded value is a step of that checklist, not the fix for this failure."
    )


# --- the tripwire ---

def test_postgres_major_is_the_recorded_one_everywhere():
    found = problems(postgres_pins())
    assert not found, failure_message(found)


def test_the_checklist_named_in_the_failure_message_exists():
    lines = (REPO_ROOT / "POSTGRES.md").read_text(encoding="utf-8").splitlines()
    assert CHECKLIST_HEADING in lines, f"{CHECKLIST} is missing: the tripwire's message would point nowhere"


# --- the tripwire's own parsing ---

@pytest.mark.parametrize("ref,major", [
    ("postgres:18", 18),
    ("postgres:18.1", 18),
    ("postgres:18-alpine", 18),
    ("postgres:18.1-bookworm", 18),
    ("postgres:19beta1", 19),
    ("postgres:18@sha256:" + "a" * 64, 18),
    ("docker.io/library/postgres:18", 18),
    ("library/postgres:17", 17),
    ("registry.example:5000/mirror/postgres:18", 18),
    ("postgres", None),
    ("postgres:latest", None),
    ("postgres:alpine", None),
    ("postgres@sha256:" + "b" * 64, None),
])
def test_image_reference_majors(ref, major):
    assert postgres_image_major(ref) == major


@pytest.mark.parametrize("ref", [
    "eclipse-mosquitto:latest", "bitnami/postgresql:18", "postgres-exporter:18", "postgis/postgis:18-3.6",
    "ghcr.io/example/postgres-backup:18", "python:3.14-slim",
])
def test_other_images_are_not_the_server_pin(ref):
    with pytest.raises(ValueError):
        postgres_image_major(ref)


COMPOSE = """services:
  postgres:
    image: {image}
    # image: postgres:99  (a comment is not a pin)
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/meshinfo
  mqtt:
    container_name: mqtt
    image: eclipse-mosquitto:latest
"""
WORKFLOW = """jobs:
  test:
    runs-on: ubuntu-latest
    {container}
    services:
      db:
        image: {image}
    steps:
      - run: python -m pytest -q tests
"""
DOCKERFILE = """FROM python:3.14-slim
# postgresql-client-99 in a comment is not a pin
RUN apt-get install -y --no-install-recommends postgresql-client-{major}
"""


def _tree(root: Path, *, prod="postgres:18", dev="postgres:18", overlay=None, ci=None, ci_container="",
          client=18) -> Path:
    (root / "docker-compose.yml").write_text(COMPOSE.format(image=prod), encoding="utf-8")
    (root / "docker-compose-dev.yml").write_text(COMPOSE.format(image=dev), encoding="utf-8")
    if overlay is not None:
        (root / "docker-compose.zfs.yml").write_text(COMPOSE.format(image=overlay), encoding="utf-8")
    if client is not None:
        (root / "Dockerfile").write_text(DOCKERFILE.format(major=client), encoding="utf-8")
    if ci is not None:
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / ".github" / "workflows" / "tests.yml").write_text(
            WORKFLOW.format(image=ci, container=ci_container), encoding="utf-8")
    return root


def test_a_consistent_tree_passes(tmp_path):
    pins = postgres_pins(_tree(tmp_path, overlay="postgres:18", ci="postgres:18"))
    assert [(p.path, p.line, p.what, p.major) for p in pins] == [
        ("docker-compose.yml", 3, "postgres:18", 18),
        ("docker-compose-dev.yml", 3, "postgres:18", 18),
        ("docker-compose.zfs.yml", 3, "postgres:18", 18),
        (".github/workflows/tests.yml", 7, "postgres:18", 18),
        ("Dockerfile", 3, "postgresql-client-18", 18),
    ]
    assert problems(pins, recorded=18) == []


@pytest.mark.parametrize("kwargs,where", [
    ({"prod": "postgres:19"}, "docker-compose.yml:3"),
    ({"dev": "postgres:19.0-alpine"}, "docker-compose-dev.yml:3"),
    ({"overlay": "postgres:19"}, "docker-compose.zfs.yml:3"),
    ({"ci": "postgres:19"}, ".github/workflows/tests.yml:7"),
    ({"ci": "postgres:18", "ci_container": "container: postgres:17"}, ".github/workflows/tests.yml:4"),
    ({"client": 19}, "Dockerfile:3"),
])
def test_one_bumped_pin_trips_the_wire(tmp_path, kwargs, where):
    found = problems(postgres_pins(_tree(tmp_path, **kwargs)), recorded=18)
    assert len(found) == 1 and found[0].startswith(where + ":"), found
    assert "the recorded major is 18" in found[0]
    message = failure_message(found, recorded=18)
    assert CHECKLIST in message and "not the fix for this failure" in message


def test_bumping_every_image_without_the_recorded_value_still_trips(tmp_path):
    # What an approved Renovate PR looks like before the checklist is done.
    tree = _tree(tmp_path, prod="postgres:19", dev="postgres:19", ci="postgres:19", client=19)
    assert len(problems(postgres_pins(tree), recorded=18)) == 4
    assert problems(postgres_pins(tree), recorded=19) == []


def test_an_unreadable_or_missing_server_pin_trips_the_wire(tmp_path):
    found = problems(postgres_pins(_tree(tmp_path, prod="postgres:latest")), recorded=18)
    assert len(found) == 1 and "names no major version" in found[0]
    (tmp_path / "docker-compose-dev.yml").unlink()
    found = problems(postgres_pins(tmp_path), recorded=18)
    assert any(f.startswith("docker-compose-dev.yml: no `image: postgres:<major>` line") for f in found)
