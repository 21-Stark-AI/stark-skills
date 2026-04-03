# `stark-pipeline` — End-to-End Feature Orchestrator Design Spec

> Automate the full stark workflow from spec to release: design → review → plan → review → tasks → implement → test → code review → fix → PR → merge → docs → release → housekeeping. Python orchestrator with terminal UI, checkpointing, metrics, and human-in-the-loop escalation.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-04-04-stark-pipeline-design.md`

---

## Problem

The stark-skills ecosystem has mature, battle-tested components for every stage of feature development — design generation, multi-agent review, plan creation, task decomposition, implementation, PR workflow, release management, and housekeeping. But they're all standalone: each skill or dispatch script operates independently with its own invocation pattern, state management, and output format.

Running a full feature from spec to release requires manually chaining 10+ skills/scripts, tracking state across sessions, re-entering context after interruptions, and mentally maintaining the pipeline's progress. This is error-prone, time-consuming, and doesn't scale — especially when the human operator (Aryeh) is in meetings and wants autonomous execution with intelligent escalation.

## Goals

1. **Single-command feature pipeline** — from a spec (or prompt) to a tagged release with one invocation
2. **Checkpoint and resume** — survive crashes, interrupts, and multi-session workflows without losing progress
3. **Terminal UI** — real-time progress display with stage status, elapsed time, cost, and activity log
4. **Human-in-the-loop escalation** — pause on critical issues or missing information, collect guidance, resume
5. **Metrics and telemetry** — token counts, cost tracking, timing, quality stats, final summary
6. **Flexible entry point** — start from any stage based on what input is provided (spec, plan, slug, prompt)
7. **Reuse existing infrastructure** — import from existing dispatch scripts, don't duplicate

## Non-Goals

- DAG-based workflow engine (the pipeline is linear with one nested loop — a DAG scheduler adds complexity without value)
- Web dashboard or remote monitoring (v1 is terminal-only; web UI could be v2)
- Full Textual TUI application (rich Live display is sufficient; Textual graduation is a future option)
- Replacing existing dispatch scripts (the pipeline wraps and orchestrates them, doesn't rewrite them)
- Multi-project pipelines (one pipeline = one feature in one repo)
- Custom pipeline definitions (stages are fixed and known; plugin architecture is over-engineering)

## Success Criteria

1. **End-to-end run completes** — from a design spec to a tagged release with zero manual intervention (assuming no escalations)
2. **Resume works** — kill the pipeline mid-phase-execute, resume with `--resume`, and it continues from the correct task and review round
3. **Escalation round-trips** — pipeline pauses on a persistent medium finding, accepts user guidance, feeds it to the fix agent, and continues
4. **Metrics are accurate** — token counts match CLI output, cost calculations match model rates, timing is wall-clock accurate
5. **TUI is usable** — stage progress, active task, and activity log update in real-time without flicker or corruption
6. **Dry run is informative** — `--dry-run` shows the full execution plan without running anything

---

## Architecture

### Dual Interface

The pipeline has two entry points that converge on the same Python engine:

1. **CLI** — `python scripts/stark_pipeline.py [args]` — run directly from terminal
2. **Skill** — `/stark-pipeline [args]` — Claude Code parses intent, launches the Python process

The Python process owns the TUI, state machine, agent dispatch, and checkpoint persistence. Claude Code is one of the agents it dispatches, not the orchestrator.

### Package Structure

```
scripts/
  stark_pipeline.py          ← entry point, argparse, launches engine
  pipeline/
    __init__.py
    engine.py                ← state machine, stage sequencing, resume logic
    stages.py                ← stage definitions (dataclasses, run/sanity_check/can_skip)
    dispatch.py              ← dispatch_headless, dispatch_worktree, dispatch_cli
    tui.py                   ← rich Live display, layout, formatting
    metrics.py               ← token counting, cost calculation, aggregation
    checkpoint.py            ← state persistence, atomic writes, resume sanity checks
    escalation.py            ← human-in-the-loop prompting, guardrail logic
    worktree.py              ← create/cleanup worktrees, collect diffs
    config.py                ← pipeline config loading, model rates, defaults
skill/
  stark-pipeline/
    SKILL.md                 ← Claude Code skill entry point
```

### Integration with Existing Code

The pipeline imports from existing modules rather than duplicating:

| Module | Imported From | Usage |
|--------|--------------|-------|
| `claude_utils` | `scripts/claude_utils.py` | `make_clean_env()`, CLI command building |
| `gemini_utils` | `scripts/gemini_utils.py` | `setup_gemini_home()`, Gemini CLI patterns |
| `config_loader` | `scripts/config_loader.py` | Hierarchical config discovery |
| `github_app` | `scripts/github_app.py` | Bot token retrieval for reviews |
| `session_state` | `scripts/session_state.py` | Patterns for persistent state (not directly used, but same approach) |

---

## State Machine

### Stage Model

The pipeline is a linear sequence of stages. Each stage implements a uniform protocol:

```python
class Stage(Protocol):
    id: str
    dispatch_mode: Literal["headless", "worktree", "cli"]

    def run(self, context: PipelineContext) -> StageResult: ...
    def sanity_check(self, context: PipelineContext) -> bool: ...
    def can_skip(self, context: PipelineContext) -> bool: ...
```

- `run()` — execute the stage, return results
- `sanity_check()` — verify prerequisites on resume (trust-but-verify)
- `can_skip()` — return True if the stage's output already exists (for entry-point detection)

### PipelineContext

Passed to every stage — the shared state of the pipeline run:

```python
@dataclass
class PipelineContext:
    slug: str
    repo_root: Path
    config: PipelineConfig        # review_mode, max_fix_rounds, agents, model_rates
    state: PipelineState          # current_stage, phase_progress, completed_stages
    tui: TuiController            # for logging events and updating display
    checkpoint: CheckpointManager # for persisting state after transitions
```

### StageMetrics

```python
@dataclass
class StageMetrics:
    wall_time_s: float
    tokens_in: int
    tokens_out: int
    cost_usd: float
    invocation_count: int
    findings_count: int       # 0 for non-review stages
```

### Stage Definitions

| Stage ID | Dispatch Mode | Parallelism | Input | Output |
|----------|--------------|-------------|-------|--------|
| `design-generate` | headless | 3 agents parallel | prompt string | design doc (.md) |
| `design-review` | headless | N×12 domains parallel | design doc | findings JSON |
| `design-to-plan` | headless | 3 gen + 6 review parallel | design doc | plan doc (.md) |
| `plan-review` | headless | N×10 domains parallel | plan doc | findings JSON |
| `plan-to-tasks` | headless | 3 sequential LLM passes | plan doc | GitHub issues |
| `phase-execute` | mixed | see inner loop | GitHub issues | branches, PRs |
| `docs-update` | headless | 1 agent | merged code | updated docs |
| `release` | CLI | sequential | main branch | tag + GitHub release |
| `housekeeping` | CLI | 1 agent | repo state | cleanup report |

### Phase Execute Inner Loop

The `phase-execute` stage contains a nested loop over phases and tasks:

```
for phase in phases:
    for task in phase.tasks:
        ① create worktree
        ② dispatch implement agent (worktree mode)
        ③ run tests in worktree
        for round in 1..max_fix_rounds:
            ④ run code review (headless, single or team)
            ⑤ if clean → break
            ⑥ if round == max_fix_rounds and medium+ findings → escalate
            ⑦ dispatch fix agent in worktree (with structured findings as input)
            ⑧ re-run tests
        ⑨ collect diff, push branch, create PR
        ⑩ merge PR
    end phase → run regression test suite
```

Tasks within a phase execute sequentially (each builds on the previous merge). Phases execute sequentially (later phases depend on earlier ones).

### Review Handling by Stage

**Design review and plan review** produce findings but don't have a fix loop — there's no automated "fix the design" agent. Instead:
- If the review produces only low/medium findings → log them, continue to next stage (findings inform downstream stages)
- If the review produces critical/blocker findings → escalate to user. User can: provide revised spec, accept and continue, or abort.

**Phase-execute review-fix loop** has full automated fixing:

- **Auto-fix** for up to `max_fix_rounds` (default: 3) rounds
- **Escalate immediately** on critical/blocker findings in any round
- **Escalate after round N** if medium+ findings persist
- **Log and continue** for low/info findings that survive all rounds
- **Structured feedback** — review findings are parsed into per-file, per-line structured data and fed to the fix agent as specific instructions, not raw review text

### Implementation Agent

Worktree-mode stages (implement, fix) use **Claude** (`claude --yes -p`) as the default implementation agent. Claude is the only CLI tool with `--yes` mode for non-interactive full-tool-access sessions. This is not configurable in v1 — codex and gemini are used for headless dispatch only.

### StageResult

Every stage returns a uniform result:

```python
@dataclass
class StageResult:
    stage_id: str
    status: Literal["success", "failed", "escalated"]
    outputs: dict          # stage-specific (file paths, PR URLs, issue numbers, etc.)
    metrics: StageMetrics  # tokens, wall_time, cost, invocation_count
    findings: list         # review findings (if applicable)
    error: str | None      # error message if failed
```

---

## Dispatch Layer

### Three Dispatch Modes

```python
def dispatch_headless(
    agent: str,           # "claude" | "codex" | "gemini"
    prompt: str,
    model: str | None,    # override from config
    timeout: int = 300,
) -> DispatchResult:
    """Single-prompt-in, text-out. For reviews, generation, plan creation."""

def dispatch_worktree(
    agent: str,
    prompt: str,
    worktree_path: Path,
    model: str | None,
    timeout: int = 600,
) -> DispatchResult:
    """Full tool access in isolated worktree. For implementation and fixes."""

def dispatch_cli(
    command: list[str],
    env: dict | None,
    cwd: Path | None,
) -> DispatchResult:
    """Simple subprocess wrapper. For git, gh, release scripts."""
```

### DispatchResult

```python
@dataclass
class DispatchResult:
    agent: str
    model: str
    success: bool
    stdout: str
    stderr: str
    exit_code: int
    wall_time_s: float
    tokens_in: int | None     # None for CLI mode
    tokens_out: int | None
    cost_usd: float | None    # calculated from tokens × model rate
    parsed: dict | None       # stage-specific parsed output
```

### Parallel Dispatch

Stages that dispatch multiple agents use `ThreadPoolExecutor` with a Gemini semaphore (max 3 concurrent) — same pattern as `multi_review.py`. The TUI updates as each agent completes.

### Agent Invocation Patterns

- **Claude:** `subprocess.run(["claude", "-p", "-", "--output-format", "json", ...], input=prompt)` via `claude_utils.make_clean_env()`
- **Claude (worktree):** `subprocess.run(["claude", "--yes", "-p", prompt, "--cwd", worktree_path, "--output-format", "json"])`
- **Codex:** `subprocess.run(["codex", "exec", "-m", model, "--json", "-"], input=prompt)`
- **Gemini:** `subprocess.run(["gemini", "-m", model, "-p", prompt, "--yolo"])` via `gemini_utils.setup_gemini_home()`

### GitHub Auth

Follows the existing auth split:

- **User's PAT** (native `gh` auth) for: creating PRs, merging PRs, creating issues
- **Bot tokens** (`stark-claude[bot]`, etc.) for: posting review comments
- `unset GH_TOKEN` before PR/issue operations, `export GH_TOKEN=$(github_app.py token)` for reviews

---

## Checkpointing & Resume

### State File

Each pipeline run persists to `~/.claude/code-review/pipelines/{slug}/state.json`. Updated after every stage transition and every task completion within phase-execute.

```json
{
  "slug": "webhook-support",
  "version": 1,
  "started_at": "2026-04-04T09:15:00Z",
  "updated_at": "2026-04-04T10:42:33Z",
  "input": {
    "type": "design-spec",
    "path": "docs/specs/2026-04-04-webhook-support-design.md",
    "start_stage": "design-review"
  },
  "config": {
    "review_mode": "single",
    "max_fix_rounds": 3,
    "agents": ["claude", "codex", "gemini"]
  },
  "current_stage": "phase-execute",
  "current_phase": 2,
  "current_task": "WEBHOOK-15",
  "current_review_round": 1,
  "completed_stages": [ ... ],
  "phase_progress": { ... },
  "escalations": [ ... ],
  "metrics_summary": { ... }
}
```

### Checkpoint Frequency

| Event | What's Saved |
|-------|-------------|
| Stage completes | Stage result added to `completed_stages`, `metrics_summary` updated |
| Task completes (PR merged) | `phase_progress` updated with task status, PR URL |
| Review round completes | `current_review_round` updated, findings saved |
| Escalation resolved | Resolution added to `escalations` array |
| Pipeline finishes | Final `metrics_summary`, `completed_at` timestamp |

### Atomic Writes

All state file updates use write-to-temp + rename to prevent corruption on crash:

```python
tmp = state_path.with_suffix(".tmp")
tmp.write_text(json.dumps(state, indent=2))
tmp.rename(state_path)
```

### Resume Flow

```
$ python scripts/stark_pipeline.py --resume webhook-support

1. Load state.json
2. Sanity checks (trust-but-verify):
   ✓ Git branch exists?
   ✓ Last PR still open/merged as expected?
   ✓ GitHub issues still match state?
   ✓ Tests still pass on current HEAD?
3. If all pass → continue from current_stage + current_task + current_review_round
4. If any fail → escalate with details of what changed
```

### Metrics Across Sessions

Metrics accumulate across resume boundaries. `metrics_summary` running totals are additive. The final summary reflects the entire run regardless of how many sessions it took.

---

## Terminal UI

### Technology

Built with `rich` only — `rich.live.Live`, `rich.table.Table`, `rich.panel.Panel`, `rich.prompt.Prompt`. No Textual dependency.

### Layout

Three zones stacked vertically, updating in-place via `Live`:

1. **Header bar** — pipeline name, slug, elapsed time, running cost
2. **Stage progress table** — all stages with status (✓/●/○), wall time, cost, key output. Active stage highlighted. Within phase-execute, shows per-task breakdown.
3. **Activity log** — rolling buffer of last 20 events with timestamps, color-coded by type (dispatch, review, fix, escalation)

### Escalation Mode

When the pipeline needs human input:
- Live display pauses
- Header turns red with "⚠ ESCALATION — Pipeline paused"
- Shows: task context, specific finding, what the agent tried
- Four options via `rich.prompt`:
  1. Provide guidance and retry — user text fed to agent as additional context
  2. Skip and continue — finding logged as skipped, pipeline advances
  3. Fix manually, then resume — pipeline waits, user edits code, presses Enter
  4. Abort pipeline — state saved, can `--resume` later

### Final Summary

On completion, displays: total duration (with per-stage breakdown), total cost, token counts, quality stats (found/fixed/skipped/escalated), phases completed, PRs merged, release tag, docs updated.

### `--no-tui` Mode

Plain log output for CI or piped execution. Same information, just sequential log lines instead of live display.

---

## Metrics & Telemetry

### Three Aggregation Levels

1. **Per-invocation** — every dispatch call logged to `pipelines/{slug}/audit.jsonl` (agent, model, tokens, cost, wall_time, success)
2. **Per-stage** — aggregated in `StageResult.metrics` (total tokens, cost, wall_time, invocation_count, findings_count)
3. **Pipeline total** — running totals in `state.json` `metrics_summary`, final snapshot to `pipelines/{slug}/summary.json`

### Token Tracking

- **Claude:** parsed from `--output-format json` response (`usage.input_tokens`, `usage.output_tokens`)
- **Codex:** parsed from `--json` response
- **Gemini:** estimated from prompt/response character length (Gemini CLI doesn't report tokens)

### Cost Calculation

Built-in rate table in `config.json` (overridable):

| Model | Input $/1M | Output $/1M |
|-------|-----------|------------|
| claude-opus-4-6 | $15.00 | $75.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| gpt-5.4 (codex) | $2.50 | $10.00 |
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.15 | $0.60 |

### Summary Output

Final summary written to terminal (rich Panel) and `pipelines/{slug}/summary.json`:

```json
{
  "slug": "webhook-support",
  "duration_s": 6120,
  "total_tokens_in": 612000,
  "total_tokens_out": 98000,
  "total_cost_usd": 7.34,
  "stages_completed": 9,
  "phases_completed": 3,
  "tasks_implemented": 7,
  "prs_merged": ["#87", "#88", "#89"],
  "review_rounds_total": 11,
  "avg_review_rounds_per_task": 1.57,
  "issues_found": 47,
  "issues_fixed": 45,
  "issues_skipped": 2,
  "escalations": 1,
  "release_tag": "v1.4.0"
}
```

---

## Escalation Engine

### Triggers

| Trigger | When | Severity |
|---------|------|----------|
| Critical/blocker finding | Any review round | Immediate pause |
| Medium+ persists after round N | Round N = `max_fix_rounds` | Pause after round |
| Resume sanity check fails | On `--resume` | Before continuing |
| Stage failure | Agent crash, timeout, test failure | After failure |

### Response Options

Consistent across all trigger types:

1. **Provide guidance and retry** — user's text is appended to the agent's prompt as additional context for the next attempt
2. **Skip and continue** — logged as skipped with reason, pipeline advances to next task/stage
3. **Fix manually, then resume** — pipeline waits at a prompt, user edits code externally, presses Enter to trigger re-validation and continue
4. **Abort pipeline** — state saved at current position, can `--resume` later

### Escalation Persistence

Every escalation is recorded in `state.json`:

```json
{
  "at": "2026-04-04T10:30:00Z",
  "stage": "phase-execute",
  "task": "WEBHOOK-14",
  "round": 3,
  "trigger": "medium_persisted",
  "finding": "Missing rate limit on webhook dispatch endpoint",
  "agent_attempts": ["Added per-URL throttle (round 2)", "Added global counter (round 3)"],
  "resolution": "User guidance: add token bucket rate limiter, 100 req/min per tenant",
  "resolved_at": "2026-04-04T10:35:00Z",
  "action": "retry_with_guidance"
}
```

---

## CLI Interface

### Entry Point

```
usage: stark_pipeline.py [-h] [--slug SLUG] [--prompt PROMPT]
                        [--start-at STAGE] [--resume SLUG]
                        [--review-mode {single,team}]
                        [--max-fix-rounds N] [--dry-run]
                        [--agents AGENTS] [--no-tui]
                        [input]

positional arguments:
  input                 path to design spec or plan (.md file)

options:
  --slug SLUG           pipeline identifier (default: derived from input filename)
  --prompt PROMPT       raw requirement string (starts from design generation)
  --start-at STAGE      override entry point stage
  --resume SLUG         resume a previous pipeline run
  --review-mode MODE    "single" (1×9) or "team" (3×9) code reviews (default: single)
  --max-fix-rounds N    max review-fix iterations per task (default: 3)
  --dry-run             show execution plan without running
  --agents AGENTS       comma-separated agent list (default: claude,codex,gemini)
  --no-tui              disable live TUI, plain log output
```

### Entry Point Detection

When no `--start-at` is provided, the pipeline infers the starting stage:

| Input | Heuristic | Start Stage |
|-------|-----------|-------------|
| `.md` file with "Architecture", "Components" | Design spec | `design-review` |
| `.md` file with "Phase", "Tasks", "Implementation" | Plan doc | `plan-review` |
| `--slug` with existing `plan:{slug}` GitHub issues | Issues exist | `phase-execute` |
| `--prompt` string | Raw requirement | `design-generate` |
| `--resume` | Existing state.json | Saved `current_stage` |

### Dry Run

`--dry-run` outputs the full execution plan:

```
Pipeline: webhook-support
Entry point: design-review (detected from input file)

Stages to execute:
  1. design-review     — 2 agents × 12 domains = 24 dispatches
  2. design-to-plan    — 3 generate + 6 cross-review = 9 dispatches
  3. plan-review        — 2 agents × 10 domains = 20 dispatches
  4. plan-to-tasks      — 3 sequential LLM passes
  5. phase-execute      — phases TBD (depends on task decomposition)
  6. docs-update        — 1 dispatch
  7. release            — CLI commands
  8. housekeeping       — 1 dispatch

Estimated dispatches: 58+ (excluding phase-execute)
Review mode: single (1×9 per task)
Max fix rounds: 3
```

---

## `/stark-pipeline` Skill

### SKILL.md Contract

```yaml
name: stark-pipeline
description: End-to-end feature pipeline — design through release
args: [input_path] [--slug NAME] [--prompt "..."] [--resume NAME]
      [--start-at STAGE] [--review-mode single|team]
      [--max-fix-rounds N] [--dry-run] [--no-tui]
```

The skill's job is to:

1. Parse the user's natural language intent into CLI arguments
2. Validate the input exists (if a file path)
3. Launch `python scripts/stark_pipeline.py [args]` as a subprocess
4. The Python process takes over the terminal (TUI)

### Entry Point Detection in Skill

The skill includes heuristics for mapping user intent:

- `/stark-pipeline docs/specs/my-feature.md` → file input, auto-detect start stage
- `/stark-pipeline --slug my-feature` → existing issues, start at phase-execute
- `/stark-pipeline --prompt "Add webhook support"` → raw prompt, start at design-generate
- `/stark-pipeline --resume my-feature` → resume from checkpoint

---

## Dependencies

### Python (existing in repo)

- `rich` — TUI display (Live, Table, Panel, Prompt)
- `subprocess` — agent dispatch
- `concurrent.futures` — ThreadPoolExecutor for parallel dispatch
- `json` — state persistence
- `argparse` — CLI argument parsing
- `dataclasses` — stage and result models
- `pathlib` — file path handling
- `time` — wall clock timing

### External Tools (already installed)

- `claude` CLI — Claude Code agent dispatch
- `codex` CLI — Codex agent dispatch
- `gemini` CLI — Gemini agent dispatch
- `gh` CLI — GitHub PR/issue operations
- `git` — branch and worktree management

### No New Dependencies

The pipeline uses only Python stdlib + `rich` (already a dependency of the repo). No new packages to install.
