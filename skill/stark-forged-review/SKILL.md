---
name: stark-forged-review
description: >-
  Multi-agent PR review with leader + second-opinion per domain, dynamic triage, and forge-style escalation on non-trivial findings. Replaces stark-review.
argument-hint: "[PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]"
disable-model-invocation: true
model: opus[1m]
---

## Preflight

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json
```

Parse the JSON result:
- `overall: blocked` → print failing checks and stop.
- `overall: degraded` → warn and continue.
- `overall: ready` → continue silently.

## Arguments

See `skill/stark-forged-review/README.md` for full details.

- `PR_NUMBER` — optional; auto-detected from current branch if omitted
- `--dry-run` — review only, no commits/pushes/merge
- `--repo ORG/REPO` — override repo detection
- `--resume` — resume from an existing `.forged-review-state.json`
- `--no-escalate` — forbid the forge path
- `--force-escalate` — always take the forge path

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Run

Invoke the Python orchestrator. It prints a single JSON object to stdout and progress to stderr.

```bash
$PYTHON $SCRIPTS/forged_review.py $ARGUMENTS
```

Capture the exit code and stdout JSON.

## Merge confirmation

Parse the stdout JSON. Shape: `{status, pr_number, repo, needs_merge_confirmation, message, summary}` where `status` is one of `clean | dry_run_complete | awaiting_fixes | failed`.

Behavior by status:

- **`clean` + `needs_merge_confirmation: true`**: print the summary, then ask `Clean. Merge PR #<pr_number>? [Y/n]`. On yes/empty, run `unset GH_TOKEN && gh pr merge <pr_number> --squash --delete-branch --repo <repo>`. On no, print `PR left open at user request` and exit 0.
- **`awaiting_fixes`**: print the message and findings summary. Do NOT merge. Exit with the orchestrator's exit code.
- **`dry_run_complete`**: print the summary. Exit 0.
- anything else: print the summary and exit with the orchestrator's exit code.

## Exit codes & observability

| Code | Meaning |
|------|---------|
| 0 | Clean / dry-run complete |
| 1 | Halted / awaiting fixes |
| 2 | Dispatch failure |
| 3 | Invalid input |

The orchestrator emits `forged_review.*` events via `emit_queue.py`, records per-run metrics to `~/.claude/code-review/history/forged-review/forged_review_metrics.db`, and prints `[forged-review] …` progress lines to stderr. See README for details.
