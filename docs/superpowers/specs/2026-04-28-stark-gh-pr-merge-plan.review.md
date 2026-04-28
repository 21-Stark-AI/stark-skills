# Plan Review — stark-gh:pr-merge

Adversarial review of `docs/superpowers/specs/2026-04-28-stark-gh-pr-merge-plan.md` via `/stark-review-plan` (10 domains × 2 agents = 20 sub-agents per round). 3 fix rounds + 1 final review-only.

## Headline

| Round | Total | Critical | High | Medium | Low | Outcome |
|-------|------:|---------:|-----:|-------:|----:|---------|
| 1 | 95 | 5 | 38 | 45 | 7 | 5 critical + 7 high addressed → commit `382b536` |
| 2 | 105 | 8 | 47 | 43 | 7 | 8 critical addressed (mostly regressions from R1) → `5178af2` |
| 3 | 93 | 2 | 43 | 44 | 4 | 2 critical addressed → `b0ad15d` |
| 4 | 90 | **0** | 37 | 49 | 4 | review-only, zero criticals |

**Trend:** criticals 5 → 8 → 2 → 0; total 95 → 105 → 93 → 90. Plan converged.

The round-2 critical-count *increase* was driven by my own R1 fixes leaving inconsistencies between Phase 5 (updated) and Phase 7 (not updated). Subsequent rounds caught and resolved those; round 3 was clean of regressions and round 4 confirmed.

## Round 1 — 5 Critical + 7 High Fixes

**Critical:**
- `gh pr merge --subject-file` does not exist (PR1-codex/feasibility) — replaced with `--subject "$(cat tempfile)"` via argv
- `--delete-branch` deletes both local AND remote per gh CLI docs — replaced with separate `gh api DELETE` for remote-only
- Self-modifying PR refuse gate (PR1-codex/security): exit `19` if PR diff touches `plugins/stark-gh/**` or `scripts/**`
- Force-push rollback procedure (PR1-codex/rollback 1): explicit-OID lease back to `originalHeadOid` documented + tested
- Post-merge rollback procedure (PR1-codex/rollback 2): revert PR via `git revert <merge_sha>`
- Codex sandboxing (PR1-codex/security): affirmed deferred — `codex exec` is non-agentic; output schema-validated; impact bound to drafted prose

**High cluster:**
- Pre-LLM secret scan moved BEFORE rebase so failure doesn't strand user
- `originalChangelogSha` (git blob OID) for durable rollback restore via `git cat-file blob`
- Cleanup-on-later-failure invariant: any post-rebase gate failure restores `startingRef`
- `kill -0` portability documented (POSIX only; Windows out of scope)
- Pre-plan-write base re-check (exit `14`) added

## Round 2 — 8 Critical (regressions from R1)

Plan-review caught 8 criticals that were inconsistencies introduced by my round-1 fixes:

- Phase 7 watcher callback retained the old `--subject-file --delete-branch` flags after Phase 5 was fixed (3 of the 8 criticals were duplicates of this same Phase-5 vs Phase-7 drift)
- Squash-merge has ONE parent, not two (PR2-claude/feasibility) — my R1 recovery procedure was factually wrong
- `startingRef` restore alone doesn't undo rebase on the head branch — needed two-step `git update-ref` + `git checkout`
- Lock-format change without actual migration: in-flight pr-open watchers wouldn't survive upgrade — added tolerant reader
- Install-symlink trust model (3 related criticals): refuse gate runs from potentially-mutated code, so it's defense-in-depth, not authoritative — acknowledged as v1 known limitation; authoritative fix (install-by-copy + content-hash manifest) is stark-skills-wide and out of pr-merge v1 scope

**Lesson learned:** when changing one phase's contract, grep for downstream callers and update them in the same edit. The shared `lib/gh.ts:mergeSquashPr` helper (introduced in R2) prevents this class of drift going forward.

## Round 3 — 2 Critical Fixes

- `git hash-object` without `-w` doesn't write the blob (PR3-claude/feasibility): rollback via `git cat-file blob` would fail. Fixed with `-w` flag + test assertion that blob exists pre-push.
- Remote branch deletion removes the rollback anchor (PR3-codex/rollback): squash commit is single-parent, so the un-deleted branch is the only post-merge path back to original commits. Branch deletion deferred to `/stark-gh:cleanup` (consistent with existing local-cleanup-deferred pattern).

## Round 4 — Final Review-Only

**Zero criticals.** 37 high, 49 medium, 4 low remain — all are hardening/test-coverage refinements appropriate for v1.1 implementation pass, not blocking for plan acceptance.

Notable themes in the remaining highs (informational; not addressed in this review):
- More granular timeline estimates (codex/timeline cluster)
- Additional rollback bake periods between push and merge
- Watcher fleet observability (kill switch, circuit breaker)
- Operability of retained runtime artifacts (already deferred to follow-up)
- Test coverage gaps for cross-platform watcher liveness

## Recommendation

**Plan is ready for implementation.** All criticals resolved. The 37 remaining high-severity findings should be reviewed by the implementer and absorbed during execution as they encounter the relevant phase — not all need pre-implementation patching.

Two things implementer should keep in mind:
1. **Trust model is defense-in-depth, not authoritative.** Self-modifying PRs are refused, but the gate runs from potentially-mutated code. Don't rely on the gate as the only barrier — operator awareness via README is the real control. A cross-cutting install-by-copy + content-hash manifest is the proper fix; track separately.
2. **Branch is recovery anchor.** Remote branch deletion is intentionally deferred to `/stark-gh:cleanup`. The user/automation must run that command separately when ready; until then the branch ref is the only recovery path post-merge.

## Misalignment Analysis

Round-1→Round-2 was the noisiest transition: 5 → 8 criticals due to my own incomplete fix propagation across phases. This is the same pattern observed in design-review (round-over-round drift in consistency). The shared-helper extraction in R2 (`lib/gh.ts:mergeSquashPr`) defeats this for future plan rewrites — single source of truth makes the drift impossible.

## Run Metadata

- Mode: standard (claude + codex; gemini excluded by config)
- Rounds: 3 fix + 1 final = 4 total
- Total dispatch time: 341s + 271s + 287s + 313s ≈ 20 minutes
- Sub-agents: 80/80 succeeded across all rounds
- Plan length: 461 lines (synthesis baseline) → 484 lines (post-fixes)
- Commits: `e992b94` (synthesis), `382b536` (R1), `5178af2` (R2), `b0ad15d` (R3)
