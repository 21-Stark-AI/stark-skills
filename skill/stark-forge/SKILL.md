---
name: stark-forge
description: >-
  Multi-phase design pipeline: generate design, review, plan, review plan, implement. Wraps existing dispatch primitives with domain routing and audit.
argument-hint: '<path> [--auto-detect] [--dry-run] [--resume] [--workers N]'
disable-model-invocation: true
model: opus
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forge --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue with available agents.
- If `overall` is "ready": continue silently.

# stark-forge

End-to-end design pipeline that chains design generation, design review, plan generation,
plan review, and implementation — with per-domain agent routing, iterative refinement,
and audit metrics collection.

**Pipeline:** `/stark-forge` = `/stark-design` → `/stark-review-design` → `/stark-design-to-plan` → `/stark-review-plan` → implement

**Exit codes:**
- `0` — pipeline completed successfully
- `1` — pipeline halted (findings exceeded threshold after max rounds)
- `2` — dispatch failure (agent crash, timeout, or infrastructure error)
- `3` — invalid input (missing file, bad arguments, config error)

## Arguments

- `<path>` — path to requirements or design document (positional, required)
- `--auto-detect` — auto-detect which pipeline phases to run based on document type
- `--dry-run` — run all phases but don't write output files or create PRs
- `--resume` — resume from the last completed phase (reads state from `.forge-state.json`)
- `--workers N` — max concurrent agent workers (default: from config, typically 3)

If no path is provided, ask: "What should forge build? Provide a requirements file path."

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS  = ~/.claude/code-review/scripts
PYTHON   = $SCRIPTS/.venv/bin/python3
PROMPTS  = ~/.claude/code-review/prompts
HISTORY  = ~/.claude/code-review/history/forge
```

## Phase 1: Setup

### 1.1 Parse input

Read the input document at `<path>`. Validate:
- File exists and is readable
- File is markdown (`.md`) or text
- File is non-empty

If `--resume` is set, load `.forge-state.json` from the document's directory and skip to the next incomplete phase.

### 1.2 Initialize state

Create `.forge-state.json` next to the input document:
```json
{
  "version": 1,
  "input_path": "<path>",
  "phases": {
    "design": {"status": "pending"},
    "design_review": {"status": "pending"},
    "plan": {"status": "pending"},
    "plan_review": {"status": "pending"},
    "implement": {"status": "pending"}
  },
  "tdd": {"status": "pending"},
  "current_round": 0,
  "max_rounds": 3,
  "created_at": "<ISO timestamp>"
}
```

### 1.3 Load config

```python
from config_loader import get_forge_config
forge_cfg = get_forge_config()
```

Read `workers`, `max_rounds`, `fix_threshold`, `domain_routing`, and `plan_review_routing` from config.

### 1.4 Initialize audit

```python
from forge_audit import init_metrics_db
init_metrics_db(f"{HISTORY}/forge_metrics.db")
```

### 1.5 Create worktree

Create an isolated git worktree for the pipeline run:
```bash
branch_name="forge/$(basename <path> .md)-$(date +%s)"
git worktree add .worktrees/$(basename $branch_name) -b $branch_name
```

## Phase 2: Design Generation

Dispatch the design generation phase using the forge-specific prompts.

Use `$PROMPTS/forge-design-review/` for domain prompts and agent preambles.

Status output: `[OK] Design generation complete` or `[FAIL] Design generation failed`

## Phase 3: Design Review

For each domain in `domain_routing`:
1. Resolve the assigned agent
2. Dispatch the review using `forge-design-review` prompts
3. Record each call via `forge_audit.record_call()`
4. Collect findings

Status output per domain: `[OK] {domain}` or `[SKIP] {domain}` or `[FAIL] {domain}`

If findings exceed `fix_threshold` after all domains:
- If `current_round < max_rounds`: apply fixes and re-review
- If `current_round >= max_rounds`: `[HALT] Design review — findings remain after {max_rounds} rounds`

The halt round is always `max_rounds + 1` — never hardcode it.

## Phase 4: Plan Generation

Dispatch plan generation from the reviewed design document.

Status output: `[OK] Plan generation complete` or `[FAIL] Plan generation failed`

## Phase 5: Plan Review

For each domain in `plan_review_routing`:
1. Resolve the assigned agent
2. Dispatch the review using `forge-plan-review` prompts
3. Record each call via `forge_audit.record_call()`
4. Collect findings

Same iterative refinement logic as Phase 3.

Status output: `[OK] Plan review complete` or `[HALT] Plan review — findings remain`

## Phase 6: Implementation

Dispatch implementation using the reviewed plan.

Status output: `[OK] Implementation complete` or `[FAIL] Implementation failed`

## Phase 7: Finalize

1. Record the full run via `forge_audit.record_run()`
2. Update `.forge-state.json` with final status
3. Print summary:
   - Total rounds per phase
   - Finding counts by severity
   - Total duration
   - Final outcome

```
[OK] stark-forge complete — 2 design rounds, 1 plan round, 12 findings resolved
```
or
```
[HALT] stark-forge halted at design review — 3 critical findings remain
```
