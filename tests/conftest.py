"""Make repo-root modules importable from tests (flat top-level namespace),
and this directory itself so shared scaffolding (tests/_helpers.py) imports
under any pytest import mode."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
