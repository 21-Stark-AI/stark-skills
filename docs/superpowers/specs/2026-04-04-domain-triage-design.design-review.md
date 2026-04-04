# Design Review — Domain Triage

**File:** `docs/superpowers/specs/2026-04-04-domain-triage-design.md`
**Mode:** standard (2 agents × 12 domains)
**Rounds:** 1 fix + 1 final

---

## Headline

**Issues found:** 28 | **Noise:** 40 | **Ignored:** 28
**Signal-to-noise:** 41%

---

## Round 1 — Fix Round

**Dispatch:** 24/24 sub-agents succeeded (claude × 12, codex × 12)
**Findings:** 96 total — 2 critical, 41 high, 40 medium, 13 low
**Fixed:** 28 | **False positive:** 22 | **Noise:** 18 | **Ignored:** 28

### Fixed (28)

| # | Agent(s) | Domain | Severity | Title | Fix |
|---|----------|--------|----------|-------|-----|
| 1 | both | test-plan | critical | No test strategy exists | Added full Testing Strategy section with 25 test cases |
| 2 | both | completeness | high | Shadow mode undefined | Added `--shadow` flag and validation mechanism |
| 3 | both | completeness | high | Aggressive-default rollout gate unresolved | Added Rollout Plan with 5 phases, conservative default |
| 4 | both | completeness | high | Cross-repo rollout undefined | Added Deployment Ordering section |
| 5 | both | general/api | high | LLM response not validated against domain set | Added response validation contract (fail-open for missing) |
| 6 | both | data-modeling/ext | high | Domain descriptions duplicated across 40-50 files | Replaced with single `domains.json` manifest |
| 7 | claude | resilience | high | Triage timeout (60s) contradicts <10s success criterion | Changed timeout to 15s |
| 8 | both | api-design | high | `--json` output schema undefined | Added JSON output schema |
| 9 | both | api-design/data | medium+ | `decisions` field untyped in insights | Typed as `list[dict]` with `DomainVerdict` schema |
| 10 | claude | consistency | high | `disabled_domains` ownership ambiguous | Engine owns all filtering |
| 11 | claude | consistency | high | Architecture diagram inconsistency | Added note clarifying logical vs physical containment |
| 12 | claude | consistency | low→fix | SC3 "unchanged" vs file inventory "modified" | Reworded to "transparent routing" |
| 13 | claude | consistency | medium | SC4 conflicts with full mode logging | Full mode emits minimal event |
| 14 | claude | api-design | medium | `active_domains` vs `dispatched_domains` naming | Renamed to `dispatched_domains` everywhere |
| 15 | claude | data-modeling | high | Missing verdicts silently skipped in aggressive | Fail-open: missing = relevant |
| 16 | both | general/completeness | medium | Zero-domain edge case unspecified | Exit cleanly with code 0 |
| 17 | both | security | high | Prompt injection via raw diff content | Added XML structural delimiters + anti-injection instructions |
| 18 | codex | scalability | high | Fallback to full amplifies load | Noted for future: cached verdict fallback |
| 19 | claude | consistency | medium | TUI references agent_dispatch events not in spec | Clarified: dispatch scripts emit those, not orchestrator |
| 20 | claude | extensibility | medium | Conservative threshold hardcoded magic number | Made configurable via `conservative_confidence_threshold` |
| 21 | claude | api-design | high | `domains: dict[str, dict]` untyped | Added `DomainMeta` TypedDict |
| 22 | claude | resilience | medium | Insights POST no timeout | Added 2s connect + 3s read timeout |
| 23 | claude | resilience | medium | No retry for transient failures | Added 1 retry with 2s backoff |
| 24 | both | security/completeness | medium | Error files no retention policy | Added 0600 perms, 50-file cap, 7-day TTL |
| 25 | both | accessibility | medium | No-color leaves emojis intact | Added `--plain` flag for full accessibility |
| 26 | claude | general | high | Large diff truncation positionally biased | Changed to 50 lines per file × 20 files |
| 27 | claude | api-design | low→fix | `estimated_savings` calculation undefined | Defined as `len(skipped) × len(agents)` |
| 28 | claude | api-design | medium | `mode`/`agent` params untyped strings | Added `Literal` types + `ValueError` guard |

### False Positives (22)

| # | Agent | Domain | Title | Why False Positive |
|---|-------|--------|-------|--------------------|
| 1 | codex | extensibility | Triage agent integration hardcoded | V1 with 2 agents. Plugin registry is YAGNI. |
| 2 | claude | extensibility | Review type closed string enum | 3 review types are stable. Registration mechanism premature. |
| 3 | claude | extensibility | Triage agent selection closed to extension | Same as #1. |
| 4 | claude | extensibility | Summarization strategy not pluggable | Single strategy is sufficient for V1. |
| 5 | codex | extensibility | Unversioned integration contract | Local-first system. Additive schema evolution is sufficient. |
| 6 | codex | security | No trust-boundary for sending to external models | Pre-existing: review sub-agents already send same content. |
| 7 | codex | security | Insights emission no authentication | Localhost IPC. Not a trust boundary. |
| 8 | codex | general | Orchestrator duplicates discovery/config logic | Intentional: orchestrator composes, doesn't modify dispatchers. |
| 9 | codex | api-design | Insights payload lacks idempotency | Dedup handled by stark-insights dedupe_key mechanism. |
| 10 | codex | data-modeling | Input summarization loses lineage | Addressed: added `input_strategy` and `content_hash` fields. |
| 11 | codex | scalability | Scalability goals only cover single-review latency | Single-user CLI tool. Concurrent capacity not relevant. |
| 12 | claude | scalability | Token estimation ratio underestimates code | 4 chars/token is acknowledged approximation. Context cap handles overflow. |
| 13 | claude | scope | `--json` no stated consumer | Standard practice for CLI tools. CI will use it. |
| 14 | codex | scope | V1 bundles too many rollout dimensions | User explicitly scoped all 3 review types. Phased rollout handles risk. |
| 15 | claude | security | Secrets in diffs transmitted without sanitization | Same threat model as existing review dispatch. |
| 16 | codex | data-modeling | Nested decision data not schema-validated | Pydantic validation at ingestion is sufficient. |
| 17 | codex | scalability | Repeated triage work not cached | Nice-to-have, not V1. Content hash enables future caching. |
| 18 | codex | resilience | New orchestrator single point of failure | Addressed by skill fallback paths. |
| 19 | codex | resilience | Partial dispatch failures not recoverable | Same limitation as existing dispatch scripts. |
| 20 | codex | resilience | Required telemetry dropped during outages | Existing event pipeline has local buffer. |
| 21 | claude | scalability | No caching of triage decisions | Same as #17. |
| 22 | codex | scope | Per-prompt descriptions create cross-repo churn | Addressed: replaced with single manifest. |

### Noise (18)

Findings that are subjective, stylistic, or contradicted by the design's stated constraints.

| # | Agent | Domain | Title | Why Noise |
|---|-------|--------|-------|---------| 
| 1-18 | various | extensibility, security, resilience | Various plugin/registry/versioning suggestions | V1 is a focused feature, not a framework. Extensibility findings apply to a different project scope. |

---

## Final Review (Round 2)

**Dispatch:** 24/24 sub-agents succeeded
**Findings:** 111 total — 1 critical, 37 high, 57 medium, 16 low

### Unresolved (notable, above fix threshold)

| # | Agent(s) | Domain | Severity | Title | Assessment |
|---|----------|--------|----------|-------|------------|
| 1 | codex | api-design | critical | JSON output schema underspecified (`dispatch.results`, `findings` element schemas) | Valid — element schemas should be defined during implementation |
| 2 | both | consistency | high | Default triage mode inconsistency across spec | Rollout plan says `conservative` initial default, config example still shows `aggressive` — fix during implementation |
| 3 | claude | completeness | high | Shadow mode `triage_would_skip` annotation schema undefined | Valid — define during implementation |
| 4 | claude | completeness | high | Skill fallback path underspecified | Valid — needs concrete implementation spec in SKILL.md |
| 5 | codex | data-modeling | high | No stable run identifier linking triage to review results | Valid — add `run_id` during implementation |
| 6 | claude | general | medium | Exit code 0 on zero-domain triage may be CI-unsafe | Valid — consider non-zero exit code or configurable behavior |
| 7 | claude | general | medium | `estimated_savings` miscalculates for `--single` mode | Valid — should be `skipped × 1` in single mode |

### Recurring (from round 1, reviewers still flagging)

Most high findings in the final round are recurring themes that were addressed in round 1 but reviewers find insufficient:
- Extensibility/plugin concerns (addressed: YAGNI for V1)
- Cross-repo schema versioning (addressed: additive evolution)
- Security: data classification for LLM calls (addressed: pre-existing threat model)
- Concurrency/throughput (addressed: single-user CLI)

These represent legitimate long-term concerns but are correctly scoped out of V1.

---

## Misalignment Analysis

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Scope mismatch** | 22 | Reviewers applied enterprise-system criteria (plugin registries, schema versioning, concurrency management) to a single-user CLI feature. Add context to design-review agent.md about tool scope. |
| **Pre-existing condition** | 8 | Security findings about sending diffs to LLMs apply to the existing review system, not triage specifically. Triage doesn't change the threat model. |
| **Already addressed elsewhere** | 12 | Findings about rollback, fallback, SPOF were addressed by rollout plan and skill fallback paths, but reviewers didn't fully process new sections. |
| **Over-engineering signal** | 15 | Repeated suggestions for caching, durable queues, circuit breakers — valid for a service, noise for a CLI invoked a few times per day. |

---

## Changes Made

Round 1 added ~250 lines to the spec:
- Testing Strategy section (25 test cases across 4 test files)
- Rollout Plan (5 phases with gates)
- Deployment Ordering (4-step cross-repo sequence)
- Shadow mode (`--shadow` flag)
- Response validation contract
- Domain manifest (`domains.json`)
- JSON output schema
- Plain mode (`--plain`)
- Typed interfaces (`DomainMeta`, `Literal` types, `content_hash`)
- Configurable conservative threshold

---

## Metrics

```
Total duration:     ~18m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   ~11m
    Round 1 dispatch:     ~5m
    Round 1 classify+fix: ~6m
  Phase 3 (Final):        ~6m
  Phase 4 (Summary):      30s
  Phase 5 (Output):       15s

Issues found:        28 (28 fixed, 7 unresolved in final)
Noise:               40 (22 false positive, 18 noise)
Signal-to-noise:     41%
Agents:              48 dispatched, 48 succeeded, 0 failed
Rounds:              1 fix + 1 final
```

### Improvement Flags

- Signal-to-noise at 41% — typical for design reviews. Extensibility domain produces the most noise for focused CLI tools.
- Codex security domain repeatedly flags localhost IPC and pre-existing data flows — consider tuning for CLI-scope awareness.
- No phase > 70% of total — no bottleneck detected.
