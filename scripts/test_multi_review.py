"""Tests for multi_review.py CLI changes."""

import json
import sys
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

import multi_review
from multi_review import (
    ReviewRound,
    SubAgentResult,
)


FAKE_DOMAINS = {
    "architecture": {"order": "01", "label": "Architecture", "filename": "01-architecture.md"},
}


class TestJsonOnlyFlag:
    """--json-only must produce pure JSON on stdout, logs on stderr."""

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_stdout_is_pure_json(self, mock_repo, mock_round):
        """stdout must contain only parseable JSON, no banners."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stdout = StringIO()
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", captured_stdout),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stdout_text = captured_stdout.getvalue()
        parsed = json.loads(stdout_text)
        assert "repo" in parsed
        assert "summary" in parsed
        assert "Multi-Agent Review" not in stdout_text
        assert "Review Round" not in stdout_text

    @patch("multi_review.DOMAINS", FAKE_DOMAINS)
    @patch("multi_review.run_review_round")
    @patch("multi_review.detect_repo", return_value="GetEvinced/test")
    def test_banners_go_to_stderr(self, mock_repo, mock_round):
        """Human-readable output must be on stderr in json-only mode."""
        mock_round.return_value = ReviewRound(round_num=1)
        captured_stderr = StringIO()

        with (
            patch("sys.stdout", StringIO()),
            patch("sys.stderr", captured_stderr),
            patch("sys.argv", ["multi_review.py", "--pr", "1", "--json-only", "--dry-run"]),
        ):
            multi_review.main()

        stderr_text = captured_stderr.getvalue()
        assert "Multi-Agent Review" in stderr_text
