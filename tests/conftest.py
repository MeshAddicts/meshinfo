"""Make repo-root modules importable from tests (flat top-level namespace)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
