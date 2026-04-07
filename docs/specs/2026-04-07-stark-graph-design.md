# stark-graph — Code Dependency Graph System

**Date:** 2026-04-07
**Status:** Design
**Approach:** B — Pluggable Pipeline
**MVP Target:** stark-showcase backend (full vertical slice)

## Problem

Code review agents lack structural awareness. They review diffs in isolation without understanding how changes propagate through the dependency graph. This leads to missed blast radius, undetected breaking changes to consumers, and no validation that documented dependencies match reality.

## Solution

A pluggable pipeline that:
1. Parses source code (AST) and docstrings to build a hierarchical dependency graph
2. Validates declared dependencies (docstrings) match actual dependencies (AST) — strict, CI-blocking
3. Diffs the graph between main and PR branches to surface dependency changes
4. Enriches review agent prompts with graph context for blast radius awareness
5. Posts dependency change summaries as PR comments

## Graph Model

Hierarchical graph with three node layers and typed edges. One JSON file per repo (`dependency-graph.json`), merged at query time for cross-repo views.

### Node

```
id:         "repo:path:qualname"     # globally unique across repos
layer:      module | class | function
parent:     "parent node id"         # null for modules
declared:   [Depends, CalledBy, Publishes]  # from docstring
file_path:  "/absolute/path.py"
line:       42
```

### Edge

```
source:  "node id"
target:  "node id"
type:    imports | inherits | calls | depends
origin:  ast | docstring            # how we discovered this edge
```

### Graph Envelope

```
repo:       "GetEvinced/stark-showcase"
generated:  "2026-04-07T13:00:00Z"
parser:     "python:1.0"
nodes:      [Node, ...]
edges:      [Edge, ...]
```

### Node ID Format

`repo:relative_path:qualname` where qualname follows Python convention:
- Module: `GetEvinced/stark-showcase:backend/showcase/services/version_service.py`
- Class: `GetEvinced/stark-showcase:backend/showcase/services/version_service.py:VersionService`
- Function: `GetEvinced/stark-showcase:backend/showcase/services/version_service.py:VersionService.activate_version`

## Docstring Convention

Structured metadata in docstrings that parsers extract and drift detection validates. Required for classes and modules. Functions inherit from their parent class.

### Class-level (required)

```python
class VersionService:
    """Manage version lifecycle for projects.

    Depends: ProjectRepository, GCSStorage, TypesenseIndex
    Publishes: version.created, version.activated
    Called by: UploadPipeline, BackofficeAPI
    """
```

### Module-level (required)

```python
"""Upload pipeline orchestrator.

Depends: version_service, gcs_storage, typesense_index
Publishes: upload.started, upload.completed
"""
```

### Metadata Fields

| Field | Meaning | Validation |
|-------|---------|------------|
| **Depends** | Services/modules this unit calls or instantiates | Cross-checked against `import` statements + constructor args |
| **Publishes** | Events, signals, or side effects | Trust-only — not import-traceable. Flagged if removed from docstring. |
| **Called by** | Reverse edges — who consumes this | Bidirectional: if A says `Called by: B`, B must say `Depends: A` |

### Parsing Rules

- Fields are case-insensitive: `depends:`, `Depends:`, `DEPENDS:` all match
- Values are comma-separated: `Depends: A, B, C`
- Values match by short name (class name or module stem), not full path
- Fields can appear anywhere in the docstring after the summary line
- Missing docstring on a class/module = drift violation (MISSING)

## Parser Interface

Each language parser implements one protocol:

```python
class Parser(Protocol):
    def parse(self, paths: list[Path], repo: str) -> Graph: ...
    def language(self) -> str: ...
    def file_patterns(self) -> list[str]: ...  # e.g. ["*.py"]
```

### Python Parser (MVP)

Uses the `ast` module. Extracts:
- **Module nodes:** one per `.py` file
- **Class nodes:** `ast.ClassDef` — parent is the module
- **Function nodes:** `ast.FunctionDef` / `ast.AsyncFunctionDef` — parent is the class or module
- **Import edges:** `ast.Import`, `ast.ImportFrom` → `imports` edge type
- **Inheritance edges:** `ast.ClassDef.bases` → `inherits` edge type
- **Call edges:** `ast.Call` where the function is a known node → `calls` edge type
- **Docstring edges:** regex extraction of `Depends:`, `Publishes:`, `Called by:` → `depends` edge type

### TypeScript Parser (Phase 2)

Node.js subprocess using `ts-morph` or the TypeScript compiler API. Same output contract — writes Graph JSON to stdout.

## Pipeline Stages

Seven stages, each a standalone script. Orchestrated by `stark_graph.py` which chains them in sequence.

### Stage 1: Parse (per language)

- Input: list of source files, repo name
- Output: `Graph` JSON (one per language)
- Scripts: `python_parser.py`, `ts_parser.js` (Phase 2)

### Stage 2: Merge

- Input: per-language Graph JSONs + optional cross-repo graphs
- Output: unified `Graph` JSON
- Script: `graph_merge.py`
- Deduplicates nodes by ID, merges edge sets

### Stage 3: Drift Validation (strict)

- Input: merged Graph JSON
- Output: validation report JSON, exit code 0 (pass) or 1 (fail)
- Script: `drift_validator.py`

Four validation checks:

| Check | Meaning | Action |
|-------|---------|--------|
| **STALE** | Docstring declares dep, AST doesn't confirm | CI fail |
| **MISSING** | AST finds dep, docstring doesn't declare | CI fail |
| **BROKEN_XREF** | A says `Called by: B` but B doesn't say `Depends: A` | CI fail |
| **NO_DOCSTRING** | Class/module exists but has no structured docstring | CI fail |

Validation output:

```json
{
  "status": "FAIL",
  "stale": [{"node": "VersionService", "declared": "TypesenseIndex", "evidence": null}],
  "missing": [{"node": "VersionService", "actual": "ReaperJob", "declared": null}],
  "broken_xref": [],
  "no_docstring": ["backend/showcase/utils/helpers.py"],
  "coverage": {"modules": 12, "with_docstring": 10, "pct": 83.3}
}
```

### Stage 4: Diff

- Input: main branch Graph JSON + PR branch Graph JSON
- Output: diff JSON (added/removed/changed edges and nodes)
- Script: `graph_differ.py`

```json
{
  "added_edges": [{"source": "VersionService", "target": "ReaperJob", "type": "depends"}],
  "removed_edges": [{"source": "VersionService", "target": "LegacyIndex", "type": "imports"}],
  "changed_edges": [{"source": "UploadPipeline", "target": "GCSStorage", "detail": "upload() → stream_upload()"}],
  "added_nodes": ["ReaperJob"],
  "removed_nodes": ["LegacyIndex"],
  "blast_radius": {"direct": 3, "transitive": 7, "event_subscribers": 2}
}
```

### Stage 5: Render

- Input: Graph JSON (optionally with diff overlay)
- Output: SVG and/or HTML file
- Script: `graph_renderer.py`
- Uses graphviz for SVG, with layer-based coloring (modules = blue, classes = green, functions = yellow)
- Diff overlay: added edges in green, removed in red, changed in amber

### Stage 6: PR Comment

- Input: diff JSON, validation report
- Output: GitHub PR comment via stark-claude[bot]
- Script: `pr_commenter.py`

Comment format:

```markdown
## Dependency Changes

+ VersionService → ReaperJob (new dependency)
- VersionService → LegacyIndex (removed)
~ UploadPipeline → GCSStorage (calls changed: upload() → stream_upload())

## Blast Radius
Direct: 3 services | Transitive: 7 services | Event subscribers: 2
```

## Review Integration

Graph feeds into the existing review pipeline at two points:

### Pre-Review Gate

`drift_validator.py` runs before `multi_review.py`. If drift is detected, review is blocked and a PR comment explains what's out of sync. No tokens wasted on a review that will fail anyway.

Integration point: `multi_review.py` calls `drift_validator.py` as a pre-check. If exit code is 1, it posts the validation report as a PR comment and exits without running review agents.

### Domain Enrichment

Graph diff JSON is injected into the system prompts for three review domains:
- **architecture** (01-architecture.md) — "These dependency edges were added/removed"
- **correctness** (04-correctness.md) — "These callers may be affected"
- **regression-prevention** (09-regression-prevention.md) — "Blast radius: N direct, M transitive"

The diff is appended as a `## Dependency Context` section in each domain prompt, generated fresh per PR.

## File Structure

```
scripts/
├── graph/                        # all graph pipeline scripts
│   ├── __init__.py
│   ├── model.py                  # Graph, Node, Edge Pydantic models
│   ├── python_parser.py          # Python AST + docstring parser
│   ├── ts_parser.js              # TypeScript parser (Phase 2)
│   ├── graph_merge.py            # merge per-language + cross-repo
│   ├── drift_validator.py        # AST vs docstring strict check
│   ├── graph_differ.py           # main vs PR graph diff
│   ├── graph_renderer.py         # SVG/HTML visualization
│   └── pr_commenter.py           # post diff + blast radius to PR
├── stark_graph.py                # pipeline orchestrator (CLI entry point)

skill/
└── stark-graph/
    └── SKILL.md                  # /stark-graph skill wrapper

global/prompts/
├── claude/
│   └── 01-architecture.md        # enriched with graph context injection
├── codex/
│   └── 01-architecture.md
└── gemini/
    └── 01-architecture.md
```

## CLI Interface

```bash
# Full pipeline on a repo
stark_graph.py --repo /path/to/stark-showcase/backend

# Parse only (outputs Graph JSON to stdout)
stark_graph.py --repo /path/to/repo --stage parse

# Validate only (exits 1 on drift)
stark_graph.py --repo /path/to/repo --stage validate

# Diff against main
stark_graph.py --repo /path/to/repo --stage diff --base main

# Render visualization
stark_graph.py --repo /path/to/repo --stage render --output graph.svg

# Full PR pipeline (validate + diff + render + comment)
stark_graph.py --repo /path/to/repo --pr 123
```

## MVP Scope — stark-showcase backend

Full vertical slice on one repo. Everything works end-to-end before generalizing.

### In Scope
- Python parser (ast module)
- Graph model (Pydantic)
- Drift validator (strict)
- Graph differ (main vs PR)
- SVG/HTML renderer
- PR comment posting
- Review domain enrichment
- `/stark-graph` skill
- Docstring convention docs

### Phase 2
- TypeScript parser
- Cross-repo graph merge
- Weekly LLM audit agent
- Coverage metrics CI artifact
- Interactive D3 explorer

### Out of Scope
- LSP integration
- Runtime tracing
- Go/Java/other language parsers
- Graph database storage
- Historical graph diffing (beyond main vs PR)

## Bootstrap Strategy

Existing code in stark-showcase has no structured docstrings. Bootstrap path:

1. Run parser in `--audit` mode: generates a report of all classes/modules missing docstrings
2. LLM agent reads each class, infers dependencies from AST, generates draft docstrings
3. Human reviews and commits the docstrings
4. Enable strict validation — from this point, all PRs must maintain docstring accuracy

This is a one-time cost per repo. After bootstrap, ongoing maintenance is incremental (update docstrings when you change dependencies).
