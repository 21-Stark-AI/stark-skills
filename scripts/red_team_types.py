"""Red-team dataclasses, identity helpers, and status derivation.

Extracted from the former `stark_red_team.py` so the Python dispatcher
(now `tools/red_team_lib.ts`) can be deleted while the Python read-side
modules — `red_team_audit`, `red_team_insights`, `red_team_backfill`,
`red_team_human_review` — keep working until they too move to TS in
Phase 5 of the 2026-05-16 migration plan.

Everything here is pure: no I/O, no subprocess, no network. The TS
dispatcher mirrors these structures in `tools/red_team_lib.ts`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

REQUEST_HUMAN_REVIEW = "REQUEST_HUMAN_REVIEW"

SEVERITY_RANK: dict[str, int] = {
    "critical": 3,
    "high": 2,
    "medium": 1,
}

def _normalize_concern(text: str) -> str:
    """Lowercase + collapse whitespace for stable hashing."""
    return " ".join((text or "").lower().split())


def compute_concern_hash(
    persona: str,
    risk_key: str | None,
    affected_component: str | None,
    concern: str,
    failure_mode: str | None = None,
) -> str:
    """SHA-256 fingerprint of a finding's stable identity (FU-rt5 + FU-rt7).

    Structured-identity path: when ``risk_key`` is set, hash
    ``persona|risk_key|affected_component|failure_mode`` so the same risk
    reworded produces the same fingerprint. Back-compat path: when
    ``risk_key`` is absent, fall back to ``persona|normalized_concern``.
    """
    if risk_key:
        canonical = "|".join([
            persona or "",
            risk_key,
            affected_component or "",
            failure_mode or "",
        ])
    else:
        canonical = "|".join([
            persona or "",
            "",
            affected_component or "",
            _normalize_concern(concern),
        ])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def compute_stable_key(
    *,
    run_id: str,
    stage: str,
    round_num: int,
    persona: str,
    finding_id: str,
    concern_hash: str,
) -> str:
    """Build the canonical AUDIT key for one finding occurrence (FU-rt7)."""
    return f"{run_id}:{stage}:{round_num}:{persona}:{finding_id}:{concern_hash}"


def compute_accept_key(
    *,
    stage: str,
    persona: str,
    concern_hash: str,
    repo: str | None = None,
) -> str:
    """Build the cross-run ACCEPT key for human-review halt recovery (FU-rt8).

    Refuses to construct a key when ``repo`` is unresolved (``None``, empty,
    or the legacy ``"unknown"`` sentinel). Accept keys are repo-scoped to
    prevent cross-repo collisions in the shared audit DB.
    """
    if not repo or repo == "unknown":
        raise ValueError(
            "compute_accept_key requires a resolved repository identifier; "
            f"got {repo!r}. Accept keys are repo-scoped to prevent cross-repo "
            "collisions; fix repo detection (e.g., run inside the target git "
            "checkout, or pass --repo) before accepting human-review halts."
        )
    return f"{repo}:{stage}:{persona}:{concern_hash}"


@dataclass
class RedTeamFinding:
    """One finding from one persona in one round."""

    id: str
    persona: str
    severity: str
    concern: str
    consequence: str
    counter_proposal: str
    trade_off: str | None
    reason_for_uncertainty: str | None
    risk_key: str | None = None
    affected_component: str | None = None
    failure_mode: str | None = None
    concern_hash: str = ""


@dataclass
class RedTeamResult:
    """Result of a single red-team call (one round, one stage)."""

    stage: str
    round_num: int
    synthesis: str
    findings: list[RedTeamFinding]
    blocking_count: int
    human_review_count: int
    raw_output: str
    duration_s: float
    cost_usd: float = 0.0
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class RedTeamRunContext:
    """Shared identity and runtime context for one red-team invocation."""

    run_id: str
    stage: str
    caller: str
    repo: str
    artifact_relative_path: str | None
    cwd: str | None
    env: dict[str, str]
    model_rates: dict[str, Any]
    cfg_red_team: dict[str, Any]
    per_run_budget_usd: float
    pr_number: int | None
    started_at_iso: str


@dataclass
class FixPlanMove:
    """One design-level move in a red-team fix plan."""

    id: str
    title: str
    rationale: str
    sections_touched: list[str]
    addressed_finding_ids: list[str]
    new_trade_off: str


@dataclass
class RedTeamFixPlan:
    """Validated proposed fix plan for blocking red-team findings."""

    summary: str
    moves: list[FixPlanMove]
    unaddressed_finding_ids: list[str]
    orphan_finding_ids: list[str]
    notes: str
    input_truncated: bool
    input_omitted_finding_ids: list[str]
    warnings: list[str]
    raw_output: str
    duration_s: float
    cost_usd: float
    input_tokens: int
    output_tokens: int
    model: str
    reasoning_effort: str
    error: str | None = None


def is_human_review(f: RedTeamFinding) -> bool:
    return f.counter_proposal == REQUEST_HUMAN_REVIEW


def derive_status(result: RedTeamResult) -> str:
    """Map a RedTeamResult to a canonical status string.

    Precedence: error → halted_human_review → halted → clean.
    Returns one of: ``"error" | "halted_human_review" | "halted" | "clean"``.
    """
    if result.error:
        return "error"
    if result.human_review_count > 0:
        return "halted_human_review"
    if result.blocking_count > 0:
        return "halted"
    return "clean"
