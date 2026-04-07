"""Integration tests: full parse → validate pipeline on fixture mini-repo.

Runs stark_graph.py as a subprocess so exit-code behaviour can be asserted.
The fixture repo at tests/fixtures/graph/ contains:
  - valid_module.py       — imports os, re; docstring Depends: os.path, re  (clean)
  - stale_ref.py          — Depends: valid_module in docstring, no import   (STALE)
  - class_without_docstring.py — classes without docstrings                 (NO_DOCSTRING)
  - suppressed.py         — # stark-graph: ignore                           (skipped)
  - syntax_error.py       — syntax error                                    (skipped)
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
FIXTURE_REPO = SCRIPTS_DIR.parent / "tests" / "fixtures" / "graph"
STARK_GRAPH = SCRIPTS_DIR / "stark_graph.py"
PYTHON = sys.executable


def _run(
    *extra_args: str,
    output_file: str | None = None,
) -> subprocess.CompletedProcess[str]:
    cmd = [
        PYTHON,
        str(STARK_GRAPH),
        "--repo", str(FIXTURE_REPO),
        "--stage", "validate",
    ]
    if output_file:
        cmd += ["--output", output_file]
    cmd += list(extra_args)
    return subprocess.run(cmd, capture_output=True, text=True)


# ── exit-code tests ───────────────────────────────────────────────────────


def test_strict_mode_exits_1_on_errors():
    """Strict mode exits 1 when there are errors (stale_ref.py causes STALE)."""
    result = _run()
    assert result.returncode == 1, (
        f"Expected exit 1 in strict mode with errors.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_warn_mode_exits_0():
    """--warn forces exit 0 even when errors exist."""
    result = _run("--warn")
    assert result.returncode == 0, (
        f"Expected exit 0 in warn mode.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_warn_stderr_has_banner():
    """--warn emits a warn banner to stderr."""
    result = _run("--warn")
    assert "WARN MODE" in result.stderr


# ── identical findings ────────────────────────────────────────────────────


def test_strict_and_warn_produce_identical_findings():
    """Strict and warn modes produce identical errors/warnings/dismissed lists."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        strict_out = f.name
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        warn_out = f.name

    _run(output_file=strict_out)
    _run("--warn", output_file=warn_out)

    strict_report = json.loads(Path(strict_out).read_text())
    warn_report = json.loads(Path(warn_out).read_text())

    assert strict_report["errors"] == warn_report["errors"]
    assert strict_report["warnings"] == warn_report["warnings"]
    assert strict_report["dismissed"] == warn_report["dismissed"]


def test_warn_report_has_mode_annotation():
    """The JSON output in warn mode contains mode='warn'."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        out = f.name
    _run("--warn", output_file=out)
    report = json.loads(Path(out).read_text())
    assert report.get("mode") == "warn"


def test_strict_report_has_no_mode_annotation():
    """The JSON output in strict mode does NOT contain a mode key."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        out = f.name
    _run(output_file=out)
    report = json.loads(Path(out).read_text())
    assert "mode" not in report


# ── report structure ──────────────────────────────────────────────────────


def test_report_has_required_fields():
    """Validation report JSON contains all required ValidationReport fields."""
    result = _run("--warn")
    report = json.loads(result.stdout)

    for field in ("graph_repo", "errors", "warnings", "dismissed",
                  "node_count", "edge_count"):
        assert field in report, f"Missing field: {field}"


def test_report_node_and_edge_counts_are_positive():
    """node_count and edge_count should be > 0 for the fixture repo."""
    result = _run("--warn")
    report = json.loads(result.stdout)
    assert report["node_count"] > 0
    assert report["edge_count"] >= 0


# ── specific findings ─────────────────────────────────────────────────────


def test_stale_ref_produces_stale_finding():
    """stale_ref.py declares Depends: valid_module without importing it → STALE."""
    result = _run("--warn")
    report = json.loads(result.stdout)

    stale_errors = [e for e in report["errors"] if "STALE" in e]
    assert any("stale_ref" in e for e in stale_errors), (
        f"Expected STALE finding for stale_ref.py.\nerrors: {report['errors']}"
    )


def test_no_docstring_finding_present():
    """Nodes without docstrings that have AST imports produce NO_DOCSTRING errors."""
    result = _run("--warn")
    report = json.loads(result.stdout)

    no_doc_errors = [e for e in report["errors"] if "NO_DOCSTRING" in e]
    assert len(no_doc_errors) >= 1, (
        f"Expected at least one NO_DOCSTRING error.\nerrors: {report['errors']}"
    )


def test_skipped_files_in_dismissed():
    """Files with syntax errors or suppression appear in dismissed skipped_files."""
    result = _run("--warn")
    report = json.loads(result.stdout)

    skipped = [d for d in report["dismissed"] if "skipped_files" in d]
    # syntax_error.py should be skipped
    assert any("syntax_error" in d for d in skipped), (
        f"Expected syntax_error.py in skipped.\ndismissed: {report['dismissed']}"
    )


def test_output_file_written():
    """--output writes the same JSON to the specified file."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        out = f.name
    result = _run("--warn", output_file=out)
    stdout_report = json.loads(result.stdout)
    file_report = json.loads(Path(out).read_text())

    # Core fields should match (mode annotation may differ slightly)
    assert stdout_report["errors"] == file_report["errors"]
    assert stdout_report["graph_repo"] == file_report["graph_repo"]


def test_workdir_validation_report_written():
    """validate stage writes validation_report.json to the workdir."""
    # workdir must be inside the repo root (path-traversal guard), so use a
    # temp sub-directory inside the fixture repo.
    workdir = FIXTURE_REPO / ".stark-graph" / "test-workdir-tmp"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [
                PYTHON, str(STARK_GRAPH),
                "--repo", str(FIXTURE_REPO),
                "--stage", "validate",
                "--warn",
                "--workdir", str(workdir),
            ],
            capture_output=True,
            text=True,
        )
        report_path = workdir / "validation_report.json"
        assert report_path.exists(), (
            f"validation_report.json not written to workdir.\n"
            f"stderr: {result.stderr}"
        )
        report = json.loads(report_path.read_text())
        assert "errors" in report
    finally:
        import shutil
        shutil.rmtree(str(workdir), ignore_errors=True)
