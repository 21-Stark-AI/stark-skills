"""Human-review halt recovery (FU-rt8).

The red-team gate halts when a finding's ``counter_proposal`` is
``REQUEST_HUMAN_REVIEW``. Until this module landed, that halt was
unconditional: an operator stopped by such a finding had no supported way
to acknowledge it short of disabling the feature globally or hand-editing
state files. This module implements the acknowledged-halt path:

1. ``accept_finding(stable_key, ...)`` writes one durable acceptance row
   keyed by FU-rt7's stable key.
2. ``is_accepted(stable_key)`` checks whether an operator has already
   acknowledged this exact concern.
3. ``filter_human_review_findings(...)`` drops accepted findings from the
   halt input so a subsequent run no longer halts on them — UNLESS the
   model surfaces a NEW concern, in which case the new ``concern_hash``
   produces a new ``stable_key`` and the gate re-engages.
4. ``list_pending_halts(...)`` surfaces every unaccepted human-review
   finding in the audit DB so a ``red-team status`` display can show what
   the operator is actually being asked to acknowledge.

Stable keys are mandatory inputs: accepting by round-local id (``rt3``) is
the failure mode FU-rt7 was filed against.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import audit_base
from red_team_audit import DEFAULT_DB_PATH

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS red_team_human_review_accepts (
    stable_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    concern_hash TEXT NOT NULL,
    concern_excerpt TEXT,
    accepted_by TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    note TEXT,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_run
    ON red_team_human_review_accepts(run_id, stage);
"""


def init_table(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create the acceptance table if it doesn't exist."""
    audit_base.init_db(db_path, _CREATE_TABLE)


def _resolve_accepted_by(value: str | None) -> str:
    if value:
        return value
    # Pick the operator's identity from $USER (set by login shells); fall back
    # to ``manual`` so the column never holds an empty string in practice.
    return os.environ.get("USER") or "manual"


@dataclass(frozen=True)
class PendingHalt:
    """One unaccepted human-review finding awaiting operator acknowledgement."""

    stable_key: str
    run_id: str
    stage: str
    round_num: int
    persona: str
    finding_id: str
    concern_hash: str
    concern_excerpt: str | None
    repo: str | None
    pr_number: int | None
    artifact_relative_path: str | None
    created_at: str | None


def accept_finding(
    stable_key: str,
    *,
    run_id: str,
    stage: str,
    round_num: int,
    persona: str,
    finding_id: str,
    concern_hash: str,
    concern_excerpt: str | None,
    accepted_by: str | None = None,
    note: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Record an operator acceptance for one human-review finding.

    Idempotent — a re-accept of the same ``stable_key`` is a no-op (the
    INSERT OR IGNORE keeps the original timestamp). That preserves the
    audit answer to "when did the operator first acknowledge this?".
    """
    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT OR IGNORE INTO red_team_human_review_accepts ("
            "stable_key, run_id, stage, round_num, persona, finding_id, "
            "concern_hash, concern_excerpt, accepted_by, note"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                stable_key,
                run_id,
                stage,
                round_num,
                persona,
                finding_id,
                concern_hash,
                concern_excerpt,
                _resolve_accepted_by(accepted_by),
                note,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def is_accepted(stable_key: str, *, db_path: str | Path = DEFAULT_DB_PATH) -> bool:
    """Return True if an operator has accepted this exact stable key."""
    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        row = conn.execute(
            "SELECT 1 FROM red_team_human_review_accepts WHERE stable_key = ?",
            (stable_key,),
        ).fetchone()
    finally:
        conn.close()
    return row is not None


def filter_human_review_findings(
    findings: list[Any],
    *,
    run_id: str,
    stage: str,
    round_num: int,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> tuple[list[Any], list[str]]:
    """Split findings into ``(unaccepted, accepted_keys)`` based on the audit DB.

    Returns the findings that should still halt the gate and the list of
    stable keys whose human-review concerns the operator has already
    acknowledged. Used by the dispatcher to demote ``halted_human_review``
    to ``clean`` (or ``halted`` if blocking findings remain) once every
    open human-review item has an accept row.
    """
    import stark_red_team as rt

    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT stable_key FROM red_team_human_review_accepts "
            "WHERE run_id = ? OR run_id LIKE ?",
            (run_id, "%"),
        ).fetchall()
        all_accepted: set[str] = {r[0] for r in rows}
    finally:
        conn.close()

    unaccepted: list[Any] = []
    matched_keys: list[str] = []
    for f in findings:
        if not rt.is_human_review(f):
            continue
        stable_key = rt.compute_stable_key(
            run_id=run_id,
            stage=stage,
            round_num=round_num,
            persona=f.persona,
            finding_id=f.id,
            concern_hash=f.concern_hash,
        )
        if stable_key in all_accepted:
            matched_keys.append(stable_key)
        else:
            unaccepted.append(f)
    return unaccepted, matched_keys


def list_pending_halts(
    *,
    repo: str | None = None,
    stage: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> list[PendingHalt]:
    """Return every unaccepted human-review finding in the audit DB.

    Drives the ``red-team status`` display so an operator can see all
    pending halts before deciding which to accept. Optional ``repo`` /
    ``stage`` filters keep the output scoped to the surface the operator
    is actually working on.
    """
    init_table(db_path)
    init_red_team_findings_dependency(db_path)
    where: list[str] = ["f.counter_proposal = 'REQUEST_HUMAN_REVIEW'"]
    params: list[Any] = []
    if repo is not None:
        where.append("r.repo = ?")
        params.append(repo)
    if stage is not None:
        where.append("f.stage = ?")
        params.append(stage)
    sql = (
        "SELECT f.stable_key, f.run_id, f.stage, f.round_num, f.persona, "
        "f.finding_id, f.concern_hash, "
        "COALESCE(f.concern, ''), r.repo, r.pr_number, r.artifact_relative_path, "
        "r.created_at "
        "FROM red_team_findings f "
        "LEFT JOIN red_team_runs r ON r.run_id = f.run_id "
        "WHERE " + " AND ".join(where) + " "
        "AND f.stable_key IS NOT NULL "
        "AND f.stable_key NOT IN ("
        "SELECT stable_key FROM red_team_human_review_accepts"
        ") "
        "ORDER BY r.created_at DESC"
    )
    conn = audit_base.connect(db_path)
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [
        PendingHalt(
            stable_key=r[0],
            run_id=r[1],
            stage=r[2],
            round_num=r[3],
            persona=r[4],
            finding_id=r[5],
            concern_hash=r[6],
            concern_excerpt=r[7] or None,
            repo=r[8],
            pr_number=r[9],
            artifact_relative_path=r[10],
            created_at=r[11],
        )
        for r in rows
    ]


def init_red_team_findings_dependency(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Best-effort init of the upstream tables used by ``list_pending_halts``.

    The SELECT join requires ``red_team_findings`` and ``red_team_runs`` to
    exist. ``red_team_audit.init_red_team_tables`` creates both. Importing
    that module from inside ``list_pending_halts`` avoids a hard
    audit_base ↔ red_team_audit ↔ red_team_human_review cycle at module
    load time.
    """
    import red_team_audit

    red_team_audit.init_red_team_tables(db_path)


def lookup_finding_metadata(
    stable_key: str,
    *,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> dict[str, Any] | None:
    """Look up a stable key's full row so the CLI can show what's being accepted.

    The FU-rt7 invariant — "display the matched concern text BEFORE
    accepting it" — relies on this. The CLI accept flow reads the
    concern excerpt and operator-side metadata, prints them, and only
    then asks the operator to confirm.
    """
    init_red_team_findings_dependency(db_path)
    conn = audit_base.connect(db_path)
    try:
        row = conn.execute(
            "SELECT stable_key, run_id, stage, round_num, persona, finding_id, "
            "concern_hash, concern, severity, counter_proposal "
            "FROM red_team_findings WHERE stable_key = ? "
            "ORDER BY id DESC LIMIT 1",
            (stable_key,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "stable_key": row[0],
        "run_id": row[1],
        "stage": row[2],
        "round_num": row[3],
        "persona": row[4],
        "finding_id": row[5],
        "concern_hash": row[6],
        "concern_excerpt": row[7],
        "severity": row[8],
        "counter_proposal": row[9],
    }
