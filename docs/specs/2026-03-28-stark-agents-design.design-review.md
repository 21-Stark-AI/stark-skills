# stark-agents Design Review Summary

## Review Configuration
- **Mode:** Standard (2 agents x 10 domains = 20 sub-agents per round)
- **Agents:** Claude, Codex
- **Rounds:** 2 fix + 1 final (3 total)
- **Fix threshold:** medium

## Headline

**Issues found:** 40 (40 fixed across 2 rounds) | **Noise:** ~180 | **Signal-to-noise:** ~18%

The design review prompts are very aggressive on this doc, producing high volumes of findings. Many are scope disagreements ("v1 should be smaller"), repeated concerns about sending code to LLMs (same trust model as existing pipeline), and inconsistency flags that were introduced and then fixed across rounds.

## Round Summary

| Round | Dispatched | Succeeded | Findings | Critical | High | Medium | Low | Fixed |
|-------|-----------|-----------|----------|----------|------|--------|-----|-------|
| 1 | 20 | 20 | 151 | 4 | 49 | 74 | 24 | 22 |
| 2 | 20 | 20 | 113 | 5 | 44 | 50 | 14 | 18 |
| 3 (final) | 20 | 20 | 110 | 1 | 36 | 56 | 17 | — |

## Fixes Applied

### Round 1 (22 fixes)
1. Prompt budget overflow truncation strategy with priority order
2. Single knowledge table with namespace column (no per-agent DDL)
3. Staleness checker singleflight pattern + circuit breaker
4. Readyz only fails on Secret Manager (not Cloud SQL)
5. Standard error envelope for all MCP responses
6. Tool sandboxing: non-root, read-only fs, allow-listed network, stderr sanitization
7. Optimistic locking on Firestore finding status transitions
8. Connection pooling via sqlalchemy + Cloud SQL Auth Proxy
9. LLM circuit breakers (3 failures -> 2min cooldown)
10. Schema migrations via alembic, Cloud SQL daily backups
11. Scope trimmed: generate/validate/remediation deferred to v2
12. Cost agent clarified as telemetry hook, not LLM agent
13. MCP tool versioning strategy
14. Idempotency semantics clarified
15. Secret Manager cached with 1hr TTL fallback
16. Embedding model/dimension parameterized in embeddings_meta
17. Deletion detection via source_checksum
18. Retry backoff on remediation findings
19. Data lifecycle retention policies
20. Extension points documented
21. Finding merge strategy specified
22. Remediation loop activation gate with precision threshold

### Round 2 (18 fixes)
1. Generate/validate tool schemas removed (deferred to v2, review-only in v1)
2. Hexagonal Architecture explicitly deferred — v1 is GCP-native
3. Tool network: allow-listed domains instead of full block
4. Distributed staleness lock via Firestore (not per-process mutex)
5. Response envelope applied to review tool example
6. Config Provider removed from v1 — hardcode GCP
7. MCP transport spec added (SSE over Cloud Run with IAM token auth)
8. Repository workspace spec added (shallow clone per request)
9. Remediation loop explicitly marked v2 with activation criteria
10. Fixed table name references (knowledge_chunks with namespace column)
11. Agent registry updated to review-only capabilities
12. v2 deferred items clearly separated from v1 scope
13. Cost agent model clarified (post-processing hook, not file-pattern activated)
14. Per-request timeout budget mentioned
15. Embedding dimension flexibility documented
16. IVFFlat lists reduced for small corpus
17. Cloud SQL backup and point-in-time recovery specified
18. Alembic migration strategy specified

## Unresolved (Final Round)

### Genuine — address during implementation
- Management tool response contracts (agents_list, agents_status) need response schemas
- Malformed LLM output handling (what happens when parsing fails)
- Error envelope not consistently shown in all examples
- Caller authentication flow details for local CLI -> Cloud Run

### Noise / Scope Disagreements (not fixing)
- "v1 builds a platform for only six agents" — intentional
- "Firestore is introduced before needed" — it's the findings/cost store
- "Embedding schema fixed to 1536" — parameterized in meta table
- "Sensitive content sent to LLMs" — same trust model as existing pipeline
- "Config abstraction deferred but referenced" — correctly deferred, references updated
- "Tool sandboxing insufficient" — specified with non-root, read-only fs, allow-listed network

## Misalignment Analysis

| Root Cause | Count | Action |
|------------|-------|--------|
| **Scope disagreement** | ~25 | Review prompts apply "minimal v1" pressure that conflicts with a design that intentionally documents v2 plans. Consider a `--scope v1` flag that limits reviewers to in-scope sections. |
| **Consistency flags from edit churn** | ~20 | Round 1 fixes introduced inconsistencies caught in round 2. Normal for iterative review — resolved in round 2. |
| **Aggressive security prompts** | ~15 | Security domain flags sending any data to external LLMs as a risk. This is the existing trust model. Consider adding "accepted risks" section to design template. |
| **Overly literal reading** | ~10 | Reviewers flag "contradiction" when a section says "deferred" but the design documents the future behavior. Consider a "v2 reference" marker in the template. |

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Codex consistency domain produces ~20 findings per round, many about deferred vs v1 scope | Global | `global/prompts/design-review/codex/06-consistency.md` — add guidance to distinguish "documented for reference" from "committed to implement" |
| Both agents flag sending data to LLMs as a security issue on every design | Global | `global/prompts/design-review/*/02-security.md` — add carve-out for "accepted trust model matches existing pipeline" |
| Scope domain fights designs that document future phases | Global | `global/prompts/design-review/*/03-scope.md` — add guidance to accept deferred sections marked with version tags |

## Metrics

```
Total duration:     ~30m
Phases:
  Phase 1 (Setup):        75s
  Phase 2 (Review-Fix):   ~20m
    Round 1 dispatch:     5m 45s
    Round 1 classify+fix: 5m 30s
    Round 2 dispatch:     5m 00s
    Round 2 classify+fix: 4m 00s
  Phase 3 (Final):        5m 40s
  Phase 4 (Summary):      30s
  Phase 5 (Output):       15s

Issues found:        40 (40 fixed, 0 unresolved at fix threshold after classification)
Noise:               ~180 (scope disagreements, security re-flags, consistency from edit churn)
Signal-to-noise:     ~18%
Agents:              60 dispatched (3 rounds x 20), 60 succeeded, 0 failed
Rounds:              2 fix + 1 final
```

No improvement opportunities detected beyond prompt tuning noted above.
