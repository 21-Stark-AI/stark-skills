# Red-Team TS Migration — Master Plan

**Date:** 2026-05-16
**Status:** Draft
**Scope:** Port the red-team subsystem (~7.2k LoC, 14 Python files) to TypeScript using the same lead/wing pattern as `tools/stark_review_doc.ts`.

## Approach

**Dispatcher-first, SQLite as the contract.** Port the user-facing dispatchers in TS while the audit / read-side modules keep reading the same SQLite schema in Python. Migrate the read-side tail later as a single batch.

This mirrors the successful `plan_review_dispatch.py → tools/stark_review_doc.ts` port: skills swap their entry point, prompts and schema stay put, no big-bang.

## Inventory & sequencing

### Write-side (port to TS first)
| File | LoC | Role |
|---|---|---|
| `red_team_design_dispatch.py` | 261 | `/stark-red-team-design` entry point |
| `red_team_plan_dispatch.py` | 260 | `/stark-red-team-plan` entry point |
| `red_team_dispatch_common.py` | 1,512 | shared persona iteration, prompt resolution, Codex dispatch, finding aggregation |
| `stark_red_team.py` | 1,893 | core orchestrator (committee runs, fix loop, sidecar emission, PR posting) |
| `red_team_state_machine.py` | 234 | run-state transitions |
| `red_team_sandbox.py` | 238 | persona sandbox execution |

### Read-side (keep in Python through Phase 1–4; port last)
| File | LoC | Role |
|---|---|---|
| `red_team_audit.py` | 500 | SQLite schema owner — **stays authoritative throughout** |
| `red_team_audit_text.py` | 150 | text rendering |
| `red_team_status.py` | 89 | CLI status |
| `red_team_accept.py` | 166 | accept-key resolution |
| `red_team_backfill.py` | 399 | historical backfill |
| `red_team_insights.py` | 668 | aggregated reporting |
| `red_team_human_review.py` | 403 | manual triage workflow |
| `calibrate_red_team.py` | 390 | persona calibration |

### Shared infra TS gets to depend on
Already-available TS helpers in `tools/` (from prior ports):
- `tools/stark_review_doc_lib.ts` — Codex per-domain dispatch, prompt resolution
- `tools/copilot_dispatch.ts` — preflight, GH App auth, runtime env
- existing `tools/skill_lib.ts` patterns

Python infra TS will need bindings to (or thin re-implementations of): `config_loader`, `codex_utils`, `emit_queue`, `audit_base`. Where TS equivalents already exist (Codex dispatch in `stark_review_doc_lib.ts`), reuse them; for `emit_queue` and `audit_base`, shell out to a small Python CLI wrapper rather than re-port the SQLite logic in this milestone.

## Phases

### Phase 0 — Freeze the SQLite contract (1 PR)
- Snapshot current schema in `docs/specs/red-team-audit-schema-2026-05-16.md` (DDL + version notes).
- Add a durable schema-version marker inside SQLite (use `PRAGMA user_version` plus a `schema_meta(version INTEGER, applied_at TEXT)` row) — not just a constant in code.
- Backfill existing audit databases in the same PR: `red_team_audit.py migrate --stamp-current` walks every known DB path, verifies the live DDL matches the snapshot, and stamps the version. Refuses to stamp if DDL drifts.
- Add a standalone `red_team_audit.py assert-schema-version --expected N --db PATH` subcommand that reads the durable marker and exits non-zero on mismatch. This is the gate TS uses before any write; the table-init `--schema-version` flag only asserts at create time.
- Snapshot the current dispatcher CLI surface (Python `--help`, accepted flags, stdout JSON receipt examples, exit-code matrix) into `docs/specs/red-team-cli-contract-2026-05-16.md`. Phases 2/3 golden-test against this contract.
- **Exit criteria:** schema + CLI contract docs committed; durable marker present and stamped in all known DBs; `assert-schema-version` ships and is wired into existing Python entry points as a smoke test; existing red-team runs unchanged.

### Phase 1 — `tools/red_team_lib.ts` (1 PR)
Extract the shared dispatcher core into a lib (mirror of `stark_review_doc_lib.ts`):
- persona + domain resolution from `global/prompts/red-team-*/`
- per-persona Codex dispatch with concurrency cap
- finding aggregation + sidecar (`<doc>.red-team.md`) rendering
- **Parity checklist** for every externally visible behavior currently owned by `stark_red_team.py`, `red_team_state_machine.py`, and `red_team_sandbox.py`: committee orchestration, fix-loop (multi-round) vs. challenge-only mode, sidecar emission, PR posting (detect + comment), run-state transitions, failure-state handling, sandbox flags (read-only FS, approval mode, network policy, temp home, env allowlist). Each item is tagged **port-to-TS**, **kept-in-Python wrapper**, or **explicit non-goal** with rationale. Items tagged port-to-TS land in this PR.
- **Sandbox contract:** the TS dispatch wraps Codex in an equivalent of `red_team_sandbox.py` — read-only filesystem, network policy, `runtime_env`-style env allowlist, isolated `HOME`, no inherited GH/Vertex tokens unless explicitly required. Asserted by unit tests that attempt write / network / env-leak and expect failure.
- **Redaction sanitizer** runs before every output sink (SQLite via the audit CLI, sidecar markdown, stdout JSON, logs, PR comments). Fixture tests with representative fake tokens (GitHub PAT, GCP key, AWS key, JWT) + PII patterns must fail the run on unredacted matches.
- `recordRun()` / `recordFindings()` shell out to a new `scripts/red_team_audit_cli.py`. The audit CLI contract is **explicit**:
  - subcommands: `ensure-schema --expected-version N --db PATH`, `assert-schema-version`, `record-run`, `record-findings`.
  - DB path resolution: single canonical resolver shared with Python; CLI accepts `--db` for override.
  - Invocation boundary: TS calls via `spawn`/`execFile` with `shell: false`, fixed interpreter + script path, canonicalized doc paths, JSON payloads piped over stdin (or a `0600` temp file for large payloads). Tests cover quotes, newlines, shell metacharacters, and oversized findings.
  - Idempotency: every run carries a stable run key (hash of doc path + commit SHA + persona set + prompt-dir version). Inserts use upsert / `INSERT OR IGNORE` so a rerun after partial failure does not duplicate run or finding rows. A retry test interrupts between `recordRun()` and `recordFindings()` and reruns successfully.
  - Transaction boundaries: `record-findings` runs inside a single transaction; partial failures roll back.
  - Exit codes: 0 ok, non-zero with a JSON error envelope on schema mismatch / DB missing / transaction failure. TS surfaces these as fatal.
  - **Preflight:** TS dispatcher MUST call `assert-schema-version` before any write; on mismatch, fail closed before model dispatch.
- Vitest coverage for prompt resolution, sidecar rendering, persona iteration, redaction sanitizer, sandbox assertions, audit CLI shell boundary, schema-version preflight, and idempotent rerun.

**Exit criteria:** lib + tests green; parity checklist filed and reviewed; sandbox + redaction + preflight + idempotency tests in CI; no skill wired to it yet.

### Phase 2 — Port `/stark-red-team-design` (1 PR)
- **Prerequisite checklist** (gate before the skill is rewired): Phase 1 parity checklist is filed; baseline Python behavior captured as golden CLI tests (stdout JSON receipt, exit-code matrix, sidecar bytes for a fixture doc); TS implements every preserved behavior listed as port-to-TS — fix-loop / no-fix-loop modes, PR posting, failure states, sandbox semantics.
- New entry: `tools/red_team_design.ts` consuming `red_team_lib.ts`.
- Update `skill/stark-red-team-design/SKILL.md` to invoke the TS entry.
- Keep `scripts/red_team_design_dispatch.py` in tree but stop wiring it; mark deprecated in a header comment.
- **Live parity test (isolated):** run TS against a real design doc with `--db` pointing at a temp SQLite path seeded from the snapshot DDL, PR posting disabled by default. Diff sidecar + audit row against a Python baseline run executed against a *separate* temp DB seeded from the same DDL; normalize run-specific fields (timestamps, generated IDs) before comparing. Pin baseline-vs-TS order in the test harness so neither run reads state written by the other.
- **Live PR-posting smoke:** one controlled run against a throwaway PR comment with cleanup, gated behind an explicit flag, exercising the detect-and-post path end to end.
- **Golden CLI tests:** stdout JSON receipt shape, exit codes (success, schema mismatch, dispatch failure, fix-loop max-rounds), `--help` flag inventory all match the Phase 0 CLI contract snapshot.
- **Exit criteria:** skill works end-to-end; audit row written via the audit CLI; sandbox + redaction + idempotency tests still green; every parity checklist item for the design path is verified by a golden test; Python dispatcher untouched but unused.

### Phase 3 — Port `/stark-red-team-plan` (1 PR)
Same as Phase 2 for the plan variant. Reuse the lib; only the prompt directory and sidecar naming differ.

### Phase 4 — Delete Python dispatchers (1 PR)
- **Pre-deletion dependency audit:** run repo-wide `rg` for every deleted module name (`stark_red_team`, `red_team_design_dispatch`, `red_team_plan_dispatch`, `red_team_dispatch_common`, `red_team_state_machine`, `red_team_sandbox`) across **all** paths — skills, docs, tests, workflows, package metadata, shell snippets, dynamic imports, subprocess invocations. Resolve every hit before deletion.
- **Pre-deletion smoke run:** execute `--help` / `status` / one representative command for every retained read-side CLI (`red_team_audit`, `red_team_audit_text`, `red_team_status`, `red_team_accept`, `red_team_backfill`, `red_team_insights`, `red_team_human_review`, `calibrate_red_team`) to prove imports still resolve.
- Remove `red_team_design_dispatch.py`, `red_team_plan_dispatch.py`, `red_team_dispatch_common.py`, `red_team_state_machine.py`, `red_team_sandbox.py`, and the bulk of `stark_red_team.py` (anything no Python module still imports).
- Keep what `red_team_audit.py` / `red_team_insights.py` / `red_team_human_review.py` / `red_team_backfill.py` still need.
- Update `CLAUDE.md` and `AGENTS.md` to reflect the new entry points.
- **Exit criteria:** repo-wide `rg` for every deleted module name returns zero hits outside the deletion diff itself; the read-side smoke run passes after deletion; `/stark-red-team-design` and `/stark-red-team-plan` plus every retained read-side CLI run successfully end-to-end.

### Phase 5 — Read-side port (deferred, split into two PRs when convenient)
- **5a — Parity:** port `red_team_audit*`, `red_team_status`, `red_team_accept`, `red_team_backfill`, `red_team_insights`, `red_team_human_review`, `calibrate_red_team` to TS alongside the Python originals. Seed a fixture SQLite database, run every Python and TS read-side command against it, and diff outputs (status, insights, accept-key resolution, backfill, human-review listings, calibration). Block on byte-level or normalized parity for each flow.
- **5b — Cutover:** move SQLite schema ownership to TS, delete `scripts/red_team_audit_cli.py` and the Python read-side modules, update docs. Only after 5a parity is signed off.

## Sequencing rationale

- Phases 1–3 deliver the user-facing win (skills run in TS) in three small PRs.
- SQLite as contract means Phase 4 deletes are pure cleanup, not coordinated cutovers.
- Phase 5 is genuinely optional — the read-side is invoked manually, low blast radius, and porting it is busywork rather than user-facing value. Defer until something else forces the touch.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| SQLite schema drift between TS writes and Python reads | Phase 0 schema freeze + `--schema-version` assertion; bumping the version requires both sides updated in the same PR |
| `stark_red_team.py` is 1.9k LoC of orchestrator state — under-scoped port | Treat Phase 2 as the discovery PR; if it exceeds ~600 lines of TS, split `red_team_lib.ts` further before Phase 3 |
| Codex dispatch behavior diverges from `stark_review_doc_lib.ts` (different reasoning effort, different result shape) | Extract a `codex_dispatch_lib.ts` if Phase 1 reveals real divergence; otherwise reuse as-is |
| PR-posting behavior regression (red-team posts sidecars to PRs when detected) | Live test in Phase 2 against a real PR worktree, not just local fixtures |

## Non-goals

- No prompt changes — same `global/prompts/red-team-*/` files, same personas.
- No UX changes — sidecar filenames, exit codes, stdout JSON receipt all preserved.
- No new features — straight port. Improvements happen after.
- Not porting `red_team_audit.py` until Phase 5; the SQLite schema stays Python-owned through the user-facing migration.

## First PR

Phase 0: schema snapshot + `--schema-version` flag. Small, isolated, unblocks everything downstream.
