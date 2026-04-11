# Design-to-Plan Cross-Review — stark-forge

**Design:** `docs/specs/2026-04-11-stark-forge-design.md`
**Date:** 2026-04-11
**Plans generated:** 2/3 (Gemini, Codex succeeded; Claude timed out)
**Cross-reviews:** 4/4 succeeded

## Scorecard

|              | Complete | Feasible | Phasing | Risk | Testable | Avg |
|--------------|----------|----------|---------|------|----------|-----|
| **codex**    | 8.0      | 8.5      | 7.5     | 8.0  | 7.5      | **7.9** |
| **gemini**   | 5.0      | 6.5      | 6.0     | 5.5  | 6.0      | 5.8 |

**Winner:** codex (7.9/10)

## Per-Plan Assessment

### Codex Plan (Winner — 7.9/10)

**Strengths:**
- Grounds the plan in actual codebase realities, proactively identifying signature mismatches between the design's API calls and existing dispatch primitives
- Front-loads the state machine, worktree isolation, and resume engine before building domain logic
- Strong operational risk mitigation (native `gh` auth, prompt isolation, sandbox repo for smoke tests)
- Function signatures reference real existing code with correct parameter names
- Phase-granular rollback with concrete commands

**Weaknesses (addressed in synthesis):**
- Audit recording deferred to Phase 7 but needed from Phase 4 onward → moved audit to Phase 1
- Terminal output (TaskCreate/TaskUpdate, TTY detection, progress format) not assigned to any task → added as Task 2.5
- Early termination optimization (0 fix → skip to round 4) missing → added to Task 4.2
- Finding recurrence detection (3rd recurrence → blocked) not mentioned → added to Task 4.2
- No mocking strategy described for integration tests → addressed in testing strategy
- /stark-design archival not addressed → added to Task 1.3
- Spec-hash comparison on resume not addressed → captured as design decision

### Gemini Plan (5.8/10)

**Strengths:**
- Good architectural decision: typed return objects (e.g., `ReviewPhaseResult`) from modules to orchestrator
- Correctly identifies SQLite WAL mode and busy timeout need
- Markdown structural parser for auto-fix section replacement (practical corruption mitigation)
- Development parallelism between Classification and Review Engine
- Chaos testing with synthetic kill signals

**Weaknesses (incorporated where valid):**
- SKILL.md creation missing entirely → in synthesis Phase 1
- No implementation-feasibility domain prompt file → in synthesis Phase 1
- Exit codes not mentioned → in synthesis Phase 2
- Consensus degradation handling only covers happy path → in synthesis Phase 4
- Config/install tasks not concrete enough → expanded in synthesis
- Tier 2 auth confusion (GITHUB_TOKEN vs Anthropic API) → corrected in synthesis
- Finding recurrence tracking absent → added in synthesis

## Synthesis Decisions

| Element | Source | Reasoning |
|---------|--------|-----------|
| 7-phase structure | Codex | More granular than Gemini's 5 phases; better isolation and testability |
| Audit in Phase 1 | Gemini | Codex deferred audit to Phase 7; Gemini correctly puts it in Phase 1 so all subsequent phases can log calls |
| Typed return objects | Gemini | `PhaseResult` dataclass pattern is cleaner than Codex's implicit dict returns |
| Prompt isolation | Codex | Explicit decision to use `forge-design-review/` not `design-review/` — prevents standalone skill regression |
| Implementation-feasibility prompt | Cross-review | Both reviews flagged this as missing; added as explicit task |
| Terminal output task | Cross-review | Claude reviewer flagged this as completely missing from both plans; added as Task 2.5 |
| Early termination | Cross-review | Claude reviewer flagged missing; critical control flow path |
| Recurrence detection | Cross-review | Claude reviewer flagged missing; required for Iron Rule escalation to blocked |
| SQLite WAL mode | Gemini | Practical concurrency safety that Codex didn't address |
| Chaos testing | Gemini | Kill-signal testing during auto-fix loop — targets hardest crash recovery scenario |
