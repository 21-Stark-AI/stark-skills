---
name: stark-write-spec
description: >-
  Author a spec doc via a bounded lead/wing contract loop. The lead drafts the
  nine-section spec, the wing verifies it against a host-owned contract, and the
  loop repeats until the contract is satisfied or a bounded breaker fires.
  Findings land on a create-or-adopt PR. Default agents: claude lead, codex
  wing. v1 supports claude|codex only (no gemini).
argument-hint: "<source-or-topic> [--out <path>] [--lead claude|codex] [--wing claude|codex] [--dry-run] [--ready] [--no-pr] [--json] [--lead-model <id>] [--wing-model <id>] [--max-rounds <n>]"
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-write-spec

Author a spec document from a source doc + distilled chat context via a
**bounded lead/wing contract loop**. The lead authors the nine-section spec; the
wing verifies each section against a host-owned contract and returns a
`{items, done, summary}` verdict; the loop revises until the contract is
satisfied or a bounded breaker (`max_rounds_unsatisfied`, `lead_empty_draft`,
`unchanged_revision`, `wing_unparseable`) fires. The result always lands on a
**create-or-adopt PR**.

Answers the question: **"Turn this rough intent into a spec that satisfies
every required section, or tell me exactly which sections are still
unsatisfied."**

**The phase ordering below is load-bearing.** The one AskUserQuestion round can
supply the topic/slug or a non-standard `--out` that slug/path/branch resolution
depends on, so it runs *before* any path/slug/branch work. Skill-layer agent
validation runs *before* `prepare-branch` so an invalid `--lead`/`--wing` can
never mutate a branch. The dispatcher exits non-zero on handled verdicts, so its
receipt is captured *without aborting* the skill.

## Preflight

```bash
TOOLS="${STARK_WRITE_SPEC_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types "$TOOLS/preflight.ts" --workflow write-spec --json
```

- `overall == "blocked"` → print failing checks, stop. In automation contexts,
  emit a `preflight_check` event with `status=blocked` and exit non-zero.
- `overall == "degraded"` → warn, continue.
- `overall == "ready"` → continue silently.

## Arguments

Raw input: `$ARGUMENTS`

- `<source-or-topic>` — required. Path to a source doc (requirements, notes,
  brainstorm) OR a free-text topic. Its contents plus distilled chat context
  become the intent brief the lead authors from.
- `--out <path>` — optional. Destination spec path. Must match
  `docs/specs/YYYY-MM-DD-<slug>-spec.md`. If omitted, the path is computed from
  the resolved slug + today's date.
- `--lead <claude|codex>` — optional. Lead (author) agent. Default from config.
- `--wing <claude|codex>` — optional. Wing (contract verifier) agent. Default
  from config.
- `--lead-model <id>` / `--wing-model <id>` — optional. Override the lead / wing
  model id.
- `--max-rounds <n>` — optional. Cap the lead/wing rounds (default from config).
- `--dry-run` — assemble + dispatch with `--dry-run` (no LLM, no writes); skip
  `prepare-branch` and `publish` entirely.
- `--ready` (alias `--no-draft`) — when this run **opens** a PR, open it
  ready-for-review. By default an auto-opened PR is a **draft**.
- `--no-pr` — skip the `publish` step: write the spec locally, do not open or
  update a PR.
- `--json` — machine-readable output. Also implies headless (the AskUserQuestion
  round is skipped).

## Constants

```
TOOLS = ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools
```

## Phase 1: Preflight

Run the preflight block above. Stop on `blocked`.

## Phase 2: Assemble inputs (no side effects)

Parse `$ARGUMENTS` into flags (`--out`, `--lead`, `--wing`, `--dry-run`,
`--ready`/`--no-draft`, `--no-pr`, `--json`, `--lead-model`, `--wing-model`,
`--max-rounds`) and the positional `<source-or-topic>`.

- Read the source doc if the positional is an existing file; otherwise treat it
  as a free-text topic.
- Distill the relevant chat context into a short intent summary.
- Do **no** slug, out-path, or branch resolution yet — that all happens after
  the question round (Phase 4), because the answers can change it.

## Phase 3: Skill-layer agent validation (before any branch work)

Validate `--lead` and `--wing` **before** Phase 5's `prepare-branch`, so an
invalid agent can never mutate a branch before the dispatcher's own rejection.
Each must be one of `{claude, codex}`. Reject anything else — including
`gemini` — with the exact error and a non-zero exit:

```
unsupported agent: gemini (claude|codex only at v1)
```

(Substitute the offending value for `gemini` in the message.) This is the same
rejection the dispatcher enforces, pulled forward so it fires **before**
`prepare-branch` is reachable. Do not continue to Phase 4 on an invalid agent.

## Phase 4: One AskUserQuestion round

Run **exactly one** `AskUserQuestion` round covering at most **four** gaps in the
intent (e.g. topic/slug when only a bare source was given, scope declaration —
playground vs production, a non-standard `--out` path, any single blocking
ambiguity). Rules:

- **Answer-once:** never re-prompt a field the user (or a CLI flag) already
  answered. A `--out` passed on the CLI is already answered — do not ask for it.
- **Skipped headless:** if `--json` was passed or the skill is running
  non-interactively, skip the round entirely and proceed on the inputs as given.

The answers feed Phase 5 (slug/out) and Phase 8 (brief).

## Phase 5: Honor-or-compute the out path

- If a `--out` override exists (from the CLI or the answer round), **honor and
  validate** it via `validate-out` — it derives + confirms the
  `docs/specs/YYYY-MM-DD-<slug>-spec.md` slug:

  ```bash
  node --experimental-strip-types "$TOOLS/write_spec_land.ts" validate-out --out "$out" --json
  ```

- Otherwise compute the default: resolve the slug from the topic, then build
  the path with today's date:

  ```bash
  slug=$(node --experimental-strip-types "$TOOLS/write_spec_land.ts" resolve-slug --topic "$topic")
  out="docs/specs/$(date +%F)-${slug}-spec.md"
  ```

The default path is computed **only** when no `--out` override exists.

## Phase 6: Dry-run branch

If `--dry-run` was passed: skip `prepare-branch` (Phase 7) and skip `publish`
(Phase 10). Dispatch with `--dry-run` (Phase 9) and emit the planned dispatch,
then stop.

## Phase 7: Prepare the branch (non-dry only)

For a real run, adopt-or-create the working branch **before** dispatch (never
the default branch, ff-only, never force):

```bash
branch="write-spec/${slug}"
node --experimental-strip-types "$TOOLS/write_spec_land.ts" prepare-branch --branch "$branch" --json
```

## Phase 8: Assemble the intent brief to scratchpad

Write the assembled intent (source contents + distilled chat context + the
Phase 4 answers) to a scratchpad **file** — the dispatcher consumes the file's
*contents* as the concrete intent:

```bash
brief_path="$(mktemp -t write-spec-brief.XXXXXX).md"
# …write the assembled brief markdown to "$brief_path"…
```

## Phase 9: Dispatch invocation contract

Run the dispatcher capturing **both** stdout (to a scratch receipt file) **and**
its exit code, **without aborting** — the dispatcher exits non-zero on handled
terminal verdicts (e.g. `max_rounds_unsatisfied`), and those are not skill
errors:

```bash
receipt_path="$(mktemp -t write-spec-receipt.XXXXXX).json"
dry_flag=()
[ -n "$dry_run" ] && dry_flag=(--dry-run)
node --experimental-strip-types "$TOOLS/write_spec.ts" \
    --intent-brief "$brief_path" \
    --out "$out" \
    ${lead:+--lead "$lead"} ${wing:+--wing "$wing"} \
    ${lead_model:+--lead-model "$lead_model"} ${wing_model:+--wing-model "$wing_model"} \
    ${max_rounds:+--max-rounds "$max_rounds"} \
    "${dry_flag[@]}" \
    --json > "$receipt_path"; RC=$?
```

Then parse `$receipt_path` and branch on `(RC, parseable receipt)`:

- **`RC == 0`** → `final_verdict == "contract_satisfied"`. Proceed to publish.
- **`RC != 0` + a parseable receipt** whose `final_verdict` is a **handled
  breaker** (`max_rounds_unsatisfied`, `lead_empty_draft`, `unchanged_revision`,
  `wing_unparseable`) → route into **gap resolution (Task 5-3)** — the receipt's
  `contract_status` names the unsatisfied sections. *(Task 5-3 may not exist
  yet; reference it as the downstream handler.)* Still publish the partial spec
  so the unsatisfied contract lands on a PR for the operator.
- **`RC != 0` + an unparseable receipt** → **hard error.** Report the dispatcher
  failure verbatim and stop.

The single scratch receipt file is the one artifact threaded to both publish
(Phase 10) and Task 5-3.

## Phase 10: Publish + summary (non-dry only)

Skip if `--dry-run` (Phase 6) or `--no-pr`. Otherwise publish, consuming the
**same** scratch receipt file from Phase 9:

```bash
ready_flag=()
[ -n "$open_ready" ] && ready_flag=(--ready)
node --experimental-strip-types "$TOOLS/write_spec_land.ts" publish \
    --repo "$REPO" \
    --branch "$branch" \
    --spec "$out" \
    --receipt "$receipt_path" \
    ${accepted_gaps:+--accepted-gaps "$accepted_gaps"} \
    ${lead:+--lead "$lead"} \
    "${ready_flag[@]}" \
    --json
```

`publish` adds/commits (repo identity) the spec, pushes (plain, never force),
adopts-or-creates the PR (App-authored), and merges only its owned body block.
`--ready` shells `gh pr ready` under the ambient user (App tokens cannot
un-draft). If Task 5-3 produced accepted gaps, thread them via
`--accepted-gaps`.

Then emit the skill summary (verdict, unsatisfied sections if any, PR link,
cost/rounds) — the terminal summary is owned by Task 5-3.

## Output Contract

| final_verdict | RC | Meaning |
|---------------|----|---------|
| `contract_satisfied` | 0 | Every required section satisfied. Spec passes. |
| `max_rounds_unsatisfied` | ≠0 | Bounded rounds exhausted with sections still unsatisfied → Task 5-3 gap resolution. |
| `lead_empty_draft` | ≠0 | Lead emitted an empty draft → Task 5-3. |
| `unchanged_revision` | ≠0 | A revision was byte-identical to the prior → Task 5-3. |
| `wing_unparseable` | ≠0 | The wing verdict never parsed → Task 5-3. |
| (dispatcher crash) | ≠0 | Unparseable receipt → hard error, reported verbatim. |

Handled breakers still land the partial spec on a PR; only an unparseable
receipt is a hard error.

## Notes

- **v1 agents: claude|codex only.** `gemini` (and any other value) is rejected
  at Phase 3 before any branch mutation, with
  `unsupported agent: gemini (claude|codex only at v1)`.
- **Draft-by-default.** An auto-opened PR is a draft unless `--ready`/`--no-draft`
  is passed; the merge path un-drafts via `gh pr ready`.
- **Scratch receipt is the single artifact.** The same `$receipt_path` file is
  captured in Phase 9 and passed to `publish --receipt` and to Task 5-3 — never
  re-run the dispatcher to regenerate it.
