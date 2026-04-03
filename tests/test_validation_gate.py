"""Tests for scripts/validation_gate.py"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import emit_queue
import validation_gate
from validation_gate import (
    _ALLOWED_DISCOVERY_COMMANDS,
    _discover_commands,
    _emit,
    _get_repo_name,
    _run_check,
    _write_stderr_log,
    run_validation_gate,
)


# ---------------------------------------------------------------------------
# _get_repo_name
# ---------------------------------------------------------------------------


class TestGetRepoName:
    def test_https_url(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="https://github.com/GetEvinced/stark-skills.git\n"
            )
            assert _get_repo_name(tmp_path) == "stark-skills"

    def test_ssh_url(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="git@github.com:GetEvinced/my-repo.git\n"
            )
            assert _get_repo_name(tmp_path) == "my-repo"

    def test_url_without_git_suffix(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="https://github.com/org/repo-name\n"
            )
            assert _get_repo_name(tmp_path) == "repo-name"

    def test_git_failure_returns_default(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            assert _get_repo_name(tmp_path) == "_default"

    def test_exception_returns_default(self, tmp_path):
        with patch("subprocess.run", side_effect=OSError("no git")):
            assert _get_repo_name(tmp_path) == "_default"

    def test_trailing_slash_stripped(self, tmp_path):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout="https://github.com/org/repo/\n"
            )
            assert _get_repo_name(tmp_path) == "repo"


# ---------------------------------------------------------------------------
# _discover_commands
# ---------------------------------------------------------------------------


class TestDiscoverCommands:
    def test_package_json_found(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        result = _discover_commands(tmp_path)
        assert result == {"test_cmd": "npm test"}

    def test_makefile_found(self, tmp_path):
        (tmp_path / "Makefile").write_text("test:\n\techo ok")
        result = _discover_commands(tmp_path)
        assert result == {"test_cmd": "make test"}

    def test_pytest_ini_found(self, tmp_path):
        (tmp_path / "pytest.ini").write_text("[pytest]")
        result = _discover_commands(tmp_path)
        assert result == {"test_cmd": "pytest"}

    def test_pyproject_toml_found(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[tool.pytest]")
        result = _discover_commands(tmp_path)
        assert result == {"test_cmd": "pytest"}

    def test_package_json_takes_priority_over_makefile(self, tmp_path):
        (tmp_path / "package.json").write_text("{}")
        (tmp_path / "Makefile").write_text("")
        result = _discover_commands(tmp_path)
        assert result["test_cmd"] == "npm test"

    def test_nothing_found(self, tmp_path):
        result = _discover_commands(tmp_path)
        assert result == {"test_cmd": None}

    def test_all_discovered_commands_are_in_allowlist(self, tmp_path):
        for cmd in ["npm test", "make test", "pytest"]:
            assert cmd in _ALLOWED_DISCOVERY_COMMANDS, f"{cmd} not in allowlist"


# ---------------------------------------------------------------------------
# _run_check
# ---------------------------------------------------------------------------


class TestRunCheck:
    def test_passing_command(self, tmp_path):
        result = _run_check("test", "true", tmp_path, timeout_s=10)
        assert result["passed"] is True
        assert result["failure_pattern"] is None
        assert result["name"] == "test"
        assert result["command"] == "true"
        assert result["duration_s"] >= 0

    def test_failing_command_test(self, tmp_path):
        result = _run_check("test", "false", tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert result["failure_pattern"] == "TEST_FAILURE"

    def test_failing_command_lint(self, tmp_path):
        result = _run_check("lint", "false", tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert result["failure_pattern"] == "LINT_ERROR"

    def test_failing_command_typecheck(self, tmp_path):
        result = _run_check("typecheck", "false", tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert result["failure_pattern"] == "TYPE_ERROR"

    def test_none_command_returns_missing(self, tmp_path):
        result = _run_check("test", None, tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert result["failure_pattern"] == "TEST_COMMAND_MISSING"
        assert result["duration_s"] == 0.0

    def test_timeout(self, tmp_path):
        result = _run_check("test", "sleep 10", tmp_path, timeout_s=1)
        assert result["passed"] is False
        assert result["failure_pattern"] == "TIMEOUT"
        assert "timed out" in result["stderr"]

    def test_stdout_captured(self, tmp_path):
        result = _run_check("test", "echo hello", tmp_path, timeout_s=10)
        assert result["passed"] is True
        assert "hello" in result["stdout"]

    def test_stderr_captured(self, tmp_path):
        result = _run_check("test", "echo err >&2; false", tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert "err" in result["stderr"]

    def test_subprocess_exception(self, tmp_path):
        with patch("subprocess.run", side_effect=OSError("spawn failed")):
            result = _run_check("test", "some-cmd", tmp_path, timeout_s=10)
        assert result["passed"] is False
        assert result["failure_pattern"] == "TEST_FAILURE"
        assert "spawn failed" in result["stderr"]


# ---------------------------------------------------------------------------
# _write_stderr_log
# ---------------------------------------------------------------------------


class TestWriteStderrLog:
    def test_creates_log_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path)
        checks = [
            {"name": "lint", "command": "eslint .", "stderr": "error on line 1"},
            {"name": "test", "command": "pytest", "stderr": ""},
        ]
        log_path = _write_stderr_log(checks)
        assert Path(log_path).exists()
        content = Path(log_path).read_text()
        assert "error on line 1" in content
        assert "eslint" in content

    def test_empty_stderr_not_included(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path)
        checks = [{"name": "test", "command": "pytest", "stderr": ""}]
        log_path = _write_stderr_log(checks)
        content = Path(log_path).read_text()
        assert content == ""

    def test_log_filename_has_timestamp(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path)
        log_path = _write_stderr_log([])
        assert "run-" in Path(log_path).name
        assert Path(log_path).suffix == ".stderr"

    def test_creates_log_dir_if_missing(self, tmp_path, monkeypatch):
        log_dir = tmp_path / "nested" / "logs"
        monkeypatch.setattr(validation_gate, "_LOG_DIR", log_dir)
        _write_stderr_log([])
        assert log_dir.exists()


# ---------------------------------------------------------------------------
# _emit
# ---------------------------------------------------------------------------


class TestEmit:
    def test_calls_make_event_and_enqueue(self):
        mock_eq = MagicMock()
        mock_event = {"type": "validation_result"}
        mock_eq.make_event.return_value = mock_event

        with patch.object(validation_gate, "emit_queue", mock_eq):
            _emit("myrepo", [{"passed": True}, {"passed": False}], "fail")

        mock_eq.make_event.assert_called_once()
        args = mock_eq.make_event.call_args
        assert args[0][0] == "validation_result"
        payload = args[0][1]
        assert payload["repo"] == "myrepo"
        assert payload["overall"] == "fail"
        assert payload["check_count"] == 2
        assert payload["passed_count"] == 1
        mock_eq.enqueue.assert_called_once_with(mock_event)

    def test_swallows_exceptions(self):
        mock_eq = MagicMock()
        mock_eq.make_event.side_effect = RuntimeError("boom")
        with patch.object(validation_gate, "emit_queue", mock_eq):
            _emit("repo", [], "pass")  # must not raise


# ---------------------------------------------------------------------------
# run_validation_gate — config-driven path
# ---------------------------------------------------------------------------


class TestRunValidationGateConfig:
    def _make_config(self, repo_entry: dict | None, default_entry: dict | None = None):
        per_repo: dict = {}
        if repo_entry is not None:
            per_repo["myrepo"] = repo_entry
        if default_entry is not None:
            per_repo["_default"] = default_entry
        return {"validation_gate": {"per_repo_commands": per_repo}}

    def test_runs_lint_typecheck_test(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config(
            {"lint_cmd": "true", "typecheck_cmd": "true", "test_cmd": "true"}
        )
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        names = [c["name"] for c in result["checks"]]
        assert "lint" in names
        assert "typecheck" in names
        assert "test" in names
        assert result["overall"] == "pass"

    def test_skips_missing_commands(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config({"lint_cmd": None, "test_cmd": "true"})
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        names = [c["name"] for c in result["checks"]]
        assert "lint" not in names
        assert "test" in names

    def test_overall_fail_when_any_check_fails(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config({"lint_cmd": "true", "test_cmd": "false"})
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["overall"] == "fail"

    def test_default_fallback_config(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config(None, default_entry={"test_cmd": "true"})
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="unknown-repo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["overall"] == "pass"
        assert any(c["name"] == "test" for c in result["checks"])

    def test_result_includes_repo_and_stderr_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config({"test_cmd": "true"})
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["repo"] == "myrepo"
        assert "stderr_path" in result

    def test_check_dicts_omit_stdout_stderr(self, tmp_path, monkeypatch):
        """Public result dict strips raw stdout/stderr (only in internal check dicts)."""
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        config = self._make_config({"test_cmd": "echo hello"})
        with (
            patch("config_loader.load_config", return_value=config),
            patch.object(validation_gate, "_get_repo_name", return_value="myrepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        for check in result["checks"]:
            assert "stdout" not in check
            assert "stderr" not in check


# ---------------------------------------------------------------------------
# run_validation_gate — discovery path
# ---------------------------------------------------------------------------


class TestRunValidationGateDiscovery:
    def test_discovers_pytest_from_pyproject(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        (tmp_path / "pyproject.toml").write_text("[tool.pytest]")
        with (
            patch("config_loader.load_config", return_value={}),
            patch.object(validation_gate, "_get_repo_name", return_value="norepo"),
            patch.object(validation_gate, "_emit"),
            patch.object(validation_gate, "_run_check", return_value={
                "name": "test", "command": "pytest", "passed": True,
                "duration_s": 0.1, "failure_pattern": None,
            }),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["overall"] == "pass"

    def test_no_commands_found_overall_pass(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        with (
            patch("config_loader.load_config", return_value={}),
            patch.object(validation_gate, "_get_repo_name", return_value="norepo"),
            patch.object(validation_gate, "_emit"),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["checks"] == []
        assert result["overall"] == "pass"

    def test_security_rejected_command(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        with (
            patch("config_loader.load_config", return_value={}),
            patch.object(validation_gate, "_get_repo_name", return_value="norepo"),
            patch.object(validation_gate, "_emit"),
            patch(
                "validation_gate._discover_commands",
                return_value={"test_cmd": None, "_security_rejected": "rm -rf /"},
            ),
        ):
            result = run_validation_gate(tmp_path, timeout_s=10)

        assert result["overall"] == "fail"
        check = result["checks"][0]
        assert check["failure_pattern"] == "SECURITY_REJECTED"


# ---------------------------------------------------------------------------
# CLI (main)
# ---------------------------------------------------------------------------


class TestCLI:
    def test_json_output(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        fake_result = {
            "repo": "r", "checks": [], "overall": "pass",
            "stderr_path": str(tmp_path / "logs" / "run-ts.stderr"),
        }
        with (
            patch("sys.argv", ["validation_gate.py", "--json", "--repo-root", str(tmp_path)]),
            patch("validation_gate.run_validation_gate", return_value=fake_result),
            patch("config_loader.load_config", return_value={}),
        ):
            with pytest.raises(SystemExit) as exc:
                validation_gate.main()
        assert exc.value.code == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["overall"] == "pass"

    def test_table_output(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        fake_result = {
            "repo": "r",
            "checks": [
                {"name": "test", "command": "pytest", "passed": True, "duration_s": 1.23, "failure_pattern": None}
            ],
            "overall": "pass",
            "stderr_path": "/tmp/run.stderr",
        }
        with (
            patch("sys.argv", ["validation_gate.py", "--repo-root", str(tmp_path)]),
            patch("validation_gate.run_validation_gate", return_value=fake_result),
            patch("config_loader.load_config", return_value={}),
        ):
            with pytest.raises(SystemExit) as exc:
                validation_gate.main()
        assert exc.value.code == 0
        captured = capsys.readouterr()
        assert "PASS" in captured.out
        assert "pytest" in captured.out

    def test_timeout_from_cli(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        captured_timeout = {}

        def fake_run(repo_root, timeout_s):
            captured_timeout["v"] = timeout_s
            return {"repo": "r", "checks": [], "overall": "pass", "stderr_path": "/tmp/x"}

        with (
            patch("sys.argv", ["validation_gate.py", "--timeout", "120", "--repo-root", str(tmp_path)]),
            patch("validation_gate.run_validation_gate", side_effect=fake_run),
            patch("config_loader.load_config", return_value={}),
        ):
            with pytest.raises(SystemExit):
                validation_gate.main()
        assert captured_timeout["v"] == 120

    def test_timeout_from_config(self, tmp_path, monkeypatch):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        captured_timeout = {}

        def fake_run(repo_root, timeout_s):
            captured_timeout["v"] = timeout_s
            return {"repo": "r", "checks": [], "overall": "pass", "stderr_path": "/tmp/x"}

        config = {"validation_gate": {"timeout_seconds": 99}}
        with (
            patch("sys.argv", ["validation_gate.py", "--repo-root", str(tmp_path)]),
            patch("validation_gate.run_validation_gate", side_effect=fake_run),
            patch("config_loader.load_config", return_value=config),
        ):
            with pytest.raises(SystemExit):
                validation_gate.main()
        assert captured_timeout["v"] == 99

    def test_always_exits_zero(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(validation_gate, "_LOG_DIR", tmp_path / "logs")
        fake_result = {
            "repo": "r", "checks": [], "overall": "fail", "stderr_path": "/tmp/x"
        }
        with (
            patch("sys.argv", ["validation_gate.py", "--repo-root", str(tmp_path)]),
            patch("validation_gate.run_validation_gate", return_value=fake_result),
            patch("config_loader.load_config", return_value={}),
        ):
            with pytest.raises(SystemExit) as exc:
                validation_gate.main()
        assert exc.value.code == 0


# ---------------------------------------------------------------------------
# emit_queue new event types (validation_result, heal_attempt)
# ---------------------------------------------------------------------------


class TestNewEventTypes:
    def _base(self, type_):
        return {
            "type": type_,
            "timestamp": "2026-04-03T10:00:00Z",
            "cli": "claude",
            "source": "skill",
            "schema_version": 1,
            "payload": {},
        }

    def test_validation_result_accepted(self):
        assert emit_queue.validate(self._base("validation_result")) == []

    def test_heal_attempt_accepted(self):
        assert emit_queue.validate(self._base("heal_attempt")) == []
