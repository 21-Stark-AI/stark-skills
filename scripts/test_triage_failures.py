#!/usr/bin/env python3
from __future__ import annotations

from io import StringIO
from unittest.mock import MagicMock, patch

import domain_triage
import triage_orchestrator


def _sample_domains() -> dict[str, domain_triage.DomainMeta]:
    return {
        "architecture": {
            "order": "01",
            "label": "Architecture",
            "filename": "architecture.md",
            "description": "Architecture review",
        },
        "security": {
            "order": "02",
            "label": "Security",
            "filename": "security.md",
            "description": "Security review",
        },
    }


def _minimal_config() -> dict[str, object]:
    return {
        "triage": {
            "mode": "aggressive",
            "agent": "claude",
            "timeout": 15,
            "conservative_confidence_threshold": 0.8,
            "insights_url": "http://insights.test",
        },
        "disabled_domains": [],
    }


@patch("domain_triage.get_model_id", return_value="test-model")
@patch("domain_triage._load_domain_descriptions", return_value={})
@patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
@patch("domain_triage._dispatch_to_agent", side_effect=TimeoutError("triage timeout"))
def test_timeout_retries_then_fallback(
    _mock_dispatch: MagicMock,
    _mock_prompt: MagicMock,
    _mock_descriptions: MagicMock,
    _mock_model: MagicMock,
) -> None:
    result = domain_triage.triage_domains(
        content="diff --git a/a.py b/a.py\n+print('x')\n",
        review_type="pr",
        domains=_sample_domains(),
        mode="aggressive",
        agent="claude",
    )

    assert result.error == "triage timeout"
    assert result.dispatched_domains == ["architecture", "security"]
    assert all(verdict.relevant for verdict in result.verdicts)
    assert all("Fallback to full mode" in verdict.reason for verdict in result.verdicts)


@patch("domain_triage.get_model_id", return_value="test-model")
@patch("domain_triage._load_domain_descriptions", return_value={})
@patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
@patch("domain_triage.subprocess.run")
def test_parse_error_saves_debug_file(
    mock_run: MagicMock,
    _mock_prompt: MagicMock,
    _mock_descriptions: MagicMock,
    _mock_model: MagicMock,
) -> None:
    mock_run.return_value = MagicMock(stdout="not json at all", stderr="", returncode=0)

    result = domain_triage.triage_domains(
        content="diff --git a/a.py b/a.py\n+print('x')\n",
        review_type="pr",
        domains=_sample_domains(),
        mode="aggressive",
        agent="claude",
    )

    assert result.error is not None
    assert "json_parse_error" in result.error
    assert result.dispatched_domains == ["architecture", "security"]
    assert all(verdict.relevant for verdict in result.verdicts)


@patch("domain_triage.get_model_id", return_value="test-model")
@patch("domain_triage._load_domain_descriptions", return_value={})
@patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
@patch("domain_triage.subprocess.run", side_effect=FileNotFoundError("codex not installed"))
def test_agent_unavailable_fallback(
    _mock_run: MagicMock,
    _mock_prompt: MagicMock,
    _mock_descriptions: MagicMock,
    _mock_model: MagicMock,
) -> None:
    result = domain_triage.triage_domains(
        content="diff --git a/a.py b/a.py\n+print('x')\n",
        review_type="pr",
        domains=_sample_domains(),
        mode="aggressive",
        agent="claude",
    )

    assert result.error is not None
    assert "agent_unavailable" in result.error
    assert result.dispatched_domains == ["architecture", "security"]


@patch("triage_orchestrator.urllib.request.urlopen", side_effect=TimeoutError("insights down"))
@patch("triage_orchestrator.discover_config", return_value=_minimal_config())
@patch("triage_orchestrator._discover_domains", return_value={})
def test_insights_unavailable_continues(
    _mock_domains: MagicMock,
    _mock_config: MagicMock,
    _mock_urlopen: MagicMock,
) -> None:
    # Force the zero-domain path directly so insights emission is exercised without dispatch.
    triage_result = domain_triage.TriageResult(
        mode="aggressive",
        agent="claude",
        model="claude-test",
        review_type="pr",
        verdicts=[],
        dispatched_domains=[],
        skipped_domains=[],
        duration_s=0.1,
        error=None,
        input_strategy="full",
        content_hash="abc123",
    )

    with (
        patch("triage_orchestrator._read_input_content", return_value=("diff", "acme/repo#1")),
        patch("triage_orchestrator._discover_review_domains", return_value={"architecture": _sample_domains()["architecture"]}),
        patch("triage_orchestrator.triage_domains", return_value=triage_result),
        patch("sys.argv", ["triage_orchestrator.py", "--type", "pr", "--pr", "1", "--repo", "acme/repo", "--plain"]),
        patch("sys.stdout", StringIO()) as stdout,
        patch("sys.stderr", StringIO()) as stderr,
    ):
        rc = triage_orchestrator.main()

    assert rc == 0
    assert "stark-insights unavailable: insights down" in stdout.getvalue()
    assert "warning: failed to emit insights event: insights down" in stderr.getvalue()
