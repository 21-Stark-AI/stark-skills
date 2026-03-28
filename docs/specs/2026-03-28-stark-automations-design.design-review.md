# Design Review — stark-automations

**File:** `docs/specs/2026-03-28-stark-automations-design.md`
**Mode:** standard (2 agents × 10 domains)
**Rounds:** 2 fix + 1 final

---

**Issues found:** 60 (48 fixed R1, 12 fixed R2) | **Unresolved:** 8
**Noise:** 148 (false positive + scope creep + noise) | **Ignored:** 77 (low severity)
**Signal-to-noise:** 29% (60 / 208)

---

## Fixed — Round 1 (48 issues)

| # | Agent(s) | Domain | Severity | Title | Section |
|---|----------|--------|----------|-------|---------|
| 1 | both | data-modeling, resilience, security, general, completeness | critical/high | Lock TTL / stale lock recovery | 3.4 |
| 2 | both | consistency, scope, api-design, general | critical/high | Invocation model: Pub/Sub vs HTTP contradiction | 2.6, 4.5, 5.2 |
| 3 | both | api-design, data-modeling | high | Schema versioning missing on persisted JSON | 3.1, 3.2, 3.5 |
| 4 | both | data-modeling, consistency | high | Run status vocabulary inconsistent | 3.3 |
| 5 | both | security, general, completeness | high | Shell sandbox: binaries not provisioned, curl bypass, awk/sed risk | 5.5 |
| 6 | both | security, general | high | gcs_write tool: model-controlled path traversal / artifact tampering | 4.3, 4.4 |
| 7 | both | api-design, security | high | GitHub API: no GraphQL, no DELETE, no path enforcement | 4.3 |
| 8 | both | api-design, completeness | high | Manual trigger: missing request_id, weak auth | 4.5 |
| 9 | both | resilience | high | Retry: no jitter, no circuit breaker, no dead-letter | 6.7 |
| 10 | codex | api-design | high | Tool output schemas undefined | 4.3 |
| 11 | claude | completeness | high | Shadow mode acceptance criteria missing | 8 |
| 12 | codex | general | medium | Slack single webhook vs channel routing mismatch | 5.4 |
| 13 | codex | general | high | Prompt portability: no validation gate | 1 |
| 14 | claude | consistency | medium | Prompt fallback self-contradiction | 6.7 |
| 15 | both | consistency | medium | Alert behavior: single failure vs consecutive | 6.5 |
| 16 | claude | consistency | high | Tool naming mismatch (section 2.4 vs 4.3) | 2.4 |
| 17 | codex | resilience | high | GitHub as fleet-wide SPOF | 1 |
| 18 | both | scope | medium/high | gcs_write tool exposed unnecessarily to model | 4.3 |
| 19 | codex | consistency | medium | Run count 32/week vs 45/week mismatch | 6.6 |
| 20 | codex | resilience | medium | Timeout budget for external calls undefined | 6.7 |

## Fixed — Round 2 (12 issues)

| # | Agent(s) | Domain | Severity | Title | Section |
|---|----------|--------|----------|-------|---------|
| 21 | both | resilience, general | high | Retry budget (985s) exceeds function timeout (540s) | 6.7 |
| 22 | both | security | high | Shell builtins eval/exec/source bypass allowlist | 5.5 |
| 23 | both | security | high | gh CLI in allowlist bypasses github_api policy | 5.5 |
| 24 | both | general | high | Lock race condition on concurrent stale recovery | 3.4 |
| 25 | codex | data-modeling | critical | Stale lock recovery can replay completed side effects | 3.4 |
| 26 | claude | data-modeling | high | Error object schema undefined | 3.2 |
| 27 | claude | data-modeling | high | Lock object schema undefined | 3.4 |
| 28 | codex | consistency | high | Scheduler IAM references cloudfunctions.invoker (wrong) | 5.3 |
| 29 | codex | api-design | high | github_api required fields not machine-enforceable | 4.3 |
| 30 | claude | resilience | high | Failure alerting depends entirely on Slack | 6.5 |
| 31 | codex | resilience | high | Pub/Sub delivery policy: no dead-letter topic | 6.7 |
| 32 | claude | api-design | high | Dry-run doesn't close gh CLI write path | 4.6 |

## Unresolved (8 issues — final round)

These are genuine findings that remain after 2 fix rounds. Most relate to shell sandbox edge cases and are documented as known v1 limitations.

| # | Agent(s) | Domain | Severity | Title | Section | Rationale |
|---|----------|--------|----------|-------|---------|-----------|
| U1 | claude | security | critical | `find -exec` bypasses binary allowlist | 5.5 | Addressed: added `-exec`/`-execdir` blocking to parser rules |
| U2 | claude | security | high | Command substitution `$(...)` can escape sandbox | 5.5 | Addressed: added to blocked patterns |
| U3 | claude | security | high | Symlink-based workspace escape | 5.5 | Addressed: symlink resolution before path check |
| U4 | both | security | high | iptables/nftables won't work on gVisor | 5.5 | Addressed: removed iptables claim, documented gVisor limitations |
| U5 | codex | security | high | Unrestricted git in shell defeats repo boundaries | 5.5 | Addressed: git restricted via GIT_CONFIG_GLOBAL |
| U6 | codex | security | high | Free-form GraphQL not actually constrained | 5.6 | Known limitation: GraphQL repo scoping is best-effort |
| U7 | claude | general | high | gVisor does not restrict metadata server by default | 5.5 | Documented: shell sandbox is not the primary security boundary |
| U8 | codex | data-modeling | critical | Lock storage model conflicts with dedupe key for concurrent runs | 3.4 | Accepted: race window is narrow, side-effect replay risk documented |

Note: U1-U5 were addressed with a final fix pass after the final review. U6-U8 are genuinely unresolved and documented as known v1 limitations.

## Noise & False Positives (148 findings)

### Root Cause Analysis

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Scope creep — v2+ concerns applied to v1** | 52 | Reviewers flagged API versioning, multi-provider support, BigQuery analytics, general-purpose sandbox, and Grafana dashboards — all explicitly out of v1 scope. Prompts should include v1 scope constraints. |
| **Over-engineering for scale** | 31 | Fleet runs 32 times/week. Findings about rate limiting, load shedding, priority queuing, and horizontal scaling are noise at this scale. Prompts should calibrate to stated volume. |
| **Repeated across domains** | 28 | Same finding (e.g., "shell sandbox insufficient") surfaced in security, general, completeness, and resilience. Dedup across domains would reduce noise significantly. |
| **Stylistic/structural preferences** | 22 | Missing ADR format, section ordering, naming conventions. Not actionable design issues. |
| **Already addressed in design** | 15 | Findings about issues the design explicitly addresses in a different section. Cross-reference awareness in prompts would help. |

## Changes Made

- **Round 1:** 890 → 1001 lines (+111 lines, 48 issues fixed)
- **Round 2:** 1001 → 1043 lines (+42 lines, 12 issues fixed)
- **Post-final fix:** Shell sandbox section rewritten with concrete parser rules and gVisor limitations

Key structural changes:
- Added Section 2.6 (Invocation Model) clarifying Pub/Sub-only architecture
- Added Section 3.3 (Run Status Enum) with canonical status values
- Rewrote Section 3.4 (Idempotency) with TTL-based lock recovery
- Removed `gcs_write` from model-facing tools (Section 4.3)
- Rewrote Section 4.5 (Manual Trigger) to use Pub/Sub path
- Rewrote Section 5.5 (Shell Sandboxing) with concrete parser, blocked builtins, network reality
- Rewrote Section 6.7 (Retry Strategy) with jitter, timeout budgets, dead-letter
- Added schema versioning to all persisted JSON

## Prompt Improvement Assessment

| Signal | Level | File | Recommendation |
|--------|-------|------|----------------|
| Both agents generate excessive scope-creep findings for v1 designs | Global | `global/prompts/design-review/*/scope.md` | Add instruction: "Calibrate findings to the design's stated scope and scale. Do not flag v2 concerns as issues." |
| Same finding appears in 3-4 domains per agent | Global | All domain prompts | Add instruction: "If a finding is primarily about another domain (e.g., security finding in completeness), note it briefly and defer to that domain's review." |
| Claude generates 82 findings vs codex's 49 (R1) — Claude is noisier | Global | `global/prompts/design-review/claude/` | Tighten Claude's severity calibration. Add: "A finding is high only if it would block implementation or cause a production incident." |
| Shell sandbox generates findings across 5+ domains | Repo config | `design_review.domain_mapping` | Consider disabling `extensibility` and `scalability` domains for infrastructure designs where these are less relevant. |
