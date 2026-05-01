"""Tests for red_team_human_review — FU-rt8 halt recovery."""

from __future__ import annotations

import red_team_audit
import red_team_human_review as hr
import stark_red_team as rt


def _seed_finding(db, *, stable_key: str, run_id: str = "run1", concern_hash: str = "abc"):
    red_team_audit.init_red_team_tables(db)
    red_team_audit.record_red_team_run(
        {
            "run_id": run_id,
            "stage": "design",
            "rounds_used": 1,
            "final_status": "halted_human_review",
            "total_findings": 1,
            "critical_count": 0,
            "high_count": 0,
            "medium_count": 0,
            "human_review_count": 1,
            "duration_s": 1.0,
            "cost_usd": 0.10,
            "model": "gpt-5.5-pro",
            "caller": "manual",
            "repo": "evinced/stark-skills",
            "artifact_relative_path": "docs/spec.md",
            "pr_number": 42,
            "fix_plan_status": "skipped_human_review_only",
        },
        db_path=db,
    )
    red_team_audit.record_finding(
        run_id=run_id,
        stage="design",
        round_num=1,
        finding_id="rt3",
        persona="data",
        severity="high",
        concern="Schema migration may break readers",
        consequence="Data loss on rollback",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None,
        reason_for_uncertainty="Need product input",
        stable_key=stable_key,
        concern_hash=concern_hash,
        risk_key="schema-migration-rollback",
        affected_component="migrations",
        failure_mode="data-loss",
        db_path=db,
    )


def test_accept_finding_persists_one_row(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="Schema migration may break readers",
        accepted_by="alice",
        db_path=db,
    )
    assert hr.is_accepted("run1:design:1:data:rt3:abc", db_path=db) is True


def test_accept_finding_is_idempotent(tmp_path):
    """A re-accept of the same stable_key is a no-op."""
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        accepted_by="alice",
        db_path=db,
    )
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        accepted_by="bob",
        db_path=db,
    )
    # Both calls succeeded; one row persists.
    import sqlite3
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(
            "SELECT accepted_by FROM red_team_human_review_accepts"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 1
    # First operator wins — the audit answer stays consistent.
    assert rows[0][0] == "alice"


def test_filter_human_review_findings_drops_accepted_keys(tmp_path):
    db = tmp_path / "rt.db"
    stable_key = "run1:design:1:data:rt3:abc"
    _seed_finding(db, stable_key=stable_key)
    hr.accept_finding(
        stable_key,
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        accepted_by="alice",
        db_path=db,
    )

    finding = rt.RedTeamFinding(
        id="rt3",
        persona="data",
        severity="high",
        concern="Schema migration may break readers",
        consequence="x",
        counter_proposal="REQUEST_HUMAN_REVIEW",
        trade_off=None,
        reason_for_uncertainty="y",
        risk_key="schema-migration-rollback",
        affected_component="migrations",
        failure_mode="data-loss",
        concern_hash="abc",
    )
    unaccepted, matched = hr.filter_human_review_findings(
        [finding],
        run_id="run1",
        stage="design",
        round_num=1,
        db_path=db,
    )
    assert unaccepted == []
    assert matched == [stable_key]


def test_list_pending_halts_excludes_accepted(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    pending = hr.list_pending_halts(db_path=db)
    assert len(pending) == 1
    assert pending[0].stable_key == "run1:design:1:data:rt3:abc"
    hr.accept_finding(
        "run1:design:1:data:rt3:abc",
        run_id="run1",
        stage="design",
        round_num=1,
        persona="data",
        finding_id="rt3",
        concern_hash="abc",
        concern_excerpt="x",
        accepted_by="alice",
        db_path=db,
    )
    pending = hr.list_pending_halts(db_path=db)
    assert pending == []


def test_list_pending_halts_filters_by_repo_and_stage(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    assert hr.list_pending_halts(repo="evinced/stark-skills", db_path=db)
    assert not hr.list_pending_halts(repo="other/repo", db_path=db)
    assert hr.list_pending_halts(stage="design", db_path=db)
    assert not hr.list_pending_halts(stage="plan", db_path=db)


def test_lookup_finding_metadata_returns_concern_excerpt(tmp_path):
    db = tmp_path / "rt.db"
    _seed_finding(db, stable_key="run1:design:1:data:rt3:abc")
    meta = hr.lookup_finding_metadata("run1:design:1:data:rt3:abc", db_path=db)
    assert meta is not None
    assert meta["counter_proposal"] == "REQUEST_HUMAN_REVIEW"
    assert "Schema migration" in (meta["concern_excerpt"] or "")


def test_lookup_finding_metadata_returns_none_for_unknown_key(tmp_path):
    db = tmp_path / "rt.db"
    red_team_audit.init_red_team_tables(db)
    assert hr.lookup_finding_metadata("nope:does:not:exist", db_path=db) is None
