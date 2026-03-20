# stark-plan-to-tasks Skill Design

## Overview

Skill that takes a spec/design document (typically produced by the brainstorming skill), decomposes it into phased GitHub issues, extracts knowledge into project documentation, and deletes the plan. The plan is a transient artifact — its value gets distributed: actionable work goes to GitHub issues, domain knowledge goes to project docs.

## Inputs

One positional argument: `<path-to-spec>` (e.g., `docs/superpowers/specs/2026-03-18-widget-system-design.md`).

Optional flags:
- `--dry-run` — run all three passes, preview issue payloads to terminal, but do NOT create issues or modify any files. Outputs a summary table and writes the full preview to `/tmp/stark-plan-to-tasks-preview-{plan-slug}.md`.
- `--cleanup <plan-slug>` — find all issues with `plan:{slug}` label, list them, and offer to close them with a "Cleaned up by stark-plan-to-tasks" comment. For recovering from bad runs.

The spec must be self-contained. This skill does not supplement weak plans — it validates and rejects them.

## Core Principle: Quality Chain

The plan is the source of truth. If the decomposition struggles, the plan is weak. If the implementing agent needs context beyond the issue, the issue is weak. If the issue is weak, the decomposition failed. If the decomposition failed, the plan was insufficient. Quality flows downstream: plan → decomposition → issues → implementation → review.

## Three LLM Passes

| Pass | Purpose | Input | Output | Agent |
|------|---------|-------|--------|-------|
| 1. Quality Gate | Flag gaps, ambiguities, contradictions, missing details | Raw plan | Gap report → user fixes plan | Primary (Claude) |
| 2. Decomposition | Break plan into phases → tasks with self-contained issues | Validated plan | Structured breakdown (JSON on disk) | Primary (Claude) |
| 3. Validation | Verify nothing lost, every issue is self-contained, dependencies correct | Breakdown + plan | Approved breakdown or flagged issues | Separate agent(s) — configurable |

**Why Pass 3 uses a different agent:** The same LLM reviewing its own decomposition shares the same blind spots that created it. Pass 3 dispatches to a different model (Codex, Gemini, or both) with a clean context — just the plan and the decomposition JSON, no carry-over from Passes 1-2.

**Configuration** (in `config.json` under `plan_to_tasks`):
```json
{
  "plan_to_tasks": {
    "validation_agents": ["codex"]
  }
}
```

Accepts `["codex"]`, `["gemini"]`, or `["codex", "gemini"]` for multi-vote validation. Default: `["codex"]`. Config follows the standard hierarchy (global → org → repo); repo overrides global.

**Pass 3 dispatch mechanism:**

The validation agent receives a single JSON envelope via stdin containing both the plan and the decomposition:

```json
{
  "schema_version": 1,
  "plan_markdown": "# Widget System Design\n...",
  "breakdown": { "schema_version": 1, "phases": [...] },
  "plan_hash": "sha256:abc123..."
}
```

The prompt (validation checklist) is passed as the instruction. Output is structured JSON (see validation output schema below).

CLI invocation per agent (same patterns as `plan_review_dispatch.py`):

```bash
# Codex — prompt via stdin, envelope as part of prompt
cat validation_envelope.json | codex exec -c 'model_reasoning_effort="high"' --ephemeral --json --full-auto -

# Gemini — prompt as -p flag, envelope via stdin
gemini -p '<validation-prompt>' -o json --approval-mode plan < validation_envelope.json
```

**Output normalization:** Each agent wraps output differently. Codex returns JSONL events (extract `agent_message` content). Gemini returns `{"response": "..."}` envelope (unwrap). After extraction, validate against the validation output schema. On malformed output, retry once with a stronger prompt; if still malformed, treat as validation failure.

Agent availability is checked in Step 1 (not just auth — verify the CLI binary exists). If a configured validation agent is not installed, fail early with a clear message naming the missing agent, before any LLM work.

If multiple validation agents are configured and they disagree, issues flagged by any agent are treated as findings (union, not intersection).

## Execution Sequence

Steps are numbered sequentially. Steps 2-4 correspond to the three LLM passes. Terminology: "Step" = execution sequence, "Pass" = LLM invocation, "Phase" = decomposition output grouping only.

### Step 1: Setup

- Read the plan file. Fail if it doesn't exist, is empty, or doesn't have a `.md` extension.
- **Target repo detection:** Check plan frontmatter for `repo: org/name` field. If absent, scan plan body for `org/repo` patterns (e.g., `GetEvinced/widget-system`). If no match, fall back to `git remote -v` (prefer `origin`, warn if multiple remotes point to different orgs). If all fail, ask the user. **Verify the detected repo matches the current git checkout** — if mismatch, warn and ask confirmation before proceeding.
- Verify `gh` CLI is installed: `which gh`. Fail early if missing.
- Verify GitHub App auth: `$PYTHON $SCRIPTS/github_app.py --app stark-claude token`. Fail early if auth is broken.
- **Repo access probe:** Verify `stark-claude` has issue/label write access on the target repo: `GH_TOKEN=... gh api /repos/{org}/{repo} --jq .permissions.push`. Fail early if access denied.
- Verify validation agent CLIs are installed: check that each agent in `validation_agents` config (default: `["codex"]`) is available in PATH. Fail early if missing.
- **Re-run detection:** Query for existing issues with `plan:{plan-slug}` label on the target repo. If found, list them and ask: skip (abort), update (re-patch existing issues), or create fresh (proceed normally). Do not proceed silently.
- Read target project's `docs/` tree structure (for knowledge routing in Step 6).
- Read target project's existing GitHub labels (for label creation in Step 5).

### Step 2: Plan Quality Gate (LLM Pass 1)

The LLM evaluates the plan against a robustness checklist. This is not a generic review — it specifically checks whether the plan has enough detail for an agent to decompose it into self-contained tasks.

**Checklist:**

- **Completeness** — every component/feature mentioned has an implementation approach, not just a name.
- **File paths** — concrete files/modules referenced, not vague "the backend" or "the API layer."
- **Decisions are made** — no "we could do X or Y" left unresolved; every fork has a chosen path.
- **Dependencies are explicit** — what depends on what, what must exist before something else can be built.
- **Boundaries are clear** — where one unit of work ends and another begins is unambiguous.
- **Acceptance criteria exist** — for each feature/component, what "done" looks like.
- **Edge cases and error handling** — not deferred, addressed in the plan.
- **Security/performance constraints** — if relevant, stated explicitly.

**Actions:**

- **Flags** gaps and presents them to the user as a structured report. Does NOT auto-fix.
- Trivial clarifications (e.g., missing acceptance criteria that are obvious from the description) may be suggested inline, but the user approves all changes.
- The user edits their plan based on the gap report. The skill re-reads from disk and re-validates after edits. Max 3 validation cycles; if gaps remain after 3 rounds, bail out with a summary of remaining issues.
- Only proceeds to Pass 2 when the plan passes the checklist with no open gaps.

**Why flag, not fix:** The LLM will confidently infer implementation details that contradict the architect's intent (e.g., picking PostgreSQL when Redis was intended). Giving it unsupervised edit access to the plan undermines the quality chain. The plan is the architect's document — the skill validates it, the architect fixes it.

**Scope:**

- Does NOT challenge architectural decisions — those were validated during brainstorming.
- Does NOT add scope — only identifies gaps in what's already described.
- Does NOT infer or add implementation details — that's the architect's job.

### Step 3: Decomposition (LLM Pass 2)

Takes the hardened plan and produces a structured breakdown.

**Phase identification:**

The LLM reads the plan and identifies natural phases — groups of work that share a logical boundary (e.g., "data model + storage layer," "API endpoints," "UI components"). Phases are ordered by dependency.

Each phase gets:
- A stable `phase_id` (e.g., `phase-1-data-model`) — used for dependency references and issue matching
- A name and one-line description
- Why it's a phase (what boundary defines it)
- Which phases it depends on (by `phase_id`)

**Task identification within each phase:**

Each task is a single unit of work an agent can pick up and execute independently. The LLM produces a structured object per task:

| Field | Purpose | Consumer |
|-------|---------|----------|
| `task_id` | Stable identifier (e.g., `task-1-1-user-entity`) — for dependency refs and issue matching | Internal |
| Title | Clear, imperative, scoped | Everyone |
| What | Deliverable description | Implementation agent |
| Why | Context from the plan (plan gets deleted — this must stand alone) | Implementation + review agent |
| Where | Specific files/modules to create or modify | Implementation agent |
| How | Implementation approach, key decisions already made (≤ 500 words) | Implementation agent |
| Acceptance criteria | Testable conditions for "done" (≤ 5 items) | Review agent |
| Dependencies | Which other tasks must complete first (by `task_id`) | Implementation agent |
| Review hints | Edge cases, security concerns, architectural constraints to verify (≤ 5 bullet points) | Review agent |

**Metrics per task (estimated by the LLM):**

| Metric | Values | Label format | Purpose |
|--------|--------|--------------|---------|
| Story points | 1, 2, 3, 5, 8, 13 (Fibonacci) | `sp:N` | Effort estimation; retrospective accuracy analysis |
| Risk | low, med, high | `risk:low`, `risk:med`, `risk:high` | Correlate risk rating vs. actual outcome |
| Confidence | low, med, high | `confidence:low`, `confidence:med`, `confidence:high` | LLM's self-assessed confidence that the task is fully specified |

**Sizing guardrails:**

Concrete heuristics the LLM can evaluate: max 5 acceptance criteria per task, max 4 files in the `where` field, max 500 words for `how`. If a task exceeds these, split it. If a task has only 1 acceptance criterion and touches 1 file, consider merging with a related task. Each task should be roughly one focused PR. Recommend max 6-8 phases and max 8-10 tasks per phase; if decomposition exceeds these, surface it as a signal that the plan should be split.

**Output schema:**

```json
{
  "schema_version": 1,
  "plan_hash": "sha256:abc123...",
  "phases": [
    {
      "phase_id": "phase-1-data-model",
      "name": "Data Model & Storage",
      "description": "Define entities, relationships, and persistence layer",
      "depends_on": [],
      "tasks": [
        {
          "task_id": "task-1-1-user-entity",
          "title": "Implement User entity with validation",
          "what": "Create User model with email, role, and tenant fields...",
          "why": "The system requires multi-tenant user management...",
          "where": ["src/models/user.py", "src/db/migrations/001_users.sql"],
          "how": "Use SQLAlchemy declarative base with...",
          "acceptance_criteria": [
            "User model passes all field validations",
            "Migration creates users table with correct indexes"
          ],
          "dependencies": [],
          "review_hints": [
            "Verify email uniqueness is enforced at DB level, not just app level",
            "Check that tenant_id is non-nullable"
          ],
          "story_points": 3,
          "risk": "low",
          "confidence": "high"
        }
      ]
    }
  ]
}
```

**Schema validation:** After the LLM generates the JSON, validate it strictly: all required fields present, `phase_id` and `task_id` are unique, dependencies reference existing IDs, no circular dependencies. On validation failure, retry once with the error message appended to the prompt. If still invalid, halt.

**Plan hash:** Compute SHA-256 of the plan content after Step 2 approval. Store in the breakdown JSON. Used by Step 4 to verify the plan hasn't changed between passes.

Output written to a temp file using `mktemp`: `TMPFILE=$(mktemp /tmp/stark-plan-to-tasks-XXXXXX.json) && chmod 600 "$TMPFILE"`. This reduces context window pressure for Pass 3. The temp file is cleaned up after Step 7 (Summary) completes successfully.

**Large plan handling:** Pass 2 always identifies all phases first (names, descriptions, dependencies), then generates tasks one phase at a time. This keeps each generation call focused and prevents quality degradation on later tasks. The phase list is generated in a single call; task generation is one call per phase.

### Step 4: Validation (LLM Pass 3 — separate agent)

The validation pass receives both the plan and the structured breakdown via the JSON envelope. Its job is adversarial — it tries to break the decomposition.

**Plan integrity check:** Before dispatching, verify the plan file's current SHA-256 matches `plan_hash` in the breakdown. If the plan was modified after Step 2 (e.g., user made edits between passes), warn and re-run Step 3.

**Checks:**

- **Coverage** — every requirement in the plan maps to at least one task. Nothing fell through the cracks.
- **Self-containment** — the issue must contain enough context about the plan's design decisions and intent that the implementing agent does not need to read other issues or the original plan. Codebase access is assumed.
- **Dependency correctness** — are the `task_id` dependency links accurate? Any circular dependencies? Could a task actually start before its declared dependencies complete?
- **No orphan knowledge** — is there information in the plan that didn't land in any task issue? (Note: the validator cannot check doc enrichment targets — this check covers task coverage only.)
- **Overlap** — do two tasks describe the same work? Would two agents step on the same files?
- **Sizing** — any task exceeding the guardrails (>5 acceptance criteria, >4 files, >500 words in how)?
- **Review sufficiency** — do the review hints tell a reviewer what to look for, or are they generic ("check for edge cases")?
- **Metric sanity** — are story points consistent across similar-complexity tasks? Does risk rating align with what's described?

**Validation output schema:**

```json
{
  "schema_version": 1,
  "approved": false,
  "issues": [
    {
      "phase_id": "phase-1-data-model",
      "task_id": "task-1-1-user-entity",
      "field": "acceptance_criteria",
      "problem": "No criteria for email validation format",
      "suggestion": "Add: 'Email field rejects invalid formats (RFC 5322)'"
    }
  ]
}
```

Fields: `phase_id` (string, required), `task_id` (string, required — use `"_phase_level"` for phase-level issues), `field` (enum: one of the task schema keys or `"_general"`), `problem` (string, required), `suggestion` (string, optional).

**Resolution:**

The validation agent flags issues — the primary Claude session fixes them. This is different from Pass 1 (where the user fixes the plan) because the decomposition is derived output, not the architect's source document. The primary session can safely adjust task fields (fill in a missing acceptance criterion, fix a dependency link) because the plan — the source of truth — is unchanged.

- Fixable issues (missing context, incomplete acceptance criteria, wrong dependency) → primary session fixes them in the structured breakdown, then re-dispatches to validation agent.
- Structural issues (missed feature, phases in wrong order) → loops back to Pass 2 for that section.
- Max 2 fix iterations (one full cycle = dispatch all validators → collect union of findings → fix → re-dispatch). If it can't converge, halt and surface remaining issues to the user. Do NOT proceed to issue creation with a known-incomplete breakdown — that violates the quality chain.

**If `--dry-run`:** After validation completes, write the full issue preview to `/tmp/stark-plan-to-tasks-preview-{plan-slug}.md` and print a summary table to terminal. Stop here — do not proceed to Step 5.

### Step 5: GitHub Issue Creation

**Token refresh:** Each `gh` command block should inline the token: `GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)"` to always get a fresh value.

**Issue body limits:** GitHub imposes a 65,536 character limit on issue bodies. Section caps are enforced during decomposition (Step 3): `How` ≤ 500 words, `Review Hints` ≤ 5 bullet points, `Acceptance Criteria` ≤ 5 items. If the total body still exceeds the limit after applying caps, truncate with a note: "Full detail available in the decomposition output." Do NOT reference Step 6 docs — they don't exist yet at this point.

**Shell injection prevention:** Never interpolate LLM-generated content directly into shell commands. Use `gh api` with `--field` for titles and bodies, or write content to temp files and use `--body-file`. Use single-quoted heredoc delimiters (`'STARK_EOF'`) to prevent shell expansion.

```bash
# Safe issue creation via gh api
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api /repos/{org}/{repo}/issues \
  --method POST \
  --field title="$TITLE" \
  --field body="$(cat $BODY_FILE)" \
  --field labels='["sp:5","risk:med","confidence:high","stark-plan-to-tasks","plan:2026-03-18-widget-system"]'
```

**Plan slug derivation:** Take the plan filename without extension, strip known suffixes (`-design`, `-spec`, `-plan`). E.g., `2026-03-18-widget-system-design.md` → `2026-03-18-widget-system`. If the resulting slug exceeds 50 characters (GitHub label length limit), truncate with a hash suffix.

**Label setup:**

Auto-create missing labels on the target repo:
- `sp:1`, `sp:2`, `sp:3`, `sp:5`, `sp:8`, `sp:13` (blue shades, graduated)
- `risk:low`, `risk:med`, `risk:high` (green, yellow, red)
- `confidence:low`, `confidence:med`, `confidence:high` (gray shades)
- `stark-plan-to-tasks` (metadata label — marks all issues created by this skill)
- `plan:{plan-slug}` — derived from plan filename, enables cleanup and traceability per decomposition run

**Phase tracking issues:**

One issue per phase. Contains:
- Phase name and description
- Dependencies on other phases
- Checklist of task issues (populated after task issues are created): `- [ ] #42 — Implement user model`

**Task issues:**

One issue per task. Contains:

```markdown
## What
{deliverable description}

## Why
{context from the plan — must stand alone}

## Where
{specific files/modules to create or modify}

## How
{implementation approach, key decisions}

## Acceptance Criteria
{testable conditions}

## Dependencies
{links to blocking issues — placeholder until patch pass}

## Review Hints
{what the reviewer should verify}

---
_Generated by `stark-plan-to-tasks` · Task ID: {task_id} · Phase: {phase-name} · Tracking: #{phase-issue-number}_
```

Labels: `sp:N`, `risk:level`, `confidence:level`, `stark-plan-to-tasks`, `plan:{plan-slug}`.

**Creation order (4 passes):**

1. Create all phase tracking issues first (to get issue numbers).
2. Create all task issues in dependency order within each phase (use placeholder text `[pending]` for Dependencies section). Record the mapping: `task_id → issue_number`.
3. **Patch pass — task cross-references:** Update every task issue's Dependencies section with actual `#NNN` links using the `task_id → issue_number` mapping.
4. Update phase tracking issues with task issue checklist links.

**Run manifest:** After each successful issue creation, append `{task_id, issue_number, phase_id}` to the temp decomposition file's `_manifest` key. This enables safe resume on partial failure — on re-run, cross-reference the manifest with existing issues to skip already-created ones.

### Step 6: Knowledge Extraction & Doc Enrichment

After issues are created, the plan still holds knowledge that doesn't belong in any single task. This knowledge must survive the plan's deletion.

**This step is an LLM call.** The LLM receives the plan content and the list of target doc files (from the detection step). It outputs the content to write or append to each file. Conflicts with existing content: always append as a new section, never replace or merge into existing sections.

**What gets extracted:**

- Architectural decisions (why the system is shaped this way)
- Data models / schemas (entity definitions, relationships)
- Integration points (how components communicate, API contracts)
- Constraints (performance budgets, security requirements, compliance)
- Glossary / domain terms (terminology defined in the plan)

**Routing logic:**

The skill scans the target project's `docs/` tree and matches knowledge to existing directories by convention. Detection is structural (directory names), not content-based — no semantic matching.

| Knowledge type | Detection | Fallback (if no match found) |
|----------------|-----------|------------------------------|
| Architectural decisions | Look for `docs/adr/`, `docs/decisions/`, `docs/architecture/decisions/` | Create `docs/adr/NNN-{title}.md` (NNN = next sequential number found in dir) |
| Data models / schemas | Look for `docs/models/`, `docs/data/` | Create `docs/data-model.md` |
| Integration / API contracts | Look for `docs/api/`, `docs/architecture/` | Create `docs/api.md` |
| Constraints | Look for `docs/security.md`, `docs/performance.md` by filename | Create `docs/constraints.md` |
| Glossary terms | Look for `docs/glossary.md`, `docs/GLOSSARY.md` (case-insensitive) | Create `docs/glossary.md` |

**Decision record:**

After knowledge extraction, the plan is compressed into a lightweight decision record appended to `docs/decisions.md` (created if missing with `# Decisions` as the title). One file, append-only — keeps decisions findable without file proliferation.

```markdown
## 2026-03-18 — Widget System

- **Date:** 2026-03-18
- **Status:** Decomposed → issues created
- **Tracking:** #41 (Phase 1: Data Model), #42 (Phase 2: API), #43 (Phase 3: UI)
- **Story Points:** 47 total (12 tasks across 3 phases)
- **Summary:** Multi-tenant widget rendering system with plugin architecture.
  Chose event-driven communication over direct coupling. PostgreSQL for
  persistence, Redis for widget state cache.
- **Knowledge extracted to:** `docs/adr/009-widget-architecture.md`, `docs/api/widgets.md`
```

**Dirty working tree check:** Before modifying any files, check for uncommitted changes in the target doc files and the plan file. If dirty, warn and ask the user to commit or stash first. Do not mix unrelated changes into the enrichment commit.

**After enrichment:**

- Delete the plan file.
- Single commit covering doc enrichment, decision record, and plan deletion. Add specific files by name — never `git add -A`.
- Commit message references tracking issues: `docs: extract knowledge from plan, create tasks (#41, #42, #43)`
- The commit is local-only. The skill does not push or create a PR — that's the user's decision.

### Step 7: Summary

Print to terminal:
- Number of phases created
- Total issues created
- Total story points across all issues
- Risk distribution (e.g., 3 low, 5 med, 1 high)
- Confidence distribution
- Links to each phase tracking issue

Clean up temp files (decomposition JSON, any preview files).

## Feedback Loop: Issue Quality Signal (Future Work)

The labels enable retrospective analysis but the closed-loop feedback mechanism is not part of v1.

**What the labels enable:**
- `plan:{slug}` — group all issues from a single decomposition for bulk analysis
- `confidence:level` — correlate predicted vs. actual specification quality
- `sp:N` — compare estimated vs. actual effort after implementation

**What's NOT implemented yet:**
- No mechanism to automatically detect when an implementing agent needed extra context. That requires instrumentation in the implementing agent, which is out of scope.
- No skill to run the retrospective analysis. The query `gh issue list --label "stark-plan-to-tasks" --label "confidence:high"` finds the issues, but evaluating them is manual.
- When a retrospective mechanism exists, it should feed back into improving the quality gate (Pass 1) and decomposition (Pass 2) prompts, following the same pattern as `stark-review-improvement`.

## SKILL.md Frontmatter

```yaml
---
name: stark-plan-to-tasks
description: >
  Decompose a spec/design document into phased GitHub issues with
  story points, risk, and confidence labels. Extracts domain knowledge
  to project docs and deletes the plan. Use when the user says
  "plan to tasks", "decompose plan", "break down this plan",
  "create issues from spec", "create tasks from plan",
  or invokes /stark-plan-to-tasks.
argument-hint: "<path-to-spec> [--dry-run] [--cleanup <slug>]"
---
```

## Constants

```
SCRIPTS=~/.claude/code-review/scripts
PYTHON=$SCRIPTS/.venv/bin/python3
```

This skill uses only the `stark-claude` GitHub App (not all three like `stark-review`).

## What This Skill Does NOT Do

- Challenge architectural decisions (those were validated during brainstorming)
- Add scope beyond what the plan describes
- Assign issues to people or agents
- Kick off implementation (execution is a separate concern)
- Create GitHub Projects or milestones
- Supplement weak plans with external research — if the plan is insufficient, it stops and asks

## Edge Cases

- **Plan references no repo** — fall back to `git remote -v`. If that also fails (e.g., running from a different directory), ask the user.
- **Plan is too vague for any decomposition** — Pass 1 will flag this. If the plan can't pass the checklist after 3 rounds of user edits, stop and report what's missing.
- **Target repo has no docs/ directory** — create `docs/` with minimal structure during knowledge extraction.
- **GitHub App auth fails** — fail early in Step 1, before any LLM work.
- **Label already exists** — `gh label create --force` is idempotent (updates description/color if changed).
- **Very large plan (20+ tasks)** — handled by per-phase task generation (see Step 3). Guardrails recommend max 6-8 phases × 8-10 tasks; exceeding this signals the plan should be split.
- **Plan contains no extractable knowledge** — skip Step 6 doc enrichment, still delete the plan (the knowledge lives in the issues).
- **Detected repo doesn't match current checkout** — warn and ask user for confirmation before proceeding.
- **Multiple git remotes** — prefer `origin`, warn if multiple remotes point to different orgs.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Plan file doesn't exist or is empty | Fail with clear error message |
| Plan is not markdown (.md) | Fail with "expected .md file" error |
| Target repo doesn't exist on GitHub | Fail at Step 1 with repo name and org |
| Target repo doesn't match current checkout | Warn and ask user at Step 1 |
| GitHub App auth fails | Fail at Step 1 before any LLM work |
| `gh` CLI not found | Fail at Step 1 before any LLM work |
| App lacks issue/label permissions on target repo | Fail at Step 1 after repo access probe |
| GitHub API rate limit during issue creation | Stop, report partial state via run manifest, allow resume |
| Partial issue creation (some succeeded, some failed) | Run manifest records `task_id → issue_number` mapping; re-run skips created issues |
| Token expires mid-run (>1 hour with many issues) | Each `gh` command block inlines token acquisition; stale shell var is the risk, not cache |
| Issue body exceeds 65,536 char GitHub limit | Truncate with note (section caps should prevent this); never split — splitting is a decomposition change |
| LLM returns malformed JSON (Pass 2 or 3) | Validate against schema, retry once with error appended to prompt, halt if still invalid |
| Plan quality gate can't pass after 3 user rounds | Stop at Step 2, report remaining gaps |
| Validation can't converge after 2 iterations | Halt, do not create issues, surface remaining problems |
| Validation agent CLI not found | Fail at Step 1 with message naming the missing agent |
| Re-run on same plan (issues already exist) | Detected at Step 1; user chooses skip/update/fresh |
| Step 6 commit fails (pre-commit hook, dirty tree) | Plan not deleted; warn and leave changes unstaged for user review |

## Mistakes to Avoid

- Don't use `git add -A` for the doc enrichment commit — add specific files by name.
- Don't delete the plan file before all issues are successfully created.
- Don't create issues without error handling — if issue 8 of 15 fails, track partial state in run manifest.
- Don't use comma-separated `--label` values — use separate `--label` flags per label.
- Don't auto-fix the plan in Pass 1 — flag gaps, let the architect fix them.
- Don't keep decomposition JSON only in memory — write to temp file with 0600 permissions.
- Don't proceed to issue creation if validation (Pass 3) didn't converge — halt and ask.
- Don't create labels one at a time without checking — use `--force` flag which is idempotent.
- Don't interpolate LLM-generated text into shell commands — use `gh api --field` or `--body-file`.
- Don't reference Step 6 docs from Step 5 issue bodies — those docs don't exist yet.
- Don't use positional indexes for task references — use stable `task_id` and `phase_id`.

## Observability

Follows the Skill Observability Protocol (`~/.claude/code-review/standards/observability.md`).

**Task-based progress:** TaskCreate per step with `activeForm` spinner text. TaskUpdate to mark in_progress → completed.

**Timestamped log lines:** `[HH:MM:SS]` format with step names and elapsed times.

**5-minute checkpoints:** For long-running plans with many tasks — elapsed time + current step.

**Metrics persistence:** End metrics block appended to `~/.claude/code-review/logs/stark-plan-to-tasks.jsonl` (JSONL, one line per run). Also printed to terminal.

**End metrics block:**

```json
{
  "schema_version": 1,
  "skill": "stark-plan-to-tasks",
  "duration_seconds": 142,
  "plan_file": "docs/superpowers/specs/2026-03-18-widget-system-design.md",
  "target_repo": "GetEvinced/widget-system",
  "pass_1_duration_seconds": 28,
  "pass_1_gaps_flagged": 3,
  "pass_1_user_prompts": 1,
  "pass_2_duration_seconds": 45,
  "pass_3_duration_seconds": 32,
  "pass_3_agents": ["codex"],
  "pass_3_fix_iterations": 1,
  "phases_created": 4,
  "issues_created": 12,
  "labels_created": 8,
  "total_story_points": 47,
  "risk_distribution": {"low": 5, "med": 6, "high": 1},
  "confidence_distribution": {"low": 1, "med": 3, "high": 8},
  "knowledge_files_written": 3,
  "knowledge_files_updated": 1,
  "decision_record_appended": true,
  "plan_deleted": true,
  "dry_run": false
}
```
