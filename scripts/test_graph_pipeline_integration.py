"""End-to-end integration tests for the stark-graph pipeline."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from graph.model import DiffReport, Graph, ValidationReport

SCRIPTS_DIR = Path(__file__).parent
FIXTURE_REPO = SCRIPTS_DIR.parent / "tests" / "fixtures" / "graph"
STARK_GRAPH = SCRIPTS_DIR / "stark_graph.py"
PYTHON = sys.executable


def _run(
    repo: Path,
    *args: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [PYTHON, str(STARK_GRAPH), "--repo", str(repo), *args],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def _copy_fixture_repo(dst: Path) -> None:
    shutil.copytree(FIXTURE_REPO, dst, dirs_exist_ok=True)
    shutil.rmtree(dst / "__pycache__", ignore_errors=True)


def _init_git_repo(repo: Path) -> None:
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Codex Test")
    _git(repo, "config", "user.email", "codex@example.com")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "base fixture")


def _prepare_changed_repo(tempdir: Path) -> tuple[Path, str]:
    repo = tempdir / "graph-fixture"
    _copy_fixture_repo(repo)
    _init_git_repo(repo)

    new_module = repo / "new_dependency.py"
    new_module.write_text(
        '"""Depends: valid_module"""\n\nimport valid_module\n',
        encoding="utf-8",
    )
    _git(repo, "add", "new_dependency.py")
    _git(repo, "commit", "-m", "add dependency module")
    base_sha = _git(repo, "rev-parse", "HEAD~1")
    return repo, base_sha


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def test_parse_validate_diff_pipeline_artifacts_validate_against_pydantic():
    with tempfile.TemporaryDirectory() as tmp:
        repo, base_sha = _prepare_changed_repo(Path(tmp))
        workdir = repo / ".stark-graph" / "e2e-diff"

        parse_result = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "parse",
            "--workdir", str(workdir),
        )
        assert parse_result.returncode == 0, parse_result.stderr

        graph_path = workdir / "graph.json"
        assert graph_path.exists()
        graph = Graph.model_validate_json(graph_path.read_text())
        assert graph.repo == "testrepo"
        assert graph.nodes

        strict_validate = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "validate",
            "--workdir", str(workdir),
        )
        assert strict_validate.returncode == 1, strict_validate.stdout + strict_validate.stderr

        warn_validate = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "validate",
            "--warn",
            "--workdir", str(workdir),
        )
        assert warn_validate.returncode == 0, warn_validate.stdout + warn_validate.stderr

        validation_path = workdir / "validation_report.json"
        assert validation_path.exists()
        validation = ValidationReport.model_validate_json(validation_path.read_text())
        assert validation.graph_repo == "testrepo"
        assert validation.errors

        diff_result = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "diff",
            "--base", base_sha,
            "--workdir", str(workdir),
            env={"CI": "1"},
        )
        assert diff_result.returncode == 0, diff_result.stdout + diff_result.stderr

        diff_path = workdir / "diff_report.json"
        assert diff_path.exists()
        diff = DiffReport.model_validate_json(diff_path.read_text())
        assert any("new_dependency.py" in node for node in diff.added_nodes)

        status = json.loads(parse_result.stdout)
        assert status["stage"] == "parse"
        assert _read_json(validation_path)["graph_repo"] == "testrepo"
        assert _read_json(diff_path)["head_ref"] == "HEAD"


def test_parse_validate_audit_flow_writes_expected_reports():
    with tempfile.TemporaryDirectory() as tmp:
        repo, _base_sha = _prepare_changed_repo(Path(tmp))
        workdir = repo / ".stark-graph" / "e2e-audit"

        parse_result = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "parse",
            "--workdir", str(workdir),
        )
        assert parse_result.returncode == 0, parse_result.stderr

        validate_result = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "validate",
            "--warn",
            "--workdir", str(workdir),
        )
        assert validate_result.returncode == 0, validate_result.stdout + validate_result.stderr
        ValidationReport.model_validate_json((workdir / "validation_report.json").read_text())

        audit_result = _run(
            repo,
            "--repo-name", "testrepo",
            "--stage", "audit",
            "--warn",
            "--workdir", str(workdir),
        )
        assert audit_result.returncode == 0, audit_result.stdout + audit_result.stderr

        audit_path = workdir / "audit_report.json"
        assert audit_path.exists()
        audit_report = _read_json(audit_path)

        assert audit_report["repo"] == "testrepo"
        assert audit_report["total_nodes"] >= audit_report["nodes_with_docstring"]
        assert isinstance(audit_report["findings"], list)
        assert any(item["finding"] == "NO_DOCSTRING" for item in audit_report["findings"])
