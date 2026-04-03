# Test Plan — Validation Gate & Heal Locks (P1-1)

## Scope

Covers the following deliverables from the `autopilot/claude/p1-1-validation-heal-locks` branch:

| File | Role |
|------|------|
| `scripts/validation_gate.py` | Runs lint/typecheck/test per repo config or discovery |
| `scripts/failure_classifier.py` | Classifies stderr into canonical failure categories |
| `scripts/healer_patterns.json` | Pattern definitions used by the healer |
| `scripts/emit_queue.py` (modified) | Added `validation_result`, `heal_attempt` event types |

---

## Test Files

| File | Tests | Status |
|------|-------|--------|
| `tests/test_validation_gate.py` | 41 | Passing |
| `tests/test_failure_classifier.py` | 39 | Passing |
| `tests/test_failure_classifier.py::TestHealerPatternsSchema` | 6 | Passing |
| `tests/test_failure_classifier.py::TestCrossComponentIntegration` | 4 | Passing |

---

## Coverage by Component

### validation_gate.py — Complete

| Area | Tests present |
|------|--------------|
| `_get_repo_name` — strip `.git`, HTTPS, SSH, no remote, not a git dir, trailing slash | Yes |
| `_discover_commands` — package.json, Makefile, pytest.ini, pyproject.toml, priority order, nothing | Yes |
| `_run_check` — pass, fail (lint/typecheck/test), None command, timeout, stdout/stderr capture, subprocess exception | Yes |
| `_write_stderr_log` — creates file, includes stderr, skips empty, timestamp filename, creates missing dir | Yes |
| `_emit` — calls make_event + enqueue, correct payload, swallows exceptions | Yes |
| `run_validation_gate` config mode — test/lint/typecheck, skip None cmd, overall fail, default fallback, result struct | Yes |
| `run_validation_gate` discovery mode — no markers=pass, pytest.ini, security rejected | Yes |
| `run_validation_gate` overall edge — TEST_COMMAND_MISSING excluded from overall | Yes |
| CLI — `--json`, table output, `--timeout` from arg, `--timeout` from config, always exits 0 | Yes |
| emit_queue schema — `validation_result` and `heal_attempt` types accepted | Yes |

### failure_classifier.py — Complete

| Test case | Expected category | Confidence |
|-----------|------------------|------------|
| `401 Unauthorized` | AUTH_STALE | 1.0 |
| `403 Forbidden` | AUTH_STALE | 1.0 |
| `Bad credentials` | AUTH_STALE | 1.0 |
| `ModuleNotFoundError: No module named 'foo'` | MISSING_IMPORT | 1.0 |
| `ImportError: cannot import name X` | MISSING_IMPORT | 1.0 |
| `SyntaxError: invalid syntax` | SYNTAX_ERROR | 1.0 |
| `IndentationError: unexpected indent` | SYNTAX_ERROR | 1.0 |
| `TypeError: expected str, got int` | TYPE_ERROR | 1.0 |
| `type mismatch in argument` (regex) | TYPE_ERROR | 0.7 |
| `alembic revision conflict` (regex) | MIGRATION_CONFLICT | 0.7 |
| `rate limit exceeded` | RESOURCE_EXHAUSTED | 1.0 |
| `quota exceeded` | RESOURCE_EXHAUSTED | 1.0 |
| `429 Too Many Requests` | RESOURCE_EXHAUSTED | 1.0 |
| Empty string | UNCLASSIFIED | 0.5 |
| Whitespace-only string | UNCLASSIFIED | 0.5 |
| No matching patterns | UNCLASSIFIED | 0.5 |
| Priority: AUTH_STALE beats MISSING_IMPORT (both present) | AUTH_STALE | — |
| `result["recommended_action"]` is present and non-empty for every category | — | — |
| `_log_result` writes to healer.jsonl with correct fields | — | — |
| CLI: `--stderr-file` with valid file → human-readable output | — | — |
| CLI: `--stderr-file` with valid file + `--json` → valid JSON | — | — |
| CLI: `--stderr-file` missing → exits 1 | — | — |

### healer_patterns.json — Schema validation complete

| Check | Status |
|-------|--------|
| Each entry has `id`, `category`, `regex`, `action`, `requires_confirmation` | Passing |
| `regex` is a valid regex string | Passing |
| `action` is one of the known action types | Passing |
| Every `category` in the JSON maps to a category in `failure_classifier.CATEGORIES` | Passing |
| `id` values are unique | Passing |
| `requires_confirmation` is boolean | Passing |

### Cross-component integration — Complete

| Test | Status |
|------|--------|
| AUTH_STALE category has a matching healer pattern | Passing |
| SYNTAX_ERROR category has a matching healer pattern | Passing |
| validation_gate stderr → failure_classifier → healer lookup pipeline | Passing |
| self_healer._emit_event() enqueues heal_attempt event end-to-end | Passing |

---

## How to Run

```bash
# All new tests
python3 -m pytest tests/test_validation_gate.py tests/test_failure_classifier.py -v

# Full test suite
python3 -m pytest tests/ -v
```

Both test files are isolated and side-effect-free (`tmp_path` / `monkeypatch` fixtures prevent
writes to `~/.claude`). Suitable for CI without sandboxing.
