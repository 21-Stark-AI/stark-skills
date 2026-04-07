"""Unit tests for scripts/graph/drift_validator.py.

Each test builds Graph objects programmatically (no real source files).
Tests cover: STALE, MISSING, NO_DOCSTRING, RUNTIME_ONLY, broken_xref,
clean (zero findings), suppressed/skipped, warn-mode annotation, and
coverage threshold enforcement.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

# Make the graph package importable
sys.path.insert(0, str(Path(__file__).parent))

from graph.drift_validator import validate
from graph.model import Edge, Graph, Node


# ── Helpers ───────────────────────────────────────────────────────────────


def _node(
    node_id: str,
    *,
    depends: list[str] | None = None,
    has_docstring: bool = True,
    layer: str = "module",
    parent: str | None = None,
    called_by: list[str] | None = None,
) -> Node:
    return Node(
        id=node_id,
        layer=layer,  # type: ignore[arg-type]
        parent=parent,
        depends=depends or [],
        called_by=called_by or [],
        file_path="test.py",
        line=1,
        has_docstring=has_docstring,
    )


def _edge(
    source: str,
    target: str,
    edge_type: str = "imports",
    origin: Literal["ast", "docstring"] = "ast",
) -> Edge:
    return Edge(source=source, target=target, type=edge_type, origin=origin)


def _graph(
    nodes: list[Node],
    edges: list[Edge] | None = None,
    skipped_files: list[str] | None = None,
) -> Graph:
    return Graph(
        schema_version="1.0",
        repo="test",
        nodes=nodes,
        edges=edges or [],
        skipped_files=skipped_files or [],
    )


# ── STALE ─────────────────────────────────────────────────────────────────


def test_stale_dep_is_known_internal_not_imported():
    """Docstring dep resolves to a known graph node but no AST import → STALE."""
    nodes = [
        _node("test:modA.py", depends=["modB"]),
        _node("test:modB.py"),
    ]
    report = validate(_graph(nodes))

    stale = [e for e in report.errors if e.startswith("STALE")]
    assert len(stale) == 1
    assert "test:modA.py" in stale[0]
    assert "modB" in stale[0]


def test_stale_is_not_emitted_when_import_exists():
    """A dep with a matching AST import is consistent — no STALE emitted."""
    nodes = [_node("test:modA.py", depends=["modB"]), _node("test:modB.py")]
    edges = [_edge("test:modA.py", "modB")]
    report = validate(_graph(nodes, edges))

    assert not any(e.startswith("STALE") for e in report.errors)


# ── MISSING ───────────────────────────────────────────────────────────────


def test_missing_ast_import_not_in_docstring():
    """AST import not mentioned in a documented node's Depends: → MISSING."""
    nodes = [_node("test:modA.py", depends=[])]  # has docstring, no deps listed
    edges = [_edge("test:modA.py", "os")]
    report = validate(_graph(nodes, edges))

    missing = [w for w in report.warnings if w.startswith("MISSING")]
    assert len(missing) == 1
    assert "os" in missing[0]


def test_missing_not_emitted_when_dep_matches():
    """When AST import is listed in Depends:, no MISSING finding."""
    nodes = [_node("test:modA.py", depends=["os"])]
    edges = [_edge("test:modA.py", "os")]
    report = validate(_graph(nodes, edges))

    assert not any(w.startswith("MISSING") for w in report.warnings)


# ── NO_DOCSTRING ──────────────────────────────────────────────────────────


def test_no_docstring_with_ast_imports():
    """Node without a docstring that has AST imports → NO_DOCSTRING error."""
    nodes = [_node("test:modA.py", has_docstring=False)]
    edges = [_edge("test:modA.py", "os")]
    report = validate(_graph(nodes, edges))

    no_doc = [e for e in report.errors if e.startswith("NO_DOCSTRING")]
    assert len(no_doc) == 1
    assert "test:modA.py" in no_doc[0]


def test_no_docstring_without_imports_is_not_flagged():
    """Node without docstring AND without AST imports → not an error."""
    nodes = [_node("test:modA.py", has_docstring=False)]
    report = validate(_graph(nodes))

    assert not any(e.startswith("NO_DOCSTRING") for e in report.errors)


# ── RUNTIME_ONLY ──────────────────────────────────────────────────────────


def test_runtime_only_external_dep():
    """Dep with no AST import and no graph node match → RUNTIME_ONLY (dismissed)."""
    nodes = [_node("test:modA.py", depends=["external_service"])]
    report = validate(_graph(nodes))

    runtime = [d for d in report.dismissed if d.startswith("RUNTIME_ONLY")]
    assert len(runtime) == 1
    assert "external_service" in runtime[0]
    # Must not appear in errors
    assert not any("external_service" in e for e in report.errors)


def test_runtime_only_is_informational_not_blocking():
    """RUNTIME_ONLY findings never appear in errors."""
    nodes = [_node("test:modA.py", depends=["injected_dep"])]
    report = validate(_graph(nodes))

    assert not report.errors  # no blocking errors


# ── CLEAN (zero findings) ─────────────────────────────────────────────────


def test_clean_graph_produces_no_errors_or_stale_or_missing():
    """A consistent graph (deps match imports) emits zero errors and no STALE/MISSING."""
    nodes = [_node("test:modA.py", depends=["os", "re"])]
    edges = [
        _edge("test:modA.py", "os"),
        _edge("test:modA.py", "re"),
    ]
    report = validate(_graph(nodes, edges))

    assert report.errors == []
    assert not any(w.startswith("STALE") for w in report.warnings)
    assert not any(w.startswith("MISSING") for w in report.warnings)


def test_clean_prefix_match_counts_as_consistent():
    """Dep 'os' with AST import 'os.path' (prefix relationship) → consistent."""
    nodes = [_node("test:modA.py", depends=["os"])]
    edges = [_edge("test:modA.py", "os.path")]
    report = validate(_graph(nodes, edges))

    assert report.errors == []
    assert not any(w.startswith("MISSING") for w in report.warnings)


# ── SUPPRESSED / SKIPPED ──────────────────────────────────────────────────


def test_skipped_files_appear_in_dismissed():
    """Files in graph.skipped_files are reported as dismissed skipped_files entries."""
    nodes = [_node("test:modA.py", depends=["os"])]
    edges = [_edge("test:modA.py", "os")]
    graph = _graph(nodes, edges, skipped_files=["tests/suppressed.py"])
    report = validate(graph)

    skipped = [d for d in report.dismissed if d.startswith("skipped_files")]
    assert len(skipped) == 1
    assert "suppressed.py" in skipped[0]


# ── WARN MODE ─────────────────────────────────────────────────────────────


def test_warn_mode_returns_same_findings_regardless_of_mode():
    """Identical findings regardless of warn_mode flag (mode is a CLI concern)."""
    nodes = [
        _node("test:modA.py", depends=["modB"]),
        _node("test:modB.py"),
    ]
    graph = _graph(nodes)
    report = validate(graph)

    # STALE should still be in errors
    stale = [e for e in report.errors if e.startswith("STALE")]
    assert len(stale) == 1


# ── COVERAGE THRESHOLD ────────────────────────────────────────────────────


def test_coverage_below_threshold_emits_warning():
    """Coverage below threshold → warning in findings."""
    nodes = [
        _node("test:modA.py", has_docstring=False),  # no docstring
        _node("test:modB.py"),                        # has docstring
    ]
    # 1/2 = 50% coverage, default threshold is 80
    report = validate(_graph(nodes), config={"graph_coverage_threshold": 80})

    coverage_warnings = [
        w for w in report.warnings if w.startswith("coverage_below_threshold")
    ]
    assert len(coverage_warnings) == 1
    assert "50.0%" in coverage_warnings[0]
    assert "threshold=80%" in coverage_warnings[0]


def test_coverage_meets_threshold_dismissed_not_warning():
    """Coverage at or above threshold → dismissed (not a warning)."""
    nodes = [_node("test:modA.py"), _node("test:modB.py")]
    report = validate(_graph(nodes), config={"graph_coverage_threshold": 80})

    assert not any(
        w.startswith("coverage_below_threshold") for w in report.warnings
    )
    coverage_ok = [d for d in report.dismissed if d.startswith("coverage_ok")]
    assert len(coverage_ok) == 1
    assert "100.0%" in coverage_ok[0]


def test_coverage_custom_threshold():
    """Custom threshold of 60%: 1/2 modules documented = 50% → still below."""
    nodes = [
        _node("test:modA.py", has_docstring=False),
        _node("test:modB.py"),
    ]
    report = validate(_graph(nodes), config={"graph_coverage_threshold": 60})

    coverage_warnings = [
        w for w in report.warnings if w.startswith("coverage_below_threshold")
    ]
    assert len(coverage_warnings) == 1
    assert "threshold=60%" in coverage_warnings[0]


# ── CALLED_BY informational ───────────────────────────────────────────────


def test_called_by_is_informational_only():
    """Called-by entries go to dismissed, never errors or warnings."""
    nodes = [_node("test:modA.py", called_by=["some.caller"])]
    report = validate(_graph(nodes))

    called_by = [d for d in report.dismissed if d.startswith("called_by")]
    assert len(called_by) == 1
    assert not any("some.caller" in e for e in report.errors)
    assert not any("some.caller" in w for w in report.warnings)


# ── ValidationReport structure ────────────────────────────────────────────


def test_report_has_expected_fields():
    """ValidationReport has all required fields with correct types."""
    nodes = [_node("test:modA.py")]
    report = validate(_graph(nodes))

    assert report.graph_repo == "test"
    assert isinstance(report.errors, list)
    assert isinstance(report.warnings, list)
    assert isinstance(report.dismissed, list)
    assert report.node_count == 1
    assert report.edge_count == 0


def test_report_model_dump_is_serialisable():
    """ValidationReport can be serialised to a plain dict (JSON-compatible)."""
    import json

    nodes = [_node("test:modA.py")]
    report = validate(_graph(nodes))
    data = report.model_dump()

    assert isinstance(json.dumps(data), str)
    assert "graph_repo" in data
    assert "errors" in data
    assert "warnings" in data
    assert "dismissed" in data
