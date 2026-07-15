# Plan-dispatch analytics + convergence breaker — design

**Date:** 2026-07-15 · **Status:** draft · **Scope:** one PR to `stark-skills`; a single-user playground tool

## Problem

`tools/plan_dispatch.ts` (the `/stark-spec-to-plan` lead/wing generation loop) has
**no growth or convergence instrumentation** — the one thing the doc-review loop
(`tools/stark_review_doc.ts`) got in #674–#676. A live run on the kotodama
`bot-calendar-titles` spec (2026-07-15) exposed the gap: the draft grew
23.8k → 45.8k → 62.4k chars (2.62×) across 3 rounds and terminated
`max_rounds_unresolved` with **no signal** distinguishing "legitimately hard spec,
needs more rounds" from "runaway padding." The operator sees a bare
`max_rounds_unresolved` and a 62k-char plan, with nothing measuring whether the
growth was signal or noise.

The doc-review loop already solved exactly this — soft/hard growth caps,
non-convergence detection, the invent-then-condemn discriminator, health grading,
and a rendered analytics sidecar all live in
`tools/stark_review_doc_analytics_lib.ts`. Plan generation should **reuse that
brain**, not grow a second one.

## What this is not

- NOT a new analytics engine. The breaker logic (`evaluateGuards`, `judgeGrade`,
  `renderAnalyticsMarkdown`, `DEFAULT_ANALYTICS_THRESHOLDS`) is reused **as-is**
  from `stark_review_doc_analytics_lib.ts` — SSOT, one breaker for both loops. If
  the two ever diverge, that is a bug.
- NOT a change to the generate/review/revise **prompts** — those got the
  playground-scope guard in #677/#678 and are the *upstream* fix. This is the
  *backstop*, exactly as #675/#676 was the backstop to the review preambles.
- NOT a hard kill of every large plan. A genuinely intricate spec legitimately
  produces a longer plan; growth **alone** is advisory (warn + ack), never a hard
  stop. Only growth **past the hard cap** or **growth + non-convergence** or
  **invent-then-condemn** aborts.
- NOT a worktree/git rollback. Plan generation is text-in/text-out with no
  committed baseline (unlike doc-review, which reverts a file). The "rollback"
  analog here is *which draft the run emits* — see Design §5.
- NOT an operator-blocking prompt in headless/automated runs. The growth ack is
  surfaced by the `/stark-spec-to-plan` skill via `AskUserQuestion`; a direct
  headless dispatch only warns and continues (the analytics record it either way).

## Design

### 1. Reuse the breaker brain via an adapter (SSOT)

`evaluateGuards(originalChars, roundStats: RoundStat[], thresholds)` and
`judgeGrade(flags)` are already shape-agnostic — they consume `RoundStat`s. The
plan loop already exposes every field they need: `draft_length` (growth),
`blocking_findings.length` (the `to_fix` analog), and — since #678 — the wing
tags scope-inflation findings `over-engineering` (the invent-then-condemn
discriminator). So the entire feature is an **adapter** that maps plan rounds onto
`RoundStat`, plus wiring the verdict into the abort path, the receipt, and a
sidecar.

New module `tools/plan_analytics_lib.ts` (thin — the brain stays in
`stark_review_doc_analytics_lib.ts`; this only adapts + persists):

```
planRoundsToRoundStats(rounds: PlanRoundResult[]): RoundStat[]
buildPlanAnalytics(rounds: PlanRoundResult[], thresholds: AnalyticsThresholds): ReviewAnalytics
countOverEngineeringFindings(findings: string[]): number
```

`buildPlanAnalytics` is the only entry point (single signature): it calls
`planRoundsToRoundStats`, then the reused `evaluateGuards` + `judgeGrade`, and
returns a `ReviewAnalytics`. No overloads.

### 2. The adapter mapping

Each `PlanRoundResult` → one `RoundStat` with `kind: "review-fix"` (so every plan
round counts as a fix round in `evaluateGuards`; it filters
`roundStats.filter(r => r.kind === "review-fix")`):

| `RoundStat` field | Source (plan round) |
|---|---|
| `kind` | `"review-fix"` (constant) |
| `round` | `round` |
| `doc_chars_before` | prior round's `draft_length` (round 1: its own `draft_length` → per-round ratio 1.0, no false spike) |
| `doc_chars_after` | this round's `draft_length` |
| `to_fix` | `blocking_findings.length` |
| `scope_findings` | `countOverEngineeringFindings(blocking_findings)` |
| `recurring` | `0` (no recurring-classification in generation) |
| `raw_findings` | `blocking_findings.length` |
| `patches_attempted` / `patches_applied` / `patch_failures` | `0` (not applicable — the churn/patch-thrash advisory flags never fire, correct for a text loop) |
| `duration_s` | `duration_s` |

`originalChars` = **round-1 `draft_length`** (the baseline; plan generation has no
pre-existing document, so the first draft is the reference the growth ratio
measures against).

**Deterministic metrics.** The baseline is always > 0 — an empty round-1 draft
aborts as `lead_round1_empty_draft` *before* analytics run, so the ratio never
divides by zero. A round that errored (dispatch failure, no verdict) is **not** a
growth or convergence data point: its `RoundStat` carries the prior draft's length
(so a transient error reads as neither growth nor shrink) and it is excluded from
the non-convergence comparison rather than counted as "did not decline."
Non-convergence compares `to_fix` across consecutive *completed* review-fix rounds
only. These rules make every metric single-valued for any round sequence.

### 3. Over-engineering detection (invent-then-condemn)

The wing (post #678) is instructed to label scope-inflation findings
`over-engineering`. `blocking_findings` is `string[]`, so detection is a host-side
match:

```
countOverEngineeringFindings(findings) =
  findings.filter(f => /over[-\s]?engineer|scope[-\s]?inflat/i.test(f)).length
```

This is the discriminator that keeps a **legitimately** growing plan from tripping
the padding abort: on the kotodama run every finding was a real execution bug and
`scope_findings == 0`, so invent-then-condemn correctly would **not** fire. It
fires only when the doc ballooned **and** the wing itself is condemning the scope
— the review manufactured scope it now flags.

**One owner for the category (SSOT).** The **wing** is the sole authority on
whether a finding is over-engineering — it applies the `over-engineering` label
(per #678). `countOverEngineeringFindings` is a **pure counter** over that label;
it never independently re-classifies a finding's scope-inflation status. So the
classification has one producer (the wing) and one consumer (the host counter),
not two competing owners. (A future refinement could have the wing emit a
structured `category` field instead of a text tag; the string match is the
low-friction path and is a strict superset of the labeled findings — it ships
first.)

### 4. Wiring the verdict into the loop

Inside `runPlanDispatch`, after each round is pushed and before deciding whether to
run another revise round, evaluate the guard on the rounds so far:

- **Hard growth cap** (`runaway_growth_hard`, ratio > `hard_doc_growth_ratio`,
  default 3×) → abort the loop immediately, `final_verdict = "aborted"`,
  `error = "padding_hard_growth"`.
- **Invent-then-condemn** (soft-growth breach **and** `scope_findings > 0` on the
  last round) → abort, `error = "padding_invent_then_condemn"`.
- **Growth + non-convergence** (soft-growth breach **and** `blocking_findings` did
  not decline for `non_convergent_rounds` consecutive rounds) → abort,
  `error = "growth_with_non_convergence"`. The loop is failing to converge under
  growth — stop, but this is **not** labeled "padding" (proven padding needs the
  scope signal, which this case lacks).
- **Non-convergence alone** (findings not declining, no growth breach) → abort,
  `error = "non_convergent"` (the wing is spinning; more rounds won't help).
- **Soft growth alone, findings declining** → do **not** abort; set
  `growth_ack_required = true`, continue. The run finishes normally but the
  receipt/skill flag it for operator judgment (§6).

All four abort kinds emit the latest draft, marked not-approved (§5) — the
`rollback_recommended` flag is not consumed by this loop (no file to revert). The
guard reuses `GuardVerdict.{abort, abort_reason, flags, growth_ack_required}`
verbatim — no new predicates.

### 5. Which draft the run emits on abort

Plan generation is text-in/text-out with **no committed baseline** — there is no
file to revert, so this loop does **not** import doc-review's rollback semantic.
On **every** abort (hard-growth, invent-then-condemn, growth+non-convergence, or
non-convergence alone), `final_plan` carries the **latest draft**, marked
not-approved (`final_verdict = "aborted"`). The run never silently emits an older
draft: discarding the latest round can throw away legitimate fixes it made, and
"which older draft" is exactly the ambiguity that produced contradictory selection
rules. Uniform across all abort kinds — there is no per-kind draft-selection
policy to get wrong.

Instead of *choosing* a draft, the analytics **report** the shape so the operator
decides:

- `analytics.abort_reason` — the specific breaker that fired.
- `analytics.growth_ratio` + a new `analytics.last_lean_round` — the last round
  whose cumulative growth was still `≤ max_doc_growth_ratio` (the un-inflated
  reference point). Null when round 1 already breached.

The operator reads the abort + the last-lean-round pointer and re-runs
deliberately (now under the #677 scope guard), raises `--max-rounds`, or splits the
spec — rather than shipping the padded draft unexamined. Automatic older-draft
emission is **deferred**: add it only behind an explicit quality-preservation
policy if operators show they want it.

### 6. Persistence + operator surface

**Single owner per artifact (SSOT).** The **dispatcher** owns analytics
*computation* and returns it in the receipt; it never prompts and never writes
files. The **skill** owns everything operator-facing — the sidecar, the ack
prompt, and recording the ack decision. The dispatcher emits a *fact*
(`growth_ack_required`); the skill owns the *decision*. This split is the fix for
the "two owners / contradictory ownership" findings.

- **Receipt (dispatcher):** `PlanDispatchResult` gains `analytics: ReviewAnalytics
  | null` (null only on dispatch failure before round 1). The dispatcher result is
  returned **once and never mutated**, so it carries no operator decision and no
  post-return persistence errors — those belong to the skill (below), which is the
  process still running when they occur.
- **Sidecar (skill):** the skill renders `<plan>.plan-analytics.md` via the reused
  `renderAnalyticsMarkdown`. **Receipt + sidecar are the entire persistence
  contract.** A raw history-dir analytics copy is **deferred** — there is no
  cross-run analysis consumer today, so building the store first would be exactly
  the speculative machinery this feature exists to prevent.
- **Ack (skill-owned, ordered):** when `analytics.growth_ack_required` is set and
  the run otherwise succeeded, the skill, **in this order**: (1) writes the sidecar
  + its own run receipt *first*, so the record exists before any prompt; (2)
  surfaces the grade + growth ratio via `AskUserQuestion` — *Continue (growth
  legitimate)* / *Stop (inspect)*; (3) records the answer in a **skill-owned**
  field `growth_ack: {required, decision, decided_at}` in the skill receipt —
  never back into the already-returned dispatcher result. *Continue* → post
  findings, noting "growth acked by operator." *Stop*, **or headless** (no TTY to
  prompt) → stop before posting, exit non-zero. Identical to the
  `/stark-review-spec` growth-ack gate (#675) this mirrors.
- **Kill switch (`STARK_PLAN_ANALYTICS_KILL`):** disables the breaker — no aborts,
  `growth_ack_required` never set — but analytics are **still computed and
  persisted**, so a killed run yields a coherent advisory/`healthy` receipt whose
  verdict and analytics never disagree.

## Components & interfaces

| Unit | Depends on | Contract |
|---|---|---|
| `planRoundsToRoundStats` (`plan_analytics_lib.ts`) | `RoundStat` type | `PlanRoundResult[] → RoundStat[]` per §2; pure |
| `countOverEngineeringFindings` | — | `string[] → number`; pure; the §3 regex |
| `buildPlanAnalytics` | `evaluateGuards`, `judgeGrade`, `buildAnalytics`/`renderAnalyticsMarkdown` (reused) | `(rounds, thresholds) → ReviewAnalytics`; no new breaker logic |
| `runPlanDispatch` (edit) | the above | evaluates the guard per round (§4), sets `final_verdict`/`error`, picks the emitted draft (§5), attaches `analytics` to the result |
| `/stark-spec-to-plan` SKILL (edit) | receipt `analytics` | writes the sidecar, surfaces the ack (§6) |

## Config

New `spec_to_plan.analytics` section in `stark_config_lib.ts` exposing **only the
three thresholds that can fire in a text loop**: `max_doc_growth_ratio` (soft,
default 2), `hard_doc_growth_ratio` (default 3), `non_convergent_rounds` (default
2). The `AnalyticsThresholds` fields the adapter zeroes — round-growth-spike,
churn, patch-thrash — are **not** part of plan config; `buildPlanAnalytics` fills
them from `DEFAULT_ANALYTICS_THRESHOLDS` internally so they stay inert and add no
operator-facing surface. The three exposed defaults are **read from** the same
`DEFAULT_ANALYTICS_THRESHOLDS` constants, not re-literaled, so the two loops can't
silently drift. Kill switch `STARK_PLAN_ANALYTICS_KILL` per §6.

## Worked example — the kotodama run this spec is motivated by

Rounds: draft `23817 → 45831 → 62359` chars; blocking findings `10 → 5 → 6`;
`scope_findings` `0 → 0 → 0` (every finding a real execution bug).

Under the ported breaker (`max_doc_growth_ratio: 2`, `hard: 3`,
`non_convergent_rounds: 2`):
- growth ratio at round 3 = 62359/23817 = **2.62×** → soft breach (`runaway_growth`
  flag), under the 3× hard cap → no hard abort.
- `scope_findings == 0` → invent-then-condemn does **not** fire (growth was
  legitimate — correct).
- findings `10 → 5 → 6`: declined R1→R2, **rose** R2→R3 → not declining across the
  last 2 rounds → `non_convergent`.
- soft-growth **and** non-convergent → **composite abort**, `error =
  "growth_with_non_convergence"`, grade `runaway`. This is the loop failing to
  converge under growth — **not** proven padding (that needs the scope signal,
  absent here: `scope_findings == 0`, the growth was legitimate detail).
  `final_plan` = the latest (round-3) draft, marked not-approved;
  `analytics.last_lean_round = 1` (the only round ≤ 2×).

So instead of a bare `max_rounds_unresolved` + a 62k plan with no context, the
operator gets: *"aborted round 3 — grew 2.62× while findings stopped declining
(10→5→6); not converging. Last lean draft was round 1. Raise `--max-rounds` or
split the spec,"* plus the analytics sidecar. The signal that was missing.

## Testing

- **Unit (`plan_analytics_lib.test.ts`):** the adapter mapping (`draft_length →
  doc_chars_after`, round-1 baseline, `over-engineering` count); the regex on
  tagged vs untagged findings; `buildPlanAnalytics` grade for the four cases
  (healthy / soft-growth-degraded / non-convergent-runaway / invent-then-condemn);
  the **kotodama replay** vector above pinned as a regression (2.62× + 10→5→6 +
  0 scope → `growth_with_non_convergence` abort, `last_lean_round = 1`, latest
  draft emitted marked not-approved).
- **Metric determinism:** zero/one-round inputs; a mid-run **errored round**
  (carries prior length, excluded from the non-convergence comparison); baseline
  is always > 0 (empty round-1 aborts upstream). Every metric single-valued.
- **Loop (`plan_dispatch` test):** hard-growth round-2 abort; invent-then-condemn
  abort with a tagged finding; growth-alone sets `growth_ack_required` without
  aborting; non-convergence-only and every padding abort emit the **latest** draft
  marked not-approved (no older-draft selection); failure on round 2 leaves a
  coherent partial analytics record, not a crash; `STARK_PLAN_ANALYTICS_KILL`
  records analytics, never aborts, and the receipt's verdict + analytics agree.
- **Skill-boundary (ack path):** headless run with `growth_ack_required` → stops +
  exits non-zero without prompting; interactive *Continue* → posts, ack recorded
  in the **skill** receipt (never the dispatcher result); *Stop* → no posting.
- **No new breaker-logic tests** — `evaluateGuards`/`judgeGrade` are already
  covered in `stark_review_doc_analytics_lib.test.ts`; reusing them means their
  coverage covers this too (the SSOT payoff).
- **Live:** re-run `/stark-spec-to-plan` on the kotodama spec; confirm the
  composite abort fires with the latest draft marked not-approved + `last_lean_round`
  reported + sidecar, and that a small/clean spec still grades `healthy` and approves.

## Open questions

None blocking. Deferred, each gated on real evidence rather than built now:

1. **Structured `category` per wing finding** (replacing the §3 text match) — only
   if the text tag proves noisy in practice; the string match ships first.
2. **Automatic older-draft emission on abort** — only behind an explicit
   quality-preservation policy, if operators show they want it over the
   latest-draft-marked-unapproved default (§5).
3. **Raw history-dir analytics store** — only when a concrete cross-run analysis
   workflow needs it (§6); receipt + sidecar are the contract until then.

## Design decisions (from the #679 spec review)

- **Growth ack kept interactive** (not simplified to warn-only): the
  `AskUserQuestion` gate stays, but §6 pins a single owner (skill) + ordered
  persistence so it carries no ownership ambiguity.
- **No rollback semantic** (§5): every abort emits the latest draft marked
  not-approved and reports `last_lean_round` — the pre-balloon-draft selection was
  cut as a borrowed, contradiction-prone semantic.
