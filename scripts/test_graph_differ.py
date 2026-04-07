"""Unit tests for scripts/graph/graph_differ.py.

Covers: added/removed nodes, added/removed edges, blast radius (direct,
transitive, depth cap, cycle safety), event subscribers, DiffReport validation.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).parent))

from graph.model import BlastRadius, DiffReport, Edge, Graph, Node
from graph.graph_differ import GraphDiffer


# ── Helpers ──────────────────────────────────────────────────────────────


def _node(
    node_id: str,
    *,
    layer: Literal["module", "class"] = "module",
    depends: list[str] | None = None,
    publishes: list[str] | None = None,
    parent: str | None = None,
) -> Node:
    return Node(
        id=node_id,
        layer=layer,
        parent=parent,
        depends=depends or [],
        publishes=publishes or [],
        file_path="test.py",
        line=1,
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
    repo: str = "testrepo",
) -> Graph:
    return Graph(
        schema_version="1.0",
        repo=repo,
        nodes=nodes,
        edges=edges or [],
    )


DIFFER = GraphDiffer()


# ── Node diff ─────────────────────────────────────────────────────────────


class TestNodeDiff:
    def test_added_node(self):
        base = _graph([_node("A")])
        head = _graph([_node("A"), _node("B")])
        report = DIFFER.diff(base, head)
        assert report.added_nodes == ["B"]
        assert report.removed_nodes == []

    def test_removed_node(self):
        base = _graph([_node("A"), _node("B")])
        head = _graph([_node("A")])
        report = DIFFER.diff(base, head)
        assert report.removed_nodes == ["B"]
        assert report.added_nodes == []

    def test_no_node_changes(self):
        base = _graph([_node("A"), _node("B")])
        head = _graph([_node("A"), _node("B")])
        report = DIFFER.diff(base, head)
        assert report.added_nodes == []
        assert report.removed_nodes == []

    def test_multiple_added_and_removed(self):
        base = _graph([_node("A"), _node("B")])
        head = _graph([_node("A"), _node("C"), _node("D")])
        report = DIFFER.diff(base, head)
        assert "B" not in report.added_nodes
        assert sorted(report.added_nodes) == ["C", "D"]
        assert report.removed_nodes == ["B"]

    def test_diff_report_is_valid_pydantic_model(self):
        base = _graph([_node("A")])
        head = _graph([_node("B")])
        report = DIFFER.diff(base, head)
        assert isinstance(report, DiffReport)
        assert report.base_ref == "base"
        assert report.head_ref == "head"


# ── Edge diff ─────────────────────────────────────────────────────────────


class TestEdgeDiff:
    def test_added_edge(self):
        nodes = [_node("A"), _node("B")]
        base = _graph(nodes, [])
        head = _graph(nodes, [_edge("A", "B")])
        report = DIFFER.diff(base, head)
        assert report.added_edges == ["A->B:imports"]
        assert report.removed_edges == []

    def test_removed_edge(self):
        nodes = [_node("A"), _node("B")]
        base = _graph(nodes, [_edge("A", "B")])
        head = _graph(nodes, [])
        report = DIFFER.diff(base, head)
        assert report.removed_edges == ["A->B:imports"]
        assert report.added_edges == []

    def test_no_edge_changes(self):
        nodes = [_node("A"), _node("B")]
        e = _edge("A", "B")
        base = _graph(nodes, [e])
        head = _graph(nodes, [_edge("A", "B")])
        report = DIFFER.diff(base, head)
        assert report.added_edges == []
        assert report.removed_edges == []

    def test_edge_key_includes_type(self):
        """Two edges with same source/target but different type are distinct."""
        nodes = [_node("A"), _node("B")]
        base = _graph(nodes, [_edge("A", "B", "imports")])
        head = _graph(nodes, [_edge("A", "B", "calls")])
        report = DIFFER.diff(base, head)
        assert "A->B:calls" in report.added_edges
        assert "A->B:imports" in report.removed_edges


# ── Blast radius ──────────────────────────────────────────────────────────


class TestBlastRadiusDirect:
    def test_direct_caller_of_added_node(self):
        """When node X is added and Y imports X, Y is in direct blast radius."""
        x = _node("X")
        y = _node("Y")
        base = _graph([y])
        head = _graph([x, y], [_edge("Y", "X")])
        report = DIFFER.diff(base, head)
        assert "Y" in report.blast_radius.direct

    def test_direct_caller_of_removed_node(self):
        """When node X is removed and Y imports X, Y is in direct blast radius."""
        x = _node("X")
        y = _node("Y")
        base = _graph([x, y], [_edge("Y", "X")])
        head = _graph([y])
        report = DIFFER.diff(base, head)
        assert "Y" in report.blast_radius.direct

    def test_changed_node_itself_not_in_blast_radius(self):
        """The changed node itself should not appear in blast radius."""
        base = _graph([_node("A")])
        head = _graph([_node("A"), _node("B")])
        report = DIFFER.diff(base, head)
        assert "B" not in report.blast_radius.direct
        assert "B" not in report.blast_radius.transitive

    def test_no_blast_radius_when_no_changes(self):
        nodes = [_node("A"), _node("B")]
        base = _graph(nodes, [_edge("A", "B")])
        head = _graph(nodes, [_edge("A", "B")])
        report = DIFFER.diff(base, head)
        assert report.blast_radius.direct == []
        assert report.blast_radius.transitive == []
        assert report.blast_radius.depth_cap_reached is False


class TestBlastRadiusTransitive:
    def test_transitive_callers_included(self):
        """C imports B imports A; A changes -> B in direct, C in transitive."""
        a = _node("A")
        b = _node("B")
        c = _node("C")
        base = _graph([b, c], [_edge("B", "A"), _edge("C", "B")])
        head = _graph([a, b, c], [_edge("B", "A"), _edge("C", "B")])
        report = DIFFER.diff(base, head)
        assert "B" in report.blast_radius.direct
        assert "C" in report.blast_radius.transitive

    def test_depth_cap_not_reached_for_short_chain(self):
        """Chain of length 2 doesn't hit default cap of 5."""
        a = _node("A")
        b = _node("B")
        c = _node("C")
        base = _graph([b, c], [_edge("B", "A"), _edge("C", "B")])
        head = _graph([a, b, c], [_edge("B", "A"), _edge("C", "B")])
        report = DIFFER.diff(base, head)
        assert report.blast_radius.depth_cap_reached is False


class TestBlastRadiusDepthCap:
    def test_depth_cap_reached_flag(self):
        """With cap=2 and a chain longer than 2, depth_cap_reached is True."""
        # Chain: A (changed) <- B <- C <- D (depth 3 from A)
        nodes = [_node(n) for n in ["A", "B", "C", "D"]]
        base_nodes = [_node(n) for n in ["B", "C", "D"]]
        edges = [_edge("B", "A"), _edge("C", "B"), _edge("D", "C")]
        base = _graph(base_nodes, edges)
        head = _graph(nodes, edges)
        report = DIFFER.diff(base, head, transitive_depth_cap=2)
        assert report.blast_radius.depth_cap_reached is True

    def test_depth_cap_not_reached_exactly_at_cap(self):
        """Chain of length == cap should not raise depth_cap_reached."""
        # Chain: A (changed) <- B <- C (depth 2 from A, cap=2)
        nodes = [_node(n) for n in ["A", "B", "C"]]
        base_nodes = [_node(n) for n in ["B", "C"]]
        edges = [_edge("B", "A"), _edge("C", "B")]
        base = _graph(base_nodes, edges)
        head = _graph(nodes, edges)
        report = DIFFER.diff(base, head, transitive_depth_cap=2)
        assert report.blast_radius.depth_cap_reached is False


class TestBlastRadiusCycle:
    def test_cycle_no_infinite_loop(self):
        """A->B->C->A cycle; changing A should terminate without infinite loop."""
        a = _node("A")
        b = _node("B")
        c = _node("C")
        # Callers: B imports A, C imports B, A imports C (cycle)
        # In reverse graph (who is called by whom): A<-B<-C<-A
        edges = [_edge("B", "A"), _edge("C", "B"), _edge("A", "C")]
        base = _graph([b, c], edges[:2])
        head = _graph([a, b, c], edges)
        # Should complete without error
        report = DIFFER.diff(base, head)
        assert isinstance(report, DiffReport)

    def test_self_loop_no_infinite_loop(self):
        """Node that imports itself should not cause infinite loop."""
        a = _node("A")
        edges = [_edge("A", "A")]
        base = _graph([], [])
        head = _graph([a], edges)
        report = DIFFER.diff(base, head)
        assert isinstance(report, DiffReport)


# ── Event subscribers ─────────────────────────────────────────────────────


class TestEventSubscribers:
    def test_subscriber_of_publishing_changed_node(self):
        """B subscribes to events from A (via depends); A changes -> B is event subscriber."""
        a = _node("A", publishes=["event.foo"])
        b = _node("B", depends=["A"])
        base = _graph([b])
        head = _graph([a, b])
        report = DIFFER.diff(base, head)
        assert "B" in report.blast_radius.event_subscribers

    def test_no_subscriber_when_no_publishes(self):
        """Node without publishes produces no event subscribers."""
        a = _node("A")  # no publishes
        b = _node("B", depends=["A"])
        base = _graph([b])
        head = _graph([a, b])
        report = DIFFER.diff(base, head)
        assert report.blast_radius.event_subscribers == []

    def test_subscriber_only_when_depends_matches_changed_publisher(self):
        """Event subscriber only when depends references a *changed* publishing node."""
        # A (unchanged, publishes), B (changed), C depends on A
        a = _node("A", publishes=["event.foo"])
        b = _node("B")
        c = _node("C", depends=["A"])
        base = _graph([a, c])
        head = _graph([a, b, c])
        report = DIFFER.diff(base, head)
        # A didn't change, so C is NOT an event subscriber due to A
        assert "C" not in report.blast_radius.event_subscribers


# ── BlastRadius model ─────────────────────────────────────────────────────


class TestBlastRadiusModel:
    def test_blast_radius_is_pydantic_model(self):
        br = BlastRadius(direct=["A"], transitive=["B"], depth_cap_reached=False)
        assert br.direct == ["A"]
        assert br.transitive == ["B"]
        assert br.depth_cap_reached is False
        assert br.event_subscribers == []

    def test_blast_radius_extra_fields_forbidden(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            BlastRadius(direct=[], unknown_field="x")  # type: ignore[call-arg]

    def test_diff_report_blast_radius_is_blast_radius_type(self):
        report = DiffReport(
            base_ref="main",
            head_ref="feature",
            blast_radius=BlastRadius(),
        )
        assert isinstance(report.blast_radius, BlastRadius)


import pytest
