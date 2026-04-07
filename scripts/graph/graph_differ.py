"""Graph differ for stark-graph.

Compares two Graph objects (base vs head) and produces a DiffReport that
includes changed nodes, changed edges, and blast-radius analysis.

Blast radius:
- direct        — nodes that directly import/call any changed node (depth 1)
- transitive    — nodes reachable via reverse BFS within transitive_depth_cap
- depth_cap_reached — True when BFS was cut short by the cap
- event_subscribers — nodes whose ``depends`` reference a changed node that
                      has non-empty ``publishes``
"""

from __future__ import annotations

from collections import deque

from .model import BlastRadius, DiffReport, Graph


def _edge_key(edge) -> str:
    """Canonical string key for an edge: 'source->target:type'."""
    return f"{edge.source}->{edge.target}:{edge.type}"


class GraphDiffer:
    def diff(
        self,
        base: Graph,
        head: Graph,
        base_ref: str = "base",
        head_ref: str = "head",
        transitive_depth_cap: int = 5,
    ) -> DiffReport:
        """Compare *base* and *head* graphs; return a DiffReport.

        Args:
            base: Graph at the base ref (before the change).
            head: Graph at the head ref (after the change).
            base_ref: Label for the base ref (e.g. commit SHA or branch name).
            head_ref: Label for the head ref.
            transitive_depth_cap: Maximum BFS depth for transitive blast radius.

        Returns:
            :class:`~graph.model.DiffReport` populated with diffs and blast radius.
        """
        # ── Node diff ────────────────────────────────────────────────────
        base_node_ids = {n.id for n in base.nodes}
        head_node_ids = {n.id for n in head.nodes}

        added_nodes = sorted(head_node_ids - base_node_ids)
        removed_nodes = sorted(base_node_ids - head_node_ids)

        # ── Edge diff ────────────────────────────────────────────────────
        base_edge_keys = {_edge_key(e) for e in base.edges}
        head_edge_keys = {_edge_key(e) for e in head.edges}

        added_edges = sorted(head_edge_keys - base_edge_keys)
        removed_edges = sorted(base_edge_keys - head_edge_keys)

        # ── Blast radius ─────────────────────────────────────────────────
        changed_node_ids: set[str] = set(added_nodes) | set(removed_nodes)
        blast = self._compute_blast_radius(
            changed_node_ids, base, head, transitive_depth_cap
        )

        return DiffReport(
            base_ref=base_ref,
            head_ref=head_ref,
            added_nodes=added_nodes,
            removed_nodes=removed_nodes,
            added_edges=added_edges,
            removed_edges=removed_edges,
            blast_radius=blast,
        )

    # ── Blast radius helpers ──────────────────────────────────────────────

    def _compute_blast_radius(
        self,
        changed: set[str],
        base: Graph,
        head: Graph,
        transitive_depth_cap: int,
    ) -> BlastRadius:
        """Compute blast radius using edges from both base and head graphs.

        Uses the union of base and head edges to build the reverse adjacency so
        that callers of *removed* nodes (only present in base) are captured too.
        BFS outward from each changed node up to transitive_depth_cap hops.
        """
        if not changed:
            return BlastRadius()

        # Build reverse adjacency: for each edge A->B, B has caller A.
        # Union of base + head edges so removed-node callers are included.
        reverse: dict[str, list[str]] = {}
        for edge in list(base.edges) + list(head.edges):
            reverse.setdefault(edge.target, []).append(edge.source)

        # BFS from all changed nodes simultaneously
        # depth 1 → direct, depth 2+ → transitive
        visited: set[str] = set(changed)  # never revisit changed nodes themselves
        direct: list[str] = []
        transitive: list[str] = []
        depth_cap_reached = False

        # queue entries: (node_id, depth)
        queue: deque[tuple[str, int]] = deque()
        for node_id in changed:
            for caller in reverse.get(node_id, []):
                if caller not in visited:
                    visited.add(caller)
                    queue.append((caller, 1))

        while queue:
            node_id, depth = queue.popleft()
            if depth == 1:
                direct.append(node_id)
            else:
                transitive.append(node_id)

            if depth < transitive_depth_cap:
                for caller in reverse.get(node_id, []):
                    if caller not in visited:
                        visited.add(caller)
                        queue.append((caller, depth + 1))
            elif depth == transitive_depth_cap:
                # Check if there are callers beyond the cap
                for caller in reverse.get(node_id, []):
                    if caller not in visited:
                        depth_cap_reached = True
                        break

        # ── Event subscribers ─────────────────────────────────────────────
        # Find changed nodes that publish events
        head_node_map = {n.id: n for n in head.nodes}
        publishing_changed: set[str] = {
            nid for nid in changed
            if nid in head_node_map and head_node_map[nid].publishes
        }

        event_subscribers: list[str] = []
        if publishing_changed:
            for node in head.nodes:
                if node.id in changed:
                    continue
                # node.depends is a list of dependency identifiers
                for dep in node.depends:
                    if dep in publishing_changed:
                        event_subscribers.append(node.id)
                        break

        return BlastRadius(
            direct=sorted(set(direct)),
            transitive=sorted(set(transitive)),
            depth_cap_reached=depth_cap_reached,
            event_subscribers=sorted(set(event_subscribers)),
        )
