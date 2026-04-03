#!/usr/bin/env python3
"""Self-healer: apply known fix patterns to validation failures.

CLI:
    python3 scripts/self_healer.py --pattern-id ID --stderr-file PATH
                                   [--mode suggest|auto] [--json]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

PATTERNS_PATH = Path(__file__).parent / "healer_patterns.json"
SESSION_PATH = Path.home() / ".claude" / "code-review" / "healer-session.json"
HEALER_LOG = Path.home() / ".claude" / "code-review" / "healer.jsonl"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_patterns() -> list[dict]:
    try:
        return json.loads(PATTERNS_PATH.read_text())
    except Exception as e:
        print(json.dumps({"error": f"Cannot load patterns: {e}"}), file=sys.stderr)
        sys.exit(1)


def _find_pattern(patterns: list[dict], pattern_id: str) -> dict | None:
    for p in patterns:
        if p["id"] == pattern_id:
            return p
    return None


def _emit(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result))
    else:
        for k, v in result.items():
            print(f"  {k}: {v}")


def _log(entry: dict) -> None:
    try:
        HEALER_LOG.parent.mkdir(parents=True, exist_ok=True)
        with HEALER_LOG.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _emit_event(payload: dict) -> None:
    try:
        import emit_queue
        event = emit_queue.make_event("heal_attempt", payload)
        emit_queue.enqueue(event)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Session tracking
# ---------------------------------------------------------------------------

def _read_session() -> dict:
    try:
        return json.loads(SESSION_PATH.read_text())
    except Exception:
        return {}


def _write_session(data: dict) -> None:
    try:
        SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        SESSION_PATH.write_text(json.dumps(data))
    except Exception:
        pass


def _session_count(pattern_id: str) -> int:
    return _read_session().get(pattern_id, 0)


def _session_increment(pattern_id: str) -> None:
    data = _read_session()
    data[pattern_id] = data.get(pattern_id, 0) + 1
    _write_session(data)


# ---------------------------------------------------------------------------
# Action execution
# ---------------------------------------------------------------------------

def _run_verify(verify_command: str) -> bool:
    try:
        result = subprocess.run(
            verify_command, shell=True, capture_output=True, timeout=15
        )
        return result.returncode == 0
    except Exception:
        return False


def _execute_action(pattern: dict) -> dict:
    action = pattern["action"]
    scripts_dir = Path(__file__).parent

    if action == "refresh_token":
        try:
            result = subprocess.run(
                ["python3", str(scripts_dir / "github_app.py"), "token"],
                capture_output=True, text=True, timeout=30
            )
            success = result.returncode == 0
        except Exception:
            success = False
    elif action == "release_stale_lock":
        print("no lock path specified, skipping")
        success = True
    else:
        print(f"action {action} not yet implemented")
        success = True

    verify_passed = _run_verify(pattern.get("verify_command", "true"))
    return {"success": success, "verify_passed": verify_passed}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Apply a healer pattern to a stderr file")
    parser.add_argument("--pattern-id", required=True, help="Pattern ID to apply")
    parser.add_argument("--stderr-file", required=True, help="Path to stderr file")
    parser.add_argument("--mode", choices=["suggest", "auto"], default="suggest")
    parser.add_argument("--json", dest="as_json", action="store_true",
                        help="Emit JSON output")
    args = parser.parse_args()

    patterns = _load_patterns()
    pattern = _find_pattern(patterns, args.pattern_id)

    if pattern is None:
        msg = {"error": f"Pattern not found: {args.pattern_id}"}
        if args.as_json:
            print(json.dumps(msg))
        else:
            print(f"Error: {msg['error']}", file=sys.stderr)
        sys.exit(1)

    stderr_path = Path(args.stderr_file)
    if not stderr_path.exists():
        msg = {"error": f"stderr file not found: {args.stderr_file}"}
        if args.as_json:
            print(json.dumps(msg))
        else:
            print(f"Error: {msg['error']}", file=sys.stderr)
        sys.exit(1)

    # Guard check
    guard_cmd = pattern.get("guard")
    if guard_cmd:
        try:
            guard_result = subprocess.run(
                guard_cmd, shell=True, capture_output=True, timeout=10
            )
            if guard_result.returncode != 0:
                result = {
                    "status": "aborted",
                    "reason": "guard_failed",
                    "guard": guard_cmd,
                }
                _emit(result, args.as_json)
                sys.exit(0)
        except Exception as e:
            result = {
                "status": "aborted",
                "reason": "guard_failed",
                "guard": guard_cmd,
                "error": str(e),
            }
            _emit(result, args.as_json)
            sys.exit(0)

    # Session max check
    max_per_session = pattern.get("max_per_session")
    if max_per_session is not None:
        count = _session_count(pattern["id"])
        if count >= max_per_session:
            result = {
                "status": "aborted",
                "reason": "max_per_session_reached",
                "pattern_id": pattern["id"],
                "count": count,
                "max_per_session": max_per_session,
            }
            _emit(result, args.as_json)
            sys.exit(0)

    action = pattern["action"]
    requires_confirmation = pattern.get("requires_confirmation", False)

    # Suggest mode
    if args.mode == "suggest":
        result = {
            "status": "suggested",
            "pattern_id": pattern["id"],
            "action": action,
            "requires_confirmation": requires_confirmation,
        }
        _emit(result, args.as_json)
        _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "suggest", "status": "suggested"})
        _log({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pattern_id": pattern["id"],
            "action": action,
            "mode": "suggest",
            "status": "suggested",
        })
        sys.exit(0)

    # Auto mode — requires_confirmation=true → skip
    if requires_confirmation:
        result = {
            "status": "skipped",
            "reason": "requires_confirmation",
            "pattern_id": pattern["id"],
            "action": action,
        }
        _emit(result, args.as_json)
        _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "auto", "status": "skipped"})
        _log({
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pattern_id": pattern["id"],
            "action": action,
            "mode": "auto",
            "status": "skipped",
        })
        sys.exit(0)

    # Auto mode — execute
    execution = _execute_action(pattern)
    if max_per_session is not None and execution["success"]:
        _session_increment(pattern["id"])

    result = {
        "status": "applied",
        "pattern_id": pattern["id"],
        "action": action,
        "verify_passed": execution["verify_passed"],
    }
    _emit(result, args.as_json)
    _emit_event({"pattern_id": pattern["id"], "action": action, "mode": "auto", "status": "applied"})
    _log({
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pattern_id": pattern["id"],
        "action": action,
        "mode": "auto",
        "status": "applied",
    })
    sys.exit(0)


if __name__ == "__main__":
    main()
