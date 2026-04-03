#!/usr/bin/env python3
"""Authoritative session ID resolver.

Resolution order:
  1. CLAUDE_SESSION_ID env var
  2. ~/.claude/projects/ marker files (JSON with 'session_id' key)
  3. uuid4 fallback

Cached per process via lru_cache.
"""
from __future__ import annotations

import json
import os
import uuid
from functools import lru_cache
from pathlib import Path

PROJECTS_DIR = Path.home() / ".claude" / "projects"


def _resolve_from_projects_dir() -> str | None:
    """Scan project marker files for a session_id value."""
    if not PROJECTS_DIR.is_dir():
        return None

    for path in sorted(PROJECTS_DIR.rglob("*.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            sid = data.get("session_id", "").strip() if isinstance(data, dict) else ""
            if sid:
                return sid
        except (OSError, json.JSONDecodeError, ValueError):
            continue

    return None


def resolve_from_checkpoint(checkpoint_path: str | Path) -> str | None:
    """Read session ID from an existing checkpoint file (JSON with 'session_id' key)."""
    path = Path(checkpoint_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if not isinstance(data, dict):
        return None

    sid = data.get("session_id")
    return sid.strip() if isinstance(sid, str) and sid.strip() else None


@lru_cache(maxsize=1)
def resolve_session_id() -> str:
    """Resolve session ID: env var > project marker > uuid4 fallback."""
    env_val = os.environ.get("CLAUDE_SESSION_ID", "").strip()
    if env_val:
        return env_val

    project_val = _resolve_from_projects_dir()
    if project_val:
        return project_val

    return str(uuid.uuid4())


if __name__ == "__main__":
    print(resolve_session_id())
