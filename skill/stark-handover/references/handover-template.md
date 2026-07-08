# Handover Body Template

Structure for the `handover_{N}.md` body (the CLI prepends frontmatter:
task/seq/project/worktree/branch/head/created/prev). Follow the section
names exactly — resume relies on them. Omit a section only where marked.

```markdown
# {One-line summary of current work}

## The Goal

{2-4 sentences: overarching objective, why it matters, what "done" looks
like. Not this iteration's step — the destination.}

## Since Last Handover

{ONLY if seq > 1. Compare the previous handover's "Where We're Going"
against what actually happened: which steps landed, which open questions
got answered, whether priorities shifted. 3-6 bullets. Omit at seq 1.}

## Where We Are

{8-20 bullets. Every file/function changed with specifics, what works,
what doesn't, test state. "Under 8 bullets after a real session" = mined
too shallow.}

## What We Tried

{Chronological, INCLUDING failures — the most expensive thing to
re-discover. Per entry: approach → result (with numbers) → why kept or
abandoned. Write "Nothing failed this session" explicitly if so.}

## Key Decisions

{Every non-obvious decision + WHY, including rejected alternatives.
These prevent the next session from re-litigating settled questions.}

## Evidence & Data

{Raw numbers only: test counts, exit codes, benchmark values, error
messages verbatim, paths to result files. Never "improved" — always
"improved from X to Y". Omit if truly none (rare).}

## User Feedback & Preferences

{Verbatim direction the user gave: corrections, preferences,
frustrations, process feedback ("stop asking, just do it"). This is the
user's voice — it calibrates the next session's behavior. Never omit if
the user said anything directional.}

## Where We're Going

{Ordered next steps, 3-7 bullets, each concrete enough to start on
without thinking. First bullet = THE next action.}

## Risks & Open Questions

{Blockers, flaky areas, unknowns needing investigation, decisions
deliberately deferred. "None" if genuinely clear.}

## Quick Start

```bash
# Verify state
{test command or check that proves the tree is as this handover claims}

# Key files to read first (3-5, most important)
{paths}

# Next action
{THE single most important thing to do next}
```
```

## Composition rules

- **Target 80-250 lines.** Hard floor for a real work session: 60. A light
  session (short Q&A, tiny fix) may drop to ~40.
- Specifics over summaries: file paths, function names, line numbers, real
  numbers. "Fixed the bug" is useless; "fixed off-by-one in
  `nextSeq()` (`tools/stark_handover_lib.ts:214`), gap case now max+1" resumes itself.
- The quality test: could a zero-context session read this and start working
  within 2 turns without asking "what were we doing"?
