"""Drift validator for stark-graph.

Compares docstring ``Depends:`` entries to AST-derived import edges and
emits structured findings.

Finding types
-------------
STALE        — docstring dep resolves to a known internal graph node but the
               current node has no matching AST import.  Errors list (CI-blocking
               in strict mode).
MISSING      — the node has a docstring but an AST import is not mentioned in
               its Depends: field.  Warnings list.
NO_DOCSTRING — node has no docstring but has AST imports that should be
               documented.  Errors list.
RUNTIME_ONLY — docstring dep has no AST import AND no match among graph nodes.
               Valid for DI / factory patterns.  Dismissed list (informational).
broken_xref  — docstring dep resolves to multiple graph nodes (ambiguous).
               Warnings list (informational).
called_by    — Called-by entries are informational only, not CI-blocking.
               Dismissed list.
skipped_files — files skipped during parse (timeout, size, syntax error, etc.).
               Dismissed list.
coverage     — coverage metric: warning when below threshold, dismissed when OK.
"""

from __future__ import annotations

from .model import Graph, ValidationReport


# ── Resolution helpers ────────────────────────────────────────────────────


def _node_id_to_module_key(node_id: str) -> str:
    """Convert a node ID to a dotted module key for dep matching.

    Examples::

        "repo:path/to/module.py"          → "path.to.module"
        "repo:path/to/module.py:MyClass"  → "path.to.module"
    """
    # Strip repo prefix
    rest = node_id.split(":", 1)[1] if ":" in node_id else node_id
    # Strip class suffix (second colon segment)
    if ":" in rest:
        rest = rest.split(":")[0]
    # Strip .py extension
    if rest.endswith(".py"):
        rest = rest[:-3]
    # Normalise separators to dots
    return rest.replace("/", ".").replace("\\", ".")


def _match_dep_to_ast(dep: str, ast_targets: set[str]) -> list[str]:
    """Match a docstring dep string against a set of AST import target strings.

    Tries exact match first, then prefix relationship (module / sub-module).

    Returns a list of matching AST targets (empty → no match, 2+ → ambiguous).
    """
    if dep in ast_targets:
        return [dep]
    matches = [
        t for t in ast_targets
        if t.startswith(dep + ".") or dep.startswith(t + ".")
    ]
    return matches


def _match_dep_to_graph(dep: str, module_keys: dict[str, str]) -> list[str]:
    """Match a docstring dep string against the graph's node module keys.

    Returns a list of matching node IDs (empty → external dep, 2+ → ambiguous).
    """
    matches = []
    for node_id, key in module_keys.items():
        if (
            key == dep
            or key.endswith("." + dep)
            or dep.endswith("." + key)
            or dep.startswith(key + ".")
        ):
            matches.append(node_id)
    return matches


# ── Validator ─────────────────────────────────────────────────────────────


def validate(graph: Graph, config: dict | None = None) -> ValidationReport:
    """Run drift validation on *graph*.

    For each node the validator compares its docstring ``Depends:`` entries
    against the node's AST-derived import edges (and, for class nodes, the
    parent module's import edges too).

    Args:
        graph:  Parsed :class:`~graph.model.Graph` to validate.
        config: Optional config dict.  Reads ``graph_coverage_threshold``
                (int, default ``80``) as the minimum acceptable docstring
                coverage percentage for module-level nodes.

    Returns:
        :class:`~graph.model.ValidationReport` populated with findings.
    """
    if config is None:
        config = {}
    coverage_threshold: int = int(config.get("graph_coverage_threshold", 80))

    errors: list[str] = []
    warnings: list[str] = []
    dismissed: list[str] = []

    # --- Build lookup structures ------------------------------------------

    # Precompute the module key for every node (used for graph-node matching)
    module_keys: dict[str, str] = {
        n.id: _node_id_to_module_key(n.id) for n in graph.nodes
    }

    # AST import targets keyed by source node id
    ast_import_targets: dict[str, set[str]] = {}
    for edge in graph.edges:
        if edge.origin == "ast" and edge.type == "imports":
            ast_import_targets.setdefault(edge.source, set()).add(edge.target)

    # Class → parent module id (for inheriting the module's import set)
    class_parents: dict[str, str] = {
        n.id: n.parent
        for n in graph.nodes
        if n.layer == "class" and n.parent
    }

    # --- Per-node analysis ------------------------------------------------

    nodes_with_docstring = 0
    total_module_nodes = sum(1 for n in graph.nodes if n.layer == "module")

    for node in graph.nodes:
        # Effective AST imports: own + parent module (for class nodes)
        node_ast: set[str] = set(ast_import_targets.get(node.id, set()))
        if node.layer == "class" and node.id in class_parents:
            parent_id = class_parents[node.id]
            node_ast |= ast_import_targets.get(parent_id, set())

        # ── NO_DOCSTRING ──────────────────────────────────────────────────
        if not node.has_docstring:
            if node_ast:
                errors.append(f"NO_DOCSTRING {node.id}")
            # Don't count undocumented nodes in coverage numerator
            continue

        # Count documented module nodes toward coverage
        if node.layer == "module":
            nodes_with_docstring += 1

        # ── Check Depends: entries ────────────────────────────────────────
        for dep in node.depends:
            ast_matches = _match_dep_to_ast(dep, node_ast)
            if ast_matches:
                # Consistent: docstring dep corresponds to an actual import
                continue

            # No AST import matches — classify by graph-node resolution
            graph_matches = _match_dep_to_graph(dep, module_keys)

            if len(graph_matches) == 0:
                # Unknown dep — not an internal module; likely runtime injection
                dismissed.append(f"RUNTIME_ONLY {node.id} depends={dep}")
            elif len(graph_matches) == 1:
                # Known internal dep that is not imported → stale docstring
                errors.append(f"STALE {node.id} depends={dep}")
            else:
                # Multiple graph nodes match → ambiguous cross-reference
                warnings.append(
                    f"broken_xref {node.id} depends={dep} "
                    f"candidates={graph_matches}"
                )

        # ── MISSING: AST imports not mentioned in Depends: ────────────────
        for ast_target in sorted(node_ast):
            if not _match_dep_to_ast(ast_target, set(node.depends)):
                warnings.append(f"MISSING {node.id} imports={ast_target}")

        # ── Called-by: informational only ────────────────────────────────
        for caller in node.called_by:
            dismissed.append(f"called_by {node.id} called_by={caller}")

    # --- Skipped files ---------------------------------------------------

    for sf in graph.skipped_files:
        dismissed.append(f"skipped_files {sf}")

    # --- Coverage --------------------------------------------------------

    coverage_pct = round(
        (nodes_with_docstring / total_module_nodes * 100) if total_module_nodes else 0.0,
        1,
    )
    coverage_detail = (
        f"{coverage_pct}% "
        f"({nodes_with_docstring}/{total_module_nodes} modules have docstrings)"
    )
    if coverage_pct < coverage_threshold:
        warnings.append(
            f"coverage_below_threshold {coverage_detail} "
            f"threshold={coverage_threshold}%"
        )
    else:
        dismissed.append(f"coverage_ok {coverage_detail}")

    return ValidationReport(
        graph_repo=graph.repo,
        errors=errors,
        warnings=warnings,
        dismissed=dismissed,
        node_count=len(graph.nodes),
        edge_count=len(graph.edges),
    )
