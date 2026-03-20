"""Tests for plan_to_tasks_validate.py — validation agent dispatch."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS_DIR = Path(__file__).parent
SCRIPT = SCRIPTS_DIR / "plan_to_tasks_validate.py"


class TestCLISmoke:
    """Verify script is importable and CLI flags parse correctly."""

    def test_script_importable(self):
        """Script can be imported without error."""
        import plan_to_tasks_validate  # noqa: F401

    def test_help_flag(self):
        """--help exits cleanly with usage info."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "plan_file" in result.stdout or "usage" in result.stdout.lower()

    def test_missing_required_args(self):
        """Script fails with clear error when required args missing."""
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            capture_output=True, text=True,
        )
        assert result.returncode != 0
