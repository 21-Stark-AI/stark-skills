# Python → TypeScript Migration Plan

**Date:** 2026-05-20
**Scope:** the 31 Python files remaining under `scripts/`, `scripts/automation/`, and `config/`.

## Why

CLAUDE.md mandates Go for backend / TS for scripts, no new Python, and migration
of existing Python in **deployable slices** — never big-bang. The autopilot,
tournament, skill-doc-viz, and triage subsystems were already deleted (dead code).
What remains is load-bearing: 18 production modules + 12 tests + `conftest.py`.

Prior TS ports set the pattern — `github_app`, `github_projects`, `preflight`,
`self_healer`, `healer_canary`, `alert_delivery`, `context_compactor`,
`session_state`, `skill_router`, `stark_persona`, `copilot_dispatch`,
`design_to_plan_dispatch` (→ `plan_dispatch.ts`). Each: port → delete the Python →
sweep callers. This plan finishes the job.

## Dependency layering

```
Layer 0 (leaves):   _emit   failure_classifier   user_token   statusline-setup   automation/*
Layer 1:            config_loader            (← _emit)
Layer 2:            runtime_env  codex_utils  gemini_utils  validation_gate  approach_contract
Layer 3:            claude_utils             (← config_loader, runtime_env)
Layer 4:            dispatcher_base          (← claude/codex/gemini_utils, config_loader)
Layer 5:            multi_review  plan_review_dispatch  plan_to_tasks_validate
```

Each phase is an independently shippable slice. No phase depends on a later one.

## Phase 1 — Standalone CLI leaves

No Python imports these; each is invoked only as a subprocess. TS ports reuse the
**existing** `tools/emit_queue_lib.ts` and `tools/stark_config_lib.ts`.

| File | Caller | Notes |
|---|---|---|
| `scripts/failure_classifier.py` | stark-phase-execute | Pure leaf — no local imports |
| `scripts/user_token.py` | stark-gh-user (`handler.sh`) | Pure leaf |
| `scripts/validation_gate.py` | stark-phase-execute | Imports `_emit` + `config_loader` → call TS libs |
| `scripts/approach_contract.py` | stark-copilot, -design-to-plan, -phase-execute | Imports `_emit` → call TS lib |
| `config/statusline-setup.py` | `install.sh` | Trivial |

No dedicated test files. Lowest-risk slices — same shape as the done
`github_app` / `preflight` ports. Recommended starting point.

## Phase 2 — The `automation/` package

| Files | Consumers |
|---|---|
| `scripts/automation/__init__.py`, `logs.py`, `schema.py` | ~7 skills (log/report writes): stark-release, stark-session, stark-review, stark-housekeeping, stark-design-to-plan, stark-phase-execute, stark-plan-to-tasks |
| `scripts/test_automation_logs.py`, `scripts/test_automation_schema.py` | port alongside |

Self-contained package — migrate as one unit.

## Phase 3 — Shared dispatch infra

The lib layer that exists **only** to serve the orchestrators. The Python cannot
be deleted while Python orchestrators import it — migrate together with Phase 4,
or run thin Python shims during the transition.

| File | Local imports | TS target |
|---|---|---|
| `scripts/_emit.py` | — | already `emit_queue_lib.ts` — delete Python once importers gone |
| `scripts/config_loader.py` | `_emit` | extend `stark_config_lib.ts` to a full port |
| `scripts/runtime_env.py` | `config_loader` | new |
| `scripts/codex_utils.py` | `config_loader` | new |
| `scripts/gemini_utils.py` | `config_loader` | new (`agent_gemini.ts` exists as partial) |
| `scripts/claude_utils.py` | `config_loader`, `runtime_env` | new (`agent_claude.ts` exists as partial) |
| `scripts/dispatcher_base.py` | the 3 `*_utils`, `config_loader` | new |

Tests: `test_agent_utils`, `test_dispatcher_base`, `test_runtime_env`, `test_red_team_config`.

## Phase 4 — The orchestrators

The heavy lift — CLAUDE.md's "4-5 week" warning lives here. Plan in writing
before starting; do not big-bang.

| File | Sub-slice order | Local imports |
|---|---|---|
| `scripts/multi_review.py` | 1st — drags in all infra | `_emit`, all 3 `*_utils`, `dispatcher_base`, `runtime_env` |
| `scripts/plan_review_dispatch.py` | 2nd — reuses the now-TS infra | same set |
| `scripts/plan_to_tasks_validate.py` | 3rd — lightest | `codex_utils`, `gemini_utils` only |

Tests: `test_multi_review`, `test_plan_review_dispatch`, `test_plan_to_tasks_validate`, `test_spec_extraction`.

## Phase 5 — Teardown

Once no Python remains:

- Delete `scripts/conftest.py` (pytest config).
- Delete `scripts/test_install_deps.py` — it tests `install.sh`'s Python-deps
  check, which becomes obsolete.
- Re-home or delete `scripts/test_register_triggers.py` — it tests
  `register_triggers.sh` (a shell script, not Python).
- Strip the `.venv` / pip-dependency machinery from `install.sh`.

## Sequencing

1. **Phase 1** — ship the 5 leaves one slice at a time. Independent, do now.
2. **Phase 2** — the `automation/` package as one slice.
3. **Phases 3 + 4** — one genuine project (the review-orchestrator core). Write a
   dedicated implementation plan first. Sub-slice within Phase 4 as listed.
4. **Phase 5** — teardown once Phase 4 lands.

After all phases: `scripts/` and `scripts/automation/` are empty of Python; the
repo is TS-only for tooling.
