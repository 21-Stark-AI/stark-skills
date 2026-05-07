---
name: stark-copilot
description: >-
  Autonomous lead/wing implementation: lead subagent implements, wing subagent reviews, fix-loop until wing approves. Use for copilot, paired build.
argument-hint: '<plan-or-prompt> [--plan-slug SLUG] [--test-command CMD] [--lead claude|codex|gemini] [--wing claude|codex|gemini] [--max-rounds N] [--timeout N] [--dry-run]'
disable-model-invocation: true
model: opus
revision: 6a876df0bd7f09205302528654ccf07e5b4c3efd
revision_date: 2026-05-07T05:24:00Z
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-copilot --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue if both the configured lead and wing agents are available.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-copilot

Autonomous implementation with a paired **lead/wing** subagent loop. Unlike `/stark-autopilot`,
which has every enabled agent compete in a tournament per step, copilot uses two roles:

- **Lead** (default `claude`) — implements the step in a git worktree
- **Wing** (default `codex`) — reviews the lead's diff and either approves or returns blocking findings

Each step runs a review→fix loop until the wing approves or `--max-rounds` is reached.
This is the cheaper, lower-variance sibling of autopilot — paired engineering instead of competition.

## Arguments

- `<plan-or-prompt>` — path to implementation plan, or inline task description
- `--plan-slug SLUG` — fetch issues labeled `plan:{SLUG}` from GitHub and use as steps (alternative to plan file)
- `--test-command CMD` — test command to run after each step (e.g., `npm test`, `pytest`)
- `--lead AGENT` — lead implementer agent ID (default: `claude`). One of `claude`, `codex`, `gemini`.
- `--wing AGENT` — wing reviewer agent ID (default: `codex`). Must differ from `--lead`.
- `--max-rounds N` — maximum review→fix rounds per step (default: `2`)
- `--timeout N` — per-agent timeout in seconds (default: 900)
- `--dry-run` — show what would happen without executing

If `--lead` and `--wing` are equal, error and stop:
> Error: --lead and --wing must be different agents.

If no input provided, ask: "What should I build?"

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
REPO_ROOT = $(git rev-parse --show-toplevel)
LEAD    = (resolved from --lead, default claude)
WING    = (resolved from --wing, default codex)
```

## Phase 1: Setup

### 1.1 Parse input

Three input modes, resolved in this order:

**Issue-driven (preferred — from `/stark-plan-to-tasks` output):** If `--plan-slug SLUG` is provided, or if the input is a `.md` file path, attempt to load steps from GitHub issues:

1. Derive `PLAN_SLUG`:
   - If `--plan-slug` was given, use it directly
   - If a plan file was given, derive from filename: strip `.md`, strip known suffixes (`-design`, `-spec`, `-plan`). Truncate to 47 chars + 3-char hash if >50. Same logic as `/stark-plan-to-tasks` §1.7.

2. Detect target repo (frontmatter → body scan → `git remote -v` → ask user).

3. Fetch issues:
   ```bash
   unset GH_TOKEN
   gh issue list \
     --label "plan:$PLAN_SLUG" \
     --repo $ORG_REPO \
     --state all \
     --json number,title,body,labels,state \
     --limit 200
   ```

4. If issues found: enter **issue-driven mode** (see §1.2).
5. If no issues found and input is a `.md` file: fall back to **plan-file mode** with a warning.
6. If no issues found and `--plan-slug` was explicit: error and stop.

**Plan file (fallback):** If input is a `.md` file and no matching issues were found, read it and extract the step list. Each `## Phase N` or `### Task N` heading becomes a step.

**Inline prompt:** If input is a description (not a file path, no `--plan-slug`), decompose into steps yourself.

When a plan file path is available, retain it as `plan_path` for the approach contract step.

### 1.2 Extract steps

Same as `/stark-autopilot` §1.2 (issue-driven, plan-file, and inline modes). Each step contains:
- `step_id` — phase slug
- `title` — phase name
- `prompt` — composed implementation prompt
- `issue_numbers` — issue numbers covered by the step

Skip closed and human-led tasks with the same warnings as autopilot.

### 1.3 Detect test command

Same as `/stark-autopilot` §1.3.

### 1.4 Show battle plan

```
stark-copilot — Battle Plan
───────────────────────────
Mode:         issue-driven (plan:widget-system, 12 tasks across 4 phases)
Steps:        4
Lead:         claude   (implementer)
Wing:         codex    (reviewer)
Max rounds:   2
Test command: pytest
Timeout:      900s per agent

Step 1: Data Model & Storage (#37, #38, #39)
Step 2: API Layer (#40, #41, #42)
...

Each step: lead implements in worktree → wing reviews diff → fix-loop until approved → merge
```

In plan-file or inline mode, replace the Mode line with `Mode: plan-file` or `Mode: inline`.

If `--dry-run`, stop here.

### 1.5 Approach Contract

Before dispatching agents, confirm the approach:
```bash
python3 ~/.claude/code-review/scripts/approach_contract.py --plan-file <plan_path> --force-confirm
```

## Phase 2: Execute Steps

For each step (sequentially — each builds on the previous step's merged result):

### 2a0. Transition issues to In Progress

Update issue status and project board. For commands, see [autopilot's references/issue-management.md](../stark-autopilot/references/issue-management.md).

### 2a. Build implement prompt

Combine:
1. The lead's implementation prompt from `global/prompts/copilot/{LEAD}/implement.md`
2. Context: what was already implemented in previous steps (file list + key decisions)
3. The step's specific task description
4. The test command if available

Write the combined prompt to `/tmp/stark-copilot-$$/step-$step_id-implement.md`.

### 2b. Dispatch lead in worktree

Reuse the autopilot dispatcher with `--agents` filtered to the lead only:

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --prompt-file /tmp/stark-copilot-$$/step-$step_id-implement.md \
  --agents "$LEAD" \
  --timeout $timeout \
  [--test-command "$test_command"]
```

Capture JSON output. The lead's worktree path, diff, files changed, and test result are in the result block under `agents[0]`.

If the lead errored or produced an empty diff, log the failure and abort the step (see [failure-modes](../stark-autopilot/references/failure-modes.md)).

### 2c. Review→fix loop

Set `round = 1`. Loop while `round <= max_rounds`:

#### 2c.i Build review prompt

Combine:
1. The wing's review prompt from `global/prompts/copilot/{WING}/review.md`
2. The step's task description and acceptance criteria
3. The lead's diff (from §2b output)
4. Test results (pass/fail + output, if available)
5. Any prior round's wing findings and lead responses (for context across rounds)

Write to `/tmp/stark-copilot-$$/step-$step_id-review-r$round.md`.

#### 2c.ii Dispatch wing reviewer

The wing reviews the diff out-of-tree (does not modify code). Dispatch the wing as a one-shot review using its CLI:

- **Wing = claude:** dispatch via `claude_utils.build_claude_cmd` with `--print` and the review prompt on stdin. Use the configured Claude model from `config.json`.
- **Wing = codex:** dispatch via `codex exec` with reasoning effort `medium`; parse JSONL output via `codex_utils.parse_jsonl_output`.
- **Wing = gemini:** dispatch via `gemini_utils` (with API key fallback if needed).

The wing must return a structured verdict. Require this trailing JSON block in its output:

```json
{
  "verdict": "approve" | "revise" | "block",
  "blocking_findings": ["..."],
  "non_blocking_suggestions": ["..."],
  "summary": "one paragraph"
}
```

- `approve` — diff is good as-is; exit the loop.
- `revise` — there are blocking issues the lead can address; continue to §2c.iii.
- `block` — the diff is fundamentally wrong (architectural mismatch, scope creep, security risk); abort the step and surface the wing's reasoning. Do not silently retry.

If the wing fails to produce a parseable verdict after one retry, treat it as `revise` with finding "wing review failed to parse — manual inspection required" and continue.

#### 2c.iii If verdict == approve

Exit the loop. Proceed to §2d.

#### 2c.iv If verdict == revise and round < max_rounds

Build a fix prompt that includes:
1. The lead's `implement.md` prompt (with a "REVISION ROUND" framing)
2. The original step task
3. The wing's blocking findings (verbatim)
4. The current diff (so the lead resumes from where it left off)

Re-dispatch the lead in the **same worktree** (do not create a new one):

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --prompt-file /tmp/stark-copilot-$$/step-$step_id-fix-r$round.md \
  --agents "$LEAD" \
  --resume-worktree \
  --timeout $timeout \
  [--test-command "$test_command"]
```

If `autopilot_dispatch.py` does not yet support `--resume-worktree`, fall back to running the lead's CLI directly inside the existing worktree path (captured from §2b). The goal is: the lead picks up its prior work and addresses the wing's findings.

Increment `round`. Re-collect diff and test results. Go back to §2c.i.

#### 2c.v If round > max_rounds and verdict still != approve

Surface the unresolved findings and stop the run (do not silently merge):
> Step {step_id}: wing did not approve after {max_rounds} rounds. Blocking findings:
> - ...
> Run terminated. Address findings manually or rerun with `--max-rounds N` raised.

#### 2c.vi If verdict == block at any round

Stop immediately. Print the wing's reasoning. Do not increment rounds.

### 2d. Verify approved diff (MANDATORY — do not skip)

Before applying, the approved diff must pass import checks, SDK API verification, and cross-module interface checks. For all gate details, see [autopilot's references/verification-gates.md](../stark-autopilot/references/verification-gates.md).

If a gate fails: do **not** silently fall back. Re-dispatch one more wing review with the gate failure included as a finding, then run one more lead fix round (counts against `--max-rounds`). If it still fails, stop the run.

### 2e. Apply approved diff

Apply the lead's final diff to the main working tree:

```bash
git apply --3way <<< "$lead_diff"
```

If the diff fails to apply cleanly, fall back to copying files from the lead's worktree.

### 2f. Commit step

```bash
git add -A
git commit -m "feat: [step title] (copilot: $LEAD impl, $WING review, $rounds rounds)"
```

### 2f1. Transition issues to Done

Close issues with commit reference and update project board. For commands, see [autopilot's references/issue-management.md](../stark-autopilot/references/issue-management.md).

### 2g. Clean up worktrees

```bash
$PYTHON $SCRIPTS/autopilot_dispatch.py \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --cleanup
```

### 2h. Log and continue

Print step summary (lead, wing, rounds, files changed, test result), then move to next step.

### 2i. Session state update

After each step completes:
```bash
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```
Call `add_task("{step_id}")` programmatically. Generate a checkpoint every `context_compaction.checkpoint_interval_minutes` minutes (default 15):
```bash
python3 ~/.claude/code-review/scripts/context_compactor.py --json 2>/dev/null || true
```

## Phase 2.5: End-of-Run Verification (MANDATORY)

After ALL steps complete, run full import chain test, smoke test, and SDK API spot-check. For procedures, see [autopilot's references/verification-gates.md](../stark-autopilot/references/verification-gates.md).

If ANY check fails, fix before proceeding to Phase 3.

## Phase 3: Summary

Print:
- Per-step results: step_id, title, rounds, wing verdict, test pass/fail, files changed
- Aggregate: total rounds, average rounds per step, lead/wing identities, total duration
- Code stats: lines added/removed, files touched

## Phase 4: Persist

### 4a. Save history

```bash
mkdir -p ~/.claude/code-review/history/copilot/{task-slug}
```

Write:
- `steps.json` — per-step results, rounds, wing verdicts, diffs
- `summary.md` — human-readable summary
- `review-log.jsonl` — per-round wing review verdicts and findings (audit trail)

### 4b. Post to PR (if PR detected)

Post the summary as a PR comment under the lead's GitHub App identity (e.g., stark-claude when lead=claude).

## Observability

Reuse autopilot's task templates, log line formats, and metrics block format with role substitution (lead/wing instead of competing agents). See [autopilot's references/observability.md](../stark-autopilot/references/observability.md).

## Failure Modes

Most autopilot failure modes apply here too — see [autopilot's references/failure-modes.md](../stark-autopilot/references/failure-modes.md). Copilot-specific additions:

| Scenario | Recovery |
|---|---|
| Lead times out on initial implement | Abort step. No wing dispatch. Surface the timeout. |
| Wing times out reviewing | Retry wing once with same prompt; if still fails, treat as `revise` with synthetic finding "wing review timed out". |
| Wing returns malformed JSON verdict | Retry once with explicit "respond with the JSON block only" suffix; if still malformed, treat as `revise`. |
| `--lead` == `--wing` | Refuse to start; error in §1.0. |
| Lead's revision round produces empty diff (no changes from prior round) | Treat as "lead unable to address findings"; stop the run with the wing's last findings. |
| Wing returns `block` verdict | Stop immediately; do not retry. The wing's reasoning is surfaced verbatim. |
