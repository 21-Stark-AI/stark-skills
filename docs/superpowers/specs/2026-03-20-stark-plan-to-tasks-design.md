# stark-plan-to-tasks Skill Design

## Overview

Skill that takes a spec/design document (typically produced by the brainstorming skill), decomposes it into phased GitHub issues, extracts knowledge into project documentation, and deletes the plan. The plan is a transient artifact — its value gets distributed: actionable work goes to GitHub issues, domain knowledge goes to project docs.

## Inputs

One positional argument: `<path-to-spec>` (e.g., `docs/superpowers/specs/2026-03-18-widget-system-design.md`).

The spec must be self-contained. This skill does not supplement weak plans — it validates and rejects them.

## Core Principle: Quality Chain

The plan is the source of truth. If the decomposition struggles, the plan is weak. If the implementing agent needs context beyond the issue, the issue is weak. If the issue is weak, the decomposition failed. If the decomposition failed, the plan was insufficient. Quality flows downstream: plan → decomposition → issues → implementation → review.

## Three LLM Passes

| Pass | Purpose | Input | Output |
|------|---------|-------|--------|
| 1. Quality Gate | Find gaps, ambiguities, contradictions, missing details | Raw plan | Fixed plan (edited in-place) |
| 2. Decomposition | Break plan into phases → tasks with self-contained issues | Fixed plan | Structured breakdown (JSON in memory) |
| 3. Validation | Verify nothing lost, every issue is self-contained, dependencies correct | Breakdown + fixed plan | Approved breakdown or flagged issues |

## Execution Sequence

### Phase 1: Setup

- Read the plan file. Fail if it doesn't exist or is empty.
- Detect target repo: parse the plan for repo references, fall back to `git remote -v` in the current directory.
- Verify GitHub App auth: `$PYTHON $SCRIPTS/github_app.py --app stark-claude token`. Fail early if auth is broken.
- Read target project's `docs/` tree structure (for knowledge routing in Phase 6).
- Read target project's existing GitHub labels (for label creation in Phase 5).

### Phase 2: Pass 1 — Plan Quality Gate

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

- Edits the plan in-place to fix gaps it can infer from the plan's own context.
- For gaps requiring human input, stops and asks the user before proceeding.

**Scope:**

- Does NOT challenge architectural decisions — those were validated during brainstorming.
- Does NOT add scope — only fills gaps in what's already described.

### Phase 3: Pass 2 — Decomposition

Takes the hardened plan and produces a structured breakdown.

**Phase identification:**

The LLM reads the plan and identifies natural phases — groups of work that share a logical boundary (e.g., "data model + storage layer," "API endpoints," "UI components"). Phases are ordered by dependency.

Each phase gets:
- A name and one-line description
- Why it's a phase (what boundary defines it)
- Which phases it depends on

**Task identification within each phase:**

Each task is a single unit of work an agent can pick up and execute independently. The LLM produces a structured object per task:

| Field | Purpose | Consumer |
|-------|---------|----------|
| Title | Clear, imperative, scoped | Everyone |
| What | Deliverable description | Implementation agent |
| Why | Context from the plan (plan gets deleted — this must stand alone) | Implementation + review agent |
| Where | Specific files/modules to create or modify | Implementation agent |
| How | Implementation approach, key decisions already made | Implementation agent |
| Acceptance criteria | Testable conditions for "done" | Review agent |
| Dependencies | Which other tasks must complete first | Implementation agent |
| Review hints | Edge cases, security concerns, architectural constraints to verify | Review agent |

**Metrics per task (estimated by the LLM):**

| Metric | Values | Label format | Purpose |
|--------|--------|--------------|---------|
| Story points | 1, 2, 3, 5, 8, 13 (Fibonacci) | `sp:N` | Effort estimation; retrospective accuracy analysis |
| Risk | low, med, high | `risk:low`, `risk:med`, `risk:high` | Correlate risk rating vs. actual outcome |
| Confidence | low, med, high | `confidence:low`, `confidence:med`, `confidence:high` | LLM's self-assessed confidence that the task is fully specified |

**Sizing heuristic:**

If a task can't be described in one issue without scrolling, it's too big — split it. If a task is just "create a file with one function," it might be too small — merge with a related task. Each task should be roughly one focused PR's worth of work.

**Output:** Structured JSON held in memory. Not written to disk.

### Phase 4: Pass 3 — Validation

The validation pass receives both the fixed plan and the structured breakdown. Its job is adversarial — it tries to break the decomposition.

**Checks:**

- **Coverage** — every requirement in the plan maps to at least one task. Nothing fell through the cracks.
- **Self-containment** — pick any single task issue: could an agent with no other context implement it? If the answer requires reading another issue or "knowing" something unstated, the issue is incomplete.
- **Dependency correctness** — are the dependency links accurate? Any circular dependencies? Could a task actually start before its declared dependencies complete?
- **No orphan knowledge** — the plan will be deleted. Is there information in the plan that didn't land in either a task issue or the doc enrichment target? If so, it's about to be lost.
- **Overlap** — do two tasks describe the same work? Would two agents step on the same files?
- **Sizing** — any task too vague to estimate or too large for a single PR gets flagged.
- **Review sufficiency** — do the review hints tell a reviewer what to look for, or are they generic ("check for edge cases")?
- **Metric sanity** — are story points consistent across similar-complexity tasks? Does risk rating align with what's described?

**Resolution:**

- Fixable issues (missing context, incomplete acceptance criteria, wrong dependency) → skill fixes them in the structured breakdown and re-validates.
- Structural issues (missed feature, phases in wrong order) → loops back to Pass 2 for that section.
- Max 2 fix iterations. If it can't converge, surfaces remaining issues to the user.

### Phase 5: GitHub Issue Creation

**Label setup:**

Auto-create missing labels on the target repo:
- `sp:1`, `sp:2`, `sp:3`, `sp:5`, `sp:8`, `sp:13` (blue shades, graduated)
- `risk:low`, `risk:med`, `risk:high` (green, yellow, red)
- `confidence:low`, `confidence:med`, `confidence:high` (gray shades)
- `stark-plan-to-tasks` (metadata label — marks all issues created by this skill)

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh label create "sp:3" --color "0052CC" --description "Story points: 3" --repo "{org}/{repo}" --force
```

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
{links to blocking issues}

## Review Hints
{what the reviewer should verify}

---
_Generated by `stark-plan-to-tasks` · Phase: {phase-name} · Tracking: #{phase-issue-number}_
```

Labels: `sp:N`, `risk:level`, `confidence:level`, `stark-plan-to-tasks`.

**Creation order:**

1. Create all phase tracking issues first (to get issue numbers).
2. Create all task issues (referencing phase tracking issue numbers).
3. Update phase tracking issues with task issue checklist links.

All issues posted via `stark-claude` GitHub App:
```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh issue create --title "..." --body "..." --label "sp:5,risk:med,confidence:high,stark-plan-to-tasks" --repo "{org}/{repo}"
```

### Phase 6: Knowledge Extraction & Doc Enrichment

After issues are created, the plan still holds knowledge that doesn't belong in any single task. This knowledge must survive the plan's deletion.

**What gets extracted:**

- Architectural decisions (why the system is shaped this way)
- Data models / schemas (entity definitions, relationships)
- Integration points (how components communicate, API contracts)
- Constraints (performance budgets, security requirements, compliance)
- Glossary / domain terms (terminology defined in the plan)

**Routing logic:**

The skill reads the target project's `docs/` tree and follows existing structure — it does not impose its own.

| Knowledge type | Target | Format |
|----------------|--------|--------|
| Architectural decisions | `docs/adr/` or `docs/decisions/` (whatever exists) | ADR template if project uses one, otherwise plain markdown |
| Data models / schemas | `docs/` alongside related docs | Markdown |
| Integration / API contracts | `docs/api/` or `docs/architecture/` | Markdown |
| Constraints | Existing relevant doc (e.g., `docs/security.md`) — appended | Section in existing file |
| Glossary terms | `docs/glossary.md` (created if missing) | Definition list |

If the project has no docs structure at all, the skill creates minimal files under `docs/`.

**After enrichment:**

- Delete the plan file.
- Single commit covering doc enrichment + plan deletion.
- Commit message references tracking issues: `docs: extract knowledge from plan, create tasks (#41, #42, #43)`

### Phase 7: Summary

Print to terminal:
- Number of phases created
- Total issues created
- Total story points across all issues
- Risk distribution (e.g., 3 low, 5 med, 1 high)
- Confidence distribution
- Links to each phase tracking issue

## Feedback Loop: Issue Quality Signal

Each task issue carries a `stark-plan-to-tasks` label and a `confidence:level` label. After implementation:

- If the implementing agent had to pull additional context beyond what's in the issue, the issue was underspecified.
- Query: `gh issue list --label "stark-plan-to-tasks" --label "confidence:high"` — then check which of those required extra context.
- This signal feeds back into improving the quality gate (Pass 1) and decomposition (Pass 2) prompts, following the same pattern as `stark-review-improvement`.

## Constants

```
PYTHON=~/git/Evinced/scripts/.venv/bin/python3
SCRIPTS=~/.claude/code-review/scripts
```

## What This Skill Does NOT Do

- Challenge architectural decisions (those were validated during brainstorming)
- Add scope beyond what the plan describes
- Assign issues to people or agents
- Kick off implementation (execution is a separate concern)
- Create GitHub Projects or milestones
- Supplement weak plans with external research — if the plan is insufficient, it stops and asks

## Edge Cases

- **Plan references no repo** — fall back to `git remote -v`. If that also fails (e.g., running from a different directory), ask the user.
- **Plan is too vague for any decomposition** — Pass 1 will flag this. If the plan can't be fixed in-place without human input, stop and report what's missing.
- **Target repo has no docs/ directory** — create `docs/` with minimal structure during knowledge extraction.
- **GitHub App auth fails** — fail early in Phase 1, before any LLM work.
- **Label already exists** — `gh label create --force` is idempotent (updates description/color if changed).
- **Very large plan (20+ tasks)** — the skill handles this naturally; phases keep the issue count manageable per tracking issue.
- **Plan contains no extractable knowledge** — skip Phase 6 doc enrichment, still delete the plan (the knowledge lives in the issues).
