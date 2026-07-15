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
  stop. The **padding aborts** are growth **past the hard cap**, **growth +
  non-convergence**, and **invent-then-condemn**; separately, **non-convergence
  alone** (findings not declining, no growth breach) also aborts as a loop-safety
  stop. See Design §4 for the full, authoritative abort list.
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
buildPlanAnalytics(opts): ReviewAnalytics        // wraps evaluateGuards + judgeGrade
countOverEngineeringFindings(findings: string[]): number
```

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

### 3. Over-engineering detection (invent-then-condemn)

The wing (post #678) is instructed to prefix scope-inflation findings with an
**exact, anchored, machine-readable marker** — the literal token `[over-engineering]`
at the start of the finding string — which is the **sole authority** for the
category. The host never independently infers scope-inflation from free prose;
there is **one owner** (the wing emits the tag), **one exact matcher** (the adapter
reads it), and **one shared exported constant** so the two vocabularies cannot
drift. `blocking_findings` is `string[]`, so detection matches only that anchored
marker:

```
OVER_ENGINEERING_TAG = "[over-engineering]"   // shared exported constant; the wing prompt and the adapter reference the same token
countOverEngineeringFindings(findings) =
  findings.filter(f => f.trimStart().startsWith(OVER_ENGINEERING_TAG)).length
```

Anchoring on the exact tag (not a broad regex) means a negation, explanatory
prose, or a complaint *about* a missing tag can never false-match and spuriously
increment `scope_findings` — which drives an abort + rollback, so a false match
would change control flow. The tag match is therefore correctness-preserving, not
merely a superset.

This is the discriminator that keeps a **legitimately** growing plan from tripping
the padding abort: on the kotodama run every finding was a real execution bug and
`scope_findings == 0`, so invent-then-condemn correctly would **not** fire. It
fires only when the doc ballooned **and** the wing itself tagged the scope
— the review manufactured scope it now flags. (A fuller refinement — the wing
emitting a fully structured `category` field per finding — is deferred; the shared
`[over-engineering]` tag constant is the low-friction path that already gives one
authoritative source.)

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
  `error = "growth_non_convergent"`. This is a **loop-safety** stop, not proven
  padding — it names the composite honestly (the doc grew *and* stopped
  converging) without claiming the extra scope was inventory padding. Because a
  growth breach is present, `rollback_recommended` is set and it emits the
  pre-balloon draft (§5).
- **Non-convergence alone** (findings not declining, no growth breach) → abort,
  `error = "non_convergent"`. The count trajectory is a **proxy** for a spinning
  loop, inherited verbatim from the doc-review brain (SSOT); it is the signal to
  stop and let the operator raise `--max-rounds` or split the spec, not a proof
  that more rounds cannot help (see the §4 note).
- **Soft growth alone, findings declining** → do **not** abort; set
  `growth_ack_required = true`, continue. The run finishes normally but the
  receipt/skill flag it for operator judgment.

These reuse `GuardVerdict.{abort, abort_reason, flags, growth_ack_required,
rollback_recommended}` verbatim — no new predicates.

> **§4 note — convergence is a count proxy, deliberately.** `evaluateGuards`
> judges convergence from the blocking-findings *count* trajectory (and this
> adapter sets `recurring = 0`), so a `10 → 5 → 6` movement cannot distinguish
> "the same findings stayed unresolved" from "the original findings were fixed and
> new, legitimate ones surfaced." Carrying per-finding identity + per-round
> disposition would **fork the reused brain and defeat the SSOT payoff**, so it is
> out of scope here — this loop inherits the exact same count heuristic (and the
> same limitation) as doc-review. The non-convergence abort is therefore a
> conservative *stop-and-ask-the-operator* signal, not a proof; the operator
> decides whether to raise `--max-rounds` or split the spec.

### 5. Which draft the run emits ("rollback" analog)

Doc-review reverts the file to its pre-review state on a padding abort. Plan
generation has no committed baseline, so the analog is **which draft
`final_plan` carries** when `rollback_recommended` is true. `rollback_recommended`
is set on **every abort that carries a growth breach** — the three growth-breach
aborts: hard-growth (`runaway_growth_hard`), invent-then-condemn, and the composite
growth + non-convergence (`growth_non_convergent`). It is **not** set for
non-convergence alone (no growth breach → keep the latest draft).

- Emit the **pre-balloon draft** — the latest round whose **cumulative** growth
  ratio (that round's `draft_length ÷ originalChars`) was still within the soft
  cap (`≤ max_doc_growth_ratio`), i.e. the last draft before growth crossed the
  soft line. If round 1 itself already breached (rare), emit round 1.
- `final_verdict = "aborted"`; the receipt's `analytics.abort_reason` explains it;
  the emitted draft is flagged not-approved so the operator re-runs deliberately
  (now under the #677 scope guard) rather than shipping the padded 62k version.

For non-convergence-only aborts (no growth breach, `rollback_recommended = false`),
keep the latest draft (it may carry legitimate partial progress) — mirrors
doc-review, where convergence-only aborts do not roll back.

### 6. Persistence + operator surface

**Two receipts, one owner per field.** The dispatcher emits an inner
`PlanDispatchResult`; the skill wraps it in an outer envelope **after** all writes.

- **Dispatcher receipt (`PlanDispatchResult`):** gains an `analytics:
  ReviewAnalytics | null` block (same type the doc-review receipt uses). `null` on
  dispatch failure before round 1 (no baseline exists yet). The dispatcher is
  file-free, so `persistence_errors` does **not** live here.
- **Sidecar + history (skill-owned):** the `/stark-spec-to-plan` skill writes
  `<plan>.plan-analytics.md` next to the plan (via the existing
  `renderAnalyticsMarkdown`) and the raw `analytics` JSON into its history dir —
  mirroring the doc-review sidecars. Atomic tmp+rename per file.
- **Skill envelope (`SpecToPlanReceipt`):** created after all writes complete. It
  embeds the dispatcher `PlanDispatchResult` verbatim and **owns**
  `persistence_errors: string[]` — one entry per failed sidecar/history write
  (empty array = all writes succeeded). This resolves the ownership gap: the
  file-free dispatcher never claims to know about write failures; the skill that
  performs the writes is the sole producer of `persistence_errors`. If the
  envelope itself cannot be persisted, the skill still returns it in-memory and
  logs the failure to stderr — the generated plan on disk is never lost to a
  receipt-write failure.

**Ack state machine.** When `growth_ack_required` is set and the run otherwise
succeeded, the plan + sidecar + history are written **first** (so nothing is lost
regardless of the answer), then the skill surfaces the grade + growth ratio via
`AskUserQuestion` before Phase 5 posts (identical pattern to `/stark-review-spec`
#675):

| Response (`AskUserQuestion` option id) | Effect |
|---|---|
| **Continue** (`ack_continue`) | Phase 5 posts; envelope records `growth_ack = "accepted"`; `final_verdict` stays `approve`. |
| **Stop** (`ack_stop`) | Phase 5 **suppressed** (no PR post); envelope records `growth_ack = "rejected"`, `final_verdict = "held"`, `error = "growth_ack_rejected"`. Plan + sidecar stay on disk — nothing discarded; the operator re-runs or ships by hand. |
| No answer / cancelled (non-TTY or timeout) | Treated as **Stop** for posting (fail-closed: never auto-post an un-acked growth), `growth_ack = "unattended"`, warning logged; artifacts remain on disk. |

Headless/direct dispatch never prompts: it logs the warning, records `growth_ack =
"unattended"`, and proceeds without posting. The `growth_ack` value is persisted in
the envelope (and mirrored into the analytics record) so the decision is auditable.

## Components & interfaces

| Unit | Depends on | Contract |
|---|---|---|
| `planRoundsToRoundStats` (`plan_analytics_lib.ts`) | `RoundStat` type | `PlanRoundResult[] → RoundStat[]` per §2; pure |
| `countOverEngineeringFindings` | shared `OVER_ENGINEERING_TAG` constant | `string[] → number`; pure; exact anchored-tag match per §3 (never prose inference) |
| `buildPlanAnalytics` | `evaluateGuards`, `judgeGrade`, `buildAnalytics`/`renderAnalyticsMarkdown` (reused) | `(rounds, thresholds) → ReviewAnalytics`; no new breaker logic |
| `runPlanDispatch` (edit) | the above | evaluates the guard per round (§4), sets `final_verdict`/`error`, picks the emitted draft (§5), attaches `analytics` to the result |
| `/stark-spec-to-plan` SKILL (edit) | receipt `analytics` | writes the sidecar + history, wraps the dispatcher result in the `SpecToPlanReceipt` envelope that owns `persistence_errors`, and runs the ack state machine (§6) |

## Config

New `spec_to_plan.analytics` section in `stark_config_lib.ts`. Its defaults are
**constructed from `DEFAULT_ANALYTICS_THRESHOLDS`** (spread the shared constant,
then layer any plan-specific overrides) — the numeric values `2 / 3 / 2` are
**never re-typed** in `stark_config_lib.ts`, so the two loops cannot drift and stay
calibrated identically unless deliberately overridden. If importing the constant
from `stark_review_doc_analytics_lib.ts` would create a dependency cycle, the shared
threshold definition moves to a neutral module both libraries import. (The
round-growth-spike / churn / patch-thrash thresholds are inherited but inert for a
text loop.)

Kill switch `STARK_PLAN_ANALYTICS_KILL` disables **enforcement** only — analytics
are still computed and recorded, guards never abort — mirroring the doc-review kill
switches. To keep a kill-switched receipt unambiguous, the analytics record carries
an explicit **enforcement state**: `analytics.enforced: boolean`, and the
counterfactual `analytics.would_abort` is kept separate from the applied
`analytics.abort`. With the switch on, `would_abort` may be `true` while
`analytics.abort` is `false` and `final_verdict` is a success — a renderer or
history consumer reads `enforced: false` and interprets the verdict correctly
instead of seeing a contradictory `abort: true` + `approve`.

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
  last 2 rounds → non-convergent.
- soft-growth **and** non-convergent → **composite abort**, `error =
  "growth_non_convergent"` (a loop-safety stop, not a claim the extra scope was
  padding), grade `runaway`. Because a growth breach is present,
  `rollback_recommended` is set → emit the **pre-balloon draft**: the latest round
  whose cumulative ratio is `≤ 2×`, which is **round 2** (45831/23817 = **1.92×**,
  still within the soft cap; round 3 at 2.62× is the first over-cap draft, round 1
  is 1.0×).

So instead of a bare `max_rounds_unresolved` + a 62k plan, the operator gets the
pre-balloon round-2 draft (1.92×, not the padded 62k round-3 one) plus:
*"aborted round 3 — grew 2.62× while findings stopped declining (10→5→6); this
spec is genuinely intricate, raise `--max-rounds` or split it,"* and the analytics
sidecar. The signal that was missing.

## Testing

- **Unit (`plan_analytics_lib.test.ts`):** the adapter mapping (`draft_length →
  doc_chars_after`, round-1 baseline, `over-engineering` count); the **exact-tag**
  matcher on tagged vs untagged findings — including the false-match guards (a
  negation, a finding *complaining about* a missing tag, the token mid-string
  rather than anchored → all count `0`); `buildPlanAnalytics` grade for the four
  cases (healthy / soft-growth-degraded / non-convergent-runaway /
  invent-then-condemn); the **kotodama replay** vector above pinned as a regression
  (2.62× + 10→5→6 + 0 scope → composite `growth_non_convergent` abort, emit
  **round 2**, the 1.92× pre-balloon draft).
- **Edge cases (unit):** empty/blank first draft and `draft_length === 0` (baseline
  `originalChars === 0` must not divide-by-zero — defined as a valid zero-state with
  a finite ratio, not `NaN`/`Infinity`); empty `blocking_findings` list; non-finite
  / malformed round metrics from model output → asserted to become either a
  deterministic dispatch failure or a finite valid zero-state, and the emitted
  analytics JSON stays finite + serializable in every case.
- **Threshold wiring (unit):** `spec_to_plan.analytics` defaults compare **equal**
  to `DEFAULT_ANALYTICS_THRESHOLDS` (guards the "derived from the constant, not
  re-typed" claim); a custom `spec_to_plan.analytics` override propagates into the
  guard; and the exact **boundary semantics** — a cumulative ratio *exactly at* 2×
  and 3× vs *just above* — pin whether each cap comparison is `>` or `≥`; plus
  "latest soft-cap-eligible draft" selection when several rounds qualify.
- **Loop (`plan_dispatch` test):** hard-growth round-2 abort; invent-then-condemn
  abort with a tagged finding; growth-alone sets `growth_ack_required` without
  aborting; `STARK_PLAN_ANALYTICS_KILL` records analytics (with `enforced: false` +
  the counterfactual `would_abort`) but never aborts; non-convergence-only keeps the
  latest draft, growth-breach abort emits the pre-balloon draft; **dispatch failure
  before round 1 returns `analytics: null`**.
- **Skill integration (`spec_to_plan` skill test, temp files + mocked
  `AskUserQuestion`):** covers healthy (approves, no prompt), growth-ack **Continue**
  (Phase 5 posts, `growth_ack = "accepted"`), growth-ack **Stop** (posting
  suppressed, `final_verdict = "held"`, artifacts still on disk), and headless
  (`growth_ack = "unattended"`, warning logged, no prompt, no post) — asserting
  sidecar + history contents, the write-**then**-ask ordering, Phase 5 gating, and
  that a persistence-write failure surfaces deterministically in the envelope's
  `persistence_errors` while the plan on disk and `final_verdict` are preserved.
- **No new breaker-logic tests** — `evaluateGuards`/`judgeGrade` are already
  covered in `stark_review_doc_analytics_lib.test.ts`; reusing them means their
  coverage covers this too (the SSOT payoff).
- **Live:** re-run `/stark-spec-to-plan` on the kotodama spec; confirm the composite
  abort fires with the pre-balloon round-2 draft + sidecar, and that a small/clean
  spec still grades `healthy` and approves.

## Open questions

None blocking. One deferred refinement: a fully structured `category` field per
wing finding (replacing the §3 `[over-engineering]` tag) — worth it only if the tag
proves insufficient in practice; the shared tag constant ships first.
