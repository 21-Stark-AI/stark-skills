"""Tests for scripts/failure_classifier.py and healer_patterns.json."""
from __future__ import annotations

import json
import pathlib
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import failure_classifier
from failure_classifier import CATEGORIES, _log_result, classify


# ---------------------------------------------------------------------------
# classify()
# ---------------------------------------------------------------------------


class TestClassify:
    # Empty / whitespace
    def test_empty_string(self):
        r = classify("")
        assert r["category"] == "UNCLASSIFIED"
        assert r["confidence"] == 0.5
        assert r["recommended_action"] == "inspect stderr manually"

    def test_whitespace_only(self):
        r = classify("   \n\t  ")
        assert r["category"] == "UNCLASSIFIED"
        assert r["confidence"] == 0.5

    def test_no_match_returns_unclassified(self):
        r = classify("some unknown garbage that matches nothing special")
        assert r["category"] == "UNCLASSIFIED"
        assert r["confidence"] == 0.5
        assert r["pattern_id"] is None

    # AUTH_STALE — literal matches
    def test_401_unauthorized(self):
        r = classify("HTTP 401 Unauthorized")
        assert r["category"] == "AUTH_STALE"
        assert r["confidence"] == 1.0

    def test_403_forbidden(self):
        r = classify("403 Forbidden access denied")
        assert r["category"] == "AUTH_STALE"
        assert r["confidence"] == 1.0

    def test_bad_credentials(self):
        r = classify("Error: Bad credentials")
        assert r["category"] == "AUTH_STALE"
        assert r["confidence"] == 1.0

    # MISSING_IMPORT
    def test_module_not_found_error(self):
        r = classify("ModuleNotFoundError: No module named 'foo'")
        assert r["category"] == "MISSING_IMPORT"
        assert r["confidence"] == 1.0

    def test_import_error(self):
        r = classify("ImportError: cannot import name X from bar")
        assert r["category"] == "MISSING_IMPORT"
        assert r["confidence"] == 1.0

    def test_no_module_named(self):
        r = classify("No module named 'requests'")
        assert r["category"] == "MISSING_IMPORT"
        assert r["confidence"] == 1.0

    # SYNTAX_ERROR
    def test_syntax_error(self):
        r = classify("SyntaxError: invalid syntax")
        assert r["category"] == "SYNTAX_ERROR"
        assert r["confidence"] == 1.0

    def test_indentation_error(self):
        r = classify("IndentationError: unexpected indent")
        assert r["category"] == "SYNTAX_ERROR"
        assert r["confidence"] == 1.0

    # TYPE_ERROR — literal
    def test_type_error_literal(self):
        r = classify("TypeError: expected str, got int")
        assert r["category"] == "TYPE_ERROR"
        assert r["confidence"] == 1.0

    # TYPE_ERROR — regex (confidence 0.7)
    def test_type_mismatch_regex(self):
        r = classify("type mismatch in argument 'foo'")
        assert r["category"] == "TYPE_ERROR"
        assert r["confidence"] == 0.7

    # MIGRATION_CONFLICT — regex (confidence 0.7)
    def test_alembic_revision_regex(self):
        r = classify("alembic revision heads conflict detected")
        assert r["category"] == "MIGRATION_CONFLICT"
        assert r["confidence"] == 0.7

    # RESOURCE_EXHAUSTED
    def test_rate_limit(self):
        r = classify("rate limit exceeded, please retry later")
        assert r["category"] == "RESOURCE_EXHAUSTED"
        assert r["confidence"] == 1.0

    def test_quota_exceeded(self):
        r = classify("quota exceeded for this project")
        assert r["category"] == "RESOURCE_EXHAUSTED"
        assert r["confidence"] == 1.0

    def test_429_too_many_requests(self):
        r = classify("429 Too Many Requests from the API")
        assert r["category"] == "RESOURCE_EXHAUSTED"
        assert r["confidence"] == 1.0

    # Priority ordering
    def test_auth_stale_beats_missing_import(self):
        stderr = "401 Unauthorized\nModuleNotFoundError: No module named 'x'"
        r = classify(stderr)
        assert r["category"] == "AUTH_STALE"

    # Confidence levels
    def test_literal_match_confidence_is_1(self):
        r = classify("SyntaxError: invalid syntax")
        assert r["confidence"] == 1.0

    def test_regex_match_confidence_is_0_7(self):
        r = classify("type mismatch in the code")
        assert r["confidence"] == 0.7

    # Result structure invariants
    def test_recommended_action_present_for_all_categories(self):
        sample = {
            "AUTH_STALE": "401",
            "MISSING_IMPORT": "ModuleNotFoundError",
            "SYNTAX_ERROR": "SyntaxError",
            "TYPE_ERROR": "TypeError",
            "MIGRATION_CONFLICT": "alembic revision conflict",
            "RESOURCE_EXHAUSTED": "rate limit exceeded",
            "UNCLASSIFIED": "",
        }
        for expected_cat, text in sample.items():
            r = classify(text)
            assert r["recommended_action"], f"{expected_cat}: recommended_action is empty"

    def test_pattern_id_set_for_known_literal(self):
        r = classify("Bad credentials")
        assert r["pattern_id"] == "auth-stale"

    def test_pattern_id_none_for_unclassified(self):
        r = classify("some unknown garbage")
        assert r["pattern_id"] is None


# ---------------------------------------------------------------------------
# _log_result()
# ---------------------------------------------------------------------------


class TestLogResult:
    def test_does_not_raise_on_normal_input(self):
        result = {
            "category": "AUTH_STALE",
            "confidence": 1.0,
            "pattern_id": "auth-stale",
            "recommended_action": "refresh",
        }
        _log_result(result, "test.log")  # must not raise

    def test_writes_jsonl_entry(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        result = {
            "category": "SYNTAX_ERROR",
            "confidence": 1.0,
            "pattern_id": "syntax-error",
            "recommended_action": "fix",
        }
        _log_result(result, "/tmp/err.log")
        log_file = tmp_path / ".claude" / "code-review" / "healer.jsonl"
        assert log_file.exists()
        entry = json.loads(log_file.read_text().strip())
        assert entry["category"] == "SYNTAX_ERROR"
        assert entry["stderr_file"] == "/tmp/err.log"
        assert "timestamp" in entry

    def test_swallows_io_error(self, monkeypatch):
        def fail_mkdir(self, *args, **kwargs):
            raise IOError("disk full")

        monkeypatch.setattr(pathlib.Path, "mkdir", fail_mkdir)
        result = {
            "category": "UNCLASSIFIED",
            "confidence": 0.5,
            "pattern_id": None,
            "recommended_action": "inspect",
        }
        _log_result(result, "x")  # must not raise


# ---------------------------------------------------------------------------
# healer_patterns.json schema
# ---------------------------------------------------------------------------


class TestHealerPatternsSchema:
    @pytest.fixture(scope="class")
    def patterns(self):
        patterns_path = Path(__file__).parent.parent / "scripts" / "healer_patterns.json"
        return json.loads(patterns_path.read_text())

    def test_all_entries_have_required_fields(self, patterns):
        required = {"id", "category", "regex", "action", "requires_confirmation"}
        for entry in patterns:
            missing = required - entry.keys()
            assert not missing, f"Entry '{entry.get('id')}' missing fields: {missing}"

    def test_ids_are_unique(self, patterns):
        ids = [p["id"] for p in patterns]
        duplicates = [x for x in ids if ids.count(x) > 1]
        assert not duplicates, f"Duplicate IDs: {duplicates}"

    def test_all_regex_compile(self, patterns):
        import re

        for entry in patterns:
            try:
                re.compile(entry["regex"])
            except re.error as e:
                pytest.fail(
                    f"Pattern '{entry['id']}' has invalid regex '{entry['regex']}': {e}"
                )

    def test_categories_match_classifier(self, patterns):
        valid_categories = {c["name"] for c in CATEGORIES}
        for entry in patterns:
            assert entry["category"] in valid_categories, (
                f"Pattern '{entry['id']}' has unknown category '{entry['category']}'. "
                f"Valid: {sorted(valid_categories)}"
            )

    def test_actions_are_known(self, patterns):
        known_actions = {
            "refresh_token",
            "add_import",
            "fix_syntax",
            "resolve_migration_head",
            "release_stale_lock",
        }
        for entry in patterns:
            assert entry["action"] in known_actions, (
                f"Pattern '{entry['id']}' has unknown action '{entry['action']}'. "
                f"Known: {sorted(known_actions)}"
            )

    def test_requires_confirmation_is_bool(self, patterns):
        for entry in patterns:
            assert isinstance(entry["requires_confirmation"], bool), (
                f"Pattern '{entry['id']}': requires_confirmation must be bool, "
                f"got {type(entry['requires_confirmation']).__name__}"
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestFailureClassifierCLI:
    def test_missing_file_exits_1(self, tmp_path, capsys):
        nonexistent = str(tmp_path / "no-such-file.txt")
        with patch("sys.argv", ["failure_classifier.py", "--stderr-file", nonexistent]):
            with pytest.raises(SystemExit) as exc:
                failure_classifier.main()
        assert exc.value.code == 1

    def test_json_output_has_required_keys(self, tmp_path, capsys):
        stderr_file = tmp_path / "err.txt"
        stderr_file.write_text("SyntaxError: invalid syntax")
        with (
            patch("sys.argv", ["failure_classifier.py", "--stderr-file", str(stderr_file), "--json"]),
            patch.object(failure_classifier, "_log_result"),
        ):
            failure_classifier.main()
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["category"] == "SYNTAX_ERROR"
        assert data["confidence"] == 1.0
        assert "recommended_action" in data
        assert "stderr_excerpt" in data

    def test_human_output(self, tmp_path, capsys):
        stderr_file = tmp_path / "err.txt"
        stderr_file.write_text("401 Unauthorized")
        with (
            patch("sys.argv", ["failure_classifier.py", "--stderr-file", str(stderr_file)]),
            patch.object(failure_classifier, "_log_result"),
        ):
            failure_classifier.main()
        captured = capsys.readouterr()
        assert "AUTH_STALE" in captured.out
        assert "Category" in captured.out
        assert "Confidence" in captured.out


# ---------------------------------------------------------------------------
# Cross-component integration
# ---------------------------------------------------------------------------


class TestCrossComponentIntegration:
    """Full path: classify stderr → look up in healer_patterns.json."""

    def _load_patterns(self):
        patterns_path = Path(__file__).parent.parent / "scripts" / "healer_patterns.json"
        return json.loads(patterns_path.read_text())

    def test_auth_stale_has_healer_pattern(self):
        result = classify("Error: 401 Unauthorized")
        assert result["category"] == "AUTH_STALE"
        patterns = self._load_patterns()
        assert any(p["category"] == "AUTH_STALE" for p in patterns)

    def test_syntax_error_has_healer_pattern(self):
        result = classify("SyntaxError: invalid syntax")
        assert result["category"] == "SYNTAX_ERROR"
        patterns = self._load_patterns()
        assert any(p["category"] == "SYNTAX_ERROR" for p in patterns)

    def test_validation_gate_failure_classifiable(self, tmp_path, monkeypatch):
        """Stderr written by validation_gate can be classified by failure_classifier."""
        import validation_gate

        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path)

        config = {
            "validation_gate": {
                "per_repo_commands": {
                    "myrepo": {"test_cmd": "echo '401 Unauthorized' >&2; false"}
                }
            }
        }
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            vg_result = validation_gate.run_validation_gate(tmp_path, timeout_s=10)

        assert vg_result["overall"] == "fail"
        stderr_content = Path(vg_result["stderr_path"]).read_text()
        fc_result = classify(stderr_content)
        assert fc_result["category"] == "AUTH_STALE"

        # Verify there's a healer entry for this category
        patterns = self._load_patterns()
        assert any(p["category"] == fc_result["category"] for p in patterns)

    def test_self_healer_emit_event_enqueues_heal_attempt(self, tmp_path):
        """self_healer._emit_event() enqueues a heal_attempt event end-to-end."""
        import emit_queue
        import self_healer

        with (
            patch.object(emit_queue, "QUEUE_DIR", tmp_path),
            patch.object(emit_queue, "QUEUE_DB", tmp_path / "queue.db"),
            patch.object(emit_queue, "TOKEN_PATH", tmp_path / "api-token"),
            patch.object(emit_queue, "LAST_TOOL_PATH", tmp_path / "last-tool"),
        ):
            (tmp_path / "api-token").write_text("test-token")
            payload = {
                "pattern_id": "auth-stale",
                "action": "refresh_token",
                "mode": "suggest",
                "status": "suggested",
            }
            self_healer._emit_event(payload)
            assert emit_queue.pending_count() == 1
