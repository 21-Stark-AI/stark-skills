"""Configuration manager for multi-level review config resolution.

Resolves config by merging: global defaults → org overrides → repo overrides → PR overrides.
Supports hot-reload, validation, and diff-aware domain selection.
"""

from __future__ import annotations

import copy
import json
import os
import pickle
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Defaults ─────────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "review": {
        "agents": ["claude", "codex", "gemini"],
        "domains": [
            "architecture", "security", "performance", "error-handling",
            "testing", "accessibility", "data-integrity", "api-design", "scope"
        ],
        "fix_threshold": "medium",
        "max_rounds": 3,
        "disabled_domains": [],
        "disabled_paths": [],
        "severity_overrides": {},
    },
    "notifications": {
        "slack_channel": None,
        "email": None,
        "on_critical": True,
        "on_complete": False,
    },
    "test": {
        "test_command": None,
        "build_command": None,
        "coverage_threshold": None,
    },
}

SEVERITY_ORDER = {
    "critical": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
    "info": 0,
}

# ── Config resolution ────────────────────────────────────────────────────


def deep_merge(base: dict, override: dict) -> dict:
    """Deep merge override into base. Lists are replaced, not appended."""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def resolve_config(
    repo: str,
    pr_body: str | None = None,
    global_path: Path | None = None,
    org_path: Path | None = None,
    repo_path: Path | None = None,
) -> dict:
    """Resolve config by merging all levels.

    Priority: PR body overrides > repo > org > global > defaults
    """
    config = copy.deepcopy(DEFAULT_CONFIG)

    # Global
    gp = global_path or Path("~/.claude/code-review/config.json").expanduser()
    if gp.exists():
        with open(gp) as f:
            config = deep_merge(config, json.load(f))

    # Org
    org = repo.split("/")[0] if "/" in repo else None
    op = org_path or (Path(f"~/git/{org}/.code-review/config.json").expanduser() if org else None)
    if op and op.exists():
        with open(op) as f:
            config = deep_merge(config, json.load(f))

    # Repo
    rp = repo_path or Path(".code-review/config.json")
    if rp.exists():
        with open(rp) as f:
            config = deep_merge(config, json.load(f))

    # PR body overrides (YAML frontmatter style)
    if pr_body:
        overrides = parse_pr_overrides(pr_body)
        if overrides:
            config = deep_merge(config, overrides)

    return config


def parse_pr_overrides(body: str) -> dict:
    """Extract review config overrides from PR body.

    Looks for a ```review-config block in the PR body.
    """
    pattern = r"```review-config\s*\n(.*?)\n```"
    match = re.search(pattern, body, re.DOTALL)
    if not match:
        return {}

    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}


# ── Domain selection ─────────────────────────────────────────────────────


@dataclass
class DiffStats:
    """Statistics about a PR diff."""
    files_changed: list[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    file_types: set[str] = field(default_factory=set)
    has_tests: bool = False
    has_migrations: bool = False
    has_config_changes: bool = False
    has_api_changes: bool = False
    has_security_files: bool = False


def analyze_diff(base_ref: str) -> DiffStats:
    """Analyze git diff to determine relevant review domains."""
    stats = DiffStats()

    try:
        result = subprocess.run(
            ["git", "diff", "--stat", f"{base_ref}...HEAD"],
            capture_output=True, text=True, timeout=30,
        )
        for line in result.stdout.splitlines():
            if "|" in line:
                filepath = line.split("|")[0].strip()
                stats.files_changed.append(filepath)
                ext = Path(filepath).suffix
                stats.file_types.add(ext)

                if "test" in filepath.lower() or "spec" in filepath.lower():
                    stats.has_tests = True
                if "migration" in filepath.lower() or "migrate" in filepath.lower():
                    stats.has_migrations = True
                if filepath.endswith((".json", ".yaml", ".yml", ".toml", ".ini")):
                    stats.has_config_changes = True
                if "api" in filepath.lower() or "route" in filepath.lower():
                    stats.has_api_changes = True
                if any(sec in filepath.lower() for sec in ("auth", "crypto", "secret", "token", "password")):
                    stats.has_security_files = True

        # Get line counts
        numstat = subprocess.run(
            ["git", "diff", "--numstat", f"{base_ref}...HEAD"],
            capture_output=True, text=True, timeout=30,
        )
        for line in numstat.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                try:
                    stats.lines_added += int(parts[0])
                    stats.lines_removed += int(parts[1])
                except ValueError:
                    pass  # Binary files show "-"

    except subprocess.TimeoutExpired:
        pass

    return stats


def select_domains(config: dict, diff_stats: DiffStats) -> list[str]:
    """Select review domains based on config and diff analysis."""
    all_domains = config["review"]["domains"]
    disabled = set(config["review"].get("disabled_domains", []))
    disabled_paths = config["review"].get("disabled_paths", [])

    # Filter disabled
    domains = [d for d in all_domains if d not in disabled]

    # Check if any changed files match disabled_paths patterns
    for path_pattern in disabled_paths:
        regex = re.compile(path_pattern.replace("*", ".*"))
        stats_filtered = [f for f in diff_stats.files_changed if not regex.match(f)]
        if not stats_filtered:
            # All files match disabled path — skip review entirely
            return []

    # Smart domain selection based on diff content
    if not diff_stats.has_tests and "testing" in domains:
        # Keep testing domain to flag missing tests
        pass

    if not diff_stats.has_security_files and diff_stats.lines_added < 50:
        # Small change, no security-sensitive files — drop security domain
        if "security" in domains and len(domains) > 3:
            domains.remove("security")

    if not diff_stats.has_api_changes:
        if "api-design" in domains and len(domains) > 3:
            domains.remove("api-design")

    return domains


# ── Config validation ────────────────────────────────────────────────────


@dataclass
class ValidationError:
    field: str
    message: str
    severity: str = "error"


def validate_config(config: dict) -> list[ValidationError]:
    """Validate a resolved config."""
    errors = []

    # Check required sections
    for section in ("review", "notifications", "test"):
        if section not in config:
            errors.append(ValidationError(section, f"Missing required section: {section}"))

    review = config.get("review", {})

    # Validate agents
    valid_agents = {"claude", "codex", "gemini"}
    agents = review.get("agents", [])
    for agent in agents:
        if agent not in valid_agents:
            errors.append(ValidationError(
                f"review.agents.{agent}",
                f"Unknown agent: {agent}. Valid: {valid_agents}"
            ))

    # Validate domains
    valid_domains = {
        "architecture", "security", "performance", "error-handling",
        "testing", "accessibility", "data-integrity", "api-design", "scope"
    }
    for domain in review.get("domains", []):
        if domain not in valid_domains:
            errors.append(ValidationError(
                f"review.domains.{domain}",
                f"Unknown domain: {domain}",
                severity="warning",
            ))

    # Validate fix_threshold
    threshold = review.get("fix_threshold", "medium")
    if threshold not in SEVERITY_ORDER:
        errors.append(ValidationError(
            "review.fix_threshold",
            f"Invalid threshold: {threshold}. Valid: {list(SEVERITY_ORDER.keys())}"
        ))

    # Validate severity_overrides
    for pattern, severity in review.get("severity_overrides", {}).items():
        if severity not in SEVERITY_ORDER:
            errors.append(ValidationError(
                f"review.severity_overrides.{pattern}",
                f"Invalid severity: {severity}"
            ))

    # Validate max_rounds
    max_rounds = review.get("max_rounds", 3)
    if not isinstance(max_rounds, int) or max_rounds < 1 or max_rounds > 10:
        errors.append(ValidationError(
            "review.max_rounds",
            "max_rounds must be integer 1-10"
        ))

    return errors


# ── Config caching ───────────────────────────────────────────────────────

_config_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 300  # 5 minutes


def get_cached_config(repo: str, **kwargs) -> dict:
    """Get config with caching. Cache invalidated on file change."""
    cache_key = repo
    now = time.time()

    if cache_key in _config_cache:
        cached_at, cached_config = _config_cache[cache_key]
        if now - cached_at < CACHE_TTL:
            return cached_config

    config = resolve_config(repo, **kwargs)
    _config_cache[cache_key] = (now, config)
    return config


def invalidate_cache(repo: str | None = None) -> None:
    """Invalidate config cache."""
    if repo:
        _config_cache.pop(repo, None)
    else:
        _config_cache.clear()


# ── Config serialization ────────────────────────────────────────────────


def save_resolved_config(config: dict, path: str | Path) -> None:
    """Save resolved config to file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Save as pickle for fast loading
    pickle_path = path.with_suffix(".pkl")
    with open(pickle_path, "wb") as f:
        pickle.dump(config, f)

    # Also save as JSON for human readability
    with open(path, "w") as f:
        json.dump(config, f, indent=2)


def load_resolved_config(path: str | Path) -> dict:
    """Load resolved config, preferring pickle for speed."""
    path = Path(path)
    pickle_path = path.with_suffix(".pkl")

    if pickle_path.exists():
        with open(pickle_path, "rb") as f:
            return pickle.load(f)

    with open(path) as f:
        return json.load(f)


# ── Diff-based config adjustments ────────────────────────────────────────


def suggest_config_for_diff(diff_stats: DiffStats) -> dict[str, Any]:
    """Suggest config adjustments based on diff characteristics."""
    suggestions: dict[str, Any] = {}

    total_lines = diff_stats.lines_added + diff_stats.lines_removed

    # Large PRs: increase timeout, suggest splitting
    if total_lines > 1000:
        suggestions["review"] = {"max_rounds": 2}  # Reduce rounds for speed
        suggestions["_advice"] = "PR is large (>1000 lines). Consider splitting."

    # Tiny PRs: reduce agents
    if total_lines < 20 and len(diff_stats.files_changed) <= 2:
        suggestions["review"] = {
            "agents": ["claude"],
            "domains": ["architecture", "security"],
        }
        suggestions["_advice"] = "Small PR — single agent with focused domains."

    # Migration PRs: focus on data integrity
    if diff_stats.has_migrations:
        suggestions.setdefault("review", {})["domains"] = [
            "data-integrity", "security", "error-handling"
        ]

    return suggestions


# ── Environment setup ────────────────────────────────────────────────────


def setup_review_env(config: dict, repo: str) -> dict[str, str]:
    """Build environment variables for review subprocess."""
    env = dict(os.environ)

    # Set agent-specific env vars
    if "claude" in config["review"]["agents"]:
        env["CLAUDE_MODEL"] = "claude-sonnet-4-6"

    # Token for GitHub API
    token = os.environ.get("GH_TOKEN", "")
    if token:
        env["GH_TOKEN"] = token

    # Review-specific vars
    env["STARK_REVIEW_REPO"] = repo
    env["STARK_REVIEW_DOMAINS"] = ",".join(config["review"]["domains"])
    env["STARK_REVIEW_THRESHOLD"] = config["review"]["fix_threshold"]

    return env
