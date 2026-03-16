"""Pytest config: adds scripts/ to sys.path so `import multi_review` works."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
