# Implementation Plan — stark-write-spec (contract-bounded spec authoring)

## 1. Overview

Build **stage 0** of the spec pipeline: a thin skill (`skill/stark-write-spec/`) over a headless lead/wing TS dispatcher (`tools/write_spec.ts` + `write_spec_lib.ts`) plus a **skill-layer controller CLI** (`tools/write_spec_skill.ts`) that turns intent into a spec satisfying a fixed **Spec Contract**, then hands off to `/stark-review-spec`.

**Key architectural decisions (all from the spec):**
- **Mirror `plan_dispatch.ts`, don't extract** — two consumers don't justify a shared lib (rule of three; Open Question #1). The loop, dispatch primitives, and receipt shape are copied and adapted.
- **The wing verifies a closed checklist, never emits findings** — `normalizeContractVerdict` over 9 fixed section ids; unknown ids dropped by the parser. This is the structural anti-ratchet bound, so no growth breakers/coherence/analytics-grading are ported.
- **`contract.md` is the canonical SSOT** for the 9 section ids; the parser enum and prompts mirror it, bound by `test_contract_ids_match_asset`.
- **The verdict parser cannot reuse `extractVerdictJson` verbatim.** That helper only accepts a fenced object carrying a top-level `verdict` key (the approve/revise/block shape); write-spec emits `{items, done, summary}`. Phase 2 adds `extractContractVerdictJson` (an `items`-keyed variant) rather than mutating the shared parser, and a regression test locks the existing `plan_dispatch.ts` verdict parsing so the port cannot silently break it.
- **Token usage is parsed from the raw dispatch output, before text normalization.** `parseCodexJsonl`/`parseGeminiJson` discard token events, so cost cannot be recovered from their return value. Phase 3 pins raw-output usage parsers (`extractUsageFromRawCodex`, `extractUsageFromRawClaude`) that run on the raw stdout the `run` primitive returns, and defines the `DispatchUsage` shape before the loop consumes it.
- **A markdown skill cannot import TypeScript.** Every deterministic skill-layer helper (`resolveSpecPaths` exposure, `prepareBranch`, `landSpec`, `resolveGaps`, `runSkillDryRun`, brief assembly) is exposed through a controller CLI `tools/write_spec_skill.ts` with explicit subcommands + JSON stdin/stdout contracts; `SKILL.md` invokes those `node --experimental-strip-types` commands and uses `AskUserQuestion` itself for the interactive steps. **The path/slug/branch triple is exposed to the markdown layer via a dedicated `resolve-paths` subcommand** — the skill computes it once, up front, and threads the identical slug/specPath/branch into build-brief, prepare-branch, the dispatcher, and landing.
- **Every terminal verdict is routed.** `contract_satisfied` lands; `max_rounds_unsatisfied` enters interactive gap resolution; `lead_empty_draft`/`unchanged_revision`/`wing_unparseable` (and a failed Answer redispatch that returns a failure verdict) commit any written spec for inspection, open **no PR**, and exit non-zero. Named tests cover each route.
- **Every non-crash exit writes the spec file and the receipt** — no exception. Even a first-round `lead_empty_draft` writes the (possibly empty) current draft to `specPath`, per the spec's uniform "every non-crash exit still writes the spec file and the receipt" contract.
- **GitHub App auth uses the repo's real signature.** `getToken({ app, owner })` (object arg), `prCreate(..., { app: leadApp })`; `leadApp: AppName` is a declared field of `LandDeps`/`GapContext`/`prepareBranch`, threaded through every lookup/fetch/edit/create — including **remote branch adoption**, which must authenticate with the lead App token.
- **The host owns the slug end to end.** The sanitized slug is host-computed once (`resolveSpecPaths`, surfaced via `resolve-paths`) and threaded to the dispatcher via an explicit `--slug` flag; the dispatcher never parses Markdown to recover it.
- **Branch is created/adopted before the spec is written**, so a rerun on an existing slug can adopt the branch and commit the regenerated spec on top.
- **PR bodies are host-rendered from a `LandingSummary`.** The contract-status table, per-round summary, accepted gaps, and redispatch-incomplete flag are assembled by the controller from the receipt and threaded into `landSpec` as an explicit `summary` opt, consumed identically by both `prCreate` (new PR) and `editPrBody` (adopted PR).
- **Interactive vs headless is an explicit, user-facing state.** The dispatcher's internal `--json` (always passed by SKILL.md so the receipt is machine-parseable) does **not** imply headless. The skill threads the *user's* `--json` intent to `resolve-gaps` via an explicit `--headless` flag; interactive runs ask, headless runs auto-accept and set `auto_accepted_gaps:true`.

**Phases (5):** (1) contract asset + config + slug/path scaffolding; (2) verdict parser (with the `items`-keyed extractor + plan-dispatch regression) + host recompute logic; (3) raw-usage parsers + the lead/wing dispatch loop + prompt assembly + receipt + cost + incremental persistence; (4) the skill controller CLI + `SKILL.md` (path resolution, brief assembly, gap-fill, branch-first landing, dry-run, full terminal routing, App-authed landing, host-rendered PR bodies); (5) docs + ADR + live e2e.

## 2. Prerequisites

- Read `tools/plan_dispatch.ts` and `tools/copilot_dispatch.ts` end to end — this plan mirrors them; the exact import set is spec'd in SSOT & Dependencies.
- **Inspect `extractVerdictJson` in `tools/copilot_dispatch.ts`** and record its acceptance predicate. It is expected to return only fenced objects containing a top-level `verdict` key. Confirm this; the confirmation drives Phase 2 Task 1's decision to add `extractContractVerdictJson` (an `items`-keyed sibling) rather than call `extractVerdictJson`. If it turns out to already accept an `items`-keyed object, Phase 2 Task 1 collapses to "reuse it" and the regression test still guards plan-dispatch.
- **Inspect the raw-output shape of each dispatch path** before Phase 3:
  - Codex: run one real `run(...)` codex dispatch and capture its raw stdout JSONL. Record which JSONL event carries token usage (expected: a `token_count` / `usage` event with `input_tokens`/`output_tokens`, distinct from the message/text events `parseCodexJsonl` normalizes). Save a real captured line as the fixture for `test_extract_usage_codex_envelope`.
  - Claude: run one real headless `claude -p` dispatch and capture its raw stdout. Record the final `result` object's `usage.input_tokens` / `usage.output_tokens` path. Save the real envelope as the fixture for `test_extract_usage_claude_envelope`.
  - These two captured envelopes are the fixtures Phase 3 Task 4 tests against — no synthesized shapes.
- Confirm the exports the spec claims already exist: `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs` in `stark_review_doc_lib.ts`; `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `shouldFallbackToApiKey`, `releaseAgentTempDir`, `parseCodexJsonl`, `parseGeminiJson`, `extractVerdictJson`, `isPlainObject`, `VALID_AGENTS`, `AgentName`, `resolveModel`, `isAgentEnabled` in `copilot_dispatch.ts`; `sanitizeSlug` in `stark_handover_lib.ts`; `computeDispatchCost` in `cost_lib.ts`; `prCreate`, `getToken`, `AppName` in `github_app_lib.ts`. Command:

  ```
  node --experimental-strip-types -e '
    import("./tools/copilot_dispatch.ts").then(m => console.log("copilot missing:",
      ["run","buildAgentEnv","setupGeminiHome","makeGeminiEnv","tryGeminiApiKeyFallback",
       "shouldFallbackToApiKey","releaseAgentTempDir","parseCodexJsonl","parseGeminiJson",
       "extractVerdictJson","isPlainObject","resolveModel","isAgentEnabled","VALID_AGENTS"]
      .filter(k => !(k in m))));'
  ```
  and the analogous one-liners for the other four modules. Any name printed as *missing* becomes a small first-class "add the export" task in the phase that consumes it (never re-implement).

- **Confirm the `getToken` signature** in `github_app_lib.ts` is the object form `getToken({ app, owner }): Promise<string>` and that `AppName` is the exported union used by `prCreate`. Confirm `prCreate` accepts `{ app: AppName, draft?: boolean, ... }`. Record the exact `owner` value source (repo remote). Phase 4 Tasks 1/5/6 depend on these exact shapes.
- **Confirm the `getToken` → `gh` env pattern** in `tools/runtime_env_lib.ts`: it imports `getToken` directly and injects the minted token as `GH_TOKEN` into a subprocess env. Pin the env-var name (`GH_TOKEN`) before Phase 4 Tasks 1/6.
- **Map lead agent → App name** once, from the repo's existing convention: `claude`→`stark-claude`, `codex`→`stark-codex` (the `AppName` values in `github_app_lib.ts`'s `APPS` map). This mapping (`leadAppFor(agent): AppName`) is used by `prepare-branch`, `route`, `resolve-gaps`, and `landSpec`.

**Parallelizable with Phase 1:** authoring `global/prompts/write-spec/{claude,codex}/{generate,verify,revise}.md` (Phase 3 owns them but they have no code dependency).

## 2.5 Global Constraints

- **Language:** TypeScript only, run via `node --experimental-strip-types`. No new Python.
- **Node runtime:** built-ins style (`node:*`) — no npm deps added.
- **Asset resolution:** all prompt + history paths through `assetPromptsDir()` / `stateRoot()` — **never** hardcode `~/.claude/code-review`.
- **Models:** resolve via `resolveModel()`/`getModelId()` — never hardcode model ids.
- **Config defaults (verbatim):** `lead_agent: "claude"`, `wing_agent: "codex"`, `wing_reasoning_effort: "xhigh"`, `max_rounds: 3`, `timeout_s: 900`, `wing_timeout_s: 600`, `max_input_chars: 200000`, `history_keep_runs: 20`, `open_pr: true`.
- **The 9 contract section ids (verbatim):** `intent`, `scope`, `interfaces`, `behavior`, `ssot`, `security`, `test-plan`, `accessibility`, `open-questions`.
- **Status enum (verbatim):** `satisfied | underspecified | missing | over_scoped | n_a`.
- **`final_verdict` enum (verbatim):** `contract_satisfied | max_rounds_unsatisfied | lead_empty_draft | unchanged_revision | wing_unparseable`.
- **Every non-crash exit writes `specPath` + `receipt.json`.** No verdict is exempt; `lead_empty_draft` writes the current draft even when it is empty/whitespace.
- **Draft-by-default:** `prCreate` with `draft ?? true`; `--ready` opts out, `--no-pr` skips.
- **GitHub App auth (verbatim):** `getToken({ app: leadApp, owner })`, `prCreate(..., { app: leadApp })`; `leadApp: AppName` derived from the lead agent via `leadAppFor` (`claude`→`stark-claude`, `codex`→`stark-codex`). `leadApp` is threaded into **every** authenticated git/gh call, including `prepareBranch`'s remote lookup/fetch.
- **Slug is host-owned:** computed once by `resolveSpecPaths` (Phase 1), surfaced to the markdown layer via `resolve-paths`, passed to the dispatcher as an explicit `--slug` flag and to landing helpers as an argument. The dispatcher never derives the slug from the brief or the out path, and the model never influences it.
- **Branch:** `write-spec/<slug>`; out path `docs/specs/YYYY-MM-DD-<topic>-spec.md`, **host-computed** from sanitized slug. Never force-push.
- **Staging scope:** git commits stage an **exact, explicitly-named file list** via `git add -- <path...>` — never `git add .`/`-A`. The only in-repo generated file is the spec at `specPath`; the run record lives under `stateRoot()` and is never staged.
- **Interactive vs headless is explicit:** the dispatcher's internal `--json` never implies headless. The skill threads the user's `--json` intent to `resolve-gaps` as `--headless`.
- **Every skill:** `## Help` block referencing `standards/help.md`.
- **`gemini` is rejected at argument validation in all three layers** (skill, controller CLI, dispatcher) until gemini prompts ship; dispatcher core stays agent-generic via `VALID_AGENTS`.

## 3. Phases

## Phase 1: Contract asset, config section, path/slug scaffolding
**Goal:** The fixed-and-known ground the rest builds on — the contract prompt asset, the `write_spec` config section, and host-computed path/slug helpers — with the id list defined in exactly one place.
**Dependencies:** none
**Estimated effort:** M

### Tasks

1. **Author `global/prompts/write-spec/contract.md`**
   - What: encode the Spec Contract — the 9 sections, each with its **done-when bar** and a short **review lens** distilled from the corresponding `spec-review` domain prompt (bounded checklist, not open-ended hunt). Mark it the canonical SSOT of the section-id list. Include the `n_a`-with-reason rule and the Scope-declaration anti-inflation note.
   - **Canonical id-extraction format (decided here, consumed by Phase 2 Task 3):** each section is an H2 heading of the exact form `## <id> — <Title>` where `<id>` is one of the 9 verbatim ids. The machine-readable list is the ordered sequence of the `<id>` tokens. No other H2 headings appear in the file (sub-content uses H3+). `extractContractIds(md)` matches `/^## ([a-z-]+) — /gm`.
   - Files: `global/prompts/write-spec/contract.md`
   - Interfaces — **Produces:** the canonical ordered section-id list (`intent, scope, interfaces, behavior, ssot, security, test-plan, accessibility, open-questions`) as `## <id> — <Title>` H2 headings that `extractContractIds` parses.
   - Acceptance: the 9 ids appear exactly once each as `## <id> — ...` headings, in order; each has a done-when bar + review lens as body text; the file states config cannot override it.

2. **Add `write_spec` config section to `stark_config_lib.ts`**
   - What: `DEFAULT_WRITE_SPEC` with the verbatim defaults from Global Constraints; `getWriteSpecConfig()` following the existing section-accessor + deep-merge pattern. **No locked-fields machinery.**
   - Files: `tools/stark_config_lib.ts`
   - Interfaces — **Consumes:** existing `DEFAULT_*` + section-accessor pattern, deep-merge. **Produces:** `DEFAULT_WRITE_SPEC`, `getWriteSpecConfig(): WriteSpecConfig`, `WriteSpecConfig` type.
   - Test: `test_write_spec_config_defaults` — accessor returns defaults with no config file; a partial override deep-merges (e.g. `max_rounds: 2` overrides, other keys retain defaults).
   - Acceptance: defaults match the spec verbatim; override merges; no key can inject a contract change.

3. **Host-computed out-path + slug + branch helpers**
   - What: derive `<slug>` via `sanitizeSlug`, out path `docs/specs/<today>-<slug>-spec.md`, branch `write-spec/<slug>`. Date is host-supplied (`new Date()` at the CLI entry, passed down — keep lib pure/injectable). **The slug is derived from `topic` regardless of `--out`** — an `--out` override sets only `specPath`; `slug` and `branch` always come from `sanitizeSlug(topic)`. Also add `leadAppFor(agent: AgentName): AppName` here (the single owner of the agent→App mapping) so every landing/branch helper consumes it rather than re-deriving.
   - Files: `tools/write_spec_lib.ts` (new)
   - Interfaces — **Consumes:** `sanitizeSlug` from `stark_handover_lib.ts`; `AppName`, `AgentName`. **Produces:** `resolveSpecPaths(topic: string, today: string, outOverride?: string): { slug, specPath, branch }` — `today` is `YYYY-MM-DD`; `leadAppFor(agent): AppName`.
   - Test: `test_out_path_host_computed` — a topic with unsafe chars yields a sanitized slug, dated path `docs/specs/2026-07-20-<slug>-spec.md`, and `write-spec/<slug>` branch; `--out` override sets the path but slug/branch stay sanitized-from-topic. `test_lead_app_mapping` — `leadAppFor("claude")==="stark-claude"`, `leadAppFor("codex")==="stark-codex"`.
   - Acceptance: model never influences the path; slug is deterministic and identical whether or not `--out` is passed; agent→App mapping has one owner.

### Risks
- **contract.md id extraction is brittle** (a heading rename silently drops a section): mitigation — the `## <id> — Title` format is simple and explicit, and `test_contract_ids_match_asset` (Phase 2) fails the build on drift.

### Verification
```
npm --prefix tools test -- write_spec_lib.test.ts
grep -nE '^## [a-z-]+ — ' global/prompts/write-spec/contract.md
```
Expect `test_write_spec_config_defaults` + `test_out_path_host_computed` + `test_lead_app_mapping` green, and exactly 9 heading lines in the verbatim order.

## Phase 2: Verdict parser + host-side done recomputation (the risk core)
**Goal:** The structural anti-ratchet: extract the `items`-keyed wing JSON (without breaking the existing `verdict`-keyed parser), drop unknown ids, fail closed on partial/lazy verdicts, recompute `done` over the full 9-id set. Pure functions, TDD.
**Dependencies:** Phase 1 (contract id list)
**Estimated effort:** M

### Tasks

1. **`extractContractVerdictJson` — the `items`-keyed fence extractor + plan-dispatch regression**
   - What: the existing `extractVerdictJson` only returns a fenced object carrying a top-level `verdict` key (confirmed in Prerequisites), so it rejects write-spec's `{items, done, summary}` — every valid wing response would become `wing_unparseable`. Add a **sibling** extractor rather than mutating the shared one:
     - `extractContractVerdictJson(raw: string): unknown | null` — scans fenced ```` ```json ```` blocks (falling back to the last balanced `{...}` object, mirroring `extractVerdictJson`'s scan strategy exactly), and returns the first parsed object for which `isPlainObject(obj) && Array.isArray(obj.items)`. Returns `null` when none matches.
   - The `verdict`-vs-`items` predicate is the only difference from `extractVerdictJson`; keep the scanning/parsing logic identical by factoring the shared scan into a local `scanFencedObjects(raw): unknown[]` helper used by the new function (do **not** touch `copilot_dispatch.ts`; if a shared scan helper isn't exported there, replicate it locally in `write_spec_lib.ts` — no cross-module refactor).
   - **Regression guard:** `test_plan_dispatch_verdict_parsing_preserved` — import `extractVerdictJson` from `copilot_dispatch.ts` and assert, against a captured real plan-dispatch wing response fixture, that it still returns the `{verdict, blocking_findings, ...}` object unchanged. This test fails if anyone later "generalizes" the shared parser and breaks plan-dispatch. It is added here even though this phase does not modify `copilot_dispatch.ts` — it locks the boundary the port must not cross.
   - Files: `tools/write_spec_lib.ts` (`extractContractVerdictJson`, `scanFencedObjects`), `tools/write_spec_lib.test.ts`
   - Interfaces — **Consumes:** `isPlainObject` (from `copilot_dispatch.ts`), `extractVerdictJson` (regression test only). **Produces:** `extractContractVerdictJson`.
   - Test: `test_extract_contract_verdict_from_fence` — an `{items,...}` object in a json fence is returned; a `{verdict,...}` object (no `items`) returns `null`; prose-only returns `null`. Plus `test_plan_dispatch_verdict_parsing_preserved`.
   - Acceptance: write-spec verdicts parse; plan-dispatch parsing provably unchanged.

2. **`normalizeContractVerdict` + `recomputeDone`**
   - What: given raw text, call `extractContractVerdictJson`; if `null` → throw `ContractVerdictUnparseable` (the loop catches it for the retry/terminate path). Otherwise for each item keep only ids in the canonical 9, record dropped ids; coerce unknown `status` → `underspecified`; a known id **absent** from `items` → `missing`; an `n_a` with empty/absent reason → `underspecified`. `done` = every one of the 9 is `satisfied | n_a`, recomputed by the host — never trusted from the wing.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `extractContractVerdictJson`, the canonical id list (Phase 1). **Produces:** `normalizeContractVerdict(raw: string, contractIds: string[]): ContractVerdict`; types `ContractItem = { section: string, status: ContractStatus, note: string }`, `ContractStatus = "satisfied"|"underspecified"|"missing"|"over_scoped"|"n_a"`, `ContractVerdict = { items: ContractItem[], done: boolean, summary: string, dropped: string[] }`, `ContractVerdictUnparseable` (Error subclass).
   - Test: `test_parser_drops_unknown_sections`, `test_status_enum_rejects_unknown`, `test_done_recomputed_from_items`, `test_partial_verdict_fails_closed`. Key assertion: no input can produce a false `done:true`.
   - Acceptance: all tests green; `dropped[]` populated; done recomputed.

3. **`revisePayloadFromVerdict` (non-satisfied selection + over_scoped cut semantics)**
   - What: given a normalized verdict, produce the sections the lead must revise: every item not `satisfied | n_a`; `over_scoped` items carry **cut** intent, all others **fill** intent, each with its `note`.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `ContractVerdict`. **Produces:** `revisePayloadFromVerdict(v: ContractVerdict): { section: string, action: "fill"|"cut", note: string }[]`.
   - Test: `test_over_scoped_routes_to_revise` — `over_scoped` → `action:"cut"`; `underspecified`/`missing` → `action:"fill"`; `satisfied`/`n_a` excluded.
   - Acceptance: cut vs fill correctly routed.

4. **`extractContractIds` + `test_contract_ids_match_asset` binding test**
   - What: `extractContractIds(md: string): string[]` matches `/^## ([a-z-]+) — /gm` against `contract.md` (read via `assetPromptsDir()`), returns the ordered ids. The parser's canonical enum is a single exported `const CONTRACT_IDS`; the test asserts `extractContractIds(read(contract.md))` deep-equals `CONTRACT_IDS`.
   - Files: `tools/write_spec_lib.ts` (`extractContractIds`, `CONTRACT_IDS`), `tools/write_spec_lib.test.ts`
   - Interfaces — **Consumes:** `assetPromptsDir` from `asset_root_lib.ts`. **Produces:** `extractContractIds`, `CONTRACT_IDS`.
   - Acceptance: passes now; a deliberate rename in either the asset or `CONTRACT_IDS` fails it.

### Risks
- **A "lazy" wing verdict faking done:** mitigated by construction — `done` is host-recomputed; `test_partial_verdict_fails_closed` locks it.
- **A future "generalize the shared parser" refactor breaks plan-dispatch:** mitigated by `test_plan_dispatch_verdict_parsing_preserved`.

### Verification
```
npm --prefix tools test -- write_spec_lib.test.ts
```
Expect green: `test_extract_contract_verdict_from_fence`, `test_plan_dispatch_verdict_parsing_preserved`, `test_parser_drops_unknown_sections`, `test_status_enum_rejects_unknown`, `test_done_recomputed_from_items`, `test_partial_verdict_fails_closed`, `test_over_scoped_routes_to_revise`, `test_contract_ids_match_asset`.

## Phase 3: Raw-usage parsers, prompt assembly, lead/wing dispatch loop, receipt, cost, incremental persistence
**Goal:** The headless dispatcher — usage parsing pinned to the raw envelopes, prompt construction, draft→verify→revise loop with early exit, all termination paths (every non-crash exit writing spec + receipt), token-cost aggregation, receipt emission, and per-round crash-proof history. Takes an explicit `--slug` + `--out`. Mirrors `plan_dispatch.ts`.
**Dependencies:** Phases 1–2
**Estimated effort:** L

### Tasks

1. **Author the 6 prompt files** (parallelizable, started in Phase 2's prerequisites)
   - What: `{claude,codex}/generate.md` (draft against `contract.md`), `verify.md` (contract check → verdict JSON, **never a review**), `revise.md` (revise non-satisfied sections only; carries the #677 playground-scope discipline block + "an unknown you cannot resolve goes under Open Questions — never invent an answer"). `generate.md` additionally instructs: **"any items under `## Pre-dispatch open questions` in the intent brief are unresolved unknowns — seed them verbatim into the spec's Open Questions section; do not invent answers."**
   - Files: `global/prompts/write-spec/{claude,codex}/{generate,verify,revise}.md`
   - Interfaces — **Produces:** three prompt templates per agent with literal `{{TOKEN}}` placeholders — generate: `{{CONTRACT}}`, `{{INTENT_BRIEF}}`; verify: `{{CONTRACT}}`, `{{SPEC_DRAFT}}`; revise: `{{CONTRACT}}`, `{{PRIOR_DRAFT}}`, `{{REVISE_ITEMS}}`.
   - Acceptance: verify prompt emits the exact `{items,done,summary}` schema fenced as ```` ```json ````; revise prompt receives only non-satisfied items; generate prompt routes pre-dispatch unknowns to Open Questions.

2. **Raw-output usage parsers + `DispatchUsage` (pinned before text normalization)**
   - What: the shared `run(...)` primitive returns raw subprocess stdout; `parseCodexJsonl`/`parseGeminiJson` normalize it to text and discard token events. Add usage parsers that operate on the **raw stdout string**, using the real envelopes captured in Prerequisites:
     - `extractUsageFromRawCodex(rawStdout: string): { input_tokens: number, output_tokens: number } | null` — scans the JSONL lines for the token/usage event recorded in Prerequisites (e.g. `type: "token_count"` or a `usage` field), returns its `input_tokens`/`output_tokens`; `null` when absent.
     - `extractUsageFromRawClaude(rawStdout: string): { input_tokens: number, output_tokens: number } | null` — parses the final `result` object and reads `usage.input_tokens`/`usage.output_tokens`; `null` when absent.
     - `extractUsage(agent: AgentName, rawStdout: string, model: string): DispatchUsage` — dispatches to the per-agent parser; on `null` returns `{ input_tokens: 0, output_tokens: 0, model, missing: true }`.
   - `DispatchUsage = { input_tokens: number, output_tokens: number, model: string, missing?: boolean }`. Each dispatch in the loop captures the raw stdout, computes text via the existing normalizer **and** usage via `extractUsage` — the two are parsed from the same raw string independently, so normalization discarding token events is irrelevant.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** the raw stdout returned by `run(...)`; `AgentName`. **Produces:** `DispatchUsage`, `extractUsageFromRawCodex`, `extractUsageFromRawClaude`, `extractUsage`.
   - Test: `test_extract_usage_codex_envelope` — the captured real codex JSONL fixture yields the recorded token counts; `test_extract_usage_claude_envelope` — the captured real claude `result` fixture yields its counts; `test_extract_usage_missing` — stdout with no usage event → zeros + `missing:true`.
   - Acceptance: usage is recoverable from the raw envelope for both real formats; a missing event degrades to a zero floor, never a crash.

3. **Prompt-construction interfaces (host-side assembly)**
   - What: the host reads every asset (via `assetPromptsDir()`) and assembles the exact stdin each agent receives:
     - `loadWriteSpecPrompts(leadAgent, wingAgent)` reads `contract.md`, `<leadAgent>/{generate,revise}.md`, `<wingAgent>/verify.md`. Returns `{ contract, generate, revise, verify }`.
     - `buildLeadInput(kind, prompts, brief, opts)`: `kind:"generate"` → substitute `{{CONTRACT}}`, `{{INTENT_BRIEF}}`; `kind:"revise"` → substitute `{{CONTRACT}}`, `{{PRIOR_DRAFT}}` (prior full document), `{{REVISE_ITEMS}}` = `renderRevisePayload(revisePayloadFromVerdict(verdict))` (one bullet per non-satisfied item: `- **<section>** (<action>): <note>`).
     - `buildWingInput(prompts, draft)` → substitute `{{CONTRACT}}`, `{{SPEC_DRAFT}}`.
     - `withFormatReminder(input)` → append a fixed trailer instructing a JSON-only fenced verdict; used exactly once on the malformed-verdict retry.
   - Substitution is literal `{{TOKEN}}` replace; a template missing a required token throws (config/asset error, not a run failure).
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `assetPromptsDir`, `revisePayloadFromVerdict`. **Produces:** `loadWriteSpecPrompts`, `buildLeadInput`, `buildWingInput`, `withFormatReminder`, `renderRevisePayload`.
   - Test: `test_prompt_assembly` — generate input contains full contract + brief and no unresolved `{{`; revise input contains only non-satisfied sections; `withFormatReminder` appends once. `test_prompt_missing_token_throws`.
   - Acceptance: each agent's exact input is reproducible from (assets, brief, prior draft, verdict).

4. **Argument validation + agent guard + explicit `--slug`/`--out`**
   - What: parse `--intent-brief --out --slug --lead --wing --lead-model --wing-model --max-rounds --timeout --wing-timeout --json --dry-run`. **`--intent-brief`, `--out`, `--slug` all required** (`--dry-run` still requires all three to plan). The dispatcher never parses the brief or out path to recover the slug. Reject `gemini` for `--lead`/`--wing` with a clear error (core stays generic via `VALID_AGENTS`; only the guard blocks it).
   - Files: `tools/write_spec.ts` (new CLI)
   - Interfaces — **Consumes:** `VALID_AGENTS`, `AgentName`, `isAgentEnabled`; `getWriteSpecConfig`, `resolveModel`/`getModelId`. **Produces:** `WriteSpecCliArgs = { intentBrief, out, slug, lead, wing, leadModel?, wingModel?, maxRounds, timeout, wingTimeout, json, dryRun }`.
   - Test: `test_reject_gemini_agent` — `--lead gemini` nonzero + `unsupported agent: gemini (claude|codex only)`; `test_dispatcher_requires_slug` — no `--slug` → nonzero + `--slug is required`; `test_reject_unknown_flag`.
   - Acceptance: advertised CLI matches what resolves; slug is a typed host contract.

5. **The loop core**
   - What: round 1..N — lead dispatch (`buildLeadInput("generate")` round 1, `buildLeadInput("revise", ...)` after) → wing dispatch (`buildWingInput`) → `normalizeContractVerdict` → `recomputeDone`. Early exit on `done` → `contract_satisfied`. `ContractVerdictUnparseable` (or `extractContractVerdictJson` null) → **one** retry with `withFormatReminder(buildWingInput(...))` → else `wing_unparseable`. Detect `lead_empty_draft` (lead whitespace-only) and `unchanged_revision` (byte-identical to prior draft). Exhaust rounds → `max_rounds_unsatisfied`.
   - **Uniform write-on-every-non-crash-exit (finding #7):** the loop tracks `lastDraft: string` (the most recent lead output, defaulting to `""`). On **every** terminal verdict the host writes `lastDraft` to `--out` before returning — **including first-round `lead_empty_draft`, where `lastDraft` is the empty/whitespace string the lead produced.** There is no "skip the write when the draft is empty" branch; the receipt's `spec_path` is always populated and the file always exists (possibly empty). This makes the dispatcher's exit contract match the spec's "every non-crash exit still writes the spec file and the receipt" verbatim.
   - Files: `tools/write_spec_lib.ts`, `tools/write_spec.ts`
   - Interfaces — **Consumes:** `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `shouldFallbackToApiKey`, `releaseAgentTempDir`, `parseCodexJsonl`, `parseGeminiJson`, `resolveModel`, `isAgentEnabled`, `VALID_AGENTS`, `AgentName`; Task 2's usage parsers; Task 3's assembly; Phase 2's parser. **Produces:** `runWriteSpec(opts: WriteSpecCliArgs, deps): Promise<WriteSpecReceipt>` (deps carries injectable `dispatch` returning `{ text, rawStdout }` for tests) + the receipt shape.
   - Test: `test_early_exit_single_pass` (clean draft → 1 lead + 1 wing call, `contract_satisfied`); `test_termination_max_rounds`, `test_termination_empty_draft`, `test_termination_unchanged_revision`, `test_termination_wing_unparseable` — each yields the right `final_verdict`, nonzero exit, and **spec + receipt on disk in every case**; `test_empty_draft_still_writes_spec` — a first-round whitespace-only lead output produces an on-disk `specPath` (empty file) plus receipt, `final_verdict:"lead_empty_draft"`. Injected `dispatch` returns canned strings — no real LLM in unit tests.
   - Acceptance: all termination paths produce the correct verdict; early exit costs one verify pass; **no exit path skips the spec write.**

6. **Per-dispatch cost aggregation**
   - What: the loop appends **every** dispatch's `DispatchUsage` (lead + wing + the one retry) to a run-level `usages: DispatchUsage[]`. `accumulateCost(usages) = Σ computeDispatchCost(u.model, u.input_tokens, u.output_tokens)`; `cost_usd = accumulateCost(usages)`. A `missing:true` usage contributes 0 and pushes `usage_missing:<agent>:<round>` into `cost_notes[]`.
   - Files: `tools/write_spec_lib.ts`
   - Interfaces — **Consumes:** `computeDispatchCost` (cost_lib), `DispatchUsage`. **Produces:** `accumulateCost`.
   - Test: `test_cost_aggregates_all_dispatches` — a 2-round run with a retry accumulates 5 usages; `cost_usd` equals the sum over all five; a missing-usage dispatch contributes 0 + a `cost_notes` entry.
   - Acceptance: `cost_usd` reproducible from `usages[]`; no dispatch double-counted or dropped.

7. **Receipt + incremental per-round persistence (incl. structured brief)**
   - What: emit the single stdout JSON receipt (`ok`, `final_verdict`, `spec_path`, `slug`, `run_id`, `rounds[]`, `contract_status[]`, `dropped_sections[]`, `models{}`, `cost_usd`, `cost_notes[]`, `pr`, `persistence_errors[]`, `history_dir`). `slug` echoed from `--slug`; `ok = final_verdict === "contract_satisfied"`. Write history under `stateRoot()/history/write-spec/<slug>/<run-id>/` — `receipt.json` + `rounds.json` **after every round** (atomic via `writeJsonAtomic`), plus `brief.md` copied in at dispatch start, `latest` pointer via `updateLatestPointer`, `history_keep_runs` retention via `pruneRunDirs`. `run_id` host-generated at CLI entry (`<today>-<hh-mm-ss>-<4hex>`, injected). The receipt also carries `history_dir` (the absolute run dir) so downstream tooling never re-derives the layout.
   - **Structured brief persistence (finding #5):** in addition to the rendered `brief.md`, the dispatcher also writes **`brief.json`** — the `BriefSections` object supplied by the skill (threaded via a new `--sections PATH` dispatcher flag; the skill's `build-brief` already produced it) — into the run dir at dispatch start. This makes the *structured* brief part of the reproducible run record, so the Answer-path redispatch (Phase 4 Task 5) can reconstruct `BriefSections`, append operator answers to `conversationContext`, and re-render — instead of trying to enrich the flat `brief.md`. `--sections` is optional for the raw dispatcher (a direct CLI dispatch without a skill may omit it; then only `brief.md` is written and `brief.json` is absent), required in practice from the skill path.
   - `--dry-run` writes **no run record.**
   - Files: `tools/write_spec_lib.ts`, `tools/write_spec.ts`
   - Interfaces — **Consumes:** `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs`; `stateRoot`; Task 6's cost. **Produces:** `WriteSpecReceipt` type (incl. `history_dir`), `persistRound(runDir, roundState)`, `persistBriefJson(runDir, sections)`.
   - Test: `test_receipt_incremental_persistence` — receipt/rounds present after a simulated round-2 crash (injected dispatch throws round 3); history-write failure surfaces in `persistence_errors`, never fatal. `test_brief_json_persisted` — a run given `--sections` writes `brief.json` deep-equal to the input sections. `test_dry_run_no_history`.
   - Acceptance: crash mid-run leaves a partial but valid record; every non-crash exit writes spec + receipt; `brief.json` reproduces the structured brief.

8. **Dispatcher `--dry-run` path**
   - What: resolve brief/config/models/prompts (`loadWriteSpecPrompts`), print the planned dispatch (resolved lead/wing agents+models, round budget, brief path, out path, slug), exit — no LLM, no writes outside scratchpad, no git, no run record.
   - Files: `tools/write_spec.ts`
   - Test: `test_dispatcher_dry_run` — zero agent calls (injected dispatch asserts never invoked), no history dir; stdout carries the planned-dispatch JSON with the echoed slug.
   - Acceptance: matches sibling dispatcher dry-run behavior.

### Risks
- **A claimed export from a sibling isn't actually exported:** Prerequisites verification catches it; add the export in a small first-class change.
- **Usage event shape differs from the captured fixture:** `extractUsage` isolates per-agent field access with a fallback-to-zero + `cost_notes` note, so a wrong assumption degrades cost accuracy, never crashes; the fixtures are real captures, not guesses.
- **An empty spec file confuses review-spec:** accepted — an empty `lead_empty_draft` file exits non-zero with a clear note; the skill never hands off to review-spec on a failure verdict, and the empty file is committed only for inspection (Phase 4 Task 5), never pushed/PR'd.

### Verification
```
npm --prefix tools test -- write_spec_lib.test.ts
```
Then a live smoke dispatch:
```
printf '## Ask\nAuthor a one-paragraph spec for a CLI that prints the current git branch.\n## Constraints\nSingle-user playground; TypeScript.\n## Target\nout=docs/specs/2026-07-20-branch-printer-spec.md slug=branch-printer\n' > /tmp/write-spec-smoke-brief.md
node --experimental-strip-types tools/write_spec.ts --intent-brief /tmp/write-spec-smoke-brief.md --out docs/specs/2026-07-20-branch-printer-spec.md --slug branch-printer --lead claude --wing codex --json
```
Expect stdout receipt `final_verdict: "contract_satisfied"` (or a bounded non-crash verdict), `spec_path` written, `slug: "branch-printer"`, `cost_usd > 0`, `history_dir` set, and that dir containing `receipt.json`, `rounds.json`, `brief.md`.

## Phase 4: Skill controller CLI + interactive layer — path resolution, brief, gap-fill, branch-first landing, full terminal routing
**Goal:** A **controller CLI** (`tools/write_spec_skill.ts`) exposing every deterministic skill-layer helper as a subcommand with a JSON contract — including host path resolution surfaced to the markdown layer, App-authed remote branch adoption, host-rendered PR bodies, and explicit interactive/headless state — plus the `SKILL.md` that orchestrates them and owns the interactive `AskUserQuestion` steps. Named proving tests target the pure helpers in `write_spec_lib.ts`; the CLI is a thin wrapper.
**Dependencies:** Phase 3
**Estimated effort:** L

### Tasks

1. **`tools/write_spec_skill.ts` — the controller CLI (the markdown↔TS seam)**
   - What: a subcommand CLI SKILL.md invokes via `node --experimental-strip-types tools/write_spec_skill.ts <sub>`. Each subcommand reads its input JSON from a `--input PATH` file (or explicit flags) and writes a single JSON object to stdout — the contract SKILL.md consumes. Subcommands:
     - **`resolve-paths --topic <t> --today <d> [--out <path>]`** → `{ slug, specPath, branch }` (finding #1). This is the **only** way the markdown layer obtains the host-computed path triple; every later subcommand + the dispatcher receive these exact values as arguments. Thin wrapper over `resolveSpecPaths`.
     - `build-brief --input <sections.json> --slug <slug> --out <specPath>` → writes `brief.md` **and** copies `sections.json` to the scratchpad as the canonical structured brief; returns `{ brief_path, sections_path, char_count, truncated: bool, pre_dispatch_unknowns: string[] }`. (`sections.json` carries the `BriefSections` fields the skill/Claude assembled, incl. distilled conversation context.) The `sections_path` is later threaded into the dispatcher as `--sections` and into `resolve-gaps` as `--sections`.
     - `prepare-branch --slug <slug> --lead <agent>` → `{ branch, adopted }` (finding #2). Computes `leadApp = leadAppFor(lead)`, and performs remote lookup/fetch using the **lead App token** via the `gitAuthEnv` askpass helper (see `prepareBranch` below — `GH_TOKEN` alone does not authenticate git). Rejects `gemini`.
     - `route --receipt <path> --slug <slug> --lead <agent> [--ready] [--no-pr]` → routes a **non-max-rounds** verdict (called for `contract_satisfied` and every failure verdict); computes `leadApp = leadAppFor(lead)`, builds the `LandingSummary` from the receipt, and returns `{ exit_code, final_verdict, pr, committed, pushed, note }`. `--ready`/`--no-pr` are **skill-layer** flags consumed here (they never reach the dispatcher).
     - `resolve-gaps --receipt <path> --slug <slug> --lead <agent> --choice <answer|accept|abort> [--answers <path>] [--sections <path>] [--headless] [--ready] [--no-pr]` → the max-rounds interactive resolution; returns `GapResult` JSON. `--headless` (finding #4) is set by the skill iff the *user* passed `--json`; it is independent of the dispatcher's internal `--json`. `--sections` (finding #5) points at the structured brief so the Answer path can enrich `conversationContext`.
     - `dry-run --input <sections.json> --slug <slug> --out <specPath> --lead <a> --wing <a>` → prints the assembled brief + resolved plan; mutates nothing.
   - Every subcommand rejects `gemini` for `--lead`/`--wing`. All are thin wrappers over `write_spec_lib.ts` pure functions (`resolveSpecPaths`, `truncateBrief`/`renderBrief`, `prepareBranch`, `routeOutcome`, `resolveGaps`, `runSkillDryRun`) with real `git`/`gh`/`getToken`/`prCreate` deps wired in.
   - Files: `tools/write_spec_skill.ts` (new)
   - Interfaces — **Consumes:** all Phase-4 `write_spec_lib.ts` helpers; `getToken`, `prCreate`, `leadAppFor`. **Produces:** the 6 subcommands' JSON contracts (documented verbatim in SKILL.md).
   - Test: `test_controller_resolve_paths_subcommand` — `resolve-paths --topic "Foo Bar!"` returns the sanitized slug/specPath/branch triple; `test_controller_route_subcommand` — `route` on a `contract_satisfied` receipt (injected fake deps) returns `exit_code:0` and a `pr` object; `test_controller_prepare_branch_lead_app` — `prepare-branch --lead codex` mints the token with `getToken({ app: "stark-codex", owner })` (recorded), never the default App; `test_controller_rejects_gemini` — any subcommand with `--lead gemini` exits nonzero.
   - Acceptance: SKILL.md never imports TS; the path triple, branch adoption, routing, and gap resolution are all documented CLI calls with JSON contracts; remote branch adoption authenticates with the lead App.

2. **`skill/stark-write-spec/SKILL.md` — frontmatter, Help, phase flow, exact invocations (full flag propagation + receipt plumbing)**
   - What: frontmatter (`name: stark-write-spec`); `## Help` block referencing `standards/help.md`; a preflight phase (`tools/preflight.ts`); the phase flow with the **exact controller invocations and full flag propagation** (finding #3). The skill parses the user CLI surface (`<path|"intent"> [--out] [--lead] [--wing] [--lead-model] [--wing-model] [--max-rounds] [--dry-run] [--ready] [--no-pr] [--json]`) and threads each flag to the layer that owns it:
     1. Classify positional + distill conversation context → write `sections.json`.
     2. `node … write_spec_skill.ts resolve-paths --topic <topic> --today <today> [--out <userOut>]` → capture `{slug, specPath, branch}`. (Topic derived per Task 3.)
     3. `AskUserQuestion` (≤4 load-bearing gaps) — SKILL.md's own tool call. **Skipped entirely when the user passed `--json`** (headless): pre-dispatch unknowns go straight into `sections.json`'s `preDispatchOpenQuestions`.
     4. `node … write_spec_skill.ts build-brief --input sections.json --slug <slug> --out <specPath>` → capture `brief_path` + `sections_path`.
     5. `node … write_spec_skill.ts prepare-branch --slug <slug> --lead <lead>` (branch before dispatch, App-authed).
     6. **Dispatcher invocation — every advertised option propagated:**
        ```
        node --experimental-strip-types tools/write_spec.ts \
          --intent-brief <brief_path> --out <specPath> --slug <slug> --sections <sections_path> \
          --lead <lead> --wing <wing> \
          [--lead-model <leadModel>] [--wing-model <wingModel>] [--max-rounds <n>] \
          --json > <scratch>/receipt.json
        ```
        The dispatcher's `--json` is **always** present (the skill needs a parseable receipt); `--lead-model`/`--wing-model`/`--max-rounds` are forwarded only when the user supplied them. **`--ready`/`--no-pr` are NOT passed to the dispatcher** — they are skill-layer landing flags. The skill **captures the dispatcher's single stdout JSON object by redirecting to `<scratch>/receipt.json`** — this is the `--receipt <path>` every later subcommand consumes. (The dispatcher also persists an identical `receipt.json` at `<history_dir>/receipt.json`; the scratchpad copy is what the controller reads, and `history_dir` inside it points at the persisted twin. The two are byte-identical because the stdout object and the persisted object are the same serialized value.)
     7. Branch on `receipt.final_verdict`:
        - `contract_satisfied` → `write_spec_skill.ts route --receipt <scratch>/receipt.json --slug <slug> --lead <lead> [--ready] [--no-pr]` → print handoff.
        - `max_rounds_unsatisfied` → if user passed `--json` → `resolve-gaps … --choice accept --headless …` (auto-accept); else `AskUserQuestion` (Answer / Accept / Abort) → `resolve-gaps --receipt <path> --slug <slug> --lead <lead> --choice <c> [--answers <answers.json>] --sections <sections_path> [--ready] [--no-pr]`.
        - `lead_empty_draft | unchanged_revision | wing_unparseable` → `write_spec_skill.ts route --receipt <path> --slug <slug> --lead <lead>` (routes as a failure: commit-for-inspection, no PR, exit 1).
     8. Print the controller's returned `note`/handoff; propagate its `exit_code`.
     - **Dry-run:** the user's `--dry-run` routes to `write_spec_skill.ts dry-run …` (skill-layer, before any branch/dispatch) — it never invokes the dispatcher.
   - Files: `skill/stark-write-spec/SKILL.md`
   - Interfaces — **Consumes:** `standards/help.md`, `tools/preflight.ts`, `tools/write_spec.ts`, `tools/write_spec_skill.ts`.
   - Acceptance: `skill_smoke_test.test.ts` picks it up (frontmatter parses, name matches, `standards/help.md` referenced, tool refs resolve, `write_spec.ts --help` + `write_spec_skill.ts --help` exit clean); every advertised user flag maps to a concrete layer (dispatcher vs skill-layer) with the receipt captured to a named scratchpad path.

3. **Positional-arg classification + brief assembly**
   - What: `classifyPositional(arg)`: `kind:"path"` iff `fs.existsSync(arg) && fs.statSync(arg).isFile()`, else `kind:"intent"`. Topic/slug: from `--out` basename (strip `YYYY-MM-DD-` prefix + `-spec.md` suffix) if given, else from an AskUserQuestion answer, else derived by the skill from the Ask's leading noun-phrase; the topic is fed to `resolve-paths` → the single `slug`. `BriefSections = { ask, sourceMaterial, conversationContext, constraints, target, preDispatchOpenQuestions }`. `truncateBrief(sections, maxChars)`: render fixed-order sections `## Ask`, `## Source material`, `## Conversation context`, `## Constraints`, `## Target`, `## Pre-dispatch open questions`; `ask`/`constraints`/`target`/`preDispatchOpenQuestions` never truncated (throw `brief_fixed_overflow` if fixed content alone exceeds cap); split remaining budget `sourceMaterial` then `conversationContext`, each truncated by byte length with marker `\n\n…[truncated N chars]…\n`; result `<= maxChars`.
   - Files: `tools/write_spec_lib.ts` (`classifyPositional`, `truncateBrief`, `renderBrief`, `BriefSections`); `write_spec_skill.ts build-brief` wraps them.
   - Interfaces — **Consumes:** `resolveSpecPaths`. **Produces:** `classifyPositional`, `truncateBrief`, `renderBrief`, `BriefSections`.
   - Test: `test_classify_positional`; `test_intent_brief_truncation` — oversize `sourceMaterial` truncates with marker, total ≤ cap, load-bearing sections untruncated; `test_pre_dispatch_unknowns_in_brief` — a `preDispatchOpenQuestions` list renders as `## Pre-dispatch open questions`, never truncated; `test_brief_fixed_overflow`.
   - Acceptance: classification deterministic; brief never exceeds cap; load-bearing sections never lost; pre-dispatch unknowns reach the lead via the brief.

4. **`--help` block** — standalone `--help`/`-h`/`help` prints purpose + usage + `## Arguments` and stops (no preflight, no phases, side-effect-free). CLI surface: `<path|"intent"> [--out PATH] [--lead claude|codex] [--wing claude|codex] [--lead-model ID] [--wing-model ID] [--max-rounds N] [--dry-run] [--ready] [--no-pr] [--json]`.

5. **Terminal-verdict routing + gap resolution (all verdicts, structured-brief enrichment, explicit headless)**
   - What: two named pure helpers with injected deps, wrapped by the controller's `route`/`resolve-gaps`:

     **`routeOutcome(ctx, deps): RouteResult`** — the non-interactive router for `contract_satisfied` and the three failure verdicts:
     - `RouteResult = { exitCode, finalVerdict, pr: PrInfo | null, committed, pushed, note }`.
     - `ctx` carries `{ receipt, specPath, slug, branch, leadApp, summary: LandingSummary, openPr, ready }`.
     - `contract_satisfied` → `landSpec(specPath, slug, { push:true, openPr: ctx.openPr, ready: ctx.ready, leadApp, summary: ctx.summary }, deps)` → `{ exitCode:0, pr }`, note = `next: /stark-review-spec <specPath>`.
     - `lead_empty_draft` → the dispatcher already wrote `specPath` (possibly empty, finding #7). `landSpec(..., { push:false, openPr:false, leadApp, summary })` commits it for inspection. `{ exitCode:1, pr:null, note:"lead produced no usable draft; branch left for inspection" }`.
     - `unchanged_revision` → `landSpec(..., { push:false, openPr:false, leadApp, summary })` (commit the last draft for inspection), `{ exitCode:1, pr:null, note:"lead stuck (unchanged revision); branch left for inspection" }`.
     - `wing_unparseable` → `landSpec(..., { push:false, openPr:false, leadApp, summary })`, `{ exitCode:1, pr:null, note:"wing verdict unparseable; draft committed for inspection" }`.
     - **No failure verdict ever opens a PR or pushes** — this is the finding-#4 (round-4) guarantee.

     **`resolveGaps(ctx, choice, deps): GapResult`** — the `max_rounds_unsatisfied` path only:
     - `GapContext = { receipt, specPath, slug, branch, leadApp, sections: BriefSections, unsatisfied, headless, openPr, ready }` — `sections` is the **structured** brief (finding #5), read from `--sections`'s `sections.json` (falling back to the run record's `brief.json`), so the Answer path can append to `conversationContext` structurally.
     - `GapChoice = "answer" | "accept" | "abort"`; `GapDeps = { runWriteSpec, appendAcceptedGaps, landSpec, renderBrief, writeFile, readFile, buildLandingSummary, redispatchCount }` (injectable).
     - **`answer`** — append the operator's answers to `ctx.sections.conversationContext` (typed append to the structured object), re-render the brief via `renderBrief`/`truncateBrief`, write the new `brief.md` + `sections.json`, and call `deps.runWriteSpec` **exactly once more** with `--sections` pointing at the enriched file (hard single-retry counter). Route the new receipt:
       - new verdict `contract_satisfied` → `routeOutcome` land path (rebuild `summary` from the new receipt), `exitCode:0`.
       - new verdict `max_rounds_unsatisfied` → **accept-with-gaps fallback**: append remaining unsatisfied to Open Questions, land (`push:true`, `summary` flags `answer_redispatch_incomplete:true`), `exitCode:0`.
       - new verdict a **failure verdict** (`lead_empty_draft`/`unchanged_revision`/`wing_unparseable`) → delegate to `routeOutcome` (commit-for-inspection, no PR, `exitCode:1`).
     - **`accept`** — read `specPath`, `appendAcceptedGaps(spec, ctx.unsatisfied)`, write back, `acceptedGaps = ctx.unsatisfied`, build `summary` with `accepted_gaps`, then `landSpec` (commit edited spec, push, PR body carries accepted gaps), `exitCode:0`, `finalVerdict:"max_rounds_unsatisfied"` (dispatcher receipt never rewritten).
     - **`abort`** — commit the dispatch's spec to the branch via `landSpec({ push:false, openPr:false, leadApp, summary })`, `exitCode:1`, no PR.
     - **Headless (`ctx.headless`, finding #4):** no interactive prompt; auto-`accept`, output flags `auto_accepted_gaps:true`. `ctx.headless` is set from the controller's explicit `--headless` flag (user `--json`), **never** inferred from the dispatcher's internal `--json`.
     - `GapResult = { exitCode, finalVerdict, acceptedGaps, redispatched, pr, autoAccepted }`.

     `appendAcceptedGaps(spec, items)`: locate `/^##+\s+Open Questions\s*$/mi` (append the section if absent); render each item `- **[<section>]** <note or "unspecified — needs an answer">`; dedup exact bullets (idempotent); preserve order.
   - Files: `tools/write_spec_lib.ts` (`routeOutcome`, `resolveGaps`, `appendAcceptedGaps`, `RouteResult`/`GapContext`/`GapChoice`/`GapDeps`/`GapResult` types); wrapped by `write_spec_skill.ts route`/`resolve-gaps`.
   - Interfaces — **Consumes:** `landSpec`, `buildLandingSummary` (Task 6), `renderBrief`, `BriefSections`. **Produces:** `routeOutcome`, `resolveGaps`, `appendAcceptedGaps`.
   - Test:
     - `test_route_satisfied_lands` — `contract_satisfied` → land + PR + `exitCode:0`.
     - `test_route_empty_draft_no_pr` — `lead_empty_draft` → `landSpec` called `{push:false,openPr:false}`, no PR, no push, `exitCode:1`.
     - `test_route_unchanged_revision_no_pr` — commit-for-inspection, no PR, `exitCode:1`.
     - `test_route_wing_unparseable_no_pr` — commit-for-inspection, no PR, `exitCode:1`.
     - `test_answer_single_redispatch_bound` — `answer` calls `runWriteSpec` exactly once more (counter asserted).
     - `test_answer_enriches_structured_conversation` — operator answers are appended to `sections.conversationContext` (structured), the redispatch's `--sections` file contains them; the flat `brief.md` is regenerated from the structured object, never hand-patched.
     - `test_answer_redispatch_failure_verdict_no_pr` — the answer redispatch returns `wing_unparseable` → no PR, `exitCode:1`.
     - `test_answer_redispatch_max_rounds_accepts_gaps` — the answer redispatch returns `max_rounds_unsatisfied` → gaps appended, lands with `answer_redispatch_incomplete:true`, `exitCode:0`.
     - `test_accept_exit_zero_receipt_unchanged` — `accept` edits Open Questions, `exitCode:0`, dispatcher `receipt.json` byte-identical.
     - `test_abort_exit_one_no_pr` — `abort` → `landSpec({push:false,openPr:false})` (commit on branch, no push/PR), `exitCode:1`.
     - `test_headless_auto_accept` — `headless:true` + `max_rounds` → gaps appended, `auto_accepted_gaps:true`, receipt unchanged.
     - `test_interactive_vs_headless_distinct` — a `resolve-gaps` call **without** `--headless` never auto-accepts (requires an explicit `--choice`); a call with `--headless` auto-accepts even when `--choice` is omitted — proving the dispatcher's internal `--json` does not leak headless state.
     - `test_append_accepted_gaps_creates_section`, `test_append_accepted_gaps_dedup`.
   - Acceptance: every terminal verdict is routed; no failure verdict opens a PR; the Answer redispatch is bounded to one, enriches the structured brief, and its verdict routed; acceptance never rewrites a dispatcher receipt; headless is an explicit user-facing state distinct from the dispatcher's `--json`.

6. **Host-rendered PR body (`LandingSummary`) + branch-first landing — prepare-before-dispatch, create-or-adopt, exact staging, explicit App auth, never force-push**
   - What: a host-owned PR-body model plus the landing helpers, all with injected `git`/`gh`/`getToken`/`prCreate` runners:

     **`buildLandingSummary(receipt, extra): LandingSummary`** (finding #6) — assembled from the dispatcher receipt (+ any accept/redispatch extras):
     - `LandingSummary = { slug, finalVerdict, contractStatus: ContractItem[], rounds: RoundSummary[], acceptedGaps: {section,note}[], flags: { answer_redispatch_incomplete?: boolean, auto_accepted_gaps?: boolean }, cost_usd, model: {lead,wing} }` (`RoundSummary = { round, revisedSections, durationS }` from `receipt.rounds[]`).
     - `renderPrBody(summary): string` renders the markdown: a **contract-status table** (section / status / note), a **per-round summary** table, an **accepted-gaps** list (when non-empty), and any **redispatch-incomplete / auto-accepted flags**. Includes the stable `write-spec:<slug>` marker line the adoption lookup keys on.

     **`prepareBranch(slug, leadApp, deps): { branch, adopted }`** — called before dispatch (finding #2):
     1. `branch = write-spec/<slug>`.
     2. local branch exists → `git checkout <branch>`.
     3. else remote-only exists (`git ls-remote --heads origin <branch>` non-empty) → `git fetch origin <branch> && git checkout -b <branch> --track origin/<branch>`.
     4. else → `git checkout -b <branch>`.
     Checkout happens on a clean tree (dispatcher hasn't written `specPath` yet), so an existing tracked spec never blocks checkout. **git remote auth (finding #2):** `GH_TOKEN` in the environment does **not** authenticate `git` over HTTPS — git ignores it. Remote ops (`ls-remote`, `fetch`, `push`) authenticate via a **scoped askpass helper**: `gitAuthEnv(leadApp, owner, deps)` mints `token = await getToken({ app: leadApp, owner })`, writes a throwaway `GIT_ASKPASS` script (mode 0700, under the process temp dir) that echoes the token, and returns `{ GIT_ASKPASS, GIT_TERMINAL_PROMPT: "0" }` merged into the git subprocess env — never the ambient identity. All three git remote verbs run through it. `test_git_remote_uses_askpass` asserts the askpass mechanism (not a bare `GH_TOKEN`) is what carries the credential.

     **`landSpec(specPath, slug, opts, deps): { branch, committed, pushed, pr }`** — `opts = { push, openPr, ready, leadApp, summary: LandingSummary }`:
     1. assert `git rev-parse --abbrev-ref HEAD === branch`; refuse otherwise.
     2. **Exact staging:** `git add -- <specPath>` — a single explicit pathspec, no glob, no `git add .`. The run record lives under `stateRoot()` (outside the repo) and is never staged.
     3. **Commit:** if `git diff --cached --quiet -- <specPath>` shows no staged diff and HEAD already carries `write-spec: <slug>` → no-diff regeneration (skip commit, proceed idempotently); else if no diff → surface `nothing_to_land` (still proceed to PR adoption if `opts.openPr`); else `git commit -m "write-spec: <slug>"`.
     4. **Push (skipped when `opts.push === false`):** `git push -u origin <branch>` (plain, **never `--force`/`--force-with-lease`**). Non-fast-forward → `git pull --ff-only origin <branch>` then retry once; still-failing → `push_failed` (spec already committed locally).
     5. **PR lookup/adoption with explicit App auth + host-rendered body:** all `gh` calls run through `deps.gh(cmd, { env })` where `env.GH_TOKEN = await getToken({ app: opts.leadApp, owner })` (the `runtime_env_lib.ts` pattern), never the ambient identity. `const body = renderPrBody(opts.summary)` is computed once and used identically by create and edit:
        - `findExistingPr(branch, repo, deps)` = `gh pr list --repo <owner/repo> --head <branch> --json number,url,isDraft` → single open match (>1 → adopt the open one, log the rest).
        - exists → `editPrBody(prNumber, body, repo, deps)` = `gh pr edit <number> --repo <owner/repo> --body <body>`; **do not open a second PR** — the adopted PR's body is **refreshed** with the current contract-status table / per-round summary / accepted gaps / flags. **Adopted-draft readiness (finding #3):** if `opts.ready` and the adopted PR `isDraft`, also run `gh pr ready <number> --repo <owner/repo>` — App installation tokens cannot un-draft, so this one call runs under the **ambient user identity** (no App-token env), matching the repo's documented merge-path pattern; an already-ready PR is left untouched (idempotent). Body edits keep App auth.
        - none and `opts.openPr` → `prCreate(..., { app: opts.leadApp, draft: opts.ready ? false : (draft ?? true), body })`; `opts.openPr === false` → skip PR.
     6. Handoff line last: `next: /stark-review-spec <spec-path>`.
   - Files: `tools/write_spec_lib.ts` (`buildLandingSummary`, `renderPrBody`, `LandingSummary`/`RoundSummary` types, `prepareBranch`, `landSpec`, `findExistingPr`, `editPrBody`, `LandDeps`); wrapped by the controller subcommands.
   - Interfaces — **Consumes:** `getToken`, `prCreate`, `AppName` (github_app_lib); `leadAppFor`. **Produces:** `buildLandingSummary`, `renderPrBody`, `prepareBranch`, `landSpec`, `findExistingPr`, `editPrBody`, `LandDeps = { git, gh, getToken, prCreate, owner, repo }`.
   - Test (injected fake `git`/`gh`/`getToken` runners record invocations):
     - `test_prepare_branch_remote_uses_lead_app` (finding #2) — a remote-only `write-spec/<slug>` with `leadApp="stark-codex"` → both `git ls-remote` and `git fetch` recorded running through `gitAuthEnv` with a token from `getToken({ app: "stark-codex", owner })` (a `GIT_ASKPASS` env entry, not a bare `GH_TOKEN`); a codex-lead run never mints the default `stark-claude` token for adoption.
     - `test_adopted_draft_marked_ready` (finding #3) — adopted branch, existing **draft** PR, `opts.ready=true` → `gh pr ready <n>` invoked exactly once **without** the App-token env (ambient identity); with an already-ready PR or `opts.ready=false`, `gh pr ready` is never called.
     - `test_prepare_branch_before_write` — existing tracked spec on a remote branch → `prepareBranch` adopts on a clean tree; checkout succeeds, no "would be overwritten" path.
     - `test_land_first_time` — no branch → create, stage only `specPath`, commit, push, draft PR via `prCreate` with `{ app: leadApp, body }`; no `--force`.
     - `test_pr_body_rendered_from_summary` (finding #6) — `renderPrBody` output contains the contract-status table, per-round summary, and (when present) accepted-gaps list + flags; `prCreate` receives that exact `body`.
     - `test_adopted_pr_body_refresh` (finding #6) — adopted branch with an existing open PR → `editPrBody` invoked with the freshly rendered `body` (asserts the current contract-status table + round summary present), **exactly one PR edit, zero creates.**
     - `test_land_rerun_differing_spec` — adopted branch, differing tracked spec → checkout, overwrite, commit on top, push, **exactly one PR edit** (not create).
     - `test_land_recovery_commit_before_push` — un-pushed commit, no diff on re-run → skip commit, push, adopt/create PR.
     - `test_land_exact_staging` — an unrelated tracked `README.md` and untracked `notes.md` modified → `git add` invoked exactly once as `git add -- <specPath>`; neither unrelated file staged.
     - `test_land_pr_uses_app_token` — every `gh pr list`/`gh pr edit` recorded with `env.GH_TOKEN` from `getToken({ app: leadApp, owner })` and `--repo <owner/repo> --head <branch>` scoping; no `gh` call without the App-token env.
     - `test_land_getToken_object_arg` — `getToken` is called with the object form `{ app, owner }` (asserts the recorded arg shape), never positional.
     - `test_land_no_force_push` — every recorded push is plain `git push`.
   - Acceptance: branch adopted before any spec write, with remote adoption authenticated by the lead App; PR bodies (create + adopt) are host-rendered from `LandingSummary` and refreshed on adoption; rerun on a differing tracked spec commits on top; staging is exactly `[specPath]`; every authenticated `gh` command carries the lead-App token via the object-form `getToken`; force-push rule provably honored.

7. **Skill-layer `--dry-run` (`runSkillDryRun`)**
   - What: `runSkillDryRun(argv, deps)`: classify the positional, resolve the path triple (`resolveSpecPaths`), assemble + `truncateBrief` the brief, resolve config/models, and **print** the assembled brief + resolved plan (agents, models, round budget, out path, branch, slug, PR-would-open, `preDispatchOpenQuestions` as "would ask: …"). Skips everything mutating: no `AskUserQuestion`, no `prepareBranch`, no dispatcher, no spec write, no git, no PR, no history. Exposed as `write_spec_skill.ts dry-run`.
   - Files: `tools/write_spec_lib.ts` (`runSkillDryRun`); `write_spec_skill.ts dry-run`.
   - Interfaces — **Consumes:** `classifyPositional`, `truncateBrief`, `renderBrief`, `resolveSpecPaths`, `getWriteSpecConfig`, `resolveModel`. **Produces:** `runSkillDryRun`.
   - Test: `test_skill_dry_run_side_effect_free` — injected fakes; zero dispatch/git/gh/AskUserQuestion/prepareBranch calls, no files written; stdout contains the assembled brief + resolved out path + branch + slug.
   - Acceptance: skill `--dry-run` prints brief + resolved plan and mutates nothing.

### Risks
- **Distilling conversation context is skill-judgment:** the structured brief is persisted (`sections.json` + run-record `brief.json`) so every run is reproducible and the Answer path enriches it structurally; gap-fill catches load-bearing omissions, and unresolved ones go into `preDispatchOpenQuestions` (visible to review-spec).
- **A rerun's dispatcher overwrites the tracked spec before commit:** `prepareBranch` runs first so the overwrite lands on the correct branch's working tree; `test_land_rerun_differing_spec` locks the commit-on-top path.
- **`gh` silently using ambient identity:** every `gh` call (including `prepareBranch`'s remote adoption) routes through the App token; `test_land_pr_uses_app_token` + `test_prepare_branch_remote_uses_lead_app` fail if any omits it.

### Verification
```
npm --prefix tools test -- write_spec_lib.test.ts skill_smoke_test.test.ts
```
Then a concrete manual skill run (real surface, playground rules):
```
/stark-write-spec "a CLI subcommand that lists the last 5 write-spec runs from the history dir" --lead claude --wing codex
```
Assert: path triple resolved, brief assembled, `write-spec/<slug>` checked out before dispatch, `docs/specs/<today>-<slug>-spec.md` written, only that file staged, a **draft** PR authored by stark-claude whose body carries the contract-status table + per-round summary, `next: /stark-review-spec <spec-path>` printed. Confirm:
```
git log -1 --format=%s                    # write-spec: <slug>
git show --stat HEAD | grep -c '\.md'     # exactly the one spec file
gh pr view --json body -q .body           # contract-status table + round summary present
```
A **codex-lead** adoption check (finding #2):
```
/stark-write-spec "same intent" --lead codex --wing claude   # rerun after pushing the branch
```
Assert the remote branch is adopted and the PR edit is authored by **stark-codex** (not the default App). Dry-run:
```
/stark-write-spec "same intent as above" --dry-run
```
Assert: prints brief + resolved plan, no branch (`git branch --list 'write-spec/*'` unchanged), no spec file, no PR. Headless (finding #4):
```
/stark-write-spec "thin intent" --max-rounds 1 --json
```
Assert: no `AskUserQuestion`, receipt/summary carry `auto_accepted_gaps:true`, exit 0. Abort (interactive, max-rounds forced via `--max-rounds 1`): choose Abort → `git branch --list write-spec/*` shows the branch with a committed spec and `gh pr list --head write-spec/<slug>` is empty.

## Phase 5: Docs, ADR, live e2e
**Goal:** Close the DoD — docs updated in the same change, the architectural ADR written, and the pipeline proven end to end on a real spec.
**Dependencies:** Phases 1–4
**Estimated effort:** M

### Tasks

1. **Docs in the same change (CLAUDE.md + AGENTS.md, both unconditional)**
   - What: update **`CLAUDE.md`** — add `/stark-write-spec` to the Pipeline skills list (stage 0, before review-spec), the TS tools section (`write_spec.ts`/`write_spec_lib.ts`/`write_spec_skill.ts`, noting the `--slug` host contract, the controller-CLI markdown↔TS seam incl. the `resolve-paths` subcommand, the App-authed remote branch adoption, the host-rendered `LandingSummary`/`renderPrBody`, the explicit `--headless` state, the `items`-keyed `extractContractVerdictJson`, the write-on-every-non-crash-exit rule, and branch-first landing), the prompts-layout section (`global/prompts/write-spec/`), and the config section list (`getWriteSpecConfig`). **Also update `AGENTS.md`** — the repository instructions require both `AGENTS.md` and `CLAUDE.md` to be updated for behavior, structure, command, and tooling changes; write-spec adds a pipeline stage, three tools, a prompts dir, and a config section, so the `AGENTS.md` pipeline/tool/prompt documentation is updated to mirror the CLAUDE.md changes. This is an **unconditional** task (finding #8) — not gated on "if applicable."
   - Files: `CLAUDE.md`, `AGENTS.md`
   - Acceptance: `CLAUDE.md` pipeline list shows write-spec ahead of review-spec with tool + prompt + config entries; `AGENTS.md` carries the mirrored pipeline/tool/prompt entries; both are committed in the same PR set. If `AGENTS.md` does not exist in the repo, create it with the write-spec entries rather than skipping the update.

2. **ADR** `docs/adr/NNNN-spec-authoring-contract-bounded.md`
   - What: MADR-lite, next monotonic number (compute via `ls docs/adr/ | sort | tail -1`). Decision: add a contract-bounded authoring stage upstream of review; rationale = the inflation root cause (implicit completeness → adversarial invention); the closed-enum wing as the structural bound; the sibling `extractContractVerdictJson` (not a shared-parser mutation) preserving plan-dispatch; the controller-CLI seam (incl. `resolve-paths`) letting a markdown skill drive TS helpers; rule-of-three deferral of the shared loop lib. Record the load-bearing host contracts: host-owned slug via `--slug`, branch-before-dispatch landing with App-authed remote adoption, object-form `getToken({ app, owner })`, host-rendered PR bodies, write-on-every-non-crash-exit, and explicit interactive/headless state.
   - Files: `docs/adr/NNNN-spec-authoring-contract-bounded.md`
   - Acceptance: immutable ADR present; referenced from the spec's DoD.

3. **Live e2e (playground rules — real surface, no ceremony)**
   - What: run the full pipeline on one real spec with a **canned intent** and record the DoD evidence.
     - **Canned intent (verbatim):** `"a CLI subcommand 'stark write-spec runs' that lists the last N write-spec runs (slug, run-id, final_verdict, cost_usd) read from the history dir, N defaulting to 10"`.
     - **Author:** `/stark-write-spec "<canned intent above>" --lead claude --wing codex`
     - **Resulting spec path:** captured from the write-spec receipt's `spec_path` (do not assume the filename; slug is host-derived).
     - **Review:** `/stark-review-spec <spec_path>`
     - **Baseline-comparison procedure (DoD #2), receipt-derived paths:**
       1. Capture the `/stark-review-spec` run's receipt and read its `history_dir` field (the per-run dir `…/history/spec-reviews/<full-document-basename>/<run-id>/`, where `<full-document-basename>` is the spec's on-disk basename incl. the date and `-spec` suffix — **not** the bare topic slug and **not** `latest`).
       2. Read `<history_dir>/rounds.json`; the round-1 finding count = sum of `findings[]` lengths across all domains in the `rounds[0]` (round 1) entry. (`rounds.json` is the canonical per-run round record `stark_review_doc` writes; there is no `round-1.json` file.)
       3. For the two most recent **hand-written** spec reviews: list `…/history/spec-reviews/*/` dirs, resolve each's `latest` pointer to its run dir, read that run's `rounds.json`, take its round-1 finding count. Pick the two by run-dir mtime, excluding the authored spec's basename.
       4. Record all three counts on the PR; the authored count should be **materially lower** (directional spot-check).
   - Files: none (records land in history dirs; numbers recorded on the PR)
   - Acceptance: (a) write-spec receipt reaches `contract_satisfied` within 3 rounds; (b) authored spec's round-1 finding count materially lower than the two-baseline average, numbers posted on the PR; (c) no growth breaker trips in the review-spec run (assert via the review run's `analytics.json` — read from the same `history_dir` — carrying no `growth_ack_required`/hard-cap/invent-then-condemn flags).

### Risks
- **DoD criterion #2 is directional, not statistical:** accepted by the spec — a spot-check against existing per-run `rounds.json` records. Record the comparison numbers on the PR for future contract-lens tuning (Open Question #2).
- **Canned-intent slug drift:** the slug is host-derived; capture the actual `spec_path` and the review receipt's `history_dir` rather than assuming filenames.

### Verification
```
npm --prefix tools test
```
Expect green (all `write_spec_lib.test.ts` named tests + `skill_smoke_test.test.ts`). Then confirm the e2e records via the **receipt-derived** paths:
```
# write-spec receipt (capture its history_dir + spec_path)
cat "$(node -e 'const r=require("os").homedir()+"/.claude/code-review/history/write-spec"; /* read latest/receipt.json history_dir */')"
# review-spec run: read history_dir from the review receipt, then:
#   rounds.json  -> round-1 finding count
#   analytics.json -> assert no growth-breaker flags
```
Assert the write-spec receipt `final_verdict:"contract_satisfied"` with `rounds` length ≤ 3, the review `rounds.json` round-1 count materially below the two hand-written baselines, and the review `analytics.json` carries no `growth_ack_required`/hard-cap/invent-then-condemn flags. Docs (`CLAUDE.md` **and** `AGENTS.md`) + ADR merged in the same PR set.

## Ambiguities resolved (from the spec + wing findings, for the implementer)

- **Path resolution not reachable from markdown (round-5 finding #1)** — resolved: Phase 4 Task 1 adds the `resolve-paths --topic --today [--out]` controller subcommand → `{slug, specPath, branch}`, the single way the markdown layer obtains the host-computed triple; `build-brief`, `prepare-branch`, the dispatcher, and landing all receive those exact values.
- **Remote branch adoption unauthenticated (round-5 finding #2)** — resolved: `prepareBranch(slug, leadApp, deps)` and `prepare-branch --slug --lead` thread the lead App through the `gitAuthEnv` **askpass** helper (`GH_TOKEN` does not authenticate git over HTTPS); `git ls-remote`/`git fetch`/`git push` carry a `GIT_ASKPASS` credential from `getToken({ app: leadApp, owner })`. `test_prepare_branch_remote_uses_lead_app` + `test_git_remote_uses_askpass` prove it.
- **Adopted draft PR left as draft under `--ready` (round-5 finding #3)** — resolved: `landSpec` runs `gh pr ready <n>` (ambient identity — App tokens can't un-draft) when an adopted PR is a draft and `opts.ready`; idempotent for already-ready PRs. `test_adopted_draft_marked_ready` covers it.
- **Verification commands unrunnable from repo root (round-5 finding #1)** — resolved: all test invocations use `npm --prefix tools test …` (the `package.json` lives in `tools/`, not the repo root).
- **Flag propagation + receipt plumbing undefined (round-5 finding #3)** — resolved: Phase 4 Task 2 specifies the exact dispatcher invocation forwarding `--lead-model`/`--wing-model`/`--max-rounds` (skill-layer `--ready`/`--no-pr` stay off the dispatcher), and captures the dispatcher's stdout receipt to `<scratch>/receipt.json` — the `--receipt <path>` every controller subcommand consumes, byte-identical to the persisted `<history_dir>/receipt.json`.
- **No executable headless path (round-5 finding #4)** — resolved: `resolve-gaps` gains an explicit `--headless` flag set only from the *user's* `--json`; the dispatcher's internal `--json` never implies headless. `test_interactive_vs_headless_distinct` + `test_headless_auto_accept` prove interactive asks, headless auto-accepts + sets `auto_accepted_gaps:true`.
- **Answer path lacked structured brief (round-5 finding #5)** — resolved: the dispatcher persists `brief.json` (the `BriefSections`) via `--sections`; `resolveGaps` carries `sections: BriefSections`, appends operator answers to `conversationContext` structurally, re-renders, and re-dispatches once. `test_answer_enriches_structured_conversation` locks it.
- **PR body lacked required data (round-5 finding #6)** — resolved: `buildLandingSummary(receipt, extra)` + `renderPrBody(summary)` produce the contract-status table, per-round summary, accepted gaps, and redispatch/auto-accept flags; `landSpec`'s `opts.summary` is consumed identically by `prCreate` and `editPrBody`. `test_pr_body_rendered_from_summary` + `test_adopted_pr_body_refresh` cover create + adopt.
- **First-round `lead_empty_draft` skipped the spec write (round-5 finding #7)** — resolved: Phase 3 Task 5 makes the write uniform — the loop tracks `lastDraft` and writes it (even empty) to `specPath` on **every** non-crash exit, matching the spec's contract verbatim; the exception is gone. `test_empty_draft_still_writes_spec` locks it.
- **AGENTS.md update was conditional (round-5 finding #8)** — resolved: Phase 5 Task 1 makes updating **both** `CLAUDE.md` and `AGENTS.md` an unconditional task (create `AGENTS.md` with the entries if absent), per the repository instructions.
- **Wing schema is not `verdict`-keyed (round-4 finding #1)** — resolved: Phase 2 Task 1 adds `extractContractVerdictJson`; `test_plan_dispatch_verdict_parsing_preserved` locks plan-dispatch.
- **Usage counts unavailable after normalization (round-4 finding #2)** — resolved: Phase 3 Task 2 pins raw-envelope usage parsers against real captures.
- **Markdown can't invoke TS helpers (round-4 finding #3)** — resolved: `tools/write_spec_skill.ts` controller CLI; SKILL.md invokes its subcommands.
- **Unrouted terminal verdicts (round-4 finding #4)** — resolved: `routeOutcome` + `resolveGaps` route every verdict; no failure verdict opens a PR.
- **`getToken` signature (round-4 finding #5)** — resolved: object-form `getToken({ app, owner })` everywhere; `test_land_getToken_object_arg` asserts it.
- **Baseline paths don't match the review-history layout (round-4 finding #6)** — resolved: Phase 5 Task 3 reads the review receipt's `history_dir` + `rounds.json` and resolves baselines via `latest` pointers.
- **Slug → dispatcher contract** — resolved: `resolveSpecPaths` computes the slug once; passed via required `--slug`.
- **Branch-before-write + Abort inspectable state** — resolved: `prepareBranch` adopts on a clean tree before dispatch; abort/failure routes commit via `landSpec({push:false,openPr:false})`.
- **Exact staging scope** — resolved: `landSpec` stages exactly `git add -- <specPath>`.

No SSOT violations introduced — every value, path, and rule consumes an existing owner (config accessor, `sanitizeSlug`, `resolveModel`, `assetPromptsDir`, `computeDispatchCost`, `getToken`, `leadAppFor`, the sibling dispatch + history primitives) rather than re-deriving or hardcoding.
