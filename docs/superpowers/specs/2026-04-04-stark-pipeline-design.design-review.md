# Design Review — stark-pipeline

**File:** `docs/superpowers/specs/2026-04-04-stark-pipeline-design.md`
**Review date:** 2026-04-04
**Mode:** standard (2 agents × 12 domains)
**Rounds:** 1 fix + 1 final

---

**Issues found:** 60 | **Noise:** 48 | **Ignored (low):** 29
**Signal-to-noise:** 56%

---

## Fixed (Round 1) — 45 issues addressed

| # | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|----------|--------|----------|---------|-------|---------|
| 1 | both | test-plan | critical | Architecture | No test strategy for the pipeline itself | Added Testing Strategy section |
| 2 | both | data-modeling | critical/high | StageResult | Stage outputs are untyped dict | Added typed StageOutputs per stage |
| 3 | both | data-modeling | high | Finding | Finding schema undefined | Added Finding dataclass with full schema |
| 4 | both | data-modeling | high | phase_progress | Checkpoint schemas undefined | Added full state.json example with schemas |
| 5 | both | completeness | critical | Task/Phase | Task issue schema and phase encoding undefined | Added Task and Phase Schema section |
| 6 | both | completeness | high | Artifacts | Inter-stage artifact formats unspecified | Added Inter-Stage Artifacts table |
| 7 | both | resilience | high | Dispatch | No retry or backoff for dispatch failures | Added retry policy with exponential backoff |
| 8 | both | resilience | high | Dispatch | No concurrency limits for Claude/Codex | Added per-agent semaphores (5/5/3) |
| 9 | both | resilience | high | Dispatch | dispatch_cli has no timeout | Added 120s default timeout |
| 10 | both | resilience | high | Worktree | Cleanup on crash unspecified | Added worktree cleanup policy + startup sweep |
| 11 | both | completeness | high | Concurrent runs | No concurrent run protection | Added file lock mechanism |
| 12 | both | completeness | high | Testing | No testing strategy | Added unit + integration test plan |
| 13 | both | api-design | high | State | Schema version but no migration strategy | Added schema migration section |
| 14 | both | general | high | State | State file no repo binding | Added repo_owner/repo_name namespacing |
| 15 | both | general | high | Budget | No cost/time ceiling | Added --max-cost and --max-time |
| 16 | claude | api-design | high | Auth | GitHub App token TTL for long runs | Added per-batch token refresh |
| 17 | claude | security | high | Auth | Thread-unsafe GH_TOKEN in parallel dispatch | Fixed: per-subprocess env dict |
| 18 | claude | consistency | high | Dispatch | dispatch_worktree accepts agent but fixed to Claude | Removed agent param from dispatch_worktree |
| 19 | claude | consistency | high | CLI/dry-run | --agents default (3) vs dry-run example (2) | Fixed dry-run example to show 3 agents |
| 20 | codex | consistency | critical | Protocol | Phase-execute mode can't be "headless" or "worktree" | Added "mixed" dispatch_mode |
| 21 | both | completeness | high | Docs-update | Stage is a placeholder | Fleshed out: prompt content, output, failure handling |
| 22 | both | completeness | high | Release | Release contract missing | Added versioning, tagging, GitHub Release spec |
| 23 | both | completeness | high | Test policy | Test execution undefined | Added Test Execution Policy section |
| 24 | both | accessibility | high | TUI | Rich Live incompatible with screen readers | Added --no-tui as accessible mode |
| 25 | both | accessibility | medium | Activity log | Color-only differentiation | Added text prefixes for event types |
| 26 | claude | completeness | high | Notification | No escalation notification while away | Added macOS notification + terminal bell |
| 27 | claude | completeness | high | install.sh | Install changes unspecified | Added Installation section |
| 28 | both | completeness | medium | Error handling | docs-update/release error handling undefined | Added failure → escalate rules |
| 29 | codex | completeness | medium | Input handling | Ambiguous inputs not handled | Added error-on-ambiguous behavior |
| 30 | both | data-modeling | medium | Slug | Slug collision across repos | Added repo-scoped slug namespacing |
| 31 | both | data-modeling | medium | Retention | No retention/cleanup policy | Added retention section |
| 32 | claude | data-modeling | medium | Slug | Slug collision handling absent | Addressed via repo namespacing |
| 33 | both | consistency | medium | Success criteria | Token accuracy conflicts with Gemini estimation | Qualified: Gemini tokens noted as approximate with `~` prefix |
| 34 | codex | consistency | high | --agents vs Claude-only | --agents flag conflicts with Claude impl | Added clarification note: --agents = headless only |
| 35 | claude | resilience | medium | ThreadPool | Worker exception handling unspecified | Added per-future catch + DispatchResult recording |
| 36 | claude | resilience | medium | Pre-flight | No dependency check at startup | Added Pre-Flight Check section |
| 37 | codex | resilience | medium | Fan-out | Partial failure behavior undefined | Added: warn below 50%, stage reports partial |
| 38 | both | resilience | medium | Worktree cleanup | Mid-task failure cleanup | Added cleanup-on-any-exit policy |
| 39 | both | api-design | medium | DispatchResult | Nullable token/cost fields no invariant | Clarified: None for CLI mode, always set for LLM dispatch |
| 40 | codex | general | high | Escalation | Critical findings can be bypassed via skip | Added: skip unavailable for critical/blocker |
| 41 | codex | general | high | Validation | No release-candidate validation | Added Release-Candidate Validation section |
| 42 | codex | general | medium | Review findings | No downstream integration path for doc review findings | Added: findings passed as context to downstream stages |
| 43 | codex | api-design | high | Idempotency | External mutations not idempotent | Added Idempotency section |
| 44 | codex | completeness | high | Test policy | Regression test failure recovery undefined | Addressed: failure → escalate |
| 45 | codex | accessibility | medium | Terminal | Narrow terminal behavior undefined | Added minimum width + graceful degradation |

## Unresolved (Final Review) — 15 real issues

These are findings from the final review that were NOT addressed. They represent refinements and edge cases to address during implementation.

| # | Agent(s) | Domain | Severity | Section | Title |
|---|----------|--------|----------|---------|-------|
| 1 | both | data-modeling | high | Task ID | Task identifier inconsistency — int in typed outputs, string "WEBHOOK-15" in state.json example |
| 2 | codex | data-modeling | high | Artifacts | Artifact paths not repo-namespaced (state.json is, artifacts aren't) |
| 3 | codex | data-modeling | high | Finding ID | Finding IDs (r1-f3) not globally unique across stages/tasks — need stage-task-round-ordinal |
| 4 | codex | consistency | critical | Worktree | Worktree cleaned on-any-exit but fix rounds need the worktree to persist across review-fix iterations |
| 5 | codex | consistency | high | Finding | "blocker" severity referenced in escalation rules but not in Finding enum |
| 6 | codex | consistency | high | Pre-flight | Pre-flight can skip Claude check (if not in --agents) but implementation stages always need Claude |
| 7 | codex | general | high | Phase loop | No `git pull origin main` after PR merge — next worktree may branch from stale main |
| 8 | claude | security | high | Slug | Path traversal risk in user-supplied slug — needs sanitization |
| 9 | claude | security | high | Gemini | Gemini prompt exposed in process listing (CLI arg vs stdin) |
| 10 | claude | data-modeling | high | Finding.section | Dual semantics (file path vs section heading) without discriminator |
| 11 | codex | general | high | Docs-update | Direct commits to main bypass branch protection |
| 12 | claude | scalability | medium | audit.jsonl | Concurrent writes from ThreadPool workers without mutex |
| 13 | claude | api-design | high | Retry | Retry conflates transient (timeout, 429) and permanent (bad prompt, auth) failures |
| 14 | claude | resilience | high | Lock | Stale file lock on SIGKILL — needs PID-based liveness check |
| 15 | claude | resilience | high | Worktree | Worktree cleanup-on-any-exit destroys worktree before diff collection and PR creation |

## Noise & False Positives — 48 findings

### By Root Cause

| Root Cause | Count | Examples |
|------------|-------|---------|
| **Intentional v1 scoping** | 18 | Plugin architecture, multiple test commands, agent adapters, extensible stages, degraded budget mode |
| **Existing patterns accepted as-is** | 10 | Claude-specific directories, GitHub-coupled task model, `gh` auth conventions, credential storage |
| **Over-engineering for single-user local tool** | 12 | Trust boundaries, data egress policy, audit log encryption, automated end-to-end tests, schema versioning for all artifacts |
| **Scope creep** | 8 | ADR auto-generation scope, StageOutputs union complexity, `--agents` flag renaming, false_positive status without actor |

### Notable Noise

- "Stage pipeline is closed to additive extension" — explicitly a non-goal (custom pipeline definitions)
- "Implementation depends on single concrete agent" — intentional v1 decision, stated in spec
- "Runtime layout hardcoded to Claude directories" — this IS a Claude Code tool, installed via Claude Code's ecosystem
- "Schema migrations premature" — valid point but the implementation cost is one function and a version field; worth having from day one
- "No data egress policy" — valid security concern but this is a local developer tool sending code to APIs the user has already authenticated with. Same trust model as running `claude` or `codex` directly.

## Changes Made (Round 1)

```
 docs/superpowers/specs/2026-04-04-stark-pipeline-design.md | 374 insertions(+), 38 deletions(-)
```

Major additions:
- Testing Strategy section (unit + integration test plan)
- 8 typed StageOutputs dataclasses + Finding schema
- Task/Phase schema, Inter-Stage Artifacts table
- Resilience: retry/backoff, per-agent concurrency limits, worktree cleanup
- Thread-safe GH_TOKEN, token refresh, concurrent run protection
- Budget ceiling, pre-flight check, escalation notification
- docs-update, release, release-candidate validation stage designs
- Schema migration strategy, retention/cleanup policy
- Accessibility: --no-tui as accessible mode, text prefixes, terminal compat
- Installation section for install.sh

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Both agents flagged extensibility of intentional v1 scoping decisions | **Global** | `global/prompts/design-review/*/extensibility.md` — add context-awareness for explicit non-goals |
| Codex flags security/trust-boundary concerns inappropriate for local dev tools | **Global** | `global/prompts/design-review/codex/security.md` — calibrate for tool type |
| Both agents generated many duplicate findings across domains | **Global** | All domain prompts — add "do not repeat findings from other domains" instruction |
| Scope-creep findings (plugin architecture, full e2e tests, agent adapters) | **Global** | `global/prompts/design-review/*/scope.md` — respect stated non-goals |

---

## Metrics

```
Total duration:     ~17m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   9m 56s
    Round 1 dispatch:     5m 11s (24/24 succeeded)
    Round 1 classify+fix: 4m 45s
  Phase 3 (Final):        5m 19s (24/24 succeeded)
  Phase 4 (Summary):      ~1m
  Phase 5 (Output):       ~30s

Issues found:        60 (45 fixed, 15 unresolved)
Noise:               48
Ignored (low):       29
Signal-to-noise:     56%
Agents:              48 dispatched, 48 succeeded, 0 failed
Rounds:              1 fix + 1 final
```

No improvement opportunities detected (all agents succeeded, no phase > 70% of total).
