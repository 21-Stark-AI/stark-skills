# AGENTS.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude and Codex are enabled by default; Gemini is disabled (opt-in via `models.gemini.enabled`). Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Language preference:** Go for backend, TypeScript for scripts. **Avoid Python at all costs** — do not introduce new Python; when touching existing Python (orchestrators under `scripts/`), prefer rewriting in TypeScript (`tools/`) over extending the Python.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Always update documentation.** Any change that affects behavior, structure, commands, env vars, or operations must update the relevant docs (this file and `CLAUDE.md` included) in the same change.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.Codex/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.Codex/code-review/scripts/`
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 30 skills), symlinked to Claude and copied to `~/.codex/skills/`
- `org/evinced/` — Evinced org config, installed to `~/Code/.code-review/`
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `automation/` — CCR automation fleet: 12 triggers, prompts, logs, cost tracking, reports
- `.github/workflows/` — GitHub Actions: project sync, gate checks, stale detection, heartbeat
- `docs/` — specs, plans, ADRs, retrospectives, generated skill docs
- `standards/` — org-wide doc templates and workflows, installed to `~/.Codex/code-review/standards/`
- `install.sh` — symlinks repo contents to Claude/config locations and copies Codex skills

## Key Files

### Dispatchers & orchestration
- `scripts/dispatcher_base.py` — shared base: config discovery, model resolution, domain/prompt resolution
- `scripts/multi_review.py` — PR review orchestrator (ThreadPoolExecutor, parallel sub-agents)
- `scripts/plan_review_dispatch.py` — plan/design review dispatch (N agents × M domains)
- `scripts/design_to_plan_dispatch.py` — generic generate-and-cross-review dispatch for enabled agents
- `scripts/autopilot_dispatch.py` — tournament-based autonomous implementation (agents compete in worktrees)
- `scripts/tournament.py` — reusable multi-LLM competition engine (semantic, visual, test evaluation)
- `scripts/domain_triage.py` — context-aware domain dispatch engine
- `scripts/triage_orchestrator.py` — triage orchestration with shadow validation support

### Agent utilities
- `scripts/claude_utils.py` — Codex CLI dispatch helpers (Vertex AI env, model pinning)
- `scripts/codex_utils.py` — Codex CLI dispatch helpers (JSONL parsing, reasoning config)
- `scripts/gemini_utils.py` — Gemini CLI dispatch helpers (session isolation, API key fallback)

### Infrastructure
- `scripts/config_loader.py` — central config with lru_cache, typed section accessors, deep merge
- `scripts/runtime_env.py` — isolated subprocess env builder (allowlist, token injection, temp dirs)
- `scripts/github_app.py` — multi-app GitHub auth (stark-Codex, stark-codex, stark-gemini)
- `scripts/github_projects.py` — GitHub Projects V2 GraphQL utility (13 public functions)
- `scripts/emit_queue.py` — SQLite-backed durable event queue with dead-letter
- `scripts/session_state.py` — persistent session state management

### TUI & session
- `scripts/tui_core.py` — shared TUI rendering primitives (box, table, progress)
- `scripts/triage_tui.py` — triage decision TUI renderer
- `scripts/session_tui.py` — session start/end renderer
- `scripts/session_tui_cli.py` — session TUI CLI entry point

### Red-team audit + emit-queue CLIs (Python shell-out seam; Phase 1a of the TS migration)
- `scripts/red_team_audit_cli.py` — canonical cross-language seam for the red-team audit SQLite. Subcommands: `resolve-db` (single source of truth for the DB path: `--db` > `STARK_RED_TEAM_DB` env > `red_team.audit.db_path` config > default `~/.claude/code-review/history/forged-review/forged_review_metrics.db`), `ensure-schema` (atomic temp-then-rename create / empty-DB recovery / pre-marker bootstrap / verify+refresh, all under a singleton `schema_meta` marker + `PRAGMA user_version`), `assert-schema-version` (writer gate), `migrate --stamp-current`, `preflight-credentials` (stark-claude/codex/gemini Keychain + installation-token mint smoke), `record-run` / `record-findings` / `update-run-status` / `read-run` / `get-findings`. Every body runs the canonical resolver → `ensure-schema` → `assert-schema-version` preflight before any read/write. Stdout discipline: exactly one JSON envelope per call; logs go to stderr. See `docs/specs/red-team-audit-schema-2026-05-16.md` and `docs/specs/red-team-cli-contract-2026-05-16.md`. Frozen schema version: 1.
- `scripts/red_team_emit_queue_cli.py` — canonical wrapper over `scripts/emit_queue.py` for the red-team subsystem. Subcommands: `enqueue --type T [--dedupe-key K]` (idempotent on `dedupe_key`), `peek [--source pending|dead-letter] [--limit N]`, `mark-done --event-id ID|--dedupe-key K` (idempotent), `dead-letter --event-id ID|--dedupe-key K [--reason R]` (idempotent). JSON in / JSON out, one envelope per call.
- `scripts/red_team_types.py` + `scripts/openai_responses.py` — small Python helpers extracted from the deleted `stark_red_team.py` (Phase 4). `red_team_types` carries the dataclasses + identity helpers still consumed by the Python read-side (`red_team_audit`, `red_team_insights`, `red_team_backfill`, `red_team_human_review`). `openai_responses` carries the Responses-API model allowlist + key resolver used by preflight.

### Red-team TS dispatchers
- `tools/red_team_lib.ts` — red-team dispatcher core. Persona/prompt resolution from `global/prompts/red-team/`, codex dispatch with sandbox (env scrubbing + isolated HOME), per-finding validation, sidecar markdown rendering, audit shell-out via `scripts/red_team_audit_cli.py`, pre-dispatch sensitive-data gate, redaction sanitizer (mirrors `emit_queue` + `red_team_audit_text` patterns), data-classification gate (YAML-frontmatter driven; see `docs/specs/red-team-classification-contract-2026-05-16.md`), `--replay-transcript` support. Fix-plan generation also lives here (`resolveFixPlan` + `runRedTeamFixPlan` + `renderFixPlanSection`); gated by `red_team.fix_plan.enabled` (default `false`) and the `STARK_RED_TEAM_FIX_PLAN_KILL` env var. Best-effort insights emission (`emitRun` / `emitFinding` / `emitFixPlan`) shells out to `scripts/red_team_emit_queue_cli.py` after the audit write — fail-open, suppressed by `--no-audit`. The former Python orchestrator (`stark_red_team.py` + `red_team_dispatch_common.py` + `red_team_state_machine.py` + `red_team_sandbox.py`) was deleted in Phase 4 of the 2026-05-16 migration.
- `tools/red_team_design.ts` — `/stark-red-team-design` TS dispatcher. Thin wrapper over `red_team_lib.ts`.
- `tools/red_team_plan.ts` — `/stark-red-team-plan` TS dispatcher. Same shape as design with `--plan` instead of `--design`.
- `tools/red_team_audit_text_lib.ts` — TS port of `scripts/red_team_audit_text.py` (Phase 5a). Owns the FU-rt6 retention policy: `policyFromConfig`, `applyToField` (excerpt vs full-text mode with secret + PII redaction), `hashText`. Used by `buildFindingPayload` (insights events) + `red_team_audit_lib.ts` (audit-row inserts). Byte-for-byte parity with the Python original (`red_team_audit_text_parity.test.ts`).
- `tools/red_team_audit_lib.ts` — TS port of `scripts/red_team_audit.py` (Phase 5a). SQLite schema + writes (`recordRedTeamRun`, `recordFindings`, `recordFixPlan`, `recordPersonaStats`, `pruneRedTeamMetrics`, `initRedTeamTables`, `sanitizeFixPlanJson`) via `node:sqlite` (built-in, no npm dep). Phase 5a scope: lives alongside the Python writer; Phase 5b will cut the dispatcher over. Parity: `red_team_audit_parity.test.ts`.

### Other
- `scripts/stark_persona.py` — session persona engine (weighted selection, combos, catchphrases)
- `scripts/generate_skill_docs.py` — multi-LLM documentation generator with viz competition
- `scripts/flow_extractor.py` — workflow extraction from SKILL.md files
- `scripts/flow_layout.py` — dagre layout runner for flow diagrams
- `scripts/flow_schema.py` — FlowDiagram Pydantic model
- `scripts/metrics.py` — review performance metrics collection
- `scripts/pr_status.py` — PR analytics dashboard data
- `scripts/plan_to_tasks_validate.py` — plan decomposition validation (3 LLM passes)

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{Codex,codex,gemini}/` — per-agent × per-domain PR review prompts (9 domains each)
- `global/prompts/{design-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/{design-to-plan,prompt-to-design}/` — per-agent generate + cross-review prompts
- `global/prompts/autopilot/` — per-agent autopilot implementation prompts
- `global/prompts/triage/` — domain triage prompts and manifest
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Commands

```bash
./install.sh              # install symlinks/copies
./install.sh --status     # check installation
./install.sh --uninstall  # remove installed symlinks/copies
```

## Skills

All skills live in `skill/stark-*/SKILL.md`; `install.sh` symlinks them for Claude and copies full skill directories to `~/.codex/skills/` for Codex.

### Pipeline (end-to-end, in order)

- `/stark-review-design <path>` — multi-agent design/spec review (N agents × 12 domains, default N=2)
- `/stark-design-to-plan <path>` — generate implementation plan from design doc (enabled agents generate, then cross-review before synthesis)
- `/stark-review-plan <path>` — multi-agent execution plan review (N agents × 10 adversarial domains, default N=2)
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-autopilot <plan-or-prompt> [--plan-slug SLUG]` — autonomous implementation with tournament at every step (all enabled agents compete in worktrees); issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × triage-selected domains, fast/cheap)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback

### Project Setup & Docs

- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs

## Conventions

- Prompts are per-agent: each LLM gets its own version of each domain
- Domain IDs are slugs derived from filenames: `01-architecture.md` → `architecture`
- Config uses JSON, prompts use markdown
- Agent preambles in `agent.md`, domain prompts in `NN-domain.md`

## GitHub Apps

| App | App ID | Installation ID | Keychain |
|-----|--------|----------------|----------|
| stark-Codex | 3066738 | 115648521 | STARK_CLAUDE_PRIVATE_KEY |
| stark-codex | 3066834 | 115648800 | STARK_CODEX_PRIVATE_KEY |
| stark-gemini | 3066689 | 115648971 | STARK_GEMINI_PRIVATE_KEY |
