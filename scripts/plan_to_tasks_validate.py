#!/usr/bin/env python3
"""Validation dispatch for plan-to-tasks decompositions.

Orchestrates validation of plan breakdown files by dispatching to external
LLM CLI tools (Codex, Gemini) in parallel. Each agent reviews the breakdown
against the original plan and reports structural/completeness issues.

Follows patterns from plan_review_dispatch.py in this repo.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Constants ────────────────────────────────────────────────────────────

SCRIPTS_DIR = Path(__file__).parent
GLOBAL_CONFIG = Path.home() / ".claude" / "code-review" / "config.json"
CODEX_REASONING_CONFIG = 'model_reasoning_effort="high"'
DEFAULT_TIMEOUT = 300

DEFAULT_PLAN_TO_TASKS_CONFIG: dict[str, Any] = {
    "agents": ["codex", "gemini"],
    "timeout": DEFAULT_TIMEOUT,
}


# ── Data models ──────────────────────────────────────────────────────────


@dataclass
class ValidationIssue:
    phase_id: str
    task_id: str
    field: str
    problem: str
    suggestion: str = ""


@dataclass
class ValidationResult:
    agent: str
    approved: bool = False
    issues: list[ValidationIssue] = field(default_factory=list)
    raw_output: str = ""
    error: str | None = None
    duration_s: float = 0.0


# ── Config loading ────────────────────────────────────────────────────────


def load_config(
    repo_dir: str | None = None,
    global_config: str | None = None,
) -> dict[str, Any]:
    """Load plan_to_tasks section from config.json (global → repo).

    Checks:
        1. GLOBAL_CONFIG → plan_to_tasks section
        2. {repo_dir}/.code-review/config.json → plan_to_tasks section
    Merges onto DEFAULT_PLAN_TO_TASKS_CONFIG (repo overrides global).
    """
    config = dict(DEFAULT_PLAN_TO_TASKS_CONFIG)

    global_cfg_path = Path(global_config) if global_config else GLOBAL_CONFIG
    if global_cfg_path.exists():
        try:
            data = json.loads(global_cfg_path.read_text())
            section = data.get("plan_to_tasks", {})
            config.update(section)
        except (json.JSONDecodeError, OSError):
            pass

    if repo_dir:
        repo_cfg_path = Path(repo_dir) / ".code-review" / "config.json"
        if repo_cfg_path.exists():
            try:
                data = json.loads(repo_cfg_path.read_text())
                section = data.get("plan_to_tasks", {})
                config.update(section)
            except (json.JSONDecodeError, OSError):
                pass

    return config


# ── Utilities ─────────────────────────────────────────────────────────────


def compute_plan_hash(content: str) -> str:
    """Return sha256 hex digest of content, prefixed with 'sha256:'."""
    digest = hashlib.sha256(content.encode()).hexdigest()
    return f"sha256:{digest}"


# ── Stub — implemented in Task 3 ─────────────────────────────────────────


def dispatch_validators(
    plan_content: str,
    breakdown_content: str,
    agents: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[ValidationResult]:
    """Dispatch validation agents in parallel (stub — implemented in Task 3)."""
    return []


# ── CLI ───────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a plan-to-tasks breakdown against the original plan.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "plan_file",
        help="Path to the original plan/spec file.",
    )
    parser.add_argument(
        "breakdown_file",
        help="Path to the task breakdown JSON file to validate.",
    )
    parser.add_argument(
        "--agents",
        help="Comma-separated list of agents to use (default: codex,gemini).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"Per-agent timeout in seconds (default: {DEFAULT_TIMEOUT}).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    config = load_config()

    agents: list[str] = (
        args.agents.split(",") if args.agents else config.get("agents", ["codex", "gemini"])
    )
    timeout: int = (
        args.timeout if args.timeout != DEFAULT_TIMEOUT else config.get("timeout", DEFAULT_TIMEOUT)
    )

    plan_content = Path(args.plan_file).read_text()
    breakdown_content = Path(args.breakdown_file).read_text()

    plan_hash = compute_plan_hash(plan_content)

    results = dispatch_validators(
        plan_content=plan_content,
        breakdown_content=breakdown_content,
        agents=agents,
        timeout=timeout,
    )

    output: dict[str, Any] = {
        "plan_hash": plan_hash,
        "agents": agents,
        "results": [
            {
                "agent": r.agent,
                "approved": r.approved,
                "issues_count": len(r.issues),
                "duration_s": r.duration_s,
                **({"error": r.error} if r.error else {}),
                **({"issues": [
                    {
                        "phase_id": i.phase_id,
                        "task_id": i.task_id,
                        "field": i.field,
                        "problem": i.problem,
                        "suggestion": i.suggestion,
                    }
                    for i in r.issues
                ]} if r.issues else {}),
            }
            for r in results
        ],
        "summary": {
            "total_agents": len(agents),
            "completed": len(results),
            "approved": sum(1 for r in results if r.approved),
            "total_issues": sum(len(r.issues) for r in results),
        },
    }

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
