# Test Plan — P1-1: Validation Gate & Heal Locks

## Scope

New components introduced in this branch:

| Component | File | Status |
|-----------|------|--------|
| Validation gate runner | `scripts/validation_gate.py` | Tests exist (2 locations) |
| Failure classifier | `scripts/failure_classifier.py` | **No tests** |
| Healer patterns config | `scripts/healer_patterns.json` | **No tests** |
| Event schema additions | `scripts/emit_queue.py` | Tests exist (schema only) |

---

## What's Already Covered

### validation_gate.py

Two test files exist. `scripts/test_validation_gate.py` (co-located) and `tests/test_validation_gate.py` (standard layout). Coverage is broad:

- `_get_repo_name`: SSH URLs, HTTPS URLs, no remote, not a git repo, trailing slash, subprocess exception
- `_discover_commands`: all 4 markers, priority ordering, empty dir, allowlist invariant
- `_run_check`: pass/fail/lint/typecheck/timeout/stdout+stderr capture/none-command/subprocess exception
- `_write_stderr_log`: creates file, includes stderr, skips empty, filename format, creates dir
- `_emit`: event fields, exception swallowed
- `run_validation_gate` (config mode): all 3 commands, skip missing, repo-specific beats default, fail propagation, discovery fallback, result structure, stdout/stderr stripped from public result
- `run_validation_gate` (discovery mode): no markers → pass, pytest.ini, security rejected
- CLI: JSON output, table output, timeout from CLI, timeout from config, always exits 0

The two test files are largely parallel but `tests/test_validation_gate.py` has better isolation (`monkeypatch` instead of `patch.object` for `_LOG_DIR`) and uses cleaner `with` stacking syntax (Python 3.10+). `scripts/test_validation_gate.py` is the simpler version with real subprocess invocations for `_get_repo_name` tests.

### emit_queue.py

`test_validation_result_accepted` and `test_heal_attempt_accepted` verify the new types pass schema validation. That's correct and sufficient for this layer.

---

## Gaps — Gaps That Need Tests

### 1. `failure_classifier.py` — No test file exists

The classifier has non-trivial logic: priority ordering between categories, regex vs. literal match, confidence levels, empty input edge case, and logging side effect.

Minimum test cases needed:

| Test | Purpose |
|------|---------|
| `classify("")` returns `UNCLASSIFIED` | Empty input guard |
| `classify("401 Unauthorized")` returns `AUTH_STALE` | Literal match |
| `classify("ModuleNotFoundError: No module named 'foo'")` returns `MISSING_IMPORT` | Literal match |
| `classify("SyntaxError: invalid syntax")` returns `SYNTAX_ERROR` | Literal match |
| `classify("alembic heads revision conflict")` returns `MIGRATION_CONFLICT` with confidence 0.7 | Regex match + confidence |
| `classify("rate limit exceeded")` returns `RESOURCE_EXHAUSTED` | Literal match |
| `classify("some unknown garbage")` returns `UNCLASSIFIED` | No match |
| AUTH_STALE matched before MISSING_IMPORT when both present | Priority ordering |
| Regex match produces `confidence=0.7`, literal produces `confidence=1.0` | Confidence levels |
| `_log_result` does not raise on any input | Side-effect safety |
| CLI: `--stderr-file` with missing file exits 1 | CLI error handling |
| CLI: `--json` flag produces parseable JSON with required keys | CLI output format |

### 2. `healer_patterns.json` — Schema invariants untested

The JSON is consumed by automation that pattern-matches on `category`, `action`, and `regex`. No test currently validates the file's structure. A schema test should assert:

- Every entry has: `id`, `category`, `regex`, `action`, `requires_confirmation`
- `category` values match the canonical set from `failure_classifier.CATEGORIES`
- `regex` values compile without error
- `id` values are unique
- `action` values are from a known enum (`refresh_token`, `add_import`, `fix_syntax`, `resolve_migration_head`, `release_stale_lock`)

### 3. Cross-component integration — Missing

No test exercises the full path: `validation_gate` failure → `failure_classifier.classify(stderr)` → healer lookup in `healer_patterns.json`. This integration is the entire point of the feature. A single integration test should:

1. Run `run_validation_gate` with a command that produces recognizable stderr
2. Pass the resulting `stderr_path` to `failure_classifier.classify`
3. Verify the category matches a pattern in `healer_patterns.json`

---

## Duplicate Test File Decision

`scripts/test_validation_gate.py` and `tests/test_validation_gate.py` cover the same module. One must be removed. Recommendation: **keep `tests/test_validation_gate.py`** (standard layout, better isolation, no real subprocess calls in most tests) and delete `scripts/test_validation_gate.py`. The real-subprocess `_get_repo_name` tests in `scripts/` should be ported to `tests/` as an `@pytest.mark.integration` group if they're considered worth keeping.

---

## Test Execution

```bash
# From repo root
python3 -m pytest tests/test_validation_gate.py -v

# After adding failure_classifier tests:
python3 -m pytest tests/ -v
```

No mocking of subprocess is needed in `_run_check` tests — `true` and `false` are safe, fast, and portable.

---

## Not In Scope

- `emit_queue` drain/HTTP delivery — covered by existing tests elsewhere
- GitHub App auth / token refresh — separate component
- Autopilot dispatch wiring — tested at the skill integration level, not here
