"""Tests for forge_audit.py — audit logging and metrics."""

from __future__ import annotations

import json
import sqlite3

import pytest

from forge_audit import (
    AuditCall,
    get_domain_snr,
    init_metrics_db,
    prune_metrics,
    record_call,
    record_run,
)


class TestInitMetricsDb:
    def test_creates_tables_and_wal_mode(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        conn = sqlite3.connect(str(db))
        try:
            # WAL mode persists after init
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            assert mode == "wal"

            # Tables exist
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            assert "runs" in tables
            assert "domain_stats" in tables
        finally:
            conn.close()

    def test_idempotent(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)
        init_metrics_db(db)  # should not raise

    def test_creates_parent_dirs(self, tmp_path):
        db = tmp_path / "deep" / "nested" / "forge_metrics.db"
        init_metrics_db(db)
        assert db.exists()


class TestRecordCall:
    def test_appends_jsonl(self, tmp_path):
        audit_file = tmp_path / ".forge-audit.json"
        call1 = AuditCall(
            agent="claude",
            domain="security",
            round_num=1,
            duration_s=2.5,
            finding_count=3,
            severity_counts={"high": 1, "medium": 2},
        )
        call2 = AuditCall(
            agent="codex",
            domain="general",
            round_num=1,
            duration_s=1.8,
            finding_count=1,
            severity_counts={"low": 1},
        )
        record_call(audit_file, call1)
        record_call(audit_file, call2)

        lines = audit_file.read_text().strip().split("\n")
        assert len(lines) == 2

        parsed1 = json.loads(lines[0])
        assert parsed1["agent"] == "claude"
        assert parsed1["domain"] == "security"
        assert parsed1["finding_count"] == 3
        assert parsed1["severity_counts"]["high"] == 1

        parsed2 = json.loads(lines[1])
        assert parsed2["agent"] == "codex"

    def test_creates_parent_dirs(self, tmp_path):
        audit_file = tmp_path / "subdir" / ".forge-audit.json"
        call = AuditCall(
            agent="claude", domain="general", round_num=1,
            duration_s=1.0, finding_count=0,
        )
        record_call(audit_file, call)
        assert audit_file.exists()

    def test_error_field_serialized(self, tmp_path):
        audit_file = tmp_path / ".forge-audit.json"
        call = AuditCall(
            agent="codex", domain="security", round_num=2,
            duration_s=0.0, finding_count=0, error="timeout",
        )
        record_call(audit_file, call)
        parsed = json.loads(audit_file.read_text().strip())
        assert parsed["error"] == "timeout"


class TestRecordRun:
    def test_inserts_run_and_domain_stats(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        run_data = {
            "run_id": "run-001",
            "doc_path": "docs/design.md",
            "total_rounds": 2,
            "total_findings": 5,
            "total_duration_s": 10.0,
            "outcome": "success",
            "domain_stats": [
                {
                    "domain": "security",
                    "agent": "codex",
                    "round_num": 1,
                    "finding_count": 3,
                    "signal_count": 2,
                    "noise_count": 1,
                    "duration_s": 4.0,
                },
                {
                    "domain": "general",
                    "agent": "claude",
                    "round_num": 1,
                    "finding_count": 2,
                    "signal_count": 2,
                    "noise_count": 0,
                    "duration_s": 6.0,
                },
            ],
        }
        record_run(db, run_data)

        conn = sqlite3.connect(str(db))
        try:
            runs = conn.execute("SELECT * FROM runs").fetchall()
            assert len(runs) == 1
            assert runs[0][1] == "run-001"  # run_id
            assert runs[0][5] == 10.0  # total_duration_s

            stats = conn.execute("SELECT * FROM domain_stats ORDER BY domain").fetchall()
            assert len(stats) == 2
            # general comes first alphabetically
            assert stats[0][2] == "general"
            assert stats[1][2] == "security"
        finally:
            conn.close()

    def test_run_without_domain_stats(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        run_data = {
            "run_id": "run-002",
            "doc_path": "docs/plan.md",
            "total_rounds": 1,
            "total_findings": 0,
            "total_duration_s": 2.0,
            "outcome": "clean",
        }
        record_run(db, run_data)

        conn = sqlite3.connect(str(db))
        try:
            runs = conn.execute("SELECT * FROM runs").fetchall()
            assert len(runs) == 1
            stats = conn.execute("SELECT * FROM domain_stats").fetchall()
            assert len(stats) == 0
        finally:
            conn.close()


class TestGetDomainSnr:
    def test_returns_1_when_no_data(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)
        assert get_domain_snr(db, "security") == 1.0

    def test_computes_correct_ratio(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        # Insert 3 rows: signal=8, noise=2 → SNR=0.8
        for i in range(3):
            record_run(db, {
                "run_id": f"run-{i}",
                "doc_path": "doc.md",
                "total_rounds": 1,
                "total_findings": 5,
                "total_duration_s": 1.0,
                "outcome": "success",
                "domain_stats": [{
                    "domain": "security",
                    "agent": "codex",
                    "round_num": 1,
                    "finding_count": 5,
                    "signal_count": 3 if i < 2 else 2,
                    "noise_count": 0 if i < 2 else 2,
                    "duration_s": 1.0,
                }],
            })

        snr = get_domain_snr(db, "security")
        # signal=3+3+2=8, noise=0+0+2=2, ratio=8/10=0.8
        assert snr == pytest.approx(0.8)

    def test_last_n_limits_rows(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        # Insert 5 rows: first 3 are noisy, last 2 are clean
        for i in range(5):
            record_run(db, {
                "run_id": f"run-{i}",
                "doc_path": "doc.md",
                "total_rounds": 1,
                "total_findings": 1,
                "total_duration_s": 1.0,
                "outcome": "success",
                "domain_stats": [{
                    "domain": "general",
                    "agent": "claude",
                    "round_num": 1,
                    "finding_count": 1,
                    "signal_count": 0 if i < 3 else 5,
                    "noise_count": 5 if i < 3 else 0,
                    "duration_s": 1.0,
                }],
            })

        # last_n=2 should only see the clean rows
        snr = get_domain_snr(db, "general", last_n=2)
        assert snr == 1.0

    def test_returns_1_when_all_zero(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        record_run(db, {
            "run_id": "run-0",
            "doc_path": "doc.md",
            "total_rounds": 1,
            "total_findings": 0,
            "total_duration_s": 1.0,
            "outcome": "clean",
            "domain_stats": [{
                "domain": "general",
                "agent": "claude",
                "round_num": 1,
                "finding_count": 0,
                "signal_count": 0,
                "noise_count": 0,
                "duration_s": 1.0,
            }],
        })

        assert get_domain_snr(db, "general") == 1.0


class TestPruneMetrics:
    def test_deletes_old_rows(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)

        conn = sqlite3.connect(str(db))
        try:
            # Insert an old row (200 days ago)
            conn.execute(
                "INSERT INTO runs (run_id, doc_path, total_rounds, total_findings, "
                "total_duration_s, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, "
                "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-200 days'))",
                ("old-run", "doc.md", 1, 0, 1.0, "success"),
            )
            conn.execute(
                "INSERT INTO domain_stats (run_id, domain, agent, round_num, "
                "finding_count, duration_s, created_at) VALUES (?, ?, ?, ?, ?, ?, "
                "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-200 days'))",
                ("old-run", "general", "claude", 1, 0, 1.0),
            )
            # Insert a recent row
            conn.execute(
                "INSERT INTO runs (run_id, doc_path, total_rounds, total_findings, "
                "total_duration_s, outcome) VALUES (?, ?, ?, ?, ?, ?)",
                ("new-run", "doc.md", 1, 0, 1.0, "success"),
            )
            conn.commit()
        finally:
            conn.close()

        deleted = prune_metrics(db, retention_days=90)
        assert deleted == 2  # 1 run + 1 domain_stat

        conn = sqlite3.connect(str(db))
        try:
            runs = conn.execute("SELECT * FROM runs").fetchall()
            assert len(runs) == 1
            assert runs[0][1] == "new-run"

            stats = conn.execute("SELECT * FROM domain_stats").fetchall()
            assert len(stats) == 0
        finally:
            conn.close()

    def test_prune_empty_db(self, tmp_path):
        db = tmp_path / "forge_metrics.db"
        init_metrics_db(db)
        assert prune_metrics(db) == 0
