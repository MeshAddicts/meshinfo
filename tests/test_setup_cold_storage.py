"""scripts/setup-cold-storage.sh: what can be checked without root.

Two kinds of test. The text-level ones hold the script against the things it
must agree with — the fstab lines ZFS.md documents, the paths the cold overlay
binds, the dataset properties of the script it delegates to, the docs that
name it — and run everywhere. The bash-level ones source the script (its
`main` only runs when it is executed) and call its pure helpers: sizes, the
free-space simulation, paths, .env editing, config.toml reading, the
per-distribution hints. They need bash and a POSIX system, which CI has.

What needs root, loop devices, btrfs or Docker — the layouts, the refusals,
grow, status, an end-to-end move — is exercised by tests/cold_storage_lab/run.sh
in a privileged container; the ZFS layout there against stand-ins for zpool
and zfs, and on a real pool where the kernel the lab runs on has ZFS.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "setup-cold-storage.sh"
ZFS_SCRIPT = REPO / "scripts" / "setup-zfs-datasets.sh"
GIB = 1024 ** 3
MIB = 1024 ** 2

BASH = shutil.which("bash")
needs_bash = pytest.mark.skipif(
    sys.platform == "win32" or BASH is None, reason="sources the script: needs bash on a POSIX system"
)


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _constant(name: str) -> str:
    """NAME='value' or NAME=value at the start of a line of the script."""
    match = re.search(rf"^{name}=(?:'([^']*)'|(\S+))", _text(SCRIPT), re.MULTILINE)
    assert match, f"{name} is not assigned in {SCRIPT.name}"
    return match.group(1) if match.group(1) is not None else match.group(2)


def sh(snippet: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run snippet in a bash that has sourced the script (so `set -euo
    pipefail` is on); args arrive as $1, $2, ..."""
    # $0 must not be the script: its last lines run main when it is executed
    # rather than sourced, and tell the two apart by comparing $0.
    return subprocess.run(
        [BASH, "-c", f'source "$1"; shift; {snippet}', "sourced-by-the-tests", str(SCRIPT), *args],
        capture_output=True, text=True, check=check,
    )


def out(snippet: str, *args: str) -> str:
    return sh(snippet, *args).stdout.rstrip("\n")


def script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True, stdin=subprocess.DEVNULL)


def _tool(directory: Path, name: str, body: str) -> None:
    """An executable stand-in for a command, for a directory put first on PATH."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8", newline="\n")
    os.chmod(path, 0o755)


# ── text level: the script against what it must agree with ───────────────────

def _documented_fstab_lines() -> dict:
    lines = re.findall(r"^\s*echo '([^']+)' \| sudo tee -a /etc/fstab$", _text(REPO / "ZFS.md"), re.MULTILINE)
    by_kind = {("image" if "loop" in line.split()[3].split(",") else "device"): line for line in lines}
    assert set(by_kind) == {"image", "device"}, f"ZFS.md should document one fstab line each for a device and an image: {lines}"
    return by_kind


def test_fstab_options_are_the_ones_zfs_md_documents():
    documented = _documented_fstab_lines()
    assert documented["device"].split() == [
        f"LABEL={_constant('LABEL')}", _constant("DEFAULT_MOUNTPOINT"), "btrfs", _constant("FSTAB_OPTS_DEVICE"), "0", "0"]
    assert documented["image"].split() == [
        _constant("DEFAULT_IMAGE"), _constant("DEFAULT_MOUNTPOINT"), "btrfs", _constant("FSTAB_OPTS_IMAGE"), "0", "0"]


def test_an_image_is_kept_from_discard_and_from_fstrim():
    # Either one hands the preallocation of the image back to the filesystem
    # underneath, and the job's free-space guard then measures room that is
    # not there.
    options = _constant("FSTAB_OPTS_IMAGE").split(",")
    assert "nodiscard" in options and "X-fstrim.notrim" in options
    assert "X-fstrim.notrim" in _text(REPO / "ZFS.md")


@needs_bash
def test_fstab_lines_are_the_documented_ones_to_the_letter():
    documented = _documented_fstab_lines()
    assert out('fstab_line_device "$DEFAULT_MOUNTPOINT"') == documented["device"]
    assert out('fstab_line_image "$DEFAULT_IMAGE" "$DEFAULT_MOUNTPOINT"') == documented["image"]


def test_paths_are_the_ones_the_cold_overlay_binds():
    overlay = _text(REPO / "docker-compose.cold.yml")
    assert f":{_constant('PG_COLD_PATH')}\n" in overlay
    assert f":{_constant('APP_COLD_PATH')}:ro\n" in overlay
    assert _constant("OVERLAY") == "docker-compose.cold.yml"
    assert (REPO / _constant("FULL_ZFS_OVERLAY")).is_file()


def test_the_two_remaining_steps_are_the_documented_config_lines():
    text = _text(SCRIPT)
    assert "       enabled = true\n" in text
    assert '       cold_filesystem = "$APP_COLD_PATH"\n' in text
    assert "       docker compose up -d\n" in text
    assert f'cold_filesystem = "{_constant("APP_COLD_PATH")}"' in _text(REPO / "ZFS.md")


def test_config_toml_is_only_ever_read():
    # No command of the script may have config.toml as the thing it writes,
    # edits, copies over, moves or removes.
    writers = re.compile(r"(>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\binstall\b|\bchmod\b|\bchown\b)[^|;&\n]*config\.toml")
    offending = [line for line in _text(SCRIPT).splitlines()
                 if not line.lstrip().startswith("#") and writers.search(line)]
    assert offending == []


def test_awk_programs_do_without_posix_character_classes():
    # mawk 1.3.3, the awk of older Debian and Ubuntu, does not know
    # [[:space:]] and friends: a program that uses one silently matches
    # nothing there, and .env would be appended to instead of edited.
    programs = re.findall(r"\bawk\b((?:[^'\n]*'[^']*')+)", _text(SCRIPT))
    assert len(programs) >= 12, "the awk programs of the script were not found"
    assert [program for program in programs if "[[:" in program] == []


def test_cold_dataset_properties_match_the_script_it_delegates_to():
    def props(path: Path, name: str) -> list:
        match = re.search(rf"^{name}=\(([^)]*)\)", _text(path), re.MULTILINE)
        assert match, f"{name} not found in {path.name}"
        return match.group(1).split()
    assert props(SCRIPT, "ZFS_COLD_PROPS") == props(ZFS_SCRIPT, "COLD_PROPS")


def test_mkfs_is_never_told_to_force():
    # mkfs.btrfs without -f is the last thing that refuses a device carrying
    # a signature that no probe named.
    for line in _text(SCRIPT).splitlines():
        if "mkfs.btrfs" in line and not line.lstrip().startswith("#"):
            assert not re.search(r"(^|\s)(-f|--force)\b", line.split("mkfs.btrfs", 1)[1]), line


def test_status_and_grow_agree_on_when_a_filesystem_is_smaller_than_its_image():
    # status, the branch of grow that finishes an earlier one, and the check
    # after the resize ask the same question. With different answers a grow
    # is reported as unfinished and refused as finished at the same time.
    comparisons = re.findall(r"-lt \$\(\((\w+) - (\w+)\)\)", _text(SCRIPT))
    assert comparisons == [("image_bytes", "FS_SLACK"), ("current", "FS_SLACK"), ("new", "FS_SLACK")]
    # ... with a margin below the smallest step grow can be asked for (1 MiB),
    # or a grow by that step that stopped half-way would count as finished
    assert "\nFS_SLACK=$((64 * 1024))\n" in _text(SCRIPT)


def test_tiering_defaults_match_the_job():
    from storage.db.tiering import TIERABLE_TABLES, TieringPolicy
    assert int(_constant("DEFAULT_MIN_FREE_MB")) == TieringPolicy.min_free_mb
    assert int(_constant("DEFAULT_COLD_AFTER_MONTHS")) == TieringPolicy.cold_after_months
    assert _constant("DEFAULT_COLD_TABLESPACE") == TieringPolicy.cold_tablespace
    # the two tables the size query knows, in the job's own order
    assert tuple(TIERABLE_TABLES) == ("mqtt_messages", "packet_receptions")
    assert 'tables="mqtt_messages,packet_receptions"' in _text(SCRIPT)


@pytest.mark.parametrize("doc", ["ZFS.md", "README.md", "POSTGRES.md", "UPGRADING.md"])
def test_the_docs_name_the_script(doc):
    assert "setup-cold-storage.sh" in _text(REPO / doc)


def test_env_backups_are_ignored_by_git():
    assert ".env.bak-*" in _text(REPO / ".gitignore").split()


# ── bash level ────────────────────────────────────────────────────────────────

@needs_bash
def test_syntax():
    subprocess.run([BASH, "-n", str(SCRIPT)], check=True)


@needs_bash
def test_shellcheck():
    shellcheck = shutil.which("shellcheck")
    if shellcheck is None:
        pytest.skip("shellcheck is not installed")
    result = subprocess.run([shellcheck, str(SCRIPT)], capture_output=True, text=True,
                            env={**os.environ, "LC_ALL": "C.UTF-8"})
    assert result.returncode == 0, result.stdout


@needs_bash
def test_help_names_every_flag_and_subcommand():
    result = script("--help")
    assert result.returncode == 0
    for word in ("--existing", "--device", "--zfs", "--subvolume", "--image", "--mountpoint", "--size", "--force",
                 "--project-dir", "--no-env", "--yes", "--dry-run", "status", "grow", "--to"):
        assert word in result.stdout, word


@needs_bash
def test_refuses_without_root():
    if os.geteuid() == 0:
        pytest.skip("running as root")
    for args in (["--dry-run"], ["status"], ["grow", "--to", "8G"]):
        result = script(*args)
        assert result.returncode == 1, args
        assert "needs root" in result.stderr, args


@needs_bash
@pytest.mark.parametrize("args,message", [
    (["--bogus"], "unknown argument: --bogus"),
    (["--image", "/a.img", "--device", "/dev/sdz"], "different layouts"),
    (["--device", "/dev/sdz", "--size", "4G"], "does not apply to --device"),
    (["--force"], "only applies to --device"),
    (["--size", "20GB"], "--size 20GB"),
    (["--size", "8388608T"], "--size 8388608T"),
    (["--mountpoint", "srv/cold"], "must be an absolute path"),
    (["--mountpoint", "/srv/cold storage"], "must be an absolute path"),
    (["--mountpoint", "/srv/cold:1"], "must be an absolute path"),
    (["--mountpoint", "/srv/../etc/cold"], "must be an absolute path"),
    (["--image", "/var/lib/my image.img"], "the image path"),
    (["--existing", "/a", "--mountpoint", "/b"], "leave --mountpoint out"),
    (["--mountpoint"], "--mountpoint needs a value"),
    (["--zfs", "tank"], "names a pool, not a dataset"),
    (["--zfs", "/tank/cold"], "takes a dataset name"),
    (["--zfs", "tank/cold/"], "must not end with /"),
    (["--zfs", "tank/cold data"], "dataset names made of letters, digits and . _ - : only"),   # ZFS takes it; findmnt -r writes it \x20
    (["--zfs", "tank/cold@monday"], "dataset names made of letters, digits and . _ - : only"),
    (["--to", "8G"], "belongs to the grow subcommand"),
    (["grow"], "grow needs --to"),
    (["grow", "--to", "lots"], "--to lots"),
    (["grow", "--to", "8G", "--image", "/a.img"], "grow takes"),
    (["status", "--yes"], "status takes"),
])
def test_usage_errors(args, message):
    # none of them needs root: they are told apart before anything is looked at
    result = script(*args)
    assert result.returncode == 2, result.stderr
    assert message in result.stderr


@needs_bash
@pytest.mark.parametrize("text,expected", [
    ("20", 20 * GIB), ("20G", 20 * GIB), ("20GiB", 20 * GIB), ("20g", 20 * GIB),
    ("20480M", 20 * GIB), ("512MiB", 512 * MIB), ("1T", 1024 * GIB), ("08", 8 * GIB),
    ("8388607T", 8388607 * 1024 * GIB),
])
def test_parse_size(text, expected):
    assert int(out('parse_size "$1"', text)) == expected


@needs_bash
@pytest.mark.parametrize("text", ["", "20GB", "1.5G", "G", "-4G", "4 G", "20K", "1e3", "99999999999G", "8388608T"])
def test_parse_size_rejects(text):
    assert sh('parse_size "$1"', text, check=False).returncode != 0


@needs_bash
@pytest.mark.parametrize("number,expected", [
    (0, "0 B"), (1023, "1023 B"), (1536, "1.5 KiB"), (20 * GIB, "20.0 GiB"), (3 * 1024 * GIB // 2, "1.5 TiB"),
])
def test_human_bytes(number, expected):
    assert out('human_bytes "$1"', str(number)) == expected


def _simulate(rows, min_free, ratio=4):
    lines = "".join(f"{name} {size}\n" for name, size in rows)
    result = subprocess.run([BASH, "-c", 'source "$1"; simulate_guard "$2" "$3"', "sourced-by-the-tests",
                             str(SCRIPT), str(min_free), str(ratio)],
                            input=lines, capture_output=True, text=True, check=True)
    needed, name, size, inside, count, total = result.stdout.split()
    return int(needed), name, int(size), int(inside), int(count), int(total)


@needs_bash
def test_simulate_guard_finds_the_tightest_move():
    # a: 0 inside + 1000 + 500 = 1500; b: 250 inside + 3000 + 500 = 3750; c: 1000 inside + 2000 + 500 = 3500
    assert _simulate([("a", 1000), ("b", 3000), ("c", 2000)], 500) == (3750, "b", 3000, 250, 3, 6000)
    # the last move can be the tightest one: what came before sits inside at a quarter
    assert _simulate([("a", 4000), ("b", 4000), ("c", 4000)], 100) == (6100, "c", 4000, 2000, 3, 12000)
    assert _simulate([], 500) == (0, "-", 0, 0, 0, 0)


@needs_bash
def test_simulate_guard_at_archive_scale():
    month = 12 * GIB  # 24 months of 12 GiB partitions, min_free_mb = 2048
    needed, name, _, inside, count, total = _simulate([(f"m{i:02d}", month) for i in range(24)], 2048 * MIB)
    assert (name, count, total) == ("m23", 24, 24 * month)
    assert inside == 23 * month // 4
    assert needed == 23 * month // 4 + month + 2048 * MIB


@needs_bash
@pytest.mark.parametrize("needed,expected", [
    (0, 4 * GIB),                                   # the minimum
    (2 * GIB, 4 * GIB),                             # (2 GiB + 560 MiB) * 1.1 = 2.8 GiB -> the minimum
    (8_000_000_000, 9 * GIB),                       # (8e9 + 560 MiB) * 1.1 = 8.8 GiB
    (40 * GIB, 45 * GIB),                           # (40 GiB + 560 MiB) * 1.1 = 44.6 GiB
    (46 * GIB, 53 * GIB),                           # above 50 GiB a new btrfs keeps 2 GiB: (46 GiB + 2100 MiB) * 1.1 = 52.9 GiB
    (100 * GIB, 113 * GIB),                         # (100 GiB + 2100 MiB) * 1.1 = 112.3 GiB
])
def test_image_bytes_for(needed, expected):
    assert int(out('image_bytes_for "$1"', str(needed))) == expected


@needs_bash
def test_image_size_leaves_what_the_guard_needs_free_on_a_new_btrfs():
    # Measured (tests/cold_storage_lab): a new btrfs reports its size minus 529 MiB as
    # free up to 50 GiB and minus 2065 MiB above.
    for needed in (0, 3 * GIB, 7 * GIB, 30 * GIB, 44 * GIB, 45 * GIB, 46 * GIB, 60 * GIB, 300 * GIB):
        size = int(out('image_bytes_for "$1"', str(needed)))
        free_when_new = size - (529 * MIB if size <= 50 * GIB else 2065 * MIB)
        assert free_when_new >= needed, (needed, size)


@needs_bash
def test_the_smallest_size_on_which_a_move_can_pass(tmp_path):
    # min_free_mb itself has to be free on a new btrfs before any month fits:
    # (2048 MiB + 560 MiB) * 1.1, in whole GiB
    assert int(out('PROJECT_DIR="$1"; smallest_useful_bytes', str(tmp_path))) == 3 * GIB
    (tmp_path / "config.toml").write_text("[storage.tiering]\nmin_free_mb = 8192\n", encoding="utf-8")
    assert int(out('PROJECT_DIR="$1"; smallest_useful_bytes', str(tmp_path))) == 10 * GIB
    note = out('PROJECT_DIR="$1"; too_small_note "$2" "$3"', str(tmp_path), str(2 * GIB), str(10 * GIB))
    assert "2.0 GiB is too small to ever take a month" in note and "The smallest that makes sense here is 10.0 GiB" in note


@needs_bash
def test_fstab_entries_and_key(tmp_path):
    base = tmp_path.resolve()
    (base / "real").mkdir()
    (base / "link").symlink_to(base / "real")
    fstab = base / "fstab"
    fstab.write_text(
        f"# {base}/cold in a comment\n"
        f"#/dev/sdx {base}/cold btrfs defaults 0 0\n"
        "UUID=1234  /  ext4  defaults  0 1\n"
        f"{base}/cold.img\t{base}/cold   btrfs loop,nodiscard  0 0\n"
        f"/dev/sdb1 {base}/cold-old btrfs defaults 0 0\n"
        f"LABEL=x {base}/link/pgcold btrfs noatime 0 0\n"
        "tmpfs none swap sw 0 0\n", encoding="utf-8")
    entry = out('fstab_entries "$1" "$2"', str(fstab), f"{base}/cold")
    assert entry == f"{base}/cold.img\t{base}/cold   btrfs loop,nodiscard  0 0"
    assert out('fstab_key "$1"', entry) == f"{base}/cold.img {base}/cold btrfs loop,nodiscard"
    assert out('fstab_entries "$1" "$2"', str(fstab), f"{base}/none") == ""
    assert out('fstab_entries "$1" /srv/none', str(base / "missing")) == ""
    # a line that spells the mountpoint through a symlink is the same line
    through = out('fstab_entries "$1" "$2"', str(fstab), f"{base}/real/pgcold")
    assert through == f"LABEL=x {base}/link/pgcold btrfs noatime 0 0"
    assert out('fstab_key "$1"', through) == f"LABEL=x {base}/real/pgcold btrfs noatime"
    # ... and where a file is mounted is found whichever way it is spelled
    assert out('fstab_targets_of "$1" "$2"', str(fstab), f"{base}/cold.img") == f"{base}/cold"
    assert out('fstab_targets_of "$1" "$2"', str(fstab), f"{base}/other.img") == ""


@needs_bash
@pytest.mark.parametrize("path,ok", [
    ("/srv/meshinfo/pgcold", True), ("/mnt/tank_1/cold-data.v2", True), ("/", False), ("srv/cold", False),
    ("/srv/cold storage", False), ("/srv/cold:1", False), ("/srv/$HOME", False), ("/srv/a#b", False), ("/srv/a'b", False),
    ("/srv/../etc", False), ("/srv/a/..", False), ("/srv/a@b", False), ("/srv/a+b", False), ("/srv/a=b", False),
    ("/srv/a,b", False), ("/srv/a%b", False), ("/srv/..data", True),
])
def test_plain_path(path, ok):
    assert (sh('plain_path "$1"', path, check=False).returncode == 0) is ok


@needs_bash
def test_paths(tmp_path):
    assert out('normalize_path "$1"', "/srv/meshinfo/pgcold///") == "/srv/meshinfo/pgcold"
    assert out('normalize_path "$1"', "/srv//meshinfo/./pgcold/.") == "/srv/meshinfo/pgcold"
    assert out('normalize_path "$1"', "/") == "/"
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    resolved = str(real.resolve())
    assert out('canonical_path "$1"', str(tmp_path / "link" / "a" / "b")) == resolved + "/a/b"
    assert out('canonical_path "$1"', str(tmp_path / "link")) == resolved
    assert out('canonical_path "$1"', "/does-not-exist-here/x") == "/does-not-exist-here/x"
    assert out('canonical_path "$1"', "/") == "/"
    assert out('nearest_existing "$1"', str(real / "a" / "b")) == str(real)
    # what .env says is the cold directory when it leads there, however it is spelled
    same = lambda value: sh('MOUNTPOINT="$2"; same_directory "$1"', value, resolved + "/pgcold", check=False).returncode == 0  # noqa: E731
    assert same(resolved + "/pgcold")
    assert same(str(tmp_path / "link") + "//pgcold/")
    assert not same(resolved + "/other")
    assert not same("pgcold")                            # a relative path never is


@needs_bash
def test_the_script_does_not_trip_over_cdpath():
    # With CDPATH exported, cd prints where it went, and $(cd ... && pwd)
    # would hold two lines.
    result = subprocess.run([BASH, "-c", 'source "$1"; printf "%s" "$SCRIPT_DIR"', "sourced-by-the-tests",
                             "scripts/setup-cold-storage.sh"],
                            cwd=REPO, env={**os.environ, "CDPATH": ".:/"}, capture_output=True, text=True, check=True)
    assert result.stdout == str(SCRIPT.parent)


@needs_bash
def test_real_tool(tmp_path):
    (tmp_path / "plain").write_text("#!/bin/sh\n", encoding="utf-8")
    (tmp_path / "busybox").write_text("#!/bin/sh\n", encoding="utf-8")
    os.chmod(tmp_path / "busybox", 0o755)
    (tmp_path / "applet").symlink_to(tmp_path / "busybox")
    tool = lambda name: sh('PATH="$1:$PATH"; real_tool "$2"', str(tmp_path), name, check=False).returncode == 0  # noqa: E731
    assert not tool("no-such-tool-here")
    assert not tool("plain")                             # on PATH, but it cannot be run
    os.chmod(tmp_path / "plain", 0o755)
    assert tool("plain")
    assert not tool("applet")                            # a busybox applet is not the tool


@needs_bash
@pytest.mark.parametrize("os_release,family", [
    ('ID=debian\n', "debian"),
    ('ID=ubuntu\nID_LIKE=debian\n', "debian"),
    ('ID=somethingelse\nID_LIKE="ubuntu debian"\n', "debian"),
    ('ID=fedora\n', "fedora"),
    ('ID="rocky"\nID_LIKE="rhel centos fedora"\n', "rhel"),
    ('ID=somethingelse\nID_LIKE="rhel fedora"\n', "rhel"),
    ('ID=somethingelse\nID_LIKE=fedora\n', "fedora"),
    ('ID="opensuse-leap"\nID_LIKE="suse opensuse"\n', "suse"),
    ('ID=arch\n', "arch"),
    ('ID=manjaro\nID_LIKE=arch\n', "arch"),
    ('ID=alpine\n', "alpine"),
    ('ID=somethingelse\n', "unknown"),
    ('', "unknown"),
])
def test_os_family(tmp_path, os_release, family):
    file = tmp_path / "os-release"
    file.write_text(os_release, encoding="utf-8")
    assert out('OS_RELEASE="$1"; os_family', str(file)) == family


@needs_bash
def test_os_family_without_the_file(tmp_path):
    assert out('OS_RELEASE="$1"; os_family', str(tmp_path / "missing")) == "unknown"


@needs_bash
@pytest.mark.parametrize("family,what,expected", [
    ("debian", "btrfs", "apt-get install btrfs-progs"),
    ("fedora", "btrfs", "dnf install btrfs-progs"),
    ("suse", "btrfs", "zypper install btrfsprogs"),
    ("arch", "btrfs", "pacman -S btrfs-progs"),
    ("alpine", "btrfs", "apk add btrfs-progs"),
    ("unknown", "btrfs", "install the btrfs-progs package with your package manager"),
    ("debian", "util", "apt-get install util-linux mount"),
    ("rhel", "util", "dnf install util-linux"),
    ("debian", "zfs", "apt-get install zfsutils-linux"),
    ("debian", "compsize", "apt-get install btrfs-compsize"),
    ("fedora", "compsize", "dnf install compsize"),
])
def test_install_hint(family, what, expected):
    assert out('install_hint "$1" "$2"', family, what) == expected


@needs_bash
def test_install_hint_for_the_rhel_family_points_away_from_btrfs():
    hint = out("install_hint rhel btrfs")
    assert "--zfs" in hint and "--existing" in hint


@needs_bash
def test_install_hint_always_says_something():
    for family in ("debian", "fedora", "rhel", "suse", "arch", "alpine", "unknown"):
        for what in ("btrfs", "util", "zfs", "compsize"):
            assert out('install_hint "$1" "$2"', family, what), (family, what)


@needs_bash
def test_env_get(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# COMPOSE_FILE=commented.yml\n"
        "#MESHINFO_PGCOLD_DIR=/commented\n"
        "PG_SHARED_BUFFERS=256MB   # a comment\n"
        'QUOTED="a value # not a comment"\n'
        "SINGLE='x y'\n"
        'FILES="a.yml:b.yml"   # the "prod" files\n'
        "PLACE='/srv/x'  # don't move\n"
        "export EXPORTED=yes\n"
        "  SPACED = padded  \n"
        "TWICE=first\n"
        "TWICE=second\r\n"
        "EMPTY=\n", encoding="utf-8", newline="")
    get = lambda key: sh('env_get "$1" "$2"', str(env), key, check=False)  # noqa: E731
    assert get("PG_SHARED_BUFFERS").stdout == "256MB\n"
    assert get("QUOTED").stdout == "a value # not a comment\n"
    assert get("SINGLE").stdout == "x y\n"
    assert get("FILES").stdout == "a.yml:b.yml\n"        # the value ends at its closing quote,
    assert get("PLACE").stdout == "/srv/x\n"             # whatever the comment after it holds
    assert get("EXPORTED").stdout == "yes\n"
    assert get("SPACED").stdout == "padded\n"
    assert get("TWICE").stdout == "second\n"
    assert (get("EMPTY").returncode, get("EMPTY").stdout) == (0, "\n")
    assert get("COMPOSE_FILE").returncode == 1          # only in a comment
    assert get("MESHINFO_PGCOLD_DIR").returncode == 1
    assert get("PG_SHARED").returncode == 1             # a prefix of another key
    assert sh('env_get "$1" X', str(tmp_path / "missing"), check=False).returncode == 1


@needs_bash
def test_env_set(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# keep me\n"
        "COMPOSE_FILE=old.yml\n"
        'QUOTED="old"\r\n'
        'FILES="a.yml"   # the "prod" files\n'
        "COMPOSE_FILE=docker-compose.yml   # the last one wins\n"
        "\n"
        "OTHER=1", encoding="utf-8", newline="")
    os.chmod(env, 0o600)
    inode = env.stat().st_ino
    sh('env_set "$1" COMPOSE_FILE "docker-compose.yml:docker-compose.cold.yml"; env_set "$1" QUOTED "new & \\\\1 value"; '
       'env_set "$1" FILES "a.yml:b.yml"; env_set "$1" MESHINFO_PGCOLD_DIR /srv/meshinfo/pgcold', str(env))
    assert env.read_bytes().decode("utf-8") == (
        "# keep me\n"
        "COMPOSE_FILE=old.yml\n"
        'QUOTED="new & \\1 value"\r\n'
        'FILES="a.yml:b.yml"   # the "prod" files\n'
        "COMPOSE_FILE=docker-compose.yml:docker-compose.cold.yml   # the last one wins\n"
        "\n"
        "OTHER=1\n"
        "MESHINFO_PGCOLD_DIR=/srv/meshinfo/pgcold\n")
    assert (env.stat().st_ino, env.stat().st_mode & 0o777) == (inode, 0o600)


@needs_bash
def test_env_set_on_an_empty_file(tmp_path):
    env = tmp_path / ".env"
    env.write_text("", encoding="utf-8")
    sh('env_set "$1" COMPOSE_FILE a.yml; env_set "$1" MESHINFO_PGCOLD_DIR /srv/x', str(env))
    assert env.read_text(encoding="utf-8") == "COMPOSE_FILE=a.yml\nMESHINFO_PGCOLD_DIR=/srv/x\n"


@needs_bash
@pytest.mark.parametrize("current,separator,override,status,expected", [
    ("", ":", "", 0, "docker-compose.yml:docker-compose.cold.yml"),
    ("", ":", "docker-compose.override.yml", 0, "docker-compose.yml:docker-compose.override.yml:docker-compose.cold.yml"),
    ("", ":", "compose.override.yaml", 0, "docker-compose.yml:compose.override.yaml:docker-compose.cold.yml"),
    ("docker-compose.yml", ":", "docker-compose.override.yml", 0, "docker-compose.yml:docker-compose.cold.yml"),
    ("docker-compose-dev.yml:docker-compose.override.yml", ":", "", 0,
     "docker-compose-dev.yml:docker-compose.override.yml:docker-compose.cold.yml"),
    ("docker-compose.yml;extra.yml", ";", "", 0, "docker-compose.yml;extra.yml;docker-compose.cold.yml"),
    ("docker-compose.yml:docker-compose.cold.yml", ":", "", 3, "docker-compose.yml:docker-compose.cold.yml"),
    ("docker-compose.yml:./docker-compose.cold.yml:x.yml", ":", "", 3, "docker-compose.yml:./docker-compose.cold.yml:x.yml"),
    ("docker-compose.yml:docker-compose.zfs.yml", ":", "", 4, ""),
])
def test_compose_file_with_overlay(current, separator, override, status, expected):
    result = sh('compose_file_with_overlay "$1" "$2" "$3"', current, separator, override, check=False)
    assert (result.returncode, result.stdout.rstrip("\n")) == (status, expected)


@needs_bash
def test_tiering_setting(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text(
        "[storage.postgres]\n"
        "min_free_mb = 1          # another table's\n"
        "\n"
        "  [storage.tiering]   # comment\r\n"
        "enabled = true\n"
        'cold_tablespace = "cold_ts"   # quoted\n'
        "cold_filesystem = '/mnt/meshinfo-cold'\n"
        "min_free_mb = 6000        # refuse below this\r\n"
        'tables = ["mqtt_messages"]  # one of the two\n'
        "\n"
        "[server]\n"
        "cold_after_months = 9\n", encoding="utf-8", newline="")
    get = lambda key: sh('tiering_setting "$1" "$2"', str(config), key, check=False)  # noqa: E731
    raw = lambda key: sh('tiering_raw "$1" "$2"', str(config), key, check=False)  # noqa: E731
    assert get("min_free_mb").stdout == "6000\n"
    assert get("cold_tablespace").stdout == "cold_ts\n"
    assert get("enabled").stdout == "true\n"
    assert get("cold_after_months").returncode == 1     # only in another table
    assert get("min_free").returncode == 1
    assert sh('tiering_setting "$1" enabled', str(tmp_path / "missing"), check=False).returncode == 1
    # as written: the quotes tell a string from a number or a boolean
    assert raw("cold_tablespace").stdout == '"cold_ts"\n'
    assert raw("cold_filesystem").stdout == "'/mnt/meshinfo-cold'\n"
    assert raw("enabled").stdout == "true\n"
    assert raw("tables").stdout == '["mqtt_messages"]\n'


@needs_bash
@pytest.mark.parametrize("value,expected", [
    ("6000", 6000), ("6_000", 6000), ("+6000", 6000), ("0", 0),
    ('"6000"', 2048),                                    # a string, which the job ignores
    ("6000.5", 2048), ("-1", 2048), ("lots", 2048),
])
def test_numeric_settings_are_read_as_the_job_reads_them(tmp_path, value, expected):
    (tmp_path / "config.toml").write_text(f"[storage.tiering]\nmin_free_mb = {value}\n", encoding="utf-8")
    assert int(out('PROJECT_DIR="$1"; numeric_setting min_free_mb 2048', str(tmp_path))) == expected


@needs_bash
def test_a_missing_setting_takes_the_default(tmp_path):
    assert int(out('PROJECT_DIR="$1"; numeric_setting min_free_mb 2048', str(tmp_path))) == 2048
    assert out('PROJECT_DIR="$1"; cold_tablespace_name', str(tmp_path)) == "meshinfo_cold"
    (tmp_path / "config.toml").write_text('[storage.tiering]\ncold_tablespace = "archive_2"\n', encoding="utf-8")
    assert out('PROJECT_DIR="$1"; cold_tablespace_name', str(tmp_path)) == "archive_2"
    (tmp_path / "config.toml").write_text('[storage.tiering]\ncold_tablespace = "not a name; --"\n', encoding="utf-8")
    assert out('PROJECT_DIR="$1"; cold_tablespace_name', str(tmp_path)) == "meshinfo_cold"


@needs_bash
@pytest.mark.parametrize("config,unreadable", [
    ("[storage.tiering]\nenabled = true\n", False),
    ("[server]\nport = 1\n", False),
    ("", False),
    ("# storage.tiering.enabled = true\n", False),
    ("storage.tiering.enabled = true\n", True),                              # a dotted key
    ("[storage]\ntiering = { enabled = true }\n", True),                     # an inline table
    ("[ storage.tiering ]\nenabled = true\n", True),                         # a header written another way
    ('[storage."tiering"]\nenabled = true\n', True),
    ('[storage.tiering]\n"enabled" = true\n', True),                         # quoted keys
    ("[storage.tiering]\n'min_free_mb' = 4096\n", True),
])
def test_tiering_written_in_a_form_the_script_does_not_read_is_noticed(tmp_path, config, unreadable):
    file = tmp_path / "config.toml"
    file.write_text(config, encoding="utf-8")
    assert (sh('tiering_unreadable "$1"', str(file), check=False).returncode == 0) is unreadable


@needs_bash
def test_the_delegated_script_still_ends_its_output_the_way_this_one_cuts_it():
    # apply_zfs drops everything from "Dataset ready:" on (its .env advice, which this script handles itself).
    result = subprocess.run([BASH, str(ZFS_SCRIPT), "--cold-only", "tank/meshinfo-cold", "/srv/meshinfo/pgcold", "--dry-run"],
                            capture_output=True, text=True, env={**os.environ, "PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert "Dataset ready:" in lines
    assert any(line.startswith("Next steps") for line in lines[lines.index("Dataset ready:"):])
    assert "+ zfs create -p tank/meshinfo-cold" in lines
    assert "+ zfs set mountpoint=/srv/meshinfo/pgcold tank/meshinfo-cold" in lines


@needs_bash
def test_fstab_targets_that_are_mounted_are_compared_as_written(tmp_path):
    # A network mount whose server is away hangs whatever looks at it. What
    # is mounted is spelled the way the kernel spells it, without symlinks,
    # so such a line is never resolved; only the others are.
    base = tmp_path.resolve()
    _tool(base / "bin", "findmnt", f"echo /; echo {base}/hung")      # the kernel's list of mount points
    fstab = base / "fstab"
    fstab.write_text(f"server:/export {base}/hung nfs defaults 0 0\n"
                     f"/dev/sdb1 {base}/elsewhere ext4 defaults 0 0\n"
                     f"/dev/sdc1 {base}/cold btrfs defaults 0 0\n", encoding="utf-8")
    resolved = out('LOG="$3"; canonical_path() { printf "%s\\n" "$1" >> "$LOG"; printf "%s\\n" "$1"; }; '
                   'PATH="$1:$PATH"; fstab_entries "$2" "$4" > "$LOG.entries"; cat "$LOG"',
                   str(base / "bin"), str(fstab), str(base / "log"), f"{base}/cold")
    assert resolved.splitlines() == [f"{base}/elsewhere"]
    assert (base / "log.entries").read_text(encoding="utf-8") == f"/dev/sdc1 {base}/cold btrfs defaults 0 0\n"


@needs_bash
@pytest.mark.parametrize("version,means_sa", [
    ("zfs-2.3.9-0+deb13u1\nzfs-kmod-2.3.9-0+deb13u1", True),
    ("zfs-2.3.0-rc1\nzfs-kmod-2.3.0-rc1", True),
    ("zfs-2.2.7-1\nzfs-kmod-2.2.7-1", False),
    ("zfs-2.4.0-1\nzfs-kmod-2.3.9-1", False),             # the userland prints the names, not the module
    ("zfs-2.1.11-1+deb12u1\nzfs-kmod-2.1.11-1+deb12u1", False),
    ("zfs-2.30.1-1\nzfs-kmod-2.30.1-1", False),
    ("", False),
])
def test_only_openzfs_2_3_prints_xattr_sa_as_on(tmp_path, version, means_sa):
    # 2.3 made on mean sa and prints sa as on; before, on meant dir, and from
    # 2.4 zfs get prints sa again.
    (tmp_path / "version.txt").write_text(version + "\n", encoding="utf-8")
    _tool(tmp_path, "zfs", '[ "$1" = version ] || exit 2; cat "$(dirname "$0")/version.txt"')
    assert (sh('PATH="$1:$PATH"; zfs_on_means_sa', str(tmp_path), check=False).returncode == 0) is means_sa


@needs_bash
def test_a_zfs_that_does_not_know_its_version_is_not_2_3(tmp_path):
    _tool(tmp_path, "zfs", "echo 'unrecognized command' >&2; exit 2")
    assert sh('PATH="$1:$PATH"; zfs_on_means_sa', str(tmp_path), check=False).returncode == 1


@needs_bash
@pytest.mark.parametrize("wanted,answer,version,mount_options,has,found", [
    ("compression=zstd-9", "zstd-9\tlocal", "2.2.7", "", True, None),
    ("compression=zstd-9", "lz4\tinherited from tank", "2.2.7", "", False, "lz4"),
    ("xattr=sa", "sa\tlocal", "2.2.7", "", True, None),
    ("xattr=sa", "on\tlocal", "2.3.9", "", True, None),                    # 2.3 prints sa as on
    ("xattr=sa", "on\tdefault", "2.2.7", "", False, "on"),                 # before 2.3, on is dir
    ("atime=off", "off\tlocal", "2.3.9", "rw,noatime,xattr", True, None),
    # zfs on musl reads "atime" into "noatime" and reports the mount's value: ask the mount
    ("atime=off", "on\ttemporary", "2.3.9", "rw,noatime,xattr,noacl,casesensitive", True, None),
    ("atime=off", "on\ttemporary", "2.3.9", "rw,relatime,xattr,noacl", False, "on, as it is mounted"),
    ("atime=off", "on\ttemporary", "2.3.9", "", False, "on, as it is mounted"),
    ("atime=off", "on\tdefault", "2.3.9", "rw,noatime,xattr", False, "on"),   # the property itself says on
    ("recordsize=128K", "", "2.3.9", "", False, ""),                       # zfs get fails
])
def test_a_cold_property_is_not_read_off_zfs_get_alone(tmp_path, wanted, answer, version, mount_options, has, found):
    (tmp_path / "answer.txt").write_text(answer + "\n" if answer else "", encoding="utf-8")
    (tmp_path / "version.txt").write_text(f"zfs-{version}-1\nzfs-kmod-{version}-1\n", encoding="utf-8")
    (tmp_path / "options.txt").write_text(mount_options + "\n" if mount_options else "", encoding="utf-8")
    _tool(tmp_path, "zfs", 'case "$1" in version) cat "$(dirname "$0")/version.txt" ;; '
                           'get) [ -s "$(dirname "$0")/answer.txt" ] || exit 1; cat "$(dirname "$0")/answer.txt" ;; *) exit 2 ;; esac')
    _tool(tmp_path, "findmnt", '[ -s "$(dirname "$0")/options.txt" ] || exit 1; cat "$(dirname "$0")/options.txt"')
    result = sh('PATH="$1:$PATH"; if zfs_has_property tank/cold "$2"; then echo has; else echo "found: $ZFS_FOUND"; fi',
                str(tmp_path), wanted)
    assert result.stdout.rstrip("\n") == ("has" if has else f"found: {found}")


@needs_bash
@pytest.mark.parametrize("mountpoint,lines,expected", [
    ("legacy", "tank/cold /srv/cold zfs defaults,nofail 0 0", "legacy"),          # the line is what mounts it
    ("legacy", "tank/cold /srv/cold zfs zfsutil,nofail 0 0", "legacy-zfsutil"),   # mount turns it down: zfsutil is not for legacy
    ("legacy", "tank/cold /srv/cold zfs nofail,zfsutil 0 0", "legacy-zfsutil"),
    ("/srv/cold", "tank/cold /srv/cold zfs zfsutil,nofail 0 0", "own"),           # the mount ZFS makes itself
    ("/srv/cold", "tank/cold  /srv/cold  zfs  defaults  0 0", "refused"),         # mount turns it down
    ("/srv/cold", "tank/other /srv/cold zfs defaults 0 0", "other"),
    ("/srv/cold", "/dev/sdb1 /srv/cold ext4 defaults 0 0", "other"),
    ("legacy", "tank/cold /srv/cold ext4 defaults 0 0", "other"),
    ("legacy", "tank/cold /srv/cold zfs defaults 0 0\n/dev/sdb1 /srv/cold ext4 defaults 0 0", "other"),
    # the dataset cannot be asked (it is not there, or its pool is not): nothing is said about its mountpoint
    ("", "tank/cold /srv/cold zfs defaults,nofail 0 0", "unknown"),
    ("", "tank/cold /srv/cold zfs zfsutil 0 0", "unknown"),
    ("", "tank/other /srv/cold zfs defaults 0 0", "other"),
])
def test_what_an_fstab_entry_is_to_the_dataset_at_the_cold_directory(tmp_path, mountpoint, lines, expected):
    (tmp_path / "mountpoint.txt").write_text(mountpoint + "\n" if mountpoint else "", encoding="utf-8")
    _tool(tmp_path, "zfs", '[ -s "$(dirname "$0")/mountpoint.txt" ] || exit 1; cat "$(dirname "$0")/mountpoint.txt"')
    assert out('PATH="$1:$PATH"; zfs_fstab_entry "$2" tank/cold', str(tmp_path), lines) == expected


@needs_bash
@pytest.mark.parametrize("kind,need_fstab,need_fallocate,says,never", [
    # the run that made the image may have it deleted again
    ("image", 1, 1, "To back out instead: take the two lines this script added out of /etc/fstab (the file as it was: "
                    "/etc/fstab.bak) and delete /var/lib/cold.img.", "only copy"),
    # an image that was there before is never what to delete: it may hold the months
    ("image", 1, 0, "/var/lib/cold.img was there before this run and stays as it is: once months were moved, it is their "
                    "only copy.", "and delete"),
    ("image", 0, 0, "Do not delete the image to start over unless this is still the first setup", "To back out instead"),
    ("device", 1, 1, "To back out instead: take the two lines this script added out of /etc/fstab (the file as it was: "
                     "/etc/fstab.bak).", "delete"),
    ("device", 0, 0, "Once months were moved, the filesystem on /dev/sdx1 is their only copy.", "To back out instead"),
])
def test_what_a_failed_mount_leaves_behind(kind, need_fstab, need_fallocate, says, never):
    note = out('KIND="$1"; NEED_FSTAB="$2"; NEED_FALLOCATE="$3"; FSTAB_BACKUP=/etc/fstab.bak; '
               'IMAGE=/var/lib/cold.img; DEVICE=/dev/sdx1; mount_failed_note', kind, str(need_fstab), str(need_fallocate))
    assert says in note
    assert never not in note


@needs_bash
@pytest.mark.parametrize("kind,why", [
    ("zfs", "the layout here is the ZFS dataset tank/cold — a dataset takes its room from the pool as it fills"),
    ("subvolume", "a subvolume shares the room of its filesystem"),
    ("device", "the layout here is btrfs on the block device /dev/sdx1 — the filesystem takes the whole device"),
    ("existing", "no storage is created"),
])
def test_a_size_that_is_not_used_is_said_to_be(kind, why):
    note = out('KIND="$1"; SIZE_ARG=40G; ZFS_DATASET=tank/cold; DEVICE=/dev/sdx1; IMAGE=""; size_not_used_note', kind)
    assert note.startswith("--size 40G is not used: it is the size of a new loop image")
    assert why in note


def _away_note(tmp_path: Path, relations: str, claims: str = "") -> str:
    """storage_away_note for a database that reports RELATIONS on the cold
    tablespace, on a host where the datasets in CLAIMS have the cold directory
    as their mountpoint without being mounted."""
    listing = "".join(f"{name}\t/srv/meshinfo/pgcold\tno\ton\n" for name in claims.split())
    (tmp_path / "bin").mkdir(exist_ok=True)
    (tmp_path / "bin" / "list.txt").write_text(listing, encoding="utf-8")
    _tool(tmp_path / "bin", "zfs", '[ "$1" = list ] || exit 2; cat "$(dirname "$0")/list.txt"')
    return out('PATH="$3:$PATH"; PROJECT_DIR="$1"; MOUNTPOINT=/srv/meshinfo/pgcold; RELATIONS="$2"; '
               'cold_tablespace_relations() { printf "%s" "$RELATIONS"; }; storage_away_note',
               str(tmp_path), relations, str(tmp_path / "bin"))


@needs_bash
@pytest.mark.parametrize("relations,says", [
    ("0", "already has the tablespace meshinfo_cold, with nothing stored on it yet:"),
    ("3", "already has the tablespace meshinfo_cold, which holds 3 of its tables and indexes:"),
    ("", "already has the tablespace meshinfo_cold: PostgreSQL expects"),          # the catalog did not answer
])
def test_bringing_the_filesystem_back_is_always_the_first_advice(tmp_path, relations, says):
    # A tablespace with nothing on it is the ordinary state of a young install
    # (the job creates it before any month is due), not a leftover: with its
    # filesystem only not mounted, dropping it would leave the PG_ directory
    # behind on that filesystem and take away the one sign that it belongs here.
    note = _away_note(tmp_path, relations)
    assert says in note
    # fstab has no line for the directory in the states this is printed in, so "mount DIR" is not among them
    assert ("Bring it back (for a ZFS dataset zpool import and zfs mount -a, after zfs load-key NAME where it is "
            "encrypted; otherwise mount the filesystem that holds it), or pass the --mountpoint where it is, and run "
            "this again.") in note
    assert "mount /srv/meshinfo/pgcold" not in note
    assert "leftover" not in note
    # With the filesystem away PostgreSQL drops a tablespace that is in use
    # without complaint: dropping is named only when nothing is on it, and
    # only for a filesystem that is gone for good.
    assert ("DROP TABLESPACE meshinfo_cold" in note) is (relations == "0")
    if relations == "0":
        assert note.index("Bring it back") < note.index("Only if that filesystem is gone for good") < note.index("DROP TABLESPACE")
        assert "remove the PG_... directory on it" in note


@needs_bash
@pytest.mark.parametrize("relations", ["0", "3", ""])
def test_a_dataset_that_is_not_mounted_is_what_to_mount_when_the_tablespace_is_away(tmp_path, relations):
    note = _away_note(tmp_path, relations, "tank/meshinfo-cold")
    # -l: zfs mount NAME fails for a dataset whose key is not loaded. And the
    # one dataset that has the path may be a copy: mounting it is not said
    # without the condition.
    assert ("and the ZFS dataset tank/meshinfo-cold, which has /srv/meshinfo/pgcold as its mountpoint, is not mounted. "
            "If it is the cold dataset, mount it (zfs mount -l tank/meshinfo-cold; -l loads the key of one that is "
            "encrypted) and run this again. If it is a copy (received from another pool), the cold dataset itself is "
            "what is away: give the copy another mountpoint or canmount=off, then bring the cold dataset's pool back "
            "(zpool import).") in note
    assert "Bring it back" not in note
    several = _away_note(tmp_path, relations, "backup/copy tank/meshinfo-cold")
    assert "and the ZFS datasets backup/copy, tank/meshinfo-cold, which have" in several
    assert "Mount the one that is the cold dataset (zfs mount -l NAME; -l loads the key of one that is encrypted)" in several


def _stack_docker(directory: Path, location: str) -> None:
    """A docker that plays a running stack whose database answers the
    script's question for the place of the cold tablespace with LOCATION."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "location.txt").write_text(location + "\n" if location else "", encoding="utf-8")
    _tool(directory, "docker",
          'here="$(dirname "$0")"\n'
          'case "$1 $2" in\n'
          '  "info "*) exit 0 ;;\n'
          '  "compose ps") echo cid ;;\n'
          '  "ps "*) echo cid ;;\n'
          '  "inspect "*) echo true ;;\n'
          '  "exec "*) if grep -q pg_tablespace_location; then cat "$here/location.txt"; else echo 1; fi ;;\n'
          '  *) exit 2 ;;\n'
          'esac')


@needs_bash
@pytest.mark.parametrize("location,made,place", [
    ("/var/lib/postgresql/cold", "PG_18_202506291", "here"),          # the default: its directory at the top
    ("/var/lib/postgresql/cold", "", "away"),
    ("", "", "away"),                                                  # the database does not say: as before
    ("/var/lib/postgresql/cold/ts", "ts/PG_18_202506291", "here"),    # cold_tablespace_location below the bind
    ("/var/lib/postgresql/cold/ts", "ts", "away"),
    ("/var/lib/postgresql/cold/ts", "", "away"),
    ("/var/lib/postgresql/cold/../x", "", "away"),                    # never followed out of the cold directory
    ("/var/lib/postgresql/coldx/ts", "", "elsewhere"),                # not the bind: only looks like it
    ("/data/elsewhere", "", "elsewhere"),
])
def test_where_the_cold_tablespace_is_seen_from_the_host(tmp_path, location, made, place):
    cold = tmp_path / "cold"
    cold.mkdir()
    if made:
        (cold / made).mkdir(parents=True)
    _stack_docker(tmp_path / "bin", location)
    result = out('PATH="$1:$PATH"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; DB_RETRY_PAUSE=0; cold_tablespace_place; '
                 'echo "$TABLESPACE_PLACE|$TABLESPACE_LOCATION"', str(tmp_path / "bin"), str(tmp_path), str(cold))
    # with its directory at the top of the cold directory the database is not asked at all
    asked = "" if made.startswith("PG_") else location
    assert result == f"{place}|{asked}"


@needs_bash
def test_a_tablespace_at_a_path_the_overlay_does_not_bind_is_said_to_be_there(tmp_path):
    cold = tmp_path / "cold"
    cold.mkdir()
    _stack_docker(tmp_path / "bin", "/data/elsewhere")
    result = sh('PATH="$1:$PATH"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; DB_RETRY_PAUSE=0; TABLESPACE_STATE=""; '
                'refuse_tablespace_not_here', str(tmp_path / "bin"), str(tmp_path), str(cold), check=False)
    assert result.returncode == 1
    assert "already has the tablespace meshinfo_cold at /data/elsewhere, which is not under /var/lib/postgresql/cold" in result.stderr
    assert "Bring it back" not in result.stderr


@needs_bash
@pytest.mark.parametrize("fails_first,fails_with,calls,status,printed", [
    (0, 2, 1, 0, "1"),
    (2, 2, 3, 0, "1"),              # a server that is only just starting: asked again, twice at most
    (5, 2, 3, 2, ""),               # it never answers: three tries, and nothing is printed
    (5, 124, 1, 124, ""),           # a query that ran into the time limit is not asked again
])
def test_the_database_is_asked_again_when_it_is_only_just_starting(tmp_path, fails_first, fails_with, calls, status, printed):
    (tmp_path / "fails-first").write_text(f"{fails_first}\n", encoding="utf-8")
    (tmp_path / "fails-with").write_text(f"{fails_with}\n", encoding="utf-8")
    _tool(tmp_path, "docker",
          'here="$(dirname "$0")"; count=$(( $(cat "$here/count" 2>/dev/null || echo 0) + 1 )); echo "$count" > "$here/count"\n'
          'cat > /dev/null\n'
          'if [ "$count" -le "$(cat "$here/fails-first")" ]; then echo "half an answer"; exit "$(cat "$here/fails-with")"; fi\n'
          'echo 1')
    result = sh('PATH="$1:$PATH"; DB_RETRY_PAUSE=0; rc=0; printf "select 1;\\n" | db_query some-container 1 meshinfo_cold x || rc=$?; '
                'echo "rc=$rc"', str(tmp_path))
    assert result.stdout.splitlines() == ([printed] if printed else []) + [f"rc={status}"]
    assert int((tmp_path / "count").read_text(encoding="utf-8")) == calls


@needs_bash
def test_a_question_that_took_its_whole_time_limit_is_not_asked_again(tmp_path):
    # timeout reports a command it had to end as 124 (coreutils) or as 143
    # (busybox); and there may be no timeout at all. The time it took tells.
    # A timeout of the test's own stands in for the kinds that do not say 124:
    # it only runs the command, which takes longer than the limit.
    _tool(tmp_path, "timeout", 'shift; exec "$@"')
    _tool(tmp_path, "docker",
          'here="$(dirname "$0")"; count=$(( $(cat "$here/count" 2>/dev/null || echo 0) + 1 )); echo "$count" > "$here/count"\n'
          'cat > /dev/null\n'
          'sleep 3\n'
          'exit 143')
    result = sh('PATH="$1:$PATH"; DB_RETRY_PAUSE=0; DB_TIME_LIMIT=1; rc=0; '
                'printf "select 1;\\n" | db_query some-container 1 meshinfo_cold x || rc=$?; echo "rc=$rc"', str(tmp_path))
    assert result.stdout.strip() == "rc=143"
    assert int((tmp_path / "count").read_text(encoding="utf-8")) == 1


def _claims(tmp_path: Path, state: str, sources: str = "tank/cold local\nbackup/copy received\nbackup/never received\n",
            copy_canmount: str = "noauto") -> subprocess.CompletedProcess:
    """check_other_claims with a zfs that lists four datasets: the mounted
    cold one, an unmounted copy with the same mountpoint, one more copy that
    can never be mounted, and an unrelated one. SOURCES says where each has
    its mountpoint from (a copy received with its properties: received)."""
    base = tmp_path.resolve()
    cold = base / "cold"
    cold.mkdir(exist_ok=True)
    (base / "bin").mkdir(exist_ok=True)
    (base / "bin" / "list.txt").write_text(
        f"tank/cold\t{cold}\tyes\ton\n"
        f"backup/copy\t{cold}\tno\t{copy_canmount}\n"
        f"backup/never\t{cold}\tno\toff\n"
        "tank/else\t/elsewhere\tno\ton\n", encoding="utf-8")
    (base / "bin" / "sources.txt").write_text(sources, encoding="utf-8")
    _tool(base / "bin", "zfs",
          'here="$(dirname "$0")"\n'
          'case "$1" in\n'
          '  list) cat "$here/list.txt" ;;\n'
          '  get)  for last in "$@"; do :; done\n'
          '        case "$*" in *source*) sed -n "s|^$last ||p" "$here/sources.txt" ;; *) exit 1 ;; esac ;;\n'
          '  *)    exit 2 ;;\n'
          'esac')
    return sh(f'PATH="$1:$PATH"; MOUNTPOINT="$2"; {state}; check_other_claims', str(base / "bin"), str(cold), check=False)


@needs_bash
def test_a_copy_that_claims_a_cold_directory_in_use_is_a_warning_and_is_never_to_be_mounted(tmp_path):
    for state in ("KIND=zfs; ZFS_DATASET=tank/cold; CUR_MOUNTED=1; CUR_KIND=zfs; CUR_SOURCE=tank/cold",   # the dataset itself is mounted there
                  "KIND=existing; CUR_MOUNTED=1; CUR_KIND=zfs; CUR_SOURCE=tank/cold",
                  "KIND=image; CUR_MOUNTED=1; CUR_KIND=image; CUR_SOURCE=/dev/loop3",                      # ... or a btrfs image is
                  "KIND=subvolume; CUR_MOUNTED=0; CUR_KIND=subvolume; CUR_SOURCE="):
        result = _claims(tmp_path, state)
        assert result.returncode == 0, (state, result.stderr)
        assert "the ZFS dataset backup/copy also has" in result.stderr and "Leave it unmounted" in result.stderr, state
        assert "zfs mount" not in result.stderr.replace("zfs mount -a at boot", ""), state   # with or without -l
        assert "backup/never" not in result.stderr and "tank/else" not in result.stderr, state
    # a directory that holds the tablespace is in use too, mount point or not
    (tmp_path.resolve() / "cold" / "PG_18_202506291").mkdir()
    result = _claims(tmp_path, "KIND=existing; CUR_MOUNTED=0; CUR_KIND=none; CUR_SOURCE=")
    assert result.returncode == 0 and "Leave it unmounted" in result.stderr


@needs_bash
def test_a_dataset_that_claims_a_bare_cold_directory_is_what_belongs_there(tmp_path):
    result = _claims(tmp_path, "KIND=image; CUR_MOUNTED=0; CUR_KIND=none; CUR_SOURCE=")
    assert result.returncode == 1
    assert "the ZFS dataset backup/copy has" in result.stderr and "is the bare directory underneath." in result.stderr
    assert "If it is the cold dataset, mount it (zfs mount -l backup/copy; -l loads the key of one that is encrypted)" in result.stderr
    assert "give it another mountpoint or set canmount=off on it" in result.stderr
    # the dataset this run is about to mount there is not a claim against itself
    result = _claims(tmp_path, "KIND=zfs; ZFS_DATASET=backup/copy; CUR_MOUNTED=0; CUR_KIND=none; CUR_SOURCE=")
    assert (result.returncode, result.stderr) == (0, "")
    # A marker file in the bare mountpoint (touch DIR/NOT_MOUNTED) does not make
    # it a cold directory in use: the dataset is still what belongs there.
    (tmp_path.resolve() / "cold" / "NOT_MOUNTED").write_text("", encoding="utf-8")
    result = _claims(tmp_path, "KIND=image; CUR_MOUNTED=0; CUR_KIND=none; CUR_SOURCE=")
    assert result.returncode == 1
    assert "is the bare directory underneath (it is not empty: look at what is in it before a dataset is mounted over it)." in result.stderr
    assert "Leave it unmounted" not in result.stderr


@needs_bash
def test_when_nothing_says_which_of_two_datasets_is_the_copy_both_readings_are_given(tmp_path):
    # A copy made by hand, or received without its properties and then given
    # the path, has its mountpoint "local" like the dataset this script made.
    result = _claims(tmp_path, "KIND=zfs; ZFS_DATASET=tank/cold; CUR_MOUNTED=1; CUR_KIND=zfs; CUR_SOURCE=tank/cold",
                     sources="tank/cold local\nbackup/copy local\nbackup/never local\n")
    assert result.returncode == 0, result.stderr
    assert "the ZFS dataset backup/copy also has" in result.stderr
    assert "Only one of the two is the cold dataset. If it is tank/cold, which is mounted there: leave backup/copy unmounted" in result.stderr
    assert ("If it is backup/copy: stop the stack (docker compose stop postgres meshinfo), unmount the directory (umount "
            in result.stderr)
    assert "mount backup/copy (zfs mount -l backup/copy) and start the stack (docker compose up -d)" in result.stderr


@needs_bash
def test_a_copy_that_is_mounted_in_the_cold_datasets_place_is_not_taken_for_it(tmp_path):
    # After a reboot the cold dataset did not mount (its key was not loaded,
    # its canmount is noauto, its pool came late) and a received copy with the
    # same mountpoint did. The mounted one has its mountpoint from a zfs
    # receive; the one that is not mounted has it local.
    sources = "tank/cold received\nbackup/copy local\nbackup/never received\n"
    mounted = "CUR_MOUNTED=1; CUR_KIND=zfs; CUR_SOURCE=tank/cold"
    # no layout flag: the script took what is mounted there by itself
    result = _claims(tmp_path, f'KIND=zfs; ZFS_DATASET=tank/cold; CHOICE=""; {mounted}', sources=sources, copy_canmount="on")
    assert result.returncode == 1
    assert ("tank/cold, which is mounted at" in result.stderr and "has its mountpoint from a zfs receive — it is a copy — and "
            "backup/copy, which has the same mountpoint, is not mounted" in result.stderr)
    assert "Nothing is changed. To put backup/copy there: stop the stack" in result.stderr
    assert "zfs set canmount=off tank/cold" in result.stderr and "zfs mount -l backup/copy" in result.stderr
    # --existing takes a dataset as it is, whatever its properties: the one way to name it that always works
    assert f"If tank/cold is the one that is meant after all, say so: --existing {tmp_path.resolve() / 'cold'}." in result.stderr
    assert "canmount=off backup/copy" not in result.stderr       # never: keep the cold dataset from mounting
    # named with --zfs or adopted with --existing: taken, with what speaks against it
    for state in (f"KIND=zfs; ZFS_DATASET=tank/cold; CHOICE=zfs; {mounted}", f"KIND=existing; CHOICE=existing; {mounted}"):
        result = _claims(tmp_path, state, sources=sources, copy_canmount="on")
        assert result.returncode == 0, (state, result.stderr)
        assert "tank/cold is taken because it was named. If backup/copy is the cold dataset: stop the stack" in result.stderr, state
        assert "Leave it unmounted" not in result.stderr, state


# ── what real pools showed: names, spellings, mounts over mounts ─────────────

def _function(name: str) -> str:
    """The body of a function of the script."""
    match = re.search(rf"^{name}\(\) \{{\n(.*?)^\}}", _text(SCRIPT), re.MULTILINE | re.DOTALL)
    assert match, f"{name}() not found in {SCRIPT.name}"
    return match.group(1)


def test_both_scripts_hold_dataset_names_to_the_same_rule():
    pattern = r"^plain_dataset\(\) \{ (.+) \}$"
    here = re.search(pattern, _text(SCRIPT), re.MULTILINE)
    there = re.search(pattern, _text(ZFS_SCRIPT), re.MULTILINE)
    assert here and there, "plain_dataset() is not a one-line function in both scripts"
    assert here.group(1) == there.group(1)


def test_a_pool_is_asked_before_anything_is_created_on_it():
    # An alternate root moves every mountpoint; without the zstd feature the
    # delegated script fails after it has created the dataset. Both are read
    # before the branch that plans the delegated script.
    body = _function("inspect_zfs")
    plans = body.index('plan "$ZFS_SCRIPT --cold-only')
    for question in ('pool_altroot "$pool"', "zpool get -H -o value feature@zstd_compress"):
        assert question in body and body.index(question) < body.index("NEED_ZFS=0") < plans, question
    assert "zpool get -H -o value altroot" in _function("pool_altroot")
    # ... and after it has run, the dataset must be what is mounted at the cold directory
    body = _function("apply_zfs")
    assert body.index('bash "$ZFS_SCRIPT"') < body.index("require_dataset_mounted_here") < body.index("chmod")
    assert "require_dataset_mounted_here" in _function("verify_cold_directory")


@needs_bash
@pytest.mark.parametrize("answer,altroot", [
    ("-", ""),                # zpool's word for "none"
    ("/mnt", "/mnt"),
    ("/srv/alt root", "/srv/alt root"),
    ("/", ""),                # zpool import -R /: ZFS puts nothing in front of a mountpoint
    ("", ""),                 # zpool does not answer (no such pool, no zpool)
])
def test_the_alternate_root_of_a_pool(tmp_path, answer, altroot):
    (tmp_path / "answer.txt").write_text(answer + "\n" if answer else "", encoding="utf-8")
    _tool(tmp_path, "zpool", '[ -s "$(dirname "$0")/answer.txt" ] || exit 1; cat "$(dirname "$0")/answer.txt"')
    assert out('PATH="$1:$PATH"; pool_altroot tank', str(tmp_path)) == altroot


@needs_bash
@pytest.mark.parametrize("name,plain", [
    ("tank/meshinfo-cold", True),
    ("tank/a.b_c-d:e/f", True),
    ("tank", True),                       # a pool: told apart from a dataset elsewhere
    ("tank/cold data", False),            # ZFS takes a space, which findmnt -r writes as \x20
    ("tank/cold\\x20data", False),
    ("tank/cold@monday", False),          # a snapshot
    ("tank//cold", False),
    ("tank/cold/", False),
    ("/tank/cold", False),
    ("", False),
])
def test_dataset_names_that_are_passed_on_to_zfs(name, plain):
    assert (sh('plain_dataset "$1"', name, check=False).returncode == 0) is plain


@needs_bash
@pytest.mark.parametrize("name", ["tank/cold data", "tank/cold@monday"])
def test_the_delegated_script_takes_the_same_dataset_names_for_the_cold_only_layout(name):
    result = subprocess.run([BASH, str(ZFS_SCRIPT), "--cold-only", name, "/srv/meshinfo/pgcold", "--dry-run"],
                            capture_output=True, text=True, env={**os.environ, "PATH": "/usr/bin:/bin"})
    assert result.returncode == 2, result.stderr
    assert f"'{name}' is not a dataset name --cold-only takes" in result.stderr
    assert "+ zfs" not in result.stdout


@needs_bash
@pytest.mark.parametrize("parent", ["tank/meshinfo", "tank/mesh info"])
def test_the_full_layout_of_the_delegated_script_takes_the_names_it_always_took(parent):
    # The full layout never reads a name back from findmnt, and ZFS takes a
    # space in a name: the rule of the cold-only layout is not put on it.
    result = subprocess.run([BASH, str(ZFS_SCRIPT), parent, "--dry-run"], capture_output=True, text=True,
                            env={**os.environ, "PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
    assert f"+ zfs create -p {parent}/pgcold" in result.stdout.splitlines()


@needs_bash
def test_a_dataset_claims_the_cold_directory_however_its_mountpoint_was_typed(tmp_path):
    # ZFS keeps the mountpoint property as it was typed — a trailing slash, a
    # doubled one, a symlink on the way — and mounts at the real place.
    base = tmp_path.resolve()
    cold = base / "real" / "cold"
    cold.mkdir(parents=True)
    (base / "link").symlink_to(base / "real")
    listing = [
        f"tank/plain\t{cold}\tno\ton",
        f"tank/slash\t{cold}/\tno\ton",
        f"tank/double\t{base}/real//cold\tno\tnoauto",
        f"tank/link\t{base}/link/cold\tno\ton",
        f"tank/cold data\t{cold}\tno\ton",             # a name with a space stays whole
        f"tank/mounted\t{cold}\tyes\ton",              # mounted: it makes no claim
        f"tank/never\t{cold}/\tno\toff",               # it can never be mounted
        f"tank/below\t{cold}/sub\tno\ton",
        f"tank/beside\t{cold}2\tno\ton",
        "tank/legacy\tlegacy\tno\ton",
        "tank/none\tnone\tno\ton",
        "tank/volume\t-\t-\t-",
        "tank\t/tank\tyes\ton",
    ]
    (base / "bin").mkdir()
    (base / "bin" / "list.txt").write_text("\n".join(listing) + "\n", encoding="utf-8")
    _tool(base / "bin", "zfs", '[ "$1" = list ] || exit 2; cat "$(dirname "$0")/list.txt"')
    found = out('PATH="$1:$PATH"; MOUNTPOINT="$2"; unmounted_datasets_here', str(base / "bin"), str(cold))
    assert found.splitlines() == ["tank/plain", "tank/slash", "tank/double", "tank/link", "tank/cold data"]


@needs_bash
@pytest.mark.parametrize("mounts,source,fstype,kind,stack", [
    ("tank/cold zfs", "tank/cold", "zfs", "zfs", ""),
    # a copy with the same mountpoint that was mounted as well: the last line is what is on top
    ("tank/cold zfs\nbackup/copy zfs", "backup/copy", "zfs", "zfs", "tank/cold, backup/copy"),
    ("backup/copy zfs\ntank/cold zfs", "tank/cold", "zfs", "zfs", "backup/copy, tank/cold"),
    ("/dev/sdb1 btrfs\ntank/cold zfs", "tank/cold", "zfs", "zfs", "/dev/sdb1, tank/cold"),
    ("tank/cold zfs\n/dev/sdb1 btrfs", "/dev/sdb1", "btrfs", "device", "tank/cold, /dev/sdb1"),
    # what is underneath without being btrfs or ZFS is no second cold filesystem
    ("tmpfs tmpfs\ntank/cold zfs", "tank/cold", "zfs", "zfs", ""),
    # ... nor is the same filesystem bound over itself (mount --bind DIR DIR)
    ("/dev/sdb1 btrfs\n/dev/sdb1 btrfs", "/dev/sdb1", "btrfs", "device", ""),
    ("tank/cold zfs\ntank/cold zfs", "tank/cold", "zfs", "zfs", ""),
    ("systemd-1 autofs\ntank/cold zfs", "tank/cold", "zfs", "zfs", ""),
    # ... and something else on top is simply what is there
    ("tank/cold zfs\ntmpfs tmpfs", "tmpfs", "tmpfs", "foreign", ""),
    # findmnt -r writes a space in a dataset name as \x20
    ("tank/cold\\x20data zfs", "tank/cold data", "zfs", "zfs", ""),
    ("tank/cold\\x20data zfs\ntank/a\\x20copy zfs", "tank/a copy", "zfs", "zfs", "tank/cold data, tank/a copy"),
    ("", "", "", "none", ""),
])
def test_what_is_mounted_at_the_cold_directory(tmp_path, mounts, source, fstype, kind, stack):
    (tmp_path / "mounts.txt").write_text(mounts + "\n" if mounts else "", encoding="utf-8")
    _tool(tmp_path, "findmnt", '[ -s "$(dirname "$0")/mounts.txt" ] || exit 1; cat "$(dirname "$0")/mounts.txt"')
    result = out('PATH="$1:$PATH"; MOUNTPOINT="$2"; detect_current; echo "$CUR_SOURCE|$CUR_FSTYPE|$CUR_KIND|$CUR_STACK"',
                 str(tmp_path), str(tmp_path / "cold"))
    assert result == f"{source}|{fstype}|{kind}|{stack}"


@needs_bash
def test_the_way_out_of_two_filesystems_at_one_directory_names_no_dataset_to_zfs_unmount():
    # With both mounted, zfs unmount NAME and zfs set canmount=off NAME take
    # off whatever is on top, whichever dataset they are given.
    note = out('MOUNTPOINT=/srv/cold; CUR_STACK="tank/cold, backup/copy"; stacked_note')
    assert note.startswith("one over the other: tank/cold, backup/copy — the last is on top")
    assert "zfs unmount" not in note and "zfs set canmount" not in note
    assert (note.index("stop the stack") < note.index("umount /srv/cold, once for each")
            < note.index("another mountpoint or canmount=off") < note.index("zfs mount -l NAME") < note.index("docker compose up -d"))


@needs_bash
@pytest.mark.parametrize("mounts,found", [
    ("tank/cold zfs", "tank/cold"),
    ("tank/other zfs\ntank/cold zfs", "tank/cold"),         # what is on top
    ("tank/cold\\x20data zfs", "tank/cold data"),
    ("tank/cold zfs\ntank/other zfs", "tank/other"),
    ("tank/cold zfs\ntmpfs tmpfs", ""),                    # no dataset on top
    ("", ""),
])
def test_the_dataset_of_the_zfs_layout_must_be_what_is_mounted_at_the_cold_directory(tmp_path, mounts, found):
    # On a pool with an alternate root ZFS mounts a dataset somewhere else
    # than at the mountpoint it was given. Nothing is chowned, and nothing is
    # reported as ready, on a directory where the dataset is not.
    (tmp_path / "mounts.txt").write_text(mounts + "\n" if mounts else "", encoding="utf-8")
    _tool(tmp_path, "findmnt", '[ -s "$(dirname "$0")/mounts.txt" ] || exit 1; cat "$(dirname "$0")/mounts.txt"')
    _tool(tmp_path, "zfs", "echo /srv/alt/srv/cold")
    assert out('PATH="$1:$PATH"; MOUNTPOINT=/srv/cold; mounted_dataset_here', str(tmp_path)) == found
    result = sh('PATH="$1:$PATH"; MOUNTPOINT=/srv/cold; ZFS_DATASET=tank/cold; require_dataset_mounted_here',
                str(tmp_path), check=False)
    if found == "tank/cold":
        assert (result.returncode, result.stderr) == (0, "")
    else:
        assert result.returncode == 1
        assert (f"the dataset tank/cold is not what is mounted at /srv/cold ({found or 'no dataset'} is; "
                "zfs get mountpoint tank/cold says /srv/alt/srv/cold). Nothing was changed at /srv/cold.") in result.stderr


@needs_bash
@pytest.mark.parametrize("entries,fstype,refused", [
    ([], "zfs", None),
    (["PG_18_202506291"], "ext4", None),
    ([".zfs"], "zfs", None),                       # snapdir=visible: ZFS's own directory at the root of a dataset
    ([".zfs", "PG_18_202506291"], "zfs", None),
    ([".zfs"], "", ".zfs"),                        # not the root of a mount: a directory like any other
    ([".zfs"], "btrfs", ".zfs"),
    (["lost+found"], "zfs", "lost+found"),
    ([".zfs", "notes"], "zfs", "notes"),
])
def test_only_the_tablespace_may_be_in_a_directory_that_is_adopted(tmp_path, entries, fstype, refused):
    cold = tmp_path / "cold"
    cold.mkdir()
    for entry in entries:
        (cold / entry).mkdir()
    (tmp_path / "fstype.txt").write_text(fstype + "\n" if fstype else "", encoding="utf-8")
    _tool(tmp_path / "bin", "findmnt", '[ -s "$(dirname "$0")/../fstype.txt" ] || exit 1; cat "$(dirname "$0")/../fstype.txt"')
    result = sh('PATH="$1:$PATH"; require_only_tablespace "$2"', str(tmp_path / "bin"), str(cold), check=False)
    if refused is None:
        assert (result.returncode, result.stderr) == (0, "")
    else:
        assert result.returncode == 1
        assert f"holds something other than a tablespace ({refused})" in result.stderr


@needs_bash
@pytest.mark.parametrize("mountpoint,altroot,pool_there,line,advice", [
    ("", "-", True, "LABEL=meshinfo-cold /srv/cold btrfs defaults,nofail 0 0", "mount /srv/cold"),
    ("legacy", "-", True, "tank/cold /srv/cold zfs defaults,nofail 0 0", "mount /srv/cold"),
    ("/srv/cold", "-", True, "tank/cold /srv/cold zfs zfsutil,nofail 0 0", "mount /srv/cold"),
    # the two zfs lines that mount turns down
    ("legacy", "-", True, "tank/cold /srv/cold zfs zfsutil,nofail 0 0",
     "take the zfsutil option out of that line (mount turns it down for a dataset with mountpoint=legacy), then mount /srv/cold"),
    ("/srv/cold", "-", True, "tank/cold /srv/cold zfs defaults 0 0",
     "zfs mount -l tank/cold — ZFS mounts that dataset itself, and mount turns the fstab line down: remove the line"),
    ("/srv/cold/", "-", True, "tank/cold /srv/cold zfs defaults 0 0",       # the property as it was typed
     "zfs mount -l tank/cold — ZFS mounts that dataset itself, and mount turns the fstab line down: remove the line"),
    # ... the second of them for a dataset whose mountpoint is not the cold
    # directory: zfs mount would put it somewhere else, or nowhere
    ("/tank/cold", "-", True, "tank/cold /srv/cold zfs defaults,nofail 0 0",
     "the dataset tank/cold has mountpoint=/tank/cold, not this directory, and mount turns down a line without the zfsutil "
     "option for it: to have it here, give it this path (zfs set mountpoint=/srv/cold tank/cold — that takes it from "
     "where it is now; then zfs mount -l tank/cold if it did not mount) and remove the line — or "
     "make it legacy (zfs set mountpoint=legacy tank/cold), keep the line, then mount /srv/cold"),
    ("none", "-", True, "tank/cold /srv/cold zfs defaults 0 0",
     "the dataset tank/cold has mountpoint=none, not this directory, and mount turns down a line without the zfsutil "
     "option for it: to have it here, give it this path (zfs set mountpoint=/srv/cold tank/cold — that takes it from "
     "where it is now; then zfs mount -l tank/cold if it did not mount) and remove the line — or "
     "make it legacy (zfs set mountpoint=legacy tank/cold), keep the line, then mount /srv/cold"),
    # ... where a path given to zfs set would get the pool's alternate root in front, only the second way
    ("/tank/cold", "/mnt", True, "tank/cold /srv/cold zfs defaults 0 0",
     "the dataset tank/cold has mountpoint=/tank/cold, not this directory, and mount turns down a line without the zfsutil "
     "option for it: make it legacy (zfs set mountpoint=legacy tank/cold), keep the line, then mount /srv/cold"),
    # the dataset cannot be asked: its pool is not imported, or it is not there
    ("", "-", False, "tank/cold /srv/cold zfs defaults 0 0",
     "zpool import tank first — the pool of the dataset that line names is not imported — then look again with "
     "sourced-by-the-tests status"),
    ("", "-", True, "tank/cold /srv/cold zfs defaults 0 0",
     "the dataset tank/cold, which that line names, is not there: correct or remove the line"),
    # fstab writes a space in a name as \040
    ("/srv/cold", "-", True, "tank/cold\\040data /srv/cold zfs defaults 0 0",
     "zfs mount -l 'tank/cold data' — ZFS mounts that dataset itself, and mount turns the fstab line down: remove the line"),
])
def test_how_to_mount_what_an_fstab_entry_names(tmp_path, mountpoint, altroot, pool_there, line, advice):
    (tmp_path / "mountpoint.txt").write_text(mountpoint + "\n" if mountpoint else "", encoding="utf-8")
    (tmp_path / "altroot.txt").write_text(altroot + "\n", encoding="utf-8")
    if pool_there:
        (tmp_path / "pool-is-there").write_text("", encoding="utf-8")
    _tool(tmp_path, "zfs", '[ -s "$(dirname "$0")/mountpoint.txt" ] || exit 1; cat "$(dirname "$0")/mountpoint.txt"')
    _tool(tmp_path, "zpool", 'here="$(dirname "$0")"\n'
                             'case "$1" in\n'
                             '  list) [ -e "$here/pool-is-there" ] || exit 1; echo tank ;;\n'
                             '  get)  cat "$here/altroot.txt" ;;\n'
                             '  *)    exit 2 ;;\n'
                             'esac')
    assert out('PATH="$1:$PATH"; MOUNTPOINT=/srv/cold; mount_advice "$2"', str(tmp_path), line) == advice
    # without a zfs to ask, every line gets the plain answer
    assert out('PATH="$1"; MOUNTPOINT=/srv/cold; mount_advice "$2"', str(tmp_path / "nothing-here"), line) == "mount /srv/cold"


# ── the fourth review: one level up, after a reboot, and what "ready" means ──

@needs_bash
@pytest.mark.parametrize("name,printed", [
    ("tank/meshinfo-cold", "tank/meshinfo-cold"),
    ("tank/cold data", "'tank/cold data'"),      # typed as printed, it still names the dataset
    ("my pool", "'my pool'"),
])
def test_a_dataset_name_inside_a_printed_command(name, printed):
    assert out('shown "$1"', name) == printed


@needs_bash
def test_an_fstab_line_for_a_dataset_with_a_space_in_its_name(tmp_path):
    # fstab writes the space as \040; findmnt gives the name as it is
    (tmp_path / "mountpoint.txt").write_text("legacy\n", encoding="utf-8")
    _tool(tmp_path, "zfs", 'cat "$(dirname "$0")/mountpoint.txt"')
    line = "tank/cold\\040data /srv/cold zfs defaults,nofail 0 0"
    assert out('PATH="$1:$PATH"; zfs_fstab_entry "$2" "tank/cold data"', str(tmp_path), line) == "legacy"
    assert out('PATH="$1:$PATH"; zfs_fstab_entry "$2" "tank/cold"', str(tmp_path), line) == "other"


def _findmnt_by_question(directory: Path, at_cold: str, target: str, at_target: str) -> None:
    """A findmnt that answers three questions: what is mounted at the cold
    directory (-M .../cold), where the filesystem of a path is mounted (-T),
    and what is mounted there (-M of that place)."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "at-cold.txt").write_text(at_cold + "\n" if at_cold else "", encoding="utf-8")
    (directory / "target.txt").write_text(target + "\n" if target else "", encoding="utf-8")
    (directory / "at-target.txt").write_text(at_target + "\n" if at_target else "", encoding="utf-8")
    _tool(directory, "findmnt",
          'here="$(dirname "$0")"\n'
          'mode=""; place=""\n'
          'while [ $# -gt 0 ]; do\n'
          '  case "$1" in\n'
          '    -M) mode=M; place="$2"; shift ;;\n'
          '    -T) mode=T; place="$2"; shift ;;\n'
          '    -o) shift ;;\n'
          '  esac\n'
          '  shift\n'
          'done\n'
          'case "$mode:$place" in\n'
          '  M:*/cold) file=at-cold.txt ;;\n'
          '  M:*)      file=at-target.txt ;;\n'
          '  T:*)      file=target.txt ;;\n'
          '  *)        exit 1 ;;\n'
          'esac\n'
          '[ -s "$here/$file" ] || exit 1\n'
          'cat "$here/$file"')


@needs_bash
@pytest.mark.parametrize("target,at_target,stack,parent", [
    # the cold directory is a directory inside a dataset, and a copy is mounted over that dataset
    ("{base}/plain", "tank/plain zfs\nbackup/plain zfs", "tank/plain, backup/plain", "{base}/plain"),
    ("{base}/plain", "tank/plain zfs", "", "{base}/plain"),
    ("{base}/plain", "systemd-1 autofs\ntank/plain zfs", "", "{base}/plain"),
    # the root filesystem is not looked at
    ("/", "rpool/ROOT/a zfs\nrpool/ROOT/b zfs", "", ""),
    ("", "", "", ""),
])
def test_one_filesystem_over_another_where_the_cold_directory_is_only_a_directory(tmp_path, target, at_target, stack, parent):
    base = tmp_path.resolve()
    (base / "plain" / "cold").mkdir(parents=True)
    _findmnt_by_question(base / "bin", "", target.format(base=base), at_target)
    result = out('PATH="$1:$PATH"; MOUNTPOINT="$2"; detect_current; echo "$CUR_KIND|$CUR_MOUNTED|$CUR_STACK|$CUR_STACK_AT|$CUR_PARENT"',
                 str(base / "bin"), str(base / "plain" / "cold"))
    where = parent.format(base=base)
    assert result == f"none|0|{stack}|{where if stack else ''}|{where}"
    if stack:
        said = out('PATH="$1:$PATH"; MOUNTPOINT="$2"; detect_current; echo "$(stacked_where), $(stacked_note)"',
                   str(base / "bin"), str(base / "plain" / "cold"))
        assert said.startswith(f"at {where}, where the filesystem that holds {base}/plain/cold is mounted, one over the other: {stack}")
        assert f"umount {where}, once for each" in said


@needs_bash
def test_datasets_that_would_be_mounted_over_the_filesystem_the_cold_directory_is_on(tmp_path):
    base = tmp_path.resolve()
    cold = base / "plain" / "sub" / "cold"
    cold.mkdir(parents=True)
    listing = [
        f"tank/plain\t{base}/plain\tyes\ton",               # what holds the cold directory: mounted
        f"backup/plain\t{base}/plain\tno\ton",              # a received copy: the next boot mounts it over that
        f"backup/typed\t{base}/plain/\tno\ton",             # ... however its mountpoint was typed
        f"backup/between\t{base}/plain/sub\tno\ton",        # a directory between the two
        f"backup/be\t{base}/plain\tno\tnoauto",             # kept from mounting by itself, as boot environments are
        f"backup/never\t{base}/plain\tno\toff",
        f"backup/here\t{cold}\tno\ton",                     # the cold directory itself: unmounted_datasets_here has it
        f"backup/below\t{cold}/x\tno\ton",
        f"backup/beside\t{base}/plain2\tno\ton",
        f"backup/higher\t{base}\tno\ton",                   # above where the filesystem is mounted
        "backup/legacy\tlegacy\tno\ton",
        "backup/volume\t-\t-\t-",
    ]
    (base / "bin").mkdir()
    (base / "bin" / "list.txt").write_text("\n".join(listing) + "\n", encoding="utf-8")
    _tool(base / "bin", "zfs", '[ "$1" = list ] || exit 2; cat "$(dirname "$0")/list.txt"')
    found = out('PATH="$1:$PATH"; MOUNTPOINT="$2"; CUR_PARENT="$3"; unmounted_datasets_above',
                str(base / "bin"), str(cold), str(base / "plain"))
    assert found.splitlines() == [f"backup/plain\t{base}/plain", f"backup/typed\t{base}/plain", f"backup/between\t{base}/plain/sub"]
    # with something mounted at the cold directory itself, or on the root filesystem, nothing is looked for
    assert out('PATH="$1:$PATH"; MOUNTPOINT="$2"; CUR_PARENT=""; unmounted_datasets_above', str(base / "bin"), str(cold)) == ""
    # ... and setup says so, without refusing: the cold directory may be in use
    result = sh('PATH="$1:$PATH"; MOUNTPOINT="$2"; CUR_PARENT="$3"; KIND=existing; CUR_MOUNTED=0; CUR_KIND=none; mkdir -p "$2/PG_18_202506291"; '
                'check_other_claims', str(base / "bin"), str(cold), str(base / "plain"), check=False)
    assert f"warn: the ZFS dataset backup/plain has {base}/plain as its mountpoint, a directory above the cold directory, and is not mounted." in result.stderr.replace("\x1b[1;33m", "").replace("\x1b[0m", "")
    assert "it would cover the filesystem that holds" in result.stderr


@needs_bash
@pytest.mark.parametrize("mountpoint,canmount,says", [
    ("/srv/cold", "on", ""),
    ("/srv/cold", "noauto", "the dataset tank/cold has canmount=noauto: ZFS does not mount it at boot, and nothing in /etc/fstab does. "
                            "Unless something of your own mounts it: zfs set canmount=on tank/cold"),
    ("legacy", "on", "the dataset tank/cold has mountpoint=legacy and /etc/fstab has no line for it: it is mounted now, but nothing "
                     "mounts it after a reboot. Add the line: tank/cold  /srv/cold  zfs  defaults,nofail  0 0"),
])
def test_a_dataset_that_nothing_would_mount_after_a_reboot(tmp_path, mountpoint, canmount, says):
    (tmp_path / "mountpoint.txt").write_text(mountpoint + "\n", encoding="utf-8")
    (tmp_path / "canmount.txt").write_text(canmount + "\n", encoding="utf-8")
    _tool(tmp_path, "zfs", 'for word in "$@"; do last="$prev"; prev="$word"; done; cat "$(dirname "$0")/$last.txt"')
    assert out('PATH="$1:$PATH"; MOUNTPOINT=/srv/cold; not_mounted_at_boot tank/cold', str(tmp_path)) == says


@needs_bash
@pytest.mark.parametrize("location,made,status,says", [
    ("/var/lib/postgresql/cold", "PG_18_202506291", 0, "ok  the running database's tablespace meshinfo_cold has its directory there"),
    # the database has the tablespace and the filesystem at the cold directory has not: it is not the one
    ("/var/lib/postgresql/cold", "", 1, "verification failed: the running database has the tablespace meshinfo_cold, which holds 1 of its "
                                        "tables and indexes, but its PG_... directory is not in"),
    ("/data/elsewhere", "", 1, "verification failed: the running database already has the tablespace meshinfo_cold at /data/elsewhere"),
])
def test_ready_is_not_said_over_a_filesystem_the_tablespace_is_not_on(tmp_path, location, made, status, says):
    cold = tmp_path / "cold"
    cold.mkdir()
    if made:
        (cold / made).mkdir()
    _stack_docker(tmp_path / "bin", location)
    result = sh('PATH="$1:$PATH"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; DB_RETRY_PAUSE=0; TABLESPACE_STATE=""; verify_tablespace_here',
                str(tmp_path / "bin"), str(tmp_path), str(cold), check=False)
    assert result.returncode == status
    assert says in (result.stdout + result.stderr)
    if status:
        assert "What this run did before (a mount, the owner) stays as it is." in result.stderr
        assert "DROP TABLESPACE" not in result.stderr          # something is stored on it
        assert "never one over the other" in result.stderr or "would not be used" in result.stderr


@needs_bash
def test_without_a_database_to_ask_the_tablespace_is_not_part_of_the_verification(tmp_path):
    result = sh('PATH="$1"; PROJECT_DIR="$2"; MOUNTPOINT="$2"; TABLESPACE_STATE=""; verify_tablespace_here; echo "rc=$?"',
                str(tmp_path / "nothing-here"), str(tmp_path))
    assert result.stdout.strip() == "rc=0"


def _view_docker(directory: Path, bound: str, inside: str) -> None:
    """A docker that plays one running container with BOUND at the cold path
    and INSIDE as what stat prints for that path in the container."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "bound.txt").write_text(bound + "\n", encoding="utf-8")
    (directory / "inside.txt").write_text(inside + "\n", encoding="utf-8")
    _tool(directory, "docker",
          'here="$(dirname "$0")"\n'
          'case "$1" in\n'
          '  info) exit 0 ;;\n'
          '  compose|ps) echo cid ;;\n'
          '  inspect) case "$*" in *Mounts*) echo "/var/lib/postgresql/cold $(cat "$here/bound.txt")" ;; *) echo true ;; esac ;;\n'
          '  exec) cat "$here/inside.txt" ;;\n'
          '  *) exit 2 ;;\n'
          'esac')


@needs_bash
def test_a_restart_is_never_the_advice_while_two_filesystems_are_mounted_one_over_the_other(tmp_path):
    # A container that was running when the second one was mounted still has
    # the first; a restart would hand it whatever is on top.
    base = tmp_path.resolve()
    cold = base / "cold"
    cold.mkdir()
    _view_docker(base / "bin", str(cold), "1:2")       # not what stat prints for the directory on the host
    snippet = ('PATH="$1:$PATH"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; CUR_STACK="$4"; CUR_STACK_AT="$3"; rc=0; '
               'container_view postgres /var/lib/postgresql/cold || rc=$?; echo "rc=$rc $VIEW_STATE"')
    stacked = out(snippet, str(base / "bin"), str(base), str(cold), "tank/cold, backup/copy")
    assert f"postgres: /var/lib/postgresql/cold shows ANOTHER filesystem than the one that is on top at {cold} now" in stacked
    assert "do not restart the containers before that is put right" in stacked
    assert "docker compose restart" not in stacked
    assert stacked.splitlines()[-1] == "rc=1 stale"
    # ... while a container that shows the bare directory under one filesystem is told to restart, as before
    plain = out(snippet, str(base / "bin"), str(base), str(cold), "")
    assert "shows the bare directory underneath, NOT the filesystem" in plain and "docker compose restart postgres meshinfo" in plain


@needs_bash
def test_a_tablespace_below_the_top_of_the_cold_directory_is_not_something_to_empty(tmp_path):
    # cold_tablespace_location may name a directory under the bind: the months
    # are then in DIR/ts/PG_..., which only the database knows.
    cold = tmp_path / "cold"
    (cold / "ts" / "PG_18_202506291").mkdir(parents=True)
    _stack_docker(tmp_path / "bin", "/var/lib/postgresql/cold/ts")
    result = sh('PATH="$1:$PATH"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; DB_RETRY_PAUSE=0; TABLESPACE_STATE=""; '
                'refuse_occupied "the cold filesystem" "mounting over it would hide what is in it"',
                str(tmp_path / "bin"), str(tmp_path), str(cold), check=False)
    assert result.returncode == 1
    assert "holds the tablespace meshinfo_cold of the running database, in a directory below it (/var/lib/postgresql/cold/ts" in result.stderr
    assert "do not empty it" in result.stderr and "Empty it" not in result.stderr
    # ... while a directory with something else in it is still what it was
    other = tmp_path / "other"
    (other / "notes").mkdir(parents=True)
    result = sh('PATH="$1"; PROJECT_DIR="$2"; MOUNTPOINT="$3"; TABLESPACE_STATE=""; '
                'refuse_occupied "the cold filesystem" "mounting over it would hide what is in it"',
                str(tmp_path / "nothing-here"), str(tmp_path), str(other), check=False)
    assert result.returncode == 1 and "Empty it or choose another --mountpoint." in result.stderr


# ── the lab's own safeguards (tests/cold_storage_lab/suite.sh) ───────────────

SUITE = REPO / "tests" / "cold_storage_lab" / "suite.sh"


def _suite_function(name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", _text(SUITE), re.MULTILINE | re.DOTALL)
    assert match, f"{name}() not found in {SUITE.name}"
    return match.group(0)


def test_the_lab_never_forces_a_pool_onto_a_device():
    # The partition is new and holds nothing: a zpool that finds something on
    # it is looking at a device that is not the lab's. And a partition's node
    # is made anew each time, never taken over.
    pool = _suite_function("real_pool")
    assert 'zpool" create ' in pool
    assert not re.search(r'zpool" create[^\n]* -f\b', pool)
    node = _suite_function("partition_node")
    assert node.index('rm -f "$PART"') < node.index("mknod")
    assert "partition_node" in _suite_function("make_partition")


def test_the_lab_cleanup_knows_of_a_suite_from_its_first_moment():
    text = _text(SUITE)
    main = text[text.index("# --- Main"):]
    # the cleanup command stops a running suite before it takes anything away
    assert 'if [ "${1:-}" = cleanup ]; then stop_running_suite; cleanup; exit 0; fi' in main
    # the suite is on record before it attaches its first loop device (bootstrap does)
    assert main.index('echo "$$" > "$PID_FILE"') < main.index("\nbootstrap\n")
    # a pool is on record before it is made
    pool = _suite_function("real_pool")
    assert pool.index('>> "$POOL_LIST"') < pool.index('zpool" create ')


def _alive(pid: int) -> bool:
    """A process that is running or stopped; one that only waits to be
    collected by its parent (a zombie) is gone."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


@needs_bash
def test_the_lab_cleanup_stops_a_suite_that_is_still_running(tmp_path):
    if shutil.which("pgrep") is None:
        pytest.skip("pgrep is not installed")
    functions = _suite_function("descendants") + _suite_function("stop_running_suite")
    # a stand-in suite: on record in a PID file, with a child that has a child, and an EXIT trap
    played = tmp_path / "suite.sh"
    played.write_text('#!/usr/bin/env bash\n'
                      'trap \'echo ran > "$1/trap-ran"\' EXIT\n'
                      'echo "$$" > "$1/suite.pid"\n'
                      'bash -c \'sleep 300 & echo "$!" > "$1/grandchild.pid"; echo "$$" > "$1/child.pid"; wait\' sh "$1" &\n'
                      'wait\n', encoding="utf-8", newline="\n")
    process = subprocess.Popen([BASH, str(played), str(tmp_path)])
    try:
        for _ in range(100):
            if all((tmp_path / name).exists() and (tmp_path / name).read_text().strip() for name in ("suite.pid", "child.pid", "grandchild.pid")):
                break
            import time
            time.sleep(0.1)
        pids = [int((tmp_path / name).read_text()) for name in ("suite.pid", "child.pid", "grandchild.pid")]
        assert pids[0] == process.pid and all(_alive(pid) for pid in pids)
        result = subprocess.run([BASH, "-c", f'set -uo pipefail\nPID_FILE="$1/suite.pid"\n{functions}\nstop_running_suite', "cleanup", str(tmp_path)],
                                capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stderr
        assert f"stopped the suite that was still running here (process {process.pid})" in result.stdout
        process.wait(timeout=30)
        assert [pid for pid in pids if _alive(pid)] == []
        assert not (tmp_path / "trap-ran").exists()       # stopped where it stood: its own cleanup did not run beside the caller's
        assert not (tmp_path / "suite.pid").exists()
    finally:
        if process.poll() is None:
            process.kill()
    # no suite on record, or a PID that is no suite: nothing is signalled
    sleeper = subprocess.Popen(["sleep", "300"])
    try:
        (tmp_path / "suite.pid").write_text(f"{sleeper.pid}\n", encoding="utf-8")
        result = subprocess.run([BASH, "-c", f'set -uo pipefail\nPID_FILE="$1/suite.pid"\n{functions}\nstop_running_suite', "cleanup", str(tmp_path)],
                                capture_output=True, text=True, timeout=60)
        assert (result.returncode, result.stdout) == (0, "")
        assert _alive(sleeper.pid) and not (tmp_path / "suite.pid").exists()
        result = subprocess.run([BASH, "-c", f'set -uo pipefail\nPID_FILE="$1/suite.pid"\n{functions}\nstop_running_suite', "cleanup", str(tmp_path)],
                                capture_output=True, text=True, timeout=60)
        assert (result.returncode, result.stdout) == (0, "") and _alive(sleeper.pid)
    finally:
        sleeper.kill()
        sleeper.wait()
