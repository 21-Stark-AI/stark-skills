#!/usr/bin/env python3
"""Lock file helpers for stark-skills workflow coordination.

Provides acquire/release/stale-detection/force-unlock primitives used by
autopilot and other concurrent workflows to prevent collisions.

Lock file format (JSON):
    {
      "pid": 12345,
      "start_time": "Thu Apr  3 12:34:56 2026",
      "timestamp": "2026-04-03T12:34:56Z",
      "worktree": "/path/to/worktree",
      "ttl_minutes": 30
    }

CLI:
    python3 scripts/lock_helpers.py --force-unlock PATH
"""
from __future__ import annotations

import argparse
import errno
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure scripts/ is on path when imported directly.
sys.path.insert(0, str(Path(__file__).parent))

from config_loader import get_runtime_config

# Audit log for force-unlock operations.
_AUDIT_PATH = Path.home() / ".claude" / "code-review" / "lock-audit.jsonl"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_process_start_time(pid: int) -> str:
    """Return the process start time string from ps, or '' on failure."""
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _is_pid_alive(pid: int) -> bool:
    """Return True if the process exists (signal 0 succeeds)."""
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        # EPERM means process exists but we can't signal it.
        return True


def _build_lock_data(worktree: str = "") -> dict:
    """Build a fresh lock data dict for the current process."""
    pid = os.getpid()
    start_time = _get_process_start_time(pid)
    ttl = get_runtime_config().get("lock_ttl_minutes", 30)
    return {
        "pid": pid,
        "start_time": start_time,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "worktree": worktree,
        "ttl_minutes": ttl,
    }


def _write_lock(path: str, worktree: str = "") -> None:
    """Write a fresh lock file to path."""
    lock_data = _build_lock_data(worktree)
    Path(path).write_text(json.dumps(lock_data, indent=2))


def _read_lock(path: str) -> dict | None:
    """Read and parse lock file. Returns None on missing or parse error."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _is_lock_data_stale(lock_data: dict) -> bool:
    """Return True if lock_data represents a stale lock."""
    # TTL check.
    try:
        stored = datetime.fromisoformat(
            lock_data["timestamp"].replace("Z", "+00:00")
        )
        ttl = timedelta(minutes=lock_data.get("ttl_minutes", 30))
        if datetime.now(timezone.utc) > stored + ttl:
            return True
    except (KeyError, ValueError):
        return True  # malformed timestamp → treat as stale

    # PID liveness check.
    pid = lock_data.get("pid")
    if not isinstance(pid, int):
        return True

    if not _is_pid_alive(pid):
        return True

    # Start-time cross-check (guards against PID reuse).
    stored_start = lock_data.get("start_time", "")
    current_start = _get_process_start_time(pid)
    if current_start and stored_start and current_start != stored_start:
        return True

    return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def acquire_lock(path: str, worktree: str = "") -> bool:
    """Create a JSON lock file at path.

    Returns True if the lock was acquired (either the file didn't exist or the
    existing lock was stale). Returns False if a live lock is held by another
    process.
    """
    lock_path = Path(path)

    if not lock_path.exists():
        _write_lock(path, worktree)
        return True

    # Lock file exists — determine if it's stale.
    lock_data = _read_lock(path)
    if lock_data is None:
        # Corrupt or unreadable — treat as stale and override.
        _write_lock(path, worktree)
        return True

    if _is_lock_data_stale(lock_data):
        # Stale: override with our own lock.
        _write_lock(path, worktree)
        return True

    # A live lock is held by another process.
    return False


def release_lock(path: str) -> bool:
    """Delete the lock file at path.

    Returns True if the file was deleted, False if it wasn't found.
    """
    try:
        Path(path).unlink()
        return True
    except FileNotFoundError:
        return False


def is_lock_stale(path: str) -> bool:
    """Return True if the lock file exists but is stale.

    Staleness criteria: PID dead, PID reused (start_time mismatch), or TTL
    exceeded. Returns False if the file doesn't exist (no lock = not stale).
    """
    if not Path(path).exists():
        return False

    lock_data = _read_lock(path)
    if lock_data is None:
        return True  # corrupt = stale

    return _is_lock_data_stale(lock_data)


def force_unlock(path: str) -> bool:
    """Operator override: remove the lock file regardless of state.

    Appends an audit entry to ~/.claude/code-review/lock-audit.jsonl.
    Always returns True.
    """
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass

    # Write audit entry.
    audit_entry = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "path": path,
        "action": "force_unlock",
    }
    try:
        _AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _AUDIT_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(audit_entry) + "\n")
    except OSError:
        pass

    return True


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="stark-skills lock file management"
    )
    parser.add_argument(
        "--force-unlock", metavar="PATH",
        help="Remove lock file at PATH regardless of state (operator override)",
    )
    args = parser.parse_args()

    if args.force_unlock:
        released = force_unlock(args.force_unlock)
        print(json.dumps({"path": args.force_unlock, "released": released}))
        sys.exit(0)

    parser.print_help()
    sys.exit(1)


if __name__ == "__main__":
    main()
